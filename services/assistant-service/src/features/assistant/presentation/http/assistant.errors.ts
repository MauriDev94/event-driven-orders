import { ServiceUnavailableException } from '@nestjs/common';
import {
  LlmQuotaExceededError,
  LlmUnavailableError,
} from '../../application/contracts/llm-client.js';
import { ModelCallBudgetUnavailableError } from '../../application/contracts/model-call-budget.js';

export const UNAVAILABLE_MESSAGE =
  'the assistant is unavailable, try again later';

/** A dependency down is a 503 with a clear message; anything else stays a 500. */
export function toHttpError(error: unknown): unknown {
  if (error instanceof LlmQuotaExceededError) {
    return new ServiceUnavailableException({
      message: 'the assistant ran out of model quota, try again later',
    });
  }
  if (
    error instanceof LlmUnavailableError ||
    error instanceof ModelCallBudgetUnavailableError
  ) {
    return new ServiceUnavailableException({ message: UNAVAILABLE_MESSAGE });
  }
  return error;
}
