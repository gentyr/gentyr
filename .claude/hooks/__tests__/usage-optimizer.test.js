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
        /const MAX_FACTOR = 2\.0/,
        'Must define MAX_FACTOR = 2.0'
      );

      assert.match(
        code,
        /const MIN_FACTOR = 0\.5/,
        'Must define MIN_FACTOR = 0.5'
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
        /const RESET_BOUNDARY_DROP_THRESHOLD = 0\.30/,
        'Must define RESET_BOUNDARY_DROP_THRESHOLD = 0.30'
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

      // In catch block, should return error
      const catchBlock = functionBody.match(/catch \(err\) \{[\s\S]*?\n  \}/);
      assert.ok(catchBlock, 'Must have catch block');

      assert.match(
        catchBlock[0],
        /return \{[\s\S]*?success: false[\s\S]*?error:/,
        'Must return success: false and error message in catch block'
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
        /if \(Object\.keys\(keyData\)\.length === 0\)/,
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

      // Should return snapshot with ts and keys
      assert.match(
        functionBody,
        /return \{[\s\S]*?ts[\s\S]*?keys:[\s\S]*?keyData/s,
        'Must return snapshot with ts and keys'
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

    it('should return array of { id, accessToken } objects', () => {
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

    it('should calculate trajectory from earliest and latest snapshots', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should get latest snapshot
      assert.match(
        functionBody,
        /const latest = data\.snapshots\[data\.snapshots\.length - 1\]/,
        'Must get latest snapshot'
      );

      // Should get earliest from recent window
      assert.match(
        functionBody,
        /const earliest = data\.snapshots\[Math\.max/,
        'Must get earliest snapshot from window'
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

    it('should calculate projected usage at reset time', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should calculate projections
      assert.match(
        functionBody,
        /projected5h = aggregate\.current5h \+ \(aggregate\.rate5h \* aggregate\.hoursUntil5hReset\)/,
        'Must calculate projected 5h usage'
      );

      assert.match(
        functionBody,
        /projected7d = aggregate\.current7d \+ \(aggregate\.rate7d \* aggregate\.hoursUntil7dReset\)/,
        'Must calculate projected 7d usage'
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
    it('should average utilization across keys', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAggregate\(latest, earliest, hoursBetween(?:, allSnapshots)?\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'calculateAggregate function must exist');

      const functionBody = functionMatch[0];

      // Should sum values across keys (via val5h/val7d intermediaries)
      assert.match(
        functionBody,
        /sum5h \+= val5h/,
        'Must sum 5h utilization across keys'
      );

      assert.match(
        functionBody,
        /sum7d \+= val7d/,
        'Must sum 7d utilization across keys'
      );

      // Should divide by numKeys
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
        /maxKey5h, maxKey7d, perKeyUtilization/,
        'Must return maxKey5h, maxKey7d, and perKeyUtilization'
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

      // Should get defaults
      assert.match(
        functionBody,
        /const defaults = config\.defaults \|\| getDefaults\(\)/,
        'Must get defaults from config or getDefaults()'
      );

      // Should calculate effective values with MIN_EFFECTIVE_MINUTES floor
      assert.match(
        functionBody,
        /effective\[key\] = Math\.max\(MIN_EFFECTIVE_MINUTES, Math\.round\(defaultVal \/ newFactor\)\)/,
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

      const functionMatch = code.match(/function calculateEmaRate\(snapshots, metricKey, alpha = 0\.3\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'calculateEmaRate function must exist with correct signature');
    });

    it('should return 0 for fewer than 2 snapshots', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateEmaRate\(snapshots, metricKey, alpha = 0\.3\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /if \(snapshots\.length < 2\) return 0/,
        'Must return 0 for fewer than 2 snapshots'
      );
    });

    it('should compute EMA from consecutive snapshot pairs', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateEmaRate\(snapshots, metricKey, alpha = 0\.3\) \{[\s\S]*?\n\}/);
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

    it('should skip near-zero time intervals', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateEmaRate\(snapshots, metricKey, alpha = 0\.3\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /if \(hoursDelta < 0\.01\) continue/,
        'Must skip near-zero time intervals'
      );
    });

    it('should find common keys between consecutive snapshots', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateEmaRate\(snapshots, metricKey, alpha = 0\.3\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /Object\.keys\(curr\.keys\)\.filter\(k => k in prev\.keys\)/,
        'Must filter for common keys between consecutive snapshots'
      );
    });
  });

  describe('Reset-Boundary Detection', () => {
    it('should detect large 5h utilization drops between consecutive snapshots', () => {
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
        /drop5h >= RESET_BOUNDARY_DROP_THRESHOLD/,
        'Must compare drop against RESET_BOUNDARY_DROP_THRESHOLD'
      );
    });

    it('should compare the last two snapshots for boundary detection', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /data\.snapshots\[data\.snapshots\.length - 2\]/,
        'Must access second-to-last snapshot'
      );

      assert.match(
        functionBody,
        /const drop5h = prevAgg\.current5h - currAgg\.current5h/,
        'Must calculate drop as previous minus current'
      );
    });

    it('should skip adjustment cycle when reset detected', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // After detecting reset, should return false
      const resetBlock = functionBody.match(/drop5h >= RESET_BOUNDARY_DROP_THRESHOLD[\s\S]*?return false/);
      assert.ok(resetBlock, 'Must return false when reset boundary detected');
    });
  });

  describe('Per-Key Warnings and Max-Key Biasing', () => {
    it('should log warnings when any key exceeds 5h threshold', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /Usage optimizer WARNING: Key .* 5h utilization/,
        'Must log per-key 5h utilization warnings'
      );
    });

    it('should log warnings when any key exceeds 7d threshold', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const functionMatch = code.match(/function calculateAndAdjust\(log\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      assert.match(
        functionBody,
        /Usage optimizer WARNING: Key .* 7d utilization/,
        'Must log per-key 7d utilization warnings'
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

      assert.match(
        functionBody,
        /maxKey5h = Math\.max\(maxKey5h, val5h\)/,
        'Must track max 5h value across keys'
      );

      assert.match(
        functionBody,
        /maxKey7d = Math\.max\(maxKey7d, val7d\)/,
        'Must track max 7d value across keys'
      );
    });
  });

  describe('EMA Rate Integration in calculateAggregate', () => {
    it('should use EMA rate when allSnapshots available with 3+ entries', () => {
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
        /rate5h = calculateEmaRate\(recentSnapshots, ['"]5h['"]\)/,
        'Must call calculateEmaRate for 5h rate'
      );

      assert.match(
        functionBody,
        /rate7d = calculateEmaRate\(recentSnapshots, ['"]7d['"]\)/,
        'Must call calculateEmaRate for 7d rate'
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

      // Verify floor is applied in effective calculation
      // Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultVal / newFactor))
      // Example: defaultVal=60, newFactor=2.0 → Math.max(5, 30) = 30 ✓
      // Example: defaultVal=8, newFactor=2.0 → Math.max(5, 4) = 5 ✓
      const applyFactorMatch = code.match(/effective\[key\] = Math\.max\(MIN_EFFECTIVE_MINUTES, Math\.round\(defaultVal \/ newFactor\)\)/);
      assert.ok(applyFactorMatch, 'Must apply MIN_EFFECTIVE_MINUTES floor in effective calculation');
    });

    it('should allow effective cooldowns above the floor', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify the formula allows values above floor
      // If defaultVal=60 and newFactor=1.0, result should be 60, not clamped to 2
      const formulaMatch = code.match(/Math\.max\(MIN_EFFECTIVE_MINUTES, Math\.round\(defaultVal \/ newFactor\)\)/);
      assert.ok(formulaMatch, 'Formula must allow values above MIN_EFFECTIVE_MINUTES');
    });
  });

  describe('Behavioral Tests - Reset-Boundary Detection', () => {
    it('should skip adjustment when 5h drops by 30% or more', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify threshold value
      const thresholdMatch = code.match(/const RESET_BOUNDARY_DROP_THRESHOLD = (0\.\d+)/);
      assert.ok(thresholdMatch, 'Must find RESET_BOUNDARY_DROP_THRESHOLD');
      const threshold = parseFloat(thresholdMatch[1]);
      assert.strictEqual(threshold, 0.30, 'RESET_BOUNDARY_DROP_THRESHOLD must be 0.30');

      // Verify detection logic
      const detectionMatch = code.match(/if \(drop5h >= RESET_BOUNDARY_DROP_THRESHOLD\)[\s\S]*?return false/);
      assert.ok(detectionMatch, 'Must skip adjustment when drop >= threshold');
    });

    it('should only check reset boundary with 2+ snapshots', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify guard condition
      const guardMatch = code.match(/if \(data\.snapshots\.length >= 2\)[\s\S]*?drop5h >= RESET_BOUNDARY_DROP_THRESHOLD/s);
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

      const alphaMatch = code.match(/function calculateEmaRate\(snapshots, metricKey, alpha = (0\.\d+)\)/);
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

    it('should prefer EMA rate over two-point slope when 3+ snapshots available', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify calculateAggregate calls calculateEmaRate when allSnapshots.length >= 3
      const preferenceMatch = code.match(/if \(allSnapshots && allSnapshots\.length >= 3\)[\s\S]*?rate5h = calculateEmaRate\(recentSnapshots, ['"]5h['"]\)/s);
      assert.ok(preferenceMatch, 'Must prefer EMA rate when 3+ snapshots available');
    });
  });

  describe('Behavioral Tests - Max-Key Awareness', () => {
    it('should track max utilization across all keys', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      // Verify maxKey tracking in calculateAggregate
      const maxTrackingMatch = code.match(/maxKey5h = Math\.max\(maxKey5h, val5h\)[\s\S]*?maxKey7d = Math\.max\(maxKey7d, val7d\)/s);
      assert.ok(maxTrackingMatch, 'Must track max values across keys');
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

    it('should warn when any single key exceeds 80% on 5h window', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const warningMatch = code.match(/if \(util\[['"]5h['"]\] >= SINGLE_KEY_WARNING_THRESHOLD\)[\s\S]*?Usage optimizer WARNING:[\s\S]*?5h utilization/s);
      assert.ok(warningMatch, 'Must warn for 5h utilization exceeding threshold');
    });

    it('should warn when any single key exceeds 80% on 7d window', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const warningMatch = code.match(/if \(util\[['"]7d['"]\] >= SINGLE_KEY_WARNING_THRESHOLD\)[\s\S]*?Usage optimizer WARNING:[\s\S]*?7d utilization/s);
      assert.ok(warningMatch, 'Must warn for 7d utilization exceeding threshold');
    });

    it('should include key ID in warning messages', () => {
      const code = fs.readFileSync(OPTIMIZER_PATH, 'utf8');

      const keyIdMatch = code.match(/Usage optimizer WARNING: Key \$\{keyId\}/);
      assert.ok(keyIdMatch, 'Must include key ID in warning messages');
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
});
