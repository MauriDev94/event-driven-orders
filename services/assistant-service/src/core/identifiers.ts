import { z } from 'zod';

/**
 * order-service's `ID_PATTERN` and `ID_MAX_LENGTH`: plain identifiers, never
 * free text. Order ids, customer ids (the `sub` of a session token) and
 * product ids all follow them, and so does anything that ends up in a cache
 * key (no `:`, no NUL).
 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const ID_MAX_LENGTH = 36;

export const idSchema = z.string().min(1).max(ID_MAX_LENGTH).regex(ID_PATTERN);

/** Whether `value` can be an id: anything else cannot name a real order. */
export function isValidId(value: unknown): value is string {
  return idSchema.safeParse(value).success;
}

/**
 * Fails closed: Prisma drops a filter whose value is `undefined`, so a query
 * without a customer would return every customer's rows. Adapters call this
 * before they build a query (ADR-0027).
 */
export function assertCustomerId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value === '') {
    throw new Error('a customer id is required to query orders');
  }
}
