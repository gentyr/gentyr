/**
 * Unit tests for Playwright Health Check SessionStart hook
 *
 * Tests that the hook correctly detects auth staleness, cookie expiry,
 * and writes playwright-health.json when playwright.config.ts is present.
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/playwright-health-check.test.js
 *
 * @version 1.0.0
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOOK_PATH = path.resolve(process.cwd(), '.claude/hooks/playwright-health-check.js');

/**
 * Run the hook with a given project directory and env vars.
 * Returns { exitCode, stdout, stderr, healthJson }.
 */
function runHook(projectDir, extraEnv = {}) {
  try {
    const result = execFileSync('node', [HOOK_PATH], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        ...extraEnv,
      },
    });
    const healthFile = path.join(projectDir, '.claude', 'playwright-health.json');
    const healthJson = fs.existsSync(healthFile)
      ? JSON.parse(fs.readFileSync(healthFile, 'utf-8'))
      : null;
    return { exitCode: 0, stdout: result, stderr: '', healthJson };
  } catch (err) {
    const healthFile = path.join(projectDir, '.claude', 'playwright-health.json');
    const healthJson = fs.existsSync(healthFile)
      ? JSON.parse(fs.readFileSync(healthFile, 'utf-8'))
      : null;
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      healthJson,
    };
  }
}

describe('playwright-health-check hook', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-health-test-'));
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should exit 0 and not write health file when no playwright.config.ts', () => {
    const { exitCode, healthJson } = runHook(tmpDir);
    assert.strictEqual(exitCode, 0, 'should exit cleanly');
    assert.strictEqual(healthJson, null, 'should not write health file without playwright.config.ts');
  });

  it('should write playwright-health.json when playwright.config.ts exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.ts'), '// config');
    const { exitCode, healthJson } = runHook(tmpDir);
    assert.strictEqual(exitCode, 0, 'should exit cleanly');
    assert.ok(healthJson, 'should write health file');
    assert.ok(healthJson.checkedAt, 'should have checkedAt timestamp');
    assert.ok('authState' in healthJson, 'should have authState');
    assert.ok('extensionBuilt' in healthJson, 'should have extensionBuilt');
    assert.ok('needsRepair' in healthJson, 'should have needsRepair');
  });

  it('should report authState.exists=false when .auth/vendor-owner.json is missing', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.ts'), '// config');
    const { healthJson } = runHook(tmpDir);
    assert.strictEqual(healthJson.authState.exists, false);
    assert.strictEqual(healthJson.authState.isStale, true);
    assert.strictEqual(healthJson.needsRepair, true);
  });

  it('should report authState.isStale=false for fresh auth files (1h old)', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.ts'), '// config');
    fs.mkdirSync(path.join(tmpDir, '.auth'), { recursive: true });

    // Write a valid auth file with non-expired cookies
    const futureExpiry = Math.floor(Date.now() / 1000) + 86400; // expires tomorrow
    const authState = {
      cookies: [{ name: 'sb-access-token', expires: futureExpiry }],
      origins: [],
    };
    fs.writeFileSync(path.join(tmpDir, '.auth', 'vendor-owner.json'), JSON.stringify(authState));

    // Set mtime to 1 hour ago
    const oneHourAgo = new Date(Date.now() - 3600_000);
    fs.utimesSync(path.join(tmpDir, '.auth', 'vendor-owner.json'), oneHourAgo, oneHourAgo);

    const { healthJson } = runHook(tmpDir);
    assert.strictEqual(healthJson.authState.exists, true);
    assert.strictEqual(healthJson.authState.isStale, false);
    assert.strictEqual(healthJson.authState.cookiesExpired, false);
    assert.ok(healthJson.authState.ageHours >= 0.9 && healthJson.authState.ageHours <= 1.1, 'age should be ~1h');
  });

  it('should report authState.isStale=true for stale auth files (>24h old)', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.ts'), '// config');
    fs.mkdirSync(path.join(tmpDir, '.auth'), { recursive: true });

    const futureExpiry = Math.floor(Date.now() / 1000) + 86400;
    const authState = { cookies: [{ name: 'sb', expires: futureExpiry }], origins: [] };
    fs.writeFileSync(path.join(tmpDir, '.auth', 'vendor-owner.json'), JSON.stringify(authState));

    // Set mtime to 25 hours ago
    const staleTime = new Date(Date.now() - 25 * 3600_000);
    fs.utimesSync(path.join(tmpDir, '.auth', 'vendor-owner.json'), staleTime, staleTime);

    const { healthJson } = runHook(tmpDir);
    assert.strictEqual(healthJson.authState.isStale, true);
    assert.strictEqual(healthJson.needsRepair, true);
  });

  it('should detect expired cookies as stale', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.ts'), '// config');
    fs.mkdirSync(path.join(tmpDir, '.auth'), { recursive: true });

    // Cookie expired 1 hour ago
    const pastExpiry = Math.floor(Date.now() / 1000) - 3600;
    const authState = { cookies: [{ name: 'sb-access-token', expires: pastExpiry }], origins: [] };
    fs.writeFileSync(path.join(tmpDir, '.auth', 'vendor-owner.json'), JSON.stringify(authState));

    const { healthJson } = runHook(tmpDir);
    assert.strictEqual(healthJson.authState.exists, true);
    assert.strictEqual(healthJson.authState.cookiesExpired, true);
    assert.strictEqual(healthJson.authState.isStale, true);
    assert.strictEqual(healthJson.needsRepair, true);
  });

  it('should skip execution when CLAUDE_SPAWNED_SESSION=true', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.ts'), '// config');
    const { exitCode, healthJson } = runHook(tmpDir, { CLAUDE_SPAWNED_SESSION: 'true' });
    assert.strictEqual(exitCode, 0, 'should exit cleanly');
    assert.strictEqual(healthJson, null, 'should not write health file for spawned sessions');
  });

  it('should set extensionBuilt=false when extension dist dir is missing', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.ts'), '// config');
    const { healthJson } = runHook(tmpDir);
    assert.strictEqual(healthJson.extensionBuilt, false);
  });
});
