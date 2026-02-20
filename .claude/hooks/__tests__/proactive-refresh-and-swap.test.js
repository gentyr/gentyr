/**
 * Tests for approaching-expiry proactive refresh and pre-expiry restartless swap
 *
 * NEW behaviors added to quota-monitor.js and key-sync.js:
 * 1. Step 4b (quota-monitor): Proactive refresh for approaching-expiry standby tokens
 * 2. Step 4c (quota-monitor): Pre-expiry restartless swap when active key is near expiry
 * 3. syncKeys() (key-sync): Refresh loop includes approaching-expiry tokens (not just expired)
 * 4. syncKeys() (key-sync): Pre-expiry restartless swap at the end of the function
 *
 * These features ensure standby tokens are always fresh and ready for rotation,
 * and that active token expiry does NOT require a session restart.
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/proactive-refresh-and-swap.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QUOTA_MONITOR_PATH = path.join(__dirname, '..', 'quota-monitor.js');
const KEY_SYNC_PATH = path.join(__dirname, '..', 'key-sync.js');

// ============================================================================
// quota-monitor.js - Approaching-expiry refresh in Step 4b
// ============================================================================

describe('quota-monitor.js - Step 4b approaching-expiry refresh', () => {
  it('should import EXPIRY_BUFFER_MS from key-sync.js', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    assert.match(
      code,
      /import \{[\s\S]*?EXPIRY_BUFFER_MS[\s\S]*?\} from ['"]\.\/key-sync\.js['"]/,
      'quota-monitor must import EXPIRY_BUFFER_MS from key-sync.js'
    );
  });

  it('should define isApproachingExpiry variable in Step 4b', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    const step4bMatch = code.match(/Step 4b[\s\S]*?writeRotationState\(state\)/);
    assert.ok(step4bMatch, 'Step 4b must exist');
    const step4bBody = step4bMatch[0];

    assert.match(
      step4bBody,
      /isApproachingExpiry/,
      'Step 4b must define isApproachingExpiry variable'
    );
  });

  it('should check that approaching-expiry key is not the active key', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    const step4bMatch = code.match(/Step 4b[\s\S]*?writeRotationState\(state\)/);
    assert.ok(step4bMatch, 'Step 4b must exist');
    const step4bBody = step4bMatch[0];

    assert.match(
      step4bBody,
      /keyId !== state\.active_key_id/,
      'isApproachingExpiry must exclude the active key'
    );
  });

  it('should check expiresAt > now for approaching-expiry (not yet expired)', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    const step4bMatch = code.match(/Step 4b[\s\S]*?writeRotationState\(state\)/);
    assert.ok(step4bMatch, 'Step 4b must exist');
    const step4bBody = step4bMatch[0];

    assert.match(
      step4bBody,
      /expiresAt > now/,
      'isApproachingExpiry must check expiresAt > now to exclude already-expired tokens'
    );
  });

  it('should check expiresAt < now + EXPIRY_BUFFER_MS for approaching-expiry', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    const step4bMatch = code.match(/Step 4b[\s\S]*?writeRotationState\(state\)/);
    assert.ok(step4bMatch, 'Step 4b must exist');
    const step4bBody = step4bMatch[0];

    assert.match(
      step4bBody,
      /expiresAt < now.*?\+ EXPIRY_BUFFER_MS/,
      'isApproachingExpiry must check expiresAt < now + EXPIRY_BUFFER_MS'
    );
  });

  it('should refresh when (isExpired || isApproachingExpiry)', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    const step4bMatch = code.match(/Step 4b[\s\S]*?writeRotationState\(state\)/);
    assert.ok(step4bMatch, 'Step 4b must exist');
    const step4bBody = step4bMatch[0];

    assert.match(
      step4bBody,
      /isExpired \|\| isApproachingExpiry/,
      'Step 4b must refresh when (isExpired || isApproachingExpiry)'
    );
  });

  it('should log proactive_standby_refresh reason for approaching-expiry tokens', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    const step4bMatch = code.match(/Step 4b[\s\S]*?writeRotationState\(state\)/);
    assert.ok(step4bMatch, 'Step 4b must exist');
    const step4bBody = step4bMatch[0];

    assert.match(
      step4bBody,
      /proactive_standby_refresh/,
      'Step 4b must log proactive_standby_refresh for approaching-expiry refresh'
    );
  });

  it('should use conditional event/reason based on isExpired vs isApproachingExpiry', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    const step4bMatch = code.match(/Step 4b[\s\S]*?writeRotationState\(state\)/);
    assert.ok(step4bMatch, 'Step 4b must exist');
    const step4bBody = step4bMatch[0];

    // Check for ternary logic: event: isExpired ? 'key_added' : 'key_refreshed'
    assert.match(
      step4bBody,
      /isExpired \? ['"]key_added['"] : ['"]key_refreshed['"]/,
      'Step 4b must use conditional event based on isExpired'
    );

    // Check for ternary logic: reason: isExpired ? 'token_refreshed_by_quota_monitor' : 'proactive_standby_refresh'
    assert.match(
      step4bBody,
      /isExpired \? ['"]token_refreshed_by_quota_monitor['"] : ['"]proactive_standby_refresh['"]/,
      'Step 4b must use conditional reason based on isExpired'
    );
  });
});

// ============================================================================
// quota-monitor.js - Step 4c: Pre-expiry restartless swap
// ============================================================================

describe('quota-monitor.js - Step 4c pre-expiry restartless swap', () => {
  it('should have a Step 4c comment for pre-expiry restartless swap', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    assert.match(
      code,
      /Step 4c.*pre.*expiry.*restartless.*swap/is,
      'Must have Step 4c comment for pre-expiry restartless swap'
    );
  });

  it('should check if activeKeyData.expiresAt is within EXPIRY_BUFFER_MS', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    const step4cMatch = code.match(/Step 4c[\s\S]*?\/\/ Step 5/);
    assert.ok(step4cMatch, 'Step 4c must exist (ends before Step 5)');
    const step4cBody = step4cMatch[0];

    assert.match(
      step4cBody,
      /activeKeyData\.expiresAt < .*?\+ EXPIRY_BUFFER_MS/,
      'Step 4c must check if active key is approaching expiry'
    );
  });

  it('should find a standby key with expiresAt > now + EXPIRY_BUFFER_MS', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    const step4cMatch = code.match(/Step 4c[\s\S]*?\/\/ Step 5/);
    assert.ok(step4cMatch, 'Step 4c must exist');
    const step4cBody = step4cMatch[0];

    assert.match(
      step4cBody,
      /k\.expiresAt > .*?\+ EXPIRY_BUFFER_MS/,
      'Step 4c standby filter must require expiresAt well beyond the buffer'
    );
  });

  it('should update state.active_key_id to the standby key', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    const step4cMatch = code.match(/Step 4c[\s\S]*?\/\/ Step 5/);
    assert.ok(step4cMatch, 'Step 4c must exist');
    const step4cBody = step4cMatch[0];

    assert.match(
      step4cBody,
      /state\.active_key_id = newKeyId/,
      'Step 4c must update state.active_key_id to the standby key'
    );
  });

  it('should call updateActiveCredentials to write standby to Keychain/file', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    const step4cMatch = code.match(/Step 4c[\s\S]*?\/\/ Step 5/);
    assert.ok(step4cMatch, 'Step 4c must exist');
    const step4cBody = step4cMatch[0];

    assert.match(
      step4cBody,
      /updateActiveCredentials\(newKeyData\)/,
      'Step 4c must call updateActiveCredentials to persist swap'
    );
  });

  it('should log key_switched event with reason pre_expiry_restartless_swap', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    const step4cMatch = code.match(/Step 4c[\s\S]*?\/\/ Step 5/);
    assert.ok(step4cMatch, 'Step 4c must exist');
    const step4cBody = step4cMatch[0];

    assert.match(
      step4cBody,
      /reason:\s*['"]pre_expiry_restartless_swap['"]/,
      'Step 4c must log reason pre_expiry_restartless_swap'
    );
  });

  it('should document that no restart is needed (comment)', () => {
    const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

    const step4cMatch = code.match(/Step 4c[\s\S]*?\/\/ Step 5/);
    assert.ok(step4cMatch, 'Step 4c must exist');
    const step4cBody = step4cMatch[0];

    assert.match(
      step4cBody,
      /No restart/i,
      'Step 4c must document that no restart is needed'
    );
  });
});

// ============================================================================
// key-sync.js - EXPIRY_BUFFER_MS export and approaching-expiry logic
// ============================================================================

describe('key-sync.js - EXPIRY_BUFFER_MS and approaching-expiry refresh', () => {
  it('should export EXPIRY_BUFFER_MS as a module-level constant', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    assert.match(
      code,
      /export const EXPIRY_BUFFER_MS\s*=\s*600_?000/,
      'key-sync.js must export EXPIRY_BUFFER_MS as 600000 (10 minutes)'
    );
  });

  it('should define isApproachingExpiry in syncKeys() refresh loop', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?export function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys must be defined');
    const syncBody = syncMatch[0];

    assert.match(
      syncBody,
      /isApproachingExpiry/,
      'syncKeys must define isApproachingExpiry variable'
    );
  });

  it('should exclude the active key from approaching-expiry candidates', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?export function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys must be defined');
    const syncBody = syncMatch[0];

    assert.match(
      syncBody,
      /keyId !== state\.active_key_id/,
      'isApproachingExpiry must exclude the active key'
    );
  });

  it('should trigger refresh when (isExpired || isApproachingExpiry) && status !== invalid', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?export function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys must be defined');
    const syncBody = syncMatch[0];

    assert.match(
      syncBody,
      /\(isExpired \|\| isApproachingExpiry\) && keyData\.status !== ['"]invalid['"]/,
      'syncKeys must refresh when (isExpired || isApproachingExpiry) && status !== invalid'
    );
  });

  it('should log token_refreshed event on successful approaching-expiry refresh', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?export function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys must be defined');
    const syncBody = syncMatch[0];

    assert.match(
      syncBody,
      /reason:\s*['"]token_refreshed['"]/,
      'syncKeys must log token_refreshed for successful refresh'
    );
  });
});

// ============================================================================
// key-sync.js - Pre-expiry restartless swap in syncKeys()
// ============================================================================

describe('key-sync.js - syncKeys() pre-expiry restartless swap', () => {
  it('should have a comment describing pre-expiry restartless swap', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?export function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys must be defined');
    const syncBody = syncMatch[0];

    assert.match(
      syncBody,
      /Pre-expiry restartless swap/i,
      'syncKeys must have a comment describing pre-expiry restartless swap'
    );
  });

  it('should check if activeKey.expiresAt is within EXPIRY_BUFFER_MS', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?export function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys must be defined');
    const syncBody = syncMatch[0];

    assert.match(
      syncBody,
      /activeKey\.expiresAt < now \+ EXPIRY_BUFFER_MS/,
      'syncKeys must check if active key is approaching expiry'
    );
  });

  it('should find a standby key with expiresAt > now + EXPIRY_BUFFER_MS', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?export function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys must be defined');
    const syncBody = syncMatch[0];

    assert.match(
      syncBody,
      /k\.expiresAt > now \+ EXPIRY_BUFFER_MS/,
      'syncKeys must check standby expiresAt > buffer'
    );
  });

  it('should update state.active_key_id to the standby key', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?export function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys must be defined');
    const syncBody = syncMatch[0];

    assert.match(
      syncBody,
      /state\.active_key_id = newKeyId/,
      'syncKeys must update state.active_key_id to standby key'
    );
  });

  it('should call updateActiveCredentials to persist the swap', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?export function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys must be defined');
    const syncBody = syncMatch[0];

    assert.match(
      syncBody,
      /updateActiveCredentials\(newKeyData\)/,
      'syncKeys must call updateActiveCredentials to persist swap'
    );
  });

  it('should log key_switched event with reason pre_expiry_restartless_swap', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?export function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys must be defined');
    const syncBody = syncMatch[0];

    assert.match(
      syncBody,
      /reason:\s*['"]pre_expiry_restartless_swap['"]/,
      'syncKeys must log reason pre_expiry_restartless_swap'
    );
  });

  it('should occur AFTER the refresh loop and BEFORE pruneDeadKeys call', () => {
    const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const syncMatch = code.match(/export async function syncKeys[\s\S]*?export function pruneDeadKeys/);
    assert.ok(syncMatch, 'syncKeys must be defined');
    const syncBody = syncMatch[0];

    const tokenRefreshedIdx = syncBody.indexOf('token_refreshed');
    const swapIdx = syncBody.indexOf('pre_expiry_restartless_swap');
    const pruneIdx = syncBody.indexOf('pruneDeadKeys');

    assert.ok(tokenRefreshedIdx >= 0, 'token_refreshed must exist');
    assert.ok(swapIdx >= 0, 'pre_expiry_restartless_swap must exist');
    assert.ok(pruneIdx >= 0, 'pruneDeadKeys call must exist');

    assert.ok(tokenRefreshedIdx < swapIdx, 'Pre-expiry swap must occur AFTER refresh loop');
    assert.ok(swapIdx < pruneIdx, 'Pre-expiry swap must occur BEFORE pruneDeadKeys');
  });
});

// ============================================================================
// Behavioral logic tests
// ============================================================================

describe('Behavioral logic - approaching-expiry and pre-expiry swap', () => {
  it('should correctly identify approaching-expiry standby keys (not expired, not active, within buffer)', () => {
    const now = Date.now();
    const EXPIRY_BUFFER_MS = 600_000; // 10 minutes
    const activeKeyId = 'active-key';

    const keys = {
      'active-key': { status: 'active', expiresAt: now + 20 * 60 * 1000 },
      'standby-approaching': { status: 'active', expiresAt: now + 8 * 60 * 1000 }, // Within buffer
      'standby-safe': { status: 'active', expiresAt: now + 15 * 60 * 1000 }, // Beyond buffer
      'standby-expired': { status: 'expired', expiresAt: now - 1000 }, // Already expired
    };

    // Simulate isApproachingExpiry filter
    const candidates = Object.entries(keys).filter(([keyId, keyData]) => {
      const isExpired = keyData.expiresAt && keyData.expiresAt < now;
      const isApproachingExpiry = keyId !== activeKeyId && keyData.expiresAt && keyData.expiresAt > now && keyData.expiresAt < now + EXPIRY_BUFFER_MS;
      return (isExpired || isApproachingExpiry) && keyData.status !== 'invalid';
    });

    assert.strictEqual(candidates.length, 2, 'Should find expired + approaching-expiry keys');
    const candidateIds = candidates.map(([id]) => id);
    assert.ok(candidateIds.includes('standby-approaching'), 'Must include approaching-expiry standby');
    assert.ok(candidateIds.includes('standby-expired'), 'Must include expired key');
  });

  it('should perform pre-expiry swap when active key is approaching and standby is available', () => {
    const now = Date.now();
    const EXPIRY_BUFFER_MS = 600_000; // 10 minutes

    const state = {
      active_key_id: 'active-key',
      keys: {
        'active-key': { status: 'active', expiresAt: now + 5 * 60 * 1000 }, // Approaching
        'standby-good': { status: 'active', expiresAt: now + 20 * 60 * 1000 }, // Well beyond buffer
      },
    };

    const activeKey = state.active_key_id && state.keys[state.active_key_id];
    const shouldSwap = activeKey && activeKey.expiresAt && activeKey.expiresAt < now + EXPIRY_BUFFER_MS;

    assert.ok(shouldSwap, 'Active key is approaching expiry, swap should trigger');

    const standby = Object.entries(state.keys).find(([id, k]) =>
      id !== state.active_key_id &&
      k.status === 'active' &&
      k.expiresAt && k.expiresAt > now + EXPIRY_BUFFER_MS
    );

    assert.ok(standby, 'Must find a suitable standby for the swap');
    assert.strictEqual(standby[0], 'standby-good');
  });

  it('should NOT perform pre-expiry swap when active key is not approaching expiry', () => {
    const now = Date.now();
    const EXPIRY_BUFFER_MS = 600_000; // 10 minutes

    const state = {
      active_key_id: 'active-key',
      keys: {
        'active-key': { status: 'active', expiresAt: now + 20 * 60 * 1000 }, // Not approaching
      },
    };

    const activeKey = state.active_key_id && state.keys[state.active_key_id];
    const shouldSwap = activeKey && activeKey.expiresAt && activeKey.expiresAt < now + EXPIRY_BUFFER_MS;

    assert.ok(!shouldSwap, 'Active key is not approaching expiry, no swap needed');
  });

  it('should NOT perform pre-expiry swap when no standby with long-enough expiry is available', () => {
    const now = Date.now();
    const EXPIRY_BUFFER_MS = 600_000; // 10 minutes

    const state = {
      active_key_id: 'active-key',
      keys: {
        'active-key': { status: 'active', expiresAt: now + 5 * 60 * 1000 }, // Approaching
        'standby-also-approaching': { status: 'active', expiresAt: now + 8 * 60 * 1000 }, // Within buffer, not suitable
      },
    };

    const activeKey = state.active_key_id && state.keys[state.active_key_id];
    const shouldSwap = activeKey && activeKey.expiresAt && activeKey.expiresAt < now + EXPIRY_BUFFER_MS;

    assert.ok(shouldSwap, 'Active key is approaching, check for standby...');

    const standby = Object.entries(state.keys).find(([id, k]) =>
      id !== state.active_key_id &&
      k.status === 'active' &&
      k.expiresAt && k.expiresAt > now + EXPIRY_BUFFER_MS
    );

    assert.strictEqual(standby, undefined, 'No suitable standby, swap should not occur');
  });
});

// ============================================================================
// Cross-file consistency
// ============================================================================

describe('Cross-file consistency - proactive refresh and swap', () => {
  it('both files must use EXPIRY_BUFFER_MS from the same source (key-sync exports, quota-monitor imports)', () => {
    const quotaCode = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');
    const keySyncCode = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    // key-sync must export it
    assert.match(
      keySyncCode,
      /export const EXPIRY_BUFFER_MS\s*=\s*600_?000/,
      'key-sync must export EXPIRY_BUFFER_MS'
    );

    // quota-monitor must import it
    assert.match(
      quotaCode,
      /import \{[\s\S]*?EXPIRY_BUFFER_MS[\s\S]*?\} from ['"]\.\/key-sync\.js['"]/,
      'quota-monitor must import EXPIRY_BUFFER_MS from key-sync'
    );
  });

  it('both files must log pre_expiry_restartless_swap reason', () => {
    const quotaCode = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');
    const keySyncCode = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    assert.match(quotaCode, /pre_expiry_restartless_swap/, 'quota-monitor must log pre_expiry_restartless_swap');
    assert.match(keySyncCode, /pre_expiry_restartless_swap/, 'key-sync must log pre_expiry_restartless_swap');
  });

  it('both files must call updateActiveCredentials when performing pre-expiry swap', () => {
    const quotaCode = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');
    const keySyncCode = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const quotaSwapSection = quotaCode.match(/Step 4c[\s\S]*?\/\/ Step 5/);
    const keySyncSwapSection = keySyncCode.match(/Pre-expiry restartless swap[\s\S]*?pruneDeadKeys/);

    assert.ok(quotaSwapSection, 'quota-monitor Step 4c must exist');
    assert.ok(keySyncSwapSection, 'key-sync pre-expiry swap section must exist');

    assert.match(quotaSwapSection[0], /updateActiveCredentials/, 'quota-monitor Step 4c must call updateActiveCredentials');
    assert.match(keySyncSwapSection[0], /updateActiveCredentials/, 'key-sync pre-expiry swap must call updateActiveCredentials');
  });

  it('both files must use the same standby filter condition (expiresAt > now/buffer + EXPIRY_BUFFER_MS)', () => {
    const quotaCode = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');
    const keySyncCode = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

    const quotaSwapSection = quotaCode.match(/Step 4c[\s\S]*?\/\/ Step 5/);
    const keySyncSwapSection = keySyncCode.match(/Pre-expiry restartless swap[\s\S]*?pruneDeadKeys/);

    assert.ok(quotaSwapSection, 'quota-monitor Step 4c must exist');
    assert.ok(keySyncSwapSection, 'key-sync pre-expiry swap section must exist');

    assert.match(quotaSwapSection[0], /k\.expiresAt > .*?\+ EXPIRY_BUFFER_MS/, 'quota-monitor must check standby expiresAt > buffer');
    assert.match(keySyncSwapSection[0], /k\.expiresAt > now \+ EXPIRY_BUFFER_MS/, 'key-sync must check standby expiresAt > buffer');
  });
});
