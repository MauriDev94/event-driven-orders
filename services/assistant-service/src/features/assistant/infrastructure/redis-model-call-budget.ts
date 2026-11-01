import type { RedisConnection } from '../../../core/cache/redis.connection.js';
import {
  ModelCallBudget,
  ModelCallBudgetUnavailableError,
} from '../application/contracts/model-call-budget.js';

export interface RedisModelCallBudgetOptions {
  /** Model calls allowed per quota day. */
  limit: number;
  /** Gemini resets its daily quota at midnight Pacific time. */
  timeZone?: string;
  keyPrefix?: string;
  now?: () => Date;
}

// A day counter only matters during its day; two days is a safe margin.
const COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;

/**
 * One INCR counter per quota day (`model-calls:YYYY-MM-DD`), with the day
 * taken in the provider's time zone, so the budget resets when the quota
 * does. The expiry goes in the same MULTI with `NX`, like the rate limit.
 */
export class RedisModelCallBudget extends ModelCallBudget {
  private readonly day: Intl.DateTimeFormat;
  private readonly keyPrefix: string;
  private readonly now: () => Date;

  constructor(
    private readonly redis: RedisConnection,
    private readonly options: RedisModelCallBudgetOptions,
  ) {
    super();
    this.day = new Intl.DateTimeFormat('en-US', {
      timeZone: options.timeZone ?? 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    this.keyPrefix = options.keyPrefix ?? 'model-calls';
    this.now = options.now ?? (() => new Date());
  }

  async take(): Promise<boolean> {
    const key = `${this.keyPrefix}:${this.quotaDay()}`;
    let replies: unknown[];
    try {
      replies = await this.redis.client
        .multi()
        .incr(key)
        .expire(key, COUNTER_TTL_SECONDS, 'NX')
        .exec();
    } catch (error) {
      throw new ModelCallBudgetUnavailableError(
        'the model call budget is unavailable',
        { cause: error },
      );
    }
    return Number(replies[0]) <= this.options.limit;
  }

  /** YYYY-MM-DD of the current moment in the quota's time zone. */
  private quotaDay(): string {
    const parts = Object.fromEntries(
      this.day.formatToParts(this.now()).map((part) => [part.type, part.value]),
    );
    return `${parts['year']}-${parts['month']}-${parts['day']}`;
  }
}
