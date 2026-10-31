import type { Options, Replies } from 'amqplib';
import { RETRY_STAGES } from './retry-policy.js';

// Duplicated from the Python services on purpose: services never share code.
export const ORDERS_EXCHANGE = 'orders';

export const ORDER_EVENTS_QUEUE = 'assistant-service.order-events';
export const ORDER_EVENTS_DLQ = `${ORDER_EVENTS_QUEUE}.dlq`;

/**
 * Bound by name, without a wildcard: a new event type must not reach a
 * service that doesn't know how to project it.
 */
export const ORDER_EVENT_ROUTING_KEYS = [
  'order.created',
  'stock.reserved',
  'stock.rejected',
  'order.confirmed',
  'order.rejected',
] as const;

export const PREFETCH = 10;

/** The slice of an amqplib channel the topology needs. */
export interface TopologyChannel {
  assertExchange(
    exchange: string,
    type: string,
    options?: Options.AssertExchange,
  ): Promise<Replies.AssertExchange>;
  assertQueue(
    queue: string,
    options?: Options.AssertQueue,
  ): Promise<Replies.AssertQueue>;
  bindQueue(
    queue: string,
    source: string,
    pattern: string,
  ): Promise<Replies.Empty>;
}

/**
 * Declares the shared exchange and this service's queues: the main queue
 * dead-letters to its DLQ through the default exchange, and each retry queue
 * sends messages back to the main queue when their TTL expires. Runs on every
 * (re)connection; declaring what already exists is a no-op.
 */
export async function declareTopology(channel: TopologyChannel): Promise<void> {
  await channel.assertExchange(ORDERS_EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(ORDER_EVENTS_DLQ, { durable: true });
  for (const [suffix, ttlMs] of RETRY_STAGES) {
    await channel.assertQueue(`${ORDER_EVENTS_QUEUE}.${suffix}`, {
      durable: true,
      arguments: {
        'x-message-ttl': ttlMs,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': ORDER_EVENTS_QUEUE,
      },
    });
  }
  await channel.assertQueue(ORDER_EVENTS_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': ORDER_EVENTS_DLQ,
    },
  });
  for (const routingKey of ORDER_EVENT_ROUTING_KEYS) {
    await channel.bindQueue(ORDER_EVENTS_QUEUE, ORDERS_EXCHANGE, routingKey);
  }
}
