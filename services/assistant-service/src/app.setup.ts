import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Env } from './core/config/env.js';

/** HTTP settings shared by main.ts and the e2e tests. */
export function configureApp(
  app: NestExpressApplication,
  env: Pick<Env, 'TRUST_PROXY'>,
): void {
  // The rate limit keys on req.ip. Express takes it from X-Forwarded-For only
  // when the connection comes from a trusted proxy (Caddy in production);
  // otherwise anyone could pick their own IP with that header.
  app.set('trust proxy', env.TRUST_PROXY);
}
