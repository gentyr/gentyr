/**
 * Tests for cto-notification-hook.js
 *
 * These tests validate critical bug fixes:
 * 1. getSessionDir() - Proper sanitization of ALL non-alphanumeric characters
 * 2. getSessionMetrics24h() - Correct JSON structure parsing and timestamp conversion
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/cto-notification-hook.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

describe('cto-notification-hook.js - Bug Fixes', () => {
  const PROJECT_DIR = process.cwd();
  const HOOK_PATH = path.join(PROJECT_DIR, '.claude/hooks/cto-notification-hook.js');

  describe('getSessionDir() - Path Sanitization', () => {
    it('should sanitize ALL non-alphanumeric characters, not just slashes', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // CRITICAL: Must use [^a-zA-Z0-9] to replace ALL non-alphanumeric chars
      // The bug was using /\//g which only replaced forward slashes
      assert.match(
        hookCode,
        /PROJECT_DIR\.replace\(\/\[\^a-zA-Z0-9\]\/g,\s*'-'\)/,
        'getSessionDir() must use [^a-zA-Z0-9] regex to replace ALL non-alphanumeric characters'
      );

      // Should NOT use the old broken pattern
      assert.doesNotMatch(
        hookCode,
        /PROJECT_DIR\.replace\(\/\\\/\/g,\s*'-'\)/,
        'getSessionDir() must NOT use the old /\\//g pattern that only replaces slashes'
      );
    });

    it('should strip leading dash after sanitization', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should remove leading dash to prevent paths like "/-foo-bar"
      assert.match(
        hookCode,
        /\.replace\(\/\^-\/,\s*''\)/,
        'getSessionDir() must strip leading dash with /^-/ pattern'
      );
    });

    it('should prepend dash to final path', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Final path should be `-${projectPath}` for Claude Code directory structure
      assert.match(
        hookCode,
        /`-\$\{projectPath\}`/,
        'getSessionDir() must prepend dash to final directory name'
      );
    });

    it('should validate complete function structure', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Extract the function
      const functionMatch = hookCode.match(/function getSessionDir\(\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'getSessionDir() function must exist');

      const functionBody = functionMatch[0];

      // Validate the complete transformation chain
      assert.match(
        functionBody,
        /PROJECT_DIR\.replace\(\/\[\^a-zA-Z0-9\]\/g,\s*'-'\)\.replace\(\/\^-\/,\s*''\)/,
        'Must chain both replace calls correctly'
      );

      // Validate return statement
      assert.match(
        functionBody,
        /return path\.join\(os\.homedir\(\),\s*'\.claude',\s*'projects',\s*`-\$\{projectPath\}`\)/,
        'Must return correct path structure'
      );
    });
  });

  describe('getSessionMetrics24h() - JSON Parsing', () => {
    it('should parse JSON with { agents: [...] } structure', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // CRITICAL: Must parse as { agents: [...] } not as array directly
      // The bug was treating the content as a direct array
      assert.match(
        hookCode,
        /const data = JSON\.parse\(content\)/,
        'Must parse JSON into data variable first'
      );

      assert.match(
        hookCode,
        /const history = data\.agents \|\| \[\]/,
        'Must extract agents array from data.agents with fallback to empty array'
      );

      // Should NOT parse directly as array
      assert.doesNotMatch(
        hookCode,
        /const history = JSON\.parse\(content\);?\s*(?!\/\/)/,
        'Must NOT parse JSON directly into history variable without extracting .agents'
      );
    });

    it('should convert ISO timestamp strings to milliseconds for comparison', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // CRITICAL: Must convert entry.timestamp (ISO string) to milliseconds
      // The bug was comparing string directly to milliseconds
      assert.match(
        hookCode,
        /new Date\(entry\.timestamp\)\.getTime\(\)/,
        'Must convert entry.timestamp to milliseconds using new Date().getTime()'
      );

      // Validate it's filtering agent-tracker entries by time
      assert.match(
        hookCode,
        /new Date\(entry\.timestamp\)\.getTime\(\) >= since/,
        'Must compare converted timestamp against since variable when filtering hook sessions'
      );

      // Should NOT compare string timestamp directly
      assert.doesNotMatch(
        hookCode,
        /if \(entry\.timestamp >= since\)/,
        'Must NOT compare ISO string timestamp directly to milliseconds'
      );
    });

    it('should validate complete function structure', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Extract the function
      const functionMatch = hookCode.match(/function getSessionMetrics24h\(\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'getSessionMetrics24h() function must exist');

      const functionBody = functionMatch[0];

      // Validate the complete flow:
      // 1. Read agent tracker history to build Set of hook session IDs
      assert.match(functionBody, /fs\.readFileSync\(AGENT_TRACKER_HISTORY/, 'Must read agent tracker history file');
      assert.match(functionBody, /const data = JSON\.parse\(content\)/, 'Must parse JSON content');
      assert.match(functionBody, /const history = data\.agents/, 'Must extract agents array');
      assert.match(functionBody, /hookSessionIds\.add\(entry\.sessionId\)/, 'Must build Set of hook session IDs');

      // 2. Count actual .jsonl session files
      assert.match(functionBody, /readdirSync\(sessionDir\)/, 'Must read session directory');
      assert.match(functionBody, /\.filter\(f => f\.endsWith\('\.jsonl'\)\)/, 'Must filter for .jsonl files');

      // 3. Check file modification time
      assert.match(functionBody, /stat\.mtime\.getTime\(\)/, 'Must check file modification time');

      // 4. Categorize sessions as hook or user
      assert.match(functionBody, /hookSessionIds\.has\(sessionId\)/, 'Must check if session is hook-spawned');
      assert.match(functionBody, /metrics\.hook\+\+/, 'Must increment hook counter');
      assert.match(functionBody, /metrics\.user\+\+/, 'Must increment user counter');
    });

    it('should handle missing file gracefully', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Extract the function
      const functionMatch = hookCode.match(/function getSessionMetrics24h\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check if agent-tracker history file exists before reading
      assert.match(
        functionBody,
        /if \(fs\.existsSync\(AGENT_TRACKER_HISTORY\)\)/,
        'Must check if history file exists before reading'
      );

      // Should check if session directory exists before reading
      assert.match(
        functionBody,
        /if \(!fs\.existsSync\(sessionDir\)\)/,
        'Must check if session directory exists'
      );

      // Should return default metrics on missing directory
      assert.match(
        functionBody,
        /return metrics/,
        'Must return metrics object'
      );
    });

    it('should wrap file operations in try-catch', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Extract the function
      const functionMatch = hookCode.match(/function getSessionMetrics24h\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should have try-catch for file operations
      assert.match(functionBody, /try \{/, 'Must have try block for file operations');
      assert.match(functionBody, /\} catch/, 'Must have catch block for error handling');

      // Catch block should return metrics (fail-open is acceptable here for metrics)
      const catchMatch = functionBody.match(/\} catch[^{]*\{([^}]+)\}/);
      assert.ok(catchMatch, 'Must have catch block with body');
    });
  });

  describe('Database Path Constants', () => {
    it('should use correct agent-reports database path', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // CRITICAL: Database was renamed from cto-reports.db to agent-reports.db
      assert.match(
        hookCode,
        /const CTO_REPORTS_DB = path\.join\(PROJECT_DIR,\s*'\.claude',\s*'agent-reports\.db'\)/,
        'CTO_REPORTS_DB constant must point to agent-reports.db'
      );

      // Should NOT reference old database name
      assert.doesNotMatch(
        hookCode,
        /'cto-reports\.db'/,
        'Must NOT reference old cto-reports.db database'
      );
    });

    it('should document correct database in comments', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Header comment should reference agent-reports
      assert.match(
        hookCode,
        /agent-reports database/i,
        'Comments must reference agent-reports database, not cto-reports'
      );

      // Should NOT reference old database in comments
      assert.doesNotMatch(
        hookCode,
        /cto-reports database/i,
        'Must NOT reference old cto-reports database in comments'
      );
    });
  });

  describe('Function Return Types - Fail-Closed Validation', () => {
    it('should return default values on errors (metrics are non-critical)', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // getSessionMetrics24h should return default metrics on error
      const metricsFunction = hookCode.match(/function getSessionMetrics24h\(\) \{[\s\S]*?\n\}/)[0];
      assert.match(
        metricsFunction,
        /const metrics = \{ hook: 0, user: 0 \}/,
        'Must initialize metrics with default values'
      );

      // getTokenUsage24h should return 0 on errors
      const tokenFunction = hookCode.match(/function getTokenUsage24h\(\) \{[\s\S]*?\n\}/)[0];
      assert.match(
        tokenFunction,
        /let total = 0/,
        'Must initialize token total to 0'
      );
      assert.match(
        tokenFunction,
        /return total/,
        'Must return total (defaults to 0 on errors)'
      );
    });

    it('should validate G001 fail-closed for critical operations', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // getDeputyCtoCounts is critical - must signal errors
      const deputyCtoFunction = hookCode.match(/function getDeputyCtoCounts\(\) \{[\s\S]*?\n\}/)[0];
      assert.match(
        deputyCtoFunction,
        /return \{[\s\S]*?error: true[\s\S]*?\}/,
        'getDeputyCtoCounts must return error flag on database failures (G001)'
      );

      assert.match(
        deputyCtoFunction,
        /console\.error\(/,
        'getDeputyCtoCounts must log errors for critical operations'
      );

      assert.match(
        deputyCtoFunction,
        /G001/,
        'getDeputyCtoCounts must reference G001 spec in error handling'
      );
    });
  });

  describe('Edge Cases - Timestamp Handling', () => {
    it('should handle various timestamp formats correctly', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // getSessionMetrics24h - entry.timestamp is ISO string
      const metricsFunction = hookCode.match(/function getSessionMetrics24h\(\) \{[\s\S]*?\n\}/)[0];
      assert.match(
        metricsFunction,
        /new Date\(entry\.timestamp\)/,
        'Must parse entry.timestamp as Date object'
      );

      // getTokenUsage24h - entry.timestamp needs conversion too
      const tokenFunction = hookCode.match(/function getTokenUsage24h\(\) \{[\s\S]*?\n\}/)[0];
      assert.match(
        tokenFunction,
        /if \(entry\.timestamp\)/,
        'Must check if timestamp exists'
      );
      assert.match(
        tokenFunction,
        /const entryTime = new Date\(entry\.timestamp\)\.getTime\(\)/,
        'Must convert timestamp to milliseconds in getTokenUsage24h'
      );
    });

    it('should calculate time windows correctly', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Both functions should calculate 24 hour window
      assert.match(
        hookCode,
        /const since = Date\.now\(\) - \(24 \* 60 \* 60 \* 1000\)/g,
        'Must calculate 24-hour window in milliseconds'
      );
    });
  });

  describe('Code Structure - Overall Validation', () => {
    it('should have all required constants defined', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const requiredConstants = [
        'PROJECT_DIR',
        'DEPUTY_CTO_DB',
        'CTO_REPORTS_DB',
        'TODO_DB',
        'AGENT_TRACKER_HISTORY',
        'AUTONOMOUS_CONFIG_PATH',
        'AUTOMATION_STATE_PATH',
        'CREDENTIALS_PATH',
        'ANTHROPIC_API_URL',
        'COOLDOWN_MINUTES'
      ];

      for (const constant of requiredConstants) {
        assert.match(
          hookCode,
          new RegExp(`const ${constant} =`),
          `Must define ${constant} constant`
        );
      }
    });

    it('should have all required functions defined', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const requiredFunctions = [
        'getSessionDir',
        'getDeputyCtoCounts',
        'getUnreadReportsCount',
        'getAutonomousModeStatus',
        'getTokenUsage24h',
        'getSessionMetrics24h',
        'getTodoCounts',
        'formatTokens',
        'formatHours',
        'progressBar',
        'getQuotaStatus',
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

    it('should validate ES module structure', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should have shebang
      assert.match(hookCode, /^#!\/usr\/bin\/env node/, 'Must have node shebang');

      // Should use ES module imports
      assert.match(hookCode, /import .* from .*;/, 'Must use ES module imports');

      // Should use fileURLToPath for __dirname
      assert.match(hookCode, /fileURLToPath\(import\.meta\.url\)/, 'Must use fileURLToPath for ES modules');
    });

    it('should handle spawned sessions correctly', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Main function should skip for spawned sessions
      const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];
      assert.match(
        mainFunction,
        /if \(process\.env\.CLAUDE_SPAWNED_SESSION === 'true'\)/,
        'Must check for spawned session'
      );

      assert.match(
        mainFunction,
        /suppressOutput: true/,
        'Must suppress output for spawned sessions'
      );
    });
  });
});

describe('Path Sanitization - Security Validation', () => {
  const PROJECT_DIR = process.cwd();
  const HOOK_PATH = path.join(PROJECT_DIR, '.claude/hooks/cto-notification-hook.js');

  it('should prevent path traversal attacks via project directory name', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // The regex [^a-zA-Z0-9] removes all special characters including:
    // - Forward slashes (/)
    // - Backslashes (\)
    // - Dots (.)
    // - Path separators
    // This prevents paths like "../../../etc/passwd" from being constructed

    const getSessionDirFunction = hookCode.match(/function getSessionDir\(\) \{[\s\S]*?\n\}/)[0];

    // Verify the sanitization pattern
    assert.match(
      getSessionDirFunction,
      /\.replace\(\/\[\^a-zA-Z0-9\]\/g,\s*'-'\)/,
      'Must sanitize path to prevent directory traversal'
    );

    // Verify leading dash removal (prevents paths starting with -)
    assert.match(
      getSessionDirFunction,
      /\.replace\(\/\^-\/,\s*''\)/,
      'Must remove leading dash to prevent flag injection'
    );
  });

  it('should produce safe directory names for edge cases', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // Example transformations that should occur:
    // "/home/user/my_project" -> "home-user-my-project" -> "-home-user-my-project"
    // "/var/../etc/passwd" -> "var-etc-passwd" -> "-var-etc-passwd"
    // "project.with.dots" -> "project-with-dots" -> "-project-with-dots"
    // "../../../evil" -> "evil" -> "-evil"

    const getSessionDirFunction = hookCode.match(/function getSessionDir\(\) \{[\s\S]*?\n\}/)[0];

    // The function should:
    // 1. Replace ALL non-alphanumeric with dash
    assert.ok(
      getSessionDirFunction.includes('[^a-zA-Z0-9]'),
      'Must use character class that includes all non-alphanumeric'
    );

    // 2. Strip leading dash (from absolute paths)
    assert.ok(
      getSessionDirFunction.includes('/^-/'),
      'Must remove leading dash after sanitization'
    );

    // 3. Prepend dash to final result (Claude Code directory convention)
    assert.ok(
      getSessionDirFunction.includes('`-${projectPath}`'),
      'Must prepend dash to final directory name'
    );
  });
});

describe('Integration - Bug Fix Validation', () => {
  it('should document both bug fixes in code or comments', () => {
    const hookCode = fs.readFileSync(path.join(process.cwd(), '.claude/hooks/cto-notification-hook.js'), 'utf8');

    // While not strictly required, good practice would be to document breaking changes
    // Check if version was bumped (bug fixes should increment version)
    assert.match(
      hookCode,
      /@version \d+\.\d+\.\d+/,
      'Must have version number'
    );

    // Version should be at least 2.0.0 (indicating breaking changes were fixed)
    const versionMatch = hookCode.match(/@version (\d+)\.(\d+)\.(\d+)/);
    assert.ok(versionMatch, 'Must have valid version');

    const [_, major, minor, patch] = versionMatch;
    assert.ok(
      parseInt(major) >= 2,
      'Major version should be >= 2 after bug fixes'
    );
  });

  it('should not have any remaining references to old patterns', () => {
    const hookCode = fs.readFileSync(path.join(process.cwd(), '.claude/hooks/cto-notification-hook.js'), 'utf8');

    // Should NOT have the old slash-only pattern
    assert.doesNotMatch(
      hookCode,
      /PROJECT_DIR\.replace\(\/\\\/\/g/,
      'Must NOT use old slash-only replacement pattern'
    );

    // Should NOT parse history as direct array
    assert.doesNotMatch(
      hookCode,
      /const history = JSON\.parse\(content\);\s*for \(/,
      'Must NOT parse agent tracker history as direct array'
    );

    // Should NOT compare ISO string to milliseconds
    const hasDirectTimestampComparison = hookCode.includes('entry.timestamp >= since') &&
                                          !hookCode.includes('new Date(entry.timestamp)');
    assert.ok(
      !hasDirectTimestampComparison,
      'Must NOT compare ISO timestamp string directly to milliseconds'
    );
  });
});
