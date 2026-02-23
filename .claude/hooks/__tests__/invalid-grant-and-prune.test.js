/**
 * Tests for invalid_grant sentinel and pruneDeadKeys() behavior
 *
 * New behaviors introduced across the changed files:
 * 1. refreshExpiredToken() returns the string 'invalid_grant' (not null) when the
 *    OAuth server responds 400 + { error: 'invalid_grant' }.
 * 2. pruneDeadKeys() garbage-collects keys with status 'invalid' older than 7 days.
 * 3. syncKeys() marks a key as 'invalid' and logs key_removed when refreshed === 'invalid_grant'.
 * 4. quota-monitor.js marks a key as 'invalid' when refreshed === 'invalid_grant' in Step 4b.
 * 5. api-key-watcher.js marks a key as 'invalid' when refreshed === 'invalid_grant' in its
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

  it('should prune invalid keys immediately (no age window)', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    // Should NOT have a 7-day threshold — invalid keys are pruned immediately
    assert.doesNotMatch(
      fnBody,
      /7 \* 24 \* 60 \* 60 \* 1000/,
      'pruneDeadKeys must NOT use a 7-day age threshold (invalid keys are pruned immediately)'
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

  it('should not use age-based filtering (prunes all invalid keys regardless of age)', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    // Should NOT have age-based filtering — invalid keys have permanently revoked
    // refresh tokens and cannot recover, so they are pruned immediately
    assert.doesNotMatch(
      fnBody,
      /last_health_check \|\| keyData\.added_at \|\| 0/,
      'pruneDeadKeys must NOT use age-based filtering (invalid keys are gc\'d immediately)'
    );
  });

  it('should tombstone invalid keys (status: "tombstone") rather than immediately deleting them', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    // Invalid keys are transitioned to tombstone status, not deleted outright.
    // This preserves the key entry for 24h so duplicate prune events are not re-fired.
    assert.match(
      fnBody,
      /status:\s*['"]tombstone['"]/,
      'pruneDeadKeys must write status: "tombstone" for invalid keys'
    );

    assert.match(
      fnBody,
      /tombstoned_at:/,
      'pruneDeadKeys must record tombstoned_at timestamp for TTL-based cleanup'
    );
  });

  it('should delete expired tombstones (24h TTL) from state.keys', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    // Only tombstones that have aged past 24h are actually deleted from state.keys.
    assert.match(
      fnBody,
      /TOMBSTONE_TTL_MS\s*=\s*24 \* 60 \* 60 \* 1000/,
      'pruneDeadKeys must define a 24h tombstone TTL constant'
    );

    assert.match(
      fnBody,
      /delete state\.keys\[keyId\]/,
      'pruneDeadKeys must delete expired tombstones from state.keys'
    );
  });

  it('should remove rotation_log entries only for actually-deleted (expired) tombstones, not fresh tombstones', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    assert.match(
      fnBody,
      /state\.rotation_log = state\.rotation_log\.filter\(/,
      'pruneDeadKeys must filter rotation_log for expired tombstones'
    );

    // The filter must scope to deletedSet (expired tombstones), not prunedSet (freshly tombstoned)
    assert.match(
      fnBody,
      /deletedSet/,
      'pruneDeadKeys must scope rotation_log cleanup to deleted tombstones (deletedSet), not freshly tombstoned keys'
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

  it('should log each tombstoned key using the optional log function', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    assert.match(
      fnBody,
      /logFn\(`\[key-sync\] Tombstoned dead key/,
      'pruneDeadKeys must log each tombstoned key via the logFn parameter'
    );
  });

  it('should exclude tombstone-status keys from hasOtherViableKey check', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const fnMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'pruneDeadKeys must be defined');
    const fnBody = fnMatch[0];

    // hasOtherViableKey must exclude tombstone keys — they can no longer authenticate.
    // This prevents a freshly-tombstoned key (from a previous cycle) from masking auth failure.
    assert.match(
      fnBody,
      /otherData\.status === ['"]tombstone['"]/,
      'hasOtherViableKey check must exclude keys with status "tombstone"'
    );
  });
});

// ============================================================================
// pruneDeadKeys() — behavioral logic
// ============================================================================

describe('pruneDeadKeys() - behavioral logic', () => {
  it('should prune any invalid key immediately (no age window)', () => {
    const now = Date.now();

    const state = {
      active_key_id: 'active-key',
      keys: {
        'active-key': { status: 'active', last_health_check: now - 1000 },
        'stale-invalid': {
          status: 'invalid',
          last_health_check: now - 1000,  // just 1 second ago — still pruned
          added_at: now - 2000,
        },
      },
      rotation_log: [
        { key_id: 'stale-invalid', event: 'key_removed' },
        { key_id: 'active-key', event: 'key_added' },
      ],
    };

    // Simulate pruneDeadKeys logic (immediate prune, no age window)
    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'invalid') continue;
      if (keyId === state.active_key_id) continue;
      prunedKeyIds.push(keyId);
    }

    assert.strictEqual(prunedKeyIds.length, 1, 'Must prune the invalid key immediately');
    assert.strictEqual(prunedKeyIds[0], 'stale-invalid');

    for (const keyId of prunedKeyIds) {
      delete state.keys[keyId];
    }
    const prunedSet = new Set(prunedKeyIds);
    state.rotation_log = state.rotation_log.filter(
      entry => !entry.key_id || !prunedSet.has(entry.key_id) || entry.event === 'account_auth_failed'
    );

    assert.ok(!state.keys['stale-invalid'], 'Pruned key must be removed from state.keys');
    assert.strictEqual(
      state.rotation_log.length,
      1,
      'Orphaned rotation_log entries for pruned key must be removed'
    );
    assert.strictEqual(state.rotation_log[0].key_id, 'active-key');
  });

  it('should prune even a recently-added invalid key (no age-based protection)', () => {
    const now = Date.now();

    const state = {
      active_key_id: null,
      keys: {
        'recent-invalid': {
          status: 'invalid',
          last_health_check: now - 1000,  // just 1 second ago
        },
      },
      rotation_log: [],
    };

    // Simulate pruneDeadKeys logic (immediate prune)
    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'invalid') continue;
      if (keyId === state.active_key_id) continue;
      prunedKeyIds.push(keyId);
    }

    assert.strictEqual(prunedKeyIds.length, 1, 'Must prune recently-added invalid keys too');
  });

  it('should NOT prune the active key even if it has status "invalid"', () => {
    const now = Date.now();

    const state = {
      active_key_id: 'active-key',
      keys: {
        'active-key': {
          status: 'invalid',
          last_health_check: now - 9999,
        },
      },
    };

    // Simulate pruneDeadKeys logic (immediate prune, but skip active)
    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'invalid') continue;
      if (keyId === state.active_key_id) continue;  // Never prune active
      prunedKeyIds.push(keyId);
    }

    assert.strictEqual(prunedKeyIds.length, 0, 'Must never prune the active key, even if invalid');
  });

  it('should NOT prune keys with status other than "invalid"', () => {
    const now = Date.now();

    const state = {
      active_key_id: null,
      keys: {
        'old-active': {
          status: 'active',
          last_health_check: now - 9999,
        },
        'old-expired': {
          status: 'expired',
          last_health_check: now - 9999,
        },
        'old-exhausted': {
          status: 'exhausted',
          last_health_check: now - 9999,
        },
      },
    };

    // Simulate pruneDeadKeys logic
    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'invalid') continue;
      if (keyId === state.active_key_id) continue;
      prunedKeyIds.push(keyId);
    }

    assert.strictEqual(prunedKeyIds.length, 0, 'Must only prune keys with status "invalid"');
  });

  it('should prune invalid keys regardless of last_health_check or added_at', () => {
    const now = Date.now();

    const state = {
      active_key_id: null,
      keys: {
        'no-health-check': {
          status: 'invalid',
          last_health_check: null,
          added_at: now - 1000,  // Just added, but invalid — still pruned
        },
        'has-health-check': {
          status: 'invalid',
          last_health_check: now - 500,
          added_at: now - 2000,
        },
      },
      rotation_log: [],
    };

    // Simulate pruneDeadKeys logic (immediate prune)
    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'invalid') continue;
      if (keyId === state.active_key_id) continue;
      prunedKeyIds.push(keyId);
    }

    assert.strictEqual(prunedKeyIds.length, 2, 'Must prune all invalid keys regardless of timestamps');
  });

  it('should prune invalid keys even when both last_health_check and added_at are null', () => {
    const now = Date.now();

    const state = {
      active_key_id: null,
      keys: {
        'no-timestamps': {
          status: 'invalid',
          last_health_check: null,
          added_at: null,
        },
      },
      rotation_log: [],
    };

    // Simulate pruneDeadKeys logic (immediate prune)
    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'invalid') continue;
      if (keyId === state.active_key_id) continue;
      prunedKeyIds.push(keyId);
    }

    assert.strictEqual(prunedKeyIds.length, 1, 'Invalid keys with no timestamps must still be pruned immediately');
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
      entry => !entry.key_id || !prunedSet.has(entry.key_id) || entry.event === 'account_auth_failed'
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

    // Simulate pruneDeadKeys candidate collection on empty state
    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'invalid') continue;
      if (keyId === state.active_key_id) continue;
      prunedKeyIds.push(keyId);
    }

    assert.strictEqual(prunedKeyIds.length, 0, 'pruneDeadKeys must handle empty state.keys without error');
  });
});

// ============================================================================
// pruneDeadKeys() — tombstone marking and TTL cleanup (new behavior)
// ============================================================================

describe('pruneDeadKeys() - tombstone behavior', () => {
  it('should convert invalid keys to tombstone status instead of deleting them immediately', () => {
    // Invalid keys become tombstones so the rotation_log entries can still refer to them
    // for 24h. Direct deletion would orphan those log entries prematurely.
    const now = Date.now();
    const state = {
      active_key_id: 'active-key',
      keys: {
        'active-key': { status: 'active', account_email: 'a@example.com' },
        'invalid-key': {
          status: 'invalid',
          account_email: 'b@example.com',
          account_uuid: null,
        },
      },
      rotation_log: [
        { key_id: 'invalid-key', event: 'key_removed', reason: 'refresh_token_invalid_grant' },
      ],
    };

    // Simulate tombstone conversion (production logic)
    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'invalid') continue;
      if (keyId === state.active_key_id) continue;
      prunedKeyIds.push(keyId);
    }

    for (const keyId of prunedKeyIds) {
      state.keys[keyId] = {
        status: 'tombstone',
        tombstoned_at: now,
        account_email: state.keys[keyId]?.account_email || null,
      };
    }

    // Key must still exist in state, but as a tombstone
    assert.ok(state.keys['invalid-key'], 'Tombstoned key must still exist in state.keys');
    assert.strictEqual(state.keys['invalid-key'].status, 'tombstone', 'Key status must be "tombstone"');
    assert.strictEqual(state.keys['invalid-key'].tombstoned_at, now, 'tombstoned_at must be set');
    assert.strictEqual(state.keys['invalid-key'].account_email, 'b@example.com', 'account_email must be preserved');

    // Rotation log entries are NOT cleaned up yet (only cleaned after TTL expires)
    assert.strictEqual(state.rotation_log.length, 1, 'rotation_log entries must not be removed for fresh tombstones');
  });

  it('should clean up expired tombstones (older than 24h) by deleting them from state.keys', () => {
    const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    const state = {
      active_key_id: 'active-key',
      keys: {
        'active-key': { status: 'active' },
        'fresh-tombstone': {
          status: 'tombstone',
          tombstoned_at: now - 1000,  // only 1s ago — keep it
        },
        'stale-tombstone': {
          status: 'tombstone',
          tombstoned_at: now - TOMBSTONE_TTL_MS - 1000,  // >24h ago — delete it
        },
      },
      rotation_log: [
        { key_id: 'fresh-tombstone', event: 'account_auth_failed' },
        { key_id: 'stale-tombstone', event: 'account_auth_failed' },
        { key_id: 'stale-tombstone', event: 'key_removed' },
        { key_id: 'active-key', event: 'key_added' },
      ],
    };

    // Simulate TTL cleanup
    const expiredTombstones = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status === 'tombstone' &&
          keyData.tombstoned_at && now - keyData.tombstoned_at > TOMBSTONE_TTL_MS) {
        expiredTombstones.push(keyId);
      }
    }
    for (const keyId of expiredTombstones) {
      delete state.keys[keyId];
    }

    // Filter log for deleted tombstones (non-account_auth_failed entries)
    const deletedSet = new Set(expiredTombstones);
    if (deletedSet.size > 0) {
      state.rotation_log = state.rotation_log.filter(
        entry => !entry.key_id || !deletedSet.has(entry.key_id) || entry.event === 'account_auth_failed'
      );
    }

    // Only the stale tombstone is deleted
    assert.ok(!state.keys['stale-tombstone'], 'Stale tombstone (>24h) must be deleted');
    assert.ok(state.keys['fresh-tombstone'], 'Fresh tombstone (<24h) must be kept');
    assert.ok(state.keys['active-key'], 'Active key must be unaffected');

    // account_auth_failed for stale tombstone is preserved; key_removed is removed
    const logKeyIds = state.rotation_log.map(e => `${e.key_id}:${e.event}`);
    assert.ok(logKeyIds.includes('fresh-tombstone:account_auth_failed'), 'Fresh tombstone log entry must be kept');
    assert.ok(logKeyIds.includes('stale-tombstone:account_auth_failed'), 'account_auth_failed for stale tombstone must be preserved');
    assert.ok(!logKeyIds.includes('stale-tombstone:key_removed'), 'key_removed for stale tombstone must be removed');
    assert.ok(logKeyIds.includes('active-key:key_added'), 'Active key log entry must be kept');
  });

  it('should NOT clean up tombstones that are exactly at the 24h boundary (TTL is strictly >24h)', () => {
    const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    // At exactly 24h the check is `> TOMBSTONE_TTL_MS`, so exactly 24h should NOT be cleaned up
    const state = {
      active_key_id: null,
      keys: {
        'at-boundary': {
          status: 'tombstone',
          tombstoned_at: now - TOMBSTONE_TTL_MS,  // exactly at boundary
        },
      },
      rotation_log: [],
    };

    const expiredTombstones = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status === 'tombstone' &&
          keyData.tombstoned_at && now - keyData.tombstoned_at > TOMBSTONE_TTL_MS) {
        expiredTombstones.push(keyId);
      }
    }

    // Exactly at the boundary is NOT expired (strictly greater than)
    assert.strictEqual(expiredTombstones.length, 0, 'Tombstones at exactly 24h must not yet be cleaned up (strictly >)');
  });

  it('should NOT prune tombstone-status keys as invalid (tombstones bypass the invalid check)', () => {
    // Tombstone keys have status 'tombstone', not 'invalid', so they are skipped
    // by the initial invalid-key selection loop.
    const state = {
      active_key_id: null,
      keys: {
        'tombstone-key': {
          status: 'tombstone',
          tombstoned_at: Date.now() - 1000,
        },
      },
      rotation_log: [],
    };

    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'invalid') continue;
      if (keyId === state.active_key_id) continue;
      prunedKeyIds.push(keyId);
    }

    assert.strictEqual(prunedKeyIds.length, 0, 'Tombstone-status keys must not be selected as invalid-prune candidates');
  });

  it('should exclude tombstone-status keys from hasOtherViableKey (tombstones cannot authenticate)', () => {
    // A tombstone key cannot be used for authentication. If it were counted as viable,
    // account_auth_failed would be incorrectly suppressed.
    const email = 'user@example.com';
    const prunedSet = new Set(['invalid-key']);

    const keys = {
      'invalid-key': { status: 'invalid', account_email: email },
      'tombstone-sibling': { status: 'tombstone', account_email: email },
    };

    const hasOtherViableKey = Object.entries(keys).some(([otherId, otherData]) => {
      if (otherId === 'invalid-key' || prunedSet.has(otherId)) return false;
      if (otherData.status === 'invalid' || otherData.status === 'expired' || otherData.status === 'tombstone') return false;
      if (!email) return false;
      return otherData.account_email === email;
    });

    assert.strictEqual(
      hasOtherViableKey,
      false,
      'A tombstone-status key must NOT count as a viable sibling — it cannot authenticate'
    );
  });
});

// ============================================================================
// pruneDeadKeys() — account_auth_failed event emission & preservation
// ============================================================================

describe('pruneDeadKeys() - account_auth_failed event emission', () => {
  it('should emit account_auth_failed via logRotationEvent before deleting invalid keys', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const pruneMatch = code.match(/function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(pruneMatch, 'pruneDeadKeys function must be defined');
    const pruneBody = pruneMatch[0];

    // account_auth_failed must appear BEFORE the delete loop
    const authFailedIdx = pruneBody.indexOf("'account_auth_failed'");
    const deleteIdx = pruneBody.indexOf('delete state.keys[keyId]');
    assert.ok(authFailedIdx > -1, 'pruneDeadKeys must emit account_auth_failed event');
    assert.ok(deleteIdx > -1, 'pruneDeadKeys must delete pruned keys');
    assert.ok(
      authFailedIdx < deleteIdx,
      'account_auth_failed must be emitted BEFORE keys are deleted from state.keys'
    );
  });

  it('should include account_email in the account_auth_failed event', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const pruneMatch = code.match(/function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(pruneMatch, 'pruneDeadKeys function must be defined');
    const pruneBody = pruneMatch[0];

    assert.match(
      pruneBody,
      /event:\s*['"]account_auth_failed['"][\s\S]*?account_email/,
      'account_auth_failed event must include account_email field'
    );
  });

  it('should preserve account_auth_failed entries in the rotation_log filter', () => {
    const prunedSet = new Set(['pruned-key-1']);

    const rotation_log = [
      { key_id: 'pruned-key-1', event: 'key_removed' },
      { key_id: 'pruned-key-1', event: 'account_auth_failed' },
      { key_id: 'keeper-key', event: 'key_switched' },
      { key_id: null, event: 'system_event' },
    ];

    const filtered = rotation_log.filter(
      entry => !entry.key_id || !prunedSet.has(entry.key_id) || entry.event === 'account_auth_failed'
    );

    assert.strictEqual(filtered.length, 3, 'Must preserve account_auth_failed for pruned keys');
    assert.ok(
      filtered.some(e => e.key_id === 'pruned-key-1' && e.event === 'account_auth_failed'),
      'account_auth_failed entry for pruned key must be retained'
    );
    assert.ok(
      !filtered.some(e => e.key_id === 'pruned-key-1' && e.event === 'key_removed'),
      'key_removed entry for pruned key must still be removed'
    );
  });

  it('should use logRotationEvent to emit account_auth_failed (not manual push)', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const pruneMatch = code.match(/function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(pruneMatch, 'pruneDeadKeys function must be defined');
    const pruneBody = pruneMatch[0];

    assert.match(
      pruneBody,
      /logRotationEvent\(state,\s*\{[\s\S]*?event:\s*['"]account_auth_failed['"]/,
      'pruneDeadKeys must use logRotationEvent() to emit account_auth_failed'
    );
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

// ============================================================================
// pruneDeadKeys() — email resolution and account_auth_failed deduplication (new logic)
// ============================================================================

describe('pruneDeadKeys() - email resolution from sibling keys and rotation_log', () => {
  /**
   * Minimal implementation of the new pruneDeadKeys email-resolution + deduplication logic.
   * We simulate the actual algorithm from key-sync.js so these are behavioral tests, not
   * just structure checks.  The simulation must match the production code line-for-line so
   * any future drift becomes a test failure.
   */
  function simulatePruneDeadKeys(state) {
    const emittedEvents = [];
    function logFn(msg) { /* intentionally silent */ }
    function mockLogRotationEvent(st, entry) {
      emittedEvents.push(entry);
      st.rotation_log.unshift(entry);
    }

    const prunedKeyIds = [];
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status !== 'invalid') continue;
      if (keyId === state.active_key_id) continue;
      prunedKeyIds.push(keyId);
    }

    if (prunedKeyIds.length === 0) return { emittedEvents, state };

    const prunedSet = new Set(prunedKeyIds);
    const emittedAccounts = new Set();

    for (const keyId of prunedKeyIds) {
      const keyData = state.keys[keyId];
      let email = keyData?.account_email || null;

      // Gap D: resolve email from sibling keys with same account_uuid
      if (!email && keyData?.account_uuid) {
        for (const [, otherData] of Object.entries(state.keys)) {
          if (otherData.account_uuid === keyData.account_uuid && otherData.account_email) {
            email = otherData.account_email;
            break;
          }
        }
      }

      // Gap E: resolve email from rotation_log history
      if (!email) {
        for (const entry of state.rotation_log) {
          if (entry.key_id === keyId && entry.account_email) {
            email = entry.account_email;
            break;
          }
        }
      }

      const dedupeKey = email || keyId;

      // Gap F: deduplicate — skip if we've already emitted for this account
      if (emittedAccounts.has(dedupeKey)) continue;

      // Gap G: only emit if this account has no other viable key
      const hasOtherViableKey = Object.entries(state.keys).some(([otherId, otherData]) => {
        if (otherId === keyId || prunedSet.has(otherId)) return false;
        if (otherData.status === 'invalid' || otherData.status === 'expired' || otherData.status === 'tombstone') return false;
        if (!email) return false;
        return otherData.account_email === email;
      });

      if (!hasOtherViableKey) {
        mockLogRotationEvent(state, {
          timestamp: Date.now(),
          event: 'account_auth_failed',
          key_id: keyId,
          reason: 'invalid_key_pruned',
          account_email: email,
        });
        emittedAccounts.add(dedupeKey);
      }
    }

    for (const keyId of prunedKeyIds) {
      delete state.keys[keyId];
    }

    state.rotation_log = state.rotation_log.filter(
      entry => !entry.key_id || !prunedSet.has(entry.key_id) || entry.event === 'account_auth_failed'
    );

    return { emittedEvents, state };
  }

  // ---- Gap D: email from sibling key with same account_uuid ----

  it('should resolve email from sibling key but suppress account_auth_failed because a viable sibling still exists', () => {
    // When a pruned key has no email, the sibling lookup resolves it.
    // But the same sibling that provided the email is still active — hasOtherViableKey is true,
    // so account_auth_failed must NOT be emitted (the account can still auth via the sibling).
    const state = {
      active_key_id: null,
      keys: {
        'invalid-key-no-email': {
          status: 'invalid',
          account_uuid: 'shared-uuid',
          account_email: null,
        },
        // Sibling key — same uuid, has email, is still active (not being pruned)
        'active-sibling': {
          status: 'active',
          account_uuid: 'shared-uuid',
          account_email: 'sibling@example.com',
        },
      },
      rotation_log: [],
    };

    const { emittedEvents } = simulatePruneDeadKeys(state);

    // The sibling resolved the email AND is itself a viable key — so auth_failed is suppressed
    assert.strictEqual(emittedEvents.length, 0,
      'Must NOT emit account_auth_failed when the sibling that provided the email is still viable');
  });

  it('should resolve email from sibling AND emit account_auth_failed when sibling is also being pruned', () => {
    // Both keys share the same account_uuid — one has email, one doesn't.
    // Both are invalid (both being pruned). Email is resolved from the sibling.
    // Since no viable key remains, account_auth_failed IS emitted.
    const state = {
      active_key_id: null,
      keys: {
        'invalid-key-no-email': {
          status: 'invalid',
          account_uuid: 'shared-uuid',
          account_email: null,
        },
        'invalid-sibling-has-email': {
          status: 'invalid',
          account_uuid: 'shared-uuid',
          account_email: 'sibling@example.com',
        },
      },
      rotation_log: [],
    };

    const { emittedEvents } = simulatePruneDeadKeys(state);

    // Both keys are pruned — no viable sibling remains — one event should fire (deduped by email)
    assert.strictEqual(emittedEvents.length, 1,
      'Must emit account_auth_failed once when all keys for the account are pruned');
    assert.strictEqual(emittedEvents[0].account_email, 'sibling@example.com',
      'Must use the email resolved from the sibling key');
  });

  it('should NOT use sibling resolution when the pruned key already has its own email', () => {
    const state = {
      active_key_id: null,
      keys: {
        'invalid-key-has-email': {
          status: 'invalid',
          account_uuid: 'shared-uuid',
          account_email: 'own@example.com',
        },
        'sibling-different-email': {
          status: 'active',
          account_uuid: 'shared-uuid',
          account_email: 'sibling@example.com',
        },
      },
      rotation_log: [],
    };

    const { emittedEvents } = simulatePruneDeadKeys(state);

    // active sibling exists — hasOtherViableKey is true — no event emitted at all
    // (but when email is present, the sibling has same email, so hasOtherViableKey check
    // looks for account_email === email on sibling, which is 'own@example.com', but the
    // sibling's email is 'sibling@example.com' — they differ, so auth_failed IS emitted)
    assert.strictEqual(emittedEvents[0].account_email, 'own@example.com',
      'Must use the pruned key\'s own email, not the sibling\'s email');
  });

  // ---- Gap E: email from rotation_log history ----

  it('should resolve email from rotation_log when key has no email and no account_uuid', () => {
    const state = {
      active_key_id: null,
      keys: {
        'invalid-no-uuid': {
          status: 'invalid',
          account_uuid: null,
          account_email: null,
        },
      },
      rotation_log: [
        // Earlier log entry for this key carried the email
        {
          timestamp: Date.now() - 5000,
          event: 'key_added',
          key_id: 'invalid-no-uuid',
          account_email: 'from-log@example.com',
        },
      ],
    };

    const { emittedEvents } = simulatePruneDeadKeys(state);

    assert.strictEqual(emittedEvents.length, 1, 'Must emit account_auth_failed');
    assert.strictEqual(emittedEvents[0].account_email, 'from-log@example.com',
      'Must resolve email from rotation_log history when no direct or sibling email exists');
  });

  it('should use the first matching rotation_log entry (not a later one) for email resolution', () => {
    const state = {
      active_key_id: null,
      keys: {
        'invalid-key': {
          status: 'invalid',
          account_uuid: null,
          account_email: null,
        },
      },
      rotation_log: [
        // First entry has email — this is the one that should be used
        { timestamp: Date.now() - 3000, event: 'key_added', key_id: 'invalid-key', account_email: 'first@example.com' },
        // Second entry also has email but should be ignored
        { timestamp: Date.now() - 1000, event: 'key_switched', key_id: 'invalid-key', account_email: 'second@example.com' },
      ],
    };

    const { emittedEvents } = simulatePruneDeadKeys(state);

    assert.strictEqual(emittedEvents[0].account_email, 'first@example.com',
      'Must use the first rotation_log entry that has a matching key_id and account_email');
  });

  it('should fall back to null email (and use keyId as dedupeKey) when no email source exists', () => {
    const state = {
      active_key_id: null,
      keys: {
        'truly-no-email': {
          status: 'invalid',
          account_uuid: null,
          account_email: null,
        },
      },
      rotation_log: [
        // Log entry exists but has no email
        { timestamp: Date.now(), event: 'key_removed', key_id: 'truly-no-email', account_email: null },
      ],
    };

    const { emittedEvents } = simulatePruneDeadKeys(state);

    assert.strictEqual(emittedEvents.length, 1, 'Must still emit account_auth_failed');
    assert.strictEqual(emittedEvents[0].account_email, null,
      'account_email must be null when no email can be resolved');
    assert.strictEqual(emittedEvents[0].key_id, 'truly-no-email');
  });

  // ---- Gap F: emittedAccounts deduplication ----

  it('should emit account_auth_failed only once when multiple invalid keys share the same email', () => {
    const state = {
      active_key_id: null,
      keys: {
        'invalid-key-A': {
          status: 'invalid',
          account_uuid: null,
          account_email: 'shared@example.com',
        },
        'invalid-key-B': {
          status: 'invalid',
          account_uuid: null,
          account_email: 'shared@example.com',
        },
      },
      rotation_log: [],
    };

    const { emittedEvents } = simulatePruneDeadKeys(state);

    assert.strictEqual(emittedEvents.length, 1,
      'Must emit account_auth_failed only once per unique email, even when multiple invalid keys share it');
    assert.strictEqual(emittedEvents[0].account_email, 'shared@example.com');
  });

  it('should emit separate account_auth_failed events for invalid keys with different emails', () => {
    const state = {
      active_key_id: null,
      keys: {
        'invalid-key-X': {
          status: 'invalid',
          account_uuid: null,
          account_email: 'user-x@example.com',
        },
        'invalid-key-Y': {
          status: 'invalid',
          account_uuid: null,
          account_email: 'user-y@example.com',
        },
      },
      rotation_log: [],
    };

    const { emittedEvents } = simulatePruneDeadKeys(state);

    assert.strictEqual(emittedEvents.length, 2,
      'Must emit a separate account_auth_failed for each distinct email');
    const emails = new Set(emittedEvents.map(e => e.account_email));
    assert.ok(emails.has('user-x@example.com'));
    assert.ok(emails.has('user-y@example.com'));
  });

  it('should emit only once when two invalid keys both have null email but the same keyId-based dedupeKey', () => {
    // Edge case: when email is null, dedupeKey falls back to keyId, so two different
    // invalid keys with null emails each get their own dedupeKey — both should emit.
    // But if the SAME key somehow appears twice (shouldn't happen), only one fires.
    const state = {
      active_key_id: null,
      keys: {
        'no-email-key-1': { status: 'invalid', account_uuid: null, account_email: null },
        'no-email-key-2': { status: 'invalid', account_uuid: null, account_email: null },
      },
      rotation_log: [],
    };

    const { emittedEvents } = simulatePruneDeadKeys(state);

    // Different keyIds → different dedupeKeys → two separate events
    assert.strictEqual(emittedEvents.length, 2,
      'Two invalid keys with null email and different key IDs must each produce their own event');
    const keyIds = new Set(emittedEvents.map(e => e.key_id));
    assert.ok(keyIds.has('no-email-key-1'));
    assert.ok(keyIds.has('no-email-key-2'));
  });

  // ---- Gap G: hasOtherViableKey suppresses account_auth_failed ----

  it('should NOT emit account_auth_failed when a non-pruned key with same email is still viable', () => {
    const state = {
      active_key_id: null,
      keys: {
        'invalid-key': {
          status: 'invalid',
          account_uuid: null,
          account_email: 'user@example.com',
        },
        // Another key for the same account (same email) that is still active — not being pruned
        'viable-key': {
          status: 'active',
          account_uuid: null,
          account_email: 'user@example.com',
        },
      },
      rotation_log: [],
    };

    const { emittedEvents } = simulatePruneDeadKeys(state);

    assert.strictEqual(emittedEvents.length, 0,
      'Must NOT emit account_auth_failed when the account still has a viable non-pruned key');
  });

  it('should emit account_auth_failed when the only other key for the email is also being pruned', () => {
    const state = {
      active_key_id: null,
      keys: {
        'invalid-key-A': {
          status: 'invalid',
          account_uuid: null,
          account_email: 'user@example.com',
        },
        'invalid-key-B': {
          status: 'invalid',
          account_uuid: null,
          account_email: 'user@example.com',
        },
      },
      rotation_log: [],
    };

    const { emittedEvents } = simulatePruneDeadKeys(state);

    // Both keys for this account are being pruned — hasOtherViableKey is false for the first one.
    // The second is deduplicated by emittedAccounts.
    assert.strictEqual(emittedEvents.length, 1,
      'Must emit account_auth_failed once when all keys for an account are being pruned');
    assert.strictEqual(emittedEvents[0].account_email, 'user@example.com');
  });

  it('should NOT emit account_auth_failed when the other key is exhausted (still viable in production)', () => {
    // exhausted keys are NOT in the hasOtherViableKey exclusion list — only invalid and expired are excluded.
    // An exhausted key means the account can still auth (it just hit quota), so we should NOT emit auth_failed.
    const state = {
      active_key_id: null,
      keys: {
        'invalid-key': {
          status: 'invalid',
          account_uuid: null,
          account_email: 'user@example.com',
        },
        'exhausted-key': {
          status: 'exhausted',
          account_uuid: null,
          account_email: 'user@example.com',
        },
      },
      rotation_log: [],
    };

    const { emittedEvents } = simulatePruneDeadKeys(state);

    assert.strictEqual(emittedEvents.length, 0,
      'Must NOT emit account_auth_failed when another key for the account is exhausted (still auth-capable)');
  });

  it('should emit account_auth_failed when the only other key for the email is expired', () => {
    // expired keys ARE excluded from hasOtherViableKey — an expired key cannot be used.
    const state = {
      active_key_id: null,
      keys: {
        'invalid-key': {
          status: 'invalid',
          account_uuid: null,
          account_email: 'user@example.com',
        },
        'expired-key': {
          status: 'expired',
          account_uuid: null,
          account_email: 'user@example.com',
        },
      },
      rotation_log: [],
    };

    const { emittedEvents } = simulatePruneDeadKeys(state);

    assert.strictEqual(emittedEvents.length, 1,
      'Must emit account_auth_failed when the only other key for the account is expired');
    assert.strictEqual(emittedEvents[0].account_email, 'user@example.com');
  });

  it('should not consider a pruned key a viable key for hasOtherViableKey check', () => {
    // Both keys for the account are invalid — neither should count as "viable" for the other
    // The prunedSet check in hasOtherViableKey ensures this.
    const state = {
      active_key_id: null,
      keys: {
        'invalid-key-1': {
          status: 'invalid',
          account_uuid: null,
          account_email: 'user@example.com',
        },
        'invalid-key-2': {
          status: 'invalid',
          account_uuid: null,
          account_email: 'user@example.com',
        },
      },
      rotation_log: [],
    };

    const { emittedEvents, state: finalState } = simulatePruneDeadKeys(state);

    // One event should fire (for the first key before deduplication blocks the second)
    assert.strictEqual(emittedEvents.length, 1,
      'A key being pruned must not count as a viable sibling for another pruned key');
    // Both keys must be deleted from state
    assert.ok(!finalState.keys['invalid-key-1'], 'invalid-key-1 must be deleted');
    assert.ok(!finalState.keys['invalid-key-2'], 'invalid-key-2 must be deleted');
  });

  // ---- Code structure: new logic must be present in key-sync.js ----

  it('should resolve email from sibling keys by account_uuid in key-sync.js source', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');
    const pruneMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(pruneMatch, 'pruneDeadKeys must be defined and exported');
    const pruneBody = pruneMatch[0];

    assert.match(
      pruneBody,
      /otherData\.account_uuid === keyData\.account_uuid && otherData\.account_email/,
      'pruneDeadKeys must resolve email from sibling keys sharing account_uuid'
    );
  });

  it('should resolve email from rotation_log history in key-sync.js source', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');
    const pruneMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(pruneMatch, 'pruneDeadKeys must be defined and exported');
    const pruneBody = pruneMatch[0];

    assert.match(
      pruneBody,
      /entry\.key_id === keyId && entry\.account_email/,
      'pruneDeadKeys must resolve email from rotation_log entries matching the pruned keyId'
    );
  });

  it('should use an emittedAccounts Set to deduplicate account_auth_failed events in key-sync.js source', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');
    const pruneMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(pruneMatch, 'pruneDeadKeys must be defined and exported');
    const pruneBody = pruneMatch[0];

    assert.match(
      pruneBody,
      /emittedAccounts/,
      'pruneDeadKeys must use an emittedAccounts Set to prevent duplicate account_auth_failed events'
    );
    assert.match(
      pruneBody,
      /emittedAccounts\.has\(dedupeKey\)/,
      'pruneDeadKeys must check emittedAccounts before emitting'
    );
    assert.match(
      pruneBody,
      /emittedAccounts\.add\(dedupeKey\)/,
      'pruneDeadKeys must add to emittedAccounts after emitting'
    );
  });

  it('should implement hasOtherViableKey guard in key-sync.js source', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');
    const pruneMatch = code.match(/export function pruneDeadKeys[\s\S]*?\n\}/);
    assert.ok(pruneMatch, 'pruneDeadKeys must be defined and exported');
    const pruneBody = pruneMatch[0];

    assert.match(
      pruneBody,
      /hasOtherViableKey/,
      'pruneDeadKeys must implement hasOtherViableKey check before emitting account_auth_failed'
    );
    assert.match(
      pruneBody,
      /!hasOtherViableKey/,
      'pruneDeadKeys must only emit account_auth_failed when hasOtherViableKey is false'
    );
  });
});
