import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service.js';
import { assertCustomerId } from '../../../core/identifiers.js';
import type {
  OrderView as OrderViewRow,
  Prisma,
} from '../../../generated/prisma/client.js';
import {
  type OrderViewScope,
  OrderViewQueries,
  type OrderViewSearch,
  type OrderViewSummary,
  type RejectionGroup,
  type RejectionLimits,
  type RejectionStats,
} from '../application/contracts/order-view.queries.js';

/** Rows of a group read for its product ids, and ids listed; the counts never depend on them. */
const ROWS_PER_GROUP = 1_000;
const ORDER_IDS_PER_GROUP = 20;
const UNKNOWN_REASON = 'unknown';

@Injectable()
export class PrismaOrderViewQueries extends OrderViewQueries {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async search(filters: OrderViewSearch): Promise<OrderViewSummary[]> {
    assertCustomerId(filters.customerId);
    const where: Prisma.OrderViewWhereInput = {
      customerId: filters.customerId,
      ...createdIn(filters),
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.productId === undefined
        ? {}
        : { items: { array_contains: [{ product_id: filters.productId }] } }),
    };
    const rows = await this.prisma.orderView.findMany({
      where,
      orderBy: [{ lastEventAt: 'desc' }, { orderId: 'asc' }],
      take: filters.limit,
    });
    return rows.map(toSummary);
  }

  async rejectionStats(
    scope: OrderViewScope,
    limits: RejectionLimits,
  ): Promise<RejectionStats> {
    assertCustomerId(scope.customerId);
    // One round trip, whatever the number of reasons: reasons embed a SKU that
    // visitors choose, so a query per group would let them drain the pool.
    // The same reason is why the groups and the product ids are capped here,
    // in SQL, and not after reading them: the rows returned never grow with
    // the data. The totals are computed before the cap, so they stay exact.
    // The customer filter is in the SQL too (ADR-0027), so the groups, the
    // caps and the totals are all per customer.
    // The date filter is `createdIn` in SQL: the creation date, or the first
    // event's while `order.created` hasn't arrived. Ordering uses COLLATE "C"
    // so the cut is the same on any database and matches JS's default sort.
    const from = scope.from ?? null;
    const until = scope.until ?? null;
    const rows = await this.prisma.$queryRaw<RejectionRow[]>`
      WITH ranked AS (
        SELECT
          order_id,
          items,
          COALESCE(rejection_reason, ${UNKNOWN_REASON}) AS reason,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(rejection_reason, ${UNKNOWN_REASON})
            ORDER BY last_event_at DESC, order_id ASC
          ) AS rn,
          COUNT(*) OVER (
            PARTITION BY COALESCE(rejection_reason, ${UNKNOWN_REASON})
          ) AS total
        FROM order_view
        WHERE status = 'rejected'
          AND customer_id = ${scope.customerId}
          AND (${from}::timestamptz IS NULL
               OR COALESCE(created_at, last_event_at) >= ${from}::timestamptz)
          AND (${until}::timestamptz IS NULL
               OR COALESCE(created_at, last_event_at) < ${until}::timestamptz)
      ),
      groups AS (
        SELECT
          reason,
          MAX(total) AS count,
          ARRAY_AGG(order_id ORDER BY rn) FILTER (WHERE rn <= ${ORDER_IDS_PER_GROUP}) AS order_ids
        FROM ranked
        GROUP BY reason
      ),
      totals AS (
        SELECT COALESCE(SUM(count), 0)::bigint AS total_rejected, COUNT(*) AS total_groups
        FROM groups
      ),
      top_groups AS (
        SELECT reason, count, order_ids
        FROM groups
        ORDER BY count DESC, reason COLLATE "C" ASC
        LIMIT ${limits.groups}
      ),
      products AS (
        SELECT r.reason, item ->> 'product_id' AS product_id
        FROM ranked r
        JOIN top_groups t ON t.reason = r.reason
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(r.items) = 'array' THEN r.items ELSE '[]'::jsonb END
        ) AS item
        WHERE r.rn <= ${ROWS_PER_GROUP}
        GROUP BY r.reason, item ->> 'product_id'
      ),
      product_lists AS (
        SELECT
          reason,
          COUNT(*) AS product_total,
          (ARRAY_AGG(product_id ORDER BY product_id COLLATE "C"))[1:${limits.productIdsPerGroup}::int] AS product_ids
        FROM products
        GROUP BY reason
      )
      SELECT
        g.reason,
        g.count,
        g.order_ids,
        COALESCE(p.product_ids, ARRAY[]::text[]) AS product_ids,
        COALESCE(p.product_total, 0) AS product_total,
        t.total_rejected,
        t.total_groups
      FROM top_groups g
      CROSS JOIN totals t
      LEFT JOIN product_lists p ON p.reason = g.reason
      ORDER BY g.count DESC, g.reason COLLATE "C" ASC`;

    const groups = rows.map((row): RejectionGroup => ({
      reason: row.reason,
      count: Number(row.count),
      productIds: row.product_ids,
      productTotal: Number(row.product_total),
      orderIds: row.order_ids,
    }));
    // With no rows there are no totals to read: nothing was rejected.
    const [first] = rows;
    return {
      totalRejected: Number(first?.total_rejected ?? 0),
      totalGroups: Number(first?.total_groups ?? 0),
      groups,
    };
  }
}

/** A row of the rejection query; COUNT is a bigint, so it arrives as one. */
interface RejectionRow {
  reason: string;
  count: bigint;
  order_ids: string[];
  product_ids: string[];
  product_total: bigint;
  total_rejected: bigint;
  total_groups: bigint;
}

/**
 * Orders created in the range. An order whose `order.created` hasn't arrived
 * yet has no creation date, so its first event stands in for it.
 */
function createdIn({
  from,
  until,
}: OrderViewScope): Prisma.OrderViewWhereInput {
  if (from === undefined && until === undefined) return {};
  const bounds = {
    ...(from === undefined ? {} : { gte: from }),
    ...(until === undefined ? {} : { lt: until }),
  };
  return {
    OR: [{ createdAt: bounds }, { createdAt: null, lastEventAt: bounds }],
  };
}

function toSummary(row: OrderViewRow): OrderViewSummary {
  return {
    orderId: row.orderId,
    customerId: row.customerId,
    status: row.status,
    stockResult: row.stockResult,
    rejectionReason: row.rejectionReason,
    // numeric(14,2): toFixed keeps "20.00", which Decimal's toString would drop.
    totalAmount: row.totalAmount?.toFixed(2) ?? null,
    createdAt: row.createdAt,
    lastEventAt: row.lastEventAt,
  };
}
