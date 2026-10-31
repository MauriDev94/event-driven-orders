import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { runAdminQuery, TEMPLATE_DATABASE, withDatabase } from './database.js';

declare module 'vitest' {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}

/**
 * Starts Postgres once per run and migrates a template database with the
 * real `prisma migrate deploy`, the same command the container runs.
 *
 * CI sets TEST_DATABASE_URL to the job's Postgres service; locally a
 * postgres:16-alpine testcontainer is started (Docker Desktop must be up).
 */
export default async function setup(project: TestProject) {
  let container: StartedPostgreSqlContainer | undefined;
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

  return async () => {
    await container?.stop();
  };
}
