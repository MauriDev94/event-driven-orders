import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ASSISTANT_QUESTIONS } from '../../../../core/observability/metrics.js';
import {
  type RateLimitDecision,
  RateLimiter,
  RateLimiterUnavailableError,
} from '../../application/contracts/rate-limiter.js';
import { UNAVAILABLE_MESSAGE } from './assistant.errors.js';

/**
 * Limits the questions per client IP before they reach the model. If the
 * limiter can't count, the question is refused (fails closed): the limit is
 * what protects the model's free quota.
 */
@Injectable()
export class AskRateLimitGuard implements CanActivate {
  constructor(@Inject(RateLimiter) private readonly limiter: RateLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    let decision: RateLimitDecision;
    try {
      decision = await this.limiter.hit(`ask:${request.ip ?? 'unknown'}`);
    } catch (error) {
      if (!(error instanceof RateLimiterUnavailableError)) throw error;
      ASSISTANT_QUESTIONS.inc({ outcome: 'error' });
      throw new ServiceUnavailableException({ message: UNAVAILABLE_MESSAGE });
    }
    if (!decision.allowed) {
      http
        .getResponse<Response>()
        .setHeader('Retry-After', String(decision.retryAfterSeconds));
      ASSISTANT_QUESTIONS.inc({ outcome: 'rate_limited' });
      throw new HttpException(
        { message: 'too many questions, try again later' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
