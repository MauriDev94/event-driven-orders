import { Inject, Injectable } from '@nestjs/common';
import { assertCustomerId } from '../../../core/identifiers.js';
import { OrderViewQueries } from '../../order-history/application/contracts/order-view.queries.js';
import { reasonOf } from '../../order-history/application/mappers/event-reason.js';
import { GetOrderTimeline } from '../../order-history/application/usecases/get-order-timeline.js';
import {
  type OrderDetails,
  OrderQueries,
  type OrderScope,
  type OrderSearch,
  type OrderSummary,
  type RejectionLimits,
  type RejectionSummary,
} from '../application/contracts/order-queries.js';

/**
 * The assistant's read side over the order-history read model: an adapter to
 * order-history's ports. The timeline goes through GetOrderTimeline, so the
 * tool shares the timeline cache and the owner check with the HTTP endpoint.
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

  async timeline(
    orderId: string,
    customerId: string,
  ): Promise<OrderDetails | null> {
    const timeline = await this.getOrderTimeline.execute(orderId, customerId);
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

  async search(filters: OrderSearch): Promise<OrderSummary[]> {
    assertCustomerId(filters.customerId);
    return this.views.search(filters);
  }

  async rejectionSummary(
    scope: OrderScope,
    limits: RejectionLimits,
  ): Promise<RejectionSummary> {
    assertCustomerId(scope.customerId);
    return this.views.rejectionStats(scope, limits);
  }
}
