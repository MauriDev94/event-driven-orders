import { Global, Module } from '@nestjs/common';
import { RedisConnection } from './cache/redis.connection.js';
import { ENV, loadEnv } from './config/env.js';
import { PrismaService } from './database/prisma.service.js';
import { HealthController } from './health/health.controller.js';
import { RabbitMQConnection } from './messaging/rabbitmq.connection.js';
import { MetricsController } from './observability/metrics.controller.js';

/** Process-wide infrastructure: validated env, database, broker, Redis, health and metrics. */
@Global()
@Module({
  controllers: [HealthController, MetricsController],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    PrismaService,
    RabbitMQConnection,
    RedisConnection,
  ],
  exports: [ENV, PrismaService, RabbitMQConnection, RedisConnection],
})
export class CoreModule {}
