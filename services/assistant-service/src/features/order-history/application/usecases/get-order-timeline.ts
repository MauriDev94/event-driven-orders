import type {
  OrderHistoryRepository,
  OrderTimeline,
} from '../contracts/order-history.repository.js';

/** The order's current state and every event received for it, oldest first. */
export class GetOrderTimeline {
  constructor(private readonly repository: OrderHistoryRepository) {}

  execute(orderId: string): Promise<OrderTimeline | null> {
    return this.repository.findTimeline(orderId);
  }
}
