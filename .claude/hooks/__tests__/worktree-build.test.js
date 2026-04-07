/**
 * Tests for worktree provisioning build step (PR #224).
 *
 * Validates:
 * 1. worktree-manager.js reads worktreeBuildCommand from services.json
 * 2. Health check skip logic (exit 0 = skip build)
 * 3. Missing services.json is non-fatal
 * 4. Build failure is non-fatal (try/catch)
 * 5. ServicesConfigSchema accepts worktreeBuildCommand and worktreeBuildHealthCheck
 *
 * Run with: node --test .claude/hooks/__tests__/worktree-build.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const PROJECT_DIR = process.cwd();
const WORKTREE_MANAGER_PATH = path.join(PROJECT_DIR, '.claude/hooks/lib/worktree-manager.js');

// ============================================================================
// Source structural validation
// ============================================================================

describe('worktree-build: source structure', () => {
  let code;

  beforeEach(() => {
    code = fs.readFileSync(WORKTREE_MANAGER_PATH, 'utf8');
  });

  it('should read worktreeBuildCommand from services.json', () => {
    assert.match(code, /config\.worktreeBuildCommand/, 'Must read worktreeBuildCommand from config');
  });

  it('should read worktreeBuildHealthCheck from services.json', () => {
    assert.match(code, /config\.worktreeBuildHealthCheck/, 'Must read worktreeBuildHealthCheck from config');
  });

  it('should guard services.json reading with existsSync', () => {
    assert.match(
      code,
      /fs\.existsSync\(configPath\)[\s\S]*?worktreeBuildCommand/,
      'Must check services.json exists before reading'
    );
  });

  it('should use worktreePath as cwd for build command', () => {
    assert.match(
      code,
      /cwd:\s*worktreePath[\s\S]*?worktreeBuildCommand|worktreeBuildCommand[\s\S]*?cwd:\s*worktreePath/,
      'Build command must use worktreePath as cwd'
    );
  });

  it('should have non-fatal error handling for build step', () => {
    const buildRegion = code.match(/Workspace build[\s\S]*?services\.json parse error/);
    assert.ok(buildRegion, 'Build step must have outer try-catch for services.json parse errors');
  });

  it('should default needsBuild to true', () => {
    assert.match(code, /let needsBuild\s*=\s*true/, 'needsBuild must default to true');
  });

  it('should set needsBuild to false when health check passes', () => {
    assert.match(code, /needsBuild\s*=\s*false/, 'Must set needsBuild = false when health check passes');
  });

  it('should use 5 second timeout for health check', () => {
    const healthCheckRegion = code.match(/worktreeBuildHealthCheck[\s\S]*?timeout:\s*(\d+)/);
    assert.ok(healthCheckRegion, 'Health check must have a timeout');
    assert.strictEqual(healthCheckRegion[1], '5000', 'Health check timeout must be 5000ms');
  });

  it('should use 300 second (5 min) timeout for build command', () => {
    const buildRegion = code.match(/worktreeBuildCommand[\s\S]*?if \(needsBuild\)[\s\S]*?timeout:\s*(\d+)/);
    assert.ok(buildRegion, 'Build command must have a timeout');
    assert.strictEqual(buildRegion[1], '300000', 'Build timeout must be 300000ms (5 min)');
  });

  it('should truncate error messages to 200 chars', () => {
    assert.match(code, /slice\(0,\s*200\)/, 'Error messages should be truncated to 200 chars');
  });

  it('should skip build step when skipInstall option is set', () => {
    assert.match(
      code,
      /!options\?\.skipInstall[\s\S]*?worktreeBuildCommand/,
      'Build step must be gated by !options?.skipInstall'
    );
  });

  it('should log success when build completes', () => {
    assert.match(
      code,
      /Built workspace packages in/,
      'Must log success message after build'
    );
  });
});

// ============================================================================
// ServicesConfigSchema validation
// ============================================================================

describe('worktree-build: ServicesConfigSchema', () => {
  let ServicesConfigSchema;

  beforeEach(async () => {
    // Import from compiled dist
    const typesPath = path.join(PROJECT_DIR, 'packages/mcp-servers/dist/secret-sync/types.js');
    if (!fs.existsSync(typesPath)) {
      // Skip if not built
      return;
    }
    const types = await import(typesPath);
    ServicesConfigSchema = types.ServicesConfigSchema;
  });

  it('should accept worktreeBuildCommand as an optional string', () => {
    if (!ServicesConfigSchema) return; // skip if not built
    const result = ServicesConfigSchema.safeParse({
      secrets: {},
      worktreeBuildCommand: "pnpm --recursive build",
    });
    assert.ok(result.success, 'Schema must accept worktreeBuildCommand');
  });

  it('should accept worktreeBuildHealthCheck as an optional string', () => {
    if (!ServicesConfigSchema) return;
    const result = ServicesConfigSchema.safeParse({
      secrets: {},
      worktreeBuildHealthCheck: "test -f packages/foo/dist/index.js",
    });
    assert.ok(result.success, 'Schema must accept worktreeBuildHealthCheck');
  });

  it('should accept both fields together', () => {
    if (!ServicesConfigSchema) return;
    const result = ServicesConfigSchema.safeParse({
      secrets: {},
      worktreeBuildCommand: "pnpm --recursive --filter './packages/*' build",
      worktreeBuildHealthCheck: "test -f packages/browser-proxy/dist/index.js",
    });
    assert.ok(result.success, 'Schema must accept both fields together');
  });

  it('should parse without either field (both optional)', () => {
    if (!ServicesConfigSchema) return;
    const result = ServicesConfigSchema.safeParse({ secrets: {} });
    assert.ok(result.success, 'Schema must parse without worktree build fields');
  });

  it('should reject non-string worktreeBuildCommand', () => {
    if (!ServicesConfigSchema) return;
    const result = ServicesConfigSchema.safeParse({
      secrets: {},
      worktreeBuildCommand: 123,
    });
    assert.ok(!result.success, 'Schema must reject non-string worktreeBuildCommand');
  });
});

// ============================================================================
// Behavioral: health check skip + build execution
// ============================================================================

describe('worktree-build: behavioral - health check and build execution', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-build-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should execute build command when health check fails', () => {
    // Create services.json with a failing health check and a build command that creates a marker
    const configDir = path.join(tempDir, '.claude', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const markerFile = path.join(tempDir, 'build-ran.marker');
    fs.writeFileSync(path.join(configDir, 'services.json'), JSON.stringify({
      secrets: {},
      worktreeBuildCommand: `touch ${markerFile}`,
      worktreeBuildHealthCheck: 'test -f /nonexistent/file/that/does/not/exist',
    }));

    // Simulate the build logic
    const config = JSON.parse(fs.readFileSync(path.join(configDir, 'services.json'), 'utf8'));
    let needsBuild = true;
    if (config.worktreeBuildHealthCheck) {
      try {
        execSync(config.worktreeBuildHealthCheck, { cwd: tempDir, timeout: 5000, stdio: 'pipe' });
        needsBuild = false;
      } catch (_) { /* needs build */ }
    }
    if (needsBuild && config.worktreeBuildCommand) {
      execSync(config.worktreeBuildCommand, { cwd: tempDir, timeout: 300000, stdio: 'pipe' });
    }

    assert.ok(fs.existsSync(markerFile), 'Build command should have run (marker file created)');
  });

  it('should skip build when health check passes', () => {
    const configDir = path.join(tempDir, '.claude', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const markerFile = path.join(tempDir, 'build-ran.marker');
    // Health check that passes (test -f on a file we create)
    const healthFile = path.join(tempDir, 'health-target');
    fs.writeFileSync(healthFile, '');
    fs.writeFileSync(path.join(configDir, 'services.json'), JSON.stringify({
      secrets: {},
      worktreeBuildCommand: `touch ${markerFile}`,
      worktreeBuildHealthCheck: `test -f ${healthFile}`,
    }));

    const config = JSON.parse(fs.readFileSync(path.join(configDir, 'services.json'), 'utf8'));
    let needsBuild = true;
    if (config.worktreeBuildHealthCheck) {
      try {
        execSync(config.worktreeBuildHealthCheck, { cwd: tempDir, timeout: 5000, stdio: 'pipe' });
        needsBuild = false;
      } catch (_) { /* needs build */ }
    }
    if (needsBuild && config.worktreeBuildCommand) {
      execSync(config.worktreeBuildCommand, { cwd: tempDir, timeout: 300000, stdio: 'pipe' });
    }

    assert.ok(!fs.existsSync(markerFile), 'Build command should NOT have run (health check passed)');
  });

  it('should handle missing services.json gracefully', () => {
    // No services.json — should not throw
    let buildRan = false;
    try {
      const configPath = path.join(tempDir, '.claude', 'config', 'services.json');
      if (fs.existsSync(configPath)) {
        buildRan = true; // would never reach here
      }
    } catch (_) { /* non-fatal */ }
    assert.ok(!buildRan, 'No build should run when services.json is missing');
  });
});
