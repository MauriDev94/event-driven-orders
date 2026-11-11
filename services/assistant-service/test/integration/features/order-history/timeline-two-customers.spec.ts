import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { RedisConnection } from '../../../../src/core/cache/redis.connection.js';
import { PrismaService } from '../../../../src/core/database/prisma.service.js';
import { toProjectionCommand } from '../../../../src/features/order-history/application/mappers/order-event.mapper.js';
import { GetOrderTimeline } from '../../../../src/features/order-history/application/usecases/get-order-timeline.js';
import { ProjectOrderEvent } from '../../../../src/features/order-history/application/usecases/project-order-event.js';
import { PrismaOrderHistoryRepository } from '../../../../src/features/order-history/infrastructure/prisma-order-history.repository.js';
import { RedisTimelineCache } from '../../../../src/features/order-history/infrastructure/redis-timeline-cache.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../support/database.js';
import { orderCreated, stockReserved } from '../../../support/order-events.js';

const ME = 'customer-me';
const OTHER = 'customer-other';

// SEC94-01: the real repository, the real cache and two customers. A foreign
// order must cost what a missing one costs, and must leave no cache key.
describe('timeline with two customers (Postgres and Redis)', () => {
  let database: TestDatabase;
  let prisma: PrismaService;
  let redis: RedisConnection;
  let project: ProjectOrderEvent;
  let timeline: GetOrderTimeline;
  let repository: PrismaOrderHistoryRepository;

  beforeAll(async () => {
    database = await createTestDatabase(inject('adminDatabaseUrl'));
    prisma = new PrismaService({ DATABASE_URL: database.url });
    redis = new RedisConnection({ REDIS_URL: inject('redisUrl') });
    redis.start();
    await vi.waitFor(() => expect(redis.isHealthy()).toBe(true), {
      timeout: 10_000,
    });
    repository = new PrismaOrderHistoryRepository(prisma);
    const cache = new RedisTimelineCache(redis);
    project = new ProjectOrderEvent(repository, cache);
    timeline = new GetOrderTimeline(repository, cache);
  });

  afterAll(async () => {
    await redis.close();
    await prisma.$disconnect();
    await database.drop();
  });

  const cacheKeys = (orderId: string) =>
    redis.client.keys(`order-timeline:${orderId}:customer:*`);

  async function create(orderId: string, customerId: string) {
    await project.execute(
      toProjectionCommand(orderCreated(orderId, { customer_id: customerId })),
    );
  }

  it('serves each customer only their order, and caches only the owner', async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    await create(mine, ME);
    await create(theirs, OTHER);

    expect(await timeline.execute(mine, ME)).toMatchObject({
      view: { orderId: mine },
    });
    expect(await timeline.execute(theirs, ME)).toBeNull();
    expect(await timeline.execute(mine, OTHER)).toBeNull();
    expect(await timeline.execute(theirs, OTHER)).not.toBeNull();

    expect(await cacheKeys(mine)).toEqual(
      expect.arrayContaining([`order-timeline:${mine}:customer:${ME}`]),
    );
    expect(await cacheKeys(mine)).not.toContainEqual(
      expect.stringContaining(`:customer:${OTHER}`),
    );
    expect(await cacheKeys(theirs)).not.toContainEqual(
      expect.stringContaining(`:customer:${ME}`),
    );
  });

  it('never creates a cache key for a foreign or a missing order', async () => {
    const theirs = randomUUID();
    const missing = randomUUID();
    await create(theirs, OTHER);

    await timeline.execute(theirs, ME);
    await timeline.execute(missing, ME);

    expect(await cacheKeys(theirs)).toEqual([]);
    expect(await cacheKeys(missing)).toEqual([]);
  });

  it('does not serve the warm entry of the owner to the other customer', async () => {
    const orderId = randomUUID();
    await create(orderId, ME);
    await timeline.execute(orderId, ME);
    const spy = vi.spyOn(repository, 'findTimeline');

    expect(await timeline.execute(orderId, OTHER)).toBeNull();

    // Not answered from the owner's entry: it went to the filtered query.
    expect(spy).toHaveBeenCalledWith(orderId, OTHER);
  });

  it('shows the owner a new event right away', async () => {
    const orderId = randomUUID();
    await create(orderId, ME);
    expect((await timeline.execute(orderId, ME))?.events).toHaveLength(1);

    await project.execute(toProjectionCommand(stockReserved(orderId)));

    expect((await timeline.execute(orderId, ME))?.events).toHaveLength(2);
  });

  it('is a 404 for everyone until order.created arrives', async () => {
    const orderId = randomUUID();
    await project.execute(toProjectionCommand(stockReserved(orderId)));

    expect(await timeline.execute(orderId, ME)).toBeNull();
    expect(await cacheKeys(orderId)).not.toContainEqual(
      expect.stringContaining(':customer:'),
    );
  });

  it('runs one query for a foreign order, as for a missing one', async () => {
    const theirs = randomUUID();
    await create(theirs, OTHER);
    const queries: string[] = [];
    const logged = new PrismaService({ DATABASE_URL: database.url });
    // Count the statements each lookup sends to Postgres.
    const client = logged.$extends({
      query: {
        $allOperations({ model, operation, args, query }) {
          queries.push(`${model}.${operation}`);
          return query(args);
        },
      },
    });
    const probe = new PrismaOrderHistoryRepository(
      client as unknown as PrismaService,
    );

    await probe.findTimeline(theirs, ME);
    const foreign = queries.length;
    queries.length = 0;
    await probe.findTimeline(randomUUID(), ME);
    const missing = queries.length;
    await logged.$disconnect();

    expect(foreign).toBe(1);
    expect(missing).toBe(1);
  });
});
