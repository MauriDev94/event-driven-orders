/**
 * zod mirror of the Python contracts in `shared/contracts` (ADR-0003): the
 * contract is the JSON on the wire. The publishers serialize with Pydantic's
 * `model_dump_json()`, which writes `Decimal` as a string and datetimes in
 * ISO 8601 with an offset. test/unit/core/messaging/contracts.spec.ts parses
 * fixtures exported from the Pydantic models, so a drift fails the tests.
 *
 * Unknown fields are dropped, like Pydantic's default.
 *
 * Unlike the Pydantic models, the ids, the reason and the items are bounded
 * (the same rules as order-service's request validation), so text a visitor
 * controls, or someone publishing straight to the broker, can't grow the read
 * model or what the assistant sends to the model. A violation is a ZodError,
 * which goes to the DLQ.
 */
import { z } from 'zod';
import { idSchema } from '../identifiers.js';

/** Ids follow order-service's ID_PATTERN and ID_MAX_LENGTH (see identifiers.ts). */
const id = idSchema;

const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'expected a non-negative decimal string');

/** The longest reason inventory writes is ~67 characters; this is 3x that. */
const REASON_MAX_LENGTH = 200;
/** order-service's `MAX_ORDER_LINES`: an accepted order is never dead-lettered. */
const MAX_ITEMS = 50;

const baseEvent = {
  event_id: id,
  occurred_at: z.iso.datetime({ offset: true }),
  correlation_id: z.string(),
  order_id: id,
};

export const orderItemSchema = z.object({
  product_id: id,
  quantity: z.number().int().positive(),
  unit_price: decimal,
});

export const orderCreatedSchema = z.object({
  ...baseEvent,
  event_type: z.literal('order.created'),
  customer_id: id,
  items: z.array(orderItemSchema).max(MAX_ITEMS),
  total_amount: decimal,
});

export const stockReservedSchema = z.object({
  ...baseEvent,
  event_type: z.literal('stock.reserved'),
});

export const stockRejectedSchema = z.object({
  ...baseEvent,
  event_type: z.literal('stock.rejected'),
  reason: z.string().max(REASON_MAX_LENGTH),
});

export const orderConfirmedSchema = z.object({
  ...baseEvent,
  event_type: z.literal('order.confirmed'),
  customer_id: id,
});

export const orderRejectedSchema = z.object({
  ...baseEvent,
  event_type: z.literal('order.rejected'),
  customer_id: id,
  reason: z.string().max(REASON_MAX_LENGTH),
});

export const orderEventSchema = z.discriminatedUnion('event_type', [
  orderCreatedSchema,
  stockReservedSchema,
  stockRejectedSchema,
  orderConfirmedSchema,
  orderRejectedSchema,
]);

export type OrderEventContract = z.infer<typeof orderEventSchema>;
