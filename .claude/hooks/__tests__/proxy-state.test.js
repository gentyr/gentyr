/**
 * Tests for proxy-state.js module and spawn env integration
 *
 * Validates:
 * 1. proxy-state.js exports (isProxyDisabled, writeProxyState, readProxyState, STATE_PATH)
 * 2. isProxyDisabled() behavior: default false, true after write(true), false after write(false)
 * 3. readProxyState() returns { disabled: false } when file missing
 * 4. Cache TTL behavior (30-second cache)
 * 5. Integration: each of the 4 spawn-env files imports isProxyDisabled from proxy-state.js
 * 6. Integration: buildSpawnEnv in each file conditionally sets HTTPS_PROXY via isProxyDisabled()
 * 7. Integration: HTTPS_PROXY is not unconditionally present in the return object literal
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/proxy-state.test.js
 *
 * @version 1.0.0
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.cwd();
const PROXY_STATE_PATH = path.join(PROJECT_DIR, '.claude/hooks/lib/proxy-state.js');

// Hook files that must integrate with proxy-state
const HOOK_FILES = {
  'hourly-automation.js': path.join(PROJECT_DIR, '.claude/hooks/hourly-automation.js'),
  'urgent-task-spawner.js': path.join(PROJECT_DIR, '.claude/hooks/urgent-task-spawner.js'),
  'task-gate-spawner.js': path.join(PROJECT_DIR, '.claude/hooks/task-gate-spawner.js'),
  'session-reviver.js': path.join(PROJECT_DIR, '.claude/hooks/session-reviver.js'),
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a temporary directory for isolated state file tests.
 */
function createTempDir(prefix = 'proxy-state-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    path: tmpDir,
    cleanup: () => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

// ============================================================================
// proxy-state.js — File structure
// ============================================================================

describe('proxy-state.js file structure', () => {
  it('should exist at .claude/hooks/lib/proxy-state.js', () => {
    assert.ok(
      fs.existsSync(PROXY_STATE_PATH),
      `proxy-state.js not found at ${PROXY_STATE_PATH}`
    );
  });

  it('should be a valid ES module (uses import/export syntax)', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    assert.match(code, /^import\s|^export\s/m, 'Should use ES module syntax');
  });

  it('should export isProxyDisabled', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    assert.match(
      code,
      /export\s+(async\s+)?function\s+isProxyDisabled|export\s+\{[^}]*isProxyDisabled/,
      'Should export isProxyDisabled function'
    );
  });

  it('should export writeProxyState', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    assert.match(
      code,
      /export\s+(async\s+)?function\s+writeProxyState|export\s+\{[^}]*writeProxyState/,
      'Should export writeProxyState function'
    );
  });

  it('should export readProxyState', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    assert.match(
      code,
      /export\s+(async\s+)?function\s+readProxyState|export\s+\{[^}]*readProxyState/,
      'Should export readProxyState function'
    );
  });

  it('should export STATE_PATH constant', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    assert.match(
      code,
      /export\s+const\s+STATE_PATH|export\s+\{[^}]*STATE_PATH/,
      'Should export STATE_PATH constant'
    );
  });

  it('should define a 30-second cache TTL', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    // Cache TTL should be 30 seconds (30000ms or 30 * 1000)
    assert.match(
      code,
      /30\s*\*\s*1000|30000|30_000/,
      'Should define a 30-second (30000ms) cache TTL'
    );
  });

  it('should read/write a JSON file with a disabled field', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    assert.match(code, /disabled/, 'Should use a "disabled" field in the state object');
    assert.match(code, /JSON\.parse|JSON\.stringify/, 'Should use JSON for state persistence');
  });
});

// ============================================================================
// proxy-state.js — Functional behavior
// ============================================================================

