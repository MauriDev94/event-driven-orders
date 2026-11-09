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
import {
  orderConfirmed,
  orderCreated,
  orderRejected,
  stockRejected,
  stockReserved,
} from '../../../support/order-events.js';

const SKU_005_REASON = 'insufficient stock for product SKU-005';
const SKU_004_REASON = 'insufficient stock for product SKU-004';
const LIMITS = { groups: 10, productIdsPerGroup: 20 };

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

      const summary = await queries.rejectionSummary({}, LIMITS);

      expect(summary).toEqual({
        totalRejected: 3,
        totalGroups: 2,
        groups: [
          {
            reason: SKU_005_REASON,
            count: 2,
            productIds: ['SKU-001', 'SKU-005'],
            productTotal: 2,
            orderIds: [b, a],
          },
          {
            reason: SKU_004_REASON,
            count: 1,
            productIds: ['SKU-004'],
            productTotal: 1,
            orderIds: [c],
          },
        ],
      });
    });

    it('counts exactly past the rows read for the ids and products', async () => {
      const recent = new Date('2026-10-31T10:00:00.000Z');
      const old = new Date('2026-10-30T10:00:00.000Z');
      const rejected = (
        reason: string,
        count: number,
        lastEventAt: Date,
        productId: string,
      ) =>
        Array.from({ length: count }, () => ({
          orderId: randomUUID(),
          status: 'rejected' as const,
          stockResult: 'rejected' as const,
          rejectionReason: reason,
          items: [{ product_id: productId, quantity: 1, unit_price: '1.00' }],
          createdAt: lastEventAt,
          lastEventAt,
        }));
      // The 100 oldest orders of the first group fall outside the 1000 rows
      // read for its products, so SKU-OLD must not show up.
      const first = [
        ...rejected(SKU_005_REASON, 1_000, recent, 'SKU-005'),
        ...rejected(SKU_005_REASON, 100, old, 'SKU-OLD'),
      ];
      const second = rejected(SKU_004_REASON, 300, recent, 'SKU-004');
      await prisma.orderView.createMany({ data: [...first, ...second] });

      const summary = await queries.rejectionSummary({}, LIMITS);

      expect(summary.totalRejected).toBe(1_400);
      expect(
        summary.groups.map((group) => [group.reason, group.count]),
      ).toEqual([
        [SKU_005_REASON, 1_100],
        [SKU_004_REASON, 300],
      ]);
      const [firstGroup, secondGroup] = summary.groups;
      expect(firstGroup?.orderIds).toHaveLength(20);
      expect(secondGroup?.orderIds).toHaveLength(20);
      const firstIds = new Set<string>(first.map((row) => row.orderId));
      const secondIds = new Set<string>(second.map((row) => row.orderId));
      expect(firstGroup?.orderIds.every((id) => firstIds.has(id))).toBe(true);
      expect(secondGroup?.orderIds.every((id) => secondIds.has(id))).toBe(true);
      expect(firstGroup?.productIds).toEqual(['SKU-005']);
      expect(secondGroup?.productIds).toEqual(['SKU-004']);
    });

    it('merges a missing reason and a literal unknown into one group', async () => {
      const at = new Date('2026-10-31T10:00:00.000Z');
      const row = (rejectionReason: string | null) => ({
        orderId: randomUUID(),
        status: 'rejected' as const,
        rejectionReason,
        createdAt: at,
        lastEventAt: at,
      });
      const rows = [row(null), row(null), row('unknown')];
      await prisma.orderView.createMany({ data: rows });

      const summary = await queries.rejectionSummary({}, LIMITS);

      expect(summary.totalRejected).toBe(3);
      expect(summary.groups).toHaveLength(1);
      expect(summary.groups[0]).toMatchObject({ reason: 'unknown', count: 3 });
      expect([...(summary.groups[0]?.orderIds ?? [])].sort()).toEqual(
        rows.map((r) => r.orderId).sort(),
      );
    });

    it('counts an order without created_at by its last event when a range is given', async () => {
      const row = (lastEventAt: string) => ({
        orderId: randomUUID(),
        status: 'rejected' as const,
        rejectionReason: SKU_005_REASON,
        createdAt: null,
        lastEventAt: new Date(lastEventAt),
      });
      const inside = row('2026-10-31T10:00:00.000Z');
      const outside = row('2026-10-30T10:00:00.000Z');
      await prisma.orderView.createMany({ data: [inside, outside] });

      const summary = await queries.rejectionSummary(
        {
          from: new Date('2026-10-31T00:00:00.000Z'),
          until: new Date('2026-11-01T00:00:00.000Z'),
        },
        LIMITS,
      );

      expect(summary.totalRejected).toBe(1);
      expect(summary.groups[0]?.orderIds).toEqual([inside.orderId]);
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

      const summary = await queries.rejectionSummary(
        {
          from: new Date('2026-10-31T00:00:00.000Z'),
        },
        LIMITS,
      );

      expect(summary.totalRejected).toBe(1);
      expect(summary.groups[0]?.orderIds).toEqual([today]);
    });

    describe('caps', () => {
      /** `count` rejected orders, each with its own invented SKU in the reason. */
      function distinctReasons(count: number, at: Date) {
        return Array.from({ length: count }, (_, i) => ({
          orderId: randomUUID(),
          status: 'rejected' as const,
          rejectionReason: `insufficient stock for product SKU-${i}`,
          items: [{ product_id: `SKU-${i}`, quantity: 1, unit_price: '1.00' }],
          createdAt: at,
          lastEventAt: at,
        }));
      }

      it('returns the largest groups up to the cap, with exact totals', async () => {
        const at = new Date('2026-10-31T10:00:00.000Z');
        // 30 groups of one order, plus two bigger ones that must survive the cut.
        const big = (reason: string, n: number) =>
          Array.from({ length: n }, () => ({
            orderId: randomUUID(),
            status: 'rejected' as const,
            rejectionReason: reason,
            createdAt: at,
            lastEventAt: at,
          }));
        await prisma.orderView.createMany({
          data: [
            ...distinctReasons(30, at),
            ...big('big reason', 7),
            ...big('bigger reason', 9),
          ],
        });

        const summary = await queries.rejectionSummary(
          {},
          {
            groups: 5,
            productIdsPerGroup: 20,
          },
        );

        expect(summary.totalRejected).toBe(46);
        expect(summary.totalGroups).toBe(32);
        expect(summary.groups).toHaveLength(5);
        expect(
          summary.groups.slice(0, 2).map((g) => [g.reason, g.count]),
        ).toEqual([
          ['bigger reason', 9],
          ['big reason', 7],
        ]);
        // Ties on the count break by reason, so the cut is deterministic.
        expect(summary.groups.slice(2).map((g) => g.reason)).toEqual([
          'insufficient stock for product SKU-0',
          'insufficient stock for product SKU-1',
          'insufficient stock for product SKU-10',
        ]);
      });

      it('reports every group as total when none is cut', async () => {
        const at = new Date('2026-10-31T10:00:00.000Z');
        await prisma.orderView.createMany({ data: distinctReasons(3, at) });

        const summary = await queries.rejectionSummary({}, LIMITS);

        expect(summary.totalGroups).toBe(3);
        expect(summary.groups).toHaveLength(3);
      });

      it('returns the product ids up to the cap and counts them all', async () => {
        const at = new Date('2026-10-31T10:00:00.000Z');
        const items = Array.from({ length: 40 }, (_, i) => ({
          product_id: `SKU-${String(i).padStart(2, '0')}`,
          quantity: 1,
          unit_price: '1.00',
        }));
        await prisma.orderView.createMany({
          data: [
            {
              orderId: randomUUID(),
              status: 'rejected' as const,
              rejectionReason: SKU_005_REASON,
              items,
              createdAt: at,
              lastEventAt: at,
            },
          ],
        });

        const summary = await queries.rejectionSummary(
          {},
          {
            groups: 10,
            productIdsPerGroup: 5,
          },
        );

        expect(summary.groups[0]?.productIds).toEqual([
          'SKU-00',
          'SKU-01',
          'SKU-02',
          'SKU-03',
          'SKU-04',
        ]);
        expect(summary.groups[0]?.productTotal).toBe(40);
      });
    });
  });
});
