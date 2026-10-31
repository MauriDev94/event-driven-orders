import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createClient } from 'redis';
import { ENV, type Env } from '../config/env.js';

export type RedisClient = ReturnType<typeof createClient>;

/** A slow Redis must not hold a request: past this, the command fails. */
const COMMAND_TIMEOUT_MS = 1_000;

/**
 * The Redis client of the process, for the rate limit and the timeline cache.
 *
 * Like the broker, connecting never blocks startup nor throws: node-redis
 * keeps retrying with backoff (1 s up to 30 s) and /health reports
 * `redis: unhealthy` meanwhile. The offline queue is off, so while Redis is
 * away every command fails at once instead of waiting for it: the rate limit
 * then fails closed and the cache fails open, both without delay.
 */
@Injectable()
export class RedisConnection
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RedisConnection.name);
  readonly client: RedisClient;
  private started = false;
  private closing = false;

  constructor(@Inject(ENV) env: Pick<Env, 'REDIS_URL'>) {
    this.client = createClient({
      url: env.REDIS_URL,
      disableOfflineQueue: true,
      commandOptions: { timeout: COMMAND_TIMEOUT_MS },
      socket: {
        connectTimeout: 2_000,
        reconnectStrategy: (retries: number) =>
          Math.min(1_000 * 2 ** retries, 30_000),
      },
    });
    // Without an error listener, node-redis would crash the process.
    this.client.on('error', (error: Error) => {
      this.logger.warn(`Redis error: ${error.message}`);
    });
    this.client.on('ready', () => this.logger.log('connected to Redis'));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.client.connect().catch((error: Error) => {
      if (!this.closing) {
        this.logger.warn(`stopped connecting to Redis: ${error.message}`);
      }
    });
  }

  isHealthy(): boolean {
    return this.client.isReady;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.client.isOpen) this.client.destroy();
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  onModuleDestroy(): Promise<void> {
    return this.close();
  }
}
