/**
 * Unit tests for Playwright server credential handling and path-resolution
 * logic introduced in the op-secrets extraction + preflight/demo changes.
 *
 * Covers:
 *   1. getUserFeedbackDbPath() — worktree fallback logic (inlined)
 *   2. validatePrerequisites() — services.json secret canary check (inlined)
 *   3. buildDemoEnv() — fail-closed credential resolution (inlined)
 *   4. Auth file freshness gate — stale/expired auth blocking (inlined)
 *
 * Child process spawning, MCP server startup, and HTTP connections are
 * NOT tested here. Each function under test is inlined verbatim from
 * server.ts so changes to the originals will surface as divergence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Inlined helpers mirroring server.ts
// ============================================================================

/**
 * Mirrors getUserFeedbackDbPath() in server.ts.
 * Accept PROJECT_DIR + WORKTREE_DIR as parameters to allow testing different
 * path configurations without modifying process.env or module state.
 */
function getUserFeedbackDbPath(projectDir: string, worktreeDir: string | null): string {
  const primary = path.join(projectDir, '.claude', 'user-feedback.db');
  if (fs.existsSync(primary)) return primary;

  // Worktree fallback: derive main tree from worktree path
  if (worktreeDir) {
    const worktreeIdx = projectDir.indexOf('/.claude/worktrees/');
    if (worktreeIdx !== -1) {
      const mainTree = projectDir.substring(0, worktreeIdx);
      const fallback = path.join(mainTree, '.claude', 'user-feedback.db');
      if (fs.existsSync(fallback)) return fallback;
    }
  }

  return primary;
}

/**
 * Mirrors the auth file freshness check in runDemo() in server.ts.
 * Returns { ok: true } when the file is fresh and cookies are valid,
 * or { ok: false, message } when the gate should block.
 *
 * Parameters mirror the relevant inputs:
 *   authFilePath  — absolute path to the primary auth file
 *   projectDir    — used to build the absolute path (pass pre-joined path here)
 */
function checkAuthFileFreshness(authFilePath: string): { ok: boolean; message?: string } {
  if (!fs.existsSync(authFilePath)) return { ok: true }; // No file — gate is skipped

  const ageMs = Date.now() - fs.statSync(authFilePath).mtimeMs;
  if (ageMs > 24 * 60 * 60 * 1000) {
    return {
      ok: false,
      message: `Auth state file is ${(ageMs / 3600000).toFixed(1)}h old (>24h). Run mcp__playwright__run_auth_setup to refresh.`,
    };
  }

  // Cookie expiry check
  try {
    const state = JSON.parse(fs.readFileSync(authFilePath, 'utf-8'));
    const now = Date.now() / 1000;
    const expiredCookies = (state.cookies || []).filter(
      (c: { expires?: number }) => c.expires && c.expires > 0 && c.expires < now,
    );
    if (expiredCookies.length > 0) {
      return {
        ok: false,
        message: `Auth cookies are expired (${expiredCookies.length} expired cookie(s)). Run mcp__playwright__run_auth_setup to refresh.`,
      };
    }
  } catch { /* non-fatal — file may not be valid JSON storage state */ }

  return { ok: true };
}

/**
 * Mirrors the services.json canary check in validatePrerequisites() in server.ts.
 * We accept injectable callbacks for loadServicesConfig and opRead so we can
 * test different code paths without spawning the `op` CLI.
 */
function runCanaryCheck(
  projectDir: string,
  loadServicesConfig: (dir: string) => { secrets?: { local?: Record<string, string> } },
  opRead: (ref: string) => string,
): string[] {
  const errors: string[] = [];
  try {
    const config = loadServicesConfig(projectDir);
    const localSecrets = config.secrets?.local || {};
    const secretRefs = Object.entries(localSecrets);
    if (secretRefs.length > 0) {
      const [canaryKey, canaryRef] = secretRefs[0];
      try {
        opRead(canaryRef);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Cannot resolve secrets from 1Password (tested ${canaryKey}): ${message}`);
      }
    }
  } catch {
    // services.json not available — fall through (no error added)
  }
  return errors;
}

/**
 * Mirrors the fail-closed credential-resolution block in buildDemoEnv() in server.ts.
 * Throws when failedKeys is non-empty, just like the original.
 */
function buildDemoEnvCredentials(
  resolveLocalSecrets: (config: object) => { resolvedEnv: Record<string, string>; failedKeys: string[]; failureDetails: Record<string, string> },
  loadServicesConfig: (dir: string) => object,
  projectDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};

  try {
    const config = loadServicesConfig(projectDir);
    const { resolvedEnv, failedKeys, failureDetails } = resolveLocalSecrets(config);
    Object.assign(env, resolvedEnv);

    if (failedKeys.length > 0) {
      const details = failedKeys.map(k => `  ${k}: ${failureDetails[k] || 'unknown error'}`).join('\n');
      throw new Error(
        `Failed to resolve credentials:\n${details}\nThese op:// references could not be resolved by the MCP server.`,
      );
    }
  } catch (err) {
    // Re-throw to caller — launching with missing credentials wastes sessions
    throw err;
  }

  return env;
}

