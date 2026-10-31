import type { RedisConnection } from '../../../core/cache/redis.connection.js';
import {
  type RateLimitDecision,
  RateLimiter,
  RateLimiterUnavailableError,
} from '../application/contracts/rate-limiter.js';

export interface RedisRateLimiterOptions {
  limit: number;
  windowSeconds: number;
}

/**
 * Fixed window with INCR. The expiry is set in the same MULTI with `NX`, so
 * the first hit of a window starts it and a crash between the two commands
 * can't leave a counter that never expires (and blocks the key forever).
 */
export class RedisRateLimiter extends RateLimiter {
  constructor(
    private readonly redis: RedisConnection,
    private readonly options: RedisRateLimiterOptions,
  ) {
    super();
  }

  async hit(key: string): Promise<RateLimitDecision> {
    const redisKey = `rate-limit:${key}`;
    let replies: unknown[];
    try {
      replies = await this.redis.client
        .multi()
        .incr(redisKey)
        .expire(redisKey, this.options.windowSeconds, 'NX')
        .ttl(redisKey)
        .exec();
    } catch (error) {
      throw new RateLimiterUnavailableError('the rate limiter is unavailable', {
        cause: error,
      });
    }
    const count = Number(replies[0]);
    const ttl = Number(replies[2]);
    return {
      allowed: count <= this.options.limit,
      retryAfterSeconds: ttl > 0 ? ttl : this.options.windowSeconds,
    };
  }
}
