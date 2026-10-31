import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Channel } from 'amqplib';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { RabbitMQConnection } from '../../../../core/messaging/rabbitmq.connection.js';
import {
  type DispatchLogger,
  type MessageHandler,
  wrapWithRetry,
} from '../../../../core/messaging/retry-dispatcher.js';
import {
  declareTopology,
  ORDER_EVENTS_QUEUE,
  PREFETCH,
} from '../../../../core/messaging/topology.js';
import { ProjectOrderEvent } from '../../application/usecases/project-order-event.js';
import { buildOrderEventHandler } from './order-events.handler.js';

/** Runs on every (re)connection: topology, prefetch and the consumer. */
export async function consumeOrderEvents(
  channel: Channel,
  handler: MessageHandler,
  logger: DispatchLogger,
): Promise<void> {
  await declareTopology(channel);
  await channel.prefetch(PREFETCH);
  await channel.consume(
    ORDER_EVENTS_QUEUE,
    wrapWithRetry(handler, { channel, mainQueue: ORDER_EVENTS_QUEUE, logger }),
  );
}

@Injectable()
export class OrderEventsConsumer implements OnModuleInit {
  constructor(
    @Inject(RabbitMQConnection) private readonly broker: RabbitMQConnection,
    @Inject(ProjectOrderEvent) private readonly useCase: ProjectOrderEvent,
    @InjectPinoLogger(OrderEventsConsumer.name)
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const handler = buildOrderEventHandler(this.useCase, this.logger);
    this.broker.addSetup((channel) =>
      consumeOrderEvents(channel, handler, this.logger),
    );
  }
}
