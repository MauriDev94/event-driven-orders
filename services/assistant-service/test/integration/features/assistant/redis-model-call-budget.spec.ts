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

  function budget(limit: number, now: () => Date, keyPrefix: string) {
    return new RedisModelCallBudget(redis, { limit, now, keyPrefix });
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
    expect(await redis.client.get(`${prefix}:2026-10-30`)).toBe('2');
    expect(await redis.client.get(`${prefix}:2026-10-31`)).toBe('1');
  });

  it('lets each day counter expire after two days', async () => {
    const prefix = `model-calls-${randomUUID()}`;
    await budget(5, () => new Date('2026-10-31T15:00:00Z'), prefix).take();

    const ttl = await redis.client.ttl(`${prefix}:2026-10-31`);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2 * 24 * 60 * 60);
  });

  it('fails closed when Redis is down', async () => {
    const down = new RedisConnection({ REDIS_URL: 'redis://127.0.0.1:1/0' });
    down.start();
    try {
      const calls = new RedisModelCallBudget(down, { limit: 5 });

      await expect(calls.take()).rejects.toThrow(
        ModelCallBudgetUnavailableError,
      );
    } finally {
      await down.close();
    }
  });
});
