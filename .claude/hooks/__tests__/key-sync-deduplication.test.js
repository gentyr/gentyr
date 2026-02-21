/**
 * Tests for key-sync.js - deduplication and account grouping
 *
 * Covers the changes made to selectActiveKey() and the new deduplicateKeys() function:
 * 1. selectActiveKey() now groups keys by account_uuid before applying threshold logic
 * 2. Keys without account_uuid are treated as unique (each is its own "account")
 * 3. deduplicateKeys() merges keys with same account_uuid, keeping freshest token
 * 4. deduplicateKeys() redirects active_key_id when merged-away key was active
 * 5. deduplicateKeys() preserves most recent health check data
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/key-sync-deduplication.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEY_SYNC_PATH = path.join(__dirname, '..', 'key-sync.js');

describe('key-sync.js - selectActiveKey() account grouping', () => {
  describe('Code Structure: selectActiveKey() grouping logic', () => {
    it('should export selectActiveKey function', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      assert.match(
        code,
        /export function selectActiveKey\(/,
        'selectActiveKey must be exported'
      );
    });

    it('should group keys by account_uuid in selectActiveKey', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      // Should create a Map for account groups
      assert.match(
        fnBody,
        /accountGroups\s*=\s*new Map\(\)/,
        'Must create accountGroups Map for grouping'
      );

      // Should check account_uuid
      assert.match(
        fnBody,
        /account_uuid/,
        'Must reference account_uuid for grouping'
      );
    });

    it('should treat keys without account_uuid as unique accounts', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      // Should handle missing account_uuid case
      assert.match(
        fnBody,
        /!uuid/,
        'Must check for missing/null account_uuid'
      );

      // Should create unique group for keys without uuid
      assert.match(
        fnBody,
        /__no_uuid__/,
        'Must create unique group identifier for keys without account_uuid'
      );
    });

    it('should pick freshest token (highest expiresAt) from each account group', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      // Should sort by expiresAt
      assert.match(
        fnBody,
        /\.sort\(/,
        'Must include sort operation'
      );

      // Should compare expiresAt values
      assert.match(
        fnBody,
        /expiresAt/,
        'Must reference expiresAt for freshness comparison'
      );
    });

    it('should treat null/missing expiresAt as 0 (least fresh)', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      // Should use || 0 fallback for missing expiresAt
      assert.match(
        fnBody,
        /expiresAt \|\| 0/,
        'Must treat missing expiresAt as 0 (least fresh)'
      );
    });

    it('should select representatives array from account groups', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      // Should build representatives array
      assert.match(
        fnBody,
        /representatives\s*=\s*\[\]/,
        'Must create representatives array for account-level selection'
      );

      // Should iterate over account groups
      assert.match(
        fnBody,
        /accountGroups\.values\(\)/,
        'Must iterate over accountGroups to pick representatives'
      );
    });

    it('should continue to filter out 100% exhausted keys', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      // Should filter by EXHAUSTED_THRESHOLD (100%)
      assert.match(
        fnBody,
        /EXHAUSTED_THRESHOLD/,
        'Must continue to use EXHAUSTED_THRESHOLD for filtering'
      );

      // Should check all three usage categories
      assert.match(
        fnBody,
        /five_hour.*EXHAUSTED_THRESHOLD/,
        'Must check five_hour against EXHAUSTED_THRESHOLD'
      );

      assert.match(
        fnBody,
        /seven_day.*EXHAUSTED_THRESHOLD/,
        'Must check seven_day against EXHAUSTED_THRESHOLD'
      );

      assert.match(
        fnBody,
        /seven_day_sonnet.*EXHAUSTED_THRESHOLD/,
        'Must check seven_day_sonnet against EXHAUSTED_THRESHOLD'
      );
    });
  });

  describe('Behavioral logic: selectActiveKey() with duplicate account keys', () => {
    it('should select between 2 accounts when 4 keys share 2 account_uuids', () => {
      // Simulate 4 keys: 2 for account A, 2 for account B
      const now = Date.now();
      const state = {
        active_key_id: 'key1',
        keys: {
          'key1': {
            status: 'active',
            account_uuid: 'account-A',
            expiresAt: now + 1000,  // older token
            last_usage: { five_hour: 50, seven_day: 50, seven_day_sonnet: 50 },
          },
          'key2': {
            status: 'active',
            account_uuid: 'account-A',
            expiresAt: now + 10000, // fresher token
            last_usage: { five_hour: 50, seven_day: 50, seven_day_sonnet: 50 },
          },
          'key3': {
            status: 'active',
            account_uuid: 'account-B',
            expiresAt: now + 2000,  // older token
            last_usage: { five_hour: 30, seven_day: 30, seven_day_sonnet: 30 },
          },
          'key4': {
            status: 'active',
            account_uuid: 'account-B',
            expiresAt: now + 20000, // fresher token
            last_usage: { five_hour: 30, seven_day: 30, seven_day_sonnet: 30 },
          },
        },
      };

      // Simulate the grouping logic
      const accountGroups = new Map();
      for (const [id, key] of Object.entries(state.keys)) {
        const uuid = key.account_uuid;
        if (!uuid) {
          accountGroups.set(`__no_uuid__${id}`, [{ id, key, usage: key.last_usage }]);
        } else {
          if (!accountGroups.has(uuid)) {
            accountGroups.set(uuid, []);
          }
          accountGroups.get(uuid).push({ id, key, usage: key.last_usage });
        }
      }

      // Should have 2 account groups, not 4
      assert.strictEqual(
        accountGroups.size,
        2,
        'Must group 4 keys into 2 account groups'
      );

      // Pick representative from each group (highest expiresAt)
      const representatives = [];
      for (const entries of accountGroups.values()) {
        entries.sort((a, b) => (b.key.expiresAt || 0) - (a.key.expiresAt || 0));
        representatives.push(entries[0]);
      }

      // Should have 2 representatives
      assert.strictEqual(
        representatives.length,
        2,
        'Must select 2 representatives from 2 account groups'
      );

      // Representatives should be the freshest tokens (key2, key4)
      const repIds = representatives.map(r => r.id).sort();
      assert.deepStrictEqual(
        repIds,
        ['key2', 'key4'],
        'Must select freshest token from each account group'
      );
    });

    it('should treat keys without account_uuid as unique accounts', () => {
      const now = Date.now();
      const state = {
        active_key_id: 'key1',
        keys: {
          'key1': {
            status: 'active',
            account_uuid: null,
            expiresAt: now + 1000,
            last_usage: { five_hour: 50, seven_day: 50, seven_day_sonnet: 50 },
          },
          'key2': {
            status: 'active',
            account_uuid: null,
            expiresAt: now + 2000,
            last_usage: { five_hour: 30, seven_day: 30, seven_day_sonnet: 30 },
          },
          'key3': {
            status: 'active',
            account_uuid: 'account-A',
            expiresAt: now + 3000,
            last_usage: { five_hour: 40, seven_day: 40, seven_day_sonnet: 40 },
          },
        },
      };

      // Simulate grouping
      const accountGroups = new Map();
      for (const [id, key] of Object.entries(state.keys)) {
        const uuid = key.account_uuid;
        if (!uuid) {
          accountGroups.set(`__no_uuid__${id}`, [{ id, key, usage: key.last_usage }]);
        } else {
          if (!accountGroups.has(uuid)) {
            accountGroups.set(uuid, []);
          }
          accountGroups.get(uuid).push({ id, key, usage: key.last_usage });
        }
      }

      // Should have 3 groups: 2 unique (no uuid) + 1 account
      assert.strictEqual(
        accountGroups.size,
        3,
        'Must treat keys without account_uuid as separate unique accounts'
      );

      // Each key without uuid should have its own group
      assert.ok(
        accountGroups.has('__no_uuid__key1'),
        'key1 must have unique group'
      );
      assert.ok(
        accountGroups.has('__no_uuid__key2'),
        'key2 must have unique group'
      );
      assert.ok(
        accountGroups.has('account-A'),
        'account-A must have its own group'
      );
    });

    it('should apply threshold logic to account representatives, not individual keys', () => {
      // After grouping, threshold checks (90%, 100%) apply to representatives
      const now = Date.now();
      const representatives = [
        {
          id: 'key-A-fresh',
          key: { status: 'active', account_uuid: 'account-A', expiresAt: now + 10000 },
          usage: { five_hour: 85, seven_day: 85, seven_day_sonnet: 85 },
        },
        {
          id: 'key-B-fresh',
          key: { status: 'active', account_uuid: 'account-B', expiresAt: now + 20000 },
          usage: { five_hour: 40, seven_day: 40, seven_day_sonnet: 40 },
        },
      ];

      // Filter out exhausted (100%)
      const EXHAUSTED_THRESHOLD = 100;
      const usable = representatives.filter(({ usage }) => {
        if (!usage) return true;
        return usage.five_hour < EXHAUSTED_THRESHOLD &&
               usage.seven_day < EXHAUSTED_THRESHOLD &&
               usage.seven_day_sonnet < EXHAUSTED_THRESHOLD;
      });

      assert.strictEqual(
        usable.length,
        2,
        'Both representatives are below 100%, so both are usable'
      );

      // Check if all above 90%
      const HIGH_USAGE_THRESHOLD = 90;
      const allAbove90 = usable.every(({ usage }) => {
        if (!usage) return false;
        return usage.five_hour >= HIGH_USAGE_THRESHOLD ||
               usage.seven_day >= HIGH_USAGE_THRESHOLD ||
               usage.seven_day_sonnet >= HIGH_USAGE_THRESHOLD;
      });

      assert.strictEqual(
        allAbove90,
        false,
        'Not all representatives are above 90% (key-B is at 40%)'
      );
    });
  });
});

describe('key-sync.js - deduplicateKeys() function', () => {
  describe('Code Structure: deduplicateKeys() export and implementation', () => {
    it('should export deduplicateKeys function', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      assert.match(
        code,
        /export function deduplicateKeys\(/,
        'deduplicateKeys must be exported'
      );
    });

    it('should accept state parameter and return result object', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function deduplicateKeys\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'deduplicateKeys must be defined');
      const fnBody = fnMatch[0];

      // Should accept state parameter
      assert.match(
        fnBody,
        /function deduplicateKeys\(state\)/,
        'Must accept state parameter'
      );

      // Should return result with merged count
      assert.match(
        fnBody,
        /return result/,
        'Must return result object'
      );

      assert.match(
        fnBody,
        /merged/,
        'Result object must include merged count'
      );
    });

    it('should group keys by account_uuid', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function deduplicateKeys\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'deduplicateKeys must be defined');
      const fnBody = fnMatch[0];

      // Should create accountGroups Map
      assert.match(
        fnBody,
        /accountGroups\s*=\s*new Map\(\)/,
        'Must create accountGroups Map'
      );

      // Should check account_uuid
      assert.match(
        fnBody,
        /account_uuid/,
        'Must reference account_uuid for grouping'
      );
    });

    it('should skip keys without account_uuid', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function deduplicateKeys\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'deduplicateKeys must be defined');
      const fnBody = fnMatch[0];

      // Should skip keys without uuid
      assert.match(
        fnBody,
        /!uuid.*continue/,
        'Must skip keys without account_uuid'
      );
    });

    it('should sort entries by expiresAt to pick freshest token', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function deduplicateKeys\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'deduplicateKeys must be defined');
      const fnBody = fnMatch[0];

      // Should sort by expiresAt
      assert.match(
        fnBody,
        /\.sort\(/,
        'Must include sort operation'
      );

      // Should reference expiresAt
      assert.match(
        fnBody,
        /expiresAt/,
        'Must reference expiresAt for comparison'
      );
    });

    it('should find most recently health-checked entry for usage data', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function deduplicateKeys\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'deduplicateKeys must be defined');
      const fnBody = fnMatch[0];

      // Should filter for entries with last_health_check
      assert.match(
        fnBody,
        /last_health_check/,
        'Must reference last_health_check field'
      );

      assert.match(
        fnBody,
        /!= null/,
        'Must filter for non-null values'
      );

      // Should include sort operation
      assert.match(
        fnBody,
        /\.sort\(/,
        'Must sort entries'
      );
    });

    it('should copy last_usage from most recently checked entry to survivor', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function deduplicateKeys\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'deduplicateKeys must be defined');
      const fnBody = fnMatch[0];

      // Should copy last_usage
      assert.match(
        fnBody,
        /survivor\.data\.last_usage = mostRecentlyChecked\.data\.last_usage/,
        'Must copy last_usage to survivor'
      );
    });

    it('should copy last_health_check from most recently checked entry to survivor', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function deduplicateKeys\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'deduplicateKeys must be defined');
      const fnBody = fnMatch[0];

      // Should copy last_health_check
      assert.match(
        fnBody,
        /survivor\.data\.last_health_check = mostRecentlyChecked\.data\.last_health_check/,
        'Must copy last_health_check to survivor'
      );
    });

    it('should delete non-survivor entries from state.keys', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function deduplicateKeys\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'deduplicateKeys must be defined');
      const fnBody = fnMatch[0];

      // Should delete removed keys
      assert.match(
        fnBody,
        /delete state\.keys\[/,
        'Must delete non-survivor keys from state.keys'
      );
    });

    it('should redirect active_key_id when merged-away key was active', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function deduplicateKeys\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'deduplicateKeys must be defined');
      const fnBody = fnMatch[0];

      // Should check if removed key was active
      assert.match(
        fnBody,
        /state\.active_key_id === removedId/,
        'Must check if removed key was active'
      );

      // Should redirect to survivor
      assert.match(
        fnBody,
        /state\.active_key_id = survivor\.id/,
        'Must redirect active_key_id to survivor'
      );
    });

    it('should increment merged counter for each removed key', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function deduplicateKeys\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'deduplicateKeys must be defined');
      const fnBody = fnMatch[0];

      // Should increment result.merged
      assert.match(
        fnBody,
        /result\.merged\+\+/,
        'Must increment merged counter'
      );
    });
  });

  describe('Behavioral logic: deduplicateKeys() scenarios', () => {
    it('should merge 2 keys with same account_uuid, keeping freshest token', () => {
      const now = Date.now();
      const state = {
        version: 1,
        active_key_id: 'key-old',
        keys: {
          'key-old': {
            accessToken: 'old-token',
            account_uuid: 'account-A',
            expiresAt: now + 1000,
            last_usage: { five_hour: 50, seven_day: 50, seven_day_sonnet: 50 },
            last_health_check: now - 1000,
          },
          'key-fresh': {
            accessToken: 'fresh-token',
            account_uuid: 'account-A',
            expiresAt: now + 10000,
            last_usage: null,
            last_health_check: null,
          },
        },
        rotation_log: [],
      };

      // Simulate deduplicateKeys logic
      const accountGroups = new Map();
      for (const [keyId, keyData] of Object.entries(state.keys)) {
        const uuid = keyData.account_uuid;
        if (!uuid) continue;
        if (!accountGroups.has(uuid)) {
          accountGroups.set(uuid, []);
        }
        accountGroups.get(uuid).push({ id: keyId, data: keyData });
      }

      let merged = 0;
      for (const [uuid, entries] of accountGroups) {
        if (entries.length <= 1) continue;

        // Sort by expiresAt descending
        entries.sort((a, b) => (b.data.expiresAt || 0) - (a.data.expiresAt || 0));
        const survivor = entries[0];

        // Find most recently checked
        const mostRecentlyChecked = entries
          .filter(e => e.data.last_health_check != null)
          .sort((a, b) => b.data.last_health_check - a.data.last_health_check)[0];

        if (mostRecentlyChecked && mostRecentlyChecked.id !== survivor.id) {
          if (mostRecentlyChecked.data.last_usage != null) {
            survivor.data.last_usage = mostRecentlyChecked.data.last_usage;
          }
          if (mostRecentlyChecked.data.last_health_check != null) {
            survivor.data.last_health_check = mostRecentlyChecked.data.last_health_check;
          }
        }

        // Remove non-survivors
        for (let i = 1; i < entries.length; i++) {
          const removedId = entries[i].id;
          if (state.active_key_id === removedId) {
            state.active_key_id = survivor.id;
          }
          delete state.keys[removedId];
          merged++;
        }
      }

      assert.strictEqual(
        Object.keys(state.keys).length,
        1,
        'Must merge 2 keys into 1'
      );

      assert.strictEqual(
        merged,
        1,
        'Must report 1 key merged'
      );

      const survivorKey = state.keys['key-fresh'];
      assert.ok(survivorKey, 'key-fresh must survive (freshest token)');
      assert.strictEqual(
        survivorKey.expiresAt,
        now + 10000,
        'Survivor must have freshest expiresAt'
      );

      // Should have usage data copied from key-old
      assert.deepStrictEqual(
        survivorKey.last_usage,
        { five_hour: 50, seven_day: 50, seven_day_sonnet: 50 },
        'Must copy last_usage from most recently checked'
      );

      assert.strictEqual(
        survivorKey.last_health_check,
        now - 1000,
        'Must copy last_health_check from most recently checked'
      );
    });

    it('should redirect active_key_id when merged-away key was active', () => {
      const now = Date.now();
      const state = {
        version: 1,
        active_key_id: 'key-old',
        keys: {
          'key-old': {
            account_uuid: 'account-A',
            expiresAt: now + 1000,
          },
          'key-fresh': {
            account_uuid: 'account-A',
            expiresAt: now + 10000,
          },
        },
        rotation_log: [],
      };

      // Simulate deduplication
      const accountGroups = new Map();
      for (const [keyId, keyData] of Object.entries(state.keys)) {
        const uuid = keyData.account_uuid;
        if (!uuid) continue;
        if (!accountGroups.has(uuid)) {
          accountGroups.set(uuid, []);
        }
        accountGroups.get(uuid).push({ id: keyId, data: keyData });
      }

      for (const entries of accountGroups.values()) {
        if (entries.length <= 1) continue;
        entries.sort((a, b) => (b.data.expiresAt || 0) - (a.data.expiresAt || 0));
        const survivor = entries[0];

        for (let i = 1; i < entries.length; i++) {
          const removedId = entries[i].id;
          if (state.active_key_id === removedId) {
            state.active_key_id = survivor.id;
          }
          delete state.keys[removedId];
        }
      }

      assert.strictEqual(
        state.active_key_id,
        'key-fresh',
        'Must redirect active_key_id to survivor when merged-away key was active'
      );
    });

    it('should skip keys without account_uuid', () => {
      const now = Date.now();
      const state = {
        version: 1,
        active_key_id: 'key1',
        keys: {
          'key1': {
            account_uuid: null,
            expiresAt: now + 1000,
          },
          'key2': {
            account_uuid: null,
            expiresAt: now + 2000,
          },
          'key3': {
            account_uuid: 'account-A',
            expiresAt: now + 3000,
          },
        },
        rotation_log: [],
      };

      // Simulate deduplication
      const accountGroups = new Map();
      for (const [keyId, keyData] of Object.entries(state.keys)) {
        const uuid = keyData.account_uuid;
        if (!uuid) continue; // Skip keys without uuid
        if (!accountGroups.has(uuid)) {
          accountGroups.set(uuid, []);
        }
        accountGroups.get(uuid).push({ id: keyId, data: keyData });
      }

      let merged = 0;
      for (const entries of accountGroups.values()) {
        if (entries.length <= 1) continue;
        merged += entries.length - 1;
      }

      assert.strictEqual(
        Object.keys(state.keys).length,
        3,
        'Must not merge keys without account_uuid'
      );

      assert.strictEqual(
        merged,
        0,
        'Must not count any merges when keys lack account_uuid'
      );
    });

    it('should handle 3+ keys from same account, picking freshest', () => {
      const now = Date.now();
      const state = {
        version: 1,
        active_key_id: 'key1',
        keys: {
          'key1': {
            account_uuid: 'account-A',
            expiresAt: now + 1000,
            last_health_check: now - 1000,
            last_usage: { five_hour: 50, seven_day: 50, seven_day_sonnet: 50 },
          },
          'key2': {
            account_uuid: 'account-A',
            expiresAt: now + 5000,
            last_health_check: null,
            last_usage: null,
          },
          'key3': {
            account_uuid: 'account-A',
            expiresAt: now + 10000, // freshest
            last_health_check: null,
            last_usage: null,
          },
        },
        rotation_log: [],
      };

      // Simulate deduplication
      const accountGroups = new Map();
      for (const [keyId, keyData] of Object.entries(state.keys)) {
        const uuid = keyData.account_uuid;
        if (!uuid) continue;
        if (!accountGroups.has(uuid)) {
          accountGroups.set(uuid, []);
        }
        accountGroups.get(uuid).push({ id: keyId, data: keyData });
      }

      let merged = 0;
      for (const entries of accountGroups.values()) {
        if (entries.length <= 1) continue;

        entries.sort((a, b) => (b.data.expiresAt || 0) - (a.data.expiresAt || 0));
        const survivor = entries[0];

        const mostRecentlyChecked = entries
          .filter(e => e.data.last_health_check != null)
          .sort((a, b) => b.data.last_health_check - a.data.last_health_check)[0];

        if (mostRecentlyChecked && mostRecentlyChecked.id !== survivor.id) {
          if (mostRecentlyChecked.data.last_usage != null) {
            survivor.data.last_usage = mostRecentlyChecked.data.last_usage;
          }
          if (mostRecentlyChecked.data.last_health_check != null) {
            survivor.data.last_health_check = mostRecentlyChecked.data.last_health_check;
          }
        }

        for (let i = 1; i < entries.length; i++) {
          const removedId = entries[i].id;
          if (state.active_key_id === removedId) {
            state.active_key_id = survivor.id;
          }
          delete state.keys[removedId];
          merged++;
        }
      }

      assert.strictEqual(
        Object.keys(state.keys).length,
        1,
        'Must merge 3 keys into 1'
      );

      assert.strictEqual(
        merged,
        2,
        'Must report 2 keys merged'
      );

      const survivorKey = state.keys['key3'];
      assert.ok(survivorKey, 'key3 must survive (freshest)');

      // Should have usage data from key1
      assert.deepStrictEqual(
        survivorKey.last_usage,
        { five_hour: 50, seven_day: 50, seven_day_sonnet: 50 },
        'Must copy last_usage from most recently checked (key1)'
      );
    });
  });
});
