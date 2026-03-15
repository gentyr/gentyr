/**
 * G011 Idempotency Tests for Specs Browser MCP Server
 *
 * Tests that create_spec and create_suite return existing resources with
 * `deduplicated: true` instead of throwing on duplicate IDs (G011 compliance).
 *
 * These tests call the REAL handler implementations exported from server.ts
 * using dynamic import (to ensure CLAUDE_PROJECT_DIR is set first and
 * MCP_SHARED_DAEMON prevents server.start() from calling process.exit).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { CreateSpecResult, CreateSuiteResult } from '../types.js';

// ============================================================================
// Type for the tools handler lookup
// ============================================================================

type HandlerFn = (args: Record<string, unknown>) => unknown;

interface Tool {
  name: string;
  handler: HandlerFn;
}

// ============================================================================
// Test helpers
// ============================================================================

function getHandler(tools: Tool[], name: string): HandlerFn {
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    throw new Error(
      `CRITICAL: Tool not found: "${name}". Available tools: ${tools.map(t => t.name).join(', ')}`
    );
  }
  return tool.handler;
}

// ============================================================================
// Top-level test suite — one isolated module load per describe block
// ============================================================================

describe('G011 Idempotency: create_spec', () => {
  const TEST_PROJECT_DIR = path.join(os.tmpdir(), `specs-g011-spec-${randomUUID()}`);
  const SPECS_DIR = path.join(TEST_PROJECT_DIR, 'specs');
  const HOOKS_DIR = path.join(TEST_PROJECT_DIR, '.claude', 'hooks');

  let createSpec: HandlerFn;

  beforeAll(async () => {
    // Create required directory structure
    fs.mkdirSync(path.join(SPECS_DIR, 'global'), { recursive: true });
    fs.mkdirSync(path.join(SPECS_DIR, 'local'), { recursive: true });
    fs.mkdirSync(path.join(SPECS_DIR, 'reference'), { recursive: true });
    fs.mkdirSync(HOOKS_DIR, { recursive: true });

    // Set env vars BEFORE dynamic import so module-level constants resolve correctly
    process.env.CLAUDE_PROJECT_DIR = TEST_PROJECT_DIR;
    process.env.MCP_SHARED_DAEMON = '1';

    // Reset modules cache so server.ts is freshly loaded with the new env
    vi.resetModules();

    // Dynamic import after env is set
    const { tools } = await import('../server.js');
    createSpec = getHandler(tools as Tool[], 'create_spec');
  });

  afterAll(() => {
    if (fs.existsSync(TEST_PROJECT_DIR)) {
      fs.rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
    }
  });

  it('should create a spec file on first call and return success without deduplicated flag', () => {
    const result = createSpec({
      spec_id: 'G011-TEST-FIRST',
      category: 'global',
      title: 'G011 First Create Test',
      content: 'Initial content for G011 test.',
    }) as CreateSpecResult;

    expect(result.success).toBe(true);
    expect(typeof result.file).toBe('string');
    expect(result.file).toContain('G011-TEST-FIRST.md');
    // First creation must NOT set deduplicated
    expect(result.deduplicated).toBeUndefined();

    // File must actually exist on disk
    const filepath = path.join(TEST_PROJECT_DIR, result.file);
    expect(fs.existsSync(filepath)).toBe(true);
  });

  it('should return deduplicated: true when called again with the same spec_id', () => {
    const spec_id = 'G011-TEST-DEDUP';
    const args = {
      spec_id,
      category: 'global',
      title: 'G011 Dedup Test',
      content: 'Content for dedup test.',
    };

    // First call — creates the file
    const first = createSpec(args) as CreateSpecResult;
    expect(first.success).toBe(true);
    expect(first.deduplicated).toBeUndefined();

    // Second call — must NOT throw and must return deduplicated: true
    const second = createSpec(args) as CreateSpecResult;

    expect(second.success).toBe(true);
    expect(second.deduplicated).toBe(true);
    expect(typeof second.file).toBe('string');
    expect(second.file).toContain(`${spec_id}.md`);
  });

  it('should return the same file path on both calls (idempotent path)', () => {
    const args = {
      spec_id: 'G011-TEST-SAME-PATH',
      category: 'global',
      title: 'G011 Same Path Test',
      content: 'Content to check path consistency.',
    };

    const first = createSpec(args) as CreateSpecResult;
    const second = createSpec(args) as CreateSpecResult;

    expect(first.file).toBe(second.file);
  });

  it('should NOT overwrite the original file content on duplicate call', () => {
    const spec_id = 'G011-TEST-NO-OVERWRITE';
    const originalContent = 'Original content that must be preserved.';
    const args = {
      spec_id,
      category: 'global',
      title: 'Original Title',
      content: originalContent,
    };

    // First call — writes the file
    const first = createSpec(args) as CreateSpecResult;
    expect(first.success).toBe(true);
    expect(first.deduplicated).toBeUndefined();

    const filepath = path.join(TEST_PROJECT_DIR, first.file);
    expect(fs.existsSync(filepath)).toBe(true);

    const contentAfterFirst = fs.readFileSync(filepath, 'utf8');
    expect(contentAfterFirst).toContain(originalContent);

    // Second call with different content — must NOT overwrite
    const second = createSpec({
      ...args,
      title: 'Attempted Overwrite Title',
      content: 'Attempted replacement content.',
    }) as CreateSpecResult;

    expect(second.success).toBe(true);
    expect(second.deduplicated).toBe(true);

    const contentAfterSecond = fs.readFileSync(filepath, 'utf8');
    expect(contentAfterSecond).toBe(contentAfterFirst);
    expect(contentAfterSecond).toContain(originalContent);
    expect(contentAfterSecond).not.toContain('Attempted replacement content.');
  });

  it('should succeed on a third or further duplicate call (fully idempotent)', () => {
    const args = {
      spec_id: 'G011-TEST-MULTI-CALL',
      category: 'global',
      title: 'G011 Multi Call Test',
      content: 'Multi call test content.',
    };

    const first = createSpec(args) as CreateSpecResult;
    const second = createSpec(args) as CreateSpecResult;
    const third = createSpec(args) as CreateSpecResult;

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(third.success).toBe(true);

    expect(second.deduplicated).toBe(true);
    expect(third.deduplicated).toBe(true);
  });

  it('should create distinct specs for different spec_ids (no false positives)', () => {
    const firstResult = createSpec({
      spec_id: 'G011-DISTINCT-A',
      category: 'global',
      title: 'Distinct A',
      content: 'Content A.',
    }) as CreateSpecResult;

    const secondResult = createSpec({
      spec_id: 'G011-DISTINCT-B',
      category: 'global',
      title: 'Distinct B',
      content: 'Content B.',
    }) as CreateSpecResult;

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    // Both are new — neither should be deduplicated
    expect(firstResult.deduplicated).toBeUndefined();
    expect(secondResult.deduplicated).toBeUndefined();
    expect(firstResult.file).not.toBe(secondResult.file);
  });

  it('should create distinct specs for the same ID in different categories (no cross-category dedup)', () => {
    const spec_id = 'G011-CROSS-CAT';

    const globalResult = createSpec({
      spec_id,
      category: 'global',
      title: 'Global Version',
      content: 'Global content.',
    }) as CreateSpecResult;

    const localResult = createSpec({
      spec_id,
      category: 'local',
      title: 'Local Version',
      content: 'Local content.',
    }) as CreateSpecResult;

    expect(globalResult.success).toBe(true);
    expect(localResult.success).toBe(true);
    // Different directories — neither is a duplicate of the other
    expect(globalResult.deduplicated).toBeUndefined();
    expect(localResult.deduplicated).toBeUndefined();
    expect(globalResult.file).not.toBe(localResult.file);
  });
});

// ============================================================================
// G011 Tests: create_suite idempotency
// Uses a separate temp dir and a second vi.resetModules() + dynamic import
// so the module resolves to the correct PROJECT_DIR for this describe block.
// ============================================================================

describe('G011 Idempotency: create_suite', () => {
  const TEST_PROJECT_DIR = path.join(os.tmpdir(), `specs-g011-suite-${randomUUID()}`);
  const SPECS_DIR = path.join(TEST_PROJECT_DIR, 'specs');
  const HOOKS_DIR = path.join(TEST_PROJECT_DIR, '.claude', 'hooks');
  const SUITES_CONFIG_PATH = path.join(HOOKS_DIR, 'suites-config.json');

  let createSuite: HandlerFn;

  beforeAll(async () => {
    // Create required directory structure
    fs.mkdirSync(path.join(SPECS_DIR, 'global'), { recursive: true });
    fs.mkdirSync(path.join(SPECS_DIR, 'local'), { recursive: true });
    fs.mkdirSync(path.join(SPECS_DIR, 'reference'), { recursive: true });
    fs.mkdirSync(HOOKS_DIR, { recursive: true });

    // Set env vars BEFORE dynamic import
    process.env.CLAUDE_PROJECT_DIR = TEST_PROJECT_DIR;
    process.env.MCP_SHARED_DAEMON = '1';

    // Reset modules so server.ts is freshly loaded with the new PROJECT_DIR
    vi.resetModules();

    const { tools } = await import('../server.js');
    createSuite = getHandler(tools as Tool[], 'create_suite');
  });

  afterAll(() => {
    if (fs.existsSync(TEST_PROJECT_DIR)) {
      fs.rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
    }
  });

  it('should create a suite on first call and return success without deduplicated flag', () => {
    const result = createSuite({
      suite_id: 'g011-first-suite',
      description: 'First suite for G011 test',
      scope: 'src/first/**',
    }) as CreateSuiteResult;

    expect(result.success).toBe(true);
    expect(result.suite_id).toBe('g011-first-suite');
    // First creation must NOT set deduplicated
    expect(result.deduplicated).toBeUndefined();

    // Suite must be persisted in config
    expect(fs.existsSync(SUITES_CONFIG_PATH)).toBe(true);
    const config = JSON.parse(fs.readFileSync(SUITES_CONFIG_PATH, 'utf8'));
    expect(config.suites['g011-first-suite']).toBeDefined();
  });

  it('should return deduplicated: true when called again with the same suite_id', () => {
    const args = {
      suite_id: 'g011-dedup-suite',
      description: 'Dedup suite for G011 test',
      scope: 'src/dedup/**',
    };

    // First call — creates the suite
    const first = createSuite(args) as CreateSuiteResult;
    expect(first.success).toBe(true);
    expect(first.deduplicated).toBeUndefined();

    // Second call — must NOT throw and must return deduplicated: true
    const second = createSuite(args) as CreateSuiteResult;

    expect(second.success).toBe(true);
    expect(second.deduplicated).toBe(true);
    expect(second.suite_id).toBe('g011-dedup-suite');
  });

  it('should return the same suite_id on both calls (idempotent ID)', () => {
    const args = {
      suite_id: 'g011-same-id-suite',
      description: 'Same ID suite test',
      scope: 'src/sameid/**',
    };

    const first = createSuite(args) as CreateSuiteResult;
    const second = createSuite(args) as CreateSuiteResult;

    expect(first.suite_id).toBe(second.suite_id);
    expect(second.suite_id).toBe('g011-same-id-suite');
  });

  it('should NOT overwrite the original suite config on duplicate call', () => {
    const suite_id = 'g011-no-overwrite-suite';

    // First call — creates the suite with original description
    const first = createSuite({
      suite_id,
      description: 'Original description',
      scope: 'src/nooverwrite/**',
    }) as CreateSuiteResult;

    expect(first.success).toBe(true);
    expect(first.deduplicated).toBeUndefined();

    const configAfterFirst = JSON.parse(fs.readFileSync(SUITES_CONFIG_PATH, 'utf8'));
    const originalSuite = { ...configAfterFirst.suites[suite_id] };

    // Second call with different description — must return deduplicated and NOT overwrite
    const second = createSuite({
      suite_id,
      description: 'Attempted overwrite description',
      scope: 'src/different/**',
    }) as CreateSuiteResult;

    expect(second.success).toBe(true);
    expect(second.deduplicated).toBe(true);

    const configAfterSecond = JSON.parse(fs.readFileSync(SUITES_CONFIG_PATH, 'utf8'));
    const suiteAfterSecond = configAfterSecond.suites[suite_id];

    expect(suiteAfterSecond.description).toBe(originalSuite.description);
    expect(suiteAfterSecond.scope).toBe(originalSuite.scope);
    expect(suiteAfterSecond.description).not.toBe('Attempted overwrite description');
  });

  it('should succeed on a third or further duplicate call (fully idempotent)', () => {
    const args = {
      suite_id: 'g011-multi-call-suite',
      description: 'Multi call suite',
      scope: 'src/multi/**',
    };

    const first = createSuite(args) as CreateSuiteResult;
    const second = createSuite(args) as CreateSuiteResult;
    const third = createSuite(args) as CreateSuiteResult;

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(third.success).toBe(true);

    expect(second.deduplicated).toBe(true);
    expect(third.deduplicated).toBe(true);
  });

  it('should create distinct suites for different suite_ids (no false positives)', () => {
    const firstResult = createSuite({
      suite_id: 'g011-distinct-suite-a',
      description: 'Suite A',
      scope: 'src/a/**',
    }) as CreateSuiteResult;

    const secondResult = createSuite({
      suite_id: 'g011-distinct-suite-b',
      description: 'Suite B',
      scope: 'src/b/**',
    }) as CreateSuiteResult;

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    // Both are new — neither should be deduplicated
    expect(firstResult.deduplicated).toBeUndefined();
    expect(secondResult.deduplicated).toBeUndefined();
    expect(firstResult.suite_id).not.toBe(secondResult.suite_id);
  });
});
