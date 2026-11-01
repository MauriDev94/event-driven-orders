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

export interface RejectionSummary {
  totalRejected: number;
  groups: {
    reason: string;
    count: number;
    productIds: string[];
    orderIds: string[];
  }[];
}

/** Read-only port over the read model, for the assistant's tools. */
export abstract class OrderQueries {
  abstract timeline(orderId: string): Promise<OrderDetails | null>;

  /** Most recent activity first. */
  abstract search(filters: OrderSearch): Promise<OrderSummary[]>;

  /** Rejected orders grouped by reason, largest group first. */
  abstract rejectionSummary(range: TimeRange): Promise<RejectionSummary>;
}
