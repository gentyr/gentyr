/**
 * Unit tests for Playwright E2E MCP Server
 *
 * Tests Zod schema validation (G003), helper functions,
 * and error handling (G001).
 *
 * Child process calls are NOT tested here - those require
 * extensive mocking and are better suited for integration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  LaunchUiModeArgsSchema,
  RunTestsArgsSchema,
  SeedDataArgsSchema,
  CleanupDataArgsSchema,
  GetReportArgsSchema,
  GetCoverageStatusArgsSchema,
  PreflightCheckArgsSchema,
  RunAuthSetupArgsSchema,
  PLAYWRIGHT_PROJECTS,
} from '../types.js';
import { parseTestOutput, truncateOutput } from '../helpers.js';

// ============================================================================
// Zod Schema Validation Tests (G003 Compliance)
// ============================================================================

describe('Playwright MCP Server - Zod Schemas', () => {
  describe('LaunchUiModeArgsSchema', () => {
    it('should accept valid vendor-owner project', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: 'vendor-owner',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.project).toBe('vendor-owner');
      }
    });

    it('should accept valid manual project', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: 'manual',
      });

      expect(result.success).toBe(true);
    });

    it('should accept all valid UI mode projects', () => {
      const validProjects = [
        'vendor-owner',
        'vendor-admin',
        'vendor-dev',
        'vendor-viewer',
        'manual',
        'extension',
        'extension-manual',
        'demo',
        'cross-persona',
        'auth-flows',
      ];

      for (const project of validProjects) {
        const result = LaunchUiModeArgsSchema.safeParse({ project });
        expect(result.success).toBe(true);
      }
    });

    it('should accept demo project (unified dashboard + extension)', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: 'demo',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.project).toBe('demo');
      }
    });

    it('should accept extension project', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: 'extension',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.project).toBe('extension');
      }
    });

    it('should accept extension-manual project', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: 'extension-manual',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.project).toBe('extension-manual');
      }
    });

    it('should reject invalid project name (G001 - fail loudly)', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: 'invalid-project',
      });

      expect(result.success).toBe(false);
    });

    it('should reject seed project (not allowed in UI mode)', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: 'seed',
      });

      expect(result.success).toBe(false);
    });

    it('should accept optional base_url override', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: 'vendor-owner',
        base_url: 'http://localhost:4000',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.base_url).toBe('http://localhost:4000');
      }
    });

    it('should work without base_url (optional)', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: 'vendor-owner',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.base_url).toBeUndefined();
      }
    });

    it('should reject invalid base_url (G003 URL validation)', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: 'vendor-owner',
        base_url: 'not-a-url',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('RunTestsArgsSchema', () => {
    it('should accept valid project filter', () => {
      const result = RunTestsArgsSchema.safeParse({
        project: 'vendor-owner',
      });

      expect(result.success).toBe(true);
    });

    it('should accept no project (runs default)', () => {
      const result = RunTestsArgsSchema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.project).toBeUndefined();
      }
    });

    it('should accept valid grep pattern', () => {
      const result = RunTestsArgsSchema.safeParse({
        grep: 'should login successfully',
      });

      expect(result.success).toBe(true);
    });

    it('should reject grep patterns with unsafe characters (G003)', () => {
      const unsafePatterns = [
        'test; rm -rf /',
        'test && echo bad',
        'test`whoami`',
        'test$USER',
      ];

      for (const pattern of unsafePatterns) {
        const result = RunTestsArgsSchema.safeParse({ grep: pattern });
        expect(result.success).toBe(false);
      }
    });

    it('should accept grep patterns with safe regex characters', () => {
      const safePatterns = [
        'test.*login',
        'should (create|update) user',
        'api[0-9]',
        'test-name_123',
        'workflow.*complete',
      ];

      for (const pattern of safePatterns) {
        const result = RunTestsArgsSchema.safeParse({ grep: pattern });
        expect(result.success).toBe(true);
      }
    });

    it('should reject grep patterns exceeding max length (200 chars)', () => {
      const longPattern = 'a'.repeat(201);
      const result = RunTestsArgsSchema.safeParse({ grep: longPattern });

      expect(result.success).toBe(false);
    });

    it('should accept retries within bounds (0-5)', () => {
      const validRetries = [0, 1, 2, 3, 4, 5];

      for (const retries of validRetries) {
        const result = RunTestsArgsSchema.safeParse({ retries });
        expect(result.success).toBe(true);
      }
    });

    it('should reject retries outside bounds (G003)', () => {
      const invalidRetries = [-1, 6, 10, 100];

      for (const retries of invalidRetries) {
        const result = RunTestsArgsSchema.safeParse({ retries });
        expect(result.success).toBe(false);
      }
    });

    it('should reject non-integer retries', () => {
      const result = RunTestsArgsSchema.safeParse({ retries: 2.5 });

      expect(result.success).toBe(false);
    });

    it('should accept workers within bounds (1-16)', () => {
      const validWorkers = [1, 4, 8, 16];

      for (const workers of validWorkers) {
        const result = RunTestsArgsSchema.safeParse({ workers });
        expect(result.success).toBe(true);
      }
    });

    it('should reject workers outside bounds (G003)', () => {
      const invalidWorkers = [0, 17, 32, -1];

      for (const workers of invalidWorkers) {
        const result = RunTestsArgsSchema.safeParse({ workers });
        expect(result.success).toBe(false);
      }
    });

    it('should accept all parameters together', () => {
      const result = RunTestsArgsSchema.safeParse({
        project: 'cross-persona',
        grep: 'should handle.*workflow',
        retries: 2,
        workers: 4,
      });

      expect(result.success).toBe(true);
    });
  });

  describe('SeedDataArgsSchema', () => {
    it('should accept empty object', () => {
      const result = SeedDataArgsSchema.safeParse({});

      expect(result.success).toBe(true);
    });
  });

  describe('CleanupDataArgsSchema', () => {
    it('should accept empty object', () => {
      const result = CleanupDataArgsSchema.safeParse({});

      expect(result.success).toBe(true);
    });
  });

  describe('GetReportArgsSchema', () => {
    it('should default open_browser to false', () => {
      const result = GetReportArgsSchema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.open_browser).toBe(false);
      }
    });

    it('should accept open_browser: true', () => {
      const result = GetReportArgsSchema.safeParse({ open_browser: true });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.open_browser).toBe(true);
      }
    });

    it('should accept open_browser: false explicitly', () => {
      const result = GetReportArgsSchema.safeParse({ open_browser: false });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.open_browser).toBe(false);
      }
    });

    it('should reject non-boolean open_browser', () => {
      const result = GetReportArgsSchema.safeParse({ open_browser: 'true' });

      expect(result.success).toBe(false);
    });
  });

  describe('GetCoverageStatusArgsSchema', () => {
    it('should accept empty object', () => {
      const result = GetCoverageStatusArgsSchema.safeParse({});

      expect(result.success).toBe(true);
    });
  });

  describe('PreflightCheckArgsSchema', () => {
    it('should accept empty object (general readiness check)', () => {
      const result = PreflightCheckArgsSchema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.project).toBeUndefined();
        expect(result.data.skip_compilation).toBe(false);
      }
    });

    it('should accept valid UI mode project', () => {
      const result = PreflightCheckArgsSchema.safeParse({
        project: 'demo',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.project).toBe('demo');
      }
    });

    it('should accept all valid UI mode projects', () => {
      const validProjects = [
        'vendor-owner', 'vendor-admin', 'vendor-dev', 'vendor-viewer',
        'manual', 'extension', 'extension-manual', 'demo',
        'cross-persona', 'auth-flows',
      ];

      for (const project of validProjects) {
        const result = PreflightCheckArgsSchema.safeParse({ project });
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid project name', () => {
      const result = PreflightCheckArgsSchema.safeParse({
        project: 'invalid-project',
      });

      expect(result.success).toBe(false);
    });

    it('should reject infrastructure projects (seed, auth-setup)', () => {
      const result = PreflightCheckArgsSchema.safeParse({
        project: 'seed',
      });

      expect(result.success).toBe(false);
    });

    it('should accept optional base_url', () => {
      const result = PreflightCheckArgsSchema.safeParse({
        project: 'demo',
        base_url: 'http://localhost:4000',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.base_url).toBe('http://localhost:4000');
      }
    });

    it('should reject invalid base_url', () => {
      const result = PreflightCheckArgsSchema.safeParse({
        project: 'demo',
        base_url: 'not-a-url',
      });

      expect(result.success).toBe(false);
    });

    it('should accept skip_compilation flag', () => {
      const result = PreflightCheckArgsSchema.safeParse({
        project: 'demo',
        skip_compilation: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skip_compilation).toBe(true);
      }
    });

    it('should default skip_compilation to false', () => {
      const result = PreflightCheckArgsSchema.safeParse({
        project: 'demo',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skip_compilation).toBe(false);
      }
    });

    it('should accept all parameters together', () => {
      const result = PreflightCheckArgsSchema.safeParse({
        project: 'vendor-owner',
        base_url: 'http://localhost:3000',
        skip_compilation: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.project).toBe('vendor-owner');
        expect(result.data.base_url).toBe('http://localhost:3000');
        expect(result.data.skip_compilation).toBe(true);
      }
    });
  });

  describe('RunAuthSetupArgsSchema', () => {
    it('should accept empty object', () => {
      const result = RunAuthSetupArgsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should default seed_only to false', () => {
      const result = RunAuthSetupArgsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.seed_only).toBe(false);
      }
    });

    it('should accept seed_only: true', () => {
      const result = RunAuthSetupArgsSchema.safeParse({ seed_only: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.seed_only).toBe(true);
      }
    });

    it('should accept seed_only: false', () => {
      const result = RunAuthSetupArgsSchema.safeParse({ seed_only: false });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.seed_only).toBe(false);
      }
    });

    it('should reject non-boolean seed_only', () => {
      const result = RunAuthSetupArgsSchema.safeParse({ seed_only: 'yes' });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Helper Function Tests
// ============================================================================

describe('Playwright MCP Server - Helper Functions', () => {
  describe('parseTestOutput', () => {
    it('should parse successful test output', () => {
      const output = '  10 passed (5.2s)';
      const result = parseTestOutput(output);

      expect(result.passed).toBe(10);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.duration).toBe('5.2s');
    });

    it('should parse failed test output', () => {
      const output = '  5 passed  2 failed (3.1s)';
      const result = parseTestOutput(output);

      expect(result.passed).toBe(5);
      expect(result.failed).toBe(2);
      expect(result.duration).toBe('3.1s');
    });

    it('should parse skipped test output', () => {
      const output = '  8 passed  3 skipped (4.5s)';
      const result = parseTestOutput(output);

      expect(result.passed).toBe(8);
      expect(result.skipped).toBe(3);
      expect(result.duration).toBe('4.5s');
    });

    it('should parse mixed test output', () => {
      const output = '  15 passed  2 failed  4 skipped (12.3s)';
      const result = parseTestOutput(output);

      expect(result.passed).toBe(15);
      expect(result.failed).toBe(2);
      expect(result.skipped).toBe(4);
      expect(result.duration).toBe('12.3s');
    });

    it('should handle missing metrics (G001 - structure validation)', () => {
      const output = 'Some random output without metrics';
      const result = parseTestOutput(output);

      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.duration).toBe('unknown');
    });

    it('should parse multi-line output correctly', () => {
      const output = `
Running tests...
  vendor-owner (Chrome)

  15 passed  2 failed  1 skipped (8.7s)

Done.
      `;
      const result = parseTestOutput(output);

      expect(result.passed).toBe(15);
      expect(result.failed).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.duration).toBe('8.7s');
    });

    it('should handle decimal and integer durations', () => {
      const outputs = [
        '  5 passed (1s)',
        '  5 passed (1.0s)',
        '  5 passed (1.23s)',
        '  5 passed (123.456s)',
      ];

      for (const output of outputs) {
        const result = parseTestOutput(output);
        expect(result.duration).toMatch(/^\d+\.?\d*s$/);
      }
    });

    it('should return zeros on garbage/crash output', () => {
      const result = parseTestOutput('Error: Cannot find module playwright\n    at Module._resolveFilename');

      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.duration).toBe('unknown');
    });

    it('should return zeros on empty output', () => {
      const result = parseTestOutput('');

      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.duration).toBe('unknown');
    });

    it('should return zeros when Playwright finds no matching tests', () => {
      const result = parseTestOutput('No tests found.\n');

      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });

  describe('truncateOutput', () => {
    it('should not truncate short output', () => {
      const output = 'Short output'.repeat(10);
      const result = truncateOutput(output);

      expect(result).toBe(output);
      expect(result).not.toContain('truncated');
    });

    it('should truncate long output at default length (4000)', () => {
      const output = 'x'.repeat(5000);
      const result = truncateOutput(output);

      expect(result.length).toBeLessThan(5000);
      expect(result).toContain('... (output truncated)');
      expect(result.slice(0, 4000)).toBe('x'.repeat(4000));
    });

    it('should truncate at custom maxLength', () => {
      const output = 'x'.repeat(2000);
      const result = truncateOutput(output, 1000);

      expect(result.length).toBeLessThan(2000);
      expect(result).toContain('... (output truncated)');
      expect(result.slice(0, 1000)).toBe('x'.repeat(1000));
    });

    it('should preserve structure validation (G001)', () => {
      const output = 'x'.repeat(10000);
      const result = truncateOutput(output);

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('countTestFiles (simulated with temp files)', () => {
    let tempDir: string;

    // This simulation mirrors the real countTestFiles in server.ts exactly.
    // Both .spec.ts (automated) and .manual.ts (manual scaffolds) are counted.
    // The extension project filter excludes files under a manual/ subdirectory.
    function countTestFiles(dir: string, projectFilter?: string): number {
      if (!fs.existsSync(dir)) return 0;

      try {
        const files = fs.readdirSync(dir, { recursive: true }) as string[];
        return files.filter(f => {
          const filename = String(f);
          const isSpec = filename.endsWith('.spec.ts');
          const isManual = filename.endsWith('.manual.ts');
          if (!isSpec && !isManual) return false;

          // Exclude manual/ subdirectory for the extension project (counted separately as extension-manual)
          if (projectFilter === 'extension' && filename.includes('manual/')) return false;

          // For role-specific projects, filter by matching spec file
          if (projectFilter === 'vendor-admin') return filename.includes('admin');
          if (projectFilter === 'vendor-dev') return filename.includes('developer');
          if (projectFilter === 'vendor-viewer') return filename.includes('viewer');

          return true;
        }).length;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[playwright] Failed to read test directory ${dir}: ${message}\n`);
        return 0;
      }
    }

    beforeEach(() => {
      tempDir = path.join('/tmp', `playwright-test-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should count .spec.ts files', () => {
      fs.writeFileSync(path.join(tempDir, 'test1.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'test2.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'test3.spec.ts'), '');

      const count = countTestFiles(tempDir);

      expect(count).toBe(3);
    });

    it('should ignore non-.spec.ts and non-.manual.ts files', () => {
      fs.writeFileSync(path.join(tempDir, 'test1.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'test2.test.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'helper.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'README.md'), '');

      const count = countTestFiles(tempDir);

      expect(count).toBe(1); // Only test1.spec.ts
    });

    it('should count .manual.ts files (demo and extension-manual scaffolds)', () => {
      fs.writeFileSync(path.join(tempDir, 'vendor-dashboard.manual.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'vendor-billing.manual.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'ext-popup-auth.manual.ts'), '');

      const count = countTestFiles(tempDir);

      expect(count).toBe(3);
    });

    it('should count both .spec.ts and .manual.ts files together', () => {
      fs.writeFileSync(path.join(tempDir, 'auth.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'vendor-dashboard.manual.ts'), '');

      const count = countTestFiles(tempDir);

      expect(count).toBe(2);
    });

    it('should exclude manual/ subdirectory files for extension project filter', () => {
      const manualSubdir = path.join(tempDir, 'manual');
      fs.mkdirSync(manualSubdir, { recursive: true });

      fs.writeFileSync(path.join(tempDir, 'popup-auth.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'platform-detection.spec.ts'), '');
      fs.writeFileSync(path.join(manualSubdir, 'ext-popup.manual.ts'), ''); // should be excluded

      const count = countTestFiles(tempDir, 'extension');

      expect(count).toBe(2); // Only the .spec.ts files, manual/ excluded
    });

    it('should include all files for extension project when no manual/ subdirectory', () => {
      fs.writeFileSync(path.join(tempDir, 'popup-auth.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'platform-detection.spec.ts'), '');

      const count = countTestFiles(tempDir, 'extension');

      expect(count).toBe(2);
    });

    it('should count files in nested directories', () => {
      const subdir = path.join(tempDir, 'nested', 'deep');
      fs.mkdirSync(subdir, { recursive: true });

      fs.writeFileSync(path.join(tempDir, 'test1.spec.ts'), '');
      fs.writeFileSync(path.join(subdir, 'test2.spec.ts'), '');

      const count = countTestFiles(tempDir);

      expect(count).toBe(2);
    });

    it('should filter vendor-admin specs', () => {
      fs.writeFileSync(path.join(tempDir, 'admin.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'developer.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'viewer.spec.ts'), '');

      const count = countTestFiles(tempDir, 'vendor-admin');

      expect(count).toBe(1); // Only admin.spec.ts
    });

    it('should filter vendor-dev specs', () => {
      fs.writeFileSync(path.join(tempDir, 'admin.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'developer.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'viewer.spec.ts'), '');

      const count = countTestFiles(tempDir, 'vendor-dev');

      expect(count).toBe(1); // Only developer.spec.ts
    });

    it('should filter vendor-viewer specs', () => {
      fs.writeFileSync(path.join(tempDir, 'admin.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'developer.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'viewer.spec.ts'), '');

      const count = countTestFiles(tempDir, 'vendor-viewer');

      expect(count).toBe(1); // Only viewer.spec.ts
    });

    it('should count all specs without filter', () => {
      fs.writeFileSync(path.join(tempDir, 'admin.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'developer.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'viewer.spec.ts'), '');

      const count = countTestFiles(tempDir);

      expect(count).toBe(3); // All specs
    });

    it('should return 0 for non-existent directory (G001 - file-not-found)', () => {
      const nonExistentDir = path.join(tempDir, 'does-not-exist');
      const count = countTestFiles(nonExistentDir);

      expect(count).toBe(0);
    });

    it('should return 0 for empty directory', () => {
      const emptyDir = path.join(tempDir, 'empty');
      fs.mkdirSync(emptyDir);

      const count = countTestFiles(emptyDir);

      expect(count).toBe(0);
    });

    it('should handle read errors gracefully (G001)', () => {
      // Create a file, not a directory
      const notADir = path.join(tempDir, 'not-a-dir.txt');
      fs.writeFileSync(notADir, 'content');

      // Attempting to read as directory should fail gracefully
      const count = countTestFiles(notADir);

      expect(count).toBe(0);
    });
  });
});

// ============================================================================
// Constants Tests
// ============================================================================

describe('Playwright MCP Server - Constants', () => {
  describe('PLAYWRIGHT_PROJECTS', () => {
    it('should define all vendor persona projects', () => {
      expect(PLAYWRIGHT_PROJECTS.VENDOR_OWNER).toBe('vendor-owner');
      expect(PLAYWRIGHT_PROJECTS.VENDOR_ADMIN).toBe('vendor-admin');
      expect(PLAYWRIGHT_PROJECTS.VENDOR_DEV).toBe('vendor-dev');
      expect(PLAYWRIGHT_PROJECTS.VENDOR_VIEWER).toBe('vendor-viewer');
    });

    it('should define manual project', () => {
      expect(PLAYWRIGHT_PROJECTS.MANUAL).toBe('manual');
    });

    it('should define extension projects', () => {
      expect(PLAYWRIGHT_PROJECTS.EXTENSION).toBe('extension');
      expect(PLAYWRIGHT_PROJECTS.EXTENSION_MANUAL).toBe('extension-manual');
    });

    it('should define demo project (unified dashboard + extension)', () => {
      expect(PLAYWRIGHT_PROJECTS.DEMO).toBe('demo');
    });

    it('should define infrastructure projects', () => {
      expect(PLAYWRIGHT_PROJECTS.SEED).toBe('seed');
      expect(PLAYWRIGHT_PROJECTS.AUTH_SETUP).toBe('auth-setup');
    });

    it('should define multi-context projects', () => {
      expect(PLAYWRIGHT_PROJECTS.CROSS_PERSONA).toBe('cross-persona');
      expect(PLAYWRIGHT_PROJECTS.AUTH_FLOWS).toBe('auth-flows');
    });
  });
});

// ============================================================================
// Error Handling Tests (G001 Compliance)
// ============================================================================

describe('Playwright MCP Server - Error Handling', () => {
  describe('Schema validation failures (G001 - fail loudly)', () => {
    it('should fail loudly on invalid project enum', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: 'bad-project',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });

    it('should fail loudly on unsafe grep pattern', () => {
      const result = RunTestsArgsSchema.safeParse({
        grep: 'test; rm -rf /',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });

    it('should fail loudly on out-of-bounds retries', () => {
      const result = RunTestsArgsSchema.safeParse({
        retries: 10,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });

    it('should fail loudly on out-of-bounds workers', () => {
      const result = RunTestsArgsSchema.safeParse({
        workers: 100,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });
  });
});

// ============================================================================
// Type Safety Tests
// ============================================================================

describe('Playwright MCP Server - Type Safety', () => {
  describe('Inferred types from schemas', () => {
    it('should infer correct LaunchUiModeArgs type', () => {
      const args = LaunchUiModeArgsSchema.parse({
        project: 'vendor-owner',
        base_url: 'http://localhost:3000',
      });

      // TypeScript should infer these as correct types
      expect(typeof args.project).toBe('string');
      expect(typeof args.base_url).toBe('string');
    });

    it('should infer correct RunTestsArgs type', () => {
      const args = RunTestsArgsSchema.parse({
        project: 'cross-persona',
        grep: 'workflow',
        retries: 2,
        workers: 4,
      });

      expect(typeof args.project).toBe('string');
      expect(typeof args.grep).toBe('string');
      expect(typeof args.retries).toBe('number');
      expect(typeof args.workers).toBe('number');
    });

    it('should infer correct GetReportArgs type with default', () => {
      const args = GetReportArgsSchema.parse({});

      expect(typeof args.open_browser).toBe('boolean');
      expect(args.open_browser).toBe(false);
    });
  });
});
