import type { OrderView } from '../../domain/order-view.js';

export interface EventLogEntry {
  eventId: string;
  orderId: string;
  eventType: string;
  occurredAt: Date;
  correlationId: string;
  /** The event exactly as it arrived, for the timeline and for audit. */
  payload: unknown;
}

export interface StoredOrderView {
  view: OrderView;
  /** Optimistic lock token, compared on save. */
  version: number;
}

export interface OrderHistoryTransaction {
  /** Inserts the event unless it was already recorded; false means a duplicate. */
  recordEvent(entry: EventLogEntry): Promise<boolean>;
  findView(orderId: string): Promise<StoredOrderView | null>;
  /**
   * Inserts the view (`expectedVersion` null) or updates the one read at that
   * version. Throws ConcurrentUpdateError if another transaction got there first.
   */
  saveView(view: OrderView, expectedVersion: number | null): Promise<void>;
}

export interface OrderTimeline {
  view: OrderView;
  events: EventLogEntry[];
}

/** Port of the read model. The Prisma adapter lives in infrastructure/. */
export abstract class OrderHistoryRepository {
  /** Runs the work in one database transaction: all of it commits or none. */
  abstract inTransaction<T>(
    work: (tx: OrderHistoryTransaction) => Promise<T>,
  ): Promise<T>;

  abstract findTimeline(orderId: string): Promise<OrderTimeline | null>;
}

/**
 * Two events of the same order were projected at once and this one lost.
 * Transient: the retry dispatcher sends it to retry-5s, and the next attempt
 * reads the winner's view.
 */
export class ConcurrentUpdateError extends Error {
  override readonly name = 'ConcurrentUpdateError';

  constructor(orderId: string) {
    super(`order ${orderId} changed while projecting an event`);
  }
}