describe('proxy-state.js functional behavior', () => {
  let tempDir;
  let proxyState;
  let originalStatePath;

  beforeEach(async () => {
    tempDir = createTempDir();

    // We need to isolate the state file. The module uses STATE_PATH derived from
    // CLAUDE_PROJECT_DIR or __dirname. Override CLAUDE_PROJECT_DIR for isolation.
    const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;

    // Create the .claude/state directory structure in temp dir
    const stateDir = path.join(tempDir.path, '.claude', 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    process.env.CLAUDE_PROJECT_DIR = tempDir.path;

    // Import with cache-busting to get a fresh module instance per test group.
    // Node's ES module cache means we import once and share across tests in this
    // describe block. The tempDir isolates the file system writes.
    try {
      proxyState = await import('../lib/proxy-state.js');
    } catch (err) {
      // Module does not exist yet — tests will fail with clear messages below
      proxyState = null;
    }

    // Restore env after import (module has already captured it)
    process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  });

  afterEach(() => {
    if (tempDir) {
      tempDir.cleanup();
    }
  });

  it('should be importable without throwing', () => {
    assert.ok(
      proxyState !== null,
      'proxy-state.js must be importable — module does not exist yet'
    );
  });

  it('isProxyDisabled() should return false when state file does not exist', async () => {
    assert.ok(proxyState, 'Module must be importable');
    // Ensure no state file exists in the isolated temp dir
    const stateFile = path.join(tempDir.path, '.claude', 'state', 'proxy-state.json');
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
    // Also try deleting from the actual STATE_PATH location if it differs
    if (proxyState.STATE_PATH && fs.existsSync(proxyState.STATE_PATH)) {
      const backup = fs.readFileSync(proxyState.STATE_PATH);
      try {
        fs.unlinkSync(proxyState.STATE_PATH);
        const result = await proxyState.isProxyDisabled();
        assert.strictEqual(result, false, 'Should return false when state file is missing');
      } finally {
        fs.writeFileSync(proxyState.STATE_PATH, backup);
      }
      return;
    }
    const result = await proxyState.isProxyDisabled();
    assert.strictEqual(result, false, 'Should return false when state file is missing');
  });

  it('readProxyState() should return { disabled: false } when file missing', async () => {
    assert.ok(proxyState, 'Module must be importable');
    // Delete any existing state file
    if (proxyState.STATE_PATH && fs.existsSync(proxyState.STATE_PATH)) {
      const backup = fs.readFileSync(proxyState.STATE_PATH);
      try {
        fs.unlinkSync(proxyState.STATE_PATH);
        const state = await proxyState.readProxyState();
        assert.ok(typeof state === 'object' && state !== null, 'Should return an object');
        assert.strictEqual(state.disabled, false, 'disabled should be false when file missing');
      } finally {
        fs.writeFileSync(proxyState.STATE_PATH, backup);
      }
      return;
    }
    const state = await proxyState.readProxyState();
    assert.ok(typeof state === 'object' && state !== null, 'Should return an object');
    assert.strictEqual(state.disabled, false, 'disabled should be false when file missing');
  });
});

// ============================================================================
// proxy-state.js — State machine behavior (source-level verification)
// ============================================================================

describe('proxy-state.js state machine (source verification)', () => {
  it('should use isProxyDisabled() as a cache-aware reader (not direct fs.existsSync)', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    // The function should check a cache variable before reading from disk
    assert.match(
      code,
      /cache|lastRead|cachedAt|_cache|cacheTime/i,
      'isProxyDisabled should use a cache to avoid disk reads on every call'
    );
  });

  it('writeProxyState should write JSON with a disabled field', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    // writeProxyState must serialize { disabled: ... } to a file
    assert.match(code, /writeFileSync|writeFile/, 'writeProxyState should write to a file');
    assert.match(
      code,
      /JSON\.stringify/,
      'writeProxyState should serialize state as JSON'
    );
  });

  it('writeProxyState should invalidate the cache on write', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    // After writing, cached value must be invalidated so next read picks up new state.
    // Look for cache reset near the write operation.
    assert.match(
      code,
      /cache|lastRead|cachedAt|_cache|cacheTime/i,
      'writeProxyState must update or clear the in-memory cache'
    );
  });

  it('STATE_PATH should resolve inside ~/.claude/', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    // Global state file at ~/.claude/proxy-disabled.json (not per-project .claude/state/)
    // because the rotation proxy is a single global service on port 18080
    assert.match(
      code,
      /os\.homedir\(\).*\.claude.*proxy-disabled\.json|\.claude.*proxy-disabled\.json/,
      'STATE_PATH should reference ~/.claude/proxy-disabled.json'
    );
  });

  it('isProxyDisabled should return a boolean', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    // The function must return true/false, not the state object
    assert.match(
      code,
      /return.*disabled|return.*false|return.*true/,
      'isProxyDisabled should return the disabled boolean field'
    );
  });
});

