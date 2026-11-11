import type { OrderTimeline } from '../../src/features/order-history/application/contracts/order-history.repository.js';
import { TimelineCache } from '../../src/features/order-history/application/contracts/timeline-cache.js';

/** The key of an entry in `entries`: one per order and customer. */
export function entryKey(orderId: string, customerId: string): string {
  return `${orderId}|${customerId}`;
}

/** Fake of the cache port: a map, with the same "don't cache misses" rule. */
export class InMemoryTimelineCache extends TimelineCache {
  readonly entries = new Map<string, OrderTimeline>();
  readonly invalidated: string[] = [];
  /** Runs inside invalidate, to look at the world at that moment. */
  onInvalidate: (orderId: string) => void = () => {};

  async getOrLoad(
    orderId: string,
    customerId: string,
    load: () => Promise<OrderTimeline | null>,
  ): Promise<OrderTimeline | null> {
    const key = entryKey(orderId, customerId);
    const hit = this.entries.get(key);
    if (hit !== undefined) return hit;
    const loaded = await load();
    if (loaded !== null) this.entries.set(key, loaded);
    return loaded;
  }

  async invalidate(orderId: string): Promise<void> {
    this.onInvalidate(orderId);
    this.invalidated.push(orderId);
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${orderId}|`)) this.entries.delete(key);
    }
  }
}
