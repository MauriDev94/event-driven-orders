import { toProjectionCommand } from '../../../../../src/features/order-history/application/mappers/order-event.mapper.js';
import { GetOrderTimeline } from '../../../../../src/features/order-history/application/usecases/get-order-timeline.js';
import { ProjectOrderEvent } from '../../../../../src/features/order-history/application/usecases/project-order-event.js';
import { InMemoryOrderHistoryRepository } from '../../../../support/in-memory-order-history.repository.js';
import {
  entryKey,
  InMemoryTimelineCache,
} from '../../../../support/in-memory-timeline-cache.js';
import {
  orderCreated,
  stockReserved,
} from '../../../../support/order-events.js';

// The support events belong to customer c-1.
const OWNER = 'c-1';

describe('GetOrderTimeline', () => {
  let repository: InMemoryOrderHistoryRepository;
  let cache: InMemoryTimelineCache;
  let useCase: GetOrderTimeline;
  let project: ProjectOrderEvent;

  beforeEach(() => {
    repository = new InMemoryOrderHistoryRepository();
    cache = new InMemoryTimelineCache();
    useCase = new GetOrderTimeline(repository, cache);
    project = new ProjectOrderEvent(repository, cache);
  });

  it('reads the database once, then serves the cached timeline', async () => {
    await project.execute(toProjectionCommand(orderCreated('o-1')));
    const findTimeline = vi.spyOn(repository, 'findTimeline');

    const first = await useCase.execute('o-1', OWNER);
    const second = await useCase.execute('o-1', OWNER);

    expect(findTimeline).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first?.events).toHaveLength(1);
  });

  it('reads the database again after an event for the order', async () => {
    await project.execute(toProjectionCommand(orderCreated('o-1')));
    await useCase.execute('o-1', OWNER);

    await project.execute(toProjectionCommand(stockReserved('o-1')));

    expect((await useCase.execute('o-1', OWNER))?.events).toHaveLength(2);
  });

  it('returns null for an unknown order', async () => {
    expect(await useCase.execute('missing', OWNER)).toBeNull();
  });

  describe('owner check (ADR-0027)', () => {
    it('returns null for the order of another customer', async () => {
      await project.execute(toProjectionCommand(orderCreated('o-1')));

      expect(await useCase.execute('o-1', 'someone-else')).toBeNull();
    });

    it('costs a foreign order the same as a missing one: one filtered query, no cache entry', async () => {
      await project.execute(toProjectionCommand(orderCreated('o-1')));
      const findTimeline = vi.spyOn(repository, 'findTimeline');

      await useCase.execute('o-1', 'someone-else');
      await useCase.execute('missing', 'someone-else');

      expect(findTimeline.mock.calls).toEqual([
        ['o-1', 'someone-else'],
        ['missing', 'someone-else'],
      ]);
      expect(cache.entries.size).toBe(0);
    });

    it('treats a foreign order as a miss even after the owner warmed the entry', async () => {
      await project.execute(toProjectionCommand(orderCreated('o-1')));
      await useCase.execute('o-1', OWNER);
      const findTimeline = vi.spyOn(repository, 'findTimeline');

      expect(await useCase.execute('o-1', 'someone-else')).toBeNull();
      // The same path as a missing order: a miss, then the filtered query.
      expect(findTimeline).toHaveBeenCalledTimes(1);
      expect(findTimeline).toHaveBeenCalledWith('o-1', 'someone-else');
    });

    it('never serves the entry of the owner to another customer', async () => {
      await project.execute(toProjectionCommand(orderCreated('o-1')));
      await useCase.execute('o-1', OWNER);
      expect([...cache.entries.keys()]).toEqual([entryKey('o-1', OWNER)]);

      expect(await useCase.execute('o-1', 'someone-else')).toBeNull();
      expect(await useCase.execute('o-1', OWNER)).not.toBeNull();
      expect([...cache.entries.keys()]).toEqual([entryKey('o-1', OWNER)]);
    });

    it('returns null while order.created has not arrived, for anyone', async () => {
      await project.execute(toProjectionCommand(stockReserved('o-1')));

      expect(await useCase.execute('o-1', OWNER)).toBeNull();
      expect(cache.entries.size).toBe(0);
    });

    it('serves the order once order.created arrives', async () => {
      await project.execute(toProjectionCommand(stockReserved('o-1')));
      expect(await useCase.execute('o-1', OWNER)).toBeNull();

      await project.execute(toProjectionCommand(orderCreated('o-1')));

      expect(await useCase.execute('o-1', OWNER)).not.toBeNull();
    });

    it('invalidates the entry of the owner', async () => {
      await project.execute(toProjectionCommand(orderCreated('o-1')));
      await useCase.execute('o-1', OWNER);

      await project.execute(toProjectionCommand(stockReserved('o-1')));

      expect(cache.entries.size).toBe(0);
      expect((await useCase.execute('o-1', OWNER))?.events).toHaveLength(2);
    });
  });

  describe('fail closed (SEC94-02)', () => {
    it.each([
      ['empty', ''],
      ['undefined', undefined],
    ])('throws when the customer id is %s', async (_name, customerId) => {
      await project.execute(toProjectionCommand(orderCreated('o-1')));

      await expect(
        useCase.execute('o-1', customerId as unknown as string),
      ).rejects.toThrow(/customer/i);
    });
  });

  describe('order ids that cannot exist (SEC94-03)', () => {
    it.each([
      ['a NUL', 'a\u0000b'],
      ['12,000 characters', 'a'.repeat(12_000)],
      ['a generation suffix', 'abcdefgh:generation'],
      ['nothing', ''],
    ])('answers null for an id with %s, touching nothing', async (_n, id) => {
      const findTimeline = vi.spyOn(repository, 'findTimeline');

      expect(await useCase.execute(id, OWNER)).toBeNull();
      expect(findTimeline).not.toHaveBeenCalled();
      expect(cache.entries.size).toBe(0);
    });
  });
});