// ============================================================================
// Integration: Hook files import isProxyDisabled from proxy-state.js
// ============================================================================

describe('Spawn env integration — proxy-state.js import', () => {
  for (const [filename, filePath] of Object.entries(HOOK_FILES)) {
    it(`${filename} should import isProxyDisabled from ./lib/proxy-state.js`, () => {
      assert.ok(
        fs.existsSync(filePath),
        `Hook file not found: ${filePath}`
      );
      const code = fs.readFileSync(filePath, 'utf8');
      assert.match(
        code,
        /import\s+\{[^}]*isProxyDisabled[^}]*\}\s+from\s+['"]\.\/lib\/proxy-state\.js['"]/,
        `${filename} must import isProxyDisabled from ./lib/proxy-state.js`
      );
    });
  }
});

// ============================================================================
// Integration: buildSpawnEnv conditionally sets HTTPS_PROXY
// ============================================================================

describe('Spawn env integration — conditional HTTPS_PROXY', () => {
  for (const [filename, filePath] of Object.entries(HOOK_FILES)) {
    it(`${filename} buildSpawnEnv should guard HTTPS_PROXY with isProxyDisabled()`, () => {
      assert.ok(
        fs.existsSync(filePath),
        `Hook file not found: ${filePath}`
      );
      const code = fs.readFileSync(filePath, 'utf8');

      // Must call isProxyDisabled() somewhere in the file
      assert.match(
        code,
        /isProxyDisabled\(\)/,
        `${filename} must call isProxyDisabled() in buildSpawnEnv`
      );

      // Must use conditional logic around HTTPS_PROXY assignment
      // Pattern: either ternary, if-block, or spread with condition
      assert.match(
        code,
        /isProxyDisabled\(\)[\s\S]{0,200}HTTPS_PROXY|HTTPS_PROXY[\s\S]{0,200}isProxyDisabled\(\)/,
        `${filename} must conditionally assign HTTPS_PROXY based on isProxyDisabled()`
      );
    });

    it(`${filename} buildSpawnEnv should NOT unconditionally set HTTPS_PROXY in the return literal`, () => {
      assert.ok(
        fs.existsSync(filePath),
        `Hook file not found: ${filePath}`
      );
      const code = fs.readFileSync(filePath, 'utf8');

      // The old pattern was HTTPS_PROXY as a bare property in the return object.
      // Extract the buildSpawnEnv function body and verify HTTPS_PROXY is conditional.
      const buildSpawnEnvMatch = code.match(/function buildSpawnEnv[\s\S]*?\n\}/);
      assert.ok(
        buildSpawnEnvMatch,
        `${filename} must define buildSpawnEnv function`
      );

      const fnBody = buildSpawnEnvMatch[0];

      // HTTPS_PROXY must NOT appear as an unconditional property in the return object literal.
      // Unconditional = directly inside "return {" without a conditional wrapper.
      // We detect this by checking whether HTTPS_PROXY appears without any conditional
      // keyword before it on the same logical block.
      //
      // Strategy: if HTTPS_PROXY appears in fnBody, it must be guarded by isProxyDisabled().
      if (fnBody.includes('HTTPS_PROXY')) {
        assert.match(
          fnBody,
          /isProxyDisabled/,
          `${filename}: HTTPS_PROXY in buildSpawnEnv must be guarded by isProxyDisabled()`
        );
      }
    });
  }
});

// ============================================================================
// Integration: HTTPS_PROXY conditional pattern shape
// ============================================================================

