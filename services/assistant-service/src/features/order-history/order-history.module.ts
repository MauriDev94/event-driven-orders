import { Module } from '@nestjs/common';
import { OrderHistoryRepository } from './application/contracts/order-history.repository.js';
import { GetOrderTimeline } from './application/usecases/get-order-timeline.js';
import { ProjectOrderEvent } from './application/usecases/project-order-event.js';
import { PrismaOrderHistoryRepository } from './infrastructure/prisma-order-history.repository.js';
import { OrderEventsConsumer } from './presentation/consumers/order-events.consumer.js';
import { OrderTimelineController } from './presentation/http/order-timeline.controller.js';

/** DI wiring of the feature (the `di/` package of the Python services). */
@Module({
  controllers: [OrderTimelineController],
  providers: [
    { provide: OrderHistoryRepository, useClass: PrismaOrderHistoryRepository },
    {
      provide: ProjectOrderEvent,
      useFactory: (repository: OrderHistoryRepository) =>
        new ProjectOrderEvent(repository),
      inject: [OrderHistoryRepository],
    },
    {
      provide: GetOrderTimeline,
      useFactory: (repository: OrderHistoryRepository) =>
        new GetOrderTimeline(repository),
      inject: [OrderHistoryRepository],
    },
    OrderEventsConsumer,
  ],
})
export class OrderHistoryModule {}
