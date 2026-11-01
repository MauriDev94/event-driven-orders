import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { collectDefaultMetrics } from 'prom-client';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { ENV, type Env } from './core/config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  const env = app.get<Env>(ENV);
  configureApp(app, env);
  // SIGTERM runs the shutdown hooks: close the broker channel and the pg pool.
  app.enableShutdownHooks();
  collectDefaultMetrics();
  await app.listen(env.PORT, '0.0.0.0');
}

await bootstrap();
