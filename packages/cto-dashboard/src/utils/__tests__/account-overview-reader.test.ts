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

      expect(result.accounts).toHaveLength(4);
      // Order: active, exhausted, expired, invalid
      expect(result.accounts[0].status).toBe('active');
      expect(result.accounts[1].status).toBe('exhausted');
      expect(result.accounts[2].status).toBe('expired');
      expect(result.accounts[3].status).toBe('invalid');
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

    it('should filter health_check events (too noisy)', () => {
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
            timestamp: now,
            event: 'key_switched',
            key_id: 'key-2',
            reason: 'test',
          },
        ],
      };

      fs.writeFileSync(testFilePath, JSON.stringify(testData), 'utf8');
      const result = getAccountOverviewData();

      // health_check events should be filtered
      expect(result.events).toHaveLength(1);
      expect(result.events[0].event).toBe('key_switched');
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

      expect(result.accounts).toHaveLength(4);
      const statuses = result.accounts.map((a) => a.status);
      expect(statuses).toContain('active');
      expect(statuses).toContain('exhausted');
      expect(statuses).toContain('expired');
      expect(statuses).toContain('invalid');
    });
  });
});
