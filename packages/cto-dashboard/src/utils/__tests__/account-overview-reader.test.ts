/**
 * Unit tests for account-overview-reader
 *
 * Tests schema parsing and data transformation:
 * - Zod schema validation for nullable fields (account_uuid, account_email)
 * - Zod schema validation for unknown field (resets_at)
 * - Graceful handling of missing/null values
 * - Account sorting logic (current first, then by status, then by addedAt)
 * - Event filtering and truncation (last 24h, cap at 20)
 * - Key ID truncation
 * - Rotation count calculation
 *
 * Philosophy: Validate structure and behavior, not implementation details.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAccountOverviewData } from '../account-overview-reader.js';
import type { AccountOverviewData } from '../account-overview-reader.js';

describe('account-overview-reader', () => {
  const testFilePath = path.join(os.homedir(), '.claude', 'api-key-rotation.json');
  let originalContent: string | null = null;
  let fileExisted = false;

  beforeEach(() => {
    // Backup original file if it exists
    if (fs.existsSync(testFilePath)) {
      originalContent = fs.readFileSync(testFilePath, 'utf8');
      fileExisted = true;
    }
  });

  afterEach(() => {
    // Restore original file
    if (fileExisted && originalContent !== null) {
      fs.writeFileSync(testFilePath, originalContent, 'utf8');
    } else if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    originalContent = null;
    fileExisted = false;
  });

  describe('Schema Validation - Nullable Fields', () => {
    it('should parse account_email as null when field is null', () => {
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            account_email: null, // Null value
            account_uuid: 'uuid-456',
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.hasData).toBe(true);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].email).toBeNull();
    });

    it('should parse account_uuid as null when field is null', () => {
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            account_email: 'test@example.com',
            account_uuid: null, // Null value
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.hasData).toBe(true);
      expect(result.accounts).toHaveLength(1);
      // account_uuid is internal - verify it doesn't crash parsing
      expect(result.accounts[0].email).toBe('test@example.com');
    });

    it('should parse account_email when field is missing (optional)', () => {
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            // account_email is missing (optional)
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.hasData).toBe(true);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].email).toBeNull();
    });

    it('should parse account_uuid when field is missing (optional)', () => {
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            account_email: 'test@example.com',
            // account_uuid is missing (optional)
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.hasData).toBe(true);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].email).toBe('test@example.com');
    });

    it('should parse account_email as string when valid', () => {
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            account_email: 'valid@example.com',
            account_uuid: 'uuid-789',
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.hasData).toBe(true);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].email).toBe('valid@example.com');
    });
  });

  describe('Schema Validation - Unknown Field (resets_at)', () => {
    it('should parse resets_at when it is a string', () => {
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            last_usage: {
              five_hour: 35,
              seven_day: 70,
              resets_at: '2026-03-01T12:00:00Z', // String value
            },
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.hasData).toBe(true);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].fiveHourPct).toBe(35);
      expect(result.accounts[0].sevenDayPct).toBe(70);
    });

    it('should parse resets_at when it is an object', () => {
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            last_usage: {
              five_hour: 35,
              seven_day: 70,
              resets_at: { value: '2026-03-01T12:00:00Z' }, // Object value
            },
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.hasData).toBe(true);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].fiveHourPct).toBe(35);
      expect(result.accounts[0].sevenDayPct).toBe(70);
    });

    it('should parse resets_at when it is a number', () => {
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            last_usage: {
              five_hour: 35,
              seven_day: 70,
              resets_at: 1709294400000, // Timestamp value
            },
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.hasData).toBe(true);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].fiveHourPct).toBe(35);
      expect(result.accounts[0].sevenDayPct).toBe(70);
    });

    it('should parse last_usage when resets_at is missing (optional)', () => {
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            last_usage: {
              five_hour: 35,
              seven_day: 70,
              // resets_at is missing (optional)
            },
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.hasData).toBe(true);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].fiveHourPct).toBe(35);
      expect(result.accounts[0].sevenDayPct).toBe(70);
    });

    it('should parse last_usage when it is null', () => {
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            last_usage: null, // Null value
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.hasData).toBe(true);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].fiveHourPct).toBeNull();
      expect(result.accounts[0].sevenDayPct).toBeNull();
    });
  });

  describe('Empty State Handling', () => {
    it('should return empty data when file does not exist', () => {
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath);
      }

      const result = getAccountOverviewData();

      expect(result.hasData).toBe(false);
      expect(result.accounts).toHaveLength(0);
      expect(result.activeKeyId).toBeNull();
      expect(result.events).toHaveLength(0);
      expect(result.totalRotations24h).toBe(0);
    });

    it('should return empty data when file has invalid JSON', () => {
      fs.writeFileSync(testFilePath, 'invalid json{', 'utf8');
      const result = getAccountOverviewData();

      expect(result.hasData).toBe(false);
      expect(result.accounts).toHaveLength(0);
    });

    it('should return empty data when version is not 1', () => {
      const testData = {
        version: 2, // Invalid version
        active_key_id: 'key-123',
        keys: {},
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.hasData).toBe(false);
      expect(result.accounts).toHaveLength(0);
    });

    it('should return empty data when schema validation fails', () => {
      const testData = {
        version: 1,
        // Missing required fields
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.hasData).toBe(false);
    });
  });

  describe('Account Sorting Logic', () => {
    it('should sort current account first', () => {
      const testData = {
        version: 1,
        active_key_id: 'current-key',
        keys: {
          'other-key': {
            status: 'active',
            added_at: Date.now(),
          },
          'current-key': {
            status: 'active',
            added_at: Date.now() - 1000,
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.accounts).toHaveLength(2);
      expect(result.accounts[0].keyId).toBe('current-...');
      expect(result.accounts[0].isCurrent).toBe(true);
    });

    it('should sort by status when current status is equal', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'invalid-key': {
            status: 'invalid',
            added_at: now,
          },
          'active-key': {
            status: 'active',
            added_at: now,
          },
          'exhausted-key': {
            status: 'exhausted',
            added_at: now,
          },
          'expired-key': {
            status: 'expired',
            added_at: now,
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.accounts).toHaveLength(3);
      // Order: active, exhausted, expired (invalid keys are filtered out)
      expect(result.accounts[0].status).toBe('active');
      expect(result.accounts[1].status).toBe('exhausted');
      expect(result.accounts[2].status).toBe('expired');
    });

    it('should sort by addedAt desc when status is equal', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'newer-key': {
            status: 'active',
            added_at: now,
          },
          'older-key': {
            status: 'active',
            added_at: now - 10000,
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.accounts).toHaveLength(2);
      expect(result.accounts[0].keyId).toBe('newer-ke...');
      expect(result.accounts[1].keyId).toBe('older-ke...');
    });
  });

  describe('Event Filtering and Truncation', () => {
    it('should filter events older than 24h', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {},
        rotation_log: [
          {
            timestamp: now - 25 * 60 * 60 * 1000, // 25 hours ago
            event: 'key_switched',
            key_id: 'old-key',
            reason: 'test',
          },
          {
            timestamp: now - 1 * 60 * 60 * 1000, // 1 hour ago
            event: 'key_switched',
            key_id: 'recent-key',
            reason: 'test',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].keyId).toBe('recent-k...');
    });

    it('should filter non-whitelisted events (health_check, key_removed, key_refreshed)', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {},
        rotation_log: [
          {
            timestamp: now,
            event: 'health_check',
            key_id: 'key-1',
            reason: 'periodic',
          },
          {
            timestamp: now - 1000,
            event: 'key_removed',
            key_id: 'key-2',
            reason: 'token_expired',
          },
          {
            timestamp: now - 2000,
            event: 'key_refreshed',
            key_id: 'key-3',
            reason: 'proactive_standby_refresh',
          },
          {
            timestamp: now - 3000,
            event: 'key_switched',
            key_id: 'key-4',
            reason: 'test',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // Only key_switched should pass the whitelist
      expect(result.events).toHaveLength(1);
      expect(result.events[0].event).toBe('key_switched');
    });

    it('should filter key_added events with token_refreshed reason', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': { status: 'active', account_email: 'user@example.com' },
        },
        rotation_log: [
          {
            timestamp: now,
            event: 'key_added',
            key_id: 'key-1',
            reason: 'token_refreshed_proactive',
          },
          {
            timestamp: now - 1000,
            event: 'key_added',
            key_id: 'key-1',
            reason: 'new_key_from_keychain_claude_max',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // Only the non-token_refreshed key_added event should show
      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('New account added: user@example.com');
    });

    it('should allow all 7 whitelisted event types', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': { status: 'active', account_email: 'user@example.com' },
        },
        rotation_log: [
          { timestamp: now, event: 'key_added', key_id: 'key-1' },
          { timestamp: now - 1000, event: 'account_auth_failed', key_id: 'key-1', account_email: 'user@example.com' },
          { timestamp: now - 2000, event: 'account_nearly_depleted', key_id: 'key-1', account_email: 'user@example.com' },
          { timestamp: now - 3000, event: 'key_exhausted', key_id: 'key-1' },
          { timestamp: now - 4000, event: 'key_switched', key_id: 'key-1' },
          { timestamp: now - 5000, event: 'account_quota_refreshed', key_id: 'key-1', account_email: 'user@example.com' },
          { timestamp: now - 6000, event: 'account_removed', key_id: 'key-1', account_email: 'user@example.com' },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(7);
      const eventTypes = result.events.map(e => e.event);
      expect(eventTypes).toContain('key_added');
      expect(eventTypes).toContain('account_auth_failed');
      expect(eventTypes).toContain('account_nearly_depleted');
      expect(eventTypes).toContain('key_exhausted');
      expect(eventTypes).toContain('key_switched');
      expect(eventTypes).toContain('account_quota_refreshed');
      expect(eventTypes).toContain('account_removed');
    });

    it('should cap events at 20', () => {
      const now = Date.now();
      const rotation_log = [];
      for (let i = 0; i < 30; i++) {
        rotation_log.push({
          timestamp: now - i * 60 * 1000,
          event: 'key_switched',
          key_id: `key-${i}`,
          reason: 'test',
        });
      }

      const testData = {
        version: 1,
        active_key_id: null,
        keys: {},
        rotation_log,
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(20);
    });

    it('should sort events newest first', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {},
        rotation_log: [
          {
            timestamp: now - 2 * 60 * 60 * 1000,
            event: 'key_switched',
            key_id: 'older-key',
            reason: 'test',
          },
          {
            timestamp: now - 1 * 60 * 60 * 1000,
            event: 'key_switched',
            key_id: 'newer-key',
            reason: 'test',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(2);
      expect(result.events[0].keyId).toBe('newer-ke...');
      expect(result.events[1].keyId).toBe('older-ke...');
    });

    it('should count key_switched events for rotation count', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {},
        rotation_log: [
          {
            timestamp: now,
            event: 'key_switched',
            key_id: 'key-1',
          },
          {
            timestamp: now,
            event: 'key_switched',
            key_id: 'key-2',
          },
          {
            timestamp: now,
            event: 'key_added',
            key_id: 'key-3',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.totalRotations24h).toBe(2);
    });
  });

  describe('Key ID Truncation', () => {
    it('should truncate key IDs longer than 8 characters', () => {
      const testData = {
        version: 1,
        active_key_id: 'very-long-key-id-that-should-be-truncated',
        keys: {
          'very-long-key-id-that-should-be-truncated': {
            status: 'active',
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].keyId).toBe('very-lon...');
      expect(result.activeKeyId).toBe('very-lon...');
    });

    it('should not truncate key IDs 8 characters or shorter', () => {
      const testData = {
        version: 1,
        active_key_id: 'short',
        keys: {
          short: {
            status: 'active',
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].keyId).toBe('short');
      expect(result.activeKeyId).toBe('short');
    });
  });

  describe('Usage Snapshot Transformation', () => {
    it('should transform usage snapshot in events', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {},
        rotation_log: [
          {
            timestamp: now,
            event: 'key_switched',
            key_id: 'key-1',
            usage_snapshot: {
              five_hour: 35,
              seven_day: 70,
              seven_day_sonnet: 65,
            },
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].usageSnapshot).toEqual({
        fiveHour: 35,
        sevenDay: 70,
      });
    });

    it('should handle missing usage_snapshot in events', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {},
        rotation_log: [
          {
            timestamp: now,
            event: 'key_added',
            key_id: 'key-1',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].usageSnapshot).toBeNull();
    });
  });

  describe('Quota Data Transformation', () => {
    it('should extract quota percentages from last_usage', () => {
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            last_usage: {
              five_hour: 35,
              seven_day: 70,
              seven_day_sonnet: 65,
            },
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].fiveHourPct).toBe(35);
      expect(result.accounts[0].sevenDayPct).toBe(70);
      expect(result.accounts[0].sevenDaySonnetPct).toBe(65);
    });

    it('should handle missing seven_day_sonnet (optional)', () => {
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            last_usage: {
              five_hour: 35,
              seven_day: 70,
            },
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].fiveHourPct).toBe(35);
      expect(result.accounts[0].sevenDayPct).toBe(70);
      expect(result.accounts[0].sevenDaySonnetPct).toBeNull();
    });

    it('should set quota to null when last_usage is missing', () => {
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].fiveHourPct).toBeNull();
      expect(result.accounts[0].sevenDayPct).toBeNull();
      expect(result.accounts[0].sevenDaySonnetPct).toBeNull();
    });
  });

  describe('Timestamp Transformation', () => {
    it('should transform expiresAt timestamp to Date', () => {
      const expiryTime = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days from now
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            expiresAt: expiryTime,
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].expiresAt).toBeInstanceOf(Date);
      expect(result.accounts[0].expiresAt?.getTime()).toBe(expiryTime);
    });

    it('should transform addedAt timestamp to Date', () => {
      const addedTime = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            added_at: addedTime,
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].addedAt).toBeInstanceOf(Date);
      expect(result.accounts[0].addedAt?.getTime()).toBe(addedTime);
    });

    it('should transform lastUsedAt timestamp to Date', () => {
      const lastUsedTime = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            last_used_at: lastUsedTime,
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].lastUsedAt).toBeInstanceOf(Date);
      expect(result.accounts[0].lastUsedAt?.getTime()).toBe(lastUsedTime);
    });

    it('should handle null last_used_at', () => {
      const testData = {
        version: 1,
        active_key_id: 'key-123',
        keys: {
          'key-123': {
            status: 'active',
            last_used_at: null,
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].lastUsedAt).toBeNull();
    });
  });

  describe('Event Description with Email', () => {
    it('should use email in "New account added" description when available', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-with-email': {
            status: 'active',
            account_email: 'user@example.com',
          },
        },
        rotation_log: [
          {
            timestamp: now,
            event: 'key_added',
            key_id: 'key-with-email',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('New account added: user@example.com');
    });

    it('should use keyId in "New account added" description when email is null', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-without-email': {
            status: 'active',
            account_email: null,
          },
        },
        rotation_log: [
          {
            timestamp: now,
            event: 'key_added',
            key_id: 'key-without-email',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('New account added: key-with...');
    });

    it('should use keyId in "New account added" description when email is missing', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-no-email-field': {
            status: 'active',
          },
        },
        rotation_log: [
          {
            timestamp: now,
            event: 'key_added',
            key_id: 'key-no-email-field',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('New account added: key-no-e...');
    });

    it('should filter token_refreshed key_added events from display', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'refresh-key': {
            status: 'active',
            account_email: 'refresh@example.com',
          },
        },
        rotation_log: [
          {
            timestamp: now,
            event: 'key_added',
            key_id: 'refresh-key',
            reason: 'token_refreshed_proactive',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // token_refreshed events are now filtered from display
      expect(result.events).toHaveLength(0);
    });
  });

  describe('Event Deduplication', () => {
    it('should suppress duplicate "New account added" events for same email', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'shared@example.com',
          },
          'key-2': {
            status: 'active',
            account_email: 'shared@example.com',
          },
        },
        rotation_log: [
          {
            timestamp: now - 2000,
            event: 'key_added',
            key_id: 'key-1',
          },
          {
            timestamp: now - 1000,
            event: 'key_added',
            key_id: 'key-2',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // Should only have 1 event (first occurrence)
      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('New account added: shared@example.com');
      expect(result.events[0].keyId).toBe('key-1');
    });

    it('should suppress duplicate "New account added" events for same keyId when email is null', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'same-key': {
            status: 'active',
            account_email: null,
          },
        },
        rotation_log: [
          {
            timestamp: now - 3000,
            event: 'key_added',
            key_id: 'same-key',
          },
          {
            timestamp: now - 2000,
            event: 'key_added',
            key_id: 'same-key',
          },
          {
            timestamp: now - 1000,
            event: 'key_added',
            key_id: 'same-key',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // Should only have 1 event (first occurrence)
      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('New account added: same-key');
    });

    it('should NOT suppress "New account added" events for different emails', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'user1@example.com',
          },
          'key-2': {
            status: 'active',
            account_email: 'user2@example.com',
          },
        },
        rotation_log: [
          {
            timestamp: now - 2000,
            event: 'key_added',
            key_id: 'key-1',
          },
          {
            timestamp: now - 1000,
            event: 'key_added',
            key_id: 'key-2',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // Should have 2 events (different emails)
      expect(result.events).toHaveLength(2);
      expect(result.events.map(e => e.description)).toContain('New account added: user1@example.com');
      expect(result.events.map(e => e.description)).toContain('New account added: user2@example.com');
    });

    it('should filter all token_refreshed key_added events from display', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'refresh-key': {
            status: 'active',
            account_email: 'refresh@example.com',
          },
        },
        rotation_log: [
          {
            timestamp: now - 3000,
            event: 'key_added',
            key_id: 'refresh-key',
            reason: 'token_refreshed_proactive',
          },
          {
            timestamp: now - 2000,
            event: 'key_added',
            key_id: 'refresh-key',
            reason: 'token_refreshed_on_401',
          },
          {
            timestamp: now - 1000,
            event: 'key_added',
            key_id: 'refresh-key',
            reason: 'token_refreshed_proactive',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // All token_refreshed events are now filtered from display
      expect(result.events).toHaveLength(0);
    });

    it('should collapse consecutive identical events but keep different event types', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'user@example.com',
          },
        },
        rotation_log: [
          {
            timestamp: now - 4000,
            event: 'key_switched',
            key_id: 'key-1',
          },
          {
            timestamp: now - 3000,
            event: 'key_switched',
            key_id: 'key-1',
          },
          {
            timestamp: now - 2000,
            event: 'key_exhausted',
            key_id: 'key-1',
          },
          {
            timestamp: now - 1000,
            event: 'account_quota_refreshed',
            key_id: 'key-1',
            account_email: 'user@example.com',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // Two consecutive key_switched with same description are collapsed to one
      expect(result.events).toHaveLength(3);
      expect(result.events[0].event).toBe('account_quota_refreshed');
      expect(result.events[1].event).toBe('key_exhausted');
      expect(result.events[2].event).toBe('key_switched');
    });
  });

  describe('New Event Type Descriptions', () => {
    it('should use email from entry-level account_email for new event types', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'key-level@example.com',
          },
        },
        rotation_log: [
          {
            timestamp: now,
            event: 'account_nearly_depleted',
            key_id: 'key-1',
            account_email: 'entry-level@example.com',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      // Entry-level email takes precedence over key-level
      expect(result.events[0].description).toBe('Account nearly depleted: entry-level@example.com');
    });

    it('should fall back to key-level email when entry-level email is missing', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'key-level@example.com',
          },
        },
        rotation_log: [
          {
            timestamp: now,
            event: 'account_quota_refreshed',
            key_id: 'key-1',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('Account quota refreshed: key-level@example.com');
    });

    it('should describe account_auth_failed with email', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {},
        rotation_log: [
          {
            timestamp: now,
            event: 'account_auth_failed',
            key_id: 'key-1',
            account_email: 'dead@example.com',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('Account can no longer auth: dead@example.com');
    });

    it('should describe key_exhausted with email', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': {
            status: 'exhausted',
            account_email: 'depleted@example.com',
          },
        },
        rotation_log: [
          {
            timestamp: now,
            event: 'key_exhausted',
            key_id: 'key-1',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('Account fully depleted: depleted@example.com');
    });

    it('should describe key_switched with email', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': {
            status: 'active',
            account_email: 'selected@example.com',
          },
        },
        rotation_log: [
          {
            timestamp: now,
            event: 'key_switched',
            key_id: 'key-1',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('Account selected: selected@example.com');
    });

    it('should fall back to truncated key ID when no email available', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-no-email-123': {
            status: 'active',
          },
        },
        rotation_log: [
          {
            timestamp: now,
            event: 'key_switched',
            key_id: 'key-no-email-123',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('Account selected: key-no-e...');
    });

    it('should describe account_removed with email', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': {
            status: 'tombstone',
            account_email: 'removed@example.com',
          },
        },
        rotation_log: [
          {
            timestamp: now,
            event: 'account_removed',
            key_id: 'key-1',
            account_email: 'removed@example.com',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('Account removed by user: removed@example.com');
    });

    it('should fall back to key-level email for account_removed when entry-level email is null', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': {
            status: 'tombstone',
            account_email: 'keylevel@example.com',
          },
        },
        rotation_log: [
          {
            timestamp: now,
            event: 'account_removed',
            key_id: 'key-1',
            account_email: null,
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('Account removed by user: keylevel@example.com');
    });

    it('should not filter account_removed events for tombstone-status keys', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': {
            status: 'tombstone',
            account_email: 'removed@example.com',
          },
        },
        rotation_log: [
          {
            timestamp: now,
            event: 'account_removed',
            key_id: 'key-1',
            account_email: 'removed@example.com',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // Tombstone keys should NOT be filtered (only invalid keys are filtered)
      expect(result.events).toHaveLength(1);
      expect(result.events[0].event).toBe('account_removed');
    });
  });

  describe('Consecutive Event Deduplication', () => {
    it('should collapse many consecutive account_auth_failed events into one', () => {
      const now = Date.now();
      const rotation_log = [];
      // Simulate the bug: many account_auth_failed events for same key with null email
      for (let i = 0; i < 20; i++) {
        rotation_log.push({
          timestamp: now - i * 10000,
          event: 'account_auth_failed',
          key_id: 'dead-key-abcdef12',
          reason: 'invalid_key_pruned',
          account_email: null,
        });
      }

      const testData = {
        version: 1,
        active_key_id: null,
        keys: {},
        rotation_log,
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // All 20 identical events should collapse to just 1
      expect(result.events).toHaveLength(1);
      expect(result.events[0].event).toBe('account_auth_failed');
    });

    it('should collapse consecutive account_removed events for same key', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': {
            status: 'tombstone',
            account_email: 'removed@example.com',
          },
        },
        rotation_log: [
          {
            timestamp: now - 1000,
            event: 'account_removed',
            key_id: 'key-1',
            account_email: 'removed@example.com',
          },
          {
            timestamp: now - 2000,
            event: 'account_removed',
            key_id: 'key-1',
            account_email: 'removed@example.com',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // Consecutive identical events should collapse to 1
      expect(result.events).toHaveLength(1);
      expect(result.events[0].event).toBe('account_removed');
    });

    it('should not collapse non-consecutive identical events', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': { status: 'active', account_email: 'a@example.com' },
          'key-2': { status: 'active', account_email: 'b@example.com' },
        },
        rotation_log: [
          { timestamp: now - 4000, event: 'key_switched', key_id: 'key-1' },
          { timestamp: now - 3000, event: 'key_exhausted', key_id: 'key-2' },
          { timestamp: now - 2000, event: 'key_switched', key_id: 'key-1' },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // Non-consecutive identical events should NOT be collapsed
      expect(result.events).toHaveLength(3);
    });

    it('should not collapse events with different descriptions (different keys)', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-1': { status: 'active', account_email: 'a@example.com' },
          'key-2': { status: 'active', account_email: 'b@example.com' },
        },
        rotation_log: [
          { timestamp: now - 2000, event: 'key_switched', key_id: 'key-1' },
          { timestamp: now - 1000, event: 'key_switched', key_id: 'key-2' },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // Same event type but different descriptions (different emails) — keep both
      expect(result.events).toHaveLength(2);
    });
  });

  describe('Email Resolution from Rotation Log History', () => {
    it('should resolve email from rotation_log when key is deleted', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {},  // Key has been pruned/deleted
        rotation_log: [
          {
            timestamp: now - 2000,
            event: 'key_added',
            key_id: 'deleted-key-1234',
            account_email: 'recovered@example.com',
          },
          {
            timestamp: now - 1000,
            event: 'account_auth_failed',
            key_id: 'deleted-key-1234',
            reason: 'invalid_key_pruned',
            account_email: null,  // This event has no email
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // The account_auth_failed event should resolve email from the key_added entry in the log
      const authFailedEvent = result.events.find(e => e.event === 'account_auth_failed');
      expect(authFailedEvent).toBeDefined();
      expect(authFailedEvent!.description).toBe('Account can no longer auth: recovered@example.com');
    });

    it('should fall back to truncated key ID when no email anywhere', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {},  // Key has been pruned
        rotation_log: [
          {
            timestamp: now,
            event: 'account_auth_failed',
            key_id: 'no-email-key-1234',
            reason: 'invalid_key_pruned',
            account_email: null,
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('Account can no longer auth: no-email...');
    });
  });

  describe('Edge Cases', () => {
    it('should handle active_key_id as null', () => {
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-123': {
            status: 'active',
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.activeKeyId).toBeNull();
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].isCurrent).toBe(false);
    });

    it('should handle empty keys object', () => {
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {},
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.hasData).toBe(false);
      expect(result.accounts).toHaveLength(0);
    });

    it('should handle empty rotation_log', () => {
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-123': {
            status: 'active',
          },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(0);
      expect(result.totalRotations24h).toBe(0);
    });

    it('should handle missing key_id in rotation_log entry', () => {
      const now = Date.now();
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {},
        rotation_log: [
          {
            timestamp: now,
            event: 'key_added',
            // key_id is missing
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.events).toHaveLength(1);
      expect(result.events[0].keyId).toBe('unknown');
    });

    it('should handle all status types', () => {
      const testData = {
        version: 1,
        active_key_id: null,
        keys: {
          'key-active': { status: 'active' },
          'key-exhausted': { status: 'exhausted' },
          'key-expired': { status: 'expired' },
          'key-invalid': { status: 'invalid' },
        },
        rotation_log: [],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      expect(result.accounts).toHaveLength(3);
      const statuses = result.accounts.map((a) => a.status);
      expect(statuses).toContain('active');
      expect(statuses).toContain('exhausted');
      expect(statuses).toContain('expired');
      // invalid keys are filtered out of account overview
      expect(statuses).not.toContain('invalid');
    });
  });
});
