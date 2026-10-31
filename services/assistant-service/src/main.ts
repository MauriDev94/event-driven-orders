import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { collectDefaultMetrics } from 'prom-client';
import { AppModule } from './app.module.js';
import { ENV, type Env } from './core/config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  // SIGTERM runs the shutdown hooks: close the broker channel and the pg pool.
  app.enableShutdownHooks();
  collectDefaultMetrics();
  await app.listen(app.get<Env>(ENV).PORT, '0.0.0.0');
}

await bootstrap();
