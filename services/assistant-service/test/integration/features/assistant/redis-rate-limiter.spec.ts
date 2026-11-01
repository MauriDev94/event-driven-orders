import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { RedisConnection } from '../../../../src/core/cache/redis.connection.js';
import { RateLimiterUnavailableError } from '../../../../src/features/assistant/application/contracts/rate-limiter.js';
import { RedisRateLimiter } from '../../../../src/features/assistant/infrastructure/redis-rate-limiter.js';

// Against a real Redis: the counter and its expiry run in one MULTI.
describe('RedisRateLimiter', () => {
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

  it('allows the limit within the window and refuses the next one', async () => {
    const limiter = new RedisRateLimiter(redis, {
      limit: 3,
      windowSeconds: 60,
    });
    const key = `ip-${randomUUID()}`;

    const decisions = [];
    for (let i = 0; i < 4; i++) decisions.push(await limiter.hit(key));

    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
    const refused = decisions[3];
    expect(refused?.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused?.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('counts each key on its own', async () => {
    const limiter = new RedisRateLimiter(redis, {
      limit: 1,
      windowSeconds: 60,
    });

    expect((await limiter.hit(`ip-${randomUUID()}`)).allowed).toBe(true);
    expect((await limiter.hit(`ip-${randomUUID()}`)).allowed).toBe(true);
  });

  it('starts a new window once the old one expires', async () => {
    const limiter = new RedisRateLimiter(redis, { limit: 1, windowSeconds: 1 });
    const key = `ip-${randomUUID()}`;
    await limiter.hit(key);
    expect((await limiter.hit(key)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect((await limiter.hit(key)).allowed).toBe(true);
  });

  it('fails closed when Redis is down', async () => {
    const down = new RedisConnection({ REDIS_URL: 'redis://127.0.0.1:1/0' });
    down.start();
    try {
      const limiter = new RedisRateLimiter(down, {
        limit: 5,
        windowSeconds: 60,
      });

      await expect(limiter.hit('ip-1')).rejects.toThrow(
        RateLimiterUnavailableError,
      );
    } finally {
      await down.close();
    }
  });
});
