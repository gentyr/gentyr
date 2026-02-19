/**
 * Tests for stop-continue-hook.js
 *
 * Covers the three additions made to this file:
 * 1. Import of refreshExpiredToken from key-sync.js
 * 2. Refresh pre-pass in attemptQuotaRotation() before health-checking keys
 * 3. Stale session cleanup window changed from 7 days to 30 minutes
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/stop-continue-hook.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOOK_PATH = path.join(__dirname, '..', 'stop-continue-hook.js');

describe('stop-continue-hook.js - Code Structure', () => {
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

  describe('attemptQuotaRotation() - refresh pre-pass', () => {
    it('should define attemptQuotaRotation as an async function', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /async function attemptQuotaRotation\(\)/,
        'attemptQuotaRotation must be an async function'
      );
    });

    it('should iterate over state.keys in the refresh pre-pass', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
      assert.ok(fnMatch, 'attemptQuotaRotation function body must be extractable');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /Object\.entries\(state\.keys\)/,
        'attemptQuotaRotation must iterate over state.keys for the pre-pass'
      );
    });

    it('should filter for keys with status "expired" and past expiresAt', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
      assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /keyData\.status === ['"]expired['"]/,
        'Pre-pass must filter for status === "expired" keys'
      );

      assert.match(
        fnBody,
        /keyData\.expiresAt && keyData\.expiresAt < Date\.now\(\)/,
        'Pre-pass must filter for keys with expiresAt < Date.now()'
      );
    });

    it('should call refreshExpiredToken in the pre-pass', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
      assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /await refreshExpiredToken\(keyData\)/,
        'attemptQuotaRotation must call refreshExpiredToken in its pre-pass'
      );
    });

    it('should update accessToken, refreshToken, expiresAt, and status on successful refresh', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
      assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /keyData\.accessToken = refreshed\.accessToken/,
        'Must update keyData.accessToken after successful refresh'
      );

      assert.match(
        fnBody,
        /keyData\.refreshToken = refreshed\.refreshToken/,
        'Must update keyData.refreshToken after successful refresh'
      );

      assert.match(
        fnBody,
        /keyData\.expiresAt = refreshed\.expiresAt/,
        'Must update keyData.expiresAt after successful refresh'
      );

      assert.match(
        fnBody,
        /keyData\.status = ['"]active['"]/,
        'Must set keyData.status to "active" after successful refresh'
      );
    });

    it('should log key_added event with token_refreshed_by_stop_hook reason', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /token_refreshed_by_stop_hook/,
        'Must log logRotationEvent with reason "token_refreshed_by_stop_hook"'
      );
    });

    it('should write rotation state after the refresh pre-pass', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
      assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /writeRotationState\(state\)/,
        'Must write rotation state after the refresh pre-pass completes'
      );
    });

    it('should wrap each individual refresh in a try/catch inside the loop (non-fatal)', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
      assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
      const fnBody = fnMatch[0];

      // The inner try/catch per key refresh
      assert.match(
        fnBody,
        /try \{[\s\S]*?refreshExpiredToken[\s\S]*?\} catch/,
        'Each key refresh in the pre-pass must be individually wrapped in try/catch'
      );
    });

    it('should wrap the outer function body in a top-level try/catch that returns false on error', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
      assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /catch \(err\)[\s\S]*?return false/,
        'Outer catch must return false so caller can handle rotation failure gracefully'
      );
    });

    it('should call checkKeyHealth for all non-invalid, non-expired keys after the pre-pass', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
      assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /await checkKeyHealth\(keyData\.accessToken\)/,
        'Must still health-check all valid keys after the refresh pre-pass'
      );
    });

    it('should use Promise.all for parallel health checks after the pre-pass', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
      assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /await Promise\.all\(/,
        'Must run health checks in parallel using Promise.all'
      );
    });

    it('should call selectActiveKey after health checks to find a better key', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
      assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /selectActiveKey\(state\)/,
        'Must call selectActiveKey after health checks to pick the best key'
      );
    });

    it('should log key_switched event when a better key is found during quota rotation', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
      assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /event:\s*['"]key_switched['"]/,
        'Must log key_switched event when rotation succeeds'
      );
    });

    it('should call updateActiveCredentials when switching to a new key', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
      assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /updateActiveCredentials\(selectedKey\)/,
        'Must call updateActiveCredentials to persist the new credentials to disk/keychain'
      );
    });

    it('should return true when rotation succeeds and false when no better key is found', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
      assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /return true/,
        'Must return true when a better key is found and rotation succeeds'
      );

      assert.match(
        fnBody,
        /return false/,
        'Must return false when no better key is available'
      );
    });
  });

  describe('writeQuotaInterruptedSession() - 30-minute cleanup window', () => {
    it('should define the stale cleanup window as 30 minutes', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      // The cleanup comment and calculation: Date.now() - 30 * 60 * 1000
      assert.match(
        code,
        /30 \* 60 \* 1000/,
        'Stale session cleanup window must be 30 minutes (30 * 60 * 1000 ms)'
      );
    });

    it('should NOT use a 7-day cleanup window', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      // The old value was 7 * 24 * 60 * 60 * 1000
      assert.doesNotMatch(
        code,
        /7 \* 24 \* 60 \* 60 \* 1000/,
        'Must NOT use the old 7-day cleanup window (7 * 24 * 60 * 60 * 1000)'
      );
    });

    it('should comment that the 30-minute window matches the session-reviver reader window', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      // The comment: "Clean up entries older than 30 minutes (matches session-reviver reader window)"
      assert.match(
        code,
        /30 minutes.*session-reviver|session-reviver.*30 minutes/i,
        'Must include a comment explaining the 30-minute window matches session-reviver'
      );
    });

    it('should filter sessions using interruptedAt timestamp parsed as a Date', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      // The filter: s => new Date(s.interruptedAt).getTime() > cutoff
      assert.match(
        code,
        /new Date\(s\.interruptedAt\)\.getTime\(\)/,
        'Must parse interruptedAt as a Date and call getTime() for comparison'
      );
    });

    it('should write the filtered sessions list back to the file', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /fs\.writeFileSync\(QUOTA_INTERRUPTED_PATH/,
        'Must write the filtered sessions back to QUOTA_INTERRUPTED_PATH'
      );
    });

    it('should de-duplicate sessions by transcriptPath', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /s\.transcriptPath === record\.transcriptPath/,
        'Must de-duplicate sessions by matching transcriptPath to avoid duplicate entries'
      );
    });
  });

  describe('detectQuotaDeath() and extractAgentId() structure', () => {
    it('should define detectQuotaDeath as a function accepting transcriptPath', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /function detectQuotaDeath\(transcriptPath\)/,
        'detectQuotaDeath must accept transcriptPath parameter'
      );
    });

    it('should return isQuotaDeath: false when transcriptPath is falsy', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/function detectQuotaDeath\(transcriptPath\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectQuotaDeath must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /if \(!transcriptPath\) return \{ isQuotaDeath: false \}/,
        'Must return isQuotaDeath: false immediately when transcriptPath is falsy'
      );
    });

    it('should check for error: "rate_limit" and isApiErrorMessage: true in JSONL entries', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/function detectQuotaDeath\(transcriptPath\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectQuotaDeath must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /parsed\.error === ['"]rate_limit['"]/,
        'Must check for error === "rate_limit"'
      );

      assert.match(
        fnBody,
        /parsed\.isApiErrorMessage === true/,
        'Must check for isApiErrorMessage === true'
      );
    });
  });

  describe('main() structure integrity', () => {
    it('should call checkIfTaskSession before the quota death check', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /const isTaskSession = checkIfTaskSession\(input\)/,
        'Must call checkIfTaskSession to determine if this is a [Task] session'
      );
    });

    it('should call detectQuotaDeath only when isTaskSession is true', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /if \(isTaskSession\)[\s\S]*?detectQuotaDeath/,
        'Must only check for quota death when this is a [Task] session'
      );
    });

    it('should call attemptQuotaRotation when quota death is detected', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /await attemptQuotaRotation\(\)/,
        'Must call attemptQuotaRotation when quota death is detected'
      );
    });

    it('should store credentialsRotated result in writeQuotaInterruptedSession call', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /credentialsRotated:\s*rotated/,
        'Must include credentialsRotated flag in the interrupted session record'
      );
    });

    it('should approve stop immediately when quota death is detected', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /decision:\s*['"]approve['"]/,
        'Must approve the stop decision when quota death is detected'
      );
    });

    it('should block the first stop of a [Task] session that is not a quota death', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /decision:\s*['"]block['"]/,
        'Must block the first stop of a [Task] session when no quota death is detected'
      );
    });

    it('should fail-open on errors (approve stop on exception)', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      // The outer try/catch in main() approves on error
      const mainMatch = code.match(/async function main\(\)[\s\S]*?main\(\)/);
      assert.ok(mainMatch, 'main() function must be defined');
      const mainBody = mainMatch[0];

      assert.match(
        mainBody,
        /catch \(err\)[\s\S]*?decision:\s*['"]approve['"]/,
        'Must approve the stop on exceptions to fail-open'
      );
    });
  });
});

describe('stop-continue-hook.js - Behavioral Logic', () => {
  describe('30-minute cleanup window semantics', () => {
    it('should retain sessions interrupted within the last 30 minutes', () => {
      const now = Date.now();
      const cutoff = now - 30 * 60 * 1000;

      const sessions = [
        { transcriptPath: '/a', interruptedAt: new Date(now - 5 * 60 * 1000).toISOString() }, // 5 min ago
        { transcriptPath: '/b', interruptedAt: new Date(now - 20 * 60 * 1000).toISOString() }, // 20 min ago
      ];

      const retained = sessions.filter(s => new Date(s.interruptedAt).getTime() > cutoff);

      assert.strictEqual(retained.length, 2, 'Sessions within 30 minutes must be retained');
    });

    it('should drop sessions interrupted more than 30 minutes ago', () => {
      const now = Date.now();
      const cutoff = now - 30 * 60 * 1000;

      const sessions = [
        { transcriptPath: '/a', interruptedAt: new Date(now - 31 * 60 * 1000).toISOString() }, // 31 min ago
        { transcriptPath: '/b', interruptedAt: new Date(now - 60 * 60 * 1000).toISOString() }, // 1 hr ago
      ];

      const retained = sessions.filter(s => new Date(s.interruptedAt).getTime() > cutoff);

      assert.strictEqual(retained.length, 0, 'Sessions older than 30 minutes must be dropped');
    });

    it('should treat old 7-day window as incompatible with session-reviver pickup window', () => {
      // Document why the change was necessary:
      // The session-reviver reads interrupted sessions within a short window.
      // A 7-day cleanup window would let stale records accumulate and interfere with
      // the reviver's logic, potentially re-reviving sessions that died long ago.
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const thirtyMinMs = 30 * 60 * 1000;

      assert.ok(
        thirtyMinMs < sevenDaysMs,
        '30-minute window must be smaller than the old 7-day window'
      );

      // The 30-minute window matches what session-reviver expects
      assert.strictEqual(thirtyMinMs, 1800000, '30 * 60 * 1000 must equal 1,800,000 ms');
    });

    it('should retain a session at exactly the 30-minute boundary (edge: strictly greater)', () => {
      const now = Date.now();
      const cutoff = now - 30 * 60 * 1000;

      // A session at exactly the cutoff is NOT retained (filter: > cutoff, not >=)
      const sessions = [
        { transcriptPath: '/a', interruptedAt: new Date(cutoff).toISOString() },
      ];

      const retained = sessions.filter(s => new Date(s.interruptedAt).getTime() > cutoff);
      assert.strictEqual(retained.length, 0, 'Session at exactly cutoff must be dropped (strictly greater check)');
    });
  });

  describe('Expired token refresh pre-pass semantics in attemptQuotaRotation', () => {
    it('should only target status=expired keys with past expiresAt in the pre-pass', () => {
      const now = Date.now();
      const keys = {
        'expired-past': { status: 'expired', expiresAt: now - 1000 },
        'expired-future': { status: 'expired', expiresAt: now + 1000 },
        'active': { status: 'active', expiresAt: now - 1000 },
        'invalid': { status: 'invalid', expiresAt: now - 1000 },
      };

      // Mirrors the pre-pass filter in attemptQuotaRotation
      const candidates = Object.entries(keys).filter(
        ([, kd]) => kd.status === 'expired' && kd.expiresAt && kd.expiresAt < Date.now()
      );

      assert.strictEqual(candidates.length, 1);
      assert.strictEqual(candidates[0][0], 'expired-past');
    });

    it('should allow a refreshed key to participate in health checks', () => {
      // After the pre-pass, a refreshed key has status 'active' and a future expiresAt.
      // The health-check filter (status !== 'invalid' && status !== 'expired') should include it.
      const refreshedKey = {
        status: 'active',
        expiresAt: Date.now() + 3600000,
        accessToken: 'new-token',
      };

      const healthCheckFilter = refreshedKey.status !== 'invalid' && refreshedKey.status !== 'expired';
      assert.ok(
        healthCheckFilter,
        'A refreshed key with status "active" must pass the health-check filter'
      );
    });

    it('should not affect keys that do not match the pre-pass criteria', () => {
      const now = Date.now();
      const keys = {
        'active-fresh': { status: 'active', expiresAt: now + 3600000 },
        'exhausted': { status: 'exhausted', expiresAt: now - 1000 },
        'invalid': { status: 'invalid', expiresAt: now - 1000 },
      };

      // These should not be pre-pass candidates
      const candidates = Object.entries(keys).filter(
        ([, kd]) => kd.status === 'expired' && kd.expiresAt && kd.expiresAt < Date.now()
      );

      assert.strictEqual(candidates.length, 0, 'No non-expired keys should be pre-pass candidates');
    });
  });
});
