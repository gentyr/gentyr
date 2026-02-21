/**
 * Tests for /show slash command detection and prefetch
 *
 * Validates:
 * 1. SENTINELS map includes 'show' command
 * 2. matchesCommand() detects /show and sentinel marker
 * 3. handleShow() returns dashboard availability and section list
 * 4. main() routes /show to handleShow()
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/slash-command-prefetch-show.test.js
 *
 * @version 1.0.0
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.cwd();
const SLASH_COMMAND_PREFETCH_HOOK = path.join(PROJECT_DIR, '.claude/hooks/slash-command-prefetch.js');

describe('Slash Command Prefetch - /show Command', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(SLASH_COMMAND_PREFETCH_HOOK, 'utf8');
  });

  // ============================================================================
  // SENTINELS Map
  // ============================================================================

  describe('SENTINELS map', () => {
    it('should include "show" command', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.ok(sentinelsMatch, 'SENTINELS constant must exist');

      const sentinelsObject = sentinelsMatch[0];
      assert.match(sentinelsObject, /'show':/);
    });

    it('should have sentinel marker for "show" command', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      const sentinelsObject = sentinelsMatch[0];

      // Sentinel should be: '<!-- HOOK:GENTYR:show -->'
      assert.match(sentinelsObject, /'show':\s*'<!-- HOOK:GENTYR:show -->'/);
    });
  });

  // ============================================================================
  // matchesCommand() Detection
  // ============================================================================

  describe('matchesCommand() detection', () => {
    it('should detect bare slash command "/show"', () => {
      // matchesCommand checks: text.trim() === `/${commandName}`
      const matchesCommandMatch = hookCode.match(/function matchesCommand\(text, commandName\) \{[\s\S]*?\n\}/);
      assert.ok(matchesCommandMatch, 'matchesCommand function must exist');

      const functionBody = matchesCommandMatch[0];
      assert.match(functionBody, /text\.trim\(\) === `\/\$\{commandName\}`/);
    });

    it('should detect sentinel marker for "show"', () => {
      // matchesCommand checks: text.includes(SENTINELS[commandName])
      const matchesCommandMatch = hookCode.match(/function matchesCommand\(text, commandName\) \{[\s\S]*?\n\}/);
      const functionBody = matchesCommandMatch[0];
      assert.match(functionBody, /text\.includes\(SENTINELS\[commandName\]\)/);
    });
  });

  // ============================================================================
  // handleShow() Function
  // ============================================================================

  describe('handleShow() function', () => {
    it('should define handleShow function', () => {
      assert.match(hookCode, /function handleShow\(/);
    });

    it('should check for .claude-framework symlink', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleShowMatch, 'handleShow function must exist');

      const functionBody = handleShowMatch[0];
      assert.match(functionBody, /\.claude-framework/);
    });

    it('should check for dashboard binary existence', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      // Check for path construction using path.join or literal string
      assert.ok(
        /packages.*cto-dashboard.*dist.*index\.js/.test(functionBody) ||
        /'cto-dashboard'/.test(functionBody),
        'Must check dashboard binary path'
      );
      assert.match(functionBody, /fs\.existsSync/);
    });

    it('should return dashboardAvailable flag', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      assert.match(functionBody, /dashboardAvailable:/);
    });

    it('should return availableSections list', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      assert.match(functionBody, /availableSections:/);
    });

    it('should include all 12 section IDs', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      // Should have an array with 12 sections
      const sections = [
        'quota', 'accounts', 'deputy-cto', 'usage', 'automations',
        'testing', 'deployments', 'worktrees', 'infra', 'logging',
        'timeline', 'tasks',
      ];

      for (const section of sections) {
        assert.match(functionBody, new RegExp(`'${section}'`));
      }
    });

    it('should output JSON with continue: true', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      assert.match(functionBody, /continue:\s*true/);
    });

    it('should output hookSpecificOutput with hookEventName', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      assert.match(functionBody, /hookEventName:\s*'UserPromptSubmit'/);
    });

    it('should include [PREFETCH:show] marker in additionalContext', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      assert.match(functionBody, /\[PREFETCH:show\]/);
    });

    it('should wrap output in JSON.stringify', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      assert.match(functionBody, /JSON\.stringify/);
    });

    it('should write to console.log not console.error', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      assert.match(functionBody, /console\.log/);
    });
  });

  // ============================================================================
  // main() Integration
  // ============================================================================

  describe('main() integration', () => {
    it('should route /show to handleShow()', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');

      const mainBody = mainMatch[0];
      assert.match(mainBody, /matchesCommand\(prompt, 'show'\)/);
      assert.match(mainBody, /handleShow\(\)/);
    });

    it('should call handleShow() when /show is detected', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const mainBody = mainMatch[0];

      // Should have: if (matchesCommand(prompt, 'show')) { return handleShow(); }
      const showBlock = mainBody.match(/if \(matchesCommand\(prompt, 'show'\)\) \{[\s\S]*?handleShow\(\)[\s\S]*?\}/);
      assert.ok(showBlock, '/show command must route to handleShow()');
    });

    it('should include show in slash commands list', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const mainBody = mainMatch[0];

      // All SENTINELS commands should have handlers in main()
      assert.match(mainBody, /matchesCommand\(.*'show'\)/);
    });
  });

  // ============================================================================
  // Output Structure
  // ============================================================================

  describe('Output structure', () => {
    it('should match Mode 2 handler pattern (continue: true)', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      // Mode 2 handlers return continue: true and provide data
      assert.match(functionBody, /continue:\s*true/);
    });

    it('should provide gathered data in output', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      assert.match(functionBody, /gathered:/);
    });

    it('should set command field to "show"', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      assert.match(functionBody, /command:\s*'show'/);
    });
  });

  // ============================================================================
  // Framework Path Resolution
  // ============================================================================

  describe('Framework path resolution', () => {
    it('should construct framework path from .claude-framework symlink', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      assert.match(functionBody, /path\.join.*PROJECT_DIR.*\.claude-framework/);
    });

    it('should use fs.realpathSync to follow symlink', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      assert.match(functionBody, /fs\.realpathSync/);
    });

    it('should handle missing symlink gracefully', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      // Should have try-catch or existsSync check
      assert.ok(
        /try \{/.test(functionBody) || /fs\.existsSync/.test(functionBody),
        'Must handle missing symlink gracefully'
      );
    });

    it('should check dashboard binary path', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      // Check for path construction using path.join or literal string
      assert.ok(
        /packages.*cto-dashboard.*dist.*index\.js/.test(functionBody) ||
        /'cto-dashboard'/.test(functionBody),
        'Must check dashboard binary path'
      );
    });
  });

  // ============================================================================
  // Section List Validation
  // ============================================================================

  describe('Section list validation', () => {
    it('should include quota section', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];
      assert.match(functionBody, /'quota'/);
    });

    it('should include deputy-cto section', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];
      assert.match(functionBody, /'deputy-cto'/);
    });

    it('should include deployments section', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];
      assert.match(functionBody, /'deployments'/);
    });

    it('should include timeline section', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];
      assert.match(functionBody, /'timeline'/);
    });

    it('should include tasks section', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];
      assert.match(functionBody, /'tasks'/);
    });
  });

  // ============================================================================
  // Error Handling
  // ============================================================================

  describe('Error handling', () => {
    it('should not throw when framework directory missing', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      // Must have error handling via try-catch or existsSync
      assert.ok(
        /try \{/.test(functionBody) && /catch/.test(functionBody),
        'Must handle errors gracefully'
      );
    });

    it('should set dashboardAvailable to false when binary missing', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleShowMatch[0];

      // Should have logic to set dashboardExists = false
      assert.match(functionBody, /dashboardExists\s*=\s*false/);
    });
  });

  // ============================================================================
  // Consistency with Other Handlers
  // ============================================================================

  describe('Consistency with other Mode 2 handlers', () => {
    it('should use same output pattern as handleCtoReport', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const handleCtoReportMatch = hookCode.match(/function handleCtoReport\(\) \{[\s\S]*?\n\}/);

      assert.ok(handleCtoReportMatch, 'handleCtoReport must exist for comparison');

      const showBody = handleShowMatch[0];
      const ctoBody = handleCtoReportMatch[0];

      // Both should have: { continue: true, hookSpecificOutput: {...} }
      assert.match(showBody, /continue:\s*true/);
      assert.match(ctoBody, /continue:\s*true/);
      assert.match(showBody, /hookSpecificOutput:/);
      assert.match(ctoBody, /hookSpecificOutput:/);
    });

    it('should use same hookEventName as other handlers', () => {
      const handleShowMatch = hookCode.match(/function handleShow\(\) \{[\s\S]*?\n\}/);
      const showBody = handleShowMatch[0];

      assert.match(showBody, /hookEventName:\s*'UserPromptSubmit'/);
    });
  });
});

describe('Slash Command Prefetch - /show Integration', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(SLASH_COMMAND_PREFETCH_HOOK, 'utf8');
  });

  it('should include /show in commands list alongside other commands', () => {
    const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
    const mainBody = mainMatch[0];

    // Should have handlers for all commands including show
    const commands = [
      'restart-session',
      'cto-report',
      'deputy-cto',
      'toggle-automation',
      'overdrive',
      'setup-gentyr',
      'push-migrations',
      'push-secrets',
      'configure-personas',
      'spawn-tasks',
      'show'
    ];

    for (const cmd of commands) {
      assert.match(mainBody, new RegExp(`matchesCommand\\(.*'${cmd}'\\)`));
    }
  });

  it('should have 13 total slash commands (including show)', () => {
    const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
    const sentinelsObject = sentinelsMatch[0];

    // Count command definitions
    const commandCount = (sentinelsObject.match(/'[\w-]+':/g) || []).length;
    assert.strictEqual(commandCount, 13, 'Should have 13 slash commands total');
  });

  it('should place /show handler in correct position in main()', () => {
    const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
    const mainBody = mainMatch[0];

    // show should be after all DB-dependent commands
    const showIndex = mainBody.indexOf("matchesCommand(prompt, 'show')");
    const spawnTasksIndex = mainBody.indexOf("matchesCommand(prompt, 'spawn-tasks')");

    assert.ok(showIndex > spawnTasksIndex, '/show handler should come after spawn-tasks');
  });
});
