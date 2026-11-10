import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  RateLimiter,
  RateLimiterUnavailableError,
} from '../../../../core/rate-limit/rate-limiter.js';

/** Injection token for the timeline's own limiter (its own limit and window). */
export const TIMELINE_RATE_LIMITER = Symbol('TIMELINE_RATE_LIMITER');

/**
 * Limits the timeline reads per client IP. Unlike the ask limit it fails
 * open: the endpoint only reads Postgres, so a limiter that can't count must
 * not take the timeline down with it (ADR-0026).
 */
@Injectable()
export class TimelineRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(TimelineRateLimitGuard.name);

  constructor(
    @Inject(TIMELINE_RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    try {
      const decision = await this.limiter.hit(
        `timeline:${request.ip ?? 'unknown'}`,
      );
      if (decision.allowed) return true;
      http
        .getResponse<Response>()
        .setHeader('Retry-After', String(decision.retryAfterSeconds));
    } catch (error) {
      if (!(error instanceof RateLimiterUnavailableError)) throw error;
      this.logger.debug(`timeline rate limit skipped: ${error.message}`);
      return true;
    }
    throw new HttpException(
      { message: 'too many requests, try again later' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
