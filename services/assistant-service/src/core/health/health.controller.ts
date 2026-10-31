import { Controller, Get, Inject } from '@nestjs/common';
import { RedisConnection } from '../cache/redis.connection.js';
import { SERVICE_NAME } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import { RabbitMQConnection } from '../messaging/rabbitmq.connection.js';

type Status = 'healthy' | 'unhealthy';

/** Always 200; the body says what is down (ADR-0014), like the Python services. */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PrismaService) private readonly database: PrismaService,
    @Inject(RabbitMQConnection) private readonly broker: RabbitMQConnection,
    @Inject(RedisConnection) private readonly redis: RedisConnection,
  ) {}

  @Get()
  async health(): Promise<{
    status: 'ok';
    service: string;
    database: Status;
    broker: Status;
    redis: Status;
  }> {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      database: (await this.database.isHealthy()) ? 'healthy' : 'unhealthy',
      broker: this.broker.isConnected() ? 'healthy' : 'unhealthy',
      redis: this.redis.isHealthy() ? 'healthy' : 'unhealthy',
    };
  }
}
