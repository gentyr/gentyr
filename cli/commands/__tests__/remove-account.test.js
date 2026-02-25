/**
 * Unit tests for remove-account CLI command
 *
 * Tests account removal from rotation state:
 * - Arg parsing (email extraction, --force flag, missing email)
 * - Account matching (case-insensitive, skip tombstone/invalid, multiple keys)
 * - Active removal (switches to another account, --force for last account)
 * - Non-active removal (active key unchanged)
 * - Tombstone behavior (correct fields, stripped token data)
 * - Rotation log (account_removed events logged)
 * - Env var warning
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'os';

const ROTATION_STATE_PATH = path.join(os.homedir(), '.claude', 'api-key-rotation.json');

// Save/restore rotation state around tests
let originalContent = null;
let fileExisted = false;

function backupState() {
  if (fs.existsSync(ROTATION_STATE_PATH)) {
    originalContent = fs.readFileSync(ROTATION_STATE_PATH, 'utf8');
    fileExisted = true;
  }
}

function restoreState() {
  if (fileExisted && originalContent !== null) {
    fs.writeFileSync(ROTATION_STATE_PATH, originalContent, 'utf8');
  } else if (fs.existsSync(ROTATION_STATE_PATH)) {
    fs.unlinkSync(ROTATION_STATE_PATH);
  }
  originalContent = null;
  fileExisted = false;
}

function writeState(state) {
  const dir = path.dirname(ROTATION_STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ROTATION_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function readState() {
  return JSON.parse(fs.readFileSync(ROTATION_STATE_PATH, 'utf8'));
}

function makeState(overrides = {}) {
  return {
    version: 1,
    active_key_id: null,
    keys: {},
    rotation_log: [],
    ...overrides,
  };
}

// Helper to capture process.exit and console output
function captureExit() {
  let exitCode = null;
  const originalExit = process.exit;
  process.exit = (code) => {
    exitCode = code;
    throw new Error(`EXIT:${code}`);
  };
  return {
    get code() { return exitCode; },
    restore() { process.exit = originalExit; },
  };
}

describe('remove-account CLI', () => {
  beforeEach(() => {
    backupState();
  });

  afterEach(() => {
    restoreState();
  });

  describe('List mode', () => {
    it('should list accounts with --list flag', async () => {
      writeState(makeState({
        active_key_id: 'key-1',
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'active@example.com',
            accessToken: 'tok1',
          },
          'key-2': {
            status: 'active',
            account_email: 'other@example.com',
            accessToken: 'tok2',
          },
          'key-tomb': {
            status: 'tombstone',
            account_email: 'dead@example.com',
          },
        },
      }));

      const logs = [];
      const origLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        const mod = await import('../remove-account.js?t=list');
        await mod.default(['--list']);
      } finally {
        console.log = origLog;
      }

      const output = logs.join('\n');
      assert.ok(output.includes('active@example.com'));
      assert.ok(output.includes('other@example.com'));
      // Tombstoned accounts should not appear
      assert.ok(!output.includes('dead@example.com'));
    });

    it('should show "No accounts registered" with --list when empty', async () => {
      writeState(makeState({ keys: {} }));

      const logs = [];
      const origLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        const mod = await import('../remove-account.js?t=listempty');
        await mod.default(['--list']);
      } finally {
        console.log = origLog;
      }

      assert.ok(logs.some(l => l.includes('No accounts registered')));
    });
  });

  describe('Arg parsing', () => {
    it('should exit with error when no email provided', async () => {
      const exit = captureExit();
      const logs = [];
      const origError = console.error;
      console.error = (...args) => logs.push(args.join(' '));

      try {
        const mod = await import('../remove-account.js?t=noarg');
        await mod.default([]);
      } catch (e) {
        if (!e.message.startsWith('EXIT:')) throw e;
      } finally {
        exit.restore();
        console.error = origError;
      }

      assert.equal(exit.code, 1);
      assert.ok(logs.some(l => l.includes('Usage:')));
    });

    it('should reject invalid email format', async () => {
      const exit = captureExit();
      const logs = [];
      const origError = console.error;
      console.error = (...args) => logs.push(args.join(' '));

      try {
        const mod = await import('../remove-account.js?t=bademail');
        await mod.default(['not-an-email']);
      } catch (e) {
        if (!e.message.startsWith('EXIT:')) throw e;
      } finally {
        exit.restore();
        console.error = origError;
      }

      assert.equal(exit.code, 1);
      assert.ok(logs.some(l => l.includes('Invalid email format')));
    });

    it('should extract email and --force flag', async () => {
      // Create state with matching account
      writeState(makeState({
        active_key_id: 'key-other',
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'remove@example.com',
            accessToken: 'tok1',
            refreshToken: 'ref1',
            expiresAt: Date.now() + 86400000,
          },
          'key-other': {
            status: 'active',
            account_email: 'keep@example.com',
            accessToken: 'tok2',
            refreshToken: 'ref2',
            expiresAt: Date.now() + 86400000,
          },
        },
      }));

      const mod = await import('../remove-account.js?t=argparse');
      await mod.default(['remove@example.com', '--force']);

      const state = readState();
      assert.equal(state.keys['key-1'].status, 'tombstone');
    });
  });

  describe('Account matching', () => {
    it('should match emails case-insensitively', async () => {
      writeState(makeState({
        active_key_id: 'key-other',
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'User@Example.COM',
            accessToken: 'tok1',
          },
          'key-other': {
            status: 'active',
            account_email: 'keep@example.com',
            accessToken: 'tok2',
          },
        },
      }));

      const mod = await import('../remove-account.js?t=caseins');
      await mod.default(['user@example.com']);

      const state = readState();
      assert.equal(state.keys['key-1'].status, 'tombstone');
    });

    it('should skip already-tombstoned keys', async () => {
      writeState(makeState({
        active_key_id: 'key-other',
        keys: {
          'key-tomb': {
            status: 'tombstone',
            tombstoned_at: Date.now() - 3600000,
            account_email: 'user@example.com',
          },
          'key-active': {
            status: 'active',
            account_email: 'user@example.com',
            accessToken: 'tok1',
          },
          'key-other': {
            status: 'active',
            account_email: 'keep@example.com',
            accessToken: 'tok2',
          },
        },
      }));

      const mod = await import('../remove-account.js?t=skiptomb');
      await mod.default(['user@example.com']);

      const state = readState();
      // The already-tombstoned key should be unchanged
      assert.ok(state.keys['key-tomb'].tombstoned_at < Date.now() - 1000);
      // The active key should now be tombstoned
      assert.equal(state.keys['key-active'].status, 'tombstone');
    });

    it('should skip invalid keys', async () => {
      writeState(makeState({
        active_key_id: 'key-other',
        keys: {
          'key-inv': {
            status: 'invalid',
            account_email: 'user@example.com',
          },
          'key-active': {
            status: 'active',
            account_email: 'user@example.com',
            accessToken: 'tok1',
          },
          'key-other': {
            status: 'active',
            account_email: 'keep@example.com',
            accessToken: 'tok2',
          },
        },
      }));

      const mod = await import('../remove-account.js?t=skipinv');
      await mod.default(['user@example.com']);

      const state = readState();
      // Invalid key should be unchanged
      assert.equal(state.keys['key-inv'].status, 'invalid');
      // Active key should be tombstoned
      assert.equal(state.keys['key-active'].status, 'tombstone');
    });

    it('should handle multiple keys per account', async () => {
      writeState(makeState({
        active_key_id: 'key-other',
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'multi@example.com',
            accessToken: 'tok1',
          },
          'key-2': {
            status: 'exhausted',
            account_email: 'multi@example.com',
            accessToken: 'tok2',
          },
          'key-3': {
            status: 'expired',
            account_email: 'multi@example.com',
            accessToken: 'tok3',
          },
          'key-other': {
            status: 'active',
            account_email: 'keep@example.com',
            accessToken: 'tok4',
          },
        },
      }));

      const mod = await import('../remove-account.js?t=multi');
      await mod.default(['multi@example.com']);

      const state = readState();
      assert.equal(state.keys['key-1'].status, 'tombstone');
      assert.equal(state.keys['key-2'].status, 'tombstone');
      assert.equal(state.keys['key-3'].status, 'tombstone');
      assert.equal(state.keys['key-other'].status, 'active');
    });

    it('should error when no keys match email', async () => {
      writeState(makeState({
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'existing@example.com',
          },
        },
      }));

      const exit = captureExit();
      const logs = [];
      const origError = console.error;
      console.error = (...args) => logs.push(args.join(' '));

      try {
        const mod = await import('../remove-account.js?t=nomatch');
        await mod.default(['nonexistent@example.com']);
      } catch (e) {
        if (!e.message.startsWith('EXIT:')) throw e;
      } finally {
        exit.restore();
        console.error = origError;
      }

      assert.equal(exit.code, 1);
      assert.ok(logs.some(l => l.includes('No active keys found')));
      assert.ok(logs.some(l => l.includes('existing@example.com')));
    });
  });

  describe('Active key removal', () => {
    it('should switch to replacement when removing active account', async () => {
      writeState(makeState({
        active_key_id: 'key-remove',
        keys: {
          'key-remove': {
            status: 'active',
            account_email: 'remove@example.com',
            accessToken: 'tok-remove',
            refreshToken: 'ref-remove',
            expiresAt: Date.now() + 86400000,
          },
          'key-keep': {
            status: 'active',
            account_email: 'keep@example.com',
            accessToken: 'tok-keep',
            refreshToken: 'ref-keep',
            expiresAt: Date.now() + 86400000,
          },
        },
      }));

      const mod = await import('../remove-account.js?t=switchactive');
      await mod.default(['remove@example.com']);

      const state = readState();
      assert.equal(state.keys['key-remove'].status, 'tombstone');
      assert.equal(state.active_key_id, 'key-keep');
    });

    it('should error when removing last account without --force', async () => {
      writeState(makeState({
        active_key_id: 'key-only',
        keys: {
          'key-only': {
            status: 'active',
            account_email: 'only@example.com',
            accessToken: 'tok-only',
          },
        },
      }));

      const exit = captureExit();
      const logs = [];
      const origError = console.error;
      console.error = (...args) => logs.push(args.join(' '));

      try {
        const mod = await import('../remove-account.js?t=lastnoforce');
        await mod.default(['only@example.com']);
      } catch (e) {
        if (!e.message.startsWith('EXIT:')) throw e;
      } finally {
        exit.restore();
        console.error = origError;
      }

      assert.equal(exit.code, 1);
      assert.ok(logs.some(l => l.includes('Cannot remove the only account')));

      // State should be unchanged
      const state = readState();
      assert.equal(state.keys['key-only'].status, 'active');
    });

    it('should allow removing last account with --force', async () => {
      writeState(makeState({
        active_key_id: 'key-only',
        keys: {
          'key-only': {
            status: 'active',
            account_email: 'only@example.com',
            accessToken: 'tok-only',
          },
        },
      }));

      const mod = await import('../remove-account.js?t=lastforce');
      await mod.default(['only@example.com', '--force']);

      const state = readState();
      assert.equal(state.keys['key-only'].status, 'tombstone');
      assert.equal(state.active_key_id, null);
    });
  });

  describe('Non-active removal', () => {
    it('should remove without switching when key is not active', async () => {
      writeState(makeState({
        active_key_id: 'key-active',
        keys: {
          'key-active': {
            status: 'active',
            account_email: 'active@example.com',
            accessToken: 'tok-active',
          },
          'key-remove': {
            status: 'active',
            account_email: 'remove@example.com',
            accessToken: 'tok-remove',
          },
        },
      }));

      const mod = await import('../remove-account.js?t=nonactive');
      await mod.default(['remove@example.com']);

      const state = readState();
      assert.equal(state.keys['key-remove'].status, 'tombstone');
      assert.equal(state.active_key_id, 'key-active');
      assert.equal(state.keys['key-active'].status, 'active');
    });
  });

  describe('Tombstone behavior', () => {
    it('should set correct tombstone fields', async () => {
      const before = Date.now();
      writeState(makeState({
        active_key_id: 'key-other',
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'tomb@example.com',
            accessToken: 'secret-token',
            refreshToken: 'secret-refresh',
            expiresAt: Date.now() + 86400000,
            subscriptionType: 'claude_max',
            last_usage: { five_hour: 50, seven_day: 60 },
          },
          'key-other': {
            status: 'active',
            account_email: 'keep@example.com',
            accessToken: 'tok2',
          },
        },
      }));

      const mod = await import('../remove-account.js?t=tombfields');
      await mod.default(['tomb@example.com']);

      const state = readState();
      const tombstoned = state.keys['key-1'];

      assert.equal(tombstoned.status, 'tombstone');
      assert.ok(tombstoned.tombstoned_at >= before);
      assert.equal(tombstoned.account_email, 'tomb@example.com');
      // Token data should be stripped (overwritten by tombstone object)
      assert.equal(tombstoned.accessToken, undefined);
      assert.equal(tombstoned.refreshToken, undefined);
    });
  });

  describe('Rotation log', () => {
    it('should log account_removed events', async () => {
      writeState(makeState({
        active_key_id: 'key-other',
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'log@example.com',
            accessToken: 'tok1',
          },
          'key-2': {
            status: 'active',
            account_email: 'log@example.com',
            accessToken: 'tok2',
          },
          'key-other': {
            status: 'active',
            account_email: 'keep@example.com',
            accessToken: 'tok3',
          },
        },
      }));

      const mod = await import('../remove-account.js?t=logtest');
      await mod.default(['log@example.com']);

      const state = readState();
      const removedEvents = state.rotation_log.filter(e => e.event === 'account_removed');

      assert.equal(removedEvents.length, 2);
      assert.ok(removedEvents.every(e => e.reason === 'user_removed'));
      assert.ok(removedEvents.every(e => e.account_email === 'log@example.com'));

      const keyIds = removedEvents.map(e => e.key_id).sort();
      assert.deepEqual(keyIds, ['key-1', 'key-2']);
    });

    it('should log key_switched event when active is switched', async () => {
      writeState(makeState({
        active_key_id: 'key-remove',
        keys: {
          'key-remove': {
            status: 'active',
            account_email: 'remove@example.com',
            accessToken: 'tok1',
            refreshToken: 'ref1',
            expiresAt: Date.now() + 86400000,
          },
          'key-keep': {
            status: 'active',
            account_email: 'keep@example.com',
            accessToken: 'tok2',
            refreshToken: 'ref2',
            expiresAt: Date.now() + 86400000,
          },
        },
      }));

      const mod = await import('../remove-account.js?t=logswitch');
      await mod.default(['remove@example.com']);

      const state = readState();
      const switchEvents = state.rotation_log.filter(e => e.event === 'key_switched');

      assert.ok(switchEvents.length >= 1);
      assert.ok(switchEvents.some(e => e.reason === 'account_removed'));
    });
  });

  describe('Env var warning', () => {
    it('should warn when CLAUDE_CODE_OAUTH_TOKEN is set', async () => {
      writeState(makeState({
        active_key_id: 'key-other',
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'envwarn@example.com',
            accessToken: 'tok1',
          },
          'key-other': {
            status: 'active',
            account_email: 'keep@example.com',
            accessToken: 'tok2',
          },
        },
      }));

      const origEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'some-token';

      const logs = [];
      const origLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        const mod = await import('../remove-account.js?t=envwarn');
        await mod.default(['envwarn@example.com']);
      } finally {
        console.log = origLog;
        if (origEnv === undefined) {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        } else {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = origEnv;
        }
      }

      assert.ok(logs.some(l => l.includes('CLAUDE_CODE_OAUTH_TOKEN')));
    });
  });

  describe('Edge cases', () => {
    it('should show "No accounts registered" when state has no keys', async () => {
      writeState(makeState({ keys: {} }));

      const exit = captureExit();
      const logs = [];
      const origError = console.error;
      console.error = (...args) => logs.push(args.join(' '));

      try {
        const mod = await import('../remove-account.js?t=nokeys');
        await mod.default(['nobody@example.com']);
      } catch (e) {
        if (!e.message.startsWith('EXIT:')) throw e;
      } finally {
        exit.restore();
        console.error = origError;
      }

      assert.equal(exit.code, 1);
      assert.ok(logs.some(l => l.includes('No accounts registered')));
    });

    it('should accept --force before the email argument', async () => {
      writeState(makeState({
        active_key_id: 'key-other',
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'flagorder@example.com',
            accessToken: 'tok1',
          },
          'key-other': {
            status: 'active',
            account_email: 'keep@example.com',
            accessToken: 'tok2',
          },
        },
      }));

      const mod = await import('../remove-account.js?t=flagorder');
      await mod.default(['--force', 'flagorder@example.com']);

      const state = readState();
      assert.equal(state.keys['key-1'].status, 'tombstone');
    });
  });
});
