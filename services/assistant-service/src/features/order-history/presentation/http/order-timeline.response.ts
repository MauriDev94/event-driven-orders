import type { OrderTimeline } from '../../application/contracts/order-history.repository.js';

/** snake_case, like the other services' APIs. */
export interface OrderTimelineResponse {
  order_id: string;
  customer_id: string | null;
  status: string;
  stock_result: string | null;
  rejection_reason: string | null;
  total_amount: string | null;
  items: { product_id: string; quantity: number; unit_price: string }[] | null;
  created_at: string | null;
  last_event_at: string | null;
  events: {
    event_id: string;
    event_type: string;
    occurred_at: string;
    correlation_id: string;
    reason?: string;
  }[];
}

export function toTimelineResponse({
  view,
  events,
}: OrderTimeline): OrderTimelineResponse {
  return {
    order_id: view.orderId,
    customer_id: view.customerId,
    status: view.status,
    stock_result: view.stockResult,
    rejection_reason: view.rejectionReason,
    total_amount: view.totalAmount,
    items:
      view.items?.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
        unit_price: item.unitPrice,
      })) ?? null,
    created_at: view.createdAt?.toISOString() ?? null,
    last_event_at: view.lastEventAt?.toISOString() ?? null,
    events: events.map((event) => {
      const reason = reasonOf(event.payload);
      return {
        event_id: event.eventId,
        event_type: event.eventType,
        occurred_at: event.occurredAt.toISOString(),
        correlation_id: event.correlationId,
        ...(reason === undefined ? {} : { reason }),
      };
    }),
  };
}

function reasonOf(payload: unknown): string | undefined {
  if (typeof payload === 'object' && payload !== null && 'reason' in payload) {
    return typeof payload.reason === 'string' ? payload.reason : undefined;
  }
  return undefined;
}
