import { inject } from 'vitest';
import { RedisConnection } from '../../../../src/core/cache/redis.connection.js';
import type { OrderTimeline } from '../../../../src/features/order-history/application/contracts/order-history.repository.js';
import { OrderView } from '../../../../src/features/order-history/domain/order-view.js';
import { RedisTimelineCache } from '../../../../src/features/order-history/infrastructure/redis-timeline-cache.js';
import { randomUUID } from 'node:crypto';

function timeline(orderId: string, events = 1): OrderTimeline {
  const view = OrderView.restore({
    orderId,
    customerId: 'c-1',
    status: 'confirmed',
    stockResult: 'reserved',
    rejectionReason: null,
    totalAmount: '20.00',
    items: [{ productId: 'SKU-001', quantity: 2, unitPrice: '10.00' }],
    createdAt: new Date('2026-10-31T12:00:00.000Z'),
    lastEventAt: new Date('2026-10-31T12:00:02.000Z'),
  });
  return {
    view,
    events: Array.from({ length: events }, (_, i) => ({
      eventId: randomUUID(),
      orderId,
      eventType: 'order.created',
      occurredAt: new Date(Date.parse('2026-10-31T12:00:00.000Z') + i * 1000),
      correlationId: `corr-${orderId}`,
      payload: { reason: null, nested: { n: i } },
    })),
  };
}

// Against a real Redis: TTLs and the invalidation counter are Redis semantics.
describe('RedisTimelineCache', () => {
  let redis: RedisConnection;
  let cache: RedisTimelineCache;

  beforeAll(async () => {
    redis = new RedisConnection({ REDIS_URL: inject('redisUrl') });
    redis.start();
    await vi.waitFor(() => expect(redis.isHealthy()).toBe(true), {
      timeout: 10_000,
    });
    cache = new RedisTimelineCache(redis);
  });

  afterAll(async () => {
    await redis.close();
  });

  it('loads a miss once and serves the next read from Redis', async () => {
    const orderId = randomUUID();
    const stored = timeline(orderId, 2);
    const load = vi.fn(async () => stored);

    const first = await cache.getOrLoad(orderId, load);
    const second = await cache.getOrLoad(orderId, load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toBe(stored);
    expect(second).toEqual(stored);
    expect(second?.view).toBeInstanceOf(OrderView);
  });

  it('does not cache an unknown order', async () => {
    const orderId = randomUUID();
    const load = vi.fn(async () => null);

    await cache.getOrLoad(orderId, load);
    await cache.getOrLoad(orderId, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('loads again after the order is invalidated', async () => {
    const orderId = randomUUID();
    await cache.getOrLoad(orderId, async () => timeline(orderId, 1));

    await cache.invalidate(orderId);
    const fresh = await cache.getOrLoad(orderId, async () =>
      timeline(orderId, 2),
    );

    expect(fresh?.events).toHaveLength(2);
  });

  it('never serves what a read loaded while an event invalidated it', async () => {
    const orderId = randomUUID();
    // The read gets the old state from Postgres, the projection commits and
    // invalidates, and only then does the read write to the cache.
    const stale = await cache.getOrLoad(orderId, async () => {
      await cache.invalidate(orderId);
      return timeline(orderId, 1);
    });

    const next = await cache.getOrLoad(orderId, async () =>
      timeline(orderId, 2),
    );

    expect(stale?.events).toHaveLength(1);
    expect(next?.events).toHaveLength(2);
  });

  it('lets entries expire', async () => {
    const shortLived = new RedisTimelineCache(redis, { ttlSeconds: 1 });
    const orderId = randomUUID();
    const load = vi.fn(async () => timeline(orderId));

    await shortLived.getOrLoad(orderId, load);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await shortLived.getOrLoad(orderId, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  describe('with Redis down', () => {
    let down: RedisConnection;

    beforeAll(() => {
      down = new RedisConnection({ REDIS_URL: 'redis://127.0.0.1:1/0' });
      down.start();
    });

    afterAll(async () => {
      await down.close();
    });

    it('reports itself unhealthy', () => {
      expect(down.isHealthy()).toBe(false);
    });

    it('reads straight from the database and invalidates without failing', async () => {
      const orderId = randomUUID();
      const offline = new RedisTimelineCache(down);
      const load = vi.fn(async () => timeline(orderId));

      await expect(offline.getOrLoad(orderId, load)).resolves.not.toBeNull();
      await expect(offline.invalidate(orderId)).resolves.toBeUndefined();
      expect(load).toHaveBeenCalledTimes(1);
    });
  });
});
