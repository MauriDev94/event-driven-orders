import {
  ConcurrentUpdateError,
  type EventLogEntry,
  OrderHistoryRepository,
  type OrderHistoryTransaction,
  type OrderTimeline,
  type StoredOrderView,
} from '../../src/features/order-history/application/contracts/order-history.repository.js';
import { OrderView } from '../../src/features/order-history/domain/order-view.js';

/**
 * Fake of the repository port for use case tests. A transaction works on a
 * copy and only publishes it when the work succeeds, like a rollback.
 */
export class InMemoryOrderHistoryRepository extends OrderHistoryRepository {
  events = new Map<string, EventLogEntry>();
  views = new Map<string, StoredOrderView>();

  async inTransaction<T>(
    work: (tx: OrderHistoryTransaction) => Promise<T>,
  ): Promise<T> {
    const events = new Map(this.events);
    const views = new Map(this.views);
    const result = await work({
      recordEvent: async (entry) => {
        if (events.has(entry.eventId)) return false;
        events.set(entry.eventId, entry);
        return true;
      },
      findView: async (orderId) => views.get(orderId) ?? null,
      saveView: async (view, expectedVersion) => {
        const current = views.get(view.orderId);
        if ((current?.version ?? null) !== expectedVersion)
          throw new ConcurrentUpdateError(view.orderId);
        views.set(view.orderId, { view, version: (expectedVersion ?? -1) + 1 });
      },
    });
    this.events = events;
    this.views = views;
    return result;
  }

  async findTimeline(orderId: string): Promise<OrderTimeline | null> {
    const stored = this.views.get(orderId);
    if (!stored) return null;
    const events = [...this.events.values()]
      .filter((entry) => entry.orderId === orderId)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    return { view: OrderView.restore(stored.view.toState()), events };
  }
}
