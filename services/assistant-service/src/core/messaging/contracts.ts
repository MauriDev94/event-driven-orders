/**
 * zod mirror of the Python contracts in `shared/contracts` (ADR-0003): the
 * contract is the JSON on the wire. The publishers serialize with Pydantic's
 * `model_dump_json()`, which writes `Decimal` as a string and datetimes in
 * ISO 8601 with an offset. test/unit/core/messaging/contracts.spec.ts parses
 * fixtures exported from the Pydantic models, so a drift fails the tests.
 *
 * Unknown fields are dropped, like Pydantic's default.
 */
import { z } from 'zod';

const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'expected a non-negative decimal string');

const baseEvent = {
  event_id: z.string().min(1),
  occurred_at: z.iso.datetime({ offset: true }),
  correlation_id: z.string(),
  order_id: z.string().min(1),
};

export const orderItemSchema = z.object({
  product_id: z.string(),
  quantity: z.number().int().positive(),
  unit_price: decimal,
});

export const orderCreatedSchema = z.object({
  ...baseEvent,
  event_type: z.literal('order.created'),
  customer_id: z.string(),
  items: z.array(orderItemSchema),
  total_amount: decimal,
});

export const stockReservedSchema = z.object({
  ...baseEvent,
  event_type: z.literal('stock.reserved'),
});

export const stockRejectedSchema = z.object({
  ...baseEvent,
  event_type: z.literal('stock.rejected'),
  reason: z.string(),
});

export const orderConfirmedSchema = z.object({
  ...baseEvent,
  event_type: z.literal('order.confirmed'),
  customer_id: z.string(),
});

export const orderRejectedSchema = z.object({
  ...baseEvent,
  event_type: z.literal('order.rejected'),
  customer_id: z.string(),
  reason: z.string(),
});

export const orderEventSchema = z.discriminatedUnion('event_type', [
  orderCreatedSchema,
  stockReservedSchema,
  stockRejectedSchema,
  orderConfirmedSchema,
  orderRejectedSchema,
]);

export type OrderEventContract = z.infer<typeof orderEventSchema>;
