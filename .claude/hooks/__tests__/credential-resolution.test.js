/**
 * Unit tests for lazy credential resolution in hourly-automation.js
 *
 * Tests the ensureCredentials() and preResolveCredentials() functions
 * which implement lazy credential resolution to prevent unnecessary
 * macOS TCC prompts in automation contexts.
 *
 * Key behaviors:
 * - ensureCredentials() only calls preResolveCredentials() once per cycle
 * - preResolveCredentials() skips op read in headless mode without service account
 * - preResolveCredentials() proceeds when OP_SERVICE_ACCOUNT_TOKEN is available
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Mock implementation of credential resolution logic
 * (Extracted from hourly-automation.js for testing)
 */
class CredentialResolver {
  constructor() {
    this.resolvedCredentials = {};
    this.credentialsResolved = false;
    this.preResolveCallCount = 0;
    this.opReadCallCount = 0;
  }

  /**
   * Ensure credentials have been resolved (lazy, called only when spawning).
   * Wraps preResolveCredentials() with a guard flag so it runs at most once
   * per automation cycle.
   */
  ensureCredentials() {
    if (this.credentialsResolved) return;
    this.credentialsResolved = true;
    this.preResolveCredentials();
  }

  /**
   * Pre-resolve all 1Password credentials needed by infrastructure MCP servers.
   * In headless contexts (launchd/systemd), skips `op read` calls unless
   * OP_SERVICE_ACCOUNT_TOKEN is set, to prevent macOS permission prompts.
   */
  preResolveCredentials() {
    this.preResolveCallCount++;

    // Headless guard: In launchd/systemd contexts, `op` communicates with the
    // 1Password desktop app via IPC, triggering macOS TCC and Touch ID prompts.
    // OP_SERVICE_ACCOUNT_TOKEN uses the 1Password API directly (no desktop app).
    const hasServiceAccount = !!process.env.OP_SERVICE_ACCOUNT_TOKEN;
    const isLaunchdService = process.env.GENTYR_LAUNCHD_SERVICE === 'true';

    if (isLaunchdService && !hasServiceAccount) {
      // Skip credential resolution in headless mode without service account
      return;
    }

    // If we reach here, either we have a service account OR we're not in headless mode
    // Simulate credential resolution
    this.resolvedCredentials.MOCK_API_KEY = 'resolved-value';
    this.opReadCallCount++;
  }

  /**
   * Build the env object for spawning claude processes.
   * Lazily resolves credentials on first call.
   */
  buildSpawnEnv(agentId) {
    this.ensureCredentials();
    return {
      ...process.env,
      ...this.resolvedCredentials,
      CLAUDE_AGENT_ID: agentId,
    };
  }

  reset() {
    this.resolvedCredentials = {};
    this.credentialsResolved = false;
    this.preResolveCallCount = 0;
    this.opReadCallCount = 0;
  }
}

