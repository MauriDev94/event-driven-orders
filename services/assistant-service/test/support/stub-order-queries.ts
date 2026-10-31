import {
  type OrderDetails,
  OrderQueries,
  type OrderSearch,
  type OrderSummary,
  type RejectionSummary,
  type TimeRange,
} from '../../src/features/assistant/application/contracts/order-queries.js';

/** OrderQueries with canned answers that records what it was asked. */
export class StubOrderQueries extends OrderQueries {
  details = new Map<string, OrderDetails>();
  orders: OrderSummary[] = [];
  rejections: RejectionSummary = { totalRejected: 0, groups: [] };
  readonly searches: OrderSearch[] = [];
  readonly rejectionRanges: TimeRange[] = [];

  async timeline(orderId: string): Promise<OrderDetails | null> {
    return this.details.get(orderId) ?? null;
  }

  async search(filters: OrderSearch): Promise<OrderSummary[]> {
    this.searches.push(filters);
    return this.orders;
  }

  async rejectionSummary(range: TimeRange): Promise<RejectionSummary> {
    this.rejectionRanges.push(range);
    return this.rejections;
  }
}

export function orderSummary(
  orderId: string,
  overrides: Partial<OrderSummary> = {},
): OrderSummary {
  return {
    orderId,
    customerId: 'c-1',
    status: 'rejected',
    stockResult: 'rejected',
    rejectionReason: 'insufficient stock for product SKU-005',
    totalAmount: '20.00',
    createdAt: new Date('2026-10-31T12:00:00.000Z'),
    lastEventAt: new Date('2026-10-31T12:00:02.000Z'),
    ...overrides,
  };
}
