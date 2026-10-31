import { performance } from 'node:perf_hooks';
import type { ConsumeMessage } from 'amqplib';
import { SERVICE_NAME } from '../../../../core/config/env.js';
import { orderEventSchema } from '../../../../core/messaging/contracts.js';
import type { MessageHandler } from '../../../../core/messaging/retry-dispatcher.js';
import { InvalidMessageError } from '../../../../core/messaging/retry-policy.js';
import {
  EVENT_PROCESSING_SECONDS,
  EVENTS_PROCESSED,
} from '../../../../core/observability/metrics.js';
import { toProjectionCommand } from '../../application/mappers/order-event.mapper.js';
import type { ProjectOrderEvent } from '../../application/usecases/project-order-event.js';

export interface HandlerLogger {
  info(fields: object, message: string): void;
}

/**
 * Thin adapter: validate the contract, map it, run the use case. It throws
 * on failure and the retry dispatcher decides between retry and DLQ.
 */
export function buildOrderEventHandler(
  useCase: ProjectOrderEvent,
  logger: HandlerLogger,
): MessageHandler {
  return async (message: ConsumeMessage) => {
    const started = performance.now();
    let body: unknown;
    try {
      body = JSON.parse(message.content.toString('utf8'));
    } catch {
      throw new InvalidMessageError('message body is not valid JSON');
    }
    // A ZodError (bad shape or unknown event_type) is permanent.
    const contract = orderEventSchema.parse(body);
    const result = await useCase.execute(toProjectionCommand(contract));

    logger.info(
      {
        event_id: contract.event_id,
        event_type: contract.event_type,
        order_id: contract.order_id,
        correlation_id: contract.correlation_id,
        result,
      },
      'order event projected',
    );
    EVENTS_PROCESSED.inc({
      service: SERVICE_NAME,
      event_type: contract.event_type,
    });
    EVENT_PROCESSING_SECONDS.observe(
      { service: SERVICE_NAME },
      (performance.now() - started) / 1000,
    );
  };
}
