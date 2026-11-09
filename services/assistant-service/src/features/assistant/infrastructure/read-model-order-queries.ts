import { Inject, Injectable } from '@nestjs/common';
import { OrderViewQueries } from '../../order-history/application/contracts/order-view.queries.js';
import { reasonOf } from '../../order-history/application/mappers/event-reason.js';
import { GetOrderTimeline } from '../../order-history/application/usecases/get-order-timeline.js';
import {
  type OrderDetails,
  OrderQueries,
  type OrderSearch,
  type OrderSummary,
  type RejectionSummary,
  type TimeRange,
} from '../application/contracts/order-queries.js';

/**
 * The assistant's read side over the order-history read model: an adapter to
 * order-history's ports. The timeline goes through GetOrderTimeline, so the
 * tool shares the timeline cache with the HTTP endpoint.
 */
@Injectable()
export class ReadModelOrderQueries extends OrderQueries {
  constructor(
    @Inject(OrderViewQueries) private readonly views: OrderViewQueries,
    @Inject(GetOrderTimeline)
    private readonly getOrderTimeline: GetOrderTimeline,
  ) {
    super();
  }

  async timeline(orderId: string): Promise<OrderDetails | null> {
    const timeline = await this.getOrderTimeline.execute(orderId);
    if (timeline === null) return null;
    const { view, events } = timeline;
    return {
      orderId: view.orderId,
      customerId: view.customerId,
      status: view.status,
      stockResult: view.stockResult,
      rejectionReason: view.rejectionReason,
      totalAmount: view.totalAmount,
      createdAt: view.createdAt,
      lastEventAt: view.lastEventAt,
      items: view.items,
      events: events.map((event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        reason: reasonOf(event.payload),
      })),
    };
  }

  search(filters: OrderSearch): Promise<OrderSummary[]> {
    return this.views.search(filters);
  }

  async rejectionSummary(range: TimeRange): Promise<RejectionSummary> {
    const { totalRejected, groups } = await this.views.rejectionStats(range);
    return { totalRejected, groups };
  }
}
