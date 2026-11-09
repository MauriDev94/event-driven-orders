import type {
  OrderStatus,
  StockResult,
} from '../../domain/order-history-event.js';

/** One row of a list of orders. */
export interface OrderViewSummary {
  orderId: string;
  customerId: string | null;
  status: OrderStatus;
  stockResult: StockResult | null;
  rejectionReason: string | null;
  totalAmount: string | null;
  createdAt: Date | null;
  lastEventAt: Date;
}

/**
 * What a query may see. Today only when the order was created (`from`
 * inclusive, `until` exclusive); caps and the customer filter will join here.
 */
export interface OrderViewScope {
  from?: Date;
  until?: Date;
}

export interface OrderViewSearch extends OrderViewScope {
  status?: OrderStatus;
  productId?: string;
  limit: number;
}

/** How much of the rejection stats a query returns; the totals stay exact. */
export interface RejectionLimits {
  /** Groups returned, the largest first. */
  groups: number;
  /** Product ids returned per group, in alphabetical order. */
  productIdsPerGroup: number;
}

export interface RejectionGroup {
  reason: string;
  /** Exact: counted in the database over every rejected order in the range. */
  count: number;
  /** Read from the most recent rejected orders of the group, so it can be partial. */
  productIds: string[];
  /** Distinct products over the 1,000 most recent orders of the group (`ROWS_PER_GROUP` in the Prisma query), not over the whole group; `productIds` holds the first ones. */
  productTotal: number;
  orderIds: string[];
}

export interface RejectionStats {
  /** Exact: every rejected order in the range, whatever the group cap. */
  totalRejected: number;
  /** Exact: every distinct reason in the range, whatever the group cap. */
  totalGroups: number;
  /** Largest group first, ties by reason, at most `limits.groups`. */
  groups: RejectionGroup[];
}

/**
 * Read-only lists over the order view, for other features. order-history owns
 * the table, so the jsonb shape and the "no order.created yet" rule stay here.
 */
export abstract class OrderViewQueries {
  /** Most recent activity first. */
  abstract search(filters: OrderViewSearch): Promise<OrderViewSummary[]>;

  /** Rejected orders grouped by reason (`unknown` when none was recorded). */
  abstract rejectionStats(
    range: OrderViewScope,
    limits: RejectionLimits,
  ): Promise<RejectionStats>;
}
