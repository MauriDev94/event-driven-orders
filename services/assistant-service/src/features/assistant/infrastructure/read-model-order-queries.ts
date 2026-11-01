import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service.js';
import type {
  OrderView as OrderViewRow,
  Prisma,
} from '../../../generated/prisma/client.js';
import { GetOrderTimeline } from '../../order-history/application/usecases/get-order-timeline.js';
import {
  type OrderDetails,
  OrderQueries,
  type OrderSearch,
  type OrderSummary,
  type RejectionSummary,
  type TimeRange,
} from '../application/contracts/order-queries.js';

/** Rows read to build a rejection summary; past that, counts stay exact but groups are partial. */
const SUMMARY_ROWS = 1_000;
const ORDER_IDS_PER_GROUP = 20;

type StoredItem = { product_id: string };

/**
 * The assistant's read side over the order-history read model. The timeline
 * goes through GetOrderTimeline, so the tool shares the timeline cache with
 * the HTTP endpoint; the lists query Postgres directly.
 */
@Injectable()
export class ReadModelOrderQueries extends OrderQueries {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GetOrderTimeline)
    private readonly getOrderTimeline: GetOrderTimeline,
  ) {
    super();
  }

  async timeline(orderId: string): Promise<OrderDetails | null> {
    const timeline = await this.getOrderTimeline.execute(orderId);
    if (timeline === null) return null;
    const { view, events } = timeline;
    return {
      orderId: view.orderId,
      customerId: view.customerId,
      status: view.status,
      stockResult: view.stockResult,
      rejectionReason: view.rejectionReason,
      totalAmount: view.totalAmount,
      createdAt: view.createdAt,
      lastEventAt: view.lastEventAt,
      items: view.items,
      events: events.map((event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        reason: reasonOf(event.payload),
      })),
    };
  }

  async search(filters: OrderSearch): Promise<OrderSummary[]> {
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

  async rejectionSummary(range: TimeRange): Promise<RejectionSummary> {
    const where: Prisma.OrderViewWhereInput = {
      ...createdIn(range),
      status: 'rejected',
    };
    const [totalRejected, rows] = await Promise.all([
      this.prisma.orderView.count({ where }),
      this.prisma.orderView.findMany({
        where,
        select: { orderId: true, rejectionReason: true, items: true },
        orderBy: [{ lastEventAt: 'desc' }, { orderId: 'asc' }],
        take: SUMMARY_ROWS,
      }),
    ]);

    const groups = new Map<
      string,
      { count: number; products: Set<string>; orderIds: string[] }
    >();
    for (const row of rows) {
      const reason = row.rejectionReason ?? 'unknown';
      const group = groups.get(reason) ?? {
        count: 0,
        products: new Set<string>(),
        orderIds: [],
      };
      group.count += 1;
      for (const item of (row.items as StoredItem[] | null) ?? []) {
        group.products.add(item.product_id);
      }
      if (group.orderIds.length < ORDER_IDS_PER_GROUP) {
        group.orderIds.push(row.orderId);
      }
      groups.set(reason, group);
    }

    return {
      totalRejected,
      groups: [...groups]
        .map(([reason, group]) => ({
          reason,
          count: group.count,
          productIds: [...group.products].sort(),
          orderIds: group.orderIds,
        }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    };
  }
}

/**
 * Orders created in the range. An order whose `order.created` hasn't arrived
 * yet has no creation date, so its first event stands in for it.
 */
function createdIn({ from, until }: TimeRange): Prisma.OrderViewWhereInput {
  if (from === undefined && until === undefined) return {};
  const bounds = {
    ...(from === undefined ? {} : { gte: from }),
    ...(until === undefined ? {} : { lt: until }),
  };
  return {
    OR: [{ createdAt: bounds }, { createdAt: null, lastEventAt: bounds }],
  };
}

function toSummary(row: OrderViewRow): OrderSummary {
  return {
    orderId: row.orderId,
    customerId: row.customerId,
    status: row.status,
    stockResult: row.stockResult,
    rejectionReason: row.rejectionReason,
    totalAmount: row.totalAmount?.toFixed(2) ?? null,
    createdAt: row.createdAt,
    lastEventAt: row.lastEventAt,
  };
}

function reasonOf(payload: unknown): string | null {
  if (typeof payload === 'object' && payload !== null && 'reason' in payload) {
    return typeof payload.reason === 'string' ? payload.reason : null;
  }
  return null;
}
