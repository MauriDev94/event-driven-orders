import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service.js';
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
    const where: Prisma.OrderViewWhereInput = {
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

  async rejectionStats(scope: OrderViewScope): Promise<RejectionStats> {
    // One round trip, whatever the number of reasons: reasons embed a SKU that
    // visitors choose, so a query per group would let them drain the pool.
    // The date filter is `createdIn` in SQL: the creation date, or the first
    // event's while `order.created` hasn't arrived.
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
          AND (${from}::timestamptz IS NULL
               OR COALESCE(created_at, last_event_at) >= ${from}::timestamptz)
          AND (${until}::timestamptz IS NULL
               OR COALESCE(created_at, last_event_at) < ${until}::timestamptz)
      ),
      products AS (
        SELECT r.reason, item ->> 'product_id' AS product_id
        FROM ranked r
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(r.items) = 'array' THEN r.items ELSE '[]'::jsonb END
        ) AS item
        WHERE r.rn <= ${ROWS_PER_GROUP}
        GROUP BY r.reason, item ->> 'product_id'
      ),
      groups AS (
        SELECT
          reason,
          MAX(total) AS count,
          ARRAY_AGG(order_id ORDER BY rn) FILTER (WHERE rn <= ${ORDER_IDS_PER_GROUP}) AS order_ids
        FROM ranked
        GROUP BY reason
      )
      SELECT
        g.reason,
        g.count,
        g.order_ids,
        COALESCE(
          (SELECT ARRAY_AGG(p.product_id) FROM products p WHERE p.reason = g.reason),
          ARRAY[]::text[]
        ) AS product_ids
      FROM groups g`;

    const groups = rows
      .map((row): RejectionGroup => ({
        reason: row.reason,
        count: Number(row.count),
        productIds: [...row.product_ids].sort(),
        orderIds: row.order_ids,
      }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    return {
      // Every group is returned, so the sum is exact. Once #80 caps the
      // groups, compute this before the cap.
      totalRejected: groups.reduce((sum, group) => sum + group.count, 0),
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
