export type OrderStatus = 'pending' | 'confirmed' | 'rejected';

export interface OrderSummary {
  orderId: string;
  customerId: string | null;
  status: OrderStatus;
  stockResult: 'reserved' | 'rejected' | null;
  rejectionReason: string | null;
  totalAmount: string | null;
  createdAt: Date | null;
  lastEventAt: Date | null;
}

export interface OrderDetails extends OrderSummary {
  items: { productId: string; quantity: number; unitPrice: string }[] | null;
  events: {
    eventId: string;
    eventType: string;
    occurredAt: Date;
    reason: string | null;
  }[];
}

/** When the order was created: `from` inclusive, `until` exclusive. */
export interface TimeRange {
  from?: Date;
  until?: Date;
}

export interface OrderSearch extends TimeRange {
  status?: OrderStatus;
  productId?: string;
  limit: number;
}

/** How much of the summary the query may return; the totals stay exact. */
export interface RejectionLimits {
  /** Groups returned, the largest first. */
  groups: number;
  /** Product ids returned per group, in alphabetical order. */
  productIdsPerGroup: number;
}

export interface RejectionSummary {
  /** Every rejected order in the range, whatever the group cap. */
  totalRejected: number;
  /** Every distinct reason in the range, whatever the group cap. */
  totalGroups: number;
  groups: {
    reason: string;
    count: number;
    productIds: string[];
    /** Distinct products over the 1,000 most recent orders of the group (`ROWS_PER_GROUP` in the Prisma query): a lower bound when the group is bigger, and more than the ones returned. */
    productTotal: number;
    orderIds: string[];
  }[];
}

/** Read-only port over the read model, for the assistant's tools. */
export abstract class OrderQueries {
  abstract timeline(orderId: string): Promise<OrderDetails | null>;

  /** Most recent activity first. */
  abstract search(filters: OrderSearch): Promise<OrderSummary[]>;

  /** Rejected orders grouped by reason, largest group first, up to `limits`. */
  abstract rejectionSummary(
    range: TimeRange,
    limits: RejectionLimits,
  ): Promise<RejectionSummary>;
}
