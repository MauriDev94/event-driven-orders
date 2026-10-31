import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { runAdminQuery, TEMPLATE_DATABASE, withDatabase } from './database.js';

declare module 'vitest' {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
    redisUrl: string;
  }
}

/**
 * Starts Postgres once per run and migrates a template database with the
 * real `prisma migrate deploy`, the same command the container runs. Starts
 * Redis too, with a random password, like Compose.
 *
 * CI sets TEST_DATABASE_URL to the job's Postgres service; locally a
 * postgres:16-alpine testcontainer is started (Docker Desktop must be up).
 * TEST_REDIS_URL works the same way; without it a Redis testcontainer runs.
 */
export default async function setup(project: TestProject) {
  let container: StartedPostgreSqlContainer | undefined;
  let redis: StartedTestContainer | undefined;
  let adminUrl = process.env['TEST_DATABASE_URL'];
  if (!adminUrl) {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withPassword(randomBytes(16).toString('hex'))
      .start();
    adminUrl = container.getConnectionUri();
  }

  await runAdminQuery(
    adminUrl,
    `DROP DATABASE IF EXISTS "${TEMPLATE_DATABASE}"`,
  );
  await runAdminQuery(adminUrl, `CREATE DATABASE "${TEMPLATE_DATABASE}"`);
  execFileSync(
    process.execPath,
    [join('node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'],
    {
      env: {
        ...process.env,
        DATABASE_URL: withDatabase(adminUrl, TEMPLATE_DATABASE),
      },
      stdio: 'pipe',
    },
  );

  project.provide('adminDatabaseUrl', adminUrl);

  let redisUrl = process.env['TEST_REDIS_URL'];
  if (!redisUrl) {
    const password = randomBytes(16).toString('hex');
    redis = await new GenericContainer('redis:8.8-alpine')
      .withCommand(['redis-server', '--requirepass', password])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    redisUrl = `redis://default:${password}@${redis.getHost()}:${redis.getMappedPort(6379)}/0`;
  }
  project.provide('redisUrl', redisUrl);

  return async () => {
    await Promise.all([container?.stop(), redis?.stop()]);
  };
}
