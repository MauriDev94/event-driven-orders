import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import { stdTimeFunctions } from 'pino';
import { type Env, SERVICE_NAME } from '../config/env.js';

const CORRELATION_HEADER = 'x-correlation-id';
const QUIET_PATHS = new Set(['/health', '/metrics']);

/**
 * JSON logs with `correlation_id` (ADR-0012). A request reuses the
 * X-Correlation-ID it brings, or gets a new UUID, and the response echoes it,
 * like order-service's middleware. Consumers log the event's correlation_id.
 */
export function loggerParams(env: Pick<Env, 'LOG_LEVEL'>): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      base: { service: SERVICE_NAME },
      timestamp: stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const header = req.headers[CORRELATION_HEADER];
        const id = (Array.isArray(header) ? header[0] : header) || randomUUID();
        res.setHeader('X-Correlation-ID', id);
        return id;
      },
      customProps: (req: IncomingMessage) => ({
        correlation_id: (req as IncomingMessage & { id: string }).id,
      }),
      autoLogging: {
        ignore: (req: IncomingMessage) => QUIET_PATHS.has(req.url ?? ''),
      },
    },
  };
}
