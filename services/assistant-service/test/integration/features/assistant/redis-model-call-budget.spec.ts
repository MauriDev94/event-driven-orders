import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { RedisConnection } from '../../../../src/core/cache/redis.connection.js';
import { ModelCallBudgetUnavailableError } from '../../../../src/features/assistant/application/contracts/model-call-budget.js';
import { RedisModelCallBudget } from '../../../../src/features/assistant/infrastructure/redis-model-call-budget.js';

// Against a real Redis: one counter per quota day, with its expiry in one MULTI.
describe('RedisModelCallBudget', () => {
  let redis: RedisConnection;

  beforeAll(async () => {
    redis = new RedisConnection({ REDIS_URL: inject('redisUrl') });
    redis.start();
    await vi.waitFor(() => expect(redis.isHealthy()).toBe(true), {
      timeout: 10_000,
    });
  });

  afterAll(async () => {
    await redis.close();
  });

  function budget(
    limit: number,
    now: () => Date,
    keyPrefix: string,
    perMinuteLimit = 1_000,
  ) {
    return new RedisModelCallBudget(redis, {
      limit,
      perMinuteLimit,
      now,
      keyPrefix,
    });
  }

  it('allows the daily limit and refuses the next call', async () => {
    const prefix = `model-calls-${randomUUID()}`;
    const calls = budget(3, () => new Date('2026-10-31T15:00:00Z'), prefix);

    const taken = [];
    for (let i = 0; i < 4; i++) taken.push(await calls.take());

    expect(taken).toEqual([true, true, true, false]);
  });

  it('counts by the day of Pacific time, when Gemini resets its quota', async () => {
    const prefix = `model-calls-${randomUUID()}`;
    let now = new Date('2026-10-31T06:59:00Z'); // 23:59 of Oct 30 in Los Angeles
    const calls = budget(1, () => now, prefix);

    expect(await calls.take()).toBe(true);
    expect(await calls.take()).toBe(false);
    now = new Date('2026-10-31T07:00:00Z'); // midnight of Oct 31 there

    expect(await calls.take()).toBe(true);
    expect(await redis.client.get(`${prefix}:2026-10-30`)).toBe('1');
    expect(await redis.client.get(`${prefix}:2026-10-31`)).toBe('1');
  });

  it('lets each day counter expire after two days', async () => {
    const prefix = `model-calls-${randomUUID()}`;
    await budget(5, () => new Date('2026-10-31T15:00:00Z'), prefix).take();

    const ttl = await redis.client.ttl(`${prefix}:2026-10-31`);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2 * 24 * 60 * 60);
  });

  describe('per-minute cap', () => {
    const noon = new Date('2026-10-31T15:00:00Z');

    it('refuses calls past the cap within the same minute', async () => {
      const prefix = `model-calls-${randomUUID()}`;
      const calls = budget(100, () => noon, prefix, 3);

      const taken = [];
      for (let i = 0; i < 4; i++) taken.push(await calls.take());

      expect(taken).toEqual([true, true, true, false]);
    });

    it('opens again when the next minute starts', async () => {
      const prefix = `model-calls-${randomUUID()}`;
      let now = new Date('2026-10-31T15:00:59Z');
      const calls = budget(100, () => now, prefix, 1);

      expect(await calls.take()).toBe(true);
      expect(await calls.take()).toBe(false);
      now = new Date('2026-10-31T15:01:00Z');

      expect(await calls.take()).toBe(true);
    });

    it('does not burn a daily unit when the minute cap refuses', async () => {
      const prefix = `model-calls-${randomUUID()}`;
      const calls = budget(100, () => noon, prefix, 2);

      for (let i = 0; i < 6; i++) await calls.take();

      expect(await redis.client.get(`${prefix}:2026-10-31`)).toBe('2');
    });

    it('does not burn a minute unit when the daily budget refuses', async () => {
      const prefix = `model-calls-${randomUUID()}`;
      let now = new Date('2026-10-31T15:00:00Z');
      const calls = budget(1, () => now, prefix, 5);
      await calls.take();
      now = new Date('2026-10-31T15:05:00Z');
      for (let i = 0; i < 4; i++) expect(await calls.take()).toBe(false);

      const minuteKeys = await redis.client.keys(`${prefix}:minute:*`);
      const counts = await Promise.all(
        minuteKeys.map((key) => redis.client.get(key)),
      );
      expect(counts.map(Number)).toEqual([1]);
    });

    it('lets each minute counter expire', async () => {
      const prefix = `model-calls-${randomUUID()}`;
      await budget(100, () => noon, prefix, 5).take();

      const [key] = await redis.client.keys(`${prefix}:minute:*`);
      const ttl = await redis.client.ttl(key!);

      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120);
    });

    it('is atomic under concurrent calls', async () => {
      const prefix = `model-calls-${randomUUID()}`;
      const calls = budget(100, () => noon, prefix, 5);

      const taken = await Promise.all(
        Array.from({ length: 20 }, () => calls.take()),
      );

      expect(taken.filter(Boolean)).toHaveLength(5);
      expect(await redis.client.get(`${prefix}:2026-10-31`)).toBe('5');
    });
  });

  it('fails closed when Redis is down', async () => {
    const down = new RedisConnection({ REDIS_URL: 'redis://127.0.0.1:1/0' });
    down.start();
    try {
      const calls = new RedisModelCallBudget(down, {
        limit: 5,
        perMinuteLimit: 5,
      });

      await expect(calls.take()).rejects.toThrow(
        ModelCallBudgetUnavailableError,
      );
    } finally {
      await down.close();
    }
  });
});
