import type { RedisConnection } from '../../../core/cache/redis.connection.js';
import {
  ModelCallBudget,
  ModelCallBudgetUnavailableError,
} from '../application/contracts/model-call-budget.js';

export interface RedisModelCallBudgetOptions {
  /** Model calls allowed per quota day. */
  limit: number;
  /** Model calls allowed per minute, across all clients. */
  perMinuteLimit: number;
  /** Gemini resets its daily quota at midnight Pacific time. */
  timeZone?: string;
  keyPrefix?: string;
  now?: () => Date;
}

// A day counter only matters during its day; two days is a safe margin.
const COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;
// A minute counter only matters during its minute; two minutes is the margin.
const MINUTE_COUNTER_TTL_SECONDS = 2 * 60;

const OK = 0;
const MINUTE_SPENT = 1;
const DAY_SPENT = 2;

/**
 * Checks both counters and takes a unit from both, or from neither, so a
 * refused call burns nothing: with two plain INCRs in a MULTI, a call
 * refused by the minute cap would still eat a daily unit for a model call
 * that never happened. One script is atomic in Redis. Every key it creates
 * gets its expiry in the same script (`NX`), because the eviction policy is
 * `volatile-ttl` and a key without a TTL could never be evicted (ADR-0026).
 */
const TAKE_SCRIPT = `
local minute = tonumber(redis.call('GET', KEYS[1]) or '0')
if minute >= tonumber(ARGV[1]) then return ${MINUTE_SPENT} end
local day = tonumber(redis.call('GET', KEYS[2]) or '0')
if day >= tonumber(ARGV[2]) then return ${DAY_SPENT} end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[3], 'NX')
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[4], 'NX')
return ${OK}
`;

/**
 * Two INCR counters: one per quota day (`model-calls:YYYY-MM-DD`), with the
 * day taken in the provider's time zone so the budget resets when the quota
 * does, and one per calendar minute (`model-calls:minute:<epoch minute>`).
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
    const now = this.now();
    const minuteKey = `${this.keyPrefix}:minute:${Math.floor(now.getTime() / 60_000)}`;
    const dayKey = `${this.keyPrefix}:${this.quotaDay(now)}`;
    let reply: unknown;
    try {
      reply = await this.redis.client.eval(TAKE_SCRIPT, {
        keys: [minuteKey, dayKey],
        arguments: [
          String(this.options.perMinuteLimit),
          String(this.options.limit),
          String(MINUTE_COUNTER_TTL_SECONDS),
          String(COUNTER_TTL_SECONDS),
        ],
      });
    } catch (error) {
      throw new ModelCallBudgetUnavailableError(
        'the model call budget is unavailable',
        { cause: error },
      );
    }
    return Number(reply) === OK;
  }

  /** YYYY-MM-DD of the given moment in the quota's time zone. */
  private quotaDay(at: Date): string {
    const parts = Object.fromEntries(
      this.day.formatToParts(at).map((part) => [part.type, part.value]),
    );
    return `${parts['year']}-${parts['month']}-${parts['day']}`;
  }
}
