import { inject } from 'vitest';
import { RedisConnection } from '../../../../src/core/cache/redis.connection.js';
import type { OrderTimeline } from '../../../../src/features/order-history/application/contracts/order-history.repository.js';
import { OrderView } from '../../../../src/features/order-history/domain/order-view.js';
import { RedisTimelineCache } from '../../../../src/features/order-history/infrastructure/redis-timeline-cache.js';
import { randomUUID } from 'node:crypto';

const CUSTOMER = 'c-1';

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

    const first = await cache.getOrLoad(orderId, CUSTOMER, load);
    const second = await cache.getOrLoad(orderId, CUSTOMER, load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toBe(stored);
    expect(second).toEqual(stored);
    expect(second?.view).toBeInstanceOf(OrderView);
  });

  it('does not cache an unknown order', async () => {
    const orderId = randomUUID();
    const load = vi.fn(async () => null);

    await cache.getOrLoad(orderId, CUSTOMER, load);
    await cache.getOrLoad(orderId, CUSTOMER, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('loads again after the order is invalidated', async () => {
    const orderId = randomUUID();
    await cache.getOrLoad(orderId, CUSTOMER, async () => timeline(orderId, 1));

    await cache.invalidate(orderId);
    const fresh = await cache.getOrLoad(orderId, CUSTOMER, async () =>
      timeline(orderId, 2),
    );

    expect(fresh?.events).toHaveLength(2);
  });

  it('never serves what a read loaded while an event invalidated it', async () => {
    const orderId = randomUUID();
    // The read gets the old state from Postgres, the projection commits and
    // invalidates, and only then does the read write to the cache.
    const stale = await cache.getOrLoad(orderId, CUSTOMER, async () => {
      await cache.invalidate(orderId);
      return timeline(orderId, 1);
    });

    const next = await cache.getOrLoad(orderId, CUSTOMER, async () =>
      timeline(orderId, 2),
    );

    expect(stale?.events).toHaveLength(1);
    expect(next?.events).toHaveLength(2);
  });

  describe('per customer (SEC94-01)', () => {
    const OTHER = 'c-2';

    it('keeps one entry per order and customer, and never serves one to the other', async () => {
      const orderId = randomUUID();
      const mine = vi.fn(async () => timeline(orderId, 1));
      const theirs = vi.fn(async () => null);

      await cache.getOrLoad(orderId, CUSTOMER, mine);
      await cache.getOrLoad(orderId, CUSTOMER, mine);
      const foreign = await cache.getOrLoad(orderId, OTHER, theirs);
      await cache.getOrLoad(orderId, OTHER, theirs);

      expect(mine).toHaveBeenCalledTimes(1);
      expect(foreign).toBeNull();
      expect(theirs).toHaveBeenCalledTimes(2);
    });

    it('writes no key for a customer whose load found nothing', async () => {
      const orderId = randomUUID();
      await cache.getOrLoad(orderId, CUSTOMER, async () =>
        timeline(orderId, 1),
      );

      await cache.getOrLoad(orderId, OTHER, async () => null);

      const keys = await redis.client.keys(`order-timeline:${orderId}*`);
      expect(keys.sort()).toEqual(
        [`order-timeline:${orderId}:customer:${CUSTOMER}`].sort(),
      );
    });

    it('still invalidates the entry of the owner', async () => {
      const orderId = randomUUID();
      await cache.getOrLoad(orderId, CUSTOMER, async () =>
        timeline(orderId, 1),
      );

      await cache.invalidate(orderId);
      const fresh = await cache.getOrLoad(orderId, CUSTOMER, async () =>
        timeline(orderId, 2),
      );

      expect(fresh?.events).toHaveLength(2);
    });

    it('cannot mix an entry key with the generation key, whatever the customer id', async () => {
      const orderId = randomUUID();
      await cache.getOrLoad(orderId, 'generation', async () =>
        timeline(orderId, 1),
      );

      await cache.invalidate(orderId);
      const fresh = await cache.getOrLoad(orderId, 'generation', async () =>
        timeline(orderId, 2),
      );

      expect(fresh?.events).toHaveLength(2);
      expect(
        await redis.client.get(`order-timeline:${orderId}:generation`),
      ).toBe('1');
    });
  });

  describe('size cap', () => {
    function big(orderId: string, bytes: number, char = 'x'): OrderTimeline {
      const stored = timeline(orderId, 1);
      stored.events[0]!.payload = { blob: char.repeat(bytes) };
      return stored;
    }

    it('serves an oversized timeline from the database every time and never stores it', async () => {
      const orderId = randomUUID();
      const load = vi.fn(async () => big(orderId, 70_000));

      const first = await cache.getOrLoad(orderId, CUSTOMER, load);
      await cache.getOrLoad(orderId, CUSTOMER, load);

      expect(first?.events).toHaveLength(1);
      expect(load).toHaveBeenCalledTimes(2);
      expect(
        await redis.client.exists(
          `order-timeline:${orderId}:customer:${CUSTOMER}`,
        ),
      ).toBe(0);
    });

    it('still caches an entry under the cap', async () => {
      const orderId = randomUUID();
      const load = vi.fn(async () => big(orderId, 20_000));

      await cache.getOrLoad(orderId, CUSTOMER, load);
      await cache.getOrLoad(orderId, CUSTOMER, load);

      expect(load).toHaveBeenCalledTimes(1);
    });

    it('measures the cap in UTF-8 bytes, not characters', async () => {
      const small = new RedisTimelineCache(redis, { maxEntryBytes: 1_500 });
      const orderId = randomUUID();
      // 700 characters but 1400 bytes of payload, plus the rest of the entry.
      const load = vi.fn(async () => big(orderId, 700, 'ñ'));
      const asciiId = randomUUID();
      const asciiLoad = vi.fn(async () => big(asciiId, 700));

      await small.getOrLoad(orderId, CUSTOMER, load);
      await small.getOrLoad(orderId, CUSTOMER, load);
      await small.getOrLoad(asciiId, CUSTOMER, asciiLoad);
      await small.getOrLoad(asciiId, CUSTOMER, asciiLoad);

      expect(load).toHaveBeenCalledTimes(2);
      expect(asciiLoad).toHaveBeenCalledTimes(1);
    });

    it('keeps the generation protocol when it skips the write', async () => {
      const orderId = randomUUID();
      await cache.invalidate(orderId);

      await cache.getOrLoad(orderId, CUSTOMER, async () =>
        big(orderId, 70_000),
      );
      const next = await cache.getOrLoad(orderId, CUSTOMER, async () =>
        timeline(orderId, 2),
      );

      expect(next?.events).toHaveLength(2);
      expect(
        await redis.client.get(`order-timeline:${orderId}:generation`),
      ).toBe('1');
    });
  });

  it('lets entries expire', async () => {
    const shortLived = new RedisTimelineCache(redis, { ttlSeconds: 1 });
    const orderId = randomUUID();
    const load = vi.fn(async () => timeline(orderId));

    await shortLived.getOrLoad(orderId, CUSTOMER, load);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await shortLived.getOrLoad(orderId, CUSTOMER, load);

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

      await expect(
        offline.getOrLoad(orderId, CUSTOMER, load),
      ).resolves.not.toBeNull();
      await expect(offline.invalidate(orderId)).resolves.toBeUndefined();
      expect(load).toHaveBeenCalledTimes(1);
    });
  });
});
