/**
 * Tests for /demo, /demo-interactive, and /demo-auto slash command detection and prefetch
 *
 * Validates:
 * 1. SENTINELS map includes 'demo', 'demo-interactive', and 'demo-auto' commands
 * 2. All three aliases share the same '<!-- HOOK:GENTYR:demo -->' sentinel value
 * 3. matchesCommand() detects each command by bare slash name and by sentinel
 * 4. handleDemo() gathers the expected preflight readiness data
 * 5. main() routes /demo, /demo-interactive, and /demo-auto to handleDemo()
 * 6. The updated SENTINELS count (16) is consistent
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/slash-command-prefetch-demo.test.js
 *
 * @version 1.0.0
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const SLASH_COMMAND_PREFETCH_HOOK = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'slash-command-prefetch.js');

describe('Slash Command Prefetch - /demo, /demo-interactive, /demo-auto Commands', () => {
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

    it('should include "demo-auto" command', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.ok(sentinelsMatch, 'SENTINELS constant must exist');
      assert.match(sentinelsMatch[0], /'demo-auto':/);
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

    it('should map "demo-auto" to the same demo sentinel marker', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.match(sentinelsMatch[0], /'demo-auto':\s*'<!-- HOOK:GENTYR:demo -->'/);
    });

    it('should have 16 total sentinel entries after adding demo-interactive and demo-auto', () => {
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

    it('should route /demo-auto to handleDemo()', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');
      assert.match(mainMatch[0], /matchesCommand\(prompt, 'demo-auto'\)/);
    });

    it('should have a dedicated if-block for /demo-interactive routing', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');
      const demoInteractiveBlock = mainMatch[0].match(
        /if \(matchesCommand\(prompt, 'demo-interactive'\)\) \{[\s\S]*?handleDemo\(\)/
      );
      assert.ok(demoInteractiveBlock, '/demo-interactive must have its own if-block routing to handleDemo()');
    });

    it('should have a dedicated if-block for /demo-auto routing', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');
      const demoAutoBlock = mainMatch[0].match(
        /if \(matchesCommand\(prompt, 'demo-auto'\)\) \{[\s\S]*?handleDemo\(\)/
      );
      assert.ok(demoAutoBlock, '/demo-auto must have its own if-block routing to handleDemo()');
    });

    it('should handle all commands including all three demo variants', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');

      const demoCommands = ['demo', 'demo-interactive', 'demo-auto'];
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
  // Consistency checks — demo should NOT require a database
  // ============================================================================

  describe('Database requirements', () => {
    it('should NOT include "demo" in needsDb array (no DB access needed)', () => {
      const needsDbMatch = hookCode.match(/const needsDb = \[[\s\S]*?\];/);
      assert.ok(needsDbMatch, 'needsDb array must exist');
      // demo commands are filesystem-only checks, not DB-dependent
      assert.doesNotMatch(needsDbMatch[0], /'demo'/);
    });

    it('should NOT include "demo-interactive" in needsDb array', () => {
      const needsDbMatch = hookCode.match(/const needsDb = \[[\s\S]*?\];/);
      assert.ok(needsDbMatch, 'needsDb array must exist');
      assert.doesNotMatch(needsDbMatch[0], /'demo-interactive'/);
    });

    it('should NOT include "demo-auto" in needsDb array', () => {
      const needsDbMatch = hookCode.match(/const needsDb = \[[\s\S]*?\];/);
      assert.ok(needsDbMatch, 'needsDb array must exist');
      assert.doesNotMatch(needsDbMatch[0], /'demo-auto'/);
    });
  });
});
