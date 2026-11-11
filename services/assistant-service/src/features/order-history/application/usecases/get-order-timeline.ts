import { assertCustomerId, isValidId } from '../../../../core/identifiers.js';
import type {
  OrderHistoryRepository,
  OrderTimeline,
} from '../contracts/order-history.repository.js';
import type { TimelineCache } from '../contracts/timeline-cache.js';

/**
 * The order's current state and every event received for it, oldest first,
 * for the customer who owns it (ADR-0027). Served from the cache when it can;
 * the projection invalidates it.
 */
export class GetOrderTimeline {
  constructor(
    private readonly repository: OrderHistoryRepository,
    private readonly cache: TimelineCache,
  ) {}

  /**
   * Null when the order doesn't exist, belongs to another customer, or its
   * `order.created` hasn't arrived (no owner yet): the three look the same to
   * the caller, in the answer and in the cost, so a foreign order isn't
   * confirmed to exist (SEC94-01).
   *
   * The cache entry is per order AND customer, and the load is the repository
   * query filtered by that customer. A visitor therefore never reads, and
   * never writes, an entry of someone else's order. An id that can't be an
   * order id (NUL, too long, a `:`) is a miss before it reaches the cache
   * keys or the database.
   */
  async execute(
    orderId: string,
    customerId: string,
  ): Promise<OrderTimeline | null> {
    assertCustomerId(customerId);
    if (!isValidId(orderId)) return null;
    return this.cache.getOrLoad(orderId, customerId, () =>
      this.repository.findTimeline(orderId, customerId),
    );
  }
}
