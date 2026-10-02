import { defineConfig } from 'vitest/config';

/** End-to-end tests against a running API (npm run dev:api) with the dev seed loaded. */
export default defineConfig({
  test: { include: ['test/e2e/**/*.e2e.ts'], testTimeout: 30_000, hookTimeout: 30_000, fileParallelism: false, sequence: { concurrent: false } },
});
