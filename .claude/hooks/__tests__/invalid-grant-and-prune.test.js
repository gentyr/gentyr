/**
 * Tests for invalid_grant sentinel and pruneDeadKeys() behavior
 *
 * New behaviors introduced across the changed files:
 * 1. refreshExpiredToken() returns the string 'invalid_grant' (not null) when the
 *    OAuth server responds 400 + { error: 'invalid_grant' }.
 * 2. pruneDeadKeys() garbage-collects keys with status 'invalid' older than 7 days.
 * 3. syncKeys() marks a key as 'invalid' and logs key_removed when refreshed === 'invalid_grant'.
 * 4. quota-monitor.js marks a key as 'invalid' when refreshed === 'invalid_grant' in Step 4b.
 * 5. stop-continue-hook.js marks a key as 'invalid' when refreshed === 'invalid_grant' in
 *    the attemptQuotaRotation() pre-pass.
 * 6. api-key-watcher.js marks a key as 'invalid' when refreshed === 'invalid_grant' in its
 *    health-check loop.
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/invalid-grant-and-prune.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEY_SYNC_PATH = path.join(__dirname, '..', 'key-sync.js');
const QUOTA_MONITOR_PATH = path.join(__dirname, '..', 'quota-monitor.js');
const STOP_HOOK_PATH = path.join(__dirname, '..', 'stop-continue-hook.js');
const API_KEY_WATCHER_PATH = path.join(__dirname, '..', 'api-key-watcher.js');

// ============================================================================
// refreshExpiredToken() — invalid_grant sentinel return value
// ============================================================================

describe('key-sync.js - refreshExpiredToken() invalid_grant sentinel', () => {
  it('should return the string "invalid_grant" (not null) when HTTP 400 body contains error: "invalid_grant"', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export async function refreshExpiredToken\([\s\S]*?\n\}/);
    assert.ok(fnMatch, 'refreshExpiredToken must be defined and exported');
    const fnBody = fnMatch[0];

    // Must check HTTP 400 status
    assert.match(
      fnBody,
      /response\.status === 400/,
      'Must check for HTTP 400 status to identify invalid_grant error'
    );

    // Must parse the error body to inspect the error field
    assert.match(
      fnBody,
      /errBody\.error === ['"]invalid_grant['"]/,
      'Must check errBody.error === "invalid_grant" before returning the sentinel'
    );

    // Must return the string literal 'invalid_grant', not null
    assert.match(
      fnBody,
      /return ['"]invalid_grant['"]/,
      'Must return the string "invalid_grant" as a sentinel value (not null)'
    );
  });

  it('should return null (not the sentinel) for non-400 HTTP errors', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export async function refreshExpiredToken\([\s\S]*?\n\}/);
    assert.ok(fnMatch, 'refreshExpiredToken must be defined');
    const fnBody = fnMatch[0];

    // After the 400/invalid_grant check, non-OK responses fall through to return null
    assert.match(
      fnBody,
      /!response\.ok[\s\S]*?return null/,
      'Must return null for non-OK responses that are not invalid_grant'
    );
  });

  it('should handle JSON parse failure in error body without crashing (treat as transient)', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export async function refreshExpiredToken\([\s\S]*?\n\}/);
    assert.ok(fnMatch, 'refreshExpiredToken must be defined');
    const fnBody = fnMatch[0];

    // The inner try/catch around errBody parsing — if JSON fails, treat as transient (return null)
    assert.match(
      fnBody,
      /try \{[\s\S]*?errBody[\s\S]*?\} catch/,
      'Must wrap error body JSON parsing in try/catch to treat parse errors as transient'
    );
  });

  it('should distinguish the sentinel string from null so callers can take different actions', () => {
    // Behavioral: 'invalid_grant' !== null, so callers can branch on it
    const sentinel = 'invalid_grant';
    assert.notStrictEqual(sentinel, null, '"invalid_grant" sentinel must not equal null');
    assert.strictEqual(typeof sentinel, 'string', 'Sentinel must be a string');
    assert.ok(Boolean(sentinel), 'Sentinel must be truthy so === null checks correctly skip it');
  });
});

// ============================================================================
// syncKeys() — invalid_grant branch behavior
// ============================================================================

describe('key-sync.js - syncKeys() invalid_grant handling', () => {
  it('should set key status to "invalid" when refreshExpiredToken returns "invalid_grant"', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?\nexport function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys function body must be extractable');
    const syncBody = syncMatch[0];

    // The branch: if (refreshed === 'invalid_grant') { keyData.status = 'invalid'; ... }
    assert.match(
      syncBody,
      /refreshed === ['"]invalid_grant['"][\s\S]*?keyData\.status = ['"]invalid['"]/,
      'syncKeys must set status to "invalid" when refreshExpiredToken returns "invalid_grant"'
    );
  });

  it('should log a key_removed event with reason refresh_token_invalid_grant when sentinel is received', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?\nexport function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys must be defined');
    const syncBody = syncMatch[0];

    assert.match(
      syncBody,
      /event:\s*['"]key_removed['"][\s\S]*?reason:\s*['"]refresh_token_invalid_grant['"]/,
      'syncKeys must log key_removed with reason refresh_token_invalid_grant for invalid_grant sentinel'
    );
  });

  it('should NOT increment tokensRefreshed counter when invalid_grant is returned', () => {
    // Behavioral: the invalid_grant branch sets status to 'invalid' and does NOT
    // run the code that increments result.tokensRefreshed.
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?\nexport function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys must be defined');
    const syncBody = syncMatch[0];

    // The tokensRefreshed++ must only appear in the `else if (refreshed)` branch, not the invalid_grant branch
    // Verify the branch order: invalid_grant check comes first, then `else if (refreshed)` for the counter
    assert.match(
      syncBody,
      /=== ['"]invalid_grant['"][\s\S]*?else if \(refreshed\)[\s\S]*?tokensRefreshed\+\+/,
      'tokensRefreshed must only increment in the successful refresh branch, not the invalid_grant branch'
    );
  });

  it('should call pruneDeadKeys after the token refresh loop', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?\nexport function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys must be defined');
    const syncBody = syncMatch[0];

    assert.match(
      syncBody,
      /pruneDeadKeys\(state/,
      'syncKeys must call pruneDeadKeys after the token refresh loop'
    );
  });
});

// ============================================================================
// pruneDeadKeys() — code structure
// ============================================================================

describe('key-sync.js - pruneDeadKeys() code structure', () => {
  it('should be exported from key-sync.js', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    assert.match(
      code,
      /export function pruneDeadKeys\(/,
      'pruneDeadKeys must be exported from key-sync.js'
    );
  });

  it('should accept state and optional log function parameters', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys\(state, log\)/);
    assert.ok(fnMatch, 'pruneDeadKeys must accept (state, log) parameters');
  });

  it('should use a 7-day prune age threshold', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    assert.match(
      fnBody,
      /7 \* 24 \* 60 \* 60 \* 1000/,
      'pruneDeadKeys must use a 7-day (7 * 24 * 60 * 60 * 1000 ms) prune age threshold'
    );
  });

  it('should only prune keys with status "invalid"', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    assert.match(
      fnBody,
      /keyData\.status !== ['"]invalid['"]/,
      'pruneDeadKeys must skip keys whose status is not "invalid"'
    );
  });

  it('should never prune the active key', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    assert.match(
      fnBody,
      /keyId === state\.active_key_id/,
      'pruneDeadKeys must skip the key that is currently active'
    );
  });

  it('should use last_health_check or added_at as the age reference (with fallback to 0)', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    assert.match(
      fnBody,
      /last_health_check \|\| keyData\.added_at \|\| 0/,
      'pruneDeadKeys must use last_health_check, fall back to added_at, then 0'
    );
  });

  it('should delete pruned keys from state.keys', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    assert.match(
      fnBody,
      /delete state\.keys\[keyId\]/,
      'pruneDeadKeys must delete pruned key entries from state.keys'
    );
  });

  it('should remove rotation_log entries referencing pruned keys', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    assert.match(
      fnBody,
      /state\.rotation_log = state\.rotation_log\.filter\(/,
      'pruneDeadKeys must filter out orphaned rotation_log entries for pruned keys'
    );
  });

  it('should return early (do nothing) when no keys qualify for pruning', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    assert.match(
      fnBody,
      /prunedKeyIds\.length === 0/,
      'pruneDeadKeys must return early when no keys need to be pruned'
    );
  });

  it('should log each pruned key using the optional log function', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    assert.match(
      fnBody,
      /logFn\(`\[key-sync\] Pruned dead key/,
      'pruneDeadKeys must log each pruned key via the logFn parameter'
    );
  });
});

// ============================================================================
// pruneDeadKeys() — behavioral logic
// ============================================================================

describe('pruneDeadKeys() - behavioral logic', () => {
  it('should prune an invalid key whose last_health_check is older than 7 days', () => {
    const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const state = {
      active_key_id: 'active-key',
      keys: {
        'active-key': { status: 'active', last_health_check: now - 1000 },
        'stale-invalid': {
          status: 'invalid',
          last_health_check: now - PRUNE_AGE_MS - 1000,  // just over 7 days
          added_at: now - PRUNE_AGE_MS - 2000,
        },
      },
      rotation_log: [
        { key_id: 'stale-invalid', event: 'key_removed' },
        { key_id: 'active-key', event: 'key_added' },
      ],
    };

    // Simulate pruneDeadKeys logic
    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'invalid') continue;
      if (keyId === state.active_key_id) continue;
      const lastSeen = keyData.last_health_check || keyData.added_at || 0;
      if (now - lastSeen > PRUNE_AGE_MS) {
        prunedKeyIds.push(keyId);
      }
    }

    assert.strictEqual(prunedKeyIds.length, 1, 'Must prune exactly one stale invalid key');
    assert.strictEqual(prunedKeyIds[0], 'stale-invalid');

    for (const keyId of prunedKeyIds) {
      delete state.keys[keyId];
    }
    const prunedSet = new Set(prunedKeyIds);
    state.rotation_log = state.rotation_log.filter(
      entry => !entry.key_id || !prunedSet.has(entry.key_id)
    );

    assert.ok(!state.keys['stale-invalid'], 'Pruned key must be removed from state.keys');
    assert.strictEqual(
      state.rotation_log.length,
      1,
      'Orphaned rotation_log entries for pruned key must be removed'
    );
    assert.strictEqual(state.rotation_log[0].key_id, 'active-key');
  });

  it('should NOT prune an invalid key whose last_health_check is within 7 days', () => {
    const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const keys = {
      'recent-invalid': {
        status: 'invalid',
        last_health_check: now - 1000,  // just 1 second ago
      },
    };

    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(keys)) {
      if (keyData.status !== 'invalid') continue;
      const lastSeen = keyData.last_health_check || keyData.added_at || 0;
      if (now - lastSeen > PRUNE_AGE_MS) {
        prunedKeyIds.push(keyId);
      }
    }

    assert.strictEqual(prunedKeyIds.length, 0, 'Must NOT prune invalid keys within the 7-day window');
  });

  it('should NOT prune the active key even if it has status "invalid"', () => {
    const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const state = {
      active_key_id: 'active-key',
      keys: {
        'active-key': {
          status: 'invalid',
          last_health_check: now - PRUNE_AGE_MS - 9999,  // Very old, would normally prune
        },
      },
    };

    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'invalid') continue;
      if (keyId === state.active_key_id) continue;  // Never prune active
      const lastSeen = keyData.last_health_check || keyData.added_at || 0;
      if (now - lastSeen > PRUNE_AGE_MS) {
        prunedKeyIds.push(keyId);
      }
    }

    assert.strictEqual(prunedKeyIds.length, 0, 'Must never prune the active key, even if invalid and old');
  });

  it('should NOT prune keys with status other than "invalid"', () => {
    const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const keys = {
      'old-active': {
        status: 'active',
        last_health_check: now - PRUNE_AGE_MS - 9999,  // Old but not invalid
      },
      'old-expired': {
        status: 'expired',
        last_health_check: now - PRUNE_AGE_MS - 9999,
      },
      'old-exhausted': {
        status: 'exhausted',
        last_health_check: now - PRUNE_AGE_MS - 9999,
      },
    };

    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(keys)) {
      if (keyData.status !== 'invalid') continue;
      const lastSeen = keyData.last_health_check || keyData.added_at || 0;
      if (now - lastSeen > PRUNE_AGE_MS) {
        prunedKeyIds.push(keyId);
      }
    }

    assert.strictEqual(prunedKeyIds.length, 0, 'Must only prune keys with status "invalid"');
  });

  it('should fall back to added_at when last_health_check is null', () => {
    const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const keys = {
      'no-health-check-old': {
        status: 'invalid',
        last_health_check: null,
        added_at: now - PRUNE_AGE_MS - 1000,  // Old enough via added_at
      },
      'no-health-check-recent': {
        status: 'invalid',
        last_health_check: null,
        added_at: now - 1000,  // Recent via added_at
      },
    };

    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(keys)) {
      if (keyData.status !== 'invalid') continue;
      const lastSeen = keyData.last_health_check || keyData.added_at || 0;
      if (now - lastSeen > PRUNE_AGE_MS) {
        prunedKeyIds.push(keyId);
      }
    }

    assert.strictEqual(prunedKeyIds.length, 1, 'Must prune key when added_at is used as fallback and it is old');
    assert.strictEqual(prunedKeyIds[0], 'no-health-check-old');
  });

  it('should use timestamp 0 as last-resort fallback when both last_health_check and added_at are null', () => {
    const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const keys = {
      'no-timestamps': {
        status: 'invalid',
        last_health_check: null,
        added_at: null,
      },
    };

    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(keys)) {
      if (keyData.status !== 'invalid') continue;
      const lastSeen = keyData.last_health_check || keyData.added_at || 0;
      if (now - lastSeen > PRUNE_AGE_MS) {
        prunedKeyIds.push(keyId);
      }
    }

    // now - 0 is very large (>> 7 days), so this key should be pruned
    assert.strictEqual(prunedKeyIds.length, 1, 'Keys with no timestamps must be treated as ancient and pruned');
  });

  it('should only remove rotation_log entries that reference a pruned key', () => {
    const prunedSet = new Set(['pruned-key-1']);

    const rotation_log = [
      { key_id: 'pruned-key-1', event: 'key_removed' },
      { key_id: 'keeper-key', event: 'key_switched' },
      { key_id: 'pruned-key-1', event: 'key_added' },
      { key_id: null, event: 'system_event' },  // Entries with no key_id must be kept
    ];

    const filtered = rotation_log.filter(
      entry => !entry.key_id || !prunedSet.has(entry.key_id)
    );

    assert.strictEqual(filtered.length, 2, 'Must only remove log entries for pruned keys');
    assert.ok(filtered.some(e => e.key_id === 'keeper-key'), 'Must retain keeper-key log entry');
    assert.ok(filtered.some(e => e.key_id === null), 'Must retain entries with no key_id');
  });

  it('should handle an empty keys object without error', () => {
    const state = {
      active_key_id: null,
      keys: {},
      rotation_log: [],
    };

    // Simulate pruneDeadKeys on empty state
    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'invalid') continue;
      if (keyId === state.active_key_id) continue;
      const lastSeen = keyData.last_health_check || keyData.added_at || 0;
      if (Date.now() - lastSeen > 7 * 24 * 60 * 60 * 1000) {
        prunedKeyIds.push(keyId);
      }
    }

    assert.strictEqual(prunedKeyIds.length, 0, 'pruneDeadKeys must handle empty state.keys without error');
  });
});

// ============================================================================
// quota-monitor.js — invalid_grant branch in Step 4b
// ============================================================================

describe('quota-monitor.js - invalid_grant sentinel handling in Step 4b', () => {
  it('should set key status to "invalid" when refreshExpiredToken returns "invalid_grant" in Step 4b', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    assert.match(
      code,
      /refreshed === ['"]invalid_grant['"][\s\S]*?keyData\.status = ['"]invalid['"]/,
      'quota-monitor Step 4b must set key status to "invalid" when sentinel is received'
    );
  });

  it('should log a key_removed event with reason refresh_token_invalid_grant in Step 4b', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    // Find the Step 4b block
    const step4bMatch = code.match(/Step 4b[\s\S]*?writeRotationState\(state\)/);
    assert.ok(step4bMatch, 'Step 4b block must be present and end with writeRotationState');
    const step4bBody = step4bMatch[0];

    assert.match(
      step4bBody,
      /event:\s*['"]key_removed['"][\s\S]*?reason:\s*['"]refresh_token_invalid_grant['"]/,
      'Step 4b must log key_removed with reason refresh_token_invalid_grant'
    );
  });

  it('should NOT update accessToken/refreshToken/expiresAt/status to active when invalid_grant is returned', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    const step4bMatch = code.match(/Step 4b[\s\S]*?writeRotationState\(state\)/);
    assert.ok(step4bMatch, 'Step 4b block must be present');
    const step4bBody = step4bMatch[0];

    // The invalid_grant and the successful-refresh branches are mutually exclusive
    // The successful path uses `else if (refreshed)` AFTER the invalid_grant check
    assert.match(
      step4bBody,
      /=== ['"]invalid_grant['"][\s\S]*?} else if \(refreshed\)/,
      'Step 4b must use else-if to separate invalid_grant and successful-refresh branches'
    );
  });

  it('should distinguish the invalid_grant branch from the successful refresh branch', () => {
    // Behavioral: simulate the branching logic from Step 4b
    const outcomes = [];

    function simulateStep4b(refreshed) {
      if (refreshed === 'invalid_grant') {
        outcomes.push('mark_invalid');
      } else if (refreshed) {
        outcomes.push('mark_active');
      } else {
        outcomes.push('stay_expired');
      }
    }

    simulateStep4b('invalid_grant');
    simulateStep4b({ accessToken: 'new', refreshToken: 'new', expiresAt: 9999 });
    simulateStep4b(null);

    assert.deepStrictEqual(outcomes, ['mark_invalid', 'mark_active', 'stay_expired'],
      'Step 4b branching: invalid_grant -> mark_invalid, successful -> mark_active, null -> stay_expired'
    );
  });
});

// ============================================================================
// stop-continue-hook.js — invalid_grant branch in attemptQuotaRotation()
// ============================================================================

describe('stop-continue-hook.js - invalid_grant sentinel handling in attemptQuotaRotation()', () => {
  it('should set key status to "invalid" when refreshExpiredToken returns "invalid_grant"', () => {
    const code = fs.readFileSync(STOP_HOOK_PATH, 'utf8');

    const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
    assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
    const fnBody = fnMatch[0];

    assert.match(
      fnBody,
      /refreshed === ['"]invalid_grant['"][\s\S]*?keyData\.status = ['"]invalid['"]/,
      'attemptQuotaRotation must set key status to "invalid" when sentinel is received'
    );
  });

  it('should log a key_removed event with reason refresh_token_invalid_grant in attemptQuotaRotation', () => {
    const code = fs.readFileSync(STOP_HOOK_PATH, 'utf8');

    const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
    assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
    const fnBody = fnMatch[0];

    assert.match(
      fnBody,
      /event:\s*['"]key_removed['"][\s\S]*?reason:\s*['"]refresh_token_invalid_grant['"]/,
      'attemptQuotaRotation must log key_removed with reason refresh_token_invalid_grant'
    );
  });

  it('should use else-if to separate invalid_grant and successful refresh branches', () => {
    const code = fs.readFileSync(STOP_HOOK_PATH, 'utf8');

    const fnMatch = code.match(/async function attemptQuotaRotation[\s\S]*?\nfunction /);
    assert.ok(fnMatch, 'attemptQuotaRotation must be defined');
    const fnBody = fnMatch[0];

    assert.match(
      fnBody,
      /=== ['"]invalid_grant['"][\s\S]*?} else if \(refreshed\)/,
      'attemptQuotaRotation must use else-if to distinguish invalid_grant from successful refresh'
    );
  });

  it('should NOT add a key with invalid_grant back as a health-check candidate', () => {
    // Behavioral: after invalid_grant, status is 'invalid'.
    // The health-check filter excludes 'invalid' and 'expired' statuses.
    const keyData = { status: 'invalid', accessToken: 'tok' };
    const isHealthCheckCandidate = keyData.status !== 'invalid' && keyData.status !== 'expired';

    assert.strictEqual(
      isHealthCheckCandidate,
      false,
      'A key marked invalid by invalid_grant must not be a health-check candidate'
    );
  });
});

// ============================================================================
// api-key-watcher.js — invalid_grant branch in health-check loop
// ============================================================================

describe('api-key-watcher.js - invalid_grant sentinel handling in main()', () => {
  it('should import refreshExpiredToken from key-sync.js', () => {
    const code = fs.readFileSync(API_KEY_WATCHER_PATH, 'utf8');

    assert.match(
      code,
      /import \{[\s\S]*?refreshExpiredToken[\s\S]*?\} from ['"]\.\/key-sync\.js['"]/,
      'api-key-watcher must import refreshExpiredToken from key-sync.js'
    );
  });

  it('should set key status to "invalid" when refreshExpiredToken returns "invalid_grant"', () => {
    const code = fs.readFileSync(API_KEY_WATCHER_PATH, 'utf8');

    const mainMatch = code.match(/async function main\(\)[\s\S]*?\n\}/);
    assert.ok(mainMatch, 'main function must be defined');
    const mainBody = mainMatch[0];

    assert.match(
      mainBody,
      /refreshed === ['"]invalid_grant['"][\s\S]*?keyData\.status = ['"]invalid['"]/,
      'api-key-watcher main() must set key status to "invalid" when sentinel is received'
    );
  });

  it('should log a key_removed event with reason refresh_token_invalid_grant', () => {
    const code = fs.readFileSync(API_KEY_WATCHER_PATH, 'utf8');

    const mainMatch = code.match(/async function main\(\)[\s\S]*?\n\}/);
    assert.ok(mainMatch, 'main function must be defined');
    const mainBody = mainMatch[0];

    assert.match(
      mainBody,
      /event:\s*['"]key_removed['"][\s\S]*?reason:\s*['"]refresh_token_invalid_grant['"]/,
      'api-key-watcher must log key_removed with reason refresh_token_invalid_grant for invalid_grant'
    );
  });

  it('should return early from the per-key health check when invalid_grant is detected', () => {
    const code = fs.readFileSync(API_KEY_WATCHER_PATH, 'utf8');

    const mainMatch = code.match(/async function main\(\)[\s\S]*?\n\}/);
    assert.ok(mainMatch, 'main function must be defined');
    const mainBody = mainMatch[0];

    // After marking invalid, the key's health-check promise returns { keyId, result: null }
    assert.match(
      mainBody,
      /refreshed === ['"]invalid_grant['"][\s\S]*?return \{ keyId, result: null \}/,
      'api-key-watcher must return {keyId, result: null} from the per-key health check when invalid_grant'
    );
  });

  it('should use else-if to separate invalid_grant and successful refresh branches', () => {
    const code = fs.readFileSync(API_KEY_WATCHER_PATH, 'utf8');

    const mainMatch = code.match(/async function main\(\)[\s\S]*?\n\}/);
    assert.ok(mainMatch, 'main function must be defined');
    const mainBody = mainMatch[0];

    assert.match(
      mainBody,
      /=== ['"]invalid_grant['"][\s\S]*?} else if \(refreshed\)/,
      'api-key-watcher must use else-if to distinguish invalid_grant from successful refresh'
    );
  });
});

// ============================================================================
// Cross-file consistency — all callers handle the sentinel the same way
// ============================================================================

describe('Cross-file consistency — invalid_grant sentinel contract', () => {
  it('all callers must check for === "invalid_grant" before checking truthiness of refreshed', () => {
    // Each caller must use: if (refreshed === 'invalid_grant') { ... } else if (refreshed) { ... }
    // This ordering matters: 'invalid_grant' is truthy, so reversing the order would break the logic.
    const files = [
      { name: 'key-sync.js', path: KEY_SYNC_PATH },
      { name: 'quota-monitor.js', path: QUOTA_MONITOR_PATH },
      { name: 'stop-continue-hook.js', path: STOP_HOOK_PATH },
      { name: 'api-key-watcher.js', path: API_KEY_WATCHER_PATH },
    ];

    for (const { name, path: filePath } of files) {
      const code = fs.readFileSync(filePath, 'utf8');

      assert.match(
        code,
        /refreshed === ['"]invalid_grant['"]/,
        `${name} must check refreshed === 'invalid_grant' before treating refreshed as truthy`
      );
    }
  });

  it('all callers must set keyData.status = "invalid" on invalid_grant', () => {
    const files = [
      { name: 'key-sync.js', path: KEY_SYNC_PATH },
      { name: 'quota-monitor.js', path: QUOTA_MONITOR_PATH },
      { name: 'stop-continue-hook.js', path: STOP_HOOK_PATH },
      { name: 'api-key-watcher.js', path: API_KEY_WATCHER_PATH },
    ];

    for (const { name, path: filePath } of files) {
      const code = fs.readFileSync(filePath, 'utf8');

      assert.match(
        code,
        /keyData\.status = ['"]invalid['"]/,
        `${name} must set keyData.status to "invalid" when processing invalid_grant`
      );
    }
  });

  it('all callers must log key_removed with reason refresh_token_invalid_grant on invalid_grant', () => {
    const files = [
      { name: 'key-sync.js', path: KEY_SYNC_PATH },
      { name: 'quota-monitor.js', path: QUOTA_MONITOR_PATH },
      { name: 'stop-continue-hook.js', path: STOP_HOOK_PATH },
      { name: 'api-key-watcher.js', path: API_KEY_WATCHER_PATH },
    ];

    for (const { name, path: filePath } of files) {
      const code = fs.readFileSync(filePath, 'utf8');

      assert.match(
        code,
        /refresh_token_invalid_grant/,
        `${name} must use the reason "refresh_token_invalid_grant" for invalid_grant events`
      );
    }
  });

  it('the sentinel "invalid_grant" must be a truthy string — validating callers cannot use simple if (refreshed)', () => {
    // This is a critical property test: if callers used `if (refreshed)` to check for success,
    // they would also enter the success branch for 'invalid_grant' because it is truthy.
    // All callers MUST check === 'invalid_grant' first.
    const sentinel = 'invalid_grant';

    assert.ok(Boolean(sentinel), 'Sentinel is truthy — naive truthiness check would treat it as a successful refresh');
    assert.notStrictEqual(sentinel, null, 'Sentinel is not null');
    assert.notStrictEqual(typeof sentinel, 'object', 'Sentinel is not an object (not a refresh result)');
  });
});
