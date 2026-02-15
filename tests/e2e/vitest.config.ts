import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 300000,     // 5 min per test (Claude sessions are slow)
    hookTimeout: 60000,      // 1 min for setup/teardown
    include: ['tests/e2e/**/*.test.ts'],
  },
});
