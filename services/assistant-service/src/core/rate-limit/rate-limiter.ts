export interface RateLimitDecision {
  allowed: boolean;
  /** When the current window ends, for the Retry-After header. */
  retryAfterSeconds: number;
}

/** Fixed-window counter per key (a client IP, prefixed by the endpoint). */
export abstract class RateLimiter {
  abstract hit(key: string): Promise<RateLimitDecision>;
}

/**
 * The limiter can't count. Each guard decides what that means: `/ask` fails
 * closed (it protects the model's free quota) and the timeline fails open
 * (it only reads the database).
 */
export class RateLimiterUnavailableError extends Error {
  override readonly name = 'RateLimiterUnavailableError';
}
