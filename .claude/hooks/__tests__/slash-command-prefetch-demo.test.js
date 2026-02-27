/**
 * Tests for /demo, /demo-interactive, and /demo-autonomous slash command detection and prefetch
 *
 * Validates:
 * 1. SENTINELS map includes 'demo', 'demo-interactive', and 'demo-autonomous' commands
 * 2. All three aliases share the same '<!-- HOOK:GENTYR:demo -->' sentinel value
 * 3. matchesCommand() detects each command by bare slash name and by sentinel
 * 4. handleDemo() gathers the expected preflight readiness data
 * 5. main() routes /demo, /demo-interactive, and /demo-autonomous to handleDemo()
 * 6. The updated SENTINELS count (17) is consistent
 * 7. Demo commands ARE in needsDb — they query user-feedback.db for enabled scenarios
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/slash-command-prefetch-demo.test.js
 *
 * @version 2.0.0
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const SLASH_COMMAND_PREFETCH_HOOK = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'slash-command-prefetch.js');

describe('Slash Command Prefetch - /demo, /demo-interactive, /demo-autonomous Commands', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(SLASH_COMMAND_PREFETCH_HOOK, 'utf8');
  });

  // ============================================================================
  // SENTINELS Map — all three demo commands
  // ============================================================================

  describe('SENTINELS map', () => {
    it('should include "demo" command', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.ok(sentinelsMatch, 'SENTINELS constant must exist');
      assert.match(sentinelsMatch[0], /'demo':/);
    });

    it('should include "demo-interactive" command', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.ok(sentinelsMatch, 'SENTINELS constant must exist');
      assert.match(sentinelsMatch[0], /'demo-interactive':/);
    });

    it('should include "demo-autonomous" command', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.ok(sentinelsMatch, 'SENTINELS constant must exist');
      assert.match(sentinelsMatch[0], /'demo-autonomous':/);
    });

    it('should map "demo" to the demo sentinel marker', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.match(sentinelsMatch[0], /'demo':\s*'<!-- HOOK:GENTYR:demo -->'/);
    });

    it('should map "demo-interactive" to the same demo sentinel marker', () => {
      // Both aliases share the same sentinel so the prefetch data is gathered once
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.match(sentinelsMatch[0], /'demo-interactive':\s*'<!-- HOOK:GENTYR:demo -->'/);
    });

    it('should map "demo-autonomous" to the same demo sentinel marker', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.match(sentinelsMatch[0], /'demo-autonomous':\s*'<!-- HOOK:GENTYR:demo -->'/);
    });

    it('should have 17 total sentinel entries after adding demo-interactive and demo-autonomous', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.ok(sentinelsMatch, 'SENTINELS constant must exist');
      const commandCount = (sentinelsMatch[0].match(/'[\w-]+':/g) || []).length;
      assert.strictEqual(commandCount, 17, 'Should have 17 slash commands total');
    });
  });

  // ============================================================================
  // matchesCommand() Detection
  // ============================================================================

  describe('matchesCommand() detection', () => {
    it('should detect bare slash command by name template literal', () => {
      const matchesCommandMatch = hookCode.match(/function matchesCommand\(text, commandName\) \{[\s\S]*?\n\}/);
      assert.ok(matchesCommandMatch, 'matchesCommand function must exist');
      assert.match(matchesCommandMatch[0], /text\.trim\(\) === `\/\$\{commandName\}`/);
    });

    it('should detect sentinel marker via text.includes', () => {
      const matchesCommandMatch = hookCode.match(/function matchesCommand\(text, commandName\) \{[\s\S]*?\n\}/);
      assert.ok(matchesCommandMatch, 'matchesCommand function must exist');
      assert.match(matchesCommandMatch[0], /text\.includes\(SENTINELS\[commandName\]\)/);
    });
  });

  // ============================================================================
  // handleDemo() Function
  // ============================================================================

  describe('handleDemo() function', () => {
    it('should define handleDemo function', () => {
      assert.match(hookCode, /function handleDemo\(/);
    });

    it('should check playwright.config.ts existence', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /playwright\.config\.ts/);
    });

    it('should check @playwright/test dependency', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /@playwright\/test/);
    });

    it('should check for Chromium browser in cache', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /chromium-/);
    });

    it('should check credentials by scanning all env vars for unresolved op:// references (project-agnostic)', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      // The credential check scans all env vars for unresolved 1Password references.
      // It is project-agnostic — no longer hardcodes specific key names like SUPABASE_URL.
      assert.match(handleDemoMatch[0], /op:\/\//);
      assert.match(handleDemoMatch[0], /process\.env/);
      // credentialsOk is the aggregated result field
      assert.match(handleDemoMatch[0], /credentialsOk/);
    });

    it('should check auth state freshness', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /authState/);
    });

    it('should return command field set to "demo"', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /command:\s*'demo'/);
    });

    it('should return gathered object with readyForPreflight', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /readyForPreflight/);
    });

    it('should return gathered object with criticalIssues', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /criticalIssues/);
    });

    it('should output JSON with continue: true', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /continue:\s*true/);
    });

    it('should output hookSpecificOutput with hookEventName: UserPromptSubmit', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /hookEventName:\s*'UserPromptSubmit'/);
    });

    it('should include [PREFETCH:demo] marker in additionalContext', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /\[PREFETCH:demo\]/);
    });

    it('should write to console.log not console.error', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /console\.log/);
    });
  });

  // ============================================================================
  // main() routing — all three aliases must call handleDemo()
  // ============================================================================

  describe('main() routing', () => {
    it('should route /demo to handleDemo()', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');
      assert.match(mainMatch[0], /matchesCommand\(prompt, 'demo'\)/);
      assert.match(mainMatch[0], /handleDemo\(\)/);
    });

    it('should route /demo-interactive to handleDemo()', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');
      assert.match(mainMatch[0], /matchesCommand\(prompt, 'demo-interactive'\)/);
    });

    it('should route /demo-autonomous to handleDemo()', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');
      assert.match(mainMatch[0], /matchesCommand\(prompt, 'demo-autonomous'\)/);
    });

    it('should have a dedicated if-block for /demo-interactive routing', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');
      const demoInteractiveBlock = mainMatch[0].match(
        /if \(matchesCommand\(prompt, 'demo-interactive'\)\) \{[\s\S]*?handleDemo\(\)/
      );
      assert.ok(demoInteractiveBlock, '/demo-interactive must have its own if-block routing to handleDemo()');
    });

    it('should have a dedicated if-block for /demo-autonomous routing', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');
      const demoAutonomousBlock = mainMatch[0].match(
        /if \(matchesCommand\(prompt, 'demo-autonomous'\)\) \{[\s\S]*?handleDemo\(\)/
      );
      assert.ok(demoAutonomousBlock, '/demo-autonomous must have its own if-block routing to handleDemo()');
    });

    it('should handle all commands including all three demo variants', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');

      const demoCommands = ['demo', 'demo-interactive', 'demo-autonomous'];
      for (const cmd of demoCommands) {
        assert.match(
          mainMatch[0],
          new RegExp(`matchesCommand\\(.*'${cmd}'\\)`),
          `main() must handle /${cmd}`
        );
      }
    });
  });

  // ============================================================================
  // Output Structure — validate Mode 2 handler contract
  // ============================================================================

  describe('Output structure', () => {
    it('should match Mode 2 handler pattern (continue: true)', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /continue:\s*true/);
    });

    it('should provide gathered data in output', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /gathered:/);
    });

    it('should use same output pattern as handleCtoReport (hookSpecificOutput wrapper)', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      const handleCtoReportMatch = hookCode.match(/function handleCtoReport\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo must exist');
      assert.ok(handleCtoReportMatch, 'handleCtoReport must exist for comparison');

      // Both must use the same hookSpecificOutput structure
      assert.match(handleDemoMatch[0], /hookSpecificOutput:/);
      assert.match(handleCtoReportMatch[0], /hookSpecificOutput:/);
      assert.match(handleDemoMatch[0], /continue:\s*true/);
      assert.match(handleCtoReportMatch[0], /continue:\s*true/);
    });
  });

  // ============================================================================
  // discoveredProjects — Playwright config project discovery
  // ============================================================================

  describe('discoveredProjects gathering', () => {
    it('should populate discoveredProjects when config file is found', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /discoveredProjects/);
    });

    it('should read playwright config file content to discover project names', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      // Must read the config file
      assert.match(handleDemoMatch[0], /readFileSync.*configFile/);
    });

    it('should use regex to extract name: "..." patterns from config', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      // The name extraction regex: name: 'project-name' or name: "project-name"
      assert.match(handleDemoMatch[0], /nameRegex/);
    });

    it('should assign matched names into an array', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /projectNames\.push/);
    });

    it('should set discoveredProjects to empty array when no config file exists', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      // Fallback when configFile is null
      assert.match(handleDemoMatch[0], /discoveredProjects.*\[\]/);
    });

    it('should set discoveredProjects to empty array on read error', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      // Must have a catch block that falls back to []
      assert.match(handleDemoMatch[0], /catch[\s\S]*?discoveredProjects.*\[\]/);
    });

    it('should only discover projects when configFile is non-null', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      // configFile is derived from the tsConfig / jsConfig existence check
      assert.match(handleDemoMatch[0], /configFile/);
      assert.match(handleDemoMatch[0], /if \(configFile\)/);
    });

    it('should include discoveredProjects in the gathered output object', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      // Must write to output.gathered.discoveredProjects
      assert.match(handleDemoMatch[0], /output\.gathered\.discoveredProjects/);
    });
  });

  // ============================================================================
  // Consistency checks — demo commands DO require a database (scenario queries)
  // ============================================================================

  describe('Database requirements', () => {
    it('should include "demo" in needsDb array (queries user-feedback.db for scenarios)', () => {
      const needsDbMatch = hookCode.match(/const needsDb = \[[\s\S]*?\];/);
      assert.ok(needsDbMatch, 'needsDb array must exist');
      // demo commands query user-feedback.db for enabled demo scenarios
      assert.match(needsDbMatch[0], /'demo'/);
    });

    it('should include "demo-interactive" in needsDb array', () => {
      const needsDbMatch = hookCode.match(/const needsDb = \[[\s\S]*?\];/);
      assert.ok(needsDbMatch, 'needsDb array must exist');
      assert.match(needsDbMatch[0], /'demo-interactive'/);
    });

    it('should include "demo-autonomous" in needsDb array', () => {
      const needsDbMatch = hookCode.match(/const needsDb = \[[\s\S]*?\];/);
      assert.ok(needsDbMatch, 'needsDb array must exist');
      assert.match(needsDbMatch[0], /'demo-autonomous'/);
    });
  });

  // ============================================================================
  // personaGroups computation — two-step persona → scenario selection
  // ============================================================================

  describe('personaGroups computation', () => {
    it('should include personaGroups field in the gathered output', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /output\.gathered\.personaGroups/);
    });

    it('should group scenarios by persona_name using a Map', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      // Must create a Map keyed by persona name and iterate over scenarios to populate it
      assert.match(handleDemoMatch[0], /const personaMap = new Map\(\)/);
      assert.match(handleDemoMatch[0], /personaMap\.has\(s\.persona_name\)/);
      assert.match(handleDemoMatch[0], /personaMap\.set\(s\.persona_name/);
    });

    it('should include persona_name field on each persona group object', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /persona_name:\s*s\.persona_name/);
    });

    it('should include playwright_project field on each persona group object', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      // The top-level group object must carry playwright_project so the command knows
      // which Playwright project to pass to run_demo without drilling into a scenario
      assert.match(handleDemoMatch[0], /playwright_project:\s*s\.playwright_project/);
    });

    it('should include scenarios array field on each persona group object', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /scenarios:\s*\[\]/);
    });

    it('should include playwright_project on each individual scenario object inside the group', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      // Critical: each scenario pushed into the group's scenarios[] array must also carry
      // playwright_project so commands that iterate individual scenarios can use it directly
      // without referencing the parent group.  This was a bug found in code review.
      const pushBlock = handleDemoMatch[0].match(/personaMap\.get\(s\.persona_name\)\.scenarios\.push\(\{[\s\S]*?\}\)/);
      assert.ok(pushBlock, 'scenarios.push() block must exist');
      assert.match(pushBlock[0], /playwright_project:\s*s\.playwright_project/);
    });

    it('should spread Map values into an array for personaGroups', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /\[\.\.\.personaMap\.values\(\)\]/);
    });

    it('should set personaGroups to [] in the catch branch', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      // The catch block following the scenarios query must reset personaGroups to []
      const catchBlock = handleDemoMatch[0].match(/\} catch \{[\s\S]*?\} finally \{/);
      assert.ok(catchBlock, 'catch block must exist before finally');
      assert.match(catchBlock[0], /output\.gathered\.personaGroups\s*=\s*\[\]/);
    });

    it('should set personaGroups to [] when scenariosDb is falsy (inner else — openDb returned null)', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      // The else branch of `if (scenariosDb)` sets personaGroups to []
      // The inner else sits between the `} finally {` close and the outer `} else {`
      const innerElseBlock = handleDemoMatch[0].match(/scenariosDb\.close\(\);\s*\}\s*\} else \{[\s\S]*?\}/);
      assert.ok(innerElseBlock, 'inner else branch (scenariosDb falsy) must exist');
      assert.match(innerElseBlock[0], /output\.gathered\.personaGroups\s*=\s*\[\]/);
    });

    it('should set personaGroups to [] when USER_FEEDBACK_DB does not exist (outer else)', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      // The outer else branch of `if (fs.existsSync(USER_FEEDBACK_DB))` must also set personaGroups to []
      // Capture the final else block after the closing of the `if (scenariosDb)` chain
      const outerElseBlock = handleDemoMatch[0].match(/\} else \{\s*output\.gathered\.scenarios\s*=\s*\[\];\s*output\.gathered\.scenarioCount\s*=\s*0;\s*output\.gathered\.personaGroups\s*=\s*\[\];\s*\}/);
      assert.ok(outerElseBlock, 'outer else branch (USER_FEEDBACK_DB missing) must set personaGroups to []');
    });
  });

  // ============================================================================
  // testCounts — file counting includes .demo.ts
  // ============================================================================

  describe('testCounts file counting', () => {
    it('should count .demo.ts files alongside .spec.ts and .manual.ts in testCounts', () => {
      // The testCounts filter in handleDemo() must include .demo.ts suffix.
      // This was added as part of the demo system improvements so that prefetch
      // data accurately reflects total test/demo file counts per project.
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');

      // The filter that populates testCounts must include .demo.ts
      assert.match(
        handleDemoMatch[0],
        /\.demo\.ts/,
        'testCounts filter must include .demo.ts files'
      );
    });

    it('should count .spec.ts files in testCounts', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /\.spec\.ts/);
    });

    it('should count .manual.ts files in testCounts', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /\.manual\.ts/);
    });

    it('should use readdirSync with recursive:true to count test files', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /readdirSync.*recursive.*true/s);
    });

    it('should store testCounts per project in gathered output', () => {
      const handleDemoMatch = hookCode.match(/function handleDemo\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleDemoMatch, 'handleDemo function must exist');
      assert.match(handleDemoMatch[0], /testCounts/);
    });
  });
});
