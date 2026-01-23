/**
 * Shared Test Utilities for MCP Servers
 *
 * Provides reusable utilities for test isolation and cleanup.
 * Following industry best practices for concurrent test execution.
 *
 * @module __testUtils__
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

// ============================================================================
// Database Utilities
// ============================================================================

/**
 * Creates an isolated in-memory SQLite database with the given schema.
 * Use in beforeEach() for complete test isolation.
 *
 * @example
 * ```typescript
 * import { createTestDb } from '../__testUtils__';
 * import { TODO_DB_SCHEMA } from '../__testUtils__/schemas';
 *
 * let db: Database.Database;
 *
 * beforeEach(() => {
 *   db = createTestDb(TODO_DB_SCHEMA);
 * });
 *
 * afterEach(() => {
 *   db.close();
 * });
 * ```
 */
export function createTestDb(schema: string): Database.Database {
  const db = new Database(':memory:');
  db.exec(schema);
  return db;
}

// ============================================================================
// File System Utilities
// ============================================================================

/**
 * Creates a unique temporary directory for file-based tests.
 * Returns both the path and a cleanup function.
 *
 * Uses os.tmpdir() for cross-platform compatibility and UUID for uniqueness.
 *
 * @example
 * ```typescript
 * import { createTempDir } from '../__testUtils__';
 *
 * let tempDir: ReturnType<typeof createTempDir>;
 *
 * beforeEach(() => {
 *   tempDir = createTempDir('my-test');
 * });
 *
 * afterEach(() => {
 *   tempDir.cleanup();
 * });
 * ```
 */
export function createTempDir(prefix: string = 'mcp-test'): {
  path: string;
  cleanup: () => void;
} {
  const tempPath = path.join(os.tmpdir(), `${prefix}-${randomUUID()}`);
  fs.mkdirSync(tempPath, { recursive: true });

  return {
    path: tempPath,
    cleanup: () => {
      if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Creates a temporary file with optional initial content.
 * Returns the file path and a cleanup function.
 *
 * @example
 * ```typescript
 * const { path: configPath, cleanup } = createTempFile('config.json', '{}');
 * // Use configPath...
 * cleanup(); // Removes the file and its directory
 * ```
 */
export function createTempFile(
  filename: string,
  content: string = '',
  prefix: string = 'mcp-test'
): { path: string; cleanup: () => void } {
  const dir = createTempDir(prefix);
  const filePath = path.join(dir.path, filename);

  if (content) {
    fs.writeFileSync(filePath, content);
  }

  return {
    path: filePath,
    cleanup: dir.cleanup,
  };
}

// ============================================================================
// Time Utilities
// ============================================================================

/**
 * Gets a Unix timestamp offset from now.
 * Useful for creating test data with specific timestamps.
 *
 * @example
 * ```typescript
 * const twoHoursAgo = getTimestamp(-2, 'hours');
 * const thirtyMinutesAgo = getTimestamp(-30, 'minutes');
 * const oneWeekAgo = getTimestamp(-7, 'days');
 * ```
 */
export function getTimestamp(
  offset: number,
  unit: 'seconds' | 'minutes' | 'hours' | 'days' = 'seconds'
): number {
  const multipliers = {
    seconds: 1,
    minutes: 60,
    hours: 60 * 60,
    days: 24 * 60 * 60,
  };

  const now = Math.floor(Date.now() / 1000);
  return now + offset * multipliers[unit];
}

/**
 * Gets an ISO timestamp string offset from now.
 */
export function getISOTimestamp(
  offset: number,
  unit: 'seconds' | 'minutes' | 'hours' | 'days' = 'seconds'
): string {
  const timestamp = getTimestamp(offset, unit);
  return new Date(timestamp * 1000).toISOString();
}

// ============================================================================
// ID Generators
// ============================================================================

/**
 * Generates a random UUID.
 * Re-exported from crypto for convenience.
 */
export { randomUUID };

/**
 * Generates a prefixed test ID.
 * Useful for creating identifiable test data.
 *
 * @example
 * ```typescript
 * const taskId = generateTestId('task'); // "task-a1b2c3d4..."
 * ```
 */
export function generateTestId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

// ============================================================================
// Test Data Helpers
// ============================================================================

/**
 * Creates multiple items using a factory function.
 *
 * @example
 * ```typescript
 * const tasks = createMultiple(5, (i) => ({
 *   id: randomUUID(),
 *   title: `Task ${i}`,
 * }));
 * ```
 */
export function createMultiple<T>(count: number, factory: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, i) => factory(i));
}

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Checks if a value is an error result (has an 'error' property).
 */
export function isErrorResult(result: unknown): result is { error: string } {
  return (
    result !== null &&
    typeof result === 'object' &&
    'error' in result &&
    typeof (result as { error: unknown }).error === 'string'
  );
}
