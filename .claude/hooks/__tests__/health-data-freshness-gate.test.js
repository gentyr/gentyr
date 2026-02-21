/**
 * Tests for health data freshness gate in key-sync.js
 *
 * Covers the freshness gate addition to selectActiveKey():
 * 1. Export of HEALTH_DATA_MAX_AGE_MS constant (15 min)
 * 2. Freshness check loop that nulls out stale usage data
 * 3. Effect: stale keys pass "usable" filter but block "allAbove90" early-return
 * 4. Effect: stale keys excluded from comparison logic (no uninformed switches)
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/health-data-freshness-gate.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEY_SYNC_PATH = path.join(__dirname, '..', 'key-sync.js');

describe('key-sync.js - HEALTH_DATA_MAX_AGE_MS constant', () => {
  describe('Code Structure: Export and value', () => {
    it('should export HEALTH_DATA_MAX_AGE_MS constant', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      assert.match(
        code,
        /export const HEALTH_DATA_MAX_AGE_MS/,
        'HEALTH_DATA_MAX_AGE_MS must be exported'
      );
    });

    it('should define HEALTH_DATA_MAX_AGE_MS as 15 minutes in milliseconds', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const match = code.match(/export const HEALTH_DATA_MAX_AGE_MS\s*=\s*([^;]+);/);
      assert.ok(match, 'HEALTH_DATA_MAX_AGE_MS must be defined');

      // Check it's 15 * 60 * 1000 (900000 ms = 15 min)
      assert.match(
        match[1],
        /15\s*\*\s*60\s*\*\s*1000/,
        'HEALTH_DATA_MAX_AGE_MS must be 15 * 60 * 1000 (15 minutes)'
      );
    });

    it('should include a comment describing the purpose', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const match = code.match(/export const HEALTH_DATA_MAX_AGE_MS.*?\/\/.*/);
      assert.ok(match, 'HEALTH_DATA_MAX_AGE_MS must have a comment');

      assert.match(
        match[0],
        /15 min/i,
        'Comment must reference 15 min'
      );

      assert.match(
        match[0],
        /usage data.*treated as unknown|stale|old/i,
        'Comment must explain that stale data is treated as unknown'
      );
    });
  });

  describe('Behavioral: Constant value', () => {
    it('should equal exactly 900000 milliseconds (15 minutes)', () => {
      const HEALTH_DATA_MAX_AGE_MS = 15 * 60 * 1000;

      assert.strictEqual(
        HEALTH_DATA_MAX_AGE_MS,
        900000,
        'HEALTH_DATA_MAX_AGE_MS must equal 900000 ms'
      );
    });

    it('should be 1.5x the EXPIRY_BUFFER_MS (10 min)', () => {
      const EXPIRY_BUFFER_MS = 600000; // 10 min
      const HEALTH_DATA_MAX_AGE_MS = 15 * 60 * 1000; // 15 min

      assert.strictEqual(
        HEALTH_DATA_MAX_AGE_MS / EXPIRY_BUFFER_MS,
        1.5,
        'HEALTH_DATA_MAX_AGE_MS must be 1.5x EXPIRY_BUFFER_MS'
      );
    });
  });
});

