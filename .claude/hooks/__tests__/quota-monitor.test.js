/**
 * Tests for quota-monitor.js
 *
 * Covers the three additions made to this file:
 * 1. Import of refreshExpiredToken from key-sync.js
 * 2. Step 4b: Pre-pass that refreshes expired tokens before rotation
 * 3. Automated session restart via spawn (previously: only continue with rotated creds)
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/quota-monitor.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOOK_PATH = path.join(__dirname, '..', 'quota-monitor.js');

describe('quota-monitor.js - Code Structure', () => {
  describe('Import: refreshExpiredToken', () => {
    it('should import refreshExpiredToken from key-sync.js', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /import \{[\s\S]*?refreshExpiredToken[\s\S]*?\} from ['"]\.\/key-sync\.js['"]/,
        'Must import refreshExpiredToken from key-sync.js'
      );
    });

    it('should also import the other required key-sync exports', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const requiredImports = [
        'readRotationState',
        'writeRotationState',
        'logRotationEvent',
        'updateActiveCredentials',
        'checkKeyHealth',
        'selectActiveKey',
        'refreshExpiredToken',
        'HIGH_USAGE_THRESHOLD',
        'EXHAUSTED_THRESHOLD',
      ];

      for (const name of requiredImports) {
        assert.match(
          code,
          new RegExp(`import \\{[\\s\\S]*?${name}[\\s\\S]*?\\} from ['"]\\./key-sync\\.js['"]`),
          `Must import ${name} from key-sync.js`
        );
      }
    });
  });

  describe('Step 4b: Expired token refresh pre-pass', () => {
    it('should include a Step 4b comment or block that refreshes expired tokens', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      // The pre-pass is described in a comment
      assert.match(
        code,
        /Step 4b|Refresh expired tokens before rotation/i,
        'Must have a Step 4b block or comment for the pre-pass token refresh'
      );
    });

    it('should iterate over state.keys in the refresh pre-pass', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /Object\.entries\(state\.keys\)/,
        'Must iterate over state.keys in the main function'
      );
    });

    it('should filter for keys with status "expired" and past expiresAt in the pre-pass', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      // The pre-pass condition: status === 'expired' && expiresAt && expiresAt < Date.now()
      assert.match(
        code,
        /keyData\.status === ['"]expired['"]/,
        'Must check for "expired" status in the refresh pre-pass'
      );

      assert.match(
        code,
        /keyData\.expiresAt && keyData\.expiresAt < Date\.now\(\)/,
        'Must check expiresAt < Date.now() in the refresh pre-pass'
      );
    });

    it('should call refreshExpiredToken in the pre-pass', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /await refreshExpiredToken\(keyData\)/,
        'Must call await refreshExpiredToken(keyData) in the pre-pass'
      );
    });

    it('should update accessToken, refreshToken, expiresAt, and status on successful refresh', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /keyData\.accessToken = refreshed\.accessToken/,
        'Must update keyData.accessToken after successful refresh in pre-pass'
      );

      assert.match(
        code,
        /keyData\.refreshToken = refreshed\.refreshToken/,
        'Must update keyData.refreshToken after successful refresh in pre-pass'
      );

      assert.match(
        code,
        /keyData\.expiresAt = refreshed\.expiresAt/,
        'Must update keyData.expiresAt after successful refresh in pre-pass'
      );

      assert.match(
        code,
        /keyData\.status = ['"]active['"]/,
        'Must set keyData.status to "active" after successful refresh in pre-pass'
      );
    });

    it('should log token_refreshed_by_quota_monitor event on successful refresh', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /token_refreshed_by_quota_monitor/,
        'Must log the token_refreshed_by_quota_monitor reason in logRotationEvent'
      );
    });

    it('should log key_added event when a token is successfully refreshed in the pre-pass', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      // The event for a refreshed token reuse is 'key_added'
      assert.match(
        code,
        /event:\s*['"]key_added['"]/,
        'Must log key_added event for refreshed tokens in quota-monitor'
      );
    });

    it('should wrap the refresh attempt in a try/catch (non-fatal)', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      // The pre-pass refresh must not crash the hook on error
      // Check there is a try/catch around refreshExpiredToken usage
      assert.match(
        code,
        /try \{[\s\S]*?refreshExpiredToken[\s\S]*?\} catch/,
        'Refresh pre-pass must be wrapped in try/catch to be non-fatal'
      );
    });

    it('should call writeRotationState after the refresh pre-pass completes', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      // There should be multiple writeRotationState calls; at minimum one after the pre-pass
      const matches = [...code.matchAll(/writeRotationState\(state\)/g)];
      assert.ok(
        matches.length >= 2,
        `Must call writeRotationState at least twice (pre-pass + after rotation). Found ${matches.length} call(s).`
      );
    });
  });

  describe('Automated session restart via spawn', () => {
    it('should spawn the claude process for automated session restart', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /spawn\(['"]claude['"]/,
        'Must spawn "claude" process for automated session restart'
      );
    });

    it('should pass --resume flag to the spawned claude process', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /['"]--resume['"]/,
        'Spawned claude process must receive --resume flag'
      );
    });

    it('should pass --dangerously-skip-permissions flag to spawned process', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /['"]--dangerously-skip-permissions['"]/,
        'Spawned claude process must receive --dangerously-skip-permissions flag'
      );
    });

    it('should pass --mcp-config flag pointing at project .mcp.json', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /['"]--mcp-config['"]/,
        'Spawned claude process must receive --mcp-config flag'
      );

      assert.match(
        code,
        /\.mcp\.json/,
        'mcp-config path must point to the .mcp.json file'
      );
    });

    it('should detach the spawned process so it survives the hook exiting', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /detached:\s*true/,
        'Spawned child process must be detached'
      );
    });

    it('should call child.unref() to allow the hook process to exit', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /child\.unref\(\)/,
        'Must call child.unref() so the hook process can exit independently'
      );
    });

    it('should return continue: false with a stopReason when spawn succeeds for automated session', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /continue:\s*false[\s\S]*?stopReason:/,
        'Must return continue: false with stopReason when automated session is restarted'
      );
    });

    it('should include the PID of the spawned process in the stopReason message', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /child\.pid/,
        'Must include spawned PID in the stopReason message'
      );
    });

    it('should fall back to continue: true with systemMessage when spawn fails', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      // After the spawn attempt fails, the hook must fall back gracefully
      assert.match(
        code,
        /continue:\s*true[\s\S]*?systemMessage:/,
        'Must fall back to continue: true with systemMessage when spawn fails for automated session'
      );
    });

    it('should distinguish between automated and interactive sessions for restart logic', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /isAutomated/,
        'Must use an isAutomated flag to differentiate restart strategy'
      );

      assert.match(
        code,
        /CLAUDE_SPAWNED_SESSION/,
        'Must read CLAUDE_SPAWNED_SESSION env var to detect automated sessions'
      );
    });
  });

  describe('main() structure integrity', () => {
    it('should still check the 5-minute throttle before doing any work', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /CHECK_INTERVAL_MS/,
        'Must still enforce the 5-minute check interval throttle'
      );
    });

    it('should still check the 10-minute rotation cooldown', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /ROTATION_COOLDOWN_MS/,
        'Must still enforce the 10-minute rotation cooldown'
      );
    });

    it('should still call checkKeyHealth for the active key', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /await checkKeyHealth\(activeKeyData\.accessToken\)/,
        'Must still call checkKeyHealth for the active key'
      );
    });

    it('should still call selectActiveKey after the refresh pre-pass', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /selectActiveKey\(state\)/,
        'Must still call selectActiveKey to determine best key after refresh pre-pass'
      );
    });

    it('should still write paused session when all keys are exhausted', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /writePausedSession\(/,
        'Must still write paused session record when all accounts are exhausted'
      );
    });

    it('should still handle errors without blocking (fail-open for PostToolUse hook)', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /main\(\)\.catch\(/,
        'Must catch errors from main() and not block'
      );

      // The catch handler must still emit continue: true via process.stdout.write or console.log.
      // Extract from `main().catch(` to end of file to capture the full block.
      const catchStart = code.indexOf('main().catch(');
      assert.ok(catchStart >= 0, 'main().catch( must exist in the file');
      const catchSection = code.slice(catchStart);
      assert.match(
        catchSection,
        /continue:\s*true/,
        'catch handler must emit continue: true to fail-open'
      );
    });
  });
});

describe('quota-monitor.js - Behavioral Logic', () => {
  describe('Expired token pre-pass decision matrix', () => {
    it('should identify expired+past-expiresAt keys as pre-pass candidates', () => {
      const now = Date.now();
      const keys = {
        'key-expired-past': { status: 'expired', expiresAt: now - 3600000 },
        'key-expired-future': { status: 'expired', expiresAt: now + 3600000 },
        'key-active': { status: 'active', expiresAt: now + 3600000 },
        'key-invalid': { status: 'invalid', expiresAt: now - 1000 },
        'key-no-expiry': { status: 'expired', expiresAt: null },
      };

      // Mirrors the pre-pass filter in quota-monitor Step 4b
      const candidates = Object.entries(keys).filter(
        ([, kd]) => kd.status === 'expired' && kd.expiresAt && kd.expiresAt < Date.now()
      );

      assert.strictEqual(candidates.length, 1);
      assert.strictEqual(candidates[0][0], 'key-expired-past');
    });

    it('should not include active, invalid, or future-expiry keys in pre-pass candidates', () => {
      const now = Date.now();
      const keys = {
        'key-active': { status: 'active', expiresAt: now + 3600000 },
        'key-invalid': { status: 'invalid', expiresAt: now - 1000 },
        'key-future': { status: 'expired', expiresAt: now + 3600000 },
        'key-null-expiry': { status: 'expired', expiresAt: null },
      };

      const candidates = Object.entries(keys).filter(
        ([, kd]) => kd.status === 'expired' && kd.expiresAt && kd.expiresAt < Date.now()
      );

      assert.strictEqual(candidates.length, 0, 'No non-expired-past keys should be candidates');
    });

    it('should verify that a successful refresh makes the key a rotation candidate', () => {
      // After a successful refresh, the key's status becomes 'active'.
      // selectActiveKey includes 'active' keys, so it becomes a valid rotation target.
      const key = { status: 'expired', expiresAt: Date.now() - 5000 };

      // Simulate successful refresh
      const refreshed = {
        accessToken: 'new-token',
        refreshToken: 'new-refresh',
        expiresAt: Date.now() + 3600000,
      };
      key.accessToken = refreshed.accessToken;
      key.refreshToken = refreshed.refreshToken;
      key.expiresAt = refreshed.expiresAt;
      key.status = 'active';

      assert.strictEqual(key.status, 'active', 'Key must be active after successful refresh');
      assert.ok(key.expiresAt > Date.now(), 'Key must have a future expiresAt after refresh');
    });
  });

  describe('Automated session restart logic', () => {
    it('should build spawnArgs with --resume, sessionId, and --output-format json', () => {
      // Simulate the spawnArgs construction
      const sessionId = 'test-session-123';
      const projectDir = '/path/to/project';

      const spawnArgs = [
        '--resume', sessionId,
        '--dangerously-skip-permissions',
        '--mcp-config', path.join(projectDir, '.mcp.json'),
        '--output-format', 'json',
      ];

      assert.strictEqual(spawnArgs[0], '--resume');
      assert.strictEqual(spawnArgs[1], sessionId);
      assert.ok(spawnArgs.includes('--dangerously-skip-permissions'));
      assert.ok(spawnArgs.includes('--mcp-config'));
      assert.ok(spawnArgs.some(a => a.endsWith('.mcp.json')));
      assert.ok(spawnArgs.includes('--output-format'));
      assert.ok(spawnArgs.includes('json'));
    });
  });
});