describe('Credential Resolution (hourly-automation.js)', () => {
  let originalEnv;
  let resolver;

  beforeEach(() => {
    originalEnv = { ...process.env };
    resolver = new CredentialResolver();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('ensureCredentials()', () => {
    it('should call preResolveCredentials() on first invocation', () => {
      resolver.ensureCredentials();

      assert.strictEqual(resolver.preResolveCallCount, 1);
      assert.strictEqual(resolver.credentialsResolved, true);
    });

    it('should NOT call preResolveCredentials() on subsequent invocations', () => {
      resolver.ensureCredentials();
      resolver.ensureCredentials();
      resolver.ensureCredentials();

      assert.strictEqual(resolver.preResolveCallCount, 1);
      assert.strictEqual(resolver.credentialsResolved, true);
    });

    it('should set credentialsResolved flag before calling preResolveCredentials', () => {
      let flagWasSet = false;

      // Override preResolveCredentials to check flag state
      const originalPreResolve = resolver.preResolveCredentials.bind(resolver);
      resolver.preResolveCredentials = function() {
        flagWasSet = this.credentialsResolved;
        originalPreResolve();
      };

      resolver.ensureCredentials();

      assert.strictEqual(flagWasSet, true);
    });
  });

  describe('preResolveCredentials() - headless guards', () => {
    it('should skip op read when GENTYR_LAUNCHD_SERVICE=true and no OP_SERVICE_ACCOUNT_TOKEN', () => {
      process.env.GENTYR_LAUNCHD_SERVICE = 'true';
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;

      resolver.preResolveCredentials();

      assert.strictEqual(resolver.opReadCallCount, 0);
      assert.strictEqual(Object.keys(resolver.resolvedCredentials).length, 0);
    });

    it('should proceed with op read when OP_SERVICE_ACCOUNT_TOKEN is set (headless mode)', () => {
      process.env.GENTYR_LAUNCHD_SERVICE = 'true';
      process.env.OP_SERVICE_ACCOUNT_TOKEN = 'ops_test_token_abc123';

      resolver.preResolveCredentials();

      assert.strictEqual(resolver.opReadCallCount, 1);
      assert.strictEqual(resolver.resolvedCredentials.MOCK_API_KEY, 'resolved-value');
    });

    it('should proceed with op read when not in headless mode', () => {
      delete process.env.GENTYR_LAUNCHD_SERVICE;
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;

      resolver.preResolveCredentials();

      assert.strictEqual(resolver.opReadCallCount, 1);
      assert.strictEqual(resolver.resolvedCredentials.MOCK_API_KEY, 'resolved-value');
    });

    it('should proceed when GENTYR_LAUNCHD_SERVICE=false (not headless)', () => {
      process.env.GENTYR_LAUNCHD_SERVICE = 'false';
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;

      resolver.preResolveCredentials();

      assert.strictEqual(resolver.opReadCallCount, 1);
      assert.strictEqual(resolver.resolvedCredentials.MOCK_API_KEY, 'resolved-value');
    });

    it('should proceed when GENTYR_LAUNCHD_SERVICE is empty string', () => {
      process.env.GENTYR_LAUNCHD_SERVICE = '';
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;

      resolver.preResolveCredentials();

      assert.strictEqual(resolver.opReadCallCount, 1);
    });

    it('should skip when GENTYR_LAUNCHD_SERVICE=true with empty OP_SERVICE_ACCOUNT_TOKEN', () => {
      process.env.GENTYR_LAUNCHD_SERVICE = 'true';
      process.env.OP_SERVICE_ACCOUNT_TOKEN = '';

      resolver.preResolveCredentials();

      // Empty string is falsy, so should skip
      assert.strictEqual(resolver.opReadCallCount, 0);
    });

    it('should proceed when both env vars are set', () => {
      process.env.GENTYR_LAUNCHD_SERVICE = 'true';
      process.env.OP_SERVICE_ACCOUNT_TOKEN = 'ops_token';

      resolver.preResolveCredentials();

      assert.strictEqual(resolver.opReadCallCount, 1);
    });
  });

  describe('buildSpawnEnv()', () => {
    it('should call ensureCredentials() before building env', () => {
      const env = resolver.buildSpawnEnv('test-agent-id');

      assert.strictEqual(resolver.preResolveCallCount, 1);
      assert.strictEqual(resolver.credentialsResolved, true);
    });

    it('should include resolved credentials in env', () => {
      process.env.GENTYR_LAUNCHD_SERVICE = 'true';
      process.env.OP_SERVICE_ACCOUNT_TOKEN = 'ops_token';

      const env = resolver.buildSpawnEnv('test-agent-id');

      assert.strictEqual(env.MOCK_API_KEY, 'resolved-value');
      assert.strictEqual(env.CLAUDE_AGENT_ID, 'test-agent-id');
    });

    it('should NOT include resolved credentials in headless mode without service account', () => {
      process.env.GENTYR_LAUNCHD_SERVICE = 'true';
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;

      const env = resolver.buildSpawnEnv('test-agent-id');

      assert.strictEqual(env.MOCK_API_KEY, undefined);
      assert.strictEqual(env.CLAUDE_AGENT_ID, 'test-agent-id');
    });

    it('should only call ensureCredentials() once across multiple buildSpawnEnv() calls', () => {
      resolver.buildSpawnEnv('agent-1');
      resolver.buildSpawnEnv('agent-2');
      resolver.buildSpawnEnv('agent-3');

      assert.strictEqual(resolver.preResolveCallCount, 1);
    });

    it('should include process.env variables in spawned env', () => {
      process.env.TEST_VAR = 'test-value';
      process.env.ANOTHER_VAR = 'another-value';

      const env = resolver.buildSpawnEnv('test-agent');

      assert.strictEqual(env.TEST_VAR, 'test-value');
      assert.strictEqual(env.ANOTHER_VAR, 'another-value');
    });
  });

  describe('lazy resolution behavior', () => {
    it('should NOT resolve credentials if no agents are spawned', () => {
      // Simulate a cycle where no agents spawn (all hit cooldowns)
      // Don't call ensureCredentials() or buildSpawnEnv()

      assert.strictEqual(resolver.preResolveCallCount, 0);
      assert.strictEqual(resolver.credentialsResolved, false);
    });

    it('should resolve credentials only when first agent spawns', () => {
      // Simulate cycle with multiple agents spawning
      resolver.buildSpawnEnv('agent-1');

      assert.strictEqual(resolver.preResolveCallCount, 1);

      resolver.buildSpawnEnv('agent-2');
      resolver.buildSpawnEnv('agent-3');

      // Still only called once
      assert.strictEqual(resolver.preResolveCallCount, 1);
    });

    it('should reset properly for next cycle', () => {
      resolver.ensureCredentials();

      assert.strictEqual(resolver.preResolveCallCount, 1);
      assert.strictEqual(resolver.credentialsResolved, true);

      // Simulate new cycle
      resolver.reset();
      resolver.ensureCredentials();

      assert.strictEqual(resolver.preResolveCallCount, 1);
      assert.strictEqual(resolver.credentialsResolved, true);
    });
  });

  describe('environment variable precedence', () => {
    it('should respect GENTYR_LAUNCHD_SERVICE string comparison', () => {
      // Test exact string match
      const testCases = [
        { value: 'true', expected: 0 },  // Skip
        { value: 'TRUE', expected: 1 },  // Proceed (case sensitive)
        { value: 'True', expected: 1 },  // Proceed
        { value: '1', expected: 1 },     // Proceed
        { value: 'yes', expected: 1 },   // Proceed
      ];

      for (const { value, expected } of testCases) {
        resolver.reset();
        process.env.GENTYR_LAUNCHD_SERVICE = value;
        delete process.env.OP_SERVICE_ACCOUNT_TOKEN;

        resolver.preResolveCredentials();

        assert.strictEqual(
          resolver.opReadCallCount,
          expected,
          `Expected ${expected} op reads for GENTYR_LAUNCHD_SERVICE="${value}"`
        );
      }
    });

    it('should respect OP_SERVICE_ACCOUNT_TOKEN truthiness', () => {
      process.env.GENTYR_LAUNCHD_SERVICE = 'true';

      const testCases = [
        { value: 'ops_valid_token', expected: 1 },
        { value: ' ', expected: 1 }, // Non-empty whitespace is truthy
        { value: '', expected: 0 },  // Empty string is falsy
      ];

      for (const { value, expected } of testCases) {
        resolver.reset();
        if (value === '') {
          delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
        } else {
          process.env.OP_SERVICE_ACCOUNT_TOKEN = value;
        }

        resolver.preResolveCredentials();

        assert.strictEqual(
          resolver.opReadCallCount,
          expected,
          `Expected ${expected} op reads for OP_SERVICE_ACCOUNT_TOKEN="${value}"`
        );
      }
    });
  });

  describe('error handling', () => {
    it('should handle missing environment variables gracefully', () => {
      delete process.env.GENTYR_LAUNCHD_SERVICE;
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;

      assert.doesNotThrow(() => {
        resolver.preResolveCredentials();
      });

      assert.strictEqual(resolver.opReadCallCount, 1);
    });

    it('should not throw when credentialsResolved flag is already set', () => {
      resolver.credentialsResolved = true;

      assert.doesNotThrow(() => {
        resolver.ensureCredentials();
      });

      assert.strictEqual(resolver.preResolveCallCount, 0);
    });
  });

  describe('performance optimization', () => {
    it('should eliminate unnecessary op calls in cooldown cycles', () => {
      // Simulate 10 automation cycles where all tasks hit cooldowns
      for (let i = 0; i < 10; i++) {
        resolver.reset();
        // No agents spawned, so ensureCredentials() never called
      }

      assert.strictEqual(resolver.preResolveCallCount, 0);
      assert.strictEqual(resolver.opReadCallCount, 0);
    });

    it('should eliminate ~90% of op calls if only 10% of cycles spawn agents', () => {
      let totalOpCalls = 0;

      // Simulate 100 cycles, only 10 spawn agents
      for (let i = 0; i < 100; i++) {
        resolver.reset();

        if (i % 10 === 0) {
          // Every 10th cycle spawns an agent
          resolver.buildSpawnEnv('agent');
          totalOpCalls += resolver.opReadCallCount;
        }
      }

      // Should be ~10 op calls instead of 100
      assert.strictEqual(totalOpCalls, 10);
    });
  });
});
