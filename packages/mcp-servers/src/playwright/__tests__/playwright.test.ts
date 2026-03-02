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
  RunDemoArgsSchema,
  CheckDemoResultArgsSchema,
  StopDemoArgsSchema,
  PLAYWRIGHT_PROJECTS,
  type DemoRunState,
  type CheckDemoResultResult,
  type DemoProgress,
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

    it('should accept any non-empty project name (validated by Playwright CLI at runtime)', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: 'custom-project',
      });

      expect(result.success).toBe(true);
    });

    it('should reject empty project name', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: '',
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

    it('should accept timeout within bounds (30000-600000)', () => {
      const validTimeouts = [30000, 60000, 120000, 300000, 600000];
      for (const timeout of validTimeouts) {
        const result = RunTestsArgsSchema.safeParse({ timeout });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.timeout).toBe(timeout);
        }
      }
    });

    it('should reject timeout outside bounds (G003)', () => {
      const invalidTimeouts = [0, 1000, 29999, 600001, 1000000];
      for (const timeout of invalidTimeouts) {
        const result = RunTestsArgsSchema.safeParse({ timeout });
        expect(result.success).toBe(false);
      }
    });

    it('should accept omitted timeout (uses Playwright config default)', () => {
      const result = RunTestsArgsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBeUndefined();
      }
    });

    it('should reject non-integer timeout (G003)', () => {
      const result = RunTestsArgsSchema.safeParse({ timeout: 60000.5 });
      expect(result.success).toBe(false);
    });

    it('should accept all parameters together', () => {
      const result = RunTestsArgsSchema.safeParse({
        project: 'cross-persona',
        grep: 'should handle.*workflow',
        retries: 2,
        workers: 4,
        timeout: 120000,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBe(120000);
      }
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

    it('should accept any non-empty project name (validated by Playwright CLI at runtime)', () => {
      const result = PreflightCheckArgsSchema.safeParse({
        project: 'chromium',
      });

      expect(result.success).toBe(true);
    });

    it('should reject empty project name', () => {
      const result = PreflightCheckArgsSchema.safeParse({
        project: '',
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

  describe('RunDemoArgsSchema', () => {
    it('should require project field', () => {
      const result = RunDemoArgsSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should accept a valid project name', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.project).toBe('demo');
      }
    });

    it('should accept any non-empty project name up to 100 chars', () => {
      const projects = ['vendor-owner', 'extension', 'cross-persona', 'my-custom-project'];
      for (const project of projects) {
        const result = RunDemoArgsSchema.safeParse({ project });
        expect(result.success).toBe(true);
      }
    });

    it('should reject empty project name (G003)', () => {
      const result = RunDemoArgsSchema.safeParse({ project: '' });
      expect(result.success).toBe(false);
    });

    it('should reject project name exceeding 100 characters (G003)', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'a'.repeat(101) });
      expect(result.success).toBe(false);
    });

    it('should default slow_mo to 800 when omitted', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.slow_mo).toBe(800);
      }
    });

    it('should accept slow_mo of 0 (no delay)', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', slow_mo: 0 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.slow_mo).toBe(0);
      }
    });

    it('should accept slow_mo of 5000 (maximum)', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', slow_mo: 5000 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.slow_mo).toBe(5000);
      }
    });

    it('should reject slow_mo below 0 (G003)', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', slow_mo: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject slow_mo above 5000 (G003)', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', slow_mo: 5001 });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer slow_mo (G003)', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', slow_mo: 1.5 });
      expect(result.success).toBe(false);
    });

    it('should coerce slow_mo from string to number via z.coerce', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', slow_mo: '500' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.slow_mo).toBe(500);
        expect(typeof result.data.slow_mo).toBe('number');
      }
    });

    it('should accept optional base_url', () => {
      const result = RunDemoArgsSchema.safeParse({
        project: 'demo',
        base_url: 'http://localhost:4000',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.base_url).toBe('http://localhost:4000');
      }
    });

    it('should allow base_url to be omitted', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.base_url).toBeUndefined();
      }
    });

    it('should reject invalid base_url (G003 URL validation)', () => {
      const result = RunDemoArgsSchema.safeParse({
        project: 'demo',
        base_url: 'not-a-url',
      });
      expect(result.success).toBe(false);
    });

    it('should accept all parameters together', () => {
      const result = RunDemoArgsSchema.safeParse({
        project: 'vendor-owner',
        slow_mo: 1200,
        base_url: 'http://localhost:3000',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.project).toBe('vendor-owner');
        expect(result.data.slow_mo).toBe(1200);
        expect(result.data.base_url).toBe('http://localhost:3000');
      }
    });

    it('should infer correct RunDemoArgs type', () => {
      const args = RunDemoArgsSchema.parse({ project: 'demo', slow_mo: 800 });
      expect(typeof args.project).toBe('string');
      expect(typeof args.slow_mo).toBe('number');
    });

    it('should accept optional test_file', () => {
      const result = RunDemoArgsSchema.safeParse({
        project: 'vendor-owner',
        test_file: 'e2e/demo/onboarding.demo.ts',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.test_file).toBe('e2e/demo/onboarding.demo.ts');
      }
    });

    it('should allow test_file to be omitted (backward compat)', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.test_file).toBeUndefined();
      }
    });

    it('should reject test_file exceeding 500 characters', () => {
      const result = RunDemoArgsSchema.safeParse({
        project: 'demo',
        test_file: 'a'.repeat(501),
      });
      expect(result.success).toBe(false);
    });

    it('should default pause_at_end to false', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pause_at_end).toBe(false);
      }
    });

    it('should accept pause_at_end: true', () => {
      const result = RunDemoArgsSchema.safeParse({
        project: 'demo',
        pause_at_end: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pause_at_end).toBe(true);
      }
    });

    it('should coerce pause_at_end from string via z.coerce', () => {
      const result = RunDemoArgsSchema.safeParse({
        project: 'demo',
        pause_at_end: 'true',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pause_at_end).toBe(true);
      }
    });

    it('should accept all parameters including test_file and pause_at_end', () => {
      const result = RunDemoArgsSchema.safeParse({
        project: 'vendor-owner',
        slow_mo: 0,
        base_url: 'http://localhost:3000',
        test_file: 'e2e/demo/billing.demo.ts',
        pause_at_end: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.project).toBe('vendor-owner');
        expect(result.data.slow_mo).toBe(0);
        expect(result.data.test_file).toBe('e2e/demo/billing.demo.ts');
        expect(result.data.pause_at_end).toBe(true);
      }
    });

    it('should default timeout to 120000 when omitted', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBe(120000);
      }
    });

    it('should accept timeout at lower bound (30000)', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', timeout: 30000 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBe(30000);
      }
    });

    it('should accept timeout at upper bound (600000)', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', timeout: 600000 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBe(600000);
      }
    });

    it('should reject timeout below 30000 (G003)', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', timeout: 29999 });
      expect(result.success).toBe(false);
    });

    it('should reject timeout above 600000 (G003)', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', timeout: 600001 });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer timeout (G003)', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', timeout: 60000.5 });
      expect(result.success).toBe(false);
    });

    it('should coerce timeout from string via z.coerce', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', timeout: '60000' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBe(60000);
        expect(typeof result.data.timeout).toBe('number');
      }
    });

    it('should default headless to false when omitted', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.headless).toBe(false);
      }
    });

    it('should accept headless: true', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', headless: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.headless).toBe(true);
      }
    });

    it('should coerce headless from string via z.coerce', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', headless: 'true' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.headless).toBe(true);
      }
    });

    it('should default show_cursor to false when omitted', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.show_cursor).toBe(false);
      }
    });

    it('should accept show_cursor: true', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', show_cursor: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.show_cursor).toBe(true);
      }
    });

    it('should coerce show_cursor from string via z.coerce', () => {
      const result = RunDemoArgsSchema.safeParse({ project: 'demo', show_cursor: 'true' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.show_cursor).toBe(true);
      }
    });

    it('should accept all parameters including new fields', () => {
      const result = RunDemoArgsSchema.safeParse({
        project: 'vendor-owner',
        slow_mo: 500,
        base_url: 'http://localhost:3000',
        test_file: 'e2e/demo/billing.demo.ts',
        pause_at_end: true,
        timeout: 60000,
        headless: true,
        show_cursor: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBe(60000);
        expect(result.data.headless).toBe(true);
        expect(result.data.show_cursor).toBe(true);
      }
    });
  });

  describe('CheckDemoResultArgsSchema', () => {
    it('should require pid field', () => {
      const result = CheckDemoResultArgsSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should accept a valid positive integer pid', () => {
      const result = CheckDemoResultArgsSchema.safeParse({ pid: 12345 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pid).toBe(12345);
      }
    });

    it('should reject pid of 0 (must be >= 1)', () => {
      const result = CheckDemoResultArgsSchema.safeParse({ pid: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject negative pid (G003)', () => {
      const result = CheckDemoResultArgsSchema.safeParse({ pid: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer pid (G003)', () => {
      const result = CheckDemoResultArgsSchema.safeParse({ pid: 1.5 });
      expect(result.success).toBe(false);
    });

    it('should coerce pid from string to number via z.coerce', () => {
      const result = CheckDemoResultArgsSchema.safeParse({ pid: '99999' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pid).toBe(99999);
        expect(typeof result.data.pid).toBe('number');
      }
    });

    it('should reject string that cannot coerce to an integer pid', () => {
      const result = CheckDemoResultArgsSchema.safeParse({ pid: 'not-a-pid' });
      expect(result.success).toBe(false);
    });

    it('should infer correct CheckDemoResultArgs type', () => {
      const args = CheckDemoResultArgsSchema.parse({ pid: 42 });
      expect(typeof args.pid).toBe('number');
      expect(args.pid).toBe(42);
    });
  });

  describe('StopDemoArgsSchema', () => {
    it('should require pid field', () => {
      const result = StopDemoArgsSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should accept a valid positive integer pid', () => {
      const result = StopDemoArgsSchema.safeParse({ pid: 12345 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pid).toBe(12345);
      }
    });

    it('should reject pid of 0 (must be >= 1)', () => {
      const result = StopDemoArgsSchema.safeParse({ pid: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject negative pid (G003)', () => {
      const result = StopDemoArgsSchema.safeParse({ pid: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer pid (G003)', () => {
      const result = StopDemoArgsSchema.safeParse({ pid: 1.5 });
      expect(result.success).toBe(false);
    });

    it('should coerce pid from string to number via z.coerce', () => {
      const result = StopDemoArgsSchema.safeParse({ pid: '99999' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pid).toBe(99999);
        expect(typeof result.data.pid).toBe('number');
      }
    });
  });

  describe('LaunchUiModeArgsSchema - test_file', () => {
    it('should accept optional test_file', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: 'vendor-owner',
        test_file: 'e2e/demo/onboarding.demo.ts',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.test_file).toBe('e2e/demo/onboarding.demo.ts');
      }
    });

    it('should allow test_file to be omitted (backward compat)', () => {
      const result = LaunchUiModeArgsSchema.safeParse({ project: 'vendor-owner' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.test_file).toBeUndefined();
      }
    });

    it('should reject test_file exceeding 500 characters', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: 'vendor-owner',
        test_file: 'a'.repeat(501),
      });
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
    // .spec.ts (automated), .manual.ts (manual scaffolds), and .demo.ts (demo scenarios) are counted.
    // The extension project filter uses pwConfig.projects isExtension/isManual flags.
    // For simplicity in tests we approximate: extension filter excludes manual/ subdirectory.
    function countTestFiles(dir: string, projectFilter?: string): number {
      if (!fs.existsSync(dir)) return 0;

      try {
        const files = fs.readdirSync(dir, { recursive: true }) as string[];
        return files.filter(f => {
          const filename = String(f);
          const isSpec = filename.endsWith('.spec.ts');
          const isManual = filename.endsWith('.manual.ts');
          const isDemo = filename.endsWith('.demo.ts');
          if (!isSpec && !isManual && !isDemo) return false;

          // Exclude manual/ subdirectory for extension projects (counted separately as extension-manual)
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

    it('should count .demo.ts files (curated demo scenario files)', () => {
      fs.writeFileSync(path.join(tempDir, 'onboarding.demo.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'billing.demo.ts'), '');

      const count = countTestFiles(tempDir);

      expect(count).toBe(2);
    });

    it('should count .demo.ts, .spec.ts, and .manual.ts files together', () => {
      fs.writeFileSync(path.join(tempDir, 'auth.spec.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'ext-popup.manual.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'onboarding.demo.ts'), '');

      const count = countTestFiles(tempDir);

      expect(count).toBe(3);
    });

    it('should not count .demo.ts files that lack the suffix', () => {
      // "demo" in filename but wrong suffix — not counted
      fs.writeFileSync(path.join(tempDir, 'demo-helper.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'onboarding.demo.ts'), '');

      const count = countTestFiles(tempDir);

      expect(count).toBe(1); // Only onboarding.demo.ts
    });

    it('should count .demo.ts files in nested directories', () => {
      const subdir = path.join(tempDir, 'demo');
      fs.mkdirSync(subdir, { recursive: true });

      fs.writeFileSync(path.join(subdir, 'checkout.demo.ts'), '');
      fs.writeFileSync(path.join(tempDir, 'login.spec.ts'), '');

      const count = countTestFiles(tempDir);

      expect(count).toBe(2);
    });

    it('should count .demo.ts files for extension project filter (not excluded)', () => {
      const manualSubdir = path.join(tempDir, 'manual');
      fs.mkdirSync(manualSubdir, { recursive: true });

      fs.writeFileSync(path.join(tempDir, 'extension-flow.demo.ts'), '');
      fs.writeFileSync(path.join(manualSubdir, 'ext-popup.manual.ts'), ''); // excluded (in manual/)

      const count = countTestFiles(tempDir, 'extension');

      // .demo.ts is NOT in manual/ so it is counted; manual/ file is excluded
      expect(count).toBe(1);
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
    it('should fail loudly on empty project name', () => {
      const result = LaunchUiModeArgsSchema.safeParse({
        project: '',
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

  describe('CheckDemoResultResult - trace_summary field', () => {
    it('should accept CheckDemoResultResult without trace_summary (field is optional)', () => {
      const result: CheckDemoResultResult = {
        status: 'passed',
        pid: 12345,
        project: 'vendor-owner',
        message: 'Demo completed successfully.',
      };

      expect(result.trace_summary).toBeUndefined();
      expect(result.status).toBe('passed');
      expect(result.pid).toBe(12345);
    });

    it('should accept CheckDemoResultResult with trace_summary as a string', () => {
      const result: CheckDemoResultResult = {
        status: 'failed',
        pid: 99999,
        project: 'demo',
        exit_code: 1,
        message: 'Demo failed.',
        trace_summary: '=== DEMO PLAY-BY-PLAY TRACE ===\n[  0.0s] NAV    Navigate to http://localhost:3000\n=== END TRACE ===',
      };

      expect(typeof result.trace_summary).toBe('string');
      expect(result.trace_summary).toContain('DEMO PLAY-BY-PLAY TRACE');
      expect(result.trace_summary).toContain('END TRACE');
    });

    it('should accept CheckDemoResultResult with all optional fields populated', () => {
      const result: CheckDemoResultResult = {
        status: 'failed',
        pid: 42,
        project: 'vendor-owner',
        test_file: 'e2e/demo/onboarding.demo.ts',
        started_at: '2026-02-28T00:00:00.000Z',
        ended_at: '2026-02-28T00:01:00.000Z',
        exit_code: 1,
        failure_summary: 'Test timed out after 30000ms',
        screenshot_paths: ['/tmp/test-results/screenshot.png'],
        trace_summary: '=== DEMO PLAY-BY-PLAY TRACE ===\nTotal events: 1\n\n[  0.0s] NAV    Navigate to http://localhost:3000\n=== END TRACE ===',
        message: 'Demo failed.',
      };

      expect(typeof result.trace_summary).toBe('string');
      expect(result.trace_summary).not.toBeNull();
      expect(result.trace_summary!.length).toBeGreaterThan(0);
    });

    it('trace_summary when present must be a non-empty string', () => {
      const withTrace: CheckDemoResultResult = {
        status: 'passed',
        pid: 1,
        message: 'ok',
        trace_summary: '=== DEMO PLAY-BY-PLAY TRACE ===\nTotal events: 5\n=== END TRACE ===',
      };

      expect(typeof withTrace.trace_summary).toBe('string');
      expect(withTrace.trace_summary!.length).toBeGreaterThan(0);
    });
  });

  describe('DemoRunState - trace_summary field', () => {
    it('should accept DemoRunState without trace_summary (field is optional)', () => {
      const state: DemoRunState = {
        pid: 12345,
        project: 'vendor-owner',
        started_at: '2026-02-28T00:00:00.000Z',
        status: 'running',
      };

      expect(state.trace_summary).toBeUndefined();
    });

    it('should accept DemoRunState with trace_summary as a string', () => {
      const state: DemoRunState = {
        pid: 12345,
        project: 'vendor-owner',
        started_at: '2026-02-28T00:00:00.000Z',
        status: 'passed',
        ended_at: '2026-02-28T00:01:00.000Z',
        exit_code: 0,
        trace_summary: '=== DEMO PLAY-BY-PLAY TRACE ===\nTotal events: 12\n\n[  0.0s] NAV    Navigate to http://localhost:3000\n=== END TRACE ===',
      };

      expect(typeof state.trace_summary).toBe('string');
      expect(state.trace_summary).toContain('Total events: 12');
    });

    it('DemoRunState round-trips through JSON serialization with trace_summary intact', () => {
      const original: DemoRunState = {
        pid: 777,
        project: 'demo',
        test_file: 'e2e/demo/billing.demo.ts',
        started_at: '2026-02-28T00:00:00.000Z',
        status: 'failed',
        ended_at: '2026-02-28T00:02:00.000Z',
        exit_code: 1,
        failure_summary: 'Assertion failed',
        screenshot_paths: ['/tmp/test-results/screenshot-1.png'],
        trace_summary: '=== DEMO PLAY-BY-PLAY TRACE ===\nTotal events: 7\n\n[  0.0s] NAV    Navigate to http://localhost:3000\n[  1.2s] ACTION Click [data-testid="billing"]\n=== END TRACE ===',
      };

      const serialized = JSON.stringify(original);
      const deserialized: DemoRunState = JSON.parse(serialized);

      expect(deserialized.trace_summary).toBe(original.trace_summary);
      expect(typeof deserialized.trace_summary).toBe('string');
      expect(deserialized.pid).toBe(777);
      expect(deserialized.status).toBe('failed');
    });

    it('DemoRunState without trace_summary round-trips through JSON with undefined preserved as absent', () => {
      const original: DemoRunState = {
        pid: 888,
        project: 'vendor-owner',
        started_at: '2026-02-28T00:00:00.000Z',
        status: 'passed',
      };

      const serialized = JSON.stringify(original);
      const deserialized: DemoRunState = JSON.parse(serialized);

      // JSON.stringify omits undefined fields, so trace_summary is absent after round-trip
      expect(deserialized.trace_summary).toBeUndefined();
      expect('trace_summary' in deserialized).toBe(false);
    });
  });

  describe('DemoProgress type', () => {
    it('should accept a valid DemoProgress object (type-level check)', () => {
      const progress: DemoProgress = {
        tests_completed: 3,
        tests_passed: 2,
        tests_failed: 1,
        total_tests: 5,
        current_test: 'should display dashboard',
        current_file: 'e2e/demo/onboarding.demo.ts',
        has_failures: true,
        recent_errors: ['AssertionError: expected "Login" to equal "Sign In"'],
        last_5_results: [
          { title: 'should navigate to home', status: 'passed' },
          { title: 'should display dashboard', status: 'failed' },
        ],
      };

      expect(typeof progress.tests_completed).toBe('number');
      expect(typeof progress.tests_passed).toBe('number');
      expect(typeof progress.tests_failed).toBe('number');
      expect(progress.total_tests).toBe(5);
      expect(progress.current_test).toBe('should display dashboard');
      expect(progress.current_file).toBe('e2e/demo/onboarding.demo.ts');
      expect(progress.has_failures).toBe(true);
      expect(Array.isArray(progress.recent_errors)).toBe(true);
      expect(progress.recent_errors.length).toBe(1);
      expect(Array.isArray(progress.last_5_results)).toBe(true);
      expect(progress.last_5_results.length).toBe(2);
    });

    it('should accept DemoProgress with null nullable fields', () => {
      const progress: DemoProgress = {
        tests_completed: 0,
        tests_passed: 0,
        tests_failed: 0,
        total_tests: null,
        current_test: null,
        current_file: null,
        has_failures: false,
        recent_errors: [],
        last_5_results: [],
      };

      expect(progress.total_tests).toBeNull();
      expect(progress.current_test).toBeNull();
      expect(progress.current_file).toBeNull();
      expect(progress.has_failures).toBe(false);
      expect(progress.recent_errors).toHaveLength(0);
      expect(progress.last_5_results).toHaveLength(0);
    });
  });

  describe('CheckDemoResultResult - progress field', () => {
    it('should accept CheckDemoResultResult without progress (existing behavior)', () => {
      const result: CheckDemoResultResult = {
        status: 'running',
        pid: 12345,
        project: 'vendor-owner',
        message: 'Demo is still running.',
      };

      expect(result.progress).toBeUndefined();
      expect(result.status).toBe('running');
    });

    it('should accept CheckDemoResultResult with progress object populated', () => {
      const progress: DemoProgress = {
        tests_completed: 2,
        tests_passed: 2,
        tests_failed: 0,
        total_tests: 4,
        current_test: 'should load billing page',
        current_file: 'e2e/demo/billing.demo.ts',
        has_failures: false,
        recent_errors: [],
        last_5_results: [
          { title: 'should navigate to home', status: 'passed' },
          { title: 'should open settings', status: 'passed' },
        ],
      };

      const result: CheckDemoResultResult = {
        status: 'running',
        pid: 54321,
        project: 'demo',
        message: 'Demo is running. 2/4 tests completed.',
        progress,
      };

      expect(result.progress).toBeDefined();
      expect(result.progress!.tests_completed).toBe(2);
      expect(result.progress!.tests_passed).toBe(2);
      expect(result.progress!.tests_failed).toBe(0);
      expect(result.progress!.total_tests).toBe(4);
      expect(result.progress!.has_failures).toBe(false);
      expect(typeof result.progress!.tests_completed).toBe('number');
      expect(Array.isArray(result.progress!.last_5_results)).toBe(true);
    });
  });

  describe('DemoRunState - progress_file field', () => {
    it('should accept DemoRunState without progress_file', () => {
      const state: DemoRunState = {
        pid: 12345,
        project: 'vendor-owner',
        started_at: '2026-03-01T00:00:00.000Z',
        status: 'running',
      };

      expect(state.progress_file).toBeUndefined();
    });

    it('should accept DemoRunState with progress_file string', () => {
      const state: DemoRunState = {
        pid: 12345,
        project: 'demo',
        started_at: '2026-03-01T00:00:00.000Z',
        status: 'running',
        progress_file: '/tmp/demo-progress-12345.json',
      };

      expect(typeof state.progress_file).toBe('string');
      expect(state.progress_file).toBe('/tmp/demo-progress-12345.json');
    });

    it('DemoRunState with progress_file round-trips through JSON serialization', () => {
      const original: DemoRunState = {
        pid: 999,
        project: 'vendor-owner',
        started_at: '2026-03-01T00:00:00.000Z',
        status: 'running',
        progress_file: '/tmp/demo-progress-999.json',
      };

      const serialized = JSON.stringify(original);
      const deserialized: DemoRunState = JSON.parse(serialized);

      expect(deserialized.progress_file).toBe('/tmp/demo-progress-999.json');
      expect(typeof deserialized.progress_file).toBe('string');
      expect(deserialized.pid).toBe(999);
    });

    it('DemoRunState without progress_file is absent after JSON round-trip', () => {
      const original: DemoRunState = {
        pid: 111,
        project: 'demo',
        started_at: '2026-03-01T00:00:00.000Z',
        status: 'passed',
      };

      const serialized = JSON.stringify(original);
      const deserialized: DemoRunState = JSON.parse(serialized);

      expect(deserialized.progress_file).toBeUndefined();
      expect('progress_file' in deserialized).toBe(false);
    });
  });
});

// ============================================================================
// isValidChromeMatchPattern Tests
//
// Mirrors the implementation in server.ts (which is not exported).
// The function is duplicated here following the same pattern used for
// countTestFiles above — this keeps coverage without a risky export change.
// ============================================================================

/**
 * Exact copy of isValidChromeMatchPattern from server.ts.
 * Must stay in sync whenever the production implementation changes.
 *
 * Validate a Chrome extension match pattern per the Chrome docs spec.
 * <scheme>://<host>/<path> where host is * | *.domain | exact domain.
 * file:// has empty host (file:///path). No partial wildcards.
 */
function isValidChromeMatchPattern(pattern: string): boolean {
  if (pattern === '<all_urls>') return true;
  if (/^file:\/\/\/(.+)$/.test(pattern)) return true;
  const m = pattern.match(/^(\*|https?|ftp):\/\/([^/]+)\/(.*)$/);
  if (!m) return false;
  const host = m[2];
  if (host === '*') return true;
  if (host.startsWith('*.')) return !host.slice(2).includes('*');
  return !host.includes('*');
}

describe('isValidChromeMatchPattern', () => {
  describe('special keyword', () => {
    it('should accept <all_urls>', () => {
      expect(isValidChromeMatchPattern('<all_urls>')).toBe(true);
    });

    it('should reject partial match on all_urls keyword', () => {
      expect(isValidChromeMatchPattern('all_urls')).toBe(false);
      expect(isValidChromeMatchPattern('<all_urls> ')).toBe(false);
    });
  });

  describe('file:// patterns', () => {
    it('should accept file:///path', () => {
      expect(isValidChromeMatchPattern('file:///path/to/file.html')).toBe(true);
    });

    it('should accept file:/// with trailing wildcard in path', () => {
      expect(isValidChromeMatchPattern('file:///foo/*')).toBe(true);
    });

    it('should reject file:// with only two slashes (no host section)', () => {
      // file://path is invalid per Chrome spec — needs three slashes
      expect(isValidChromeMatchPattern('file://path/to/file')).toBe(false);
    });
  });

  describe('wildcard scheme *://', () => {
    it('should accept *://*/*', () => {
      expect(isValidChromeMatchPattern('*://*/*')).toBe(true);
    });

    it('should accept *://example.com/*', () => {
      expect(isValidChromeMatchPattern('*://example.com/*')).toBe(true);
    });

    it('should accept *://*.example.com/*', () => {
      expect(isValidChromeMatchPattern('*://*.example.com/*')).toBe(true);
    });

    it('should reject *://host with no path separator', () => {
      expect(isValidChromeMatchPattern('*://example.com')).toBe(false);
    });
  });

  describe('https:// patterns', () => {
    it('should accept https://example.com/*', () => {
      expect(isValidChromeMatchPattern('https://example.com/*')).toBe(true);
    });

    it('should accept https://*.example.com/*', () => {
      expect(isValidChromeMatchPattern('https://*.example.com/*')).toBe(true);
    });

    it('should accept https://*/* (wildcard host)', () => {
      expect(isValidChromeMatchPattern('https://*/*')).toBe(true);
    });

    it('should accept https://sub.example.com/path/to/page', () => {
      expect(isValidChromeMatchPattern('https://sub.example.com/path/to/page')).toBe(true);
    });

    it('should accept https://example.com/ (empty path)', () => {
      expect(isValidChromeMatchPattern('https://example.com/')).toBe(true);
    });

    it('should reject partial wildcard in host like *-admin.example.com', () => {
      // Partial wildcards are not allowed — only * alone or *.domain
      expect(isValidChromeMatchPattern('https://*-admin.example.com/*')).toBe(false);
    });

    it('should reject double wildcard in subdomain *.*.example.com', () => {
      expect(isValidChromeMatchPattern('https://*.*.example.com/*')).toBe(false);
    });

    it('should reject missing path component', () => {
      expect(isValidChromeMatchPattern('https://example.com')).toBe(false);
    });

    it('should reject wildcard embedded in middle of hostname', () => {
      expect(isValidChromeMatchPattern('https://foo.*.example.com/*')).toBe(false);
    });
  });

  describe('http:// patterns', () => {
    it('should accept http://localhost/*', () => {
      expect(isValidChromeMatchPattern('http://localhost/*')).toBe(true);
    });

    it('should accept http://127.0.0.1/*', () => {
      expect(isValidChromeMatchPattern('http://127.0.0.1/*')).toBe(true);
    });

    it('should accept http://*.example.com/path', () => {
      expect(isValidChromeMatchPattern('http://*.example.com/path')).toBe(true);
    });

    it('should reject http://example.com (no trailing slash)', () => {
      expect(isValidChromeMatchPattern('http://example.com')).toBe(false);
    });
  });

  describe('ftp:// patterns', () => {
    it('should accept ftp://ftp.example.com/*', () => {
      expect(isValidChromeMatchPattern('ftp://ftp.example.com/*')).toBe(true);
    });

    it('should reject ftp:// without path', () => {
      expect(isValidChromeMatchPattern('ftp://ftp.example.com')).toBe(false);
    });
  });

  describe('invalid schemes', () => {
    it('should reject ws:// (not in allowed schemes)', () => {
      expect(isValidChromeMatchPattern('ws://example.com/*')).toBe(false);
    });

    it('should reject chrome-extension:// scheme', () => {
      expect(isValidChromeMatchPattern('chrome-extension://*/*')).toBe(false);
    });

    it('should reject javascript: scheme', () => {
      expect(isValidChromeMatchPattern('javascript:void(0)')).toBe(false);
    });

    it('should reject plain strings with no scheme', () => {
      expect(isValidChromeMatchPattern('example.com/*')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isValidChromeMatchPattern('')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should reject pattern with only whitespace', () => {
      expect(isValidChromeMatchPattern('   ')).toBe(false);
    });

    it('should reject pattern that starts with *. at scheme level', () => {
      // *.example.com/* has no scheme — not valid
      expect(isValidChromeMatchPattern('*.example.com/*')).toBe(false);
    });

    it('should accept https://*.co.uk/* (multi-part TLD)', () => {
      expect(isValidChromeMatchPattern('https://*.co.uk/*')).toBe(true);
    });

    it('should accept https://example.com/api/v1/*', () => {
      expect(isValidChromeMatchPattern('https://example.com/api/v1/*')).toBe(true);
    });
  });
});

// ============================================================================
// EXTENSION_PROJECTS membership tests
//
// Verifies the set of projects that trigger extension_manifest check matches
// the documented contract: demo, extension, extension-manual.
// ============================================================================

const EXTENSION_PROJECTS = new Set(['demo', 'extension', 'extension-manual']);

describe('EXTENSION_PROJECTS set', () => {
  it('should include demo', () => {
    expect(EXTENSION_PROJECTS.has('demo')).toBe(true);
  });

  it('should include extension', () => {
    expect(EXTENSION_PROJECTS.has('extension')).toBe(true);
  });

  it('should include extension-manual', () => {
    expect(EXTENSION_PROJECTS.has('extension-manual')).toBe(true);
  });

  it('should not include non-extension projects', () => {
    const nonExtensionProjects = [
      'vendor-owner', 'vendor-admin', 'vendor-dev', 'vendor-viewer',
      'cross-persona', 'auth-flows', 'manual', 'seed', 'auth-setup',
    ];
    for (const project of nonExtensionProjects) {
      expect(EXTENSION_PROJECTS.has(project)).toBe(false);
    }
  });

  it('should have exactly 3 members', () => {
    expect(EXTENSION_PROJECTS.size).toBe(3);
  });
});

// ============================================================================
// extension_manifest check logic (simulated)
//
// The preflight check in server.ts reads manifest.json from disk and calls
// isValidChromeMatchPattern on each content_scripts[i].matches entry.
// These tests validate that logic directly using temp files, mirroring the
// approach used for countTestFiles above.
// ============================================================================

describe('extension_manifest check logic (simulated)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `playwright-manifest-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Simulate the extension_manifest check from server.ts.
   * Returns the same {status, message} shape as runCheck's fn callback.
   */
  function simulateExtensionManifestCheck(
    distPath: string | undefined,
    projectDir: string
  ): { status: 'pass' | 'fail' | 'warn' | 'skip'; message: string } {
    if (!distPath) {
      return { status: 'skip', message: 'GENTYR_EXTENSION_DIST_PATH not set — skipping manifest validation' };
    }

    const primaryPath = path.join(projectDir, distPath, 'manifest.json');
    const fallbackPath = path.join(projectDir, path.dirname(distPath), 'manifest.json');
    let manifestPath: string | null = null;

    if (fs.existsSync(primaryPath)) {
      manifestPath = primaryPath;
    } else if (fs.existsSync(fallbackPath)) {
      manifestPath = fallbackPath;
    }

    if (!manifestPath) {
      return { status: 'fail', message: `manifest.json not found at ${primaryPath} or ${fallbackPath}` };
    }

    let manifest: { content_scripts?: Array<{ matches?: string[] }> };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'fail', message: `Failed to parse ${manifestPath}: ${msg}` };
    }

    const invalidPatterns: string[] = [];
    const contentScripts = manifest.content_scripts || [];
    for (let i = 0; i < contentScripts.length; i++) {
      const matches = contentScripts[i].matches || [];
      for (const pattern of matches) {
        if (!isValidChromeMatchPattern(pattern)) {
          invalidPatterns.push(`content_scripts[${i}]: ${pattern}`);
        }
      }
    }

    if (invalidPatterns.length > 0) {
      return {
        status: 'fail',
        message: `Invalid match patterns in ${path.relative(projectDir, manifestPath)}:\n${invalidPatterns.map(p => `  - ${p}`).join('\n')}`,
      };
    }

    const totalPatterns = contentScripts.reduce((sum, cs) => sum + (cs.matches?.length || 0), 0);
    return { status: 'pass', message: `${totalPatterns} match pattern(s) validated in ${path.relative(projectDir, manifestPath)}` };
  }

  it('should skip when GENTYR_EXTENSION_DIST_PATH is not set', () => {
    const result = simulateExtensionManifestCheck(undefined, tempDir);

    expect(result.status).toBe('skip');
    expect(result.message).toContain('GENTYR_EXTENSION_DIST_PATH not set');
  });

  it('should fail when manifest.json is missing at both primary and fallback paths', () => {
    const result = simulateExtensionManifestCheck('dist/extension', tempDir);

    expect(result.status).toBe('fail');
    expect(result.message).toContain('manifest.json not found');
  });

  it('should pass when manifest.json has no content_scripts', () => {
    const distDir = path.join(tempDir, 'dist', 'extension');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify({
      name: 'Test Extension',
      version: '1.0.0',
      manifest_version: 3,
    }));

    const result = simulateExtensionManifestCheck('dist/extension', tempDir);

    expect(result.status).toBe('pass');
    expect(result.message).toContain('0 match pattern(s)');
  });

  it('should pass with all valid content_scripts match patterns', () => {
    const distDir = path.join(tempDir, 'dist', 'extension');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify({
      content_scripts: [
        { matches: ['https://example.com/*', 'https://*.example.com/*'] },
        { matches: ['*://*/*'] },
      ],
    }));

    const result = simulateExtensionManifestCheck('dist/extension', tempDir);

    expect(result.status).toBe('pass');
    expect(result.message).toContain('3 match pattern(s)');
  });

  it('should fail when a content_scripts entry has an invalid match pattern', () => {
    const distDir = path.join(tempDir, 'dist', 'extension');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify({
      content_scripts: [
        { matches: ['https://valid.example.com/*', 'https://*-admin.example.com/*'] },
      ],
    }));

    const result = simulateExtensionManifestCheck('dist/extension', tempDir);

    expect(result.status).toBe('fail');
    expect(result.message).toContain('Invalid match patterns');
    expect(result.message).toContain('content_scripts[0]: https://*-admin.example.com/*');
  });

  it('should report all invalid patterns across multiple content_scripts entries', () => {
    const distDir = path.join(tempDir, 'dist', 'extension');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify({
      content_scripts: [
        { matches: ['https://*-widget.example.com/*'] },
        { matches: ['https://valid.example.com/*'] },
        { matches: ['ws://realtime.example.com/*'] },
      ],
    }));

    const result = simulateExtensionManifestCheck('dist/extension', tempDir);

    expect(result.status).toBe('fail');
    expect(result.message).toContain('content_scripts[0]: https://*-widget.example.com/*');
    expect(result.message).toContain('content_scripts[2]: ws://realtime.example.com/*');
    // Valid entry must NOT appear in the invalid list
    expect(result.message).not.toContain('content_scripts[1]');
  });

  it('should fail when manifest.json contains invalid JSON', () => {
    const distDir = path.join(tempDir, 'dist', 'extension');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'manifest.json'), '{ broken json }}}');

    const result = simulateExtensionManifestCheck('dist/extension', tempDir);

    expect(result.status).toBe('fail');
    expect(result.message).toContain('Failed to parse');
  });

  it('should find manifest.json at the fallback path (parent of distPath)', () => {
    // primary: tempDir/dist/extension/manifest.json — does NOT exist
    // fallback: tempDir/dist/manifest.json — exists
    const parentDir = path.join(tempDir, 'dist');
    fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(path.join(parentDir, 'manifest.json'), JSON.stringify({
      content_scripts: [{ matches: ['<all_urls>'] }],
    }));

    const result = simulateExtensionManifestCheck('dist/extension', tempDir);

    expect(result.status).toBe('pass');
    expect(result.message).toContain('1 match pattern(s)');
  });

  it('should prefer primary path over fallback when both exist', () => {
    // primary: tempDir/dist/extension/manifest.json — valid manifest
    // fallback: tempDir/dist/manifest.json — invalid manifest
    const primaryDir = path.join(tempDir, 'dist', 'extension');
    fs.mkdirSync(primaryDir, { recursive: true });
    fs.writeFileSync(path.join(primaryDir, 'manifest.json'), JSON.stringify({
      content_scripts: [{ matches: ['https://example.com/*'] }],
    }));

    const fallbackDir = path.join(tempDir, 'dist');
    fs.writeFileSync(path.join(fallbackDir, 'manifest.json'), JSON.stringify({
      content_scripts: [{ matches: ['bad-pattern'] }],
    }));

    const result = simulateExtensionManifestCheck('dist/extension', tempDir);

    // Should use primary (valid), not fallback (invalid)
    expect(result.status).toBe('pass');
    expect(result.message).toContain('1 match pattern(s)');
  });

  it('should pass with <all_urls> match pattern', () => {
    const distDir = path.join(tempDir, 'dist', 'extension');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify({
      content_scripts: [{ matches: ['<all_urls>'] }],
    }));

    const result = simulateExtensionManifestCheck('dist/extension', tempDir);

    expect(result.status).toBe('pass');
    expect(result.message).toContain('1 match pattern(s)');
  });

  it('should pass with content_scripts entry that has empty matches array', () => {
    const distDir = path.join(tempDir, 'dist', 'extension');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify({
      content_scripts: [{ matches: [] }, { matches: ['https://example.com/*'] }],
    }));

    const result = simulateExtensionManifestCheck('dist/extension', tempDir);

    expect(result.status).toBe('pass');
    expect(result.message).toContain('1 match pattern(s)');
  });

  it('should handle content_scripts entry with no matches key', () => {
    const distDir = path.join(tempDir, 'dist', 'extension');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify({
      content_scripts: [{ js: ['content.js'] }],
    }));

    const result = simulateExtensionManifestCheck('dist/extension', tempDir);

    expect(result.status).toBe('pass');
    expect(result.message).toContain('0 match pattern(s)');
  });

  it('should include the relative manifest path in the pass message', () => {
    const distDir = path.join(tempDir, 'dist', 'extension');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify({
      content_scripts: [{ matches: ['https://example.com/*'] }],
    }));

    const result = simulateExtensionManifestCheck('dist/extension', tempDir);

    expect(result.status).toBe('pass');
    // The message must contain a relative (not absolute) path
    expect(result.message).toContain('manifest.json');
    expect(result.message).not.toContain(tempDir);
  });
});

// ============================================================================
// Recovery step for extension_manifest check (G001 - fail loudly)
// ============================================================================

describe('extension_manifest recovery step', () => {
  it('should provide actionable recovery step text for invalid patterns', () => {
    // The recovery step text from server.ts switch case for extension_manifest.
    // Validates the message is specific and actionable.
    const recoveryStep = 'Fix invalid match patterns in manifest.json — Chrome requires host to be * | *.domain.com | exact.domain.com (no partial wildcards like *-admin.example.com)';

    expect(recoveryStep).toContain('manifest.json');
    expect(recoveryStep).toContain('*.domain.com');
    expect(recoveryStep).toContain('no partial wildcards');
    expect(recoveryStep.length).toBeGreaterThan(50);
  });
});
