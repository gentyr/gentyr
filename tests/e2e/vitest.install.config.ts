import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120000,     // 2 min per test (installation + verification)
    hookTimeout: 60000,      // 1 min for setup/teardown
    include: ['tests/e2e/install/**/*.test.ts'],
    sequence: { concurrent: false },  // Run sequentially - shared temp state
  },
});
