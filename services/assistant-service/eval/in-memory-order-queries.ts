import {
  type OrderDetails,
  OrderQueries,
  type OrderSearch,
  type OrderSummary,
  type RejectionSummary,
  type TimeRange,
} from '../src/features/assistant/application/contracts/order-queries.js';

function inRange(order: OrderSummary, range: TimeRange): boolean {
  const created = order.createdAt?.getTime();
  if (created === undefined)
    return range.from === undefined && range.until === undefined;
  return (
    (range.from === undefined || created >= range.from.getTime()) &&
    (range.until === undefined || created < range.until.getTime())
  );
}

function summary({
  items: _items,
  events: _events,
  ...order
}: OrderDetails): OrderSummary {
  return order;
}

function byLatestActivity(a: OrderSummary, b: OrderSummary): number {
  return (b.lastEventAt?.getTime() ?? 0) - (a.lastEventAt?.getTime() ?? 0);
}

/**
 * The read model as a fixed list, so the eval runs without Postgres and
 * every run sees the same orders. It follows the contract of the Prisma
 * adapter: ranges are on the creation date, `until` exclusive, and searches
 * come back with the most recent activity first.
 */
export class InMemoryOrderQueries extends OrderQueries {
  constructor(private readonly orders: readonly OrderDetails[]) {
    super();
  }

  async timeline(orderId: string): Promise<OrderDetails | null> {
    return this.orders.find((order) => order.orderId === orderId) ?? null;
  }

  async search(filters: OrderSearch): Promise<OrderSummary[]> {
    return this.orders
      .filter(
        (order) =>
          (filters.status === undefined || order.status === filters.status) &&
          (filters.productId === undefined ||
            (order.items ?? []).some(
              (item) => item.productId === filters.productId,
            )) &&
          inRange(order, filters),
      )
      .sort(byLatestActivity)
      .slice(0, filters.limit)
      .map(summary);
  }

  async rejectionSummary(range: TimeRange): Promise<RejectionSummary> {
    const rejected = this.orders.filter(
      (order) => order.status === 'rejected' && inRange(order, range),
    );
    const groups = new Map<string, OrderDetails[]>();
    for (const order of rejected) {
      const reason = order.rejectionReason ?? 'unspecified';
      groups.set(reason, [...(groups.get(reason) ?? []), order]);
    }
    return {
      totalRejected: rejected.length,
      groups: [...groups]
        .map(([reason, orders]) => ({
          reason,
          count: orders.length,
          productIds: [
            ...new Set(
              orders.flatMap((order) =>
                (order.items ?? []).map((item) => item.productId),
              ),
            ),
          ],
          orderIds: orders.map((order) => order.orderId),
        }))
        .sort((a, b) => b.count - a.count),
    };
  }
}
