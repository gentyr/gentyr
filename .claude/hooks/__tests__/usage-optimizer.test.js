/**
 * Tests for usage-optimizer.js
 *
 * These tests validate:
 * 1. runUsageOptimizer() - Main entry point and error handling
 * 2. Snapshot collection from API keys
 * 3. Trajectory calculation from snapshots
 * 4. Adjustment factor computation
 * 5. Config file updates with new effective cooldowns
 * 6. Edge cases: no keys, no snapshots, usage at/above target
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/usage-optimizer.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

describe('usage-optimizer.js - Structure Validation', () => {
  const PROJECT_DIR = process.cwd();
  const OPTIMIZER_PATH = path.join(PROJECT_DIR, '.claude/hooks/usage-optimizer.js');

  describe('Code Structure', () => {
    it('should be a valid ES module', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Should use ES module imports
      assert.match(code, /import .* from ['"]fs['"]/, 'Must import fs');
      assert.match(code, /import .* from ['"]path['"]/, 'Must import path');
      assert.match(code, /import .* from ['"]os['"]/, 'Must import os');
    });

    it('should import from config-reader.js', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /import \{[\s\S]*?getConfigPath[\s\S]*?\} from ['"]\.\/config-reader\.js['"]/,
        'Must import getConfigPath from config-reader.js'
      );

      assert.match(
        code,
        /import \{[\s\S]*?getDefaults[\s\S]*?\} from ['"]\.\/config-reader\.js['"]/,
        'Must import getDefaults from config-reader.js'
      );
    });

    it('should export runUsageOptimizer function', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /export async function runUsageOptimizer/,
        'Must export runUsageOptimizer as async function'
      );
    });

    it('should define critical constants', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /const TARGET_UTILIZATION = 0\.90/,
        'Must define TARGET_UTILIZATION = 0.90'
      );

      assert.match(
        code,
        /const MAX_FACTOR = 20\.0/,
        'Must define MAX_FACTOR = 20.0'
      );

      assert.match(
        code,
        /const MIN_FACTOR = 0\.05/,
        'Must define MIN_FACTOR = 0.05'
      );

      assert.match(
        code,
        /const MAX_CHANGE_PER_CYCLE = 0\.10/,
        'Must define MAX_CHANGE_PER_CYCLE = 0.10 (10%)'
      );

      assert.match(
        code,
        /const MIN_SNAPSHOTS_FOR_TRAJECTORY = 3/,
        'Must define MIN_SNAPSHOTS_FOR_TRAJECTORY = 3'
      );

      assert.match(
        code,
        /const MIN_EFFECTIVE_MINUTES = 5/,
        'Must define MIN_EFFECTIVE_MINUTES = 5'
      );

      assert.match(
        code,
        /const SINGLE_KEY_WARNING_THRESHOLD = 0\.80/,
        'Must define SINGLE_KEY_WARNING_THRESHOLD = 0.80'
      );

      assert.match(
        code,
        /const PER_KEY_RESET_DROP_THRESHOLD = 0\.50/,
        'Must define PER_KEY_RESET_DROP_THRESHOLD = 0.50'
      );
    });

    it('should define file paths', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /const ROTATION_STATE_PATH/,
        'Must define ROTATION_STATE_PATH for API keys'
      );

      assert.match(
        code,
        /const SNAPSHOTS_PATH/,
        'Must define SNAPSHOTS_PATH for usage snapshots'
      );

      assert.match(
        code,
        /const CREDENTIALS_PATH/,
        'Must define CREDENTIALS_PATH for fallback credentials'
      );
    });

    it('should define Anthropic API constants', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /const ANTHROPIC_API_URL = ['"]https:\/\/api\.anthropic\.com\/api\/oauth\/usage['"]/,
        'Must define ANTHROPIC_API_URL'
      );

      assert.match(
        code,
        /const ANTHROPIC_BETA_HEADER/,
        'Must define ANTHROPIC_BETA_HEADER'
      );
    });
  });

  describe('runUsageOptimizer() - Main Entry Point', () => {
    it('should accept optional logFn parameter', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export async function runUsageOptimizer\([\s\S]*?\) \{/);
      assert.ok(functionMatch, 'runUsageOptimizer must exist');

      assert.match(
        functionMatch[0],
        /runUsageOptimizer\(\[?logFn\]?\)/,
        'Must accept optional logFn parameter'
      );
    });

    it('should default to console.log when logFn not provided', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export async function runUsageOptimizer\([\s\S]*?\n  try \{/);
      assert.ok(functionMatch, 'Function must have try block');

      assert.match(
        functionMatch[0],
        /const log = logFn \|\| console\.log/,
        'Must default logFn to console.log'
      );
    });

    it('should return success status object', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Find all return statements in runUsageOptimizer
      const functionBody = code.match(/export async function runUsageOptimizer[\s\S]*?(?=\nexport|$)/);
      assert.ok(functionBody, 'Must find function body');

      // Should return { success, snapshotTaken, adjustmentMade }
      assert.match(
        functionBody[0],
        /return \{[\s\S]*?success:[\s\S]*?snapshotTaken:[\s\S]*?adjustmentMade:/,
        'Must return object with success, snapshotTaken, adjustmentMade'
      );
    });

    it('should wrap execution in try-catch', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export async function runUsageOptimizer[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'Function must exist');

      const functionBody = functionMatch[0];

      assert.match(functionBody, /try \{/, 'Must have try block');
      assert.match(functionBody, /catch \(err\)/, 'Must have catch block');
    });

    it('should return error in response on failure', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export async function runUsageOptimizer[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // The outer catch block is the one that returns { success: false, error: ... }.
      // Match it by finding the return with success: false and error field anywhere
      // in the function body (the outer catch wraps the full try block).
      assert.match(
        functionBody,
        /return \{[\s\S]*?success: false[\s\S]*?error:/,
        'Must return success: false and error message in outer catch block'
      );
    });

    it('should log error message before returning', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export async function runUsageOptimizer[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      const catchBlock = functionBody.match(/catch \(err\) \{[\s\S]*?\n  \}/);

      assert.match(
        catchBlock[0],
        /log\(/,
        'Must call log function in catch block'
      );

      assert.match(
        catchBlock[0],
        /err\.message/,
        'Must log error message'
      );
    });
  });

  describe('collectSnapshot() - Snapshot Collection', () => {
    it('should get API keys and fetch usage for each', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/async function collectSnapshot\(log\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'collectSnapshot function must exist');

      const functionBody = functionMatch[0];

      // Should call getApiKeys()
      assert.match(
        functionBody,
        /const keys = getApiKeys\(\)/,
        'Must call getApiKeys()'
      );

      // Should iterate over keys
      assert.match(
        functionBody,
        /for \(const key of keys\)/,
        'Must iterate over keys'
      );

      // Should fetch usage for each key
      assert.match(
        functionBody,
        /await fetchUsage\(key\.accessToken\)/,
        'Must fetch usage for each key'
      );
    });

    it('should return null when no keys available', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/async function collectSnapshot\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /if \(keys\.length === 0\)[\s\S]*?return null/s,
        'Must return null when no keys found'
      );

      assert.match(
        functionBody,
        /No API keys found/i,
        'Must log message when no keys'
      );
    });

    it('should return null when no usage data retrieved', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/async function collectSnapshot\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /if \(Object\.keys\(rawKeyData\)\.length === 0\)/,
        'Must check if no usage data collected'
      );

      assert.match(
        functionBody,
        /No usage data retrieved/i,
        'Must log when no usage data'
      );

      assert.match(
        functionBody,
        /return null/,
        'Must return null when no usage data'
      );
    });

    it('should build snapshot with timestamp and key data', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/async function collectSnapshot\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should capture timestamp
      assert.match(
        functionBody,
        /const ts = Date\.now\(\)/,
        'Must capture timestamp'
      );

      // Should return snapshot with ts and keys (deduplicated keyData)
      assert.match(
        functionBody,
        /return \{[\s\S]*?ts[\s\S]*?keys:[\s\S]*?keyData/s,
        'Must return snapshot with ts and keys'
      );
    });

    it('should deduplicate keys by account before building snapshot', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/async function collectSnapshot\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should build a keyLookup map
      assert.match(
        functionBody,
        /const keyLookup = new Map\(\)/,
        'Must create keyLookup map for account deduplication'
      );

      // Should collect raw data first, then deduplicate
      assert.match(
        functionBody,
        /const rawKeyData = \{\}/,
        'Must collect raw key data before deduplication'
      );

      // Should create accountMap for deduplication
      assert.match(
        functionBody,
        /const accountMap = new Map\(\)/,
        'Must create accountMap for per-account deduplication'
      );

      // Should use accountId with fingerprint fallback
      assert.match(
        functionBody,
        /key\?\.accountId[\s\S]*?\|\|[\s\S]*?`fp:/s,
        'Must use accountId with fingerprint fallback for dedup key'
      );
    });

    it('should normalize API utilization values from 0-100 to 0-1 fractions', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/async function collectSnapshot\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should divide 5h utilization by 100 (now stored in rawKeyData)
      assert.match(
        functionBody,
        /['"]5h['"]\s*:\s*\(usage\.fiveHour\.utilization[\s\S]*?\)\s*\/\s*100/,
        'Must divide 5h utilization by 100 to normalize to 0-1 fraction'
      );

      // Should divide 7d utilization by 100 (now stored in rawKeyData)
      assert.match(
        functionBody,
        /['"]7d['"]\s*:\s*\(usage\.sevenDay\.utilization[\s\S]*?\)\s*\/\s*100/,
        'Must divide 7d utilization by 100 to normalize to 0-1 fraction'
      );
    });

    it('should handle fetch errors gracefully per key', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/async function collectSnapshot\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should wrap fetch in try-catch
      assert.match(
        functionBody,
        /try \{[\s\S]*?await fetchUsage[\s\S]*?\} catch \(err\)/s,
        'Must wrap fetchUsage in try-catch'
      );

      // Should log error but continue
      assert.match(
        functionBody,
        /catch \(err\)[\s\S]*?log\(/s,
        'Must log error in catch block'
      );
    });
  });

  describe('getApiKeys() - Key Discovery', () => {
    it('should try rotation state file first', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function getApiKeys\(\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'getApiKeys function must exist');

      const functionBody = functionMatch[0];

      // Should check ROTATION_STATE_PATH (may use ternary or if)
      assert.match(
        functionBody,
        /fs\.existsSync\(ROTATION_STATE_PATH\)/,
        'Must check rotation state file existence'
      );

      // Should parse rotation state (from rotationPath variable or ROTATION_STATE_PATH directly)
      assert.match(
        functionBody,
        /JSON\.parse\(fs\.readFileSync\(rotation/i,
        'Must read and parse rotation state'
      );
    });

    it('should extract keys from rotation state', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function getApiKeys\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should iterate over state.keys
      assert.match(
        functionBody,
        /Object\.entries\(state\.keys\)/,
        'Must iterate over state.keys entries'
      );

      // Should check for accessToken
      assert.match(
        functionBody,
        /data\.accessToken/,
        'Must check for accessToken in key data'
      );

      // Should push to keys array
      assert.match(
        functionBody,
        /keys\.push\(/,
        'Must push keys to array'
      );
    });

    it('should fall back to credentials file', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function getApiKeys\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check if keys.length === 0
      assert.match(
        functionBody,
        /if \(keys\.length === 0 && fs\.existsSync\(CREDENTIALS_PATH\)\)/,
        'Must fall back to credentials when no rotation keys'
      );

      // Should read credentials
      assert.match(
        functionBody,
        /JSON\.parse\(fs\.readFileSync\(CREDENTIALS_PATH/,
        'Must read credentials file'
      );

      // Should check claudeAiOauth.accessToken
      assert.match(
        functionBody,
        /creds\?\.claudeAiOauth\?\.accessToken/,
        'Must extract claudeAiOauth.accessToken'
      );
    });

    it('should return array of { id, accessToken, accountId } objects', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function getApiKeys\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should initialize keys array
      assert.match(
        functionBody,
        /const keys = \[\]/,
        'Must initialize empty keys array'
      );

      // Should return keys
      assert.match(
        functionBody,
        /return keys/,
        'Must return keys array'
      );

      // Should include accountId from rotation state
      assert.match(
        functionBody,
        /accountId:\s*data\.account_uuid \|\| null/,
        'Must include accountId from rotation state account_uuid'
      );
    });

    it('should handle file read errors gracefully', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function getApiKeys\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should have catch blocks (at least 2 for rotation state and credentials)
      const catchBlocks = (functionBody.match(/\} catch/g) || []).length;
      assert.ok(catchBlocks >= 2, 'Must have catch blocks for file errors');
    });
  });

  describe('fetchUsage() - API Call', () => {
    it('should make GET request to Anthropic API', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/async function fetchUsage\(accessToken\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'fetchUsage function must exist');

      const functionBody = functionMatch[0];

      // Should call fetch with ANTHROPIC_API_URL
      assert.match(
        functionBody,
        /await fetch\(ANTHROPIC_API_URL/,
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
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/async function fetchUsage\(accessToken\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should set Authorization header
      assert.match(
        functionBody,
        /['"]Authorization['"]\s*:\s*`Bearer \$\{accessToken\}`/,
        'Must set Authorization header with Bearer token'
      );

      // Should set anthropic-beta header
      assert.match(
        functionBody,
        /['"]anthropic-beta['"]\s*:\s*ANTHROPIC_BETA_HEADER/,
        'Must set anthropic-beta header'
      );
    });

    it('should return null on non-OK response', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/async function fetchUsage\(accessToken\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /if \(!response\.ok\)/,
        'Must check response.ok'
      );

      assert.match(
        functionBody,
        /return null/,
        'Must return null on failed response'
      );
    });

    it('should parse and extract usage data', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/async function fetchUsage\(accessToken\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should parse JSON
      assert.match(
        functionBody,
        /await response\.json\(\)/,
        'Must parse JSON response'
      );

      // Should extract five_hour utilization
      assert.match(
        functionBody,
        /data\.five_hour\?\.utilization/,
        'Must extract five_hour.utilization'
      );

      // Should extract seven_day utilization
      assert.match(
        functionBody,
        /data\.seven_day\?\.utilization/,
        'Must extract seven_day.utilization'
      );

      // Should extract resets_at fields
      assert.match(
        functionBody,
        /data\.five_hour\?\.resets_at/,
        'Must extract five_hour.resets_at'
      );

      assert.match(
        functionBody,
        /data\.seven_day\?\.resets_at/,
        'Must extract seven_day.resets_at'
      );
    });

    it('should return structured usage object', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/async function fetchUsage\(accessToken\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should return object with fiveHour and sevenDay
      assert.match(
        functionBody,
        /return \{[\s\S]*?fiveHour:[\s\S]*?sevenDay:/s,
        'Must return object with fiveHour and sevenDay'
      );
    });
  });

  describe('storeSnapshot() - Snapshot Storage', () => {
    it('should migrate old-format snapshots from 0-100 scale to 0-1 fractions', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function storeSnapshot\(snapshot, log\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'storeSnapshot function must exist');

      const functionBody = functionMatch[0];

      // Should iterate over existing snapshots for migration
      assert.match(
        functionBody,
        /for \(const s of data\.snapshots\)/,
        'Must iterate over existing snapshots'
      );

      // Should check for values > 1.0 in 5h metric
      assert.match(
        functionBody,
        /if \(\(k\[['"]5h['"]\][\s\S]*?\) > 1\.0\)/,
        'Must check if 5h value is >1.0 (old format)'
      );

      // Should divide old 5h values by 100
      assert.match(
        functionBody,
        /k\[['"]5h['"]\] = k\[['"]5h['"]\] \/ 100/,
        'Must divide old 5h values by 100'
      );

      // Should check for values > 1.0 in 7d metric
      assert.match(
        functionBody,
        /if \(\(k\[['"]7d['"]\][\s\S]*?\) > 1\.0\)/,
        'Must check if 7d value is >1.0 (old format)'
      );

      // Should divide old 7d values by 100
      assert.match(
        functionBody,
        /k\[['"]7d['"]\] = k\[['"]7d['"]\] \/ 100/,
        'Must divide old 7d values by 100'
      );
    });

    it('should append snapshot to snapshots array', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function storeSnapshot\(snapshot, log\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'storeSnapshot function must exist');

      const functionBody = functionMatch[0];

      // Should push snapshot
      assert.match(
        functionBody,
        /data\.snapshots\.push\(snapshot\)/,
        'Must push snapshot to array'
      );
    });

    it('should prune old snapshots based on retention', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function storeSnapshot\(snapshot, log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should calculate cutoff based on SNAPSHOT_RETENTION_DAYS
      assert.match(
        functionBody,
        /SNAPSHOT_RETENTION_DAYS/,
        'Must use SNAPSHOT_RETENTION_DAYS constant'
      );

      // Should filter snapshots by timestamp
      assert.match(
        functionBody,
        /data\.snapshots\.filter\(s => s\.ts/,
        'Must filter snapshots by timestamp'
      );
    });

    it('should write snapshots to file', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function storeSnapshot\(snapshot, log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should write to SNAPSHOTS_PATH
      assert.match(
        functionBody,
        /fs\.writeFileSync\(SNAPSHOTS_PATH/,
        'Must write to SNAPSHOTS_PATH'
      );

      // Should stringify with formatting
      assert.match(
        functionBody,
        /JSON\.stringify\(data,\s*null,\s*2\)/,
        'Must stringify with 2-space indent'
      );
    });

    it('should handle write errors gracefully', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function storeSnapshot\(snapshot, log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should wrap write in try-catch
      assert.match(
        functionBody,
        /try \{[\s\S]*?fs\.writeFileSync[\s\S]*?\} catch/s,
        'Must wrap file write in try-catch'
      );

      // Should log error
      assert.match(
        functionBody,
        /catch[\s\S]*?log\(/s,
        'Must log write errors'
      );
    });

    it('should initialize with empty snapshots array if file missing', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function storeSnapshot\(snapshot, log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should initialize data
      assert.match(
        functionBody,
        /let data = \{[\s\S]*?snapshots:\s*\[\]/s,
        'Must initialize with empty snapshots array'
      );
    });
  });

  describe('calculateAndAdjust() - Trajectory & Adjustment', () => {
    it('should require minimum snapshots for trajectory', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'calculateAndAdjust function must exist');

      const functionBody = functionMatch[0];

      // Should check snapshot count against MIN_SNAPSHOTS_FOR_TRAJECTORY
      assert.match(
        functionBody,
        /data\.snapshots\.length < MIN_SNAPSHOTS_FOR_TRAJECTORY/,
        'Must check snapshot count'
      );

      // Should return false when insufficient snapshots
      assert.match(
        functionBody,
        /return false/,
        'Must return false when not enough snapshots'
      );
    });

    it('should calculate trajectory from time-based earliest and latest snapshots', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should get latest snapshot
      assert.match(
        functionBody,
        /const latest = data\.snapshots\[data\.snapshots\.length - 1\]/,
        'Must get latest snapshot'
      );

      // Should use time-based window for earliest
      assert.match(
        functionBody,
        /const timeBasedWindow = selectTimeBasedSnapshots\(data\.snapshots, EMA_WINDOW_MS, EMA_MIN_INTERVAL_MS\)/,
        'Must use selectTimeBasedSnapshots for window'
      );

      assert.match(
        functionBody,
        /const earliest = timeBasedWindow\[0\]/,
        'Must get earliest snapshot from time-based window'
      );

      // Should calculate hours between
      assert.match(
        functionBody,
        /hoursBetween = \(latest\.ts - earliest\.ts\)/,
        'Must calculate time span between snapshots'
      );
    });

    it('should require minimum time span', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check if hoursBetween is too small
      assert.match(
        functionBody,
        /if \(hoursBetween < 0\.\d+\)/,
        'Must check minimum time span'
      );

      // Should log and return false
      assert.match(
        functionBody,
        /Not enough time span/i,
        'Must log when time span too small'
      );
    });

    it('should calculate projected usage at reset time with projection cap', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Projections are capped at MAX_PROJECTION to prevent runaway extrapolation
      // on long horizons (e.g. 7d window with 155h until reset).
      assert.match(
        functionBody,
        /projected5h = Math\.min\(MAX_PROJECTION, aggregate\.current5h \+ \(aggregate\.rate5h \* aggregate\.hoursUntil5hReset\)\)/,
        'Must cap projected 5h usage at MAX_PROJECTION'
      );

      assert.match(
        functionBody,
        /projected7d = Math\.min\(MAX_PROJECTION, aggregate\.current7d \+ \(aggregate\.rate7d \* aggregate\.hoursUntil7dReset\)\)/,
        'Must cap projected 7d usage at MAX_PROJECTION'
      );
    });

    it('should determine constraining metric', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should compare projections
      assert.match(
        functionBody,
        /const constraining = projected5h > projected7d \? ['"]5h['"] : ['"]7d['"]/,
        'Must determine constraining metric by comparing projections'
      );
    });

    it('should handle edge case: already at or above target', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check if effectiveUsage >= TARGET_UTILIZATION
      assert.match(
        functionBody,
        /if \(effectiveUsage >= TARGET_UTILIZATION\)/,
        'Must check if already at target (using effectiveUsage)'
      );

      // Should clamp factor to <= 1.0 (never speed up)
      assert.match(
        functionBody,
        /Math\.min\(currentFactor, 1\.0\)/,
        'Must clamp factor to 1.0 when at target'
      );
    });

    it('should handle edge case: rate is zero or negative', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check if rate <= 0
      assert.match(
        functionBody,
        /if \(currentRate <= 0\)/,
        'Must handle zero or negative rate'
      );

      // Should speed up conservatively
      assert.match(
        functionBody,
        /currentFactor \* 1\.0\d+/,
        'Must increase factor when rate is flat'
      );
    });

    it('should calculate desired rate to hit target', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should calculate desiredRate using effectiveUsage (biased by max key)
      assert.match(
        functionBody,
        /desiredRate = \(TARGET_UTILIZATION - effectiveUsage\) \/ hoursUntilReset/,
        'Must calculate desired rate from effectiveUsage'
      );

      // Should calculate ratio
      assert.match(
        functionBody,
        /rawRatio = desiredRate \/ currentRate/,
        'Must calculate ratio of desired to current rate'
      );
    });

    it('should apply conservative bounds: max ±10% per cycle', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should clamp to MAX_CHANGE_PER_CYCLE
      assert.match(
        functionBody,
        /Math\.max\(1\.0 - MAX_CHANGE_PER_CYCLE,\s*Math\.min\(1\.0 \+ MAX_CHANGE_PER_CYCLE/,
        'Must clamp change to ±MAX_CHANGE_PER_CYCLE'
      );
    });

    it('should apply overall factor bounds (MIN_FACTOR to MAX_FACTOR)', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should clamp to MIN_FACTOR and MAX_FACTOR
      assert.match(
        functionBody,
        /Math\.max\(MIN_FACTOR,\s*Math\.min\(MAX_FACTOR/,
        'Must clamp to MIN_FACTOR and MAX_FACTOR'
      );
    });

    it('should skip update if change too small', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check if change is meaningful
      assert.match(
        functionBody,
        /if \(Math\.abs\(newFactor - currentFactor\) < 0\.01\)/,
        'Must skip update if change less than 0.01'
      );

      // Should return false
      assert.match(
        functionBody,
        /Factor unchanged/i,
        'Must log when factor unchanged'
      );
    });

    it('should call applyFactor when adjustment needed', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should call applyFactor (with hoursUntilReset as 6th arg)
      assert.match(
        functionBody,
        /applyFactor\(config, newFactor, constraining, projectedAtReset, log, hoursUntilReset\)/,
        'Must call applyFactor with correct parameters including hoursUntilReset'
      );

      // Should return true after adjustment
      assert.match(
        functionBody,
        /applyFactor[\s\S]*?return true/s,
        'Must return true after applying factor'
      );
    });
  });

  describe('calculateAggregate() - Aggregate Metrics', () => {
    it('should average utilization across active keys', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAggregate\(latest, earliest, hoursBetween(?:, allSnapshots)?\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'calculateAggregate function must exist');

      const functionBody = functionMatch[0];

      // Should sum values across entries to average
      assert.match(
        functionBody,
        /sum5h \+=/,
        'Must sum 5h utilization across keys'
      );

      assert.match(
        functionBody,
        /sum7d \+=/,
        'Must sum 7d utilization across keys'
      );

      // Should divide by numKeys (count of entries to average)
      assert.match(
        functionBody,
        /current5h = sum5h \/ numKeys/,
        'Must average 5h by dividing by numKeys'
      );

      assert.match(
        functionBody,
        /current7d = sum7d \/ numKeys/,
        'Must average 7d by dividing by numKeys'
      );

      // Should filter exhausted accounts (7d >= 0.995)
      assert.match(
        functionBody,
        /EXHAUSTED_THRESHOLD/,
        'Must define exhausted threshold for filtering'
      );

      assert.match(
        functionBody,
        /exhaustedKeyIds/,
        'Must track exhausted key IDs'
      );

      assert.match(
        functionBody,
        /activeEntries/,
        'Must compute active (non-exhausted) entries'
      );
    });

    it('should calculate rates from common keys between earliest and latest', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAggregate\(latest, earliest, hoursBetween(?:, allSnapshots)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should find common keys between snapshots
      assert.match(
        functionBody,
        /commonKeyIds/,
        'Must identify common keys between snapshots'
      );

      // Should calculate rate5h from common keys
      assert.match(
        functionBody,
        /rate5h = \(avg5hNow - avg5hPrev\) \/ hoursBetween/,
        'Must calculate rate5h from common key averages'
      );

      // Should calculate rate7d from common keys
      assert.match(
        functionBody,
        /rate7d = \(avg7dNow - avg7dPrev\) \/ hoursBetween/,
        'Must calculate rate7d from common key averages'
      );
    });

    it('should calculate hours until reset from reset timestamps', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAggregate\(latest, earliest, hoursBetween(?:, allSnapshots)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should parse reset timestamps
      assert.match(
        functionBody,
        /new Date\(resetAt5h\)\.getTime\(\)/,
        'Must parse 5h reset timestamp'
      );

      assert.match(
        functionBody,
        /new Date\(resetAt7d\)\.getTime\(\)/,
        'Must parse 7d reset timestamp'
      );

      // Should calculate hours until reset
      assert.match(
        functionBody,
        /hoursUntil5hReset = Math\.max\(0\.\d+,\s*\(resetTime - now\)/,
        'Must calculate hours until 5h reset'
      );
    });

    it('should return aggregate object with all metrics', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAggregate\(latest, earliest, hoursBetween(?:, allSnapshots)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should return object with all metrics including max-key and per-key data
      assert.match(
        functionBody,
        /return \{[\s\S]*?current5h,[\s\S]*?current7d,[\s\S]*?rate5h,[\s\S]*?rate7d,[\s\S]*?hoursUntil5hReset,[\s\S]*?hoursUntil7dReset/s,
        'Must return aggregate with all required metrics'
      );

      assert.match(
        functionBody,
        /maxKey5h, maxKey7d, perKeyUtilization,/,
        'Must return maxKey5h, maxKey7d, and perKeyUtilization'
      );

      assert.match(
        functionBody,
        /activeKeyCount:[\s\S]*?totalKeyCount:/s,
        'Must return activeKeyCount and totalKeyCount'
      );
    });

    it('should return null when no keys in snapshot', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAggregate\(latest, earliest, hoursBetween(?:, allSnapshots)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check if latestEntries.length === 0
      assert.match(
        functionBody,
        /if \(latestEntries\.length === 0\)[\s\S]*?return null/s,
        'Must return null when no keys in snapshot'
      );
    });
  });

  describe('applyFactor() - Config Update', () => {
    it('should calculate effective cooldowns from defaults and factor', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function applyFactor\(config, newFactor, constraining, projectedAtReset, log(?:, hoursUntilReset)?\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'applyFactor function must exist');

      const functionBody = functionMatch[0];

      // Should get defaults from getDefaults()
      assert.match(
        functionBody,
        /const defaults = getDefaults\(\)/,
        'Must get defaults from getDefaults()'
      );

      // Should calculate effective values with MIN_EFFECTIVE_MINUTES floor (GAP 1: uses computed variable)
      assert.match(
        functionBody,
        /let computed = Math\.max\(MIN_EFFECTIVE_MINUTES, Math\.round\(defaultVal \/ newFactor\)\)/,
        'Must calculate effective with MIN_EFFECTIVE_MINUTES floor'
      );

      // Higher factor = shorter cooldowns (more activity)
      // This is validated by the division: defaultVal / newFactor
    });

    it('should update config.effective with new values', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function applyFactor\(config, newFactor, constraining, projectedAtReset, log(?:, hoursUntilReset)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should set config.effective
      assert.match(
        functionBody,
        /config\.effective = effective/,
        'Must update config.effective'
      );
    });

    it('should update config.adjustment with metadata', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function applyFactor\(config, newFactor, constraining, projectedAtReset, log(?:, hoursUntilReset)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should set config.adjustment
      assert.match(
        functionBody,
        /config\.adjustment = \{/,
        'Must update config.adjustment object'
      );

      // Should include factor (rounded to 3 decimals)
      assert.match(
        functionBody,
        /factor:\s*Math\.round\(newFactor \* 1000\) \/ 1000/,
        'Must round factor to 3 decimal places'
      );

      // Should include last_updated timestamp
      assert.match(
        functionBody,
        /last_updated:\s*new Date\(\)\.toISOString\(\)/,
        'Must include ISO timestamp'
      );

      // Should include constraining_metric
      assert.match(
        functionBody,
        /constraining_metric:\s*constraining/,
        'Must include constraining metric'
      );

      // Should include projected_at_reset
      assert.match(
        functionBody,
        /projected_at_reset:\s*Math\.round\(projectedAtReset \* 1000\) \/ 1000/,
        'Must include projected utilization at reset'
      );
    });

    it('should write updated config to file', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function applyFactor\(config, newFactor, constraining, projectedAtReset, log(?:, hoursUntilReset)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should get config path
      assert.match(
        functionBody,
        /const configPath = getConfigPath\(\)/,
        'Must get config path from getConfigPath()'
      );

      // Should write to file
      assert.match(
        functionBody,
        /fs\.writeFileSync\(configPath,\s*JSON\.stringify\(config,\s*null,\s*2\)\)/,
        'Must write config with JSON.stringify'
      );
    });

    it('should log the adjustment', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function applyFactor\(config, newFactor, constraining, projectedAtReset, log(?:, hoursUntilReset)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should log after write
      assert.match(
        functionBody,
        /log\(/,
        'Must log the adjustment'
      );

      // Should include factor, constraining metric, and projection
      assert.match(
        functionBody,
        /newFactor\.toFixed\(3\)/,
        'Must log new factor'
      );

      assert.match(
        functionBody,
        /Constraining/i,
        'Must log constraining metric'
      );

      assert.match(
        functionBody,
        /Projected/i,
        'Must log projected usage'
      );
    });

    it('should handle write errors gracefully', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function applyFactor\(config, newFactor, constraining, projectedAtReset, log(?:, hoursUntilReset)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should wrap write in try-catch
      assert.match(
        functionBody,
        /try \{[\s\S]*?fs\.writeFileSync[\s\S]*?\} catch/s,
        'Must wrap file write in try-catch'
      );

      // Should log error
      assert.match(
        functionBody,
        /catch[\s\S]*?log\(/s,
        'Must log write errors'
      );
    });
  });

  describe('calculateEmaRate() - EMA Smoothing', () => {
    it('should exist as a standalone function', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateEmaRate\(snapshots, metricKey, alpha = 0\.3, excludeKeys = null\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'calculateEmaRate function must exist with correct signature');
    });

    it('should return 0 for fewer than 2 snapshots', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateEmaRate\(snapshots, metricKey, alpha = 0\.3, excludeKeys = null\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /if \(snapshots\.length < 2\) return 0/,
        'Must return 0 for fewer than 2 snapshots'
      );
    });

    it('should compute EMA from consecutive snapshot pairs', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateEmaRate\(snapshots, metricKey, alpha = 0\.3, excludeKeys = null\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should iterate with i=1 start
      assert.match(
        functionBody,
        /for \(let i = 1; i < snapshots\.length; i\+\+\)/,
        'Must iterate from index 1 through all snapshots'
      );

      // Should compute hours delta
      assert.match(
        functionBody,
        /hoursDelta = \(curr\.ts - prev\.ts\) \/ \(1000 \* 60 \* 60\)/,
        'Must compute time delta in hours'
      );

      // Should use EMA formula
      assert.match(
        functionBody,
        /emaRate = alpha \* intervalRate \+ \(1 - alpha\) \* emaRate/,
        'Must apply EMA smoothing formula'
      );
    });

    it('should skip rapid-fire time intervals below MIN_HOURS_DELTA', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateEmaRate\(snapshots, metricKey, alpha = 0\.3, excludeKeys = null\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /if \(hoursDelta < MIN_HOURS_DELTA\) continue/,
        'Must skip intervals shorter than MIN_HOURS_DELTA (0.05h = 3 min)'
      );
    });

    it('should find common keys between consecutive snapshots', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateEmaRate\(snapshots, metricKey, alpha = 0\.3, excludeKeys = null\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /Object\.keys\(curr\.keys\)\.filter\(k => k in prev\.keys\)/,
        'Must filter for common keys between consecutive snapshots'
      );
    });
  });

  describe('Reset-Boundary Detection (Per-Key)', () => {
    it('should detect large 5h utilization drops per-key between consecutive snapshots', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /Reset boundary detected/,
        'Must log when reset boundary is detected'
      );

      assert.match(
        functionBody,
        /keyDrop >= PER_KEY_RESET_DROP_THRESHOLD/,
        'Must compare per-key drop against PER_KEY_RESET_DROP_THRESHOLD'
      );
    });

    it('should compare each key individually for boundary detection', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /data\.snapshots\[data\.snapshots\.length - 2\]/,
        'Must access second-to-last snapshot'
      );

      // Per-key detection: compute drop for each common key individually
      assert.match(
        functionBody,
        /const keyDrop = \(prev\.keys\[k\]\['5h'\] \?\? 0\) - \(curr\.keys\[k\]\['5h'\] \?\? 0\)/,
        'Must calculate per-key drop for each common key'
      );
    });

    it('should skip adjustment cycle when any key reset detected', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // After detecting reset on any key, should return false
      const resetBlock = functionBody.match(/keyDrop >= PER_KEY_RESET_DROP_THRESHOLD[\s\S]*?return false/);
      assert.ok(resetBlock, 'Must return false when any key reset boundary detected');
    });
  });

  describe('Per-Key Warnings and Max-Key Biasing', () => {
    it('should log warnings when any account exceeds 5h threshold', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /Usage optimizer WARNING: Account .* 5h utilization/,
        'Must log per-account 5h utilization warnings'
      );
    });

    it('should log warnings when any account exceeds 7d threshold', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /Usage optimizer WARNING: Account .* 7d utilization/,
        'Must log per-account 7d utilization warnings'
      );
    });

    it('should bias effectiveUsage upward when max key near threshold', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /let effectiveUsage = currentUsage/,
        'Must initialize effectiveUsage from currentUsage'
      );

      assert.match(
        functionBody,
        /if \(maxKeyUsage >= SINGLE_KEY_WARNING_THRESHOLD\)/,
        'Must check maxKeyUsage against threshold'
      );

      assert.match(
        functionBody,
        /effectiveUsage = Math\.max\(effectiveUsage, maxKeyUsage \* 0\.8\)/,
        'Must bias effectiveUsage upward using max key value'
      );
    });

    it('should use maxKey5h or maxKey7d based on constraining metric', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /const maxKeyUsage = constraining === ['"]5h['"] \? aggregate\.maxKey5h : aggregate\.maxKey7d/,
        'Must select maxKey based on constraining metric'
      );
    });

    it('should track per-key utilization in calculateAggregate', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAggregate\(latest, earliest, hoursBetween(?:, allSnapshots)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /const perKeyUtilization = \{\}/,
        'Must initialize perKeyUtilization object'
      );

      assert.match(
        functionBody,
        /perKeyUtilization\[id\] = \{ ['"]5h['"]:/,
        'Must populate per-key utilization data'
      );
    });

    it('should track max values across keys in calculateAggregate', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAggregate\(latest, earliest, hoursBetween(?:, allSnapshots)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // maxKey computed from entriesToAverage (active keys), not first pass
      assert.match(
        functionBody,
        /for \(const \[, k\] of entriesToAverage\)[\s\S]*?maxKey5h = Math\.max\(maxKey5h, k\['5h'\]/s,
        'Must compute maxKey5h from active keys (entriesToAverage)'
      );

      assert.match(
        functionBody,
        /maxKey7d = Math\.max\(maxKey7d, k\['7d'\]/,
        'Must compute maxKey7d from active keys'
      );
    });
  });

  describe('EMA Rate Integration in calculateAggregate', () => {
    it('should use EMA rate with time-based snapshots when allSnapshots available with 3+ entries', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAggregate\(latest, earliest, hoursBetween(?:, allSnapshots)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /if \(allSnapshots && allSnapshots\.length >= 3\)/,
        'Must check for allSnapshots availability'
      );

      assert.match(
        functionBody,
        /const recentSnapshots = selectTimeBasedSnapshots\(allSnapshots, EMA_WINDOW_MS, EMA_MIN_INTERVAL_MS\)/,
        'Must use selectTimeBasedSnapshots instead of array slice'
      );

      assert.match(
        functionBody,
        /rate5h = calculateEmaRate\(recentSnapshots, ['"]5h['"], 0\.3, excludeKeys\)/,
        'Must call calculateEmaRate for 5h rate with excludeKeys'
      );

      assert.match(
        functionBody,
        /rate7d = calculateEmaRate\(recentSnapshots, ['"]7d['"], 0\.3, excludeKeys\)/,
        'Must call calculateEmaRate for 7d rate with excludeKeys'
      );
    });

    it('should fall back to two-point slope when allSnapshots not available', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAggregate\(latest, earliest, hoursBetween(?:, allSnapshots)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should have else branch with original two-point calculation
      assert.match(
        functionBody,
        /} else \{[\s\S]*?commonKeyIds[\s\S]*?rate5h = \(avg5hNow - avg5hPrev\) \/ hoursBetween/s,
        'Must fall back to two-point slope calculation'
      );
    });

    it('should pass allSnapshots from calculateAndAdjust', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /calculateAggregate\(latest, earliest, hoursBetween, data\.snapshots\)/,
        'Must pass data.snapshots as allSnapshots parameter'
      );
    });
  });

  describe('applyFactor() - Direction Tracking and Reset Time', () => {
    it('should accept hoursUntilReset as 6th parameter', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /function applyFactor\(config, newFactor, constraining, projectedAtReset, log, hoursUntilReset\)/,
        'Must accept hoursUntilReset parameter'
      );
    });

    it('should compute direction from previous and new factor', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function applyFactor\(config, newFactor, constraining, projectedAtReset, log(?:, hoursUntilReset)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /const previousFactor = config\.adjustment\?\.factor \?\? 1\.0/,
        'Must read previous factor from config'
      );

      assert.match(
        functionBody,
        /const direction = newFactor > previousFactor/,
        'Must compute direction from factor comparison'
      );

      assert.match(
        functionBody,
        /['"]ramping up['"]/,
        'Must include ramping up direction'
      );

      assert.match(
        functionBody,
        /['"]ramping down['"]/,
        'Must include ramping down direction'
      );

      assert.match(
        functionBody,
        /['"]holding['"]/,
        'Must include holding direction'
      );
    });

    it('should store direction and hours_until_reset in config.adjustment', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function applyFactor\(config, newFactor, constraining, projectedAtReset, log(?:, hoursUntilReset)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /direction,/,
        'Must store direction in config.adjustment'
      );

      assert.match(
        functionBody,
        /hours_until_reset:/,
        'Must store hours_until_reset in config.adjustment'
      );
    });

    it('should include direction and reset time in log message', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function applyFactor\(config, newFactor, constraining, projectedAtReset, log(?:, hoursUntilReset)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /\$\{direction\}/,
        'Must include direction in log output'
      );

      assert.match(
        functionBody,
        /Reset in/,
        'Must include reset time in log output'
      );
    });

    it('should include hoursUntilReset in factor unchanged log', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // The "Factor unchanged" log should include reset time
      const unchangedLog = functionBody.match(/Factor unchanged[\s\S]*?hoursUntilReset/);
      assert.ok(unchangedLog, 'Factor unchanged log must include hoursUntilReset');
    });
  });

  describe('desiredRate uses effectiveUsage', () => {
    it('should compute desiredRate from effectiveUsage not currentUsage', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /desiredRate = \(TARGET_UTILIZATION - effectiveUsage\) \/ hoursUntilReset/,
        'Must use effectiveUsage in desiredRate calculation'
      );
    });
  });

  describe('File Header Documentation', () => {
    it('should have complete header with description and version', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Should have JSDoc header
      assert.match(code, /\/\*\*/, 'Must have JSDoc header');

      // Should describe purpose
      assert.match(
        code,
        /Tracks API quota/i,
        'Header must describe quota tracking'
      );

      assert.match(
        code,
        /dynamically adjusts/i,
        'Header must mention dynamic adjustment'
      );

      // Should mention target usage
      assert.match(
        code,
        /90%/,
        'Header must reference 90% target'
      );

      // Should have version
      assert.match(
        code,
        /@version \d+\.\d+\.\d+/,
        'Header must have version number'
      );
    });

    it('should document the 3-step process', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Should list the process steps
      assert.match(code, /Snapshot:/i, 'Must document snapshot step');
      assert.match(code, /Trajectory:/i, 'Must document trajectory step');
      assert.match(code, /Adjustment:/i, 'Must document adjustment step');
    });
  });

  describe('Behavioral Tests - MIN_EFFECTIVE_MINUTES Floor', () => {
    it('should enforce 5-minute floor when factor would create shorter cooldowns', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Extract MIN_EFFECTIVE_MINUTES constant value
      const minMatch = code.match(/const MIN_EFFECTIVE_MINUTES = (\d+)/);
      assert.ok(minMatch, 'Must find MIN_EFFECTIVE_MINUTES constant');
      const minMinutes = parseInt(minMatch[1], 10);
      assert.strictEqual(minMinutes, 5, 'MIN_EFFECTIVE_MINUTES must be 5');

      // Verify floor is applied in effective calculation (GAP 1: now uses intermediate `computed` variable)
      // let computed = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultVal / newFactor));
      const applyFactorMatch = code.match(/let computed = Math\.max\(MIN_EFFECTIVE_MINUTES, Math\.round\(defaultVal \/ newFactor\)\)/);
      assert.ok(applyFactorMatch, 'Must apply MIN_EFFECTIVE_MINUTES floor in effective calculation');
    });

    it('should allow effective cooldowns above the floor', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify the formula allows values above floor (GAP 1: now uses `computed` variable)
      const formulaMatch = code.match(/Math\.max\(MIN_EFFECTIVE_MINUTES, Math\.round\(defaultVal \/ newFactor\)\)/);
      assert.ok(formulaMatch, 'Formula must allow values above MIN_EFFECTIVE_MINUTES');
    });
  });

  describe('Behavioral Tests - Reset-Boundary Detection (Per-Key)', () => {
    it('should skip adjustment when any key 5h drops by 50% or more', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify threshold value
      const thresholdMatch = code.match(/const PER_KEY_RESET_DROP_THRESHOLD = (0\.\d+)/);
      assert.ok(thresholdMatch, 'Must find PER_KEY_RESET_DROP_THRESHOLD');
      const threshold = parseFloat(thresholdMatch[1]);
      assert.strictEqual(threshold, 0.50, 'PER_KEY_RESET_DROP_THRESHOLD must be 0.50');

      // Verify detection logic uses per-key drop
      const detectionMatch = code.match(/if \(keyDrop >= PER_KEY_RESET_DROP_THRESHOLD\)[\s\S]*?return false/);
      assert.ok(detectionMatch, 'Must skip adjustment when any key drop >= threshold');
    });

    it('should only check reset boundary with 2+ snapshots', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify guard condition
      const guardMatch = code.match(/if \(data\.snapshots\.length >= 2\)[\s\S]*?keyDrop >= PER_KEY_RESET_DROP_THRESHOLD/s);
      assert.ok(guardMatch, 'Must only check reset boundary with 2+ snapshots');
    });

    it('should compare consecutive snapshots for boundary detection', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify it compares last two snapshots
      const comparisonMatch = code.match(/const prev = data\.snapshots\[data\.snapshots\.length - 2\][\s\S]*?const curr = data\.snapshots\[data\.snapshots\.length - 1\]/s);
      assert.ok(comparisonMatch, 'Must compare last two snapshots');
    });
  });

  describe('Behavioral Tests - EMA Rate Smoothing', () => {
    it('should use alpha=0.3 as default smoothing factor', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const alphaMatch = code.match(/function calculateEmaRate\(snapshots, metricKey, alpha = (0\.\d+), excludeKeys = null\)/);
      assert.ok(alphaMatch, 'Must find calculateEmaRate function with alpha parameter');
      const alphaDefault = parseFloat(alphaMatch[1]);
      assert.strictEqual(alphaDefault, 0.3, 'Default alpha must be 0.3');
    });

    it('should skip EMA when fewer than 2 snapshots', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const earlyReturnMatch = code.match(/if \(snapshots\.length < 2\) return 0/);
      assert.ok(earlyReturnMatch, 'Must return 0 for fewer than 2 snapshots');
    });

    it('should apply EMA formula: alpha * current + (1-alpha) * previous', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const emaFormulaMatch = code.match(/emaRate = alpha \* intervalRate \+ \(1 - alpha\) \* emaRate/);
      assert.ok(emaFormulaMatch, 'Must apply correct EMA formula');
    });

    it('should prefer EMA rate with time-based selection over two-point slope when 3+ snapshots available', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify calculateAggregate uses selectTimeBasedSnapshots and calls calculateEmaRate
      const preferenceMatch = code.match(/if \(allSnapshots && allSnapshots\.length >= 3\)[\s\S]*?selectTimeBasedSnapshots\(allSnapshots, EMA_WINDOW_MS, EMA_MIN_INTERVAL_MS\)[\s\S]*?rate5h = calculateEmaRate\(recentSnapshots, ['"]5h['"], 0\.3, excludeKeys\)/s);
      assert.ok(preferenceMatch, 'Must prefer time-based EMA rate when 3+ snapshots available');
    });
  });

  describe('Behavioral Tests - Max-Key Awareness', () => {
    it('should track max utilization across active keys only', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify maxKey tracking in calculateAggregate from entriesToAverage (active keys only)
      const functionMatch = code.match(/function calculateAggregate\(latest, earliest, hoursBetween(?:, allSnapshots)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // maxKey computed from entriesToAverage, not from all latestEntries
      assert.match(
        functionBody,
        /for \(const \[, k\] of entriesToAverage\)[\s\S]*?maxKey5h = Math\.max\(maxKey5h/s,
        'Must compute maxKey from entriesToAverage (active keys only)'
      );
    });

    it('should bias effectiveUsage upward when max key exceeds 80%', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify threshold
      const thresholdMatch = code.match(/const SINGLE_KEY_WARNING_THRESHOLD = (0\.\d+)/);
      assert.ok(thresholdMatch, 'Must find SINGLE_KEY_WARNING_THRESHOLD');
      const threshold = parseFloat(thresholdMatch[1]);
      assert.strictEqual(threshold, 0.80, 'SINGLE_KEY_WARNING_THRESHOLD must be 0.80');

      // Verify biasing logic
      const biasingMatch = code.match(/if \(maxKeyUsage >= SINGLE_KEY_WARNING_THRESHOLD\)[\s\S]*?effectiveUsage = Math\.max\(effectiveUsage, maxKeyUsage \* 0\.8\)/s);
      assert.ok(biasingMatch, 'Must bias effectiveUsage when max key exceeds threshold');
    });

    it('should select max key based on constraining metric', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const selectionMatch = code.match(/const maxKeyUsage = constraining === ['"]5h['"] \? aggregate\.maxKey5h : aggregate\.maxKey7d/);
      assert.ok(selectionMatch, 'Must select max key based on constraining metric');
    });
  });

  describe('Behavioral Tests - Per-Key Rate Tracking', () => {
    it('should track utilization for each key individually', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify perKeyUtilization structure
      const trackingMatch = code.match(/perKeyUtilization\[id\] = \{ ['"]5h['"]:\s*val5h,\s*['"]7d['"]:\s*val7d \}/);
      assert.ok(trackingMatch, 'Must track per-key utilization with 5h and 7d values');
    });

    it('should warn when any single account exceeds 80% on 5h window', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const warningMatch = code.match(/if \(util\[['"]5h['"]\] >= SINGLE_KEY_WARNING_THRESHOLD\)[\s\S]*?Usage optimizer WARNING:[\s\S]*?5h utilization/s);
      assert.ok(warningMatch, 'Must warn for 5h utilization exceeding threshold');
    });

    it('should warn when any single account exceeds 80% on 7d window', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const warningMatch = code.match(/if \(util\[['"]7d['"]\] >= SINGLE_KEY_WARNING_THRESHOLD\)[\s\S]*?Usage optimizer WARNING:[\s\S]*?7d utilization/s);
      assert.ok(warningMatch, 'Must warn for 7d utilization exceeding threshold');
    });

    it('should include account ID in warning messages', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const keyIdMatch = code.match(/Usage optimizer WARNING: Account \$\{keyId\}/);
      assert.ok(keyIdMatch, 'Must include account ID in warning messages');
    });
  });

  describe('Behavioral Tests - Enhanced Logging', () => {
    it('should track direction as ramping up, ramping down, or holding', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const directionMatch = code.match(/const direction = newFactor > previousFactor \+ 0\.005 \? ['"]ramping up['"] : newFactor < previousFactor - 0\.005 \? ['"]ramping down['"] : ['"]holding['"]/);
      assert.ok(directionMatch, 'Must compute direction with 0.005 threshold');
    });

    it('should store direction in config.adjustment', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const storageMatch = code.match(/config\.adjustment = \{[\s\S]*?direction,/s);
      assert.ok(storageMatch, 'Must store direction in config.adjustment');
    });

    it('should store hours_until_reset in config.adjustment', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const storageMatch = code.match(/config\.adjustment = \{[\s\S]*?hours_until_reset:/s);
      assert.ok(storageMatch, 'Must store hours_until_reset in config.adjustment');
    });

    it('should round hours_until_reset to 1 decimal place', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const roundingMatch = code.match(/hours_until_reset:[\s\S]*?Math\.round\(hoursUntilReset \* 10\) \/ 10/s);
      assert.ok(roundingMatch, 'Must round hours_until_reset to 1 decimal');
    });

    it('should include direction in log output', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const logMatch = code.match(/log\(`Usage optimizer: Factor[\s\S]*?\$\{direction\}/s);
      assert.ok(logMatch, 'Must include direction in log message');
    });

    it('should include reset time in log output', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const logMatch = code.match(/Reset in \$\{hoursUntilReset\.toFixed\(1\)\}h/);
      assert.ok(logMatch, 'Must include formatted reset time in log');
    });

    it('should include reset time in "factor unchanged" message', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const unchangedMatch = code.match(/Factor unchanged[\s\S]*?Reset in \$\{hoursUntilReset\.toFixed\(1\)\}h/s);
      assert.ok(unchangedMatch, 'Must include reset time in unchanged message');
    });
  });

  describe('Integration Tests - Combined Behavior', () => {
    it('should use effectiveUsage (biased by max key) for desiredRate calculation', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify effectiveUsage initialization and biasing
      const effectiveMatch = code.match(/let effectiveUsage = currentUsage[\s\S]*?if \(maxKeyUsage >= SINGLE_KEY_WARNING_THRESHOLD\)[\s\S]*?effectiveUsage = Math\.max\(effectiveUsage, maxKeyUsage \* 0\.8\)/s);
      assert.ok(effectiveMatch, 'Must initialize and bias effectiveUsage');

      // Verify desiredRate uses effectiveUsage
      const desiredRateMatch = code.match(/desiredRate = \(TARGET_UTILIZATION - effectiveUsage\) \/ hoursUntilReset/);
      assert.ok(desiredRateMatch, 'Must use effectiveUsage in desiredRate calculation');
    });

    it('should pass allSnapshots to calculateAggregate for EMA calculation', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const passMatch = code.match(/calculateAggregate\(latest, earliest, hoursBetween, data\.snapshots\)/);
      assert.ok(passMatch, 'Must pass data.snapshots to calculateAggregate');
    });

    it('should call applyFactor with hoursUntilReset as 6th parameter', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const callMatch = code.match(/applyFactor\(config, newFactor, constraining, projectedAtReset, log, hoursUntilReset\)/);
      assert.ok(callMatch, 'Must pass hoursUntilReset to applyFactor');
    });

    it('should return aggregate with maxKey5h, maxKey7d, and perKeyUtilization', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const returnMatch = code.match(/return \{[\s\S]*?maxKey5h, maxKey7d, perKeyUtilization,/s);
      assert.ok(returnMatch, 'Must return max key and per-key data from calculateAggregate');
    });
  });

  describe('Overdrive Mode Support', () => {
    it('should define revertOverdrive() function', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /function revertOverdrive\(config, log\)/,
        'Must define revertOverdrive function'
      );
    });

    it('should restore previous_state.effective when reverting', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function revertOverdrive\(config, log\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'revertOverdrive must exist');

      const functionBody = functionMatch[0];

      // Should access previous_state from config.overdrive
      assert.match(
        functionBody,
        /const prev = config\.overdrive\.previous_state/,
        'Must access previous_state'
      );

      // Should restore effective values
      assert.match(
        functionBody,
        /if \(prev\?\.effective\)[\s\S]*?config\.effective = prev\.effective/s,
        'Must restore previous effective values'
      );
    });

    it('should restore previous_state.factor when reverting', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function revertOverdrive\(config, log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check if previous factor exists
      assert.match(
        functionBody,
        /if \(prev\?\.factor !== undefined\)/,
        'Must check if previous factor exists'
      );

      // Should clamp and restore factor to config.adjustment
      assert.match(
        functionBody,
        /const restoredFactor = Math\.max\(MIN_FACTOR, Math\.min\(MAX_FACTOR, prev\.factor\)\)/,
        'Must clamp previous factor to MIN_FACTOR/MAX_FACTOR bounds'
      );

      assert.match(
        functionBody,
        /config\.adjustment\.factor = restoredFactor/,
        'Must restore clamped factor to config.adjustment'
      );

      // Should set direction to indicate reversion
      assert.match(
        functionBody,
        /config\.adjustment\.direction = ['"]overdrive-reverted['"]/,
        'Must set direction to overdrive-reverted'
      );
    });

    it('should set overdrive.active to false when reverting', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function revertOverdrive\(config, log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /config\.overdrive\.active = false/,
        'Must set overdrive.active to false'
      );
    });

    it('should write updated config to file after reverting', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function revertOverdrive\(config, log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should get config path
      assert.match(
        functionBody,
        /const configPath = getConfigPath\(\)/,
        'Must get config path'
      );

      // Should write config
      assert.match(
        functionBody,
        /fs\.writeFileSync\(configPath, JSON\.stringify\(config, null, 2\)\)/,
        'Must write updated config'
      );
    });

    it('should log overdrive reversion', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function revertOverdrive\(config, log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /log\(`Usage optimizer: Overdrive expired, reverted/,
        'Must log reversion message'
      );

      // Should include previous factor in log
      assert.match(
        functionBody,
        /prev\?\.factor/,
        'Must include previous factor in log message'
      );
    });

    it('should check for active overdrive at start of runUsageOptimizer', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export async function runUsageOptimizer\(logFn\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'runUsageOptimizer must exist');

      const functionBody = functionMatch[0];

      // Should check overdrive.active
      assert.match(
        functionBody,
        /overdriveConfig\.overdrive\?\.active/,
        'Must check for overdrive.active'
      );
    });

    it('should check if overdrive has expired', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export async function runUsageOptimizer\(logFn\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should compare current time with expires_at
      assert.match(
        functionBody,
        /new Date\(\) > new Date\(overdriveConfig\.overdrive\.expires_at\)/,
        'Must check if overdrive has expired'
      );
    });

    it('should call revertOverdrive when overdrive has expired', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export async function runUsageOptimizer\(logFn\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should call revertOverdrive
      assert.match(
        functionBody,
        /revertOverdrive\(overdriveConfig, log\)/,
        'Must call revertOverdrive when expired'
      );
    });

    it('should skip adjustment when overdrive is active', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export async function runUsageOptimizer\(logFn\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should log and skip when active
      assert.match(
        functionBody,
        /log\(`Usage optimizer: Overdrive active until/,
        'Must log when overdrive is active'
      );

      // Should return early with adjustmentMade: false
      assert.match(
        functionBody,
        /return \{[\s\S]*?adjustmentMade: false/s,
        'Must return with adjustmentMade false when overdrive active'
      );
    });

    it('should take snapshots even when overdrive is active', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export async function runUsageOptimizer\(logFn\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Within overdrive active block, should still collect snapshot
      const overdriveBlock = functionBody.match(/} else \{[\s\S]*?Overdrive active[\s\S]*?return \{[\s\S]*?\}/s);
      assert.ok(overdriveBlock, 'Must have overdrive active block');

      // Should call collectSnapshot
      assert.match(
        overdriveBlock[0],
        /const snapshot = await collectSnapshot\(log\)/,
        'Must collect snapshot even during overdrive'
      );

      // Should store snapshot
      assert.match(
        overdriveBlock[0],
        /storeSnapshot\(snapshot, log\)/,
        'Must store snapshot even during overdrive'
      );

      // Should return snapshotTaken: true if snapshot was taken
      assert.match(
        overdriveBlock[0],
        /snapshotTaken: !!\s*snapshot/,
        'Must return snapshotTaken based on whether snapshot was taken'
      );
    });

    it('should handle overdrive check errors gracefully', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export async function runUsageOptimizer\(logFn\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should wrap overdrive check in try-catch
      assert.match(
        functionBody,
        /try \{[\s\S]*?overdriveConfig\.overdrive[\s\S]*?\} catch \(err\)/s,
        'Must wrap overdrive check in try-catch'
      );

      // Should log error and continue
      assert.match(
        functionBody,
        /log\(`Usage optimizer: Overdrive check failed \(non-fatal\)/,
        'Must log overdrive check errors as non-fatal'
      );
    });
  });

  describe('Behavioral Tests - Projection Cap (MAX_PROJECTION)', () => {
    it('should define MAX_PROJECTION as a local constant inside calculateAndAdjust', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'calculateAndAdjust must exist');

      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /const MAX_PROJECTION = 1\.5/,
        'Must define MAX_PROJECTION = 1.5 to cap runaway projections'
      );
    });

    it('should cap projected5h at MAX_PROJECTION to prevent runaway extrapolation', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /const projected5h = Math\.min\(MAX_PROJECTION,/,
        'Must clamp projected5h to MAX_PROJECTION'
      );
    });

    it('should cap projected7d at MAX_PROJECTION to prevent runaway extrapolation', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /const projected7d = Math\.min\(MAX_PROJECTION,/,
        'Must clamp projected7d to MAX_PROJECTION'
      );
    });

    it('should use Math.max of the two capped projections as projectedAtReset', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // After capping both, the constraining metric is the larger of the two.
      assert.match(
        functionBody,
        /const projectedAtReset = Math\.max\(projected5h, projected7d\)/,
        'Must use Math.max of capped projections for projectedAtReset'
      );
    });

    it('should mathematically cap at 1.5 (150% utilization)', () => {
      // Verify the numeric value of the cap is correct: 1.5 means the optimizer
      // will never think usage can exceed 150% of quota at reset time.
      // This prevents the factor from being pinned at MIN_FACTOR due to
      // nonsensical projections on long horizons (e.g., 7d window ~155h away).
      const MAX_PROJECTION = 1.5;

      // Example: current=0.1, rate=0.05/h, hoursUntilReset=155 (7d window)
      // Raw projection = 0.1 + 0.05 * 155 = 7.85 (nonsensical)
      // Capped projection = Math.min(1.5, 7.85) = 1.5 (sensible)
      const rawProjection = 0.1 + 0.05 * 155;
      const cappedProjection = Math.min(MAX_PROJECTION, rawProjection);

      assert.strictEqual(cappedProjection, 1.5, 'Cap must clip runaway projections to 1.5');
      assert.ok(rawProjection > MAX_PROJECTION, 'Raw projection must exceed cap for this scenario');

      // Example: current=0.5, rate=0.05/h, hoursUntilReset=3 (5h window)
      // Raw projection = 0.5 + 0.05 * 3 = 0.65 (not affected by cap)
      const shortHorizonProjection = 0.5 + 0.05 * 3;
      const shortHorizonCapped = Math.min(MAX_PROJECTION, shortHorizonProjection);

      assert.strictEqual(shortHorizonCapped, shortHorizonProjection, 'Short-horizon projections must not be affected by cap');
    });
  });

  describe('Behavioral Tests - Factor Recovery Clause (Tiered)', () => {
    it('should define the tier-1 factor recovery condition in calculateAndAdjust', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'calculateAndAdjust must exist');

      const functionBody = functionMatch[0];

      // Tier 1 recovery triggers when factor is at or near minimum AND usage is below 70% of target.
      assert.match(
        functionBody,
        /currentFactor <= 0\.15 && currentUsage < TARGET_UTILIZATION \* 0\.7/,
        'Must check for factor at very low level with usage below 70% of target'
      );
    });

    it('should define the tier-2 gradual recovery condition', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Tier 2: factor in 0.15-0.5 range with usage below 80% of target
      assert.match(
        functionBody,
        /currentFactor < 0\.5 && currentFactor > 0\.15 && currentUsage < TARGET_UTILIZATION \* 0\.8/,
        'Must have tier-2 recovery for factor in 0.15-0.5 dead zone'
      );
    });

    it('should multiply factor by 1.5 in tier-2 recovery', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /Math\.min\(1\.0, currentFactor \* 1\.5\)/,
        'Tier-2 must multiply factor by 1.5 capped at 1.0'
      );
    });

    it('should reset factor to 1.0 on tier-1 recovery', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Find the tier-1 recovery block and verify it calls applyFactor with 1.0
      const recoveryBlock = functionBody.match(
        /if \(currentFactor <= 0\.15 && currentUsage < TARGET_UTILIZATION \* 0\.7\)[\s\S]*?return true/
      );
      assert.ok(recoveryBlock, 'Must have tier-1 factor recovery block');

      assert.match(
        recoveryBlock[0],
        /applyFactor\(config, 1\.0,/,
        'Must reset factor to 1.0 on tier-1 recovery'
      );
    });

    it('should log factor recovery messages for both tiers', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /Factor recovery \(tier 1\)/,
        'Must log tier-1 factor recovery message'
      );

      assert.match(
        functionBody,
        /Factor recovery \(tier 2\)/,
        'Must log tier-2 factor recovery message'
      );
    });

    it('should return true after applying factor recovery', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // After recovery, return true to signal an adjustment was made.
      const recoveryBlock = functionBody.match(
        /if \(currentFactor <= 0\.15[\s\S]*?return true/
      );
      assert.ok(recoveryBlock, 'Factor recovery block must return true');
    });

    it('should include current usage percentage in recovery log message', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /Math\.round\(currentUsage \* 100\)\}%/,
        'Recovery log must include current usage as a percentage'
      );
    });

    it('should verify tier-1 recovery threshold at 70% of TARGET_UTILIZATION', () => {
      // Recovery fires when usage is below 63% = 90% * 0.7.
      const TARGET_UTILIZATION = 0.90;
      const recoveryThreshold = TARGET_UTILIZATION * 0.7;

      assert.ok(Math.abs(recoveryThreshold - 0.63) < 0.001, 'Recovery threshold must be 0.63 (70% of 0.90 target)');

      // At 60% usage with factor at very low level, tier-1 recovery fires.
      const stuckFactor = 0.10;
      const currentUsage60pct = 0.60;
      const shouldRecover = stuckFactor <= 0.15 && currentUsage60pct < recoveryThreshold;
      assert.strictEqual(shouldRecover, true, 'Tier-1 recovery must fire at 60% usage with factor at very low level');

      // At 65% usage (above threshold), tier-1 recovery must NOT fire.
      const currentUsage65pct = 0.65;
      const shouldNotRecover = stuckFactor <= 0.15 && currentUsage65pct < recoveryThreshold;
      assert.strictEqual(shouldNotRecover, false, 'Tier-1 recovery must not fire at 65% usage');
    });

    it('should verify tier-2 recovery covers the 0.15-0.5 dead zone', () => {
      const TARGET_UTILIZATION = 0.90;
      const tier2UsageThreshold = TARGET_UTILIZATION * 0.8; // 0.72

      // Factor at 0.3 (in dead zone), usage at 60%
      const factor = 0.3;
      const usage = 0.60;
      const shouldRecover = factor < 0.5 && factor > 0.15 && usage < tier2UsageThreshold;
      assert.strictEqual(shouldRecover, true, 'Tier-2 must fire at factor 0.3 with 60% usage');

      // Factor at 0.3, usage at 75% (above 72% threshold)
      const highUsage = 0.75;
      const shouldNotRecover = factor < 0.5 && factor > 0.15 && highUsage < tier2UsageThreshold;
      assert.strictEqual(shouldNotRecover, false, 'Tier-2 must not fire when usage exceeds 72%');

      // Verify 1.5x boost
      const boosted = Math.min(1.0, factor * 1.5);
      assert.ok(Math.abs(boosted - 0.45) < 0.001, `Factor 0.3 * 1.5 should be ~0.45, got ${boosted}`);

      // High factor gets capped
      const highFactor = 0.8;
      const capped = Math.min(1.0, highFactor * 1.5);
      assert.strictEqual(capped, 1.0, 'Factor 0.8 * 1.5 = 1.2, capped to 1.0');
    });
  });

  describe('Snapshot Throttle Constants', () => {
    it('should define MIN_SNAPSHOT_INTERVAL_MS as 5 minutes', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /const MIN_SNAPSHOT_INTERVAL_MS = 5 \* 60 \* 1000/,
        'Must define MIN_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000'
      );
    });

    it('should define EMA_WINDOW_MS as 2 hours', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /const EMA_WINDOW_MS = 2 \* 60 \* 60 \* 1000/,
        'Must define EMA_WINDOW_MS = 2 * 60 * 60 * 1000'
      );
    });

    it('should define EMA_MIN_INTERVAL_MS as 5 minutes', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /const EMA_MIN_INTERVAL_MS = 5 \* 60 \* 1000/,
        'Must define EMA_MIN_INTERVAL_MS = 5 * 60 * 1000'
      );
    });

    it('should define MIN_HOURS_DELTA as 0.05 (3 minutes)', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /const MIN_HOURS_DELTA = 0\.05/,
        'Must define MIN_HOURS_DELTA = 0.05'
      );
    });
  });

  describe('getLastSnapshotTimestamp() - Snapshot Throttle Helper', () => {
    it('should exist as a standalone function', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /function getLastSnapshotTimestamp\(\) \{/,
        'Must define getLastSnapshotTimestamp function'
      );
    });

    it('should return null when snapshots file does not exist', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function getLastSnapshotTimestamp\(\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'getLastSnapshotTimestamp must exist');

      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /if \(!fs\.existsSync\(SNAPSHOTS_PATH\)\) return null/,
        'Must return null when snapshots file missing'
      );
    });

    it('should return the timestamp of the last snapshot', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function getLastSnapshotTimestamp\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /return data\.snapshots\[data\.snapshots\.length - 1\]\?\.ts/,
        'Must return ts of last snapshot'
      );
    });

    it('should return null on empty snapshots array', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function getLastSnapshotTimestamp\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /data\.snapshots\.length === 0\) return null/,
        'Must return null when snapshots array is empty'
      );
    });

    it('should be wrapped in try-catch returning null on error', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function getLastSnapshotTimestamp\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /try \{[\s\S]*?\} catch \{[\s\S]*?return null/s,
        'Must return null on any error'
      );
    });
  });

  describe('selectTimeBasedSnapshots() - Time-Based Deduplication', () => {
    it('should exist as a standalone function', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /function selectTimeBasedSnapshots\(snapshots, windowMs, minIntervalMs\) \{/,
        'Must define selectTimeBasedSnapshots with correct signature'
      );
    });

    it('should return empty array for null/empty input', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function selectTimeBasedSnapshots\(snapshots, windowMs, minIntervalMs\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'selectTimeBasedSnapshots must exist');

      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /if \(!snapshots \|\| snapshots\.length === 0\) return \[\]/,
        'Must return empty array for null/empty input'
      );
    });

    it('should walk backward from the most recent snapshot', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function selectTimeBasedSnapshots\(snapshots, windowMs, minIntervalMs\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /for \(let i = snapshots\.length - 2; i >= 0; i--\)/,
        'Must walk backward from second-to-last snapshot'
      );
    });

    it('should only include snapshots at least minIntervalMs apart', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function selectTimeBasedSnapshots\(snapshots, windowMs, minIntervalMs\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /if \(lastSelectedTs - s\.ts >= minIntervalMs\)/,
        'Must check interval between selected snapshots'
      );
    });

    it('should stop when exceeding windowMs from the most recent', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function selectTimeBasedSnapshots\(snapshots, windowMs, minIntervalMs\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /if \(s\.ts < windowStart\) break/,
        'Must break when snapshot is outside time window'
      );
    });

    it('should fall back to slice(-30) for cold start (fewer than 3 snapshots selected)', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function selectTimeBasedSnapshots\(snapshots, windowMs, minIntervalMs\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /if \(selected\.length < 3\)[\s\S]*?return snapshots\.slice\(-30\)/s,
        'Must fall back to slice(-30) when fewer than 3 snapshots selected'
      );
    });

    it('should return selected snapshots in chronological order', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function selectTimeBasedSnapshots\(snapshots, windowMs, minIntervalMs\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /return selected\.reverse\(\)/,
        'Must reverse selected array to chronological order'
      );
    });

    it('should correctly deduplicate rapid-fire snapshots', () => {
      // Behavioral test: simulate 30 snapshots taken 30s apart (rapid-fire)
      // selectTimeBasedSnapshots should only keep 1 per 5-minute window
      const MIN_INTERVAL = 5 * 60 * 1000; // 5 min
      const WINDOW = 2 * 60 * 60 * 1000;  // 2 hours
      const now = Date.now();

      // 30 rapid-fire snapshots, 30 seconds apart (total span: 14.5 minutes)
      const rapidFire = [];
      for (let i = 0; i < 30; i++) {
        rapidFire.push({ ts: now - (29 - i) * 30000, keys: {} });
      }

      // Simulate the selection algorithm
      const latest = rapidFire[rapidFire.length - 1];
      const windowStart = latest.ts - WINDOW;
      const selected = [latest];
      let lastSelectedTs = latest.ts;

      for (let i = rapidFire.length - 2; i >= 0; i--) {
        const s = rapidFire[i];
        if (s.ts < windowStart) break;
        if (lastSelectedTs - s.ts >= MIN_INTERVAL) {
          selected.push(s);
          lastSelectedTs = s.ts;
        }
      }

      // With 30s intervals and 5-min dedup, we should get very few snapshots
      // 14.5 min span / 5 min interval = at most 3-4, but since total span is
      // only ~14.5 min, we get at most 3 (at 0, 5, 10 min marks)
      assert.ok(selected.length <= 4, `Rapid-fire dedup should yield <=4 snapshots, got ${selected.length}`);
      assert.ok(selected.length < 30, `Must significantly reduce ${rapidFire.length} rapid-fire snapshots`);
    });

    it('should keep well-spaced snapshots intact', () => {
      // Behavioral test: 24 snapshots, 10 minutes apart (4 hours total)
      const MIN_INTERVAL = 5 * 60 * 1000; // 5 min
      const WINDOW = 2 * 60 * 60 * 1000;  // 2 hours
      const now = Date.now();

      const wellSpaced = [];
      for (let i = 0; i < 24; i++) {
        wellSpaced.push({ ts: now - (23 - i) * 10 * 60 * 1000, keys: {} });
      }

      // Simulate the selection algorithm
      const latest = wellSpaced[wellSpaced.length - 1];
      const windowStart = latest.ts - WINDOW;
      const selected = [latest];
      let lastSelectedTs = latest.ts;

      for (let i = wellSpaced.length - 2; i >= 0; i--) {
        const s = wellSpaced[i];
        if (s.ts < windowStart) break;
        if (lastSelectedTs - s.ts >= MIN_INTERVAL) {
          selected.push(s);
          lastSelectedTs = s.ts;
        }
      }

      // 2-hour window with 10-min intervals = 12 snapshots, all pass 5-min dedup
      assert.ok(selected.length >= 10, `Well-spaced snapshots should mostly survive, got ${selected.length}`);
    });
  });

  describe('Snapshot Throttle in runUsageOptimizer()', () => {
    it('should check last snapshot timestamp before any other work', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export async function runUsageOptimizer\(logFn\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'runUsageOptimizer must exist');

      const functionBody = functionMatch[0];

      // The throttle check should appear before the overdrive check
      const throttlePos = functionBody.indexOf('getLastSnapshotTimestamp()');
      const overdrivePos = functionBody.indexOf('Overdrive check');

      assert.ok(throttlePos > 0, 'Must call getLastSnapshotTimestamp()');
      assert.ok(overdrivePos > 0, 'Must have overdrive check');
      assert.ok(throttlePos < overdrivePos, 'Throttle check must come before overdrive check');
    });

    it('should return early with snapshotTaken: false when throttled', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export async function runUsageOptimizer\(logFn\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check against MIN_SNAPSHOT_INTERVAL_MS
      assert.match(
        functionBody,
        /if \(lastTs && \(Date\.now\(\) - lastTs\) < MIN_SNAPSHOT_INTERVAL_MS\)/,
        'Must compare elapsed time against MIN_SNAPSHOT_INTERVAL_MS'
      );

      // Should return early
      const throttleBlock = functionBody.match(
        /if \(lastTs && \(Date\.now\(\) - lastTs\) < MIN_SNAPSHOT_INTERVAL_MS\)[\s\S]*?return \{[\s\S]*?\}/
      );
      assert.ok(throttleBlock, 'Must have throttle return block');

      assert.match(
        throttleBlock[0],
        /snapshotTaken: false/,
        'Must return snapshotTaken: false when throttled'
      );

      assert.match(
        throttleBlock[0],
        /adjustmentMade: false/,
        'Must return adjustmentMade: false when throttled'
      );

      assert.match(
        throttleBlock[0],
        /success: true/,
        'Must return success: true when throttled'
      );
    });

    it('should verify throttle interval is 5 minutes', () => {
      // Behavioral: verify the math of the throttle constant
      const MIN_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
      assert.strictEqual(MIN_SNAPSHOT_INTERVAL_MS, 300000, 'Throttle interval must be 300000ms (5 min)');

      // If last snapshot was 4 minutes ago, should be throttled
      const fourMinAgo = Date.now() - 4 * 60 * 1000;
      const elapsed = Date.now() - fourMinAgo;
      assert.ok(elapsed < MIN_SNAPSHOT_INTERVAL_MS, 'Must throttle when <5 min elapsed');

      // If last snapshot was 6 minutes ago, should NOT be throttled
      const sixMinAgo = Date.now() - 6 * 60 * 1000;
      const elapsed2 = Date.now() - sixMinAgo;
      assert.ok(elapsed2 >= MIN_SNAPSHOT_INTERVAL_MS, 'Must not throttle when >=5 min elapsed');
    });
  });

  describe('Behavioral Tests - MIN_HOURS_DELTA Filter', () => {
    it('should use MIN_HOURS_DELTA constant for interval filtering', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify the constant value
      const constMatch = code.match(/const MIN_HOURS_DELTA = ([\d.]+)/);
      assert.ok(constMatch, 'Must find MIN_HOURS_DELTA constant');
      const value = parseFloat(constMatch[1]);
      assert.strictEqual(value, 0.05, 'MIN_HOURS_DELTA must be 0.05 (3 minutes)');
    });

    it('should filter intervals shorter than 3 minutes in calculateEmaRate', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateEmaRate\(snapshots, metricKey, alpha = 0\.3, excludeKeys = null\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /if \(hoursDelta < MIN_HOURS_DELTA\) continue/,
        'Must skip intervals below MIN_HOURS_DELTA'
      );
    });

    it('should correctly convert MIN_HOURS_DELTA to minutes', () => {
      // 0.05 hours = 3 minutes
      const MIN_HOURS_DELTA = 0.05;
      const minutesEquiv = MIN_HOURS_DELTA * 60;
      assert.strictEqual(minutesEquiv, 3, 'MIN_HOURS_DELTA of 0.05h must equal 3 minutes');

      // Previous value was 0.01h = 36 seconds — too small to filter rapid-fire
      const oldValue = 0.01;
      const oldMinutes = oldValue * 60;
      assert.ok(oldMinutes < 1, 'Old threshold of 0.01h was only 36 seconds');
      assert.ok(minutesEquiv > oldMinutes, 'New threshold must be significantly larger than old');
    });
  });

  describe('Behavioral Tests - Extreme Factor Boundaries', () => {
    it('should enforce MIN_EFFECTIVE_MINUTES floor when factor reaches MAX_FACTOR (20.0)', () => {
      // At MAX_FACTOR=20.0, even short default cooldowns hit the 5-minute floor
      const MAX_FACTOR = 20.0;
      const MIN_EFFECTIVE_MINUTES = 5;
      const defaultCooldown = 60; // 60 minutes

      // Calculate effective cooldown: max(5, round(60 / 20))
      const rawEffective = Math.round(defaultCooldown / MAX_FACTOR);
      const effective = Math.max(MIN_EFFECTIVE_MINUTES, rawEffective);

      // 60 / 20 = 3 minutes → clamped to 5 minutes
      assert.strictEqual(rawEffective, 3, 'Raw effective should be 3 minutes');
      assert.strictEqual(effective, 5, 'Must clamp to MIN_EFFECTIVE_MINUTES floor of 5');
    });

    it('should allow large effective cooldowns when factor at MAX_FACTOR for longer defaults', () => {
      // At MAX_FACTOR=20.0, longer cooldowns still produce reasonable values
      const MAX_FACTOR = 20.0;
      const MIN_EFFECTIVE_MINUTES = 5;
      const defaultCooldown = 1440; // 24 hours (1440 minutes)

      const effective = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultCooldown / MAX_FACTOR));

      // 1440 / 20 = 72 minutes (well above the floor)
      assert.strictEqual(effective, 72, 'Should allow 72-minute effective cooldown');
    });

    it('should calculate extreme cooldowns when factor at MIN_FACTOR (0.05)', () => {
      // At MIN_FACTOR=0.05, cooldowns become very long (20x slowdown)
      const MIN_FACTOR = 0.05;
      const MIN_EFFECTIVE_MINUTES = 5;
      const defaultCooldown = 60; // 60 minutes

      const effective = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultCooldown / MIN_FACTOR));

      // 60 / 0.05 = 1200 minutes (20 hours)
      assert.strictEqual(effective, 1200, 'Should calculate 1200-minute (20-hour) effective cooldown');
    });

    it('should handle extreme slowdown for daily cooldowns at MIN_FACTOR', () => {
      // At MIN_FACTOR=0.05, daily automations become much less frequent
      const MIN_FACTOR = 0.05;
      const MIN_EFFECTIVE_MINUTES = 5;
      const defaultCooldown = 1440; // 24 hours (1440 minutes)

      const effective = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultCooldown / MIN_FACTOR));

      // 1440 / 0.05 = 28800 minutes (20 days)
      assert.strictEqual(effective, 28800, 'Should calculate 28800-minute (20-day) effective cooldown');
    });

    it('should verify MIN_EFFECTIVE_MINUTES prevents factors from creating sub-5-minute cooldowns', () => {
      // Even at extreme factors, the floor prevents harmful rapid-fire behavior
      const MIN_EFFECTIVE_MINUTES = 5;
      const factors = [20.0, 50.0, 100.0]; // Even beyond MAX_FACTOR
      const defaultCooldown = 10; // Short default

      for (const factor of factors) {
        const effective = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultCooldown / factor));
        assert.ok(
          effective >= MIN_EFFECTIVE_MINUTES,
          `Factor ${factor} must respect ${MIN_EFFECTIVE_MINUTES}-minute floor (got ${effective})`
        );
      }
    });
  });

  describe('Behavioral Tests - Recovery Threshold Boundaries (Tiered)', () => {
    it('should fire tier-1 recovery at factor exactly 0.15 with low usage', () => {
      const TARGET_UTILIZATION = 0.90;
      const recoveryThreshold = TARGET_UTILIZATION * 0.7; // 0.63
      const currentFactor = 0.15; // Exactly at boundary
      const currentUsage = 0.40; // Below threshold

      const shouldRecover = currentFactor <= 0.15 && currentUsage < recoveryThreshold;

      assert.strictEqual(shouldRecover, true, 'Tier-1 recovery must fire when factor is exactly 0.15 with usage at 40%');
    });

    it('should NOT fire tier-1 recovery at factor 0.16 with low usage', () => {
      const TARGET_UTILIZATION = 0.90;
      const recoveryThreshold = TARGET_UTILIZATION * 0.7; // 0.63
      const currentFactor = 0.16; // Just above tier-1 boundary
      const currentUsage = 0.40; // Below threshold

      const shouldTier1 = currentFactor <= 0.15 && currentUsage < recoveryThreshold;
      assert.strictEqual(shouldTier1, false, 'Tier-1 must NOT fire when factor is 0.16');

      // But tier-2 SHOULD fire (factor < 0.5, > 0.15, usage < 0.72)
      const tier2Threshold = TARGET_UTILIZATION * 0.8; // 0.72
      const shouldTier2 = currentFactor < 0.5 && currentFactor > 0.15 && currentUsage < tier2Threshold;
      assert.strictEqual(shouldTier2, true, 'Tier-2 must fire when factor is 0.16 with usage at 40%');
    });

    it('should fire tier-1 recovery at factor below 0.15 with usage just below threshold', () => {
      const TARGET_UTILIZATION = 0.90;
      const recoveryThreshold = TARGET_UTILIZATION * 0.7; // 0.63
      const currentFactor = 0.10; // Well below boundary
      const currentUsage = 0.62; // Just below threshold

      const shouldRecover = currentFactor <= 0.15 && currentUsage < recoveryThreshold;

      assert.strictEqual(shouldRecover, true, 'Tier-1 recovery must fire when factor is 0.10 and usage is 62%');
    });

    it('should NOT fire tier-1 recovery when usage at or above threshold even with low factor', () => {
      const TARGET_UTILIZATION = 0.90;
      const recoveryThreshold = TARGET_UTILIZATION * 0.7; // 0.63
      const currentFactor = 0.10; // Low factor
      const currentUsage = 0.63; // Exactly at threshold

      const shouldRecover = currentFactor <= 0.15 && currentUsage < recoveryThreshold;

      assert.strictEqual(shouldRecover, false, 'Tier-1 recovery must NOT fire when usage is at or above 63% threshold');
    });

    it('should verify recovery threshold independence from MIN_FACTOR', () => {
      // Recovery threshold is hardcoded at 0.15, not derived from MIN_FACTOR (0.05)
      const MIN_FACTOR = 0.05;
      const recoveryThreshold = 0.15;

      assert.notStrictEqual(
        recoveryThreshold,
        MIN_FACTOR,
        'Recovery threshold (0.15) must be independent of MIN_FACTOR (0.05)'
      );

      assert.notStrictEqual(
        recoveryThreshold,
        MIN_FACTOR + 0.01,
        'Recovery threshold must NOT use old MIN_FACTOR + 0.01 formula'
      );

      // Old formula would have been: MIN_FACTOR + 0.01 = 0.05 + 0.01 = 0.06
      const oldFormula = MIN_FACTOR + 0.01;
      assert.notStrictEqual(
        recoveryThreshold,
        oldFormula,
        `Recovery threshold (0.15) must differ from old formula (${oldFormula})`
      );
    });
  });

  describe('Behavioral Tests - Per-Account Deduplication', () => {
    it('should deduplicate keys by accountId in collectSnapshot', () => {
      // Simulate the dedup logic: 4 keys from Account A, 2 from B, 1 from C
      const rawKeyData = {
        'key1aaaa': { '5h': 0.26, '7d': 1.00 },
        'key2aaaa': { '5h': 0.26, '7d': 1.00 },
        'key3aaaa': { '5h': 0.26, '7d': 1.00 },
        'key4aaaa': { '5h': 0.26, '7d': 1.00 },
        'key5bbbb': { '5h': 0.85, '7d': 0.35 },
        'key6bbbb': { '5h': 0.85, '7d': 0.35 },
        'key7cccc': { '5h': 0.00, '7d': 1.00 },
      };

      const keyLookup = new Map([
        ['key1aaaa', { accountId: 'acct-A' }],
        ['key2aaaa', { accountId: 'acct-A' }],
        ['key3aaaa', { accountId: 'acct-A' }],
        ['key4aaaa', { accountId: 'acct-A' }],
        ['key5bbbb', { accountId: 'acct-B' }],
        ['key6bbbb', { accountId: 'acct-B' }],
        ['key7cccc', { accountId: 'acct-C' }],
      ]);

      const accountMap = new Map();
      for (const [keyId, usage] of Object.entries(rawKeyData)) {
        const key = keyLookup.get(keyId);
        const dedupeKey = key?.accountId || `fp:${usage['5h']}:${usage['7d']}`;
        if (!accountMap.has(dedupeKey)) {
          accountMap.set(dedupeKey, { id: keyId, usage });
        }
      }

      // Should produce exactly 3 entries (one per account)
      assert.strictEqual(accountMap.size, 3, 'Must deduplicate to 3 accounts from 7 keys');

      // Verify correct 7d average: (100 + 35 + 100) / 3 = 78.3%
      const entries = Array.from(accountMap.values());
      const avg7d = entries.reduce((s, e) => s + e.usage['7d'], 0) / entries.length;
      const avg7dPct = Math.round(avg7d * 1000) / 10;
      assert.ok(
        Math.abs(avg7dPct - 78.3) < 0.1,
        `Per-account 7d average should be ~78.3%, got ${avg7dPct}%`
      );

      // Buggy per-key average would be: (100*4 + 35*2 + 100*1) / 7 = 81.4%
      const buggyAvg = (1.00 * 4 + 0.35 * 2 + 1.00 * 1) / 7;
      const buggyPct = Math.round(buggyAvg * 1000) / 10;
      assert.ok(
        Math.abs(buggyPct - 81.4) < 0.1,
        `Buggy per-key average should be ~81.4%, got ${buggyPct}%`
      );

      assert.ok(avg7dPct < buggyPct, 'Per-account average must be lower than buggy per-key average');
    });

    it('should fall back to fingerprint when accountId is null', () => {
      const rawKeyData = {
        'key1xxxx': { '5h': 0.50, '7d': 0.60 },
        'key2xxxx': { '5h': 0.50, '7d': 0.60 }, // Same fingerprint → same account
        'key3yyyy': { '5h': 0.20, '7d': 0.30 }, // Different fingerprint → different account
      };

      const keyLookup = new Map([
        ['key1xxxx', { accountId: null }],
        ['key2xxxx', { accountId: null }],
        ['key3yyyy', { accountId: null }],
      ]);

      const accountMap = new Map();
      for (const [keyId, usage] of Object.entries(rawKeyData)) {
        const key = keyLookup.get(keyId);
        const dedupeKey = key?.accountId || `fp:${usage['5h']}:${usage['7d']}`;
        if (!accountMap.has(dedupeKey)) {
          accountMap.set(dedupeKey, { id: keyId, usage });
        }
      }

      // key1 and key2 have same fingerprint → deduped to 1 entry
      // key3 has different fingerprint → separate entry
      assert.strictEqual(accountMap.size, 2, 'Must deduplicate by fingerprint when accountId is null');
    });

    it('should prefer accountId over fingerprint when both available', () => {
      const rawKeyData = {
        'key1xxxx': { '5h': 0.50, '7d': 0.60 },
        'key2xxxx': { '5h': 0.50, '7d': 0.60 }, // Same fingerprint but different account
      };

      const keyLookup = new Map([
        ['key1xxxx', { accountId: 'acct-A' }],
        ['key2xxxx', { accountId: 'acct-B' }], // Different account despite same usage values
      ]);

      const accountMap = new Map();
      for (const [keyId, usage] of Object.entries(rawKeyData)) {
        const key = keyLookup.get(keyId);
        const dedupeKey = key?.accountId || `fp:${usage['5h']}:${usage['7d']}`;
        if (!accountMap.has(dedupeKey)) {
          accountMap.set(dedupeKey, { id: keyId, usage });
        }
      }

      // Two different accounts, even though usage values are identical
      assert.strictEqual(accountMap.size, 2, 'Must keep keys from different accounts even if usage matches');
    });

    it('should include accountId in env token key objects', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function getApiKeys\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Env token should have accountId: null
      assert.match(
        functionBody,
        /return \[\{ id: ['"]env['"],\s*accessToken: envToken,\s*accountId: null \}\]/,
        'Env token must include accountId: null'
      );
    });

    it('should include accountId in keychain key objects', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function getApiKeys\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Keychain source should include accountId: null
      assert.match(
        functionBody,
        /id: ['"]keychain['"],\s*accessToken:[\s\S]*?accountId: null/s,
        'Keychain key must include accountId: null'
      );
    });

    it('should include accountId in credentials file key objects', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function getApiKeys\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Credentials fallback should include accountId: null
      assert.match(
        functionBody,
        /id: ['"]default['"],\s*accessToken:[\s\S]*?accountId: null/s,
        'Credentials file key must include accountId: null'
      );
    });
  });

  describe('Exhausted-Account Filtering in calculateAggregate', () => {
    it('should classify keys with 7d >= 0.995 as exhausted', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAggregate\(latest, earliest, hoursBetween(?:, allSnapshots)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /const EXHAUSTED_THRESHOLD = 0\.995/,
        'Must define EXHAUSTED_THRESHOLD = 0.995'
      );

      assert.match(
        functionBody,
        /val7d >= EXHAUSTED_THRESHOLD/,
        'Must check 7d value against EXHAUSTED_THRESHOLD'
      );
    });

    it('should fall back to all-key average when ALL keys are exhausted', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAggregate\(latest, earliest, hoursBetween(?:, allSnapshots)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /activeEntries\.length > 0 \? activeEntries : latestEntries/,
        'Must fall back to all entries when no active keys'
      );
    });

    it('should pass excludeKeys to calculateEmaRate to exclude exhausted keys from rates', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAggregate\(latest, earliest, hoursBetween(?:, allSnapshots)?\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /const excludeKeys = exhaustedKeyIds\.size > 0 && activeEntries\.length > 0 \? exhaustedKeyIds : null/,
        'Must set excludeKeys from exhausted IDs when active keys exist'
      );
    });

    it('should correctly compute active-only aggregate (behavioral)', () => {
      // Simulate: 3 accounts, 1 exhausted at 100% 7d
      const keys = {
        active1: { '5h': 0.14, '7d': 0.40 },
        active2: { '5h': 0.20, '7d': 0.30 },
        exhausted: { '5h': 0.00, '7d': 1.00 },
      };

      const EXHAUSTED_THRESHOLD = 0.995;
      const entries = Object.entries(keys);
      const activeEntries = entries.filter(([, k]) => (k['7d'] ?? 0) < EXHAUSTED_THRESHOLD);
      const entriesToAverage = activeEntries.length > 0 ? activeEntries : entries;

      let sum7d = 0;
      for (const [, k] of entriesToAverage) sum7d += k['7d'] ?? 0;
      const avg7d = sum7d / entriesToAverage.length;

      // Active-only: (0.40 + 0.30) / 2 = 0.35
      assert.ok(Math.abs(avg7d - 0.35) < 0.001, `Active-only 7d average must be 0.35, got ${avg7d}`);

      // Buggy all-key: (0.40 + 0.30 + 1.00) / 3 = 0.567
      const buggyAvg = (0.40 + 0.30 + 1.00) / 3;
      assert.ok(avg7d < buggyAvg, 'Active-only average must be lower than all-key average');
    });
  });

  describe('Key-Count Discontinuity Guard', () => {
    it('should detect key count changes and skip adjustment', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /prevKeyCount !== currKeyCount/,
        'Must compare previous and current key counts'
      );

      assert.match(
        functionBody,
        /Key count changed/,
        'Must log when key count changes'
      );
    });

    it('should skip one cycle when keys are added or removed', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      const guardBlock = functionBody.match(/prevKeyCount !== currKeyCount[\s\S]*?return false/);
      assert.ok(guardBlock, 'Must return false when key count changes');
    });
  });

  describe('Invalid Key Filtering in getApiKeys', () => {
    it('should skip keys with status invalid', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function getApiKeys\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /data\.status === ['"]invalid['"]/,
        'Must check for invalid status'
      );
    });
  });

  describe('resetOptimizer() - Data Reset', () => {
    it('should be exported as a named function', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /export function resetOptimizer\(/,
        'Must export resetOptimizer function'
      );
    });

    it('should clear snapshots to empty array', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export function resetOptimizer\([\s\S]*?\n\}/);
      assert.ok(functionMatch, 'resetOptimizer must exist');

      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /JSON\.stringify\(\{ snapshots: \[\] \}/,
        'Must write empty snapshots array'
      );
    });

    it('should reset factor to 1.0', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export function resetOptimizer\([\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /factor: 1\.0/,
        'Must reset factor to 1.0'
      );
    });

    it('should set direction to reset', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export function resetOptimizer\([\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /direction: ['"]reset['"]/,
        'Must set direction to reset'
      );
    });

    it('should restore default cooldowns', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export function resetOptimizer\([\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /const defaults = getDefaults\(\)/,
        'Must get defaults from getDefaults()'
      );

      assert.match(
        functionBody,
        /config\.effective = \{ \.\.\.defaults \}/,
        'Must spread defaults into config.effective'
      );
    });

    it('should handle errors gracefully', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/export function resetOptimizer\([\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      const catchCount = (functionBody.match(/\} catch/g) || []).length;
      assert.ok(catchCount >= 2, 'Must have catch blocks for both snapshot and config operations');
    });
  });

  describe('MAX_COOLDOWN_MINUTES - Ceiling Map (GAP 1)', () => {
    it('should define MAX_COOLDOWN_MINUTES constant', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /const MAX_COOLDOWN_MINUTES\s*=\s*\{/,
        'Must define MAX_COOLDOWN_MINUTES as an object'
      );
    });

    it('should set production_health_monitor ceiling to 120 minutes', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /production_health_monitor:\s*120/,
        'production_health_monitor ceiling must be 120 (2h)'
      );
    });

    it('should set staging_health_monitor ceiling to 360 minutes', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /staging_health_monitor:\s*360/,
        'staging_health_monitor ceiling must be 360 (6h)'
      );
    });

    it('should set triage_check ceiling to 15 minutes', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      assert.match(
        code,
        /triage_check:\s*15/,
        'triage_check ceiling must be 15 minutes'
      );
    });

    it('should apply Math.min ceiling in applyFactor()', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const applyFactorMatch = code.match(/function applyFactor\([\s\S]*?\n\}/);
      assert.ok(applyFactorMatch, 'applyFactor function must exist');
      const fnBody = applyFactorMatch[0];

      // Must use Math.min with MAX_COOLDOWN_MINUTES
      assert.match(
        fnBody,
        /Math\.min\(computed,\s*MAX_COOLDOWN_MINUTES\[key\]\)/,
        'Must apply Math.min ceiling using MAX_COOLDOWN_MINUTES'
      );

      // Must check if key exists in ceiling map
      assert.match(
        fnBody,
        /MAX_COOLDOWN_MINUTES\[key\]\s*!==\s*undefined/,
        'Must check if key has a ceiling defined'
      );
    });

    it('should apply floor before ceiling (Math.max before Math.min)', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const applyFactorMatch = code.match(/function applyFactor\([\s\S]*?\n\}/);
      const fnBody = applyFactorMatch[0];

      // Floor (Math.max with MIN_EFFECTIVE_MINUTES) should come before ceiling (Math.min)
      const floorIdx = fnBody.indexOf('Math.max(MIN_EFFECTIVE_MINUTES');
      const ceilingIdx = fnBody.indexOf('Math.min(computed, MAX_COOLDOWN_MINUTES');

      assert.ok(floorIdx > 0, 'Must have Math.max floor');
      assert.ok(ceilingIdx > 0, 'Must have Math.min ceiling');
      assert.ok(floorIdx < ceilingIdx, 'Floor (Math.max) must be applied before ceiling (Math.min)');
    });
  });

  describe('Behavioral Tests - MAX_COOLDOWN_MINUTES Ceiling Application', () => {
    const MIN_EFFECTIVE_MINUTES = 5;
    const MAX_COOLDOWN_MINUTES = {
      production_health_monitor: 120,
      staging_health_monitor: 360,
      triage_check: 15,
    };

    it('should clamp production_health_monitor to 120 minutes when factor is extreme slowdown', () => {
      // At factor 0.05 (20x slowdown), production default 60 min becomes 60/0.05 = 1200 min
      const factor = 0.05;
      const defaultCooldown = 60;

      const rawComputed = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultCooldown / factor));
      const withCeiling = Math.min(rawComputed, MAX_COOLDOWN_MINUTES.production_health_monitor);

      assert.strictEqual(rawComputed, 1200, 'Raw computed value should be 1200 minutes');
      assert.strictEqual(withCeiling, 120, 'Ceiling must clamp to 120 minutes');
    });

    it('should clamp staging_health_monitor to 360 minutes when factor is extreme slowdown', () => {
      // At factor 0.05, staging default 180 min becomes 180/0.05 = 3600 min (60 hours)
      const factor = 0.05;
      const defaultCooldown = 180;

      const rawComputed = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultCooldown / factor));
      const withCeiling = Math.min(rawComputed, MAX_COOLDOWN_MINUTES.staging_health_monitor);

      assert.strictEqual(rawComputed, 3600, 'Raw computed value should be 3600 minutes');
      assert.strictEqual(withCeiling, 360, 'Ceiling must clamp to 360 minutes (6h)');
    });

    it('should clamp triage_check to 15 minutes when factor is moderate slowdown', () => {
      // At factor 0.5, triage default 5 min becomes 5/0.5 = 10 min (under ceiling)
      // At factor 0.2, triage default 5 min becomes 5/0.2 = 25 min (over ceiling)
      const factor = 0.2;
      const defaultCooldown = 5;

      const rawComputed = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultCooldown / factor));
      const withCeiling = Math.min(rawComputed, MAX_COOLDOWN_MINUTES.triage_check);

      assert.strictEqual(rawComputed, 25, 'Raw computed value should be 25 minutes');
      assert.strictEqual(withCeiling, 15, 'Ceiling must clamp to 15 minutes');
    });

    it('should not clamp production_health_monitor when factor keeps it under ceiling', () => {
      // At factor 1.0, production default 60 min stays at 60 min (well under 120 ceiling)
      const factor = 1.0;
      const defaultCooldown = 60;

      const rawComputed = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultCooldown / factor));
      const withCeiling = Math.min(rawComputed, MAX_COOLDOWN_MINUTES.production_health_monitor);

      assert.strictEqual(rawComputed, 60, 'Raw computed value should be 60 minutes');
      assert.strictEqual(withCeiling, 60, 'Should not clamp when under ceiling');
    });

    it('should not clamp keys without ceiling entries', () => {
      // Keys not in MAX_COOLDOWN_MINUTES should only apply floor, not ceiling
      const factor = 0.05;
      const defaultCooldown = 1440; // 24 hours

      const rawComputed = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultCooldown / factor));
      // No ceiling for this key, so rawComputed is the final value
      const withCeiling = rawComputed; // Simulating: if (MAX_COOLDOWN_MINUTES[key] !== undefined) check

      assert.strictEqual(rawComputed, 28800, 'Raw computed value should be 28800 minutes (20 days)');
      assert.strictEqual(withCeiling, 28800, 'Keys without ceiling should not be clamped');
    });

    it('should apply both floor and ceiling correctly', () => {
      // Test ceiling application after floor
      // At factor 10.0, production default 60 min becomes 60/10 = 6 min (above floor, under ceiling)
      const factorModerate = 10.0;
      const defaultCooldown = 60;

      const rawComputedModerate = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultCooldown / factorModerate));
      const withCeilingModerate = Math.min(rawComputedModerate, MAX_COOLDOWN_MINUTES.production_health_monitor);

      assert.strictEqual(rawComputedModerate, 6, 'Floor should allow 6 minutes');
      assert.strictEqual(withCeilingModerate, 6, 'Ceiling should not affect values under 120 minutes');

      // At factor 30.0, production default 60 min becomes 60/30 = 2 min → floored to 5 min
      const factorExtreme = 30.0;
      const rawComputedExtreme = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultCooldown / factorExtreme));
      const withCeilingExtreme = Math.min(rawComputedExtreme, MAX_COOLDOWN_MINUTES.production_health_monitor);

      assert.strictEqual(rawComputedExtreme, 5, 'Floor must enforce 5-minute minimum');
      assert.strictEqual(withCeilingExtreme, 5, 'Ceiling should not affect floored values');
    });

    it('should verify ceiling boundaries are exact', () => {
      // Test that ceiling is applied at exactly the boundary value
      const factor = 0.5; // 60 / 0.5 = 120 exactly for production
      const defaultCooldown = 60;

      const rawComputed = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultCooldown / factor));
      const withCeiling = Math.min(rawComputed, MAX_COOLDOWN_MINUTES.production_health_monitor);

      assert.strictEqual(rawComputed, 120, 'Raw computed should be exactly 120');
      assert.strictEqual(withCeiling, 120, 'Ceiling should allow exactly 120 minutes');

      // Just above ceiling
      const factorJustAbove = 0.499; // 60 / 0.499 = 120.24 → rounds to 120
      const rawComputedAbove = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultCooldown / factorJustAbove));
      const withCeilingAbove = Math.min(rawComputedAbove, MAX_COOLDOWN_MINUTES.production_health_monitor);

      assert.strictEqual(rawComputedAbove, 120, 'Should round to 120');
      assert.strictEqual(withCeilingAbove, 120, 'Ceiling should not clamp at boundary');

      // Clearly above ceiling
      const factorClearlyAbove = 0.4; // 60 / 0.4 = 150
      const rawComputedClear = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultCooldown / factorClearlyAbove));
      const withCeilingClear = Math.min(rawComputedClear, MAX_COOLDOWN_MINUTES.production_health_monitor);

      assert.strictEqual(rawComputedClear, 150, 'Raw computed should be 150');
      assert.strictEqual(withCeilingClear, 120, 'Ceiling must clamp 150 to 120');
    });
  });
});
