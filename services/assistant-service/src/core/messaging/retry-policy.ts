/**
 * Retry/DLQ decision logic, the same contract as the Python services'
 * `shared.messaging.retry_policy`. Pure logic, no I/O.
 *
 * Backoff schedule: 5s -> 30s -> 2m. After MAX_RETRIES transient failures, or
 * on the first permanent one, the message goes to the dead-letter queue.
 */
import { ZodError } from 'zod';
import { DomainError } from '../../common/domain-error.js';

export const RETRY_COUNT_HEADER = 'x-retry-count';

/** (queue name suffix, TTL in milliseconds) per backoff stage. */
export const RETRY_STAGES: ReadonlyArray<readonly [string, number]> = [
  ['retry-5s', 5_000],
  ['retry-30s', 30_000],
  ['retry-2m', 120_000],
];
export const MAX_RETRIES = RETRY_STAGES.length;

/** The message body is not JSON: it will never parse, so it is permanent. */
export class InvalidMessageError extends Error {
  override readonly name = 'InvalidMessageError';
}

export type ErrorClass = 'transient' | 'permanent';

export type RetryDecision =
  | { action: 'dead-letter' }
  | {
      action: 'retry';
      retryQueueSuffix: string;
      delayMs: number;
      nextRetryCount: number;
    };

/**
 * PERMANENT: the message itself is the problem (not JSON, fails the schema,
 * unknown event_type, impossible transition). TRANSIENT: everything else.
 */
export function classifyError(error: unknown): ErrorClass {
  const permanent =
    error instanceof ZodError ||
    error instanceof InvalidMessageError ||
    error instanceof DomainError;
  return permanent ? 'permanent' : 'transient';
}

export function decideRetry(
  retryCount: number,
  errorClass: ErrorClass,
): RetryDecision {
  const stage = RETRY_STAGES[retryCount];
  if (errorClass === 'permanent' || stage === undefined) {
    return { action: 'dead-letter' };
  }
  const [retryQueueSuffix, delayMs] = stage;
  return {
    action: 'retry',
    retryQueueSuffix,
    delayMs,
    nextRetryCount: retryCount + 1,
  };
}
