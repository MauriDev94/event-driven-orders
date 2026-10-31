import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv } from './config/env.js';
import { PrismaService } from './database/prisma.service.js';
import { HealthController } from './health/health.controller.js';
import { RabbitMQConnection } from './messaging/rabbitmq.connection.js';
import { MetricsController } from './observability/metrics.controller.js';

/** Process-wide infrastructure: validated env, database, broker, health and metrics. */
@Global()
@Module({
  controllers: [HealthController, MetricsController],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    PrismaService,
    RabbitMQConnection,
  ],
  exports: [ENV, PrismaService, RabbitMQConnection],
})
export class CoreModule {}
