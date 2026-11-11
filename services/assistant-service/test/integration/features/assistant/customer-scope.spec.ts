import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { PrismaService } from '../../../../src/core/database/prisma.service.js';
import { ReadModelOrderQueries } from '../../../../src/features/assistant/infrastructure/read-model-order-queries.js';
import { toProjectionCommand } from '../../../../src/features/order-history/application/mappers/order-event.mapper.js';
import { GetOrderTimeline } from '../../../../src/features/order-history/application/usecases/get-order-timeline.js';
import { ProjectOrderEvent } from '../../../../src/features/order-history/application/usecases/project-order-event.js';
import { PrismaOrderHistoryRepository } from '../../../../src/features/order-history/infrastructure/prisma-order-history.repository.js';
import { PrismaOrderViewQueries } from '../../../../src/features/order-history/infrastructure/prisma-order-view.queries.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../support/database.js';
import { InMemoryTimelineCache } from '../../../support/in-memory-timeline-cache.js';
import { orderCreated } from '../../../support/order-events.js';

const ME = 'customer-me';
const OTHER = 'customer-other';
const LIMITS = { groups: 10, productIdsPerGroup: 20 };
const AT = new Date('2026-10-31T10:00:00.000Z');

// ADR-0027: the customer filter lives in the SQL, so these run against real
// Postgres with the orders of two customers side by side.
describe('customer scope of the read model queries', () => {
  let database: TestDatabase;
  let prisma: PrismaService;
  let project: ProjectOrderEvent;
  let queries: ReadModelOrderQueries;

  beforeAll(async () => {
    database = await createTestDatabase(inject('adminDatabaseUrl'));
    prisma = new PrismaService({ DATABASE_URL: database.url });
    const repository = new PrismaOrderHistoryRepository(prisma);
    const cache = new InMemoryTimelineCache();
    project = new ProjectOrderEvent(repository, cache);
    queries = new ReadModelOrderQueries(
      new PrismaOrderViewQueries(prisma),
      new GetOrderTimeline(repository, cache),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await database.drop();
  });

  beforeEach(async () => {
    await prisma.orderEventLog.deleteMany();
    await prisma.orderView.deleteMany();
  });

  function row(
    customerId: string | null,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      orderId: randomUUID(),
      customerId,
      status: 'rejected' as const,
      stockResult: 'rejected' as const,
      rejectionReason: 'insufficient stock for product SKU-005',
      items: [{ product_id: 'SKU-005', quantity: 1, unit_price: '1.00' }],
      createdAt: AT,
      lastEventAt: AT,
      ...overrides,
    };
  }

  describe('search', () => {
    it('never returns the orders of another customer, whatever the filter', async () => {
      const mine = row(ME);
      const theirs = row(OTHER, { lastEventAt: new Date(AT.getTime() + 1000) });
      const noOwner = row(null);
      await prisma.orderView.createMany({ data: [mine, theirs, noOwner] });

      const ids = async (filters: Record<string, unknown>) =>
        (await queries.search({ customerId: ME, limit: 10, ...filters })).map(
          (order) => order.orderId,
        );

      expect(await ids({})).toEqual([mine.orderId]);
      expect(await ids({ status: 'rejected' })).toEqual([mine.orderId]);
      expect(await ids({ productId: 'SKU-005' })).toEqual([mine.orderId]);
      expect(await ids({ from: new Date('2026-10-31T00:00:00Z') })).toEqual([
        mine.orderId,
      ]);
    });

    it('gives each customer only their own orders', async () => {
      const mine = row(ME);
      const theirs = row(OTHER);
      await prisma.orderView.createMany({ data: [mine, theirs] });

      const asOther = await queries.search({ customerId: OTHER, limit: 10 });

      expect(asOther.map((order) => order.orderId)).toEqual([theirs.orderId]);
    });

    it('applies the limit after the filter, not before', async () => {
      const mine = row(ME, { lastEventAt: new Date(AT.getTime() - 60_000) });
      const newerOthers = Array.from({ length: 5 }, () =>
        row(OTHER, { lastEventAt: new Date(AT.getTime() + 1000) }),
      );
      await prisma.orderView.createMany({ data: [mine, ...newerOthers] });

      const found = await queries.search({ customerId: ME, limit: 2 });

      expect(found.map((order) => order.orderId)).toEqual([mine.orderId]);
    });
  });

  describe('rejectionSummary', () => {
    it('leaves the orders of other customers out of the groups and the counts', async () => {
      const mine = [row(ME), row(ME)];
      const sharedReasonTheirs = [row(OTHER), row(OTHER), row(OTHER)];
      const onlyTheirs = row(OTHER, {
        rejectionReason: 'insufficient stock for product SKU-001',
        items: [{ product_id: 'SKU-001', quantity: 1, unit_price: '1.00' }],
      });
      await prisma.orderView.createMany({
        data: [...mine, ...sharedReasonTheirs, onlyTheirs, row(null)],
      });

      const summary = await queries.rejectionSummary(
        { customerId: ME },
        LIMITS,
      );

      expect(summary.totalRejected).toBe(2);
      expect(summary.totalGroups).toBe(1);
      expect(summary.groups).toHaveLength(1);
      expect(summary.groups[0]).toMatchObject({
        count: 2,
        productIds: ['SKU-005'],
        productTotal: 1,
      });
      expect([...(summary.groups[0]?.orderIds ?? [])].sort()).toEqual(
        mine.map((order) => order.orderId).sort(),
      );
    });

    it('is empty for a customer with no rejections', async () => {
      await prisma.orderView.createMany({ data: [row(OTHER)] });

      const summary = await queries.rejectionSummary(
        { customerId: ME },
        LIMITS,
      );

      expect(summary).toEqual({
        totalRejected: 0,
        totalGroups: 0,
        groups: [],
      });
    });

    it('applies the group cap to the customer groups only', async () => {
      // The other customer has a bigger group that would take the only slot.
      const theirs = Array.from({ length: 5 }, () =>
        row(OTHER, { rejectionReason: 'a reason only they have' }),
      );
      await prisma.orderView.createMany({ data: [row(ME), ...theirs] });

      const summary = await queries.rejectionSummary(
        { customerId: ME },
        { groups: 1, productIdsPerGroup: 5 },
      );

      expect(summary.groups.map((group) => group.reason)).toEqual([
        'insufficient stock for product SKU-005',
      ]);
      expect(summary.totalGroups).toBe(1);
    });
  });

  describe('timeline', () => {
    async function create(orderId: string, customerId: string) {
      await project.execute(
        toProjectionCommand(orderCreated(orderId, { customer_id: customerId })),
      );
    }

    it('returns the order of the customer', async () => {
      const orderId = randomUUID();
      await create(orderId, ME);

      expect(await queries.timeline(orderId, ME)).toMatchObject({ orderId });
    });

    it('returns null for the order of another customer, like a missing one', async () => {
      const orderId = randomUUID();
      await create(orderId, OTHER);

      expect(await queries.timeline(orderId, ME)).toBeNull();
      expect(await queries.timeline(randomUUID(), ME)).toBeNull();
    });

    it('returns null while order.created has not arrived (no customer yet)', async () => {
      const orderId = randomUUID();
      await prisma.orderView.createMany({ data: [row(null, { orderId })] });

      expect(await queries.timeline(orderId, ME)).toBeNull();
    });
  });

  // Prisma drops a filter whose value is undefined, which would return every
  // customer's rows: the adapters must refuse to run without a customer.
  describe('fail closed without a customer (SEC94-02)', () => {
    const views = () => new PrismaOrderViewQueries(prisma);
    const missing = [
      ['undefined', undefined],
      ['empty', ''],
    ] as const;

    beforeEach(async () => {
      await prisma.orderView.createMany({ data: [row(ME), row(OTHER)] });
    });

    it.each(missing)('search throws when customerId is %s', async (_n, id) => {
      await expect(
        views().search({ customerId: id as unknown as string, limit: 10 }),
      ).rejects.toThrow(/customer/i);
      await expect(
        queries.search({ customerId: id as unknown as string, limit: 10 }),
      ).rejects.toThrow(/customer/i);
    });

    it.each(missing)(
      'rejection stats throw when customerId is %s',
      async (_n, id) => {
        await expect(
          views().rejectionStats(
            { customerId: id as unknown as string },
            LIMITS,
          ),
        ).rejects.toThrow(/customer/i);
      },
    );

    it.each(missing)(
      'the timeline throws when customerId is %s',
      async (_n, id) => {
        const orderId = randomUUID();
        await expect(
          queries.timeline(orderId, id as unknown as string),
        ).rejects.toThrow(/customer/i);
        await expect(
          new PrismaOrderHistoryRepository(prisma).findTimeline(
            orderId,
            id as unknown as string,
          ),
        ).rejects.toThrow(/customer/i);
      },
    );
  });

  it('indexes the orders by customer and last event', async () => {
    const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'order_view'`;

    expect(
      indexes.some((index) =>
        index.indexdef.includes('(customer_id, last_event_at)'),
      ),
    ).toBe(true);
  });
});
