import { Module } from '@nestjs/common';
import { RedisConnection } from '../../core/cache/redis.connection.js';
import { OrderHistoryRepository } from './application/contracts/order-history.repository.js';
import { OrderViewQueries } from './application/contracts/order-view.queries.js';
import { TimelineCache } from './application/contracts/timeline-cache.js';
import { GetOrderTimeline } from './application/usecases/get-order-timeline.js';
import { ProjectOrderEvent } from './application/usecases/project-order-event.js';
import { PrismaOrderHistoryRepository } from './infrastructure/prisma-order-history.repository.js';
import { PrismaOrderViewQueries } from './infrastructure/prisma-order-view.queries.js';
import { RedisTimelineCache } from './infrastructure/redis-timeline-cache.js';
import { OrderEventsConsumer } from './presentation/consumers/order-events.consumer.js';
import { OrderTimelineController } from './presentation/http/order-timeline.controller.js';

/** DI wiring of the feature (the `di/` package of the Python services). */
@Module({
  controllers: [OrderTimelineController],
  providers: [
    { provide: OrderHistoryRepository, useClass: PrismaOrderHistoryRepository },
    {
      provide: TimelineCache,
      useFactory: (redis: RedisConnection) => new RedisTimelineCache(redis),
      inject: [RedisConnection],
    },
    {
      provide: ProjectOrderEvent,
      useFactory: (repository: OrderHistoryRepository, cache: TimelineCache) =>
        new ProjectOrderEvent(repository, cache),
      inject: [OrderHistoryRepository, TimelineCache],
    },
    {
      provide: GetOrderTimeline,
      useFactory: (repository: OrderHistoryRepository, cache: TimelineCache) =>
        new GetOrderTimeline(repository, cache),
      inject: [OrderHistoryRepository, TimelineCache],
    },
    { provide: OrderViewQueries, useClass: PrismaOrderViewQueries },
    OrderEventsConsumer,
  ],
  // The assistant reads the timeline through the same cache, and its lists
  // through OrderViewQueries.
  exports: [GetOrderTimeline, OrderViewQueries],
})
export class OrderHistoryModule {}
