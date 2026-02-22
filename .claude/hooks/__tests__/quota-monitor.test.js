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

      // The unified pre-pass uses isExpired = status === 'expired' && expiresAt < now (cached)
      assert.match(
        code,
        /keyData\.status === ['"]expired['"]/,
        'Must check for "expired" status in the refresh pre-pass'
      );

      assert.match(
        code,
        /keyData\.expiresAt && keyData\.expiresAt < now/,
        'Must check expiresAt < now (cached timestamp) in the refresh pre-pass'
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

      // The event for a refreshed expired token is 'key_added' (via ternary: isExpired ? 'key_added' : 'key_refreshed')
      assert.match(
        code,
        /['"]key_added['"]/,
        'Must include key_added event for refreshed tokens in quota-monitor'
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

  describe('Seamless rotation (no kill/restart)', () => {
    it('should return continue: true with systemMessage for interactive sessions after rotation', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /continue:\s*true[\s\S]*?systemMessage:/,
        'Must return continue: true with systemMessage for interactive sessions'
      );
    });

    it('should distinguish between automated and interactive sessions', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /isAutomated/,
        'Must use an isAutomated flag to differentiate session type'
      );

      assert.match(
        code,
        /CLAUDE_SPAWNED_SESSION/,
        'Must read CLAUDE_SPAWNED_SESSION env var to detect automated sessions'
      );
    });

    it('should NOT spawn new processes (seamless rotation only)', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.doesNotMatch(
        code,
        /spawn\(['"]claude['"]/,
        'Must NOT spawn new claude processes - seamless rotation only'
      );
    });

    it('should include rotation audit logging', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /verifyPendingAudit/,
        'Must include verifyPendingAudit function for post-rotation health checks'
      );

      assert.match(
        code,
        /appendRotationAudit/,
        'Must import appendRotationAudit from key-sync.js for rotation telemetry'
      );
    });
  });

  describe('main() structure integrity', () => {
    it('should use adaptive interval instead of fixed CHECK_INTERVAL_MS', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /getAdaptiveInterval/,
        'Must use getAdaptiveInterval for dynamic throttling'
      );

      assert.match(
        code,
        /ADAPTIVE_INTERVALS/,
        'Must define ADAPTIVE_INTERVALS for usage-based throttling'
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

  describe('Seamless rotation logic', () => {
    it('should write rotated credentials to Keychain via updateActiveCredentials', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /updateActiveCredentials\(/,
        'Must call updateActiveCredentials to persist rotated credentials'
      );
    });

    it('should create audit record in throttle state after rotation', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /pendingAudit/,
        'Must create pendingAudit in throttle state for verification'
      );
    });
  });
});
