import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ENV, type Env } from '../config/env.js';
import {
  INVALID_TOKEN_MESSAGE,
  sessionKey,
  verifySessionToken,
} from './session-token.js';

/** A request the guard let through: it carries the customer of the token. */
type AuthenticatedRequest = Request & { customerId?: string };

/** `Authorization: Bearer <token>`; the scheme is case-insensitive, as in FastAPI. */
const BEARER = /^bearer (.+)$/i;

/**
 * Verifies the session token of ADR-0027 and exposes its customer id to the
 * controller (`@CurrentCustomer()`). Every failure is the same 401 with
 * `WWW-Authenticate: Bearer`: nothing says which check failed. It runs before
 * the rate-limit guards, so a 401 doesn't spend the per-IP limit.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  private readonly key: Uint8Array;

  constructor(@Inject(ENV) env: Pick<Env, 'AUTH_TOKEN_SECRET'>) {
    this.key = sessionKey(env.AUTH_TOKEN_SECRET);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    try {
      if (token === undefined) throw new Error('no bearer token');
      request.customerId = await verifySessionToken(token, this.key);
      return true;
    } catch {
      http.getResponse<Response>().setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException({ message: INVALID_TOKEN_MESSAGE });
    }
  }
}

/** The customer id the guard took from the token. Use only behind the guard. */
export const CurrentCustomer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const { customerId } = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();
    if (customerId === undefined) {
      throw new Error(
        'CurrentCustomer used on a route without SessionAuthGuard',
      );
    }
    return customerId;
  },
);
