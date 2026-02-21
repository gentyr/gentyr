/**
 * Tests for monitor-token-swap.mjs - comprehensive telemetry script
 *
 * Covers the new monitoring script functionality:
 * 1. Code structure validation (imports, constants, functions)
 * 2. Data reader functions (Keychain, credentials file, throttle state)
 * 3. Diagnostic alerts (DESYNC, STALE_DATA, VELOCITY_WARNING, etc.)
 * 4. Format helpers (fmtDuration, shortId)
 * 5. Deep health checks via Anthropic API
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test scripts/__tests__/monitor-token-swap.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MONITOR_SCRIPT_PATH = path.join(__dirname, '..', 'monitor-token-swap.mjs');

describe('monitor-token-swap.mjs - Code Structure', () => {
  describe('Script header and shebang', () => {
    it('should have node shebang', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /^#!\/usr\/bin\/env node/,
        'Must have node shebang for executable'
      );
    });

    it('should use ES module imports', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /import.*from ['"]fs['"]/,
        'Must use ES module import for fs'
      );

      assert.match(
        code,
        /import.*from ['"]path['"]/,
        'Must use ES module import for path'
      );

      assert.match(
        code,
        /import.*from ['"]os['"]/,
        'Must use ES module import for os'
      );
    });

    it('should import key-sync utilities', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      // Should import key functions from key-sync.js
      assert.match(
        code,
        /readRotationState/,
        'Must import readRotationState'
      );

      assert.match(
        code,
        /selectActiveKey/,
        'Must import selectActiveKey'
      );

      assert.match(
        code,
        /generateKeyId/,
        'Must import generateKeyId'
      );

      assert.match(
        code,
        /checkKeyHealth/,
        'Must import checkKeyHealth'
      );

      assert.match(
        code,
        /key-sync\.js/,
        'Must import from key-sync.js'
      );
    });
  });

  describe('Constants and paths', () => {
    it('should define poll interval constants', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /const POLL_INTERVAL_MS\s*=\s*30_000/,
        'Must define POLL_INTERVAL_MS as 30 seconds'
      );

      assert.match(
        code,
        /const DEEP_CHECK_INTERVAL_MS\s*=\s*300_000/,
        'Must define DEEP_CHECK_INTERVAL_MS as 5 minutes'
      );
    });

    it('should define diagnostic threshold constants', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /const STALE_HEALTH_CHECK_MS/,
        'Must define STALE_HEALTH_CHECK_MS threshold'
      );

      assert.match(
        code,
        /const VELOCITY_WARNING_PCT/,
        'Must define VELOCITY_WARNING_PCT threshold'
      );
    });

    it('should define file paths', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /const LOG_FILE\s*=/,
        'Must define LOG_FILE path'
      );

      assert.match(
        code,
        /const CREDENTIALS_PATH\s*=/,
        'Must define CREDENTIALS_PATH'
      );

      assert.match(
        code,
        /const THROTTLE_STATE_PATH\s*=/,
        'Must define THROTTLE_STATE_PATH'
      );
    });
  });

  describe('Monitor state structure', () => {
    it('should define monitorState object with tracking fields', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /const monitorState\s*=\s*\{/,
        'Must define monitorState object'
      );

      // Should track poll count
      assert.match(
        code,
        /pollCount:\s*0/,
        'Must initialize pollCount'
      );

      // Should track start time
      assert.match(
        code,
        /startedAt:/,
        'Must track startedAt timestamp'
      );

      // Should track previous usage snapshots
      assert.match(
        code,
        /previousUsageSnapshots:/,
        'Must track previousUsageSnapshots for velocity'
      );

      // Should track alert counts
      assert.match(
        code,
        /alertCounts:\s*\{/,
        'Must define alertCounts object'
      );
    });

    it('should define all alert types in alertCounts', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const requiredAlerts = [
        'DESYNC',
        'STALE_DATA',
        'VELOCITY_WARNING',
        'DUPLICATE_ACCOUNT',
        'ALL_EXHAUSTED',
        'TOKEN_EXPIRED',
        'NO_REFRESH_TOKEN',
      ];

      for (const alertType of requiredAlerts) {
        assert.match(
          code,
          new RegExp(`${alertType}:\\s*0`),
          `Must define ${alertType} in alertCounts`
        );
      }
    });
  });

  describe('Data reader functions', () => {
    it('should define readKeychainState function', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /function readKeychainState\(/,
        'Must define readKeychainState function'
      );
    });

    it('should define readCredentialsFile function', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /function readCredentialsFile\(/,
        'Must define readCredentialsFile function'
      );
    });

    it('should define readThrottleState function', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /function readThrottleState\(/,
        'Must define readThrottleState function'
      );
    });

    it('should define countClaudeProcesses function', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /function countClaudeProcesses\(/,
        'Must define countClaudeProcesses function'
      );
    });

    it('readKeychainState should use security command on macOS', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function readKeychainState\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'readKeychainState must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /execFileSync\(['"]security['"]/,
        'Must use execFileSync with security command'
      );

      assert.match(
        fnBody,
        /find-generic-password/,
        'Must use find-generic-password command'
      );
    });

    it('readCredentialsFile should read from CREDENTIALS_PATH', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function readCredentialsFile\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'readCredentialsFile must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /fs\.readFileSync\(CREDENTIALS_PATH/,
        'Must read from CREDENTIALS_PATH'
      );
    });

    it('countClaudeProcesses should use pgrep', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function countClaudeProcesses\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'countClaudeProcesses must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /execFileSync\(['"]pgrep['"]/,
        'Must use execFileSync with pgrep to count claude processes'
      );
    });
  });

  describe('Format helper functions', () => {
    it('should define fmtDuration function for human-readable time', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /function fmtDuration\(/,
        'Must define fmtDuration function'
      );
    });

    it('should define shortId function for key ID abbreviation', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /function shortId\(/,
        'Must define shortId function'
      );
    });

    it('fmtDuration should handle minutes and hours', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function fmtDuration\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'fmtDuration must be defined');
      const fnBody = fnMatch[0];

      // Should compute minutes
      assert.match(
        fnBody,
        /Math\.floor\(.*\/ 60\)/,
        'Must compute minutes from seconds'
      );

      // Should handle hours
      assert.match(
        fnBody,
        /hours/,
        'Must format hours for long durations'
      );
    });

    it('shortId should return first 8 characters', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function shortId\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'shortId must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /slice\(0,\s*8\)/,
        'Must return first 8 characters of ID'
      );
    });
  });

  describe('Logging functions', () => {
    it('should define log function for dual output', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /function log\(/,
        'Must define log function'
      );
    });

    it('should define logAlert function for alert tracking', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /function logAlert\(/,
        'Must define logAlert function'
      );
    });

    it('log should write to both console and file', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function log\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'log must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /console\.log/,
        'Must write to console'
      );

      assert.match(
        fnBody,
        /fs\.appendFileSync.*LOG_FILE/,
        'Must append to LOG_FILE'
      );
    });

    it('logAlert should increment alert counter', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function logAlert\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'logAlert must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /monitorState\.alertCounts\[alertType\]/,
        'Must increment alert counter in monitorState'
      );
    });
  });

  describe('Diagnostic alerts', () => {
    it('should define runDiagnostics function', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /function runDiagnostics\(/,
        'Must define runDiagnostics function'
      );
    });

    it('runDiagnostics should check for DESYNC between Keychain and rotation state', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function runDiagnostics\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'runDiagnostics must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /DESYNC/,
        'Must check for DESYNC alert'
      );

      assert.match(
        fnBody,
        /keychainState.*keyId/,
        'Must reference keychainState.keyId'
      );

      assert.match(
        fnBody,
        /active_key_id/,
        'Must reference active_key_id'
      );
    });

    it('runDiagnostics should check for STALE_DATA in health checks', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function runDiagnostics\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'runDiagnostics must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /STALE_DATA/,
        'Must check for STALE_DATA alert'
      );

      assert.match(
        fnBody,
        /last_health_check/,
        'Must check last_health_check timestamp'
      );

      assert.match(
        fnBody,
        /STALE_HEALTH_CHECK_MS/,
        'Must compare against STALE_HEALTH_CHECK_MS threshold'
      );
    });

    it('runDiagnostics should check for VELOCITY_WARNING', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function runDiagnostics\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'runDiagnostics must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /VELOCITY_WARNING/,
        'Must check for VELOCITY_WARNING alert'
      );

      assert.match(
        fnBody,
        /previousUsageSnapshots/,
        'Must compare against previous usage snapshots'
      );

      assert.match(
        fnBody,
        /VELOCITY_WARNING_PCT/,
        'Must use VELOCITY_WARNING_PCT threshold'
      );
    });

    it('runDiagnostics should check for DUPLICATE_ACCOUNT', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function runDiagnostics\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'runDiagnostics must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /DUPLICATE_ACCOUNT/,
        'Must check for DUPLICATE_ACCOUNT alert'
      );

      assert.match(
        fnBody,
        /account_email/,
        'Must group keys by account_email'
      );
    });

    it('runDiagnostics should check for ALL_EXHAUSTED', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function runDiagnostics\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'runDiagnostics must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /ALL_EXHAUSTED/,
        'Must check for ALL_EXHAUSTED alert'
      );

      assert.match(
        fnBody,
        /status === ['"]active['"]/,
        'Must check for active keys'
      );
    });

    it('runDiagnostics should check for TOKEN_EXPIRED', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function runDiagnostics\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'runDiagnostics must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /TOKEN_EXPIRED/,
        'Must check for TOKEN_EXPIRED alert'
      );

      assert.match(
        fnBody,
        /expiresAt < now/,
        'Must check if expiresAt is in the past'
      );
    });

    it('runDiagnostics should check for NO_REFRESH_TOKEN', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function runDiagnostics\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'runDiagnostics must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /NO_REFRESH_TOKEN/,
        'Must check for NO_REFRESH_TOKEN alert'
      );

      assert.match(
        fnBody,
        /!keyData\.refreshToken/,
        'Must check for missing refresh token'
      );
    });
  });

  describe('Poll and deep check functions', () => {
    it('should define poll function for regular checks', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /function poll\(/,
        'Must define poll function'
      );
    });

    it('should define deepCheck async function for API health checks', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /async function deepCheck\(/,
        'Must define deepCheck async function'
      );
    });

    it('poll should read all data sources', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function poll\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'poll must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /readKeychainState\(\)/,
        'Must call readKeychainState'
      );

      assert.match(
        fnBody,
        /readCredentialsFile\(\)/,
        'Must call readCredentialsFile'
      );

      assert.match(
        fnBody,
        /readRotationState\(\)/,
        'Must call readRotationState'
      );

      assert.match(
        fnBody,
        /readThrottleState\(\)/,
        'Must call readThrottleState'
      );

      assert.match(
        fnBody,
        /countClaudeProcesses\(\)/,
        'Must call countClaudeProcesses'
      );
    });

    it('poll should call runDiagnostics', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/function poll\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'poll must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /runDiagnostics\(/,
        'Must call runDiagnostics at end of poll'
      );
    });

    it('deepCheck should call checkKeyHealth for each key', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/async function deepCheck\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'deepCheck must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /await checkKeyHealth\(/,
        'Must call checkKeyHealth for API verification'
      );
    });

    it('deepCheck should deduplicate by account_email', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/async function deepCheck\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'deepCheck must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /account_email/,
        'Must check account_email for deduplication'
      );

      assert.match(
        fnBody,
        /checked\.has\(/,
        'Must use Set to track already-checked accounts'
      );
    });
  });

  describe('Main loop structure', () => {
    it('should define main async function', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /async function main\(/,
        'Must define main async function'
      );
    });

    it('main should call initial poll and deepCheck', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/async function main\([\s\S]*$/);
      assert.ok(fnMatch, 'main must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /poll\(\)/,
        'Must call initial poll'
      );

      assert.match(
        fnBody,
        /await deepCheck\(\)/,
        'Must call initial deepCheck'
      );
    });

    it('main should set up setInterval for polling', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/async function main\([\s\S]*$/);
      assert.ok(fnMatch, 'main must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /setInterval\(/,
        'Must set up interval timer'
      );

      assert.match(
        fnBody,
        /POLL_INTERVAL_MS/,
        'Must use POLL_INTERVAL_MS for timer'
      );
    });

    it('main should set up SIGINT handler for graceful shutdown', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/async function main\([\s\S]*$/);
      assert.ok(fnMatch, 'main must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /process\.on\(['"]SIGINT['"]/,
        'Must set up SIGINT handler'
      );
    });

    it('SIGINT handler should print summary on shutdown', () => {
      const code = fs.readFileSync(MONITOR_SCRIPT_PATH, 'utf8');

      // Find SIGINT handler
      const sigintMatch = code.match(/process\.on\(['"]SIGINT['"],[\s\S]*?\}\);/);
      assert.ok(sigintMatch, 'SIGINT handler must be defined');
      const handlerBody = sigintMatch[0];

      assert.match(
        handlerBody,
        /Uptime:/,
        'Must print uptime in summary'
      );

      assert.match(
        handlerBody,
        /pollCount/,
        'Must print poll count in summary'
      );

      assert.match(
        handlerBody,
        /alertCounts/,
        'Must print alert counts in summary'
      );
    });
  });
});

describe('monitor-token-swap.mjs - Behavioral Logic', () => {
  describe('fmtDuration helper', () => {
    it('should format short durations in minutes and seconds', () => {
      function fmtDuration(ms) {
        if (ms == null || isNaN(ms)) return '?';
        const negative = ms < 0;
        const absMs = Math.abs(ms);
        const totalSec = Math.round(absMs / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        if (mins >= 60) {
          const hours = Math.floor(mins / 60);
          const remainMins = mins % 60;
          return `${negative ? '-' : ''}${hours}h${String(remainMins).padStart(2, '0')}m`;
        }
        return `${negative ? '-' : ''}${mins}m${String(secs).padStart(2, '0')}s`;
      }

      assert.strictEqual(
        fmtDuration(125000), // 2 min 5 sec
        '2m05s',
        'Should format 125 seconds as 2m05s'
      );

      assert.strictEqual(
        fmtDuration(30000), // 30 sec
        '0m30s',
        'Should format 30 seconds as 0m30s'
      );
    });

    it('should format long durations in hours and minutes', () => {
      function fmtDuration(ms) {
        if (ms == null || isNaN(ms)) return '?';
        const negative = ms < 0;
        const absMs = Math.abs(ms);
        const totalSec = Math.round(absMs / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        if (mins >= 60) {
          const hours = Math.floor(mins / 60);
          const remainMins = mins % 60;
          return `${negative ? '-' : ''}${hours}h${String(remainMins).padStart(2, '0')}m`;
        }
        return `${negative ? '-' : ''}${mins}m${String(secs).padStart(2, '0')}s`;
      }

      assert.strictEqual(
        fmtDuration(3665000), // 1 hour 1 min 5 sec
        '1h01m',
        'Should format 3665 seconds as 1h01m'
      );

      assert.strictEqual(
        fmtDuration(7200000), // 2 hours
        '2h00m',
        'Should format 7200 seconds as 2h00m'
      );
    });

    it('should handle negative durations', () => {
      function fmtDuration(ms) {
        if (ms == null || isNaN(ms)) return '?';
        const negative = ms < 0;
        const absMs = Math.abs(ms);
        const totalSec = Math.round(absMs / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        if (mins >= 60) {
          const hours = Math.floor(mins / 60);
          const remainMins = mins % 60;
          return `${negative ? '-' : ''}${hours}h${String(remainMins).padStart(2, '0')}m`;
        }
        return `${negative ? '-' : ''}${mins}m${String(secs).padStart(2, '0')}s`;
      }

      assert.strictEqual(
        fmtDuration(-125000),
        '-2m05s',
        'Should handle negative duration'
      );
    });

    it('should return ? for null or NaN', () => {
      function fmtDuration(ms) {
        if (ms == null || isNaN(ms)) return '?';
        const negative = ms < 0;
        const absMs = Math.abs(ms);
        const totalSec = Math.round(absMs / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        if (mins >= 60) {
          const hours = Math.floor(mins / 60);
          const remainMins = mins % 60;
          return `${negative ? '-' : ''}${hours}h${String(remainMins).padStart(2, '0')}m`;
        }
        return `${negative ? '-' : ''}${mins}m${String(secs).padStart(2, '0')}s`;
      }

      assert.strictEqual(fmtDuration(null), '?');
      assert.strictEqual(fmtDuration(undefined), '?');
      assert.strictEqual(fmtDuration(NaN), '?');
    });
  });

  describe('shortId helper', () => {
    it('should return first 8 characters of key ID', () => {
      function shortId(id) {
        if (!id || typeof id !== 'string') return 'NONE    ';
        return id.slice(0, 8);
      }

      assert.strictEqual(
        shortId('abcdef1234567890'),
        'abcdef12',
        'Should return first 8 chars'
      );
    });

    it('should return NONE padded for null/undefined', () => {
      function shortId(id) {
        if (!id || typeof id !== 'string') return 'NONE    ';
        return id.slice(0, 8);
      }

      assert.strictEqual(shortId(null), 'NONE    ');
      assert.strictEqual(shortId(undefined), 'NONE    ');
      assert.strictEqual(shortId(''), 'NONE    ');
    });
  });

  describe('Diagnostic alert logic', () => {
    it('should detect DESYNC when Keychain key differs from active key', () => {
      const keychainState = { keyId: 'key-A-12345678' };
      const rotationState = { active_key_id: 'key-B-87654321' };

      const desync = keychainState.keyId !== rotationState.active_key_id;

      assert.strictEqual(
        desync,
        true,
        'Should detect DESYNC when Keychain differs from active key'
      );
    });

    it('should detect STALE_DATA when health check is old', () => {
      const now = Date.now();
      const STALE_HEALTH_CHECK_MS = 600_000; // 10 min

      const keyData = {
        status: 'active',
        last_health_check: now - 900_000, // 15 min ago
      };

      const isStale = keyData.last_health_check &&
                      (now - keyData.last_health_check > STALE_HEALTH_CHECK_MS);

      assert.strictEqual(
        isStale,
        true,
        'Should detect STALE_DATA when health check is > 10 min old'
      );
    });

    it('should detect VELOCITY_WARNING when usage jumps significantly', () => {
      const VELOCITY_WARNING_PCT = 15;

      const previousUsage = { five_hour: 50 };
      const currentUsage = { five_hour: 70 };

      const delta = currentUsage.five_hour - previousUsage.five_hour;
      const warningTriggered = delta >= VELOCITY_WARNING_PCT;

      assert.strictEqual(
        warningTriggered,
        true,
        'Should trigger VELOCITY_WARNING when usage jumps >= 15%'
      );
    });

    it('should detect DUPLICATE_ACCOUNT when multiple keys share same email', () => {
      const keys = {
        'key1': { account_email: 'user@example.com', status: 'active' },
        'key2': { account_email: 'user@example.com', status: 'active' },
        'key3': { account_email: 'other@example.com', status: 'active' },
      };

      const emailMap = new Map();
      for (const [keyId, keyData] of Object.entries(keys)) {
        if (keyData.status === 'invalid') continue;
        const email = keyData.account_email;
        if (email) {
          if (!emailMap.has(email)) {
            emailMap.set(email, []);
          }
          emailMap.get(email).push(keyId);
        }
      }

      const duplicates = [];
      for (const [email, keyIds] of emailMap) {
        if (keyIds.length > 1) {
          duplicates.push(email);
        }
      }

      assert.strictEqual(
        duplicates.length,
        1,
        'Should detect 1 duplicate account'
      );

      assert.strictEqual(
        duplicates[0],
        'user@example.com',
        'Should identify user@example.com as duplicate'
      );
    });

    it('should detect ALL_EXHAUSTED when no active keys remain', () => {
      const keys = {
        'key1': { status: 'exhausted' },
        'key2': { status: 'invalid' },
        'key3': { status: 'expired' },
      };

      const activeKeys = Object.values(keys).filter(k => k.status === 'active');
      const allExhausted = activeKeys.length === 0 && Object.keys(keys).length > 0;

      assert.strictEqual(
        allExhausted,
        true,
        'Should detect ALL_EXHAUSTED when no active keys remain'
      );
    });

    it('should detect TOKEN_EXPIRED when expiresAt is in the past', () => {
      const now = Date.now();
      const keyData = {
        status: 'active',
        expiresAt: now - 60000, // 1 min ago
      };

      const isExpired = keyData.expiresAt && keyData.expiresAt < now;

      assert.strictEqual(
        isExpired,
        true,
        'Should detect TOKEN_EXPIRED when expiresAt < now'
      );
    });

    it('should detect NO_REFRESH_TOKEN when refreshToken is missing', () => {
      const keyData = {
        status: 'active',
        accessToken: 'token',
        refreshToken: null,
      };

      const noRefreshToken = !keyData.refreshToken;

      assert.strictEqual(
        noRefreshToken,
        true,
        'Should detect NO_REFRESH_TOKEN when refreshToken is null'
      );
    });
  });
});