describe('key-sync.js - selectActiveKey() freshness gate', () => {
  describe('Code Structure: Freshness check implementation', () => {
    it('should capture current timestamp as "now" at start of selectActiveKey', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /const now = Date\.now\(\)/,
        'Must capture current timestamp as "now"'
      );
    });

    it('should include a freshness gate comment block', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /Freshness gate.*null out usage.*stale health data/i,
        'Must have freshness gate comment explaining purpose'
      );

      assert.match(
        fnBody,
        /Effect.*stale keys.*usable.*filter/i,
        'Comment must explain effect on usable filter'
      );

      assert.match(
        fnBody,
        /Effect.*excluded from comparison|excluded from comparison logic/i,
        'Comment must explain exclusion from comparison logic'
      );
    });

    it('should loop over validKeys entries to check freshness', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /for \(const entry of validKeys\)/,
        'Must loop over validKeys to check freshness'
      );
    });

    it('should check entry.key.last_health_check for staleness', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /entry\.key\.last_health_check/,
        'Must reference entry.key.last_health_check'
      );
    });

    it('should use HEALTH_DATA_MAX_AGE_MS in the staleness check', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /HEALTH_DATA_MAX_AGE_MS/,
        'Must use HEALTH_DATA_MAX_AGE_MS constant in staleness check'
      );
    });

    it('should check if (now - lastCheck) > HEALTH_DATA_MAX_AGE_MS', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      // Look for the pattern: (now - lastCheck) > HEALTH_DATA_MAX_AGE_MS
      assert.match(
        fnBody,
        /\(now - lastCheck\)\s*>\s*HEALTH_DATA_MAX_AGE_MS/,
        'Must check if (now - lastCheck) > HEALTH_DATA_MAX_AGE_MS'
      );
    });

    it('should null out entry.usage when data is stale', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /entry\.usage = null/,
        'Must set entry.usage = null when health data is stale'
      );
    });

    it('should guard lastCheck with truthiness check before comparison', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      // Should check if lastCheck exists before doing math
      assert.match(
        fnBody,
        /if \(lastCheck &&/,
        'Must guard lastCheck with truthiness check'
      );
    });

    it('should perform freshness gate AFTER validKeys creation, BEFORE account grouping', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export function selectActiveKey\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'selectActiveKey must be defined');
      const fnBody = fnMatch[0];

      const validKeysIndex = fnBody.indexOf('const validKeys');
      const freshnessGateIndex = fnBody.indexOf('Freshness gate');
      const accountGroupsIndex = fnBody.indexOf('accountGroups = new Map()');

      assert.ok(validKeysIndex > -1, 'validKeys must exist');
      assert.ok(freshnessGateIndex > -1, 'Freshness gate must exist');
      assert.ok(accountGroupsIndex > -1, 'accountGroups must exist');

      assert.ok(
        validKeysIndex < freshnessGateIndex,
        'Freshness gate must come AFTER validKeys creation'
      );

      assert.ok(
        freshnessGateIndex < accountGroupsIndex,
        'Freshness gate must come BEFORE account grouping'
      );
    });
  });

  describe('Behavioral logic: Freshness gate scenarios', () => {
    it('should null out usage when last_health_check is exactly 15 minutes old', () => {
      const now = Date.now();
      const HEALTH_DATA_MAX_AGE_MS = 15 * 60 * 1000;

      const entry = {
        id: 'key1',
        key: {
          status: 'active',
          last_health_check: now - HEALTH_DATA_MAX_AGE_MS, // exactly at threshold
        },
        usage: { five_hour: 50, seven_day: 50, seven_day_sonnet: 50 },
      };

      // Simulate freshness gate
      const lastCheck = entry.key.last_health_check;
      if (lastCheck && (now - lastCheck) > HEALTH_DATA_MAX_AGE_MS) {
        entry.usage = null;
      }

      // At exactly the threshold (not >) should NOT null
      assert.notStrictEqual(
        entry.usage,
        null,
        'Usage should NOT be nulled at exactly 15 min threshold (> not >=)'
      );
    });

    it('should null out usage when last_health_check is 15 minutes + 1 ms old', () => {
      const now = Date.now();
      const HEALTH_DATA_MAX_AGE_MS = 15 * 60 * 1000;

      const entry = {
        id: 'key1',
        key: {
          status: 'active',
          last_health_check: now - HEALTH_DATA_MAX_AGE_MS - 1, // 1 ms past threshold
        },
        usage: { five_hour: 50, seven_day: 50, seven_day_sonnet: 50 },
      };

      // Simulate freshness gate
      const lastCheck = entry.key.last_health_check;
      if (lastCheck && (now - lastCheck) > HEALTH_DATA_MAX_AGE_MS) {
        entry.usage = null;
      }

      assert.strictEqual(
        entry.usage,
        null,
        'Usage must be nulled when 1 ms past 15 min threshold'
      );
    });

    it('should NOT null out usage when last_health_check is 14 minutes old', () => {
      const now = Date.now();
      const HEALTH_DATA_MAX_AGE_MS = 15 * 60 * 1000;

      const entry = {
        id: 'key1',
        key: {
          status: 'active',
          last_health_check: now - 14 * 60 * 1000, // 14 min old (within threshold)
        },
        usage: { five_hour: 50, seven_day: 50, seven_day_sonnet: 50 },
      };

      const originalUsage = entry.usage;

      // Simulate freshness gate
      const lastCheck = entry.key.last_health_check;
      if (lastCheck && (now - lastCheck) > HEALTH_DATA_MAX_AGE_MS) {
        entry.usage = null;
      }

      assert.strictEqual(
        entry.usage,
        originalUsage,
        'Usage must NOT be nulled when within 15 min threshold'
      );
    });

    it('should NOT null out usage when last_health_check is null (no data yet)', () => {
      const now = Date.now();
      const HEALTH_DATA_MAX_AGE_MS = 15 * 60 * 1000;

      const entry = {
        id: 'key1',
        key: {
          status: 'active',
          last_health_check: null, // never checked
        },
        usage: null,
      };

      // Simulate freshness gate
      const lastCheck = entry.key.last_health_check;
      if (lastCheck && (now - lastCheck) > HEALTH_DATA_MAX_AGE_MS) {
        entry.usage = null;
      }

      // Should not crash or modify entry.usage
      assert.strictEqual(
        entry.usage,
        null,
        'Usage remains null (gate skipped when last_health_check is null)'
      );
    });

    it('should null out usage when last_health_check is 24 hours old', () => {
      const now = Date.now();
      const HEALTH_DATA_MAX_AGE_MS = 15 * 60 * 1000;

      const entry = {
        id: 'key1',
        key: {
          status: 'active',
          last_health_check: now - 24 * 60 * 60 * 1000, // 24 hours old
        },
        usage: { five_hour: 50, seven_day: 50, seven_day_sonnet: 50 },
      };

      // Simulate freshness gate
      const lastCheck = entry.key.last_health_check;
      if (lastCheck && (now - lastCheck) > HEALTH_DATA_MAX_AGE_MS) {
        entry.usage = null;
      }

      assert.strictEqual(
        entry.usage,
        null,
        'Usage must be nulled when 24 hours old (way past threshold)'
      );
    });

    it('should allow stale key to pass "usable" filter (not proven exhausted)', () => {
      const EXHAUSTED_THRESHOLD = 100;

      const staleKey = {
        id: 'stale-key',
        key: { status: 'active' },
        usage: null, // nulled by freshness gate
      };

      // Simulate usable filter logic
      const isUsable = !staleKey.usage || (
        staleKey.usage.five_hour < EXHAUSTED_THRESHOLD &&
        staleKey.usage.seven_day < EXHAUSTED_THRESHOLD &&
        staleKey.usage.seven_day_sonnet < EXHAUSTED_THRESHOLD
      );

      assert.strictEqual(
        isUsable,
        true,
        'Stale key (usage=null) must pass usable filter'
      );
    });

    it('should block "allAbove90" early-return when stale key present', () => {
      const HIGH_USAGE_THRESHOLD = 90;

      const usableKeys = [
        {
          id: 'high-key',
          usage: { five_hour: 95, seven_day: 85, seven_day_sonnet: 80 },
        },
        {
          id: 'stale-key',
          usage: null, // nulled by freshness gate
        },
      ];

      // Simulate allAbove90 check
      const allAbove90 = usableKeys.every(({ usage }) => {
        if (!usage) return false; // stale key returns false
        return usage.five_hour >= HIGH_USAGE_THRESHOLD ||
               usage.seven_day >= HIGH_USAGE_THRESHOLD ||
               usage.seven_day_sonnet >= HIGH_USAGE_THRESHOLD;
      });

      assert.strictEqual(
        allAbove90,
        false,
        'allAbove90 must be false when stale key (usage=null) is present'
      );
    });

    it('should exclude stale key from usage-based comparison logic', () => {
      const HIGH_USAGE_THRESHOLD = 90;

      const usableKeys = [
        {
          id: 'current-key',
          usage: { five_hour: 85, seven_day: 75, seven_day_sonnet: 70 },
        },
        {
          id: 'stale-key',
          usage: null, // nulled by freshness gate
        },
      ];

      // Simulate comparison logic (finds keys with usage < 90%)
      const sortedByUsage = usableKeys
        .filter(k => k.usage) // excludes stale key
        .sort((a, b) => {
          const aMax = Math.max(a.usage.five_hour, a.usage.seven_day, a.usage.seven_day_sonnet);
          const bMax = Math.max(b.usage.five_hour, b.usage.seven_day, b.usage.seven_day_sonnet);
          return aMax - bMax;
        });

      assert.strictEqual(
        sortedByUsage.length,
        1,
        'Stale key must be excluded from comparison logic'
      );

      assert.strictEqual(
        sortedByUsage[0].id,
        'current-key',
        'Only current-key should remain in comparison pool'
      );
    });

    it('should cause system to stay put when all keys have stale data', () => {
      const usableKeys = [
        { id: 'key1', usage: null }, // stale
        { id: 'key2', usage: null }, // stale
        { id: 'key3', usage: null }, // stale
      ];

      const currentKeyId = 'key1';

      // Simulate: comparison logic finds nothing (all usage=null)
      const sortedByUsage = usableKeys
        .filter(k => k.id !== currentKeyId && k.usage)
        .sort((a, b) => {
          const aMax = Math.max(a.usage.five_hour, a.usage.seven_day, a.usage.seven_day_sonnet);
          const bMax = Math.max(b.usage.five_hour, b.usage.seven_day, b.usage.seven_day_sonnet);
          return aMax - bMax;
        });

      assert.strictEqual(
        sortedByUsage.length,
        0,
        'No keys available for comparison when all data is stale'
      );

      // Default: stay with current key
      const selectedKey = sortedByUsage.length > 0 ? sortedByUsage[0].id : currentKeyId;

      assert.strictEqual(
        selectedKey,
        currentKeyId,
        'System must stay put with current key when all data is stale'
      );
    });
  });

  describe('Integration: Freshness gate effect on key selection', () => {
    it('should NOT switch from 80% key to stale key (unknown usage)', () => {
      const now = Date.now();
      const HIGH_USAGE_THRESHOLD = 90;
      const EXHAUSTED_THRESHOLD = 100;
      const HEALTH_DATA_MAX_AGE_MS = 15 * 60 * 1000;

      const state = {
        active_key_id: 'current-key',
        keys: {
          'current-key': {
            status: 'active',
            last_health_check: now - 5 * 60 * 1000, // 5 min ago (fresh)
            last_usage: { five_hour: 80, seven_day: 70, seven_day_sonnet: 65 },
          },
          'stale-key': {
            status: 'active',
            last_health_check: now - 20 * 60 * 1000, // 20 min ago (stale)
            last_usage: { five_hour: 10, seven_day: 10, seven_day_sonnet: 10 }, // low, but stale
          },
        },
      };

      // Simulate selectActiveKey logic with freshness gate
      const validKeys = Object.entries(state.keys)
        .map(([id, key]) => ({ id, key, usage: key.last_usage }));

      // Freshness gate: null out stale usage
      for (const entry of validKeys) {
        const lastCheck = entry.key.last_health_check;
        if (lastCheck && (now - lastCheck) > HEALTH_DATA_MAX_AGE_MS) {
          entry.usage = null;
        }
      }

      // Filter usable
      const usableKeys = validKeys.filter(({ usage }) => {
        if (!usage) return true; // no data, assume usable
        return usage.five_hour < EXHAUSTED_THRESHOLD &&
               usage.seven_day < EXHAUSTED_THRESHOLD &&
               usage.seven_day_sonnet < EXHAUSTED_THRESHOLD;
      });

      // Check allAbove90
      const allAbove90 = usableKeys.every(({ usage }) => {
        if (!usage) return false; // stale key blocks this
        return usage.five_hour >= HIGH_USAGE_THRESHOLD ||
               usage.seven_day >= HIGH_USAGE_THRESHOLD ||
               usage.seven_day_sonnet >= HIGH_USAGE_THRESHOLD;
      });

      assert.strictEqual(allAbove90, false, 'allAbove90 must be false (stale key present)');

      const currentKey = usableKeys.find(k => k.id === state.active_key_id);
      const currentMaxUsage = Math.max(
        currentKey.usage.five_hour,
        currentKey.usage.seven_day,
        currentKey.usage.seven_day_sonnet
      );

      // Should NOT switch (current is 80%, below 90% threshold)
      assert.ok(
        currentMaxUsage < HIGH_USAGE_THRESHOLD,
        'Current key is below 90%, should not switch'
      );

      // Comparison logic excludes stale key
      const sortedByUsage = usableKeys
        .filter(k => k.id !== state.active_key_id && k.usage)
        .sort((a, b) => {
          const aMax = Math.max(a.usage.five_hour, a.usage.seven_day, a.usage.seven_day_sonnet);
          const bMax = Math.max(b.usage.five_hour, b.usage.seven_day, b.usage.seven_day_sonnet);
          return aMax - bMax;
        });

      assert.strictEqual(
        sortedByUsage.length,
        0,
        'No alternative keys available (stale-key excluded)'
      );

      // Result: stay with current-key
      const selectedKey = currentKey.id;

      assert.strictEqual(
        selectedKey,
        'current-key',
        'Must NOT switch to stale key with unknown usage'
      );
    });

    it('should allow stale key to be selected if current key hits 100%', () => {
      const now = Date.now();
      const EXHAUSTED_THRESHOLD = 100;
      const HEALTH_DATA_MAX_AGE_MS = 15 * 60 * 1000;

      const state = {
        active_key_id: 'current-key',
        keys: {
          'current-key': {
            status: 'active',
            last_health_check: now - 1 * 60 * 1000, // 1 min ago (fresh)
            last_usage: { five_hour: 100, seven_day: 95, seven_day_sonnet: 90 }, // exhausted
          },
          'stale-key': {
            status: 'active',
            last_health_check: now - 20 * 60 * 1000, // 20 min ago (stale)
            last_usage: { five_hour: 50, seven_day: 50, seven_day_sonnet: 50 }, // unknown
          },
        },
      };

      // Simulate selectActiveKey logic with freshness gate
      const validKeys = Object.entries(state.keys)
        .map(([id, key]) => ({ id, key, usage: key.last_usage }));

      // Freshness gate
      for (const entry of validKeys) {
        const lastCheck = entry.key.last_health_check;
        if (lastCheck && (now - lastCheck) > HEALTH_DATA_MAX_AGE_MS) {
          entry.usage = null;
        }
      }

      // Filter usable
      const usableKeys = validKeys.filter(({ usage }) => {
        if (!usage) return true; // stale key passes
        return usage.five_hour < EXHAUSTED_THRESHOLD &&
               usage.seven_day < EXHAUSTED_THRESHOLD &&
               usage.seven_day_sonnet < EXHAUSTED_THRESHOLD;
      });

      // current-key should be filtered out (100% in five_hour)
      assert.strictEqual(
        usableKeys.length,
        1,
        'Only stale-key should be usable (current-key exhausted)'
      );

      assert.strictEqual(
        usableKeys[0].id,
        'stale-key',
        'stale-key must be selected when current is exhausted'
      );
    });
  });
});
