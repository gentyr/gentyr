import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types.ts',
        '**/index.ts',
      ],
    },
    // Increase timeout for database operations
    testTimeout: 10000,
    // Custom reporters - TestFailureReporter spawns Claude to fix failures
    reporters: [
      'default',
      './test/reporters/test-failure-reporter.ts',
    ],
  },
});
