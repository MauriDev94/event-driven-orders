import { randomBytes } from 'node:crypto';
import pg from 'pg';

export const TEMPLATE_DATABASE = 'assistant_template';

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export async function runAdminQuery(
  adminUrl: string,
  sql: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * A fresh database cloned from the migrated template, so test files can run
 * in parallel without seeing each other's rows.
 */
export async function createTestDatabase(
  adminUrl: string,
): Promise<TestDatabase> {
  const name = `assistant_test_${randomBytes(6).toString('hex')}`;
  await runAdminQuery(
    adminUrl,
    `CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DATABASE}"`,
  );
  return {
    url: withDatabase(adminUrl, name),
    drop: () =>
      runAdminQuery(adminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
  };
}
