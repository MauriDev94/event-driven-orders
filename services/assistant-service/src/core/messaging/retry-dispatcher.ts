/**
 * Wraps a message handler with the retry/DLQ protocol of the Python services
 * (`shared.messaging.retry_dispatcher`):
 *
 * - On success it acks the message.
 * - TRANSIENT failure with retries left: republishes body and headers, with
 *   `x-retry-count` incremented, to `<queue>.<retry-stage>` through the
 *   default exchange, then acks the original. The retry queue's TTL and
 *   dead-letter routing bring it back to the main queue.
 * - PERMANENT failure or retries exhausted: nacks without requeue, which
 *   dead-letters it to `<queue>.dlq`.
 */
import type { ConsumeMessage, Message, Options } from 'amqplib';
import { EVENTS_DLQ, EVENTS_RETRIED } from '../observability/metrics.js';
import {
  classifyError,
  decideRetry,
  RETRY_COUNT_HEADER,
} from './retry-policy.js';

/** The slice of an amqplib channel the dispatcher uses. */
export interface RetryChannel {
  ack(message: Message): void;
  nack(message: Message, allUpTo?: boolean, requeue?: boolean): void;
  sendToQueue(
    queue: string,
    content: Buffer,
    options?: Options.Publish,
  ): boolean;
}

export interface DispatchLogger {
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export type MessageHandler = (message: ConsumeMessage) => Promise<void>;

export interface RetryOptions {
  channel: RetryChannel;
  mainQueue: string;
  logger: DispatchLogger;
}

/**
 * Returns the callback for `channel.consume`. It never rejects: amqplib
 * calls it without awaiting, so a rejection would be an unhandled one.
 */
export function wrapWithRetry(
  handler: MessageHandler,
  { channel, mainQueue, logger }: RetryOptions,
): (message: ConsumeMessage | null) => Promise<void> {
  return async (message) => {
    // The broker cancelled the consumer (for example, the queue was deleted).
    if (message === null) return;
    const fields = {
      queue: mainQueue,
      correlation_id: correlationIdOf(message),
    };
    try {
      try {
        await handler(message);
      } catch (error) {
        handleFailure(message, error);
        return;
      }
      channel.ack(message);
    } catch (error) {
      logger.error({ ...fields, err: error }, 'could not settle message');
    }

    function handleFailure(failed: ConsumeMessage, error: unknown): void {
      const headers = { ...failed.properties.headers };
      const retryCount = parseRetryCount(headers[RETRY_COUNT_HEADER]);
      const decision = decideRetry(retryCount, classifyError(error));

      if (decision.action === 'dead-letter') {
        logger.warn(
          { ...fields, retry_count: retryCount, err: error },
          `dead-lettering message after ${retryCount} retries`,
        );
        EVENTS_DLQ.inc({ queue: mainQueue });
        channel.nack(failed, false, false);
        return;
      }

      headers[RETRY_COUNT_HEADER] = decision.nextRetryCount;
      const retryQueue = `${mainQueue}.${decision.retryQueueSuffix}`;
      logger.warn(
        {
          ...fields,
          retry_queue: retryQueue,
          attempt: decision.nextRetryCount,
          err: error,
        },
        'retrying message',
      );
      EVENTS_RETRIED.inc({ queue: mainQueue });
      channel.sendToQueue(retryQueue, failed.content, {
        headers,
        persistent: true,
        contentType: failed.properties.contentType,
        messageId: failed.properties.messageId,
        correlationId: failed.properties.correlationId,
        type: failed.properties.type,
      });
      channel.ack(failed);
    }
  };
}

/** The dispatcher writes a number; a message republished by hand carries a string. */
function parseRetryCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

/** Best effort: every contract carries `correlation_id` (see BaseEvent). */
function correlationIdOf(message: ConsumeMessage): string | undefined {
  try {
    const body: unknown = JSON.parse(message.content.toString('utf8'));
    if (typeof body === 'object' && body !== null && 'correlation_id' in body) {
      const { correlation_id: id } = body;
      return typeof id === 'string' ? id : undefined;
    }
  } catch {
    // A body that is not JSON is a permanent failure the handler reports.
  }
  return undefined;
}
