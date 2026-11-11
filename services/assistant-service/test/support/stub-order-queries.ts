import {
  type OrderDetails,
  OrderQueries,
  type OrderScope,
  type OrderSearch,
  type OrderSummary,
  type RejectionLimits,
  type RejectionSummary,
} from '../../src/features/assistant/application/contracts/order-queries.js';

/** OrderQueries with canned answers that records what it was asked. */
export class StubOrderQueries extends OrderQueries {
  details = new Map<string, OrderDetails>();
  orders: OrderSummary[] = [];
  rejections: RejectionSummary = {
    totalRejected: 0,
    totalGroups: 0,
    groups: [],
  };
  readonly timelines: { orderId: string; customerId: string }[] = [];
  readonly searches: OrderSearch[] = [];
  readonly rejectionRanges: OrderScope[] = [];
  readonly rejectionLimits: RejectionLimits[] = [];

  async timeline(
    orderId: string,
    customerId: string,
  ): Promise<OrderDetails | null> {
    this.timelines.push({ orderId, customerId });
    return this.details.get(orderId) ?? null;
  }

  async search(filters: OrderSearch): Promise<OrderSummary[]> {
    this.searches.push(filters);
    return this.orders;
  }

  async rejectionSummary(
    scope: OrderScope,
    limits: RejectionLimits,
  ): Promise<RejectionSummary> {
    this.rejectionLimits.push(limits);
    this.rejectionRanges.push(scope);
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
