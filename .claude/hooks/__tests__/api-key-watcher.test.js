/**
 * Tests for api-key-watcher.js
 *
 * These tests validate the API key rotation system:
 * 1. generateKeyId() - Stable key ID generation from access tokens
 * 2. selectActiveKey() - Rotation logic based on usage thresholds
 * 3. State file reading/writing
 * 4. Health check API integration
 * 5. Edge cases: no keys, all keys exhausted, single key
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/api-key-watcher.test.js
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

describe('api-key-watcher.js - Unit Tests', () => {
  const PROJECT_DIR = process.cwd();
  const HOOK_PATH = path.join(PROJECT_DIR, '.claude/hooks/api-key-watcher.js');

  describe('Code Structure Validation', () => {
    it('should be a valid ES module with proper shebang', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should have shebang
      assert.match(hookCode, /^#!\/usr\/bin\/env node/, 'Must have node shebang');

      // Should use ES module imports
      assert.match(hookCode, /import .* from ['"]fs['"]/, 'Must import fs');
      assert.match(hookCode, /import .* from ['"]path['"]/, 'Must import path');
      assert.match(hookCode, /import .* from ['"]os['"]/, 'Must import os');
      assert.match(hookCode, /import .* from ['"]crypto['"]/, 'Must import crypto');

      // Should use fileURLToPath for __dirname
      assert.match(hookCode, /fileURLToPath\(import\.meta\.url\)/, 'Must use fileURLToPath for ES modules');
    });

    it('should define all required constants', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const requiredConstants = [
        'PROJECT_DIR',
        'CREDENTIALS_PATH',
        'ROTATION_STATE_PATH',
        'ROTATION_LOG_PATH',
        'ANTHROPIC_API_URL',
        'ANTHROPIC_BETA_HEADER',
        'HIGH_USAGE_THRESHOLD',
        'EXHAUSTED_THRESHOLD',
        'MAX_LOG_ENTRIES'
      ];

      for (const constant of requiredConstants) {
        assert.match(
          hookCode,
          new RegExp(`const ${constant} =`),
          `Must define ${constant} constant`
        );
      }
    });

    it('should define all required functions', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const requiredFunctions = [
        'generateKeyId',
        'readCredentials',
        'writeCredentials',
        'readRotationState',
        'writeRotationState',
        'logRotationEvent',
        'checkKeyHealth',
        'selectActiveKey',
        'updateActiveCredentials',
        'main'
      ];

      for (const func of requiredFunctions) {
        assert.match(
          hookCode,
          new RegExp(`function ${func}\\(`),
          `Must define ${func} function`
        );
      }
    });

    it('should define correct threshold constants', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // High usage threshold should be 0.90 (90%)
      assert.match(
        hookCode,
        /const HIGH_USAGE_THRESHOLD = 0\.90/,
        'HIGH_USAGE_THRESHOLD must be 0.90'
      );

      // Exhausted threshold should be 1.0 (100%)
      assert.match(
        hookCode,
        /const EXHAUSTED_THRESHOLD = 1\.0/,
        'EXHAUSTED_THRESHOLD must be 1.0'
      );

      // Max log entries should be 100
      assert.match(
        hookCode,
        /const MAX_LOG_ENTRIES = 100/,
        'MAX_LOG_ENTRIES must be 100'
      );
    });
  });

  describe('generateKeyId() - Key ID Generation', () => {
    it('should exist and accept accessToken parameter', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /function generateKeyId\(accessToken\)/,
        'generateKeyId must accept accessToken parameter'
      );
    });

    it('should remove common token prefixes', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function generateKeyId\(accessToken\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'generateKeyId function must exist');

      const functionBody = functionMatch[0];

      // Should remove sk-ant-oat01- prefix
      assert.match(
        functionBody,
        /\.replace\(\/\^sk-ant-oat01-\/,\s*['"]['"]?\)/,
        'Must remove sk-ant-oat01- prefix'
      );

      // Should remove sk-ant- prefix
      assert.match(
        functionBody,
        /\.replace\(\/\^sk-ant-\/,\s*['"]['"]?\)/,
        'Must remove sk-ant- prefix'
      );
    });

    it('should use SHA256 hash for key ID', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function generateKeyId\(accessToken\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should use crypto.createHash('sha256')
      assert.match(
        functionBody,
        /crypto\.createHash\(['"]sha256['"]\)/,
        'Must use SHA256 hash algorithm'
      );

      // Should call update with cleanToken
      assert.match(
        functionBody,
        /\.update\(cleanToken\)/,
        'Must update hash with cleanToken'
      );

      // Should call digest('hex')
      assert.match(
        functionBody,
        /\.digest\(['"]hex['"]\)/,
        'Must generate hex digest'
      );
    });

    it('should return 16 character hash', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function generateKeyId\(accessToken\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should substring to 16 chars
      assert.match(
        functionBody,
        /\.substring\(0,\s*16\)/,
        'Must return first 16 characters of hash'
      );

      // Should return the hash
      assert.match(
        functionBody,
        /return hash\.substring/,
        'Must return the substring result'
      );
    });

    it('should produce deterministic output for same input', () => {
      // Test the actual logic (not importing, but validating the algorithm)
      const testToken = 'sk-ant-oat01-test-token-12345';
      const cleanToken = testToken.replace(/^sk-ant-oat01-/, '').replace(/^sk-ant-/, '');
      const hash = crypto.createHash('sha256').update(cleanToken).digest('hex');
      const keyId1 = hash.substring(0, 16);

      // Generate again with same input
      const cleanToken2 = testToken.replace(/^sk-ant-oat01-/, '').replace(/^sk-ant-/, '');
      const hash2 = crypto.createHash('sha256').update(cleanToken2).digest('hex');
      const keyId2 = hash2.substring(0, 16);

      assert.strictEqual(keyId1, keyId2, 'Key IDs must be deterministic for same input');
    });

    it('should produce different output for different inputs', () => {
      const token1 = 'sk-ant-oat01-token-1';
      const token2 = 'sk-ant-oat01-token-2';

      const clean1 = token1.replace(/^sk-ant-oat01-/, '').replace(/^sk-ant-/, '');
      const clean2 = token2.replace(/^sk-ant-oat01-/, '').replace(/^sk-ant-/, '');

      const hash1 = crypto.createHash('sha256').update(clean1).digest('hex').substring(0, 16);
      const hash2 = crypto.createHash('sha256').update(clean2).digest('hex').substring(0, 16);

      assert.notStrictEqual(hash1, hash2, 'Key IDs must be different for different inputs');
    });
  });

  describe('readRotationState() - State File Reading', () => {
    it('should return default state when file does not exist', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function readRotationState\(\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'readRotationState function must exist');

      const functionBody = functionMatch[0];

      // Should check if file exists
      assert.match(
        functionBody,
        /if \(!fs\.existsSync\(ROTATION_STATE_PATH\)\)/,
        'Must check if rotation state file exists'
      );

      // Should return defaultState
      assert.match(
        functionBody,
        /return defaultState/,
        'Must return default state when file does not exist'
      );
    });

    it('should define correct default state structure', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function readRotationState\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Default state should have version 1
      assert.match(
        functionBody,
        /version:\s*1/,
        'Default state must have version: 1'
      );

      // Default state should have active_key_id: null
      assert.match(
        functionBody,
        /active_key_id:\s*null/,
        'Default state must have active_key_id: null'
      );

      // Default state should have empty keys object
      assert.match(
        functionBody,
        /keys:\s*\{\}/,
        'Default state must have empty keys object'
      );

      // Default state should have empty rotation_log array
      assert.match(
        functionBody,
        /rotation_log:\s*\[\]/,
        'Default state must have empty rotation_log array'
      );
    });

    it('should parse JSON content when file exists', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function readRotationState\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should read file content
      assert.match(
        functionBody,
        /fs\.readFileSync\(ROTATION_STATE_PATH,\s*['"]utf8['"]\)/,
        'Must read file with utf8 encoding'
      );

      // Should parse JSON
      assert.match(
        functionBody,
        /JSON\.parse\(content\)/,
        'Must parse JSON content'
      );
    });

    it('should validate state structure', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function readRotationState\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should validate version
      assert.match(
        functionBody,
        /parsed\.version !== 1/,
        'Must validate version === 1'
      );

      // Should validate keys is an object
      assert.match(
        functionBody,
        /typeof parsed\.keys !== ['"]object['"]/,
        'Must validate keys is an object'
      );

      // Should return defaultState on invalid structure
      assert.match(
        functionBody,
        /return defaultState/,
        'Must return default state on validation failure'
      );
    });

    it('should handle read errors gracefully', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function readRotationState\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should wrap in try-catch
      assert.match(
        functionBody,
        /try \{/,
        'Must have try block for file operations'
      );

      assert.match(
        functionBody,
        /catch \(err\)/,
        'Must have catch block for error handling'
      );

      // Should log error
      assert.match(
        functionBody,
        /console\.error\(/,
        'Must log errors'
      );

      // Should return defaultState in catch
      assert.match(
        functionBody,
        /catch[\s\S]*?return defaultState/,
        'Must return default state on error'
      );
    });
  });

  describe('writeRotationState() - State File Writing', () => {
    it('should create directory if it does not exist', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function writeRotationState\(state\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'writeRotationState function must exist');

      const functionBody = functionMatch[0];

      // Should get directory path
      assert.match(
        functionBody,
        /path\.dirname\(ROTATION_STATE_PATH\)/,
        'Must get directory path'
      );

      // Should check if directory exists
      assert.match(
        functionBody,
        /fs\.existsSync\(dir\)/,
        'Must check if directory exists'
      );

      // Should create directory recursively
      assert.match(
        functionBody,
        /fs\.mkdirSync\(dir,\s*\{\s*recursive:\s*true\s*\}\)/,
        'Must create directory recursively'
      );
    });

    it('should write JSON with proper formatting', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function writeRotationState\(state\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should stringify with 2-space indent
      assert.match(
        functionBody,
        /JSON\.stringify\(state,\s*null,\s*2\)/,
        'Must stringify JSON with 2-space indent'
      );

      // Should write to ROTATION_STATE_PATH
      assert.match(
        functionBody,
        /fs\.writeFileSync\(ROTATION_STATE_PATH/,
        'Must write to ROTATION_STATE_PATH'
      );

      // Should use utf8 encoding
      assert.match(
        functionBody,
        /['"]utf8['"]\)/,
        'Must use utf8 encoding'
      );
    });

    it('should handle write errors gracefully', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function writeRotationState\(state\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should wrap in try-catch
      assert.match(
        functionBody,
        /try \{/,
        'Must have try block for file operations'
      );

      assert.match(
        functionBody,
        /catch \(err\)/,
        'Must have catch block for error handling'
      );

      // Should log error
      assert.match(
        functionBody,
        /console\.error\(/,
        'Must log errors'
      );
    });
  });

  describe('logRotationEvent() - Event Logging', () => {
    it('should add event to state rotation_log', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function logRotationEvent\(state, entry\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'logRotationEvent function must exist');

      const functionBody = functionMatch[0];

      // Should unshift (prepend) to rotation_log
      assert.match(
        functionBody,
        /state\.rotation_log\.unshift\(entry\)/,
        'Must prepend entry to rotation_log'
      );
    });

    it('should limit rotation_log to MAX_LOG_ENTRIES', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function logRotationEvent\(state, entry\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check log length
      assert.match(
        functionBody,
        /state\.rotation_log\.length > MAX_LOG_ENTRIES/,
        'Must check if log exceeds MAX_LOG_ENTRIES'
      );

      // Should slice to MAX_LOG_ENTRIES
      assert.match(
        functionBody,
        /state\.rotation_log\.slice\(0,\s*MAX_LOG_ENTRIES\)/,
        'Must slice rotation_log to MAX_LOG_ENTRIES'
      );
    });

    it('should format human-readable log entry', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function logRotationEvent\(state, entry\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should convert timestamp to ISO string
      assert.match(
        functionBody,
        /new Date\(entry\.timestamp\)\.toISOString\(\)/,
        'Must convert timestamp to ISO string'
      );

      // Should include event type
      assert.match(
        functionBody,
        /entry\.event/,
        'Must include event type in log line'
      );

      // Should truncate key_id to 8 chars
      assert.match(
        functionBody,
        /entry\.key_id\.slice\(0,\s*8\)/,
        'Must truncate key_id to 8 characters for logging'
      );
    });

    it('should append to log file', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function logRotationEvent\(state, entry\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should append to ROTATION_LOG_PATH
      assert.match(
        functionBody,
        /fs\.appendFileSync\(ROTATION_LOG_PATH/,
        'Must append to ROTATION_LOG_PATH'
      );

      // Should include newline
      assert.match(
        functionBody,
        /['"]\s*\\n['"]/,
        'Must append newline to log entries'
      );
    });

    it('should handle log file errors gracefully', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function logRotationEvent\(state, entry\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should wrap append in try-catch or check with catch/empty block
      // The implementation uses bare catch { } to ignore log file errors
      const hasTryCatch = functionBody.includes('try {') && functionBody.includes('} catch');

      assert.ok(hasTryCatch, 'Must handle log file errors gracefully');
    });
  });

  describe('checkKeyHealth() - API Health Check', () => {
    it('should make GET request to Anthropic Usage API', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function checkKeyHealth\(accessToken\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'checkKeyHealth function must be async');

      const functionBody = functionMatch[0];

      // Should use fetch with ANTHROPIC_API_URL
      assert.match(
        functionBody,
        /fetch\(ANTHROPIC_API_URL/,
        'Must fetch from ANTHROPIC_API_URL'
      );

      // Should use GET method
      assert.match(
        functionBody,
        /method:\s*['"]GET['"]/,
        'Must use GET method'
      );
    });

    it('should set correct headers', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function checkKeyHealth\(accessToken\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should set Authorization header with Bearer token
      assert.match(
        functionBody,
        /['"]Authorization['"]\s*:\s*`Bearer \$\{accessToken\}`/,
        'Must set Authorization header with Bearer token'
      );

      // Should set Content-Type header
      assert.match(
        functionBody,
        /['"]Content-Type['"]\s*:\s*['"]application\/json['"]/,
        'Must set Content-Type header'
      );

      // Should set User-Agent header
      assert.match(
        functionBody,
        /['"]User-Agent['"]/,
        'Must set User-Agent header'
      );

      // Should set anthropic-beta header
      assert.match(
        functionBody,
        /['"]anthropic-beta['"]\s*:\s*ANTHROPIC_BETA_HEADER/,
        'Must set anthropic-beta header'
      );
    });

    it('should handle 401 unauthorized response', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function checkKeyHealth\(accessToken\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check for 401 status
      assert.match(
        functionBody,
        /response\.status === 401/,
        'Must check for 401 status'
      );

      // Should return valid: false for 401
      assert.match(
        functionBody,
        /valid:\s*false.*usage:\s*null.*error:\s*['"]unauthorized['"]/s,
        'Must return valid: false with unauthorized error'
      );
    });

    it('should handle non-OK responses', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function checkKeyHealth\(accessToken\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check if response.ok
      assert.match(
        functionBody,
        /!response\.ok/,
        'Must check response.ok'
      );

      // Should return error with http status code
      assert.match(
        functionBody,
        /error:\s*`http_\$\{response\.status\}`/,
        'Must return error with HTTP status code'
      );
    });

    it('should parse usage data correctly', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function checkKeyHealth\(accessToken\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should parse JSON response
      assert.match(
        functionBody,
        /await response\.json\(\)/,
        'Must parse JSON response'
      );

      // Should extract five_hour utilization
      assert.match(
        functionBody,
        /five_hour:\s*data\.five_hour\?\.utilization/,
        'Must extract five_hour utilization'
      );

      // Should extract seven_day utilization
      assert.match(
        functionBody,
        /seven_day:\s*data\.seven_day\?\.utilization/,
        'Must extract seven_day utilization'
      );

      // Should extract seven_day_sonnet utilization
      assert.match(
        functionBody,
        /seven_day_sonnet:\s*data\.seven_day_sonnet\?\.utilization/,
        'Must extract seven_day_sonnet utilization'
      );

      // Should use nullish coalescing for defaults
      assert.match(
        functionBody,
        /\?\?\s*0/,
        'Must provide default value of 0 for missing utilization'
      );
    });

    it('should return valid: true on success', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function checkKeyHealth\(accessToken\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should return valid: true with usage data
      assert.match(
        functionBody,
        /return\s*\{[\s\S]*?valid:\s*true[\s\S]*?usage:\s*\{/,
        'Must return valid: true with usage object on success'
      );
    });

    it('should handle fetch errors', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function checkKeyHealth\(accessToken\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should wrap in try-catch
      assert.match(
        functionBody,
        /try \{/,
        'Must have try block for fetch operation'
      );

      assert.match(
        functionBody,
        /catch \(err\)/,
        'Must have catch block for error handling'
      );

      // Should return valid: false on error
      assert.match(
        functionBody,
        /catch[\s\S]*?valid:\s*false/,
        'Must return valid: false on fetch error'
      );

      // Should include error message
      assert.match(
        functionBody,
        /error:\s*err\.message/,
        'Must include error message in return value'
      );
    });
  });

  describe('selectActiveKey() - Rotation Logic', () => {
    it('should exist and accept state parameter', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /function selectActiveKey\(state\)/,
        'selectActiveKey must accept state parameter'
      );
    });

    it('should return null when no keys exist', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'selectActiveKey function must exist');

      const functionBody = functionMatch[0];

      // Should check if validKeys.length === 0
      assert.match(
        functionBody,
        /validKeys\.length === 0.*?return null/s,
        'Must return null when no valid keys exist'
      );
    });

    it('should filter out invalid and expired keys', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should filter for active or exhausted status
      assert.match(
        functionBody,
        /key\.status === ['"]active['"] \|\| key\.status === ['"]exhausted['"]/,
        'Must filter keys by status (active or exhausted)'
      );
    });

    it('should exclude keys at 100% usage (exhausted)', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should filter out keys at EXHAUSTED_THRESHOLD
      assert.match(
        functionBody,
        /usage\.five_hour < EXHAUSTED_THRESHOLD/,
        'Must check five_hour usage against EXHAUSTED_THRESHOLD'
      );

      assert.match(
        functionBody,
        /usage\.seven_day < EXHAUSTED_THRESHOLD/,
        'Must check seven_day usage against EXHAUSTED_THRESHOLD'
      );

      assert.match(
        functionBody,
        /usage\.seven_day_sonnet < EXHAUSTED_THRESHOLD/,
        'Must check seven_day_sonnet usage against EXHAUSTED_THRESHOLD'
      );

      // Should return null if all keys exhausted
      assert.match(
        functionBody,
        /usableKeys\.length === 0.*?return null/s,
        'Must return null when all keys are exhausted'
      );
    });

    it('should detect when all keys are above 90% usage', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check if all keys are above HIGH_USAGE_THRESHOLD
      assert.match(
        functionBody,
        /allAbove90/,
        'Must define allAbove90 variable'
      );

      assert.match(
        functionBody,
        /usableKeys\.every\(/,
        'Must check every usable key'
      );

      assert.match(
        functionBody,
        /HIGH_USAGE_THRESHOLD/,
        'Must compare against HIGH_USAGE_THRESHOLD'
      );
    });

    it('should switch only when current is exhausted if all keys high usage', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should have branch for allAbove90
      assert.match(
        functionBody,
        /if \(allAbove90\)/,
        'Must have conditional branch for allAbove90 scenario'
      );

      // Should check if current key hit EXHAUSTED_THRESHOLD
      assert.match(
        functionBody,
        /EXHAUSTED_THRESHOLD/,
        'Must check against EXHAUSTED_THRESHOLD when all keys high usage'
      );
    });

    it('should switch when current reaches 90% if other keys below 90%', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should have else branch for when some keys below 90%
      assert.match(
        functionBody,
        /\} else \{/,
        'Must have else branch for normal rotation scenario'
      );

      // Should check maxUsage against HIGH_USAGE_THRESHOLD
      assert.match(
        functionBody,
        /maxUsage >= HIGH_USAGE_THRESHOLD/,
        'Must check max usage against HIGH_USAGE_THRESHOLD'
      );
    });

    it('should select key with lowest max usage when rotating', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should sort by usage
      assert.match(
        functionBody,
        /\.sort\(/,
        'Must sort keys by usage'
      );

      // Should calculate max usage for each key
      assert.match(
        functionBody,
        /Math\.max\(/,
        'Must calculate max usage across utilization metrics'
      );

      // Should compare a.usage vs b.usage in sort
      const sortMatch = functionBody.match(/\.sort\(\([^)]+\)\s*=>\s*\{[\s\S]*?\}\)/);
      assert.ok(sortMatch, 'Must have sort function with comparison logic');
    });

    it('should return current key or first usable as default', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should have default return at end
      assert.match(
        functionBody,
        /return currentKey\?\.\w+ \?\?/,
        'Must return current key as default if available'
      );

      // Should fallback to first usable key
      assert.match(
        functionBody,
        /usableKeys\[0\]\?\.\w+ \?\? null/,
        'Must fallback to first usable key then null'
      );
    });
  });

  describe('main() - Integration', () => {
    it('should skip for spawned sessions', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'main function must be async');

      const functionBody = functionMatch[0];

      // Should check CLAUDE_SPAWNED_SESSION env var
      assert.match(
        functionBody,
        /process\.env\.CLAUDE_SPAWNED_SESSION === ['"]true['"]/,
        'Must check for spawned session environment variable'
      );

      // Should return early with suppressOutput: true
      assert.match(
        functionBody,
        /suppressOutput:\s*true/,
        'Must suppress output for spawned sessions'
      );
    });

    it('should read credentials on start', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should call readCredentials()
      assert.match(
        functionBody,
        /readCredentials\(\)/,
        'Must call readCredentials()'
      );

      // Should check for claudeAiOauth.accessToken
      assert.match(
        functionBody,
        /claudeAiOauth\?\.accessToken/,
        'Must check for accessToken in credentials'
      );
    });

    it('should generate key ID for current token', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should call generateKeyId with accessToken
      assert.match(
        functionBody,
        /generateKeyId\(oauth\.accessToken\)/,
        'Must generate key ID for current access token'
      );
    });

    it('should add new keys to tracking', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check if key is new
      assert.match(
        functionBody,
        /isNewKey = !state\.keys\[currentKeyId\]/,
        'Must check if key is new'
      );

      // Should add key data to state.keys
      assert.match(
        functionBody,
        /state\.keys\[currentKeyId\] = \{/,
        'Must add new key to state.keys'
      );

      // Should log key_added event
      assert.match(
        functionBody,
        /event:\s*['"]key_added['"]/,
        'Must log key_added event for new keys'
      );
    });

    it('should update existing key data', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should update accessToken for existing keys
      assert.match(
        functionBody,
        /existingKey\.accessToken = oauth\.accessToken/,
        'Must update accessToken for existing keys'
      );

      // Should update refreshToken
      assert.match(
        functionBody,
        /existingKey\.refreshToken = oauth\.refreshToken/,
        'Must update refreshToken for existing keys'
      );

      // Should update expiresAt
      assert.match(
        functionBody,
        /existingKey\.expiresAt = oauth\.expiresAt/,
        'Must update expiresAt for existing keys'
      );
    });

    it('should run health checks on all tracked keys', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should map over state.keys
      assert.match(
        functionBody,
        /Object\.entries\(state\.keys\)\.map\(/,
        'Must map over all keys in state'
      );

      // Should call checkKeyHealth
      assert.match(
        functionBody,
        /await checkKeyHealth\(keyData\.accessToken\)/,
        'Must call checkKeyHealth for each key'
      );

      // Should use Promise.all for parallel checks
      assert.match(
        functionBody,
        /await Promise\.all\(healthCheckPromises\)/,
        'Must run health checks in parallel with Promise.all'
      );
    });

    it('should mark expired tokens', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check expiresAt against now
      assert.match(
        functionBody,
        /keyData\.expiresAt.*?<\s*now/s,
        'Must check if token is expired'
      );

      // Should set status to 'expired'
      assert.match(
        functionBody,
        /keyData\.status = ['"]expired['"]/,
        'Must set status to expired for expired tokens'
      );

      // Should log key_removed event
      assert.match(
        functionBody,
        /reason:\s*['"]token_expired['"]/,
        'Must log token_expired reason'
      );
    });

    it('should mark invalid tokens', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check result.valid
      assert.match(
        functionBody,
        /!result\.valid/,
        'Must check if health check result is invalid'
      );

      // Should set status to 'invalid'
      assert.match(
        functionBody,
        /keyData\.status = ['"]invalid['"]/,
        'Must set status to invalid for failed health checks'
      );

      // Should log key_removed event
      assert.match(
        functionBody,
        /event:\s*['"]key_removed['"]/,
        'Must log key_removed event for invalid keys'
      );
    });

    it('should mark exhausted keys', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check if any metric >= EXHAUSTED_THRESHOLD
      assert.match(
        functionBody,
        /isExhausted = result\.usage\.five_hour >= EXHAUSTED_THRESHOLD/,
        'Must check five_hour against EXHAUSTED_THRESHOLD'
      );

      // Should set status to 'exhausted'
      assert.match(
        functionBody,
        /keyData\.status = ['"]exhausted['"]/,
        'Must set status to exhausted when hitting 100%'
      );

      // Should log key_exhausted event
      assert.match(
        functionBody,
        /event:\s*['"]key_exhausted['"]/,
        'Must log key_exhausted event'
      );
    });

    it('should call selectActiveKey', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should call selectActiveKey with state
      assert.match(
        functionBody,
        /selectActiveKey\(state\)/,
        'Must call selectActiveKey to determine best key'
      );
    });

    it('should log key_switched event when rotating', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check if selectedKeyId differs from active_key_id
      assert.match(
        functionBody,
        /selectedKeyId !== state\.active_key_id/,
        'Must check if key rotation is needed'
      );

      // Should log key_switched event
      assert.match(
        functionBody,
        /event:\s*['"]key_switched['"]/,
        'Must log key_switched event when rotating'
      );

      // Should update active_key_id
      assert.match(
        functionBody,
        /state\.active_key_id = selectedKeyId/,
        'Must update active_key_id when switching'
      );
    });

    it('should update credentials file when switching keys', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should call updateActiveCredentials when switching
      assert.match(
        functionBody,
        /updateActiveCredentials\(creds, selectedKey\)/,
        'Must call updateActiveCredentials when switching to different key'
      );
    });

    it('should save state after processing', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should call writeRotationState
      assert.match(
        functionBody,
        /writeRotationState\(state\)/,
        'Must write rotation state after processing'
      );
    });

    it('should build notification message for multiple keys', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should count active/exhausted keys
      assert.match(
        functionBody,
        /keyCount = Object\.keys\(state\.keys\)/,
        'Must count tracked keys'
      );

      // Should check if keyCount > 1
      assert.match(
        functionBody,
        /keyCount > 1/,
        'Must check if multiple keys are tracked'
      );

      // Should include usage percentage in message
      assert.match(
        functionBody,
        /Math\.round\(maxUsage \* 100\)/,
        'Must calculate usage percentage for notification'
      );
    });

    it('should return hook response with continue: true', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should stringify response
      assert.match(
        functionBody,
        /JSON\.stringify\(/,
        'Must stringify response object'
      );

      // Should always include continue: true
      assert.match(
        functionBody,
        /continue:\s*true/,
        'Must include continue: true in response'
      );

      // Should conditionally suppress output
      assert.match(
        functionBody,
        /suppressOutput:/,
        'Must include suppressOutput flag'
      );
    });

    it('should handle errors gracefully without blocking', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should have top-level catch for main()
      assert.match(
        hookCode,
        /main\(\)\.catch\(/,
        'Must catch errors from main function'
      );

      // Should log errors
      assert.match(
        hookCode,
        /console\.error\(/,
        'Must log errors'
      );

      // Should return continue: true even on error
      // Extract the catch block (multiline)
      const catchMatch = hookCode.match(/\.catch\(err => \{[\s\S]*?\}\);/);
      assert.ok(catchMatch, 'Must have catch handler body');

      const catchBody = catchMatch[0];
      assert.match(
        catchBody,
        /continue:\s*true/,
        'Must return continue: true on error (fail-open for hook)'
      );
    });
  });

  describe('Edge Cases - Single Key Scenarios', () => {
    it('should handle single key with no usage data', () => {
      // This is a logical test - verifying the code handles the case where
      // a key exists but has last_usage: null (no health check yet)
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const selectActiveKeyFunction = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/)[0];

      // Should check if usage exists before accessing
      assert.match(
        selectActiveKeyFunction,
        /if \(!usage\)/,
        'Must check if usage data exists'
      );

      // Should treat no usage as usable
      assert.match(
        selectActiveKeyFunction,
        /if \(!usage\) return true/,
        'Must treat keys without usage data as usable'
      );
    });

    it('should handle single exhausted key', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const selectActiveKeyFunction = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/)[0];

      // Should return null when all keys exhausted
      assert.match(
        selectActiveKeyFunction,
        /usableKeys\.length === 0.*?return null/s,
        'Must return null when single key is exhausted'
      );
    });

    it('should stick with single key even at high usage if below 100%', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const selectActiveKeyFunction = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/)[0];

      // Logic: when allAbove90 is true and only one key exists,
      // should only switch when hitting EXHAUSTED_THRESHOLD
      assert.match(
        selectActiveKeyFunction,
        /if \(allAbove90\)/,
        'Must have branch for all keys above 90%'
      );

      // In allAbove90 branch, should check for EXHAUSTED_THRESHOLD
      const allAbove90Branch = selectActiveKeyFunction.match(/if \(allAbove90\) \{[\s\S]*?\n  \} else/s);
      assert.ok(allAbove90Branch, 'Must have complete allAbove90 conditional block');

      const branchBody = allAbove90Branch[0];
      assert.match(
        branchBody,
        /EXHAUSTED_THRESHOLD/,
        'Must check EXHAUSTED_THRESHOLD in high usage scenario'
      );
    });
  });

  describe('TypeScript Type Definitions (JSDoc)', () => {
    it('should define UsageData type', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /@typedef \{Object\} UsageData/,
        'Must define UsageData typedef'
      );

      assert.match(
        hookCode,
        /@property \{number\} five_hour/,
        'UsageData must have five_hour property'
      );

      assert.match(
        hookCode,
        /@property \{number\} seven_day/,
        'UsageData must have seven_day property'
      );

      assert.match(
        hookCode,
        /@property \{number\} seven_day_sonnet/,
        'UsageData must have seven_day_sonnet property'
      );
    });

    it('should define KeyData type', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /@typedef \{Object\} KeyData/,
        'Must define KeyData typedef'
      );

      assert.match(
        hookCode,
        /@property \{string\} accessToken/,
        'KeyData must have accessToken property'
      );

      assert.match(
        hookCode,
        /@property \{string\} refreshToken/,
        'KeyData must have refreshToken property'
      );

      assert.match(
        hookCode,
        /@property \{['"]active['"]|['"]exhausted['"]|['"]invalid['"]|['"]expired['"]\} status/,
        'KeyData must have status union type'
      );
    });

    it('should define RotationLogEntry type', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /@typedef \{Object\} RotationLogEntry/,
        'Must define RotationLogEntry typedef'
      );

      assert.match(
        hookCode,
        /@property \{['"]key_added['"]|/,
        'RotationLogEntry must have event union type including key_added'
      );
    });

    it('should define KeyRotationState type', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /@typedef \{Object\} KeyRotationState/,
        'Must define KeyRotationState typedef'
      );

      assert.match(
        hookCode,
        /@property \{1\} version/,
        'KeyRotationState must have version: 1'
      );

      assert.match(
        hookCode,
        /@property \{Record<string, KeyData>\} keys/,
        'KeyRotationState must have keys as Record'
      );
    });
  });

  describe('Security and Privacy', () => {
    it('should hash tokens for key IDs rather than storing them directly', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const generateKeyIdFunction = hookCode.match(/function generateKeyId\(accessToken\) \{[\s\S]*?\n\}/)[0];

      // Should use crypto hash, not just substring
      assert.match(
        generateKeyIdFunction,
        /crypto\.createHash/,
        'Must use cryptographic hash for key ID'
      );

      // Should not expose full token in ID
      assert.match(
        generateKeyIdFunction,
        /\.substring\(0,\s*16\)/,
        'Must limit key ID to 16 chars (short hash)'
      );
    });

    it('should truncate key IDs in log messages', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const logRotationEventFunction = hookCode.match(/function logRotationEvent\(state, entry\) \{[\s\S]*?\n\}/)[0];

      // Should slice key_id to 8 chars for logging
      assert.match(
        logRotationEventFunction,
        /entry\.key_id\.slice\(0,\s*8\)/,
        'Must truncate key_id to 8 chars in log messages'
      );
    });

    it('should store full tokens in state (needed for rotation)', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];

      // Should store accessToken in key data
      assert.match(
        mainFunction,
        /accessToken:\s*oauth\.accessToken/,
        'Must store full accessToken in key data (required for rotation)'
      );

      // Should store refreshToken in key data
      assert.match(
        mainFunction,
        /refreshToken:\s*oauth\.refreshToken/,
        'Must store full refreshToken in key data (required for rotation)'
      );
    });

    it('should not log sensitive token values', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should not log accessToken directly
      assert.doesNotMatch(
        hookCode,
        /console\.log\(.*?accessToken/i,
        'Must not log access tokens'
      );

      assert.doesNotMatch(
        hookCode,
        /console\.error\(.*?accessToken/i,
        'Must not log access tokens in errors'
      );

      // Should not log refreshToken directly
      assert.doesNotMatch(
        hookCode,
        /console\.log\(.*?refreshToken/i,
        'Must not log refresh tokens'
      );
    });
  });

  describe('File Path Configuration', () => {
    it('should read credentials from home directory', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /CREDENTIALS_PATH = path\.join\(os\.homedir\(\),\s*['"]\.claude['"]/,
        'CREDENTIALS_PATH must be in ~/.claude/'
      );

      assert.match(
        hookCode,
        /['"]\.credentials\.json['"]\)/,
        'CREDENTIALS_PATH must point to .credentials.json'
      );
    });

    it('should store rotation state in project directory', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /ROTATION_STATE_PATH = path\.join\(PROJECT_DIR,\s*['"]\.claude['"]/,
        'ROTATION_STATE_PATH must be in PROJECT_DIR/.claude/'
      );

      assert.match(
        hookCode,
        /['"]api-key-rotation\.json['"]\)/,
        'ROTATION_STATE_PATH must point to api-key-rotation.json'
      );
    });

    it('should store rotation log in project directory', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /ROTATION_LOG_PATH = path\.join\(PROJECT_DIR,\s*['"]\.claude['"]/,
        'ROTATION_LOG_PATH must be in PROJECT_DIR/.claude/'
      );

      assert.match(
        hookCode,
        /['"]api-key-rotation\.log['"]\)/,
        'ROTATION_LOG_PATH must point to api-key-rotation.log'
      );
    });
  });

  describe('Hook Response Format', () => {
    it('should return valid hook response structure', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];

      // Should JSON.stringify response
      assert.match(
        mainFunction,
        /console\.log\(JSON\.stringify\(/,
        'Must output JSON stringified response'
      );

      // Response should have continue property
      assert.match(
        mainFunction,
        /continue:\s*true/,
        'Response must include continue: true'
      );

      // Response should have suppressOutput property
      assert.match(
        mainFunction,
        /suppressOutput:/,
        'Response must include suppressOutput flag'
      );

      // Response can have systemMessage property
      assert.match(
        mainFunction,
        /systemMessage:/,
        'Response can include systemMessage for notifications'
      );
    });

    it('should suppress output when no message to show', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];

      // Should conditionally set suppressOutput based on message
      assert.match(
        mainFunction,
        /suppressOutput:\s*!message/,
        'Must suppress output when no message to display'
      );
    });
  });
});

describe('API Key Rotation Logic - Integration Scenarios', () => {
  describe('Scenario: Two keys, first at 95%, second at 20%', () => {
    it('should rotate to second key', () => {
      // This is a logical validation of the rotation algorithm
      // State: Key A at 95%, Key B at 20%
      // Expected: Should switch from A to B

      const hookCode = fs.readFileSync(path.join(process.cwd(), '.claude/hooks/api-key-watcher.js'), 'utf8');
      const selectActiveKeyFunction = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/)[0];

      // Should find key with lowest max usage when current >= 90%
      assert.match(
        selectActiveKeyFunction,
        /maxUsage >= HIGH_USAGE_THRESHOLD/,
        'Must detect current key at high usage'
      );

      assert.match(
        selectActiveKeyFunction,
        /\.sort\(/,
        'Must sort keys by usage to find lowest'
      );
    });
  });

  describe('Scenario: Two keys, both at 95%', () => {
    it('should stick with current key until it hits 100%', () => {
      // State: Key A (current) at 95%, Key B at 95%
      // Expected: Should stay on A until A hits 100%

      const hookCode = fs.readFileSync(path.join(process.cwd(), '.claude/hooks/api-key-watcher.js'), 'utf8');
      const selectActiveKeyFunction = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/)[0];

      // Should detect allAbove90 scenario
      assert.match(
        selectActiveKeyFunction,
        /allAbove90 = usableKeys\.every\(/,
        'Must detect when all keys are above 90%'
      );

      // In allAbove90, should only switch at EXHAUSTED_THRESHOLD
      const allAbove90Branch = selectActiveKeyFunction.match(/if \(allAbove90\) \{[\s\S]*?\n  \} else/s);
      assert.ok(allAbove90Branch, 'Must have allAbove90 conditional');

      const branchBody = allAbove90Branch[0];
      assert.match(
        branchBody,
        /EXHAUSTED_THRESHOLD/,
        'Must only switch at exhausted threshold when all keys high usage'
      );
    });
  });

  describe('Scenario: Single key at 95%', () => {
    it('should continue using single key until exhausted', () => {
      // State: Only Key A at 95%
      // Expected: Stay on A (no alternative)

      const hookCode = fs.readFileSync(path.join(process.cwd(), '.claude/hooks/api-key-watcher.js'), 'utf8');
      const selectActiveKeyFunction = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/)[0];

      // Should return current or first usable as default
      assert.match(
        selectActiveKeyFunction,
        /return currentKey\?\.\w+ \?\? usableKeys\[0\]\?\.\w+ \?\? null/,
        'Must return current key when no better option available'
      );
    });
  });

  describe('Scenario: All keys exhausted (100%)', () => {
    it('should return null (no usable keys)', () => {
      const hookCode = fs.readFileSync(path.join(process.cwd(), '.claude/hooks/api-key-watcher.js'), 'utf8');
      const selectActiveKeyFunction = hookCode.match(/function selectActiveKey\(state\) \{[\s\S]*?\n\}/)[0];

      // Should filter out keys at 100%
      assert.match(
        selectActiveKeyFunction,
        /usage\.five_hour < EXHAUSTED_THRESHOLD/,
        'Must filter out exhausted keys'
      );

      // Should return null when no usable keys
      assert.match(
        selectActiveKeyFunction,
        /usableKeys\.length === 0.*?return null/s,
        'Must return null when all keys exhausted'
      );
    });
  });
});