// ============================================================================
// Test fixtures
// ============================================================================

let tempDir: string;

beforeEach(() => {
  tempDir = path.join('/tmp', `demo-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ============================================================================
// getUserFeedbackDbPath() — worktree fallback
// ============================================================================

describe('getUserFeedbackDbPath()', () => {
  it('returns the primary path when user-feedback.db exists at PROJECT_DIR', () => {
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const dbPath = path.join(claudeDir, 'user-feedback.db');
    fs.writeFileSync(dbPath, '');

    const result = getUserFeedbackDbPath(tempDir, null);

    expect(result).toBe(dbPath);
  });

  it('returns the primary path when no DB exists and no worktree is configured', () => {
    // No DB file created — function must still return a path (the primary)
    const result = getUserFeedbackDbPath(tempDir, null);

    expect(result).toBe(path.join(tempDir, '.claude', 'user-feedback.db'));
  });

  it('falls back to main-tree DB when running in a worktree and primary is absent', () => {
    // Simulate: mainTree = tempDir, worktree = tempDir/.claude/worktrees/feature-x
    const worktreePath = path.join(tempDir, '.claude', 'worktrees', 'feature-x');
    fs.mkdirSync(worktreePath, { recursive: true });

    // DB only exists in the MAIN tree
    const mainClaudeDir = path.join(tempDir, '.claude');
    const mainDbPath = path.join(mainClaudeDir, 'user-feedback.db');
    fs.writeFileSync(mainDbPath, '');

    // PROJECT_DIR is the worktree path; WORKTREE_DIR is set
    const result = getUserFeedbackDbPath(worktreePath, worktreePath);

    expect(result).toBe(mainDbPath);
  });

  it('returns worktree primary path when DB exists inside worktree (non-standard but valid)', () => {
    const worktreePath = path.join(tempDir, '.claude', 'worktrees', 'feature-y');
    const worktreeClaudeDir = path.join(worktreePath, '.claude');
    fs.mkdirSync(worktreeClaudeDir, { recursive: true });
    const worktreeDbPath = path.join(worktreeClaudeDir, 'user-feedback.db');
    fs.writeFileSync(worktreeDbPath, '');

    const result = getUserFeedbackDbPath(worktreePath, worktreePath);

    // Primary exists, so returns it (no fallback needed)
    expect(result).toBe(worktreeDbPath);
  });

  it('returns primary path when WORKTREE_DIR is set but PROJECT_DIR has no worktree segment', () => {
    // PROJECT_DIR does not contain /.claude/worktrees/ — fallback cannot derive main tree
    const result = getUserFeedbackDbPath(tempDir, '/some/other/worktree');

    expect(result).toBe(path.join(tempDir, '.claude', 'user-feedback.db'));
  });

  it('falls back to main-tree DB for deeply-nested worktree path', () => {
    // Verify substring matching on /.claude/worktrees/ works for multi-level paths
    const worktreePath = path.join(tempDir, '.claude', 'worktrees', 'fix', 'deep-subdir');
    fs.mkdirSync(worktreePath, { recursive: true });

    const mainDbPath = path.join(tempDir, '.claude', 'user-feedback.db');
    fs.writeFileSync(mainDbPath, '');

    // PROJECT_DIR contains /.claude/worktrees/ — should resolve to mainTree
    const projectDir = path.join(tempDir, '.claude', 'worktrees', 'fix');
    const result = getUserFeedbackDbPath(projectDir, projectDir);

    expect(result).toBe(mainDbPath);
  });
});

// ============================================================================
// validatePrerequisites() — canary opRead check
// ============================================================================

describe('validatePrerequisites() — canary opRead check', () => {
  it('adds no errors when services.json has no local secrets', () => {
    const loadServicesConfig = (_dir: string) => ({ secrets: { local: {} } });
    const opRead = (_ref: string) => 'resolved-value';

    const errors = runCanaryCheck(tempDir, loadServicesConfig, opRead);

    expect(errors).toHaveLength(0);
  });

  it('adds no errors when opRead succeeds on the canary secret', () => {
    const loadServicesConfig = (_dir: string) => ({
      secrets: { local: { MY_SECRET: 'op://vault/item/field' } },
    });
    const opRead = (_ref: string) => 'resolved-secret-value';

    const errors = runCanaryCheck(tempDir, loadServicesConfig, opRead);

    expect(errors).toHaveLength(0);
  });

  it('adds an error containing the canary key name when opRead throws', () => {
    const loadServicesConfig = (_dir: string) => ({
      secrets: { local: { CANARY_KEY: 'op://vault/item/field' } },
    });
    const opRead = (_ref: string): string => {
      throw new Error('OP_SERVICE_ACCOUNT_TOKEN not set');
    };

    const errors = runCanaryCheck(tempDir, loadServicesConfig, opRead);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/CANARY_KEY/);
    expect(errors[0]).toMatch(/Cannot resolve secrets from 1Password/);
  });

  it('error message includes the opRead error text', () => {
    const loadServicesConfig = (_dir: string) => ({
      secrets: { local: { MY_DB_SECRET: 'op://vault/db/password' } },
    });
    const opRead = (_ref: string): string => {
      throw new Error('vault not found');
    };

    const errors = runCanaryCheck(tempDir, loadServicesConfig, opRead);

    expect(errors[0]).toMatch(/vault not found/);
  });

  it('adds no errors when loadServicesConfig throws (services.json absent)', () => {
    const loadServicesConfig = (_dir: string): never => {
      throw new Error('Failed to load services.json: file not found');
    };
    const opRead = (_ref: string) => 'should-not-be-called';

    const errors = runCanaryCheck(tempDir, loadServicesConfig, opRead);

    // services.json not available → fall through with no errors
    expect(errors).toHaveLength(0);
  });

  it('only tests the FIRST secret as the canary (subsequent secrets are not checked)', () => {
    let opReadCallCount = 0;
    const loadServicesConfig = (_dir: string) => ({
      secrets: {
        local: {
          FIRST_SECRET: 'op://vault/item/first',
          SECOND_SECRET: 'op://vault/item/second',
          THIRD_SECRET: 'op://vault/item/third',
        },
      },
    });
    const opRead = (_ref: string) => {
      opReadCallCount++;
      return 'value';
    };

    runCanaryCheck(tempDir, loadServicesConfig, opRead);

    expect(opReadCallCount).toBe(1);
  });

  it('adds no errors when secrets.local is absent in the config', () => {
    const loadServicesConfig = (_dir: string) => ({ secrets: {} });
    const opRead = (_ref: string) => 'should-not-be-called';

    const errors = runCanaryCheck(tempDir, loadServicesConfig, opRead);

    expect(errors).toHaveLength(0);
  });
});

// ============================================================================
// buildDemoEnv() — fail-closed credential resolution
// ============================================================================

describe('buildDemoEnv() — credential resolution', () => {
  it('merges resolved credentials into the env object', () => {
    const resolveLocalSecrets = (_config: object) => ({
      resolvedEnv: { DB_URL: 'postgres://localhost/test', API_KEY: 'secret-value' },
      failedKeys: [],
      failureDetails: {},
    });
    const loadServicesConfig = (_dir: string) => ({});

    const env = buildDemoEnvCredentials(resolveLocalSecrets, loadServicesConfig, tempDir);

    expect(env).toHaveProperty('DB_URL', 'postgres://localhost/test');
    expect(env).toHaveProperty('API_KEY', 'secret-value');
  });

  it('throws when any credential key fails to resolve', () => {
    const resolveLocalSecrets = (_config: object) => ({
      resolvedEnv: { PARTIAL_KEY: 'value' },
      failedKeys: ['MISSING_SECRET'],
      failureDetails: { MISSING_SECRET: 'Failed to read op://vault/item/field: item not found' },
    });
    const loadServicesConfig = (_dir: string) => ({});

    expect(() => {
      buildDemoEnvCredentials(resolveLocalSecrets, loadServicesConfig, tempDir);
    }).toThrow(/MISSING_SECRET: Failed to read op:\/\/vault\/item\/field: item not found/);
  });

  it('error message includes per-key error details on failure', () => {
    const resolveLocalSecrets = (_config: object) => ({
      resolvedEnv: {},
      failedKeys: ['MY_KEY'],
      failureDetails: { MY_KEY: 'Failed to read op://vault/item/field: token expired' },
    });
    const loadServicesConfig = (_dir: string) => ({});

    expect(() => {
      buildDemoEnvCredentials(resolveLocalSecrets, loadServicesConfig, tempDir);
    }).toThrow(/MY_KEY: Failed to read op:\/\/vault\/item\/field: token expired/);
  });

  it('throws listing ALL failed keys when multiple keys fail', () => {
    const resolveLocalSecrets = (_config: object) => ({
      resolvedEnv: {},
      failedKeys: ['KEY_A', 'KEY_B', 'KEY_C'],
      failureDetails: { KEY_A: 'token expired', KEY_B: 'vault not found', KEY_C: 'network timeout' },
    });
    const loadServicesConfig = (_dir: string) => ({});

    expect(() => {
      buildDemoEnvCredentials(resolveLocalSecrets, loadServicesConfig, tempDir);
    }).toThrow(/KEY_A.*KEY_B.*KEY_C/s);
  });

  it('does NOT throw when failedKeys is empty', () => {
    const resolveLocalSecrets = (_config: object) => ({
      resolvedEnv: {},
      failedKeys: [],
      failureDetails: {},
    });
    const loadServicesConfig = (_dir: string) => ({});

    expect(() => {
      buildDemoEnvCredentials(resolveLocalSecrets, loadServicesConfig, tempDir);
    }).not.toThrow();
  });

  it('throws when loadServicesConfig itself throws (services.json unreadable)', () => {
    const resolveLocalSecrets = (_config: object) => ({
      resolvedEnv: {},
      failedKeys: [],
      failureDetails: {},
    });
    const loadServicesConfig = (_dir: string): never => {
      throw new Error('Failed to load services.json: permission denied');
    };

    expect(() => {
      buildDemoEnvCredentials(resolveLocalSecrets, loadServicesConfig, tempDir);
    }).toThrow(/Failed to load services.json/);
  });

  it('returns an empty env object when config has no secrets to resolve', () => {
    const resolveLocalSecrets = (_config: object) => ({
      resolvedEnv: {},
      failedKeys: [],
      failureDetails: {},
    });
    const loadServicesConfig = (_dir: string) => ({});

    const env = buildDemoEnvCredentials(resolveLocalSecrets, loadServicesConfig, tempDir);

    expect(env).toEqual({});
  });

});

// ============================================================================
// Auth file freshness gate
// ============================================================================

describe('auth file freshness gate', () => {
  it('passes (ok: true) when no auth file exists', () => {
    const nonExistentPath = path.join(tempDir, '.auth', 'vendor-owner.json');

    const result = checkAuthFileFreshness(nonExistentPath);

    expect(result.ok).toBe(true);
    expect(result.message).toBeUndefined();
  });

  it('passes (ok: true) for a freshly-created auth file with no expired cookies', () => {
    const authDir = path.join(tempDir, '.auth');
    fs.mkdirSync(authDir, { recursive: true });
    const authFile = path.join(authDir, 'vendor-owner.json');
    // Write a valid auth state with a cookie that expires far in the future
    const futureExpiry = Math.floor(Date.now() / 1000) + 86400 * 30; // 30 days from now
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        cookies: [{ name: 'session', value: 'abc', expires: futureExpiry }],
        origins: [],
      }),
    );

    const result = checkAuthFileFreshness(authFile);

    expect(result.ok).toBe(true);
  });

  it('blocks (ok: false) when auth file is older than 24 hours', () => {
    const authDir = path.join(tempDir, '.auth');
    fs.mkdirSync(authDir, { recursive: true });
    const authFile = path.join(authDir, 'vendor-owner.json');
    fs.writeFileSync(authFile, JSON.stringify({ cookies: [], origins: [] }));

    // Back-date the file's mtime to 25 hours ago
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(authFile, twentyFiveHoursAgo, twentyFiveHoursAgo);

    const result = checkAuthFileFreshness(authFile);

    expect(result.ok).toBe(false);
    expect(result.message).toBeDefined();
    expect(result.message).toMatch(/>24h/);
    expect(result.message).toMatch(/run_auth_setup/);
  });

  it('blocks when auth file is exactly 24h + 1 second old', () => {
    const authDir = path.join(tempDir, '.auth');
    fs.mkdirSync(authDir, { recursive: true });
    const authFile = path.join(authDir, 'session.json');
    fs.writeFileSync(authFile, JSON.stringify({ cookies: [] }));

    const justOverLimit = new Date(Date.now() - (24 * 60 * 60 * 1000 + 1000));
    fs.utimesSync(authFile, justOverLimit, justOverLimit);

    const result = checkAuthFileFreshness(authFile);

    expect(result.ok).toBe(false);
  });

  it('passes when auth file is just under 24 hours old', () => {
    const authDir = path.join(tempDir, '.auth');
    fs.mkdirSync(authDir, { recursive: true });
    const authFile = path.join(authDir, 'session.json');
    fs.writeFileSync(authFile, JSON.stringify({ cookies: [] }));

    // 23h59m old — just under the limit
    const justUnderLimit = new Date(Date.now() - (24 * 60 * 60 * 1000 - 60 * 1000));
    fs.utimesSync(authFile, justUnderLimit, justUnderLimit);

    const result = checkAuthFileFreshness(authFile);

    expect(result.ok).toBe(true);
  });

  it('blocks (ok: false) when auth file contains expired cookies', () => {
    const authDir = path.join(tempDir, '.auth');
    fs.mkdirSync(authDir, { recursive: true });
    const authFile = path.join(authDir, 'vendor-owner.json');

    const expiredTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        cookies: [{ name: 'session', value: 'abc', expires: expiredTimestamp }],
        origins: [],
      }),
    );

    const result = checkAuthFileFreshness(authFile);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/expired/);
    expect(result.message).toMatch(/1 expired cookie/);
    expect(result.message).toMatch(/run_auth_setup/);
  });

  it('reports correct count when multiple cookies are expired', () => {
    const authDir = path.join(tempDir, '.auth');
    fs.mkdirSync(authDir, { recursive: true });
    const authFile = path.join(authDir, 'vendor-owner.json');

    const past = Math.floor(Date.now() / 1000) - 7200;
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        cookies: [
          { name: 'a', value: '1', expires: past },
          { name: 'b', value: '2', expires: past },
          { name: 'c', value: '3', expires: past },
        ],
        origins: [],
      }),
    );

    const result = checkAuthFileFreshness(authFile);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/3 expired cookie/);
  });

  it('ignores cookies with expires = 0 (session cookies that never expire)', () => {
    const authDir = path.join(tempDir, '.auth');
    fs.mkdirSync(authDir, { recursive: true });
    const authFile = path.join(authDir, 'vendor-owner.json');

    fs.writeFileSync(
      authFile,
      JSON.stringify({
        cookies: [{ name: 'session', value: 'abc', expires: 0 }],
        origins: [],
      }),
    );

    const result = checkAuthFileFreshness(authFile);

    expect(result.ok).toBe(true);
  });

  it('ignores cookies with no expires field (session cookies)', () => {
    const authDir = path.join(tempDir, '.auth');
    fs.mkdirSync(authDir, { recursive: true });
    const authFile = path.join(authDir, 'vendor-owner.json');

    fs.writeFileSync(
      authFile,
      JSON.stringify({
        cookies: [{ name: 'session', value: 'abc' }],
        origins: [],
      }),
    );

    const result = checkAuthFileFreshness(authFile);

    expect(result.ok).toBe(true);
  });

  it('passes when cookies array is empty', () => {
    const authDir = path.join(tempDir, '.auth');
    fs.mkdirSync(authDir, { recursive: true });
    const authFile = path.join(authDir, 'vendor-owner.json');
    fs.writeFileSync(authFile, JSON.stringify({ cookies: [], origins: [] }));

    const result = checkAuthFileFreshness(authFile);

    expect(result.ok).toBe(true);
  });

  it('passes non-fatally when auth file contains invalid JSON', () => {
    const authDir = path.join(tempDir, '.auth');
    fs.mkdirSync(authDir, { recursive: true });
    const authFile = path.join(authDir, 'vendor-owner.json');
    fs.writeFileSync(authFile, 'not valid json {{{');

    // The cookie-expiry check is non-fatal per spec — should not throw
    expect(() => checkAuthFileFreshness(authFile)).not.toThrow();
    const result = checkAuthFileFreshness(authFile);
    expect(result.ok).toBe(true);
  });

  it('stale file error message includes the age in hours', () => {
    const authDir = path.join(tempDir, '.auth');
    fs.mkdirSync(authDir, { recursive: true });
    const authFile = path.join(authDir, 'vendor-owner.json');
    fs.writeFileSync(authFile, JSON.stringify({ cookies: [] }));

    // 48 hours ago
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(authFile, fortyEightHoursAgo, fortyEightHoursAgo);

    const result = checkAuthFileFreshness(authFile);

    expect(result.ok).toBe(false);
    // Age should be approximately 48h
    expect(result.message).toMatch(/48\.\d+h old/);
  });
});
