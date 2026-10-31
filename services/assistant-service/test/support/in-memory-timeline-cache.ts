import type { OrderTimeline } from '../../src/features/order-history/application/contracts/order-history.repository.js';
import { TimelineCache } from '../../src/features/order-history/application/contracts/timeline-cache.js';

/** Fake of the cache port: a map, with the same "don't cache misses" rule. */
export class InMemoryTimelineCache extends TimelineCache {
  readonly entries = new Map<string, OrderTimeline>();
  readonly invalidated: string[] = [];
  /** Runs inside invalidate, to look at the world at that moment. */
  onInvalidate: (orderId: string) => void = () => {};

  async getOrLoad(
    orderId: string,
    load: () => Promise<OrderTimeline | null>,
  ): Promise<OrderTimeline | null> {
    const hit = this.entries.get(orderId);
    if (hit !== undefined) return hit;
    const loaded = await load();
    if (loaded !== null) this.entries.set(orderId, loaded);
    return loaded;
  }

  async invalidate(orderId: string): Promise<void> {
    this.onInvalidate(orderId);
    this.invalidated.push(orderId);
    this.entries.delete(orderId);
  }
}
