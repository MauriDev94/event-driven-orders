import type { OrderTimeline } from './order-history.repository.js';

/**
 * Cache of order timelines (cache-aside), invalidated by the order's events.
 *
 * - An entry belongs to an order AND a customer (ADR-0027): `load` is the
 *   query already filtered by that customer, so what it returns is what that
 *   customer may see. Nobody is ever served an entry stored for someone else,
 *   and a load that finds nothing (missing order, foreign order, no owner yet)
 *   writes nothing.
 * - `getOrLoad` returns the cached timeline, or runs `load` and caches what it
 *   returns. An unknown order (null) is not cached: its first event may be
 *   on its way.
 * - Neither method fails because of the cache: if the cache is down, reads go
 *   straight to the database (fail open).
 */
export abstract class TimelineCache {
  abstract getOrLoad(
    orderId: string,
    customerId: string,
    load: () => Promise<OrderTimeline | null>,
  ): Promise<OrderTimeline | null>;

  /** Called after an event of the order committed; drops the entries of every customer. */
  abstract invalidate(orderId: string): Promise<void>;
}
