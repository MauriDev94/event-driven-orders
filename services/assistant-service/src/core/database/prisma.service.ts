import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { ENV, type Env } from '../config/env.js';

/**
 * The single Prisma client of the process (its pg pool is shared by the
 * consumer, the routers and /health). It connects on the first query, so the
 * service starts even when the database is down.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Pick<Env, 'DATABASE_URL'>) {
    super({
      adapter: new PrismaPg({
        connectionString: env.DATABASE_URL,
        connectionTimeoutMillis: 5_000,
      }),
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
