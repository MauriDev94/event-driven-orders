// Prisma 7 CLI config. Named prisma7.config.ts (accepted since 7.10) so it
// doesn't clash with the Prisma 8 format, which only reads prisma.config.ts.
// DATABASE_URL comes from the environment (compose, CI or the shell); there
// is no dotenv. `prisma generate` doesn't need it.
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
