import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json. Requires Vite 8.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    // One Postgres per run (a testcontainer, or TEST_DATABASE_URL in CI),
    // migrated once into a template that every test file clones.
    globalSetup: ['test/support/global-setup.ts'],
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/main.ts'],
      thresholds: { lines: 80, statements: 80 },
    },
  },
});
