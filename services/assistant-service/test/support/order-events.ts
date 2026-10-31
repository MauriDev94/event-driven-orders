import { randomUUID } from 'node:crypto';
import type { OrderEventContract } from '../../src/core/messaging/contracts.js';

/** Wire-format events, as the Python services publish them. */
export function orderCreated(
  orderId: string,
  overrides: Partial<
    Extract<OrderEventContract, { event_type: 'order.created' }>
  > = {},
) {
  return {
    event_id: randomUUID(),
    event_type: 'order.created' as const,
    occurred_at: '2026-10-31T12:00:00.000000Z',
    correlation_id: `corr-${orderId}`,
    order_id: orderId,
    customer_id: 'c-1',
    items: [{ product_id: 'SKU-001', quantity: 2, unit_price: '10.00' }],
    total_amount: '20.00',
    ...overrides,
  };
}

export function stockReserved(
  orderId: string,
  occurredAt = '2026-10-31T12:00:01.000000Z',
) {
  return {
    event_id: randomUUID(),
    event_type: 'stock.reserved' as const,
    occurred_at: occurredAt,
    correlation_id: `corr-${orderId}`,
    order_id: orderId,
  };
}

export function stockRejected(orderId: string, reason: string) {
  return {
    event_id: randomUUID(),
    event_type: 'stock.rejected' as const,
    occurred_at: '2026-10-31T12:00:01.000000Z',
    correlation_id: `corr-${orderId}`,
    order_id: orderId,
    reason,
  };
}

export function orderConfirmed(
  orderId: string,
  occurredAt = '2026-10-31T12:00:02.000000Z',
) {
  return {
    event_id: randomUUID(),
    event_type: 'order.confirmed' as const,
    occurred_at: occurredAt,
    correlation_id: `corr-${orderId}`,
    order_id: orderId,
    customer_id: 'c-1',
  };
}

export function orderRejected(orderId: string, reason: string) {
  return {
    event_id: randomUUID(),
    event_type: 'order.rejected' as const,
    occurred_at: '2026-10-31T12:00:02.000000Z',
    correlation_id: `corr-${orderId}`,
    order_id: orderId,
    customer_id: 'c-1',
    reason,
  };
}