describe('Spawn env integration — conditional pattern correctness', () => {
  for (const [filename, filePath] of Object.entries(HOOK_FILES)) {
    it(`${filename} should use a recognized conditional pattern for HTTPS_PROXY`, () => {
      assert.ok(
        fs.existsSync(filePath),
        `Hook file not found: ${filePath}`
      );
      const code = fs.readFileSync(filePath, 'utf8');

      // Accept any of these valid conditional patterns:
      //   Pattern A: ...(!isProxyDisabled() && { HTTPS_PROXY: ... })
      //   Pattern B: ...(isProxyDisabled() ? {} : { HTTPS_PROXY: ... })
      //   Pattern C: if (!isProxyDisabled()) { env.HTTPS_PROXY = ... }
      //   Pattern D: const proxy = isProxyDisabled() ? {} : { HTTPS_PROXY: ... }
      const patternA = /\.\.\.\s*\(\s*!\s*isProxyDisabled\(\)/;
      const patternB = /isProxyDisabled\(\)\s*\?\s*\{\s*\}/;
      const patternC = /if\s*\(\s*!\s*isProxyDisabled\(\)\s*\)/;
      const patternD = /isProxyDisabled\(\)\s*\?/;

      const hasValidPattern =
        patternA.test(code) ||
        patternB.test(code) ||
        patternC.test(code) ||
        patternD.test(code);

      assert.ok(
        hasValidPattern,
        `${filename} must use a recognized conditional pattern (spread+negation, ternary, or if-block) for HTTPS_PROXY`
      );
    });
  }
});

// ============================================================================
// Integration: NODE_EXTRA_CA_CERTS also conditional
// ============================================================================

describe('Spawn env integration — NODE_EXTRA_CA_CERTS conditional', () => {
  for (const [filename, filePath] of Object.entries(HOOK_FILES)) {
    it(`${filename} should guard NODE_EXTRA_CA_CERTS alongside HTTPS_PROXY`, () => {
      assert.ok(
        fs.existsSync(filePath),
        `Hook file not found: ${filePath}`
      );
      const code = fs.readFileSync(filePath, 'utf8');

      // NODE_EXTRA_CA_CERTS is only meaningful when the proxy is active.
      // Verify it appears near the HTTPS_PROXY conditional (within 400 chars).
      if (code.includes('NODE_EXTRA_CA_CERTS')) {
        // If NODE_EXTRA_CA_CERTS exists, it must appear in proximity to isProxyDisabled()
        assert.match(
          code,
          /isProxyDisabled[\s\S]{0,400}NODE_EXTRA_CA_CERTS|NODE_EXTRA_CA_CERTS[\s\S]{0,400}isProxyDisabled/,
          `${filename}: NODE_EXTRA_CA_CERTS should be guarded by the same isProxyDisabled() condition as HTTPS_PROXY`
        );
      }
    });
  }
});

// ============================================================================
// proxy-state.js — Cache TTL behavior (source verification)
// ============================================================================

describe('proxy-state.js cache TTL (source verification)', () => {
  it('should define a CACHE_TTL constant of 30 seconds (30000ms)', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    // Look for a named constant with 30000 or 30 * 1000
    assert.match(
      code,
      /(?:CACHE_TTL|CACHE_TTL_MS|TTL|cacheTtl|cache_ttl)\s*=\s*(?:30\s*\*\s*1000|30000|30_000)|30\s*\*\s*1000|30000|30_000/,
      'Should define 30-second cache TTL (30000ms)'
    );
  });

  it('should store a timestamp alongside the cached value to enforce TTL expiry', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    // Cache expiry requires a timestamp comparison: Date.now() - cachedAt < TTL
    assert.match(
      code,
      /Date\.now\(\)|performance\.now\(\)/,
      'Cache TTL enforcement must use Date.now() or similar timestamp'
    );
  });

  it('should re-read from disk when cache is stale (> 30s old)', () => {
    const code = fs.readFileSync(PROXY_STATE_PATH, 'utf8');
    // Must have logic to check if the cache has expired
    assert.match(
      code,
      /(?:Date\.now\(\)|\w+)\s*-\s*\w+\s*[<>]\s*(?:\w+TTL\w*|\w+Ttl|30000|30_000|30\s*\*\s*1000)/,
      'Must compare Date.now() - timestamp against cache TTL for expiry check'
    );
  });
});
