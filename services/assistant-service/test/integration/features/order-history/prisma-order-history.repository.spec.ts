import { inject } from 'vitest';
import { PrismaService } from '../../../../src/core/database/prisma.service.js';
import { ConcurrentUpdateError } from '../../../../src/features/order-history/application/contracts/order-history.repository.js';
import { toProjectionCommand } from '../../../../src/features/order-history/application/mappers/order-event.mapper.js';
import { ProjectOrderEvent } from '../../../../src/features/order-history/application/usecases/project-order-event.js';
import { OrderView } from '../../../../src/features/order-history/domain/order-view.js';
import { PrismaOrderHistoryRepository } from '../../../../src/features/order-history/infrastructure/prisma-order-history.repository.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../support/database.js';
import {
  orderConfirmed,
  orderCreated,
  stockRejected,
  stockReserved,
} from '../../../support/order-events.js';

// Against real Postgres (ADR-0008): ON CONFLICT, the optimistic lock and the
// transaction boundaries are Postgres semantics.
describe('PrismaOrderHistoryRepository', () => {
  let database: TestDatabase;
  let prisma: PrismaService;
  let repository: PrismaOrderHistoryRepository;

  beforeAll(async () => {
    database = await createTestDatabase(inject('adminDatabaseUrl'));
    prisma = new PrismaService({ DATABASE_URL: database.url });
    repository = new PrismaOrderHistoryRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await database.drop();
  });

  beforeEach(async () => {
    await prisma.orderEventLog.deleteMany();
    await prisma.orderView.deleteMany();
  });

  function project(event: Parameters<typeof toProjectionCommand>[0]) {
    return new ProjectOrderEvent(repository).execute(
      toProjectionCommand(event),
    );
  }

  it('records an event once; the redelivery inserts nothing', async () => {
    const event = orderCreated('o-1');

    expect(await project(event)).toBe('projected');
    expect(await project(event)).toBe('duplicate');

    expect(await prisma.orderEventLog.count()).toBe(1);
    expect(
      await prisma.orderView.findUnique({ where: { orderId: 'o-1' } }),
    ).toMatchObject({ version: 0 });
  });

  it('rolls back the log entry when the view cannot be saved', async () => {
    await project(orderCreated('o-1'));
    const reserved = stockReserved('o-1');

    await expect(
      repository.inTransaction(async (tx) => {
        await tx.recordEvent(entryOf(reserved));
        throw new Error('crash before saving the view');
      }),
    ).rejects.toThrow('crash before saving the view');

    expect(
      await prisma.orderEventLog.findUnique({
        where: { eventId: reserved.event_id },
      }),
    ).toBeNull();
  });

  it('refuses to insert a view that another transaction already created', async () => {
    await project(orderCreated('o-1'));

    await expect(
      repository.inTransaction((tx) =>
        tx.saveView(OrderView.start('o-1'), null),
      ),
    ).rejects.toThrow(ConcurrentUpdateError);
  });

  it('refuses to overwrite a view that changed since it was read', async () => {
    await project(orderCreated('o-1'));
    await project(stockReserved('o-1'));

    await expect(
      repository.inTransaction((tx) => tx.saveView(OrderView.start('o-1'), 0)),
    ).rejects.toThrow(ConcurrentUpdateError);
  });

  it('returns no timeline for an unknown order', async () => {
    expect(await repository.findTimeline('missing')).toBeNull();
  });

  it('returns the view and its events in the order they happened', async () => {
    const confirmed = orderConfirmed('o-1', '2026-10-31T12:00:02.000000Z');
    const reserved = stockReserved('o-1', '2026-10-31T12:00:01.000000Z');
    const created = orderCreated('o-1');
    await project(confirmed);
    await project(reserved);
    await project(created);

    const timeline = await repository.findTimeline('o-1');

    expect(timeline?.view.toState()).toEqual({
      orderId: 'o-1',
      customerId: 'c-1',
      status: 'confirmed',
      stockResult: 'reserved',
      rejectionReason: null,
      totalAmount: '20.00',
      items: [{ productId: 'SKU-001', quantity: 2, unitPrice: '10.00' }],
      createdAt: new Date('2026-10-31T12:00:00.000Z'),
      lastEventAt: new Date('2026-10-31T12:00:02.000Z'),
    });
    expect(timeline?.events.map((e) => e.eventId)).toEqual([
      created.event_id,
      reserved.event_id,
      confirmed.event_id,
    ]);
    expect(timeline?.events[2]?.payload).toEqual(confirmed);
  });

  it('keeps the rejection reason', async () => {
    await project(orderCreated('o-2'));
    await project(
      stockRejected('o-2', 'insufficient stock for product SKU-005'),
    );

    const timeline = await repository.findTimeline('o-2');

    expect(timeline?.view).toMatchObject({
      stockResult: 'rejected',
      rejectionReason: 'insufficient stock for product SKU-005',
    });
  });
});

function entryOf(event: ReturnType<typeof stockReserved>) {
  const {
    event: domainEvent,
    correlationId,
    payload,
  } = toProjectionCommand(event);
  return {
    eventId: domainEvent.eventId,
    orderId: domainEvent.orderId,
    eventType: domainEvent.type,
    occurredAt: domainEvent.occurredAt,
    correlationId,
    payload,
  };
}
