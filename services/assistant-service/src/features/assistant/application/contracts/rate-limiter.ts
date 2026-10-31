export interface RateLimitDecision {
  allowed: boolean;
  /** When the current window ends, for the Retry-After header. */
  retryAfterSeconds: number;
}

/** Fixed-window counter per key (the client IP for the assistant). */
export abstract class RateLimiter {
  abstract hit(key: string): Promise<RateLimitDecision>;
}

/**
 * The limiter can't count. The endpoint then refuses the question (fails
 * closed): the limit exists to protect the model's free quota.
 */
export class RateLimiterUnavailableError extends Error {
  override readonly name = 'RateLimiterUnavailableError';
}
