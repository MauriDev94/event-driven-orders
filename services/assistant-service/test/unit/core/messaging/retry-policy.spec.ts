import { z } from 'zod';
import { DomainError } from '../../../../src/common/domain-error.js';
import {
  classifyError,
  decideRetry,
  InvalidMessageError,
  MAX_RETRIES,
  RETRY_STAGES,
} from '../../../../src/core/messaging/retry-policy.js';

describe('RETRY_STAGES', () => {
  it('matches shared.messaging.retry_policy', () => {
    expect(RETRY_STAGES).toEqual([
      ['retry-5s', 5_000],
      ['retry-30s', 30_000],
      ['retry-2m', 120_000],
    ]);
    expect(MAX_RETRIES).toBe(3);
  });
});

describe('decideRetry', () => {
  it.each([
    [0, 'retry-5s', 5_000, 1],
    [1, 'retry-30s', 30_000, 2],
    [2, 'retry-2m', 120_000, 3],
  ])(
    'retries a transient failure with %i previous retries on %s',
    (count, suffix, delay, next) => {
      expect(decideRetry(count, 'transient')).toEqual({
        action: 'retry',
        retryQueueSuffix: suffix,
        delayMs: delay,
        nextRetryCount: next,
      });
    },
  );

  it('dead-letters a transient failure once the retries run out', () => {
    expect(decideRetry(MAX_RETRIES, 'transient')).toEqual({
      action: 'dead-letter',
    });
  });

  it('dead-letters a permanent failure on the first attempt', () => {
    expect(decideRetry(0, 'permanent')).toEqual({ action: 'dead-letter' });
  });
});

describe('classifyError', () => {
  const zodError = z.string().safeParse(1).error;

  it.each([
    ['a schema validation error', zodError],
    ['an invalid message', new InvalidMessageError('not JSON')],
    ['a domain rule violation', new DomainError('impossible transition')],
  ])('treats %s as permanent', (_name, error) => {
    expect(classifyError(error)).toBe('permanent');
  });

  it.each([
    ['a generic error', new Error('connection reset')],
    ['a type error', new TypeError('boom')],
    ['a thrown string', 'boom'],
  ])('treats %s as transient', (_name, error) => {
    expect(classifyError(error)).toBe('transient');
  });
});
