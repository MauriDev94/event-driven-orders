import { DomainError } from '../../../../../src/common/domain-error.js';
import { toProjectionCommand } from '../../../../../src/features/order-history/application/mappers/order-event.mapper.js';
import { ProjectOrderEvent } from '../../../../../src/features/order-history/application/usecases/project-order-event.js';
import { InMemoryOrderHistoryRepository } from '../../../../support/in-memory-order-history.repository.js';
import { InMemoryTimelineCache } from '../../../../support/in-memory-timeline-cache.js';
import {
  orderConfirmed,
  orderCreated,
  orderRejected,
  stockReserved,
} from '../../../../support/order-events.js';

describe('ProjectOrderEvent', () => {
  let repository: InMemoryOrderHistoryRepository;
  let cache: InMemoryTimelineCache;
  let useCase: ProjectOrderEvent;

  beforeEach(() => {
    repository = new InMemoryOrderHistoryRepository();
    cache = new InMemoryTimelineCache();
    useCase = new ProjectOrderEvent(repository, cache);
  });

  it('logs the event and creates the view of a new order', async () => {
    const event = orderCreated('o-1');

    expect(await useCase.execute(toProjectionCommand(event))).toBe('projected');

    expect(repository.events.get(event.event_id)).toMatchObject({
      orderId: 'o-1',
      eventType: 'order.created',
      correlationId: 'corr-o-1',
      payload: event,
    });
    expect(repository.views.get('o-1')).toMatchObject({
      version: 0,
      view: { status: 'pending', customerId: 'c-1', totalAmount: '20.00' },
    });
  });

  it('updates the view of an order it already knows', async () => {
    await useCase.execute(toProjectionCommand(orderCreated('o-1')));
    await useCase.execute(toProjectionCommand(stockReserved('o-1')));
    await useCase.execute(toProjectionCommand(orderConfirmed('o-1')));

    expect(repository.views.get('o-1')).toMatchObject({
      version: 2,
      view: { status: 'confirmed', stockResult: 'reserved' },
    });
  });

  it('acks a duplicate without changing anything', async () => {
    const event = orderCreated('o-1');
    await useCase.execute(toProjectionCommand(event));

    expect(await useCase.execute(toProjectionCommand(event))).toBe('duplicate');
    expect(repository.events.size).toBe(1);
    expect(repository.views.get('o-1')?.version).toBe(0);
  });

  it('keeps neither the log entry nor the view when the transition is impossible', async () => {
    await useCase.execute(toProjectionCommand(orderConfirmed('o-1')));
    const impossible = orderRejected('o-1', 'too late');

    await expect(
      useCase.execute(toProjectionCommand(impossible)),
    ).rejects.toThrow(DomainError);
    expect(repository.events.has(impossible.event_id)).toBe(false);
    expect(repository.views.get('o-1')?.view.status).toBe('confirmed');
  });

  it('invalidates the cached timeline once the event committed', async () => {
    const event = orderCreated('o-1');
    let committed = false;
    cache.onInvalidate = () => {
      committed = repository.events.has(event.event_id);
    };

    await useCase.execute(toProjectionCommand(event));

    expect(cache.invalidated).toEqual(['o-1']);
    expect(committed).toBe(true);
  });

  it('leaves the cache alone for a duplicate or a failed projection', async () => {
    const event = orderConfirmed('o-1');
    await useCase.execute(toProjectionCommand(event));

    await useCase.execute(toProjectionCommand(event));
    await expect(
      useCase.execute(toProjectionCommand(orderRejected('o-1', 'too late'))),
    ).rejects.toThrow(DomainError);

    expect(cache.invalidated).toEqual(['o-1']);
  });
});

describe('toProjectionCommand', () => {
  it('maps the wire format to the domain, keeping the raw payload', () => {
    const event = orderCreated('o-1');

    expect(toProjectionCommand(event)).toEqual({
      correlationId: 'corr-o-1',
      payload: event,
      event: {
        type: 'order.created',
        eventId: event.event_id,
        orderId: 'o-1',
        occurredAt: new Date('2026-10-31T12:00:00.000Z'),
        customerId: 'c-1',
        items: [{ productId: 'SKU-001', quantity: 2, unitPrice: '10.00' }],
        totalAmount: '20.00',
      },
    });
  });
});
