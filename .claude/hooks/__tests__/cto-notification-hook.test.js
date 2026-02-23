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

  describe('getSessionMetricsCached() - Incremental Cache', () => {
    // getSessionMetrics24h() and getTokenUsage24h() were replaced by
    // getSessionMetricsCached() + scanSessionFile() which use an incremental
    // disk cache and a 30-day window instead of a 24-hour window.

    it('should define getSessionMetricsCached() function', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /function getSessionMetricsCached\(\)/,
        'Must define getSessionMetricsCached() function'
      );
    });

    it('should define scanSessionFile() helper', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /function scanSessionFile\(filePath, since\)/,
        'Must define scanSessionFile() helper function'
      );
    });

    it('should convert ISO timestamp strings to milliseconds in scanSessionFile', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // The timestamp conversion was moved to scanSessionFile()
      assert.match(
        hookCode,
        /new Date\(entry\.timestamp\)\.getTime\(\)/,
        'Must convert entry.timestamp to milliseconds using new Date().getTime()'
      );

      // Should NOT compare string timestamp directly
      assert.doesNotMatch(
        hookCode,
        /if \(entry\.timestamp >= since\)/,
        'Must NOT compare ISO string timestamp directly to milliseconds'
      );
    });

    it('should validate getSessionMetricsCached function structure', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function getSessionMetricsCached\(\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'getSessionMetricsCached() function must exist');

      const functionBody = functionMatch[0];

      // 1. Must get session directory and establish time window
      assert.match(functionBody, /getSessionDir\(\)/, 'Must call getSessionDir()');

      // 2. Must read session directory for .jsonl files
      assert.match(functionBody, /readdirSync\(sessionDir\)/, 'Must read session directory');
      assert.match(functionBody, /\.filter\(f => f\.endsWith\('\.jsonl'\)\)/, 'Must filter for .jsonl files');

      // 3. Must use incremental cache (load and save)
      assert.match(functionBody, /loadMetricsCache\(\)/, 'Must load metrics cache');
      assert.match(functionBody, /saveMetricsCache\(cache\)/, 'Must save metrics cache');

      // 4. Must track task and user sessions
      assert.match(functionBody, /taskSessions/, 'Must track task session count');
      assert.match(functionBody, /userSessions/, 'Must track user session count');
    });

    it('should handle missing session directory gracefully', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function getSessionMetricsCached\(\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'getSessionMetricsCached() function must exist');
      const functionBody = functionMatch[0];

      // Should check if session directory exists before reading
      assert.match(
        functionBody,
        /if \(!fs\.existsSync\(sessionDir\)\)/,
        'Must check if session directory exists'
      );

      // Should return default metrics on missing directory
      assert.match(
        functionBody,
        /return \{ tokens: 0, taskSessions: 0, userSessions: 0 \}/,
        'Must return default zero metrics when session directory missing'
      );
    });

    it('should wrap file scanning in try-catch', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function getSessionMetricsCached\(\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'getSessionMetricsCached() function must exist');
      const functionBody = functionMatch[0];

      assert.match(functionBody, /try \{/, 'Must have try block for file operations');
      assert.match(functionBody, /\} catch/, 'Must have catch block for error handling');
    });
  });

  describe('Database Path Constants', () => {
    it('should define CTO_REPORTS_DB constant pointing to cto-reports.db', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // The MCP server for agent reports uses cto-reports.db as its backing file.
      // Both the hook and packages/mcp-servers/src/agent-reports/server.ts use this path.
      assert.match(
        hookCode,
        /const CTO_REPORTS_DB = path\.join\(PROJECT_DIR,\s*'\.claude',\s*'cto-reports\.db'\)/,
        'CTO_REPORTS_DB constant must point to cto-reports.db (the agent-reports MCP server backing file)'
      );
    });

    it('should document correct database in comments', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Comments should reference agent-reports (the MCP server name / logical name)
      assert.match(
        hookCode,
        /agent-reports/i,
        'Code must reference agent-reports (MCP server name)'
      );
    });
  });

  describe('Function Return Types - Fail-Closed Validation', () => {
    it('should return default values on errors (metrics are non-critical)', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // getSessionMetricsCached replaces the old getSessionMetrics24h and
      // getTokenUsage24h. It returns { tokens, taskSessions, userSessions }.
      const metricsFunction = hookCode.match(/function getSessionMetricsCached\(\) \{[\s\S]*?\n\}/);
      assert.ok(metricsFunction, 'getSessionMetricsCached() must exist');

      // Must return default zeros when session directory is missing
      assert.match(
        metricsFunction[0],
        /return \{ tokens: 0, taskSessions: 0, userSessions: 0 \}/,
        'Must return default zero values when session directory is missing'
      );

      // Token accumulator must start at 0 in cache totals
      assert.match(
        hookCode,
        /tokens: 0/,
        'Must initialize token totals to 0'
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
    it('should handle ISO timestamp strings correctly in scanSessionFile', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Timestamp handling was consolidated into scanSessionFile()
      const scanFn = hookCode.match(/function scanSessionFile\(filePath, since\) \{[\s\S]*?\n\}/);
      assert.ok(scanFn, 'scanSessionFile() function must exist');

      // Must check if timestamp exists before converting
      assert.match(
        scanFn[0],
        /if \(entry\.timestamp\)/,
        'Must check if timestamp exists'
      );

      // Must convert ISO string to milliseconds (not compare directly)
      assert.match(
        scanFn[0],
        /new Date\(entry\.timestamp\)\.getTime\(\)/,
        'Must convert entry.timestamp to milliseconds using new Date().getTime()'
      );
    });

    it('should calculate time window correctly in getSessionMetricsCached', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const metricsFunction = hookCode.match(/function getSessionMetricsCached\(\) \{[\s\S]*?\n\}/);
      assert.ok(metricsFunction, 'getSessionMetricsCached() function must exist');

      // Uses a 30-day window (replaces the old 24-hour window)
      assert.match(
        metricsFunction[0],
        /Date\.now\(\) - \(30 \* 24 \* 60 \* 60 \* 1000\)/,
        'Must calculate 30-day window in milliseconds'
      );
    });
  });

  describe('Slash Command Suppression - Bug Fix', () => {
    it('should parse JSON stdin to extract prompt field', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
      const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];

      // Must read from /dev/stdin
      assert.match(
        mainFunction,
        /fs\.readFileSync\('\/dev\/stdin'/,
        'Must read stdin to check for slash commands'
      );

      // Must parse JSON to extract prompt
      assert.match(
        mainFunction,
        /JSON\.parse\(stdin\)/,
        'Must parse JSON stdin'
      );

      // Must extract prompt field
      assert.match(
        mainFunction,
        /parsed\.prompt/,
        'Must extract prompt field from parsed JSON'
      );
    });

    it('should suppress output for sentinel markers', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
      const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];

      // Must check for HOOK:GENTYR: sentinel markers
      assert.match(
        mainFunction,
        /HOOK:GENTYR:/,
        'Must check for GENTYR sentinel markers'
      );

      // Must suppress output when sentinel detected
      assert.match(
        mainFunction,
        /suppressOutput: true/,
        'Must suppress output for slash commands'
      );
    });

    it('should suppress output for bare slash commands', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
      const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];

      // CRITICAL FIX: Must match bare slash commands like "/cto-report"
      // Pattern: /^\/[\w-]+$/
      assert.match(
        mainFunction,
        /\/\^\\\/\[\\w-\]\+\$\//,
        'Must match bare slash commands with /^\/[\\w-]+$/ pattern'
      );
    });

    it('should test extracted prompt, not raw stdin', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
      const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];

      // Must assign to prompt variable
      assert.match(
        mainFunction,
        /let prompt = stdin/,
        'Must assign stdin to prompt variable for testing'
      );

      // Must test against prompt, not stdin
      assert.match(
        mainFunction,
        /prompt\.includes\(/,
        'Must test prompt.includes() for sentinels'
      );

      assert.match(
        mainFunction,
        /\.test\(prompt\.trim\(\)\)/,
        'Must test prompt.trim() for slash command pattern'
      );
    });

    it('should handle JSON parse errors gracefully', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
      const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];

      // Must wrap stdin parsing in try-catch
      const stdinSection = mainFunction.match(/try \{[\s\S]*?fs\.readFileSync\('\/dev\/stdin'[\s\S]*?\} catch/);
      assert.ok(stdinSection, 'Must wrap stdin operations in try-catch');
    });

    it('should continue normally when stdin unavailable', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
      const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];

      // Catch block should continue to metrics gathering
      const catchBlock = mainFunction.match(/\} catch \{[\s\S]*?\/\/ No stdin available/);
      assert.ok(catchBlock, 'Catch block must continue normally when stdin unavailable');
    });

    it('should check for both sentinel and regex patterns', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
      const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];

      // Must have both checks in the same condition
      const slashCommandCheck = mainFunction.match(/if \(prompt\.includes\('<!-- HOOK:GENTYR:'\) \|\| \/\^\\\/\[\\w-\]\+\$\/\.test\(prompt\.trim\(\)\)\)/);
      assert.ok(slashCommandCheck, 'Must check both sentinel markers AND bare slash commands');
    });

    it('should fall back to raw stdin if JSON parse fails', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
      const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];

      // Must set prompt to stdin if parsing fails
      const stdinSection = mainFunction.match(/try \{[\s\S]*?const parsed = JSON\.parse\(stdin\);[\s\S]*?if \(typeof parsed\.prompt === 'string'\) prompt = parsed\.prompt;[\s\S]*?\} catch/);
      assert.ok(stdinSection, 'Must fall back to raw stdin if JSON parsing fails');
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

      // getSessionMetrics24h and getTokenUsage24h were replaced by
      // getSessionMetricsCached() and scanSessionFile() in the incremental
      // cache refactor.
      const requiredFunctions = [
        'getSessionDir',
        'getDeputyCtoCounts',
        'getUnreadReportsCount',
        'getAutonomousModeStatus',
        'scanSessionFile',
        'getSessionMetricsCached',
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

describe('hookSpecificOutput - UserPromptSubmit Protocol', () => {
  const PROJECT_DIR = process.cwd();
  const HOOK_PATH = path.join(PROJECT_DIR, '.claude/hooks/cto-notification-hook.js');

  it('should emit hookSpecificOutput with hookEventName UserPromptSubmit in the final console.log', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // The final console.log in main() must include hookSpecificOutput so the
    // Claude Code runtime injects additionalContext into the model's context window.
    assert.match(
      hookCode,
      /hookSpecificOutput:/,
      'main() final console.log must include hookSpecificOutput field',
    );

    assert.match(
      hookCode,
      /hookEventName:\s*'UserPromptSubmit'/,
      "hookEventName must be 'UserPromptSubmit'",
    );
  });

  it('should set additionalContext to the same message string as systemMessage', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // Extract the final console.log block (last JSON.stringify call in main()).
    // Both systemMessage and additionalContext must reference the same `message` variable
    // so the AI model context and terminal display stay in sync.
    const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];

    // The final output block must assign additionalContext: message
    assert.match(
      mainFunction,
      /additionalContext:\s*message/,
      'additionalContext must be set to the same `message` variable as systemMessage',
    );

    // And systemMessage must also be set to message
    assert.match(
      mainFunction,
      /systemMessage:\s*message/,
      'systemMessage must be set to the same `message` variable as additionalContext',
    );
  });

  it('should include hookSpecificOutput in the same object as systemMessage', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
    const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];

    // The final JSON.stringify call must have all four required fields together.
    // Extract the final console.log block by finding the last console.log.
    const lastConsoleLog = mainFunction.match(/console\.log\(JSON\.stringify\(\{[\s\S]*?\}\)\);\n\}/);
    assert.ok(lastConsoleLog, 'main() must have a final console.log(JSON.stringify(...))');

    const block = lastConsoleLog[0];
    assert.match(block, /continue:\s*true/, 'output must include continue: true');
    assert.match(block, /suppressOutput:\s*false/, 'output must include suppressOutput: false');
    assert.match(block, /systemMessage:\s*message/, 'output must include systemMessage: message');
    assert.match(block, /hookSpecificOutput:/, 'output must include hookSpecificOutput');
    assert.match(block, /additionalContext:\s*message/, 'output must include additionalContext: message');
  });

  it('should not include hookSpecificOutput in the spawned-session suppression path', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
    const mainFunction = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/)[0];

    // The spawned-session early-return path outputs { continue: true, suppressOutput: true }
    // only — no hookSpecificOutput.  Extract that block.
    const spawnedBlock = mainFunction.match(
      /if \(process\.env\.CLAUDE_SPAWNED_SESSION === 'true'\) \{[\s\S]*?\}/,
    );
    assert.ok(spawnedBlock, 'Must have spawned session guard');

    assert.doesNotMatch(
      spawnedBlock[0],
      /hookSpecificOutput/,
      'Spawned session path must not include hookSpecificOutput',
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
