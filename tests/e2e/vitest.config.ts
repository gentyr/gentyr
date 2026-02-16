import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 600000,     // 10 min per test (real Claude agent sessions)
    hookTimeout: 60000,      // 1 min for setup/teardown
    include: ['tests/e2e/**/*.test.ts'],
  },
});
