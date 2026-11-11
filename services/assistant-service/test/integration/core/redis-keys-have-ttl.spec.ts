import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { inject } from 'vitest';
import { RedisConnection } from '../../../src/core/cache/redis.connection.js';
import { toProjectionCommand } from '../../../src/features/order-history/application/mappers/order-event.mapper.js';
import { ProjectOrderEvent } from '../../../src/features/order-history/application/usecases/project-order-event.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../support/database.js';
import { orderCreated, stockReserved } from '../../support/order-events.js';
import {
  answer,
  ScriptedLlmClient,
} from '../../support/scripted-llm-client.js';
import { bearer } from '../../support/session-token.js';
import { createTestApp, randomIp } from '../../support/test-app.js';

// Redis runs with maxmemory-policy volatile-ttl (ADR-0026): a key without a
// TTL is never evicted, and enough of them make every write fail. So every
// write path of the service must leave a TTL on what it creates.
describe('Redis keys written by the service', () => {
  let database: TestDatabase;
  let app: NestExpressApplication;
  let redis: RedisConnection;

  beforeAll(async () => {
    database = await createTestDatabase(inject('adminDatabaseUrl'));
    app = await createTestApp({
      databaseUrl: database.url,
      env: { TRUST_PROXY: 'loopback' },
      llm: new ScriptedLlmClient([answer('hola')]),
    });
    redis = new RedisConnection({ REDIS_URL: inject('redisUrl') });
    redis.start();
    await vi.waitFor(() => expect(redis.isHealthy()).toBe(true), {
      timeout: 10_000,
    });
  });

  afterAll(async () => {
    await redis?.close();
    await app?.close();
    await database.drop();
  });

  async function allKeys(): Promise<string[]> {
    const keys = new Set<string>();
    for await (const batch of redis.client.scanIterator({ COUNT: 200 })) {
      for (const key of batch) keys.add(key);
    }
    return [...keys];
  }

  it('all have a TTL, and the TTLs order the eviction: 60 s first, the daily counter last', async () => {
    const ip = randomIp();
    const orderId = randomUUID();
    const project = app.get(ProjectOrderEvent);
    await project.execute(toProjectionCommand(orderCreated(orderId)));
    // Ask rate limit, daily and per-minute budgets.
    await request(app.getHttpServer())
      .post('/v1/assistant/ask')
      .set('X-Forwarded-For', ip)
      .set('Authorization', bearer('c-1'))
      .send({ question: 'hola' })
      .expect(200);
    // Timeline rate limit and cache entry.
    await request(app.getHttpServer())
      .get(`/v1/assistant/orders/${orderId}/timeline`)
      .set('X-Forwarded-For', ip)
      .set('Authorization', bearer('c-1'))
      .expect(200);
    // Generation counter (an event invalidates the cached entry).
    await project.execute(toProjectionCommand(stockReserved(orderId)));
    // The invalidation deleted the entry; read again so the scan sees a fresh one.
    await request(app.getHttpServer())
      .get(`/v1/assistant/orders/${orderId}/timeline`)
      .set('X-Forwarded-For', ip)
      .set('Authorization', bearer('c-1'))
      .expect(200);

    const keys = await allKeys();
    const ttls = new Map<string, number>();
    for (const key of keys) ttls.set(key, await redis.client.ttl(key));
    const find = (pattern: RegExp) => keys.filter((key) => pattern.test(key));

    expect(find(new RegExp(`^rate-limit:ask:${ip}$`))).toHaveLength(1);
    expect(find(new RegExp(`^rate-limit:timeline:${ip}$`))).toHaveLength(1);
    expect(find(/^model-calls:\d{4}-\d{2}-\d{2}$/).length).toBeGreaterThan(0);
    expect(find(/^model-calls:minute:\d+$/).length).toBeGreaterThan(0);
    expect(
      find(new RegExp(`^order-timeline:${orderId}:generation$`)),
    ).toHaveLength(1);
    const entryTtl = ttls.get(`order-timeline:${orderId}:customer:c-1`);
    expect(entryTtl).toBeGreaterThanOrEqual(1);
    expect(entryTtl).toBeLessThanOrEqual(60);
    expect([...ttls].filter(([, ttl]) => ttl === -1)).toEqual([]);

    const longest = (pattern: RegExp) =>
      Math.max(...find(pattern).map((key) => ttls.get(key)!));
    const rateLimit = longest(/^rate-limit:/);
    const minute = longest(/^model-calls:minute:/);
    const generation = longest(/^order-timeline:.*:generation$/);
    const daily = longest(/^model-calls:\d{4}-/);
    expect(rateLimit).toBeLessThanOrEqual(60);
    expect(minute).toBeLessThanOrEqual(120);
    expect(generation).toBeLessThanOrEqual(600);
    expect(rateLimit).toBeLessThan(generation);
    expect(generation).toBeLessThan(daily);
  });
});
