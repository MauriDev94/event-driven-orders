import type { OrderTimeline } from './order-history.repository.js';

/**
 * Cache of order timelines (cache-aside), invalidated by the order's events.
 *
 * - `getOrLoad` returns the cached timeline, or runs `load` and caches what it
 *   returns. An unknown order (null) is not cached: its first event may be
 *   on its way.
 * - Neither method fails because of the cache: if the cache is down, reads go
 *   straight to the database (fail open).
 */
export abstract class TimelineCache {
  abstract getOrLoad(
    orderId: string,
    load: () => Promise<OrderTimeline | null>,
  ): Promise<OrderTimeline | null>;

  /** Called after an event of the order committed. */
  abstract invalidate(orderId: string): Promise<void>;
}
