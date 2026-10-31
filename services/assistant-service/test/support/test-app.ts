import { randomInt } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { inject, vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { RedisConnection } from '../../src/core/cache/redis.connection.js';
import { ENV, loadEnv } from '../../src/core/config/env.js';
import { RabbitMQConnection } from '../../src/core/messaging/rabbitmq.connection.js';
import { LlmClient } from '../../src/features/assistant/application/contracts/llm-client.js';
import { FakeBroker } from './fake-broker.js';

export interface TestAppOptions {
  databaseUrl: string;
  /** Overrides on top of a valid environment (real Redis, fake LLM). */
  env?: Record<string, string>;
  broker?: FakeBroker;
  llm?: LlmClient;
}

/** The real AppModule, wired like main.ts, with the broker replaced. */
export async function createTestApp(
  options: TestAppOptions,
): Promise<NestExpressApplication> {
  const env = loadEnv({
    DATABASE_URL: options.databaseUrl,
    RABBITMQ_URL: 'amqp://broker@localhost:5672/',
    REDIS_URL: inject('redisUrl'),
    LOG_LEVEL: 'silent',
    ...options.env,
  });
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(RabbitMQConnection)
    .useValue(options.broker ?? new FakeBroker(false));
  if (options.llm) {
    builder = builder.overrideProvider(LlmClient).useValue(options.llm);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app, env);
  await app.init();
  if (options.env?.['REDIS_URL'] === undefined) {
    // Redis connects in the background; the tests need it from the start.
    const redis = app.get(RedisConnection);
    await vi.waitFor(
      () => {
        if (!redis.isHealthy()) throw new Error('Redis is not ready yet');
      },
      { timeout: 10_000 },
    );
  }
  return app;
}

/** A client IP of its own, so each test gets a fresh rate-limit window. */
export function randomIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
}
