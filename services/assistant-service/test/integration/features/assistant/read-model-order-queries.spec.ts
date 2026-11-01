import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { PrismaService } from '../../../../src/core/database/prisma.service.js';
import { ReadModelOrderQueries } from '../../../../src/features/assistant/infrastructure/read-model-order-queries.js';
import { toProjectionCommand } from '../../../../src/features/order-history/application/mappers/order-event.mapper.js';
import { GetOrderTimeline } from '../../../../src/features/order-history/application/usecases/get-order-timeline.js';
import { ProjectOrderEvent } from '../../../../src/features/order-history/application/usecases/project-order-event.js';
import { PrismaOrderHistoryRepository } from '../../../../src/features/order-history/infrastructure/prisma-order-history.repository.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../support/database.js';
import { InMemoryTimelineCache } from '../../../support/in-memory-timeline-cache.js';
import {
  orderConfirmed,
  orderCreated,
  orderRejected,
  stockRejected,
  stockReserved,
} from '../../../support/order-events.js';

const SKU_005_REASON = 'insufficient stock for product SKU-005';
const SKU_004_REASON = 'insufficient stock for product SKU-004';

// The queries behind the assistant's tools, against real Postgres (ADR-0008):
// the jsonb containment and the date bounds are Postgres semantics.
describe('ReadModelOrderQueries', () => {
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
      prisma,
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

  async function confirmedOrder(createdAt: string, productId = 'SKU-001') {
    const orderId = randomUUID();
    const at = (seconds: number) =>
      new Date(Date.parse(createdAt) + seconds * 1000).toISOString();
    await project.execute(
      toProjectionCommand(
        orderCreated(orderId, {
          occurred_at: createdAt,
          items: [{ product_id: productId, quantity: 1, unit_price: '10.00' }],
          total_amount: '10.00',
        }),
      ),
    );
    await project.execute(toProjectionCommand(stockReserved(orderId, at(1))));
    await project.execute(toProjectionCommand(orderConfirmed(orderId, at(2))));
    return orderId;
  }

  async function rejectedOrder(
    createdAt: string,
    reason: string,
    productIds: string[],
  ) {
    const orderId = randomUUID();
    await project.execute(
      toProjectionCommand(
        orderCreated(orderId, {
          occurred_at: createdAt,
          items: productIds.map((product_id) => ({
            product_id,
            quantity: 999,
            unit_price: '10.00',
          })),
        }),
      ),
    );
    await project.execute(
      toProjectionCommand({
        ...stockRejected(orderId, reason),
        occurred_at: createdAt,
      }),
    );
    await project.execute(
      toProjectionCommand({
        ...orderRejected(orderId, reason),
        occurred_at: createdAt,
      }),
    );
    return orderId;
  }

  describe('timeline', () => {
    it('returns the order with its items and events, oldest first', async () => {
      const orderId = await rejectedOrder(
        '2026-10-31T12:00:00.000Z',
        SKU_005_REASON,
        ['SKU-005'],
      );

      const details = await queries.timeline(orderId);

      expect(details).toMatchObject({
        orderId,
        customerId: 'c-1',
        status: 'rejected',
        stockResult: 'rejected',
        rejectionReason: SKU_005_REASON,
        totalAmount: '20.00',
        createdAt: new Date('2026-10-31T12:00:00.000Z'),
        items: [{ productId: 'SKU-005', quantity: 999, unitPrice: '10.00' }],
      });
      expect(
        details?.events.map((event) => [event.eventType, event.reason]),
      ).toEqual([
        ['order.created', null],
        ['stock.rejected', SKU_005_REASON],
        ['order.rejected', SKU_005_REASON],
      ]);
    });

    it('returns null for an unknown order', async () => {
      expect(await queries.timeline(randomUUID())).toBeNull();
    });
  });

  describe('search', () => {
    it('filters by status, most recent activity first, up to the limit', async () => {
      const older = await confirmedOrder('2026-10-30T10:00:00.000Z');
      const newer = await confirmedOrder('2026-10-31T10:00:00.000Z');
      await rejectedOrder('2026-10-31T11:00:00.000Z', SKU_005_REASON, [
        'SKU-005',
      ]);

      const all = await queries.search({ status: 'confirmed', limit: 10 });
      const one = await queries.search({ status: 'confirmed', limit: 1 });

      expect(all.map((order) => order.orderId)).toEqual([newer, older]);
      expect(one.map((order) => order.orderId)).toEqual([newer]);
      expect(all[0]).toMatchObject({
        status: 'confirmed',
        stockResult: 'reserved',
        rejectionReason: null,
        totalAmount: '10.00',
        createdAt: new Date('2026-10-31T10:00:00.000Z'),
        lastEventAt: new Date('2026-10-31T10:00:02.000Z'),
      });
    });

    it('filters by creation date, from inclusive and until exclusive', async () => {
      await confirmedOrder('2026-10-30T23:59:59.000Z');
      const first = await confirmedOrder('2026-10-31T00:00:00.000Z');
      const last = await confirmedOrder('2026-10-31T23:59:59.000Z');
      await confirmedOrder('2026-11-01T00:00:00.000Z');

      const found = await queries.search({
        from: new Date('2026-10-31T00:00:00.000Z'),
        until: new Date('2026-11-01T00:00:00.000Z'),
        limit: 10,
      });

      expect(found.map((order) => order.orderId)).toEqual([last, first]);
    });

    it('filters by a product in the items', async () => {
      await confirmedOrder('2026-10-31T10:00:00.000Z', 'SKU-001');
      const withProduct = await confirmedOrder(
        '2026-10-31T11:00:00.000Z',
        'SKU-003',
      );

      const found = await queries.search({ productId: 'SKU-003', limit: 10 });

      expect(found.map((order) => order.orderId)).toEqual([withProduct]);
    });
  });

  describe('rejectionSummary', () => {
    it('groups the rejected orders by reason, largest group first', async () => {
      const a = await rejectedOrder(
        '2026-10-31T10:00:00.000Z',
        SKU_005_REASON,
        ['SKU-005'],
      );
      const b = await rejectedOrder(
        '2026-10-31T11:00:00.000Z',
        SKU_005_REASON,
        ['SKU-001', 'SKU-005'],
      );
      const c = await rejectedOrder(
        '2026-10-31T12:00:00.000Z',
        SKU_004_REASON,
        ['SKU-004'],
      );
      await confirmedOrder('2026-10-31T13:00:00.000Z');

      const summary = await queries.rejectionSummary({});

      expect(summary).toEqual({
        totalRejected: 3,
        groups: [
          {
            reason: SKU_005_REASON,
            count: 2,
            productIds: ['SKU-001', 'SKU-005'],
            orderIds: [b, a],
          },
          {
            reason: SKU_004_REASON,
            count: 1,
            productIds: ['SKU-004'],
            orderIds: [c],
          },
        ],
      });
    });

    it('only counts the orders created in the range', async () => {
      await rejectedOrder('2026-10-30T10:00:00.000Z', SKU_005_REASON, [
        'SKU-005',
      ]);
      const today = await rejectedOrder(
        '2026-10-31T10:00:00.000Z',
        SKU_005_REASON,
        ['SKU-005'],
      );

      const summary = await queries.rejectionSummary({
        from: new Date('2026-10-31T00:00:00.000Z'),
      });

      expect(summary.totalRejected).toBe(1);
      expect(summary.groups[0]?.orderIds).toEqual([today]);
    });
  });
});
