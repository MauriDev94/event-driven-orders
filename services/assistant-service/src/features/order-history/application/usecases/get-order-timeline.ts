import type {
  OrderHistoryRepository,
  OrderTimeline,
} from '../contracts/order-history.repository.js';
import type { TimelineCache } from '../contracts/timeline-cache.js';

/**
 * The order's current state and every event received for it, oldest first.
 * Served from the cache when it can; the projection invalidates it.
 */
export class GetOrderTimeline {
  constructor(
    private readonly repository: OrderHistoryRepository,
    private readonly cache: TimelineCache,
  ) {}

  execute(orderId: string): Promise<OrderTimeline | null> {
    return this.cache.getOrLoad(orderId, () =>
      this.repository.findTimeline(orderId),
    );
  }
}
