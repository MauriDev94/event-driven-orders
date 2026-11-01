import { toProjectionCommand } from '../../../../../src/features/order-history/application/mappers/order-event.mapper.js';
import { GetOrderTimeline } from '../../../../../src/features/order-history/application/usecases/get-order-timeline.js';
import { ProjectOrderEvent } from '../../../../../src/features/order-history/application/usecases/project-order-event.js';
import { InMemoryOrderHistoryRepository } from '../../../../support/in-memory-order-history.repository.js';
import { InMemoryTimelineCache } from '../../../../support/in-memory-timeline-cache.js';
import {
  orderCreated,
  stockReserved,
} from '../../../../support/order-events.js';

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

    const first = await useCase.execute('o-1');
    const second = await useCase.execute('o-1');

    expect(findTimeline).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first?.events).toHaveLength(1);
  });

  it('reads the database again after an event for the order', async () => {
    await project.execute(toProjectionCommand(orderCreated('o-1')));
    await useCase.execute('o-1');

    await project.execute(toProjectionCommand(stockReserved('o-1')));

    expect((await useCase.execute('o-1'))?.events).toHaveLength(2);
  });

  it('returns null for an unknown order', async () => {
    expect(await useCase.execute('missing')).toBeNull();
  });
});
