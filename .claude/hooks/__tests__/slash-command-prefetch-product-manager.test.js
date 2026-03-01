/**
 * Tests for /product-manager slash command detection and prefetch
 *
 * Validates:
 * 1. SENTINELS map includes 'product-manager' command
 * 2. matchesCommand() detects /product-manager and sentinel marker
 * 3. handleProductManager() returns analysis status when DB exists
 * 4. main() routes /product-manager to handleProductManager()
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/slash-command-prefetch-product-manager.test.js
 *
 * @version 1.0.0
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const SLASH_COMMAND_PREFETCH_HOOK = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'slash-command-prefetch.js');

describe('Slash Command Prefetch - /product-manager Command', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(SLASH_COMMAND_PREFETCH_HOOK, 'utf8');
  });

  // ============================================================================
  // SENTINELS Map
  // ============================================================================

  describe('SENTINELS map', () => {
    it('should include "product-manager" command', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.ok(sentinelsMatch, 'SENTINELS constant must exist');

      const sentinelsObject = sentinelsMatch[0];
      assert.match(sentinelsObject, /'product-manager':/);
    });

    it('should have sentinel marker for "product-manager" command', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      const sentinelsObject = sentinelsMatch[0];

      // Sentinel should be: '<!-- HOOK:GENTYR:product-manager -->'
      assert.match(sentinelsObject, /'product-manager':\s*'<!-- HOOK:GENTYR:product-manager -->'/);
    });
  });

  // ============================================================================
  // matchesCommand() Detection
  // ============================================================================

  describe('matchesCommand() detection', () => {
    it('should detect bare slash command "/product-manager"', () => {
      const matchesCommandMatch = hookCode.match(/function matchesCommand\(text, commandName\) \{[\s\S]*?\n\}/);
      assert.ok(matchesCommandMatch, 'matchesCommand function must exist');

      const functionBody = matchesCommandMatch[0];
      assert.match(functionBody, /text\.trim\(\) === `\/\$\{commandName\}`/);
    });

    it('should detect sentinel marker for "product-manager"', () => {
      const matchesCommandMatch = hookCode.match(/function matchesCommand\(text, commandName\) \{[\s\S]*?\n\}/);
      const functionBody = matchesCommandMatch[0];
      assert.match(functionBody, /text\.includes\(SENTINELS\[commandName\]\)/);
    });
  });

  // ============================================================================
  // handleProductManager() Function
  // ============================================================================

  describe('handleProductManager() function', () => {
    it('should define handleProductManager function', () => {
      assert.match(hookCode, /function handleProductManager\(/);
    });

    it('should define PRODUCT_MANAGER_DB constant', () => {
      assert.match(hookCode, /const PRODUCT_MANAGER_DB = path\.join\(PROJECT_DIR, '\.claude', 'state', 'product-manager\.db'\)/);
    });

    it('should open database using openDb helper', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      assert.ok(handleProductManagerMatch, 'handleProductManager function must exist');

      const functionBody = handleProductManagerMatch[0];
      assert.match(functionBody, /openDb\(PRODUCT_MANAGER_DB\)/);
    });

    it('should include product-manager in needsDb array', () => {
      // Check that 'product-manager' is in the list of commands requiring DB
      const needsDbMatch = hookCode.match(/const needsDb = \[[\s\S]*?\];/);
      assert.ok(needsDbMatch, 'needsDb array must exist');

      const needsDbArray = needsDbMatch[0];
      assert.match(needsDbArray, /'product-manager'/);
    });

    it('should return command field set to "product-manager"', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      assert.match(functionBody, /command:\s*'product-manager'/);
    });

    it('should return gathered object', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      assert.match(functionBody, /gathered:\s*\{/);
    });

    it('should query analysis_meta table when DB exists', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      // Should query analysis_meta
      assert.match(functionBody, /SELECT.*FROM analysis_meta/);
    });

    it('should query sections table when DB exists', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      // Should query sections
      assert.match(functionBody, /SELECT.*FROM sections/);
    });

    it('should set note when DB does not exist', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      assert.match(functionBody, /output\.gathered\.note = 'product-manager\.db not found'/);
    });

    it('should output JSON with continue: true', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      assert.match(functionBody, /continue:\s*true/);
    });

    it('should output hookSpecificOutput with hookEventName', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      assert.match(functionBody, /hookEventName:\s*'UserPromptSubmit'/);
    });

    it('should include [PREFETCH:product-manager] marker in additionalContext', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      assert.match(functionBody, /\[PREFETCH:product-manager\]/);
    });

    it('should wrap output in JSON.stringify', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      assert.match(functionBody, /JSON\.stringify/);
    });

    it('should write to console.log not console.error', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      assert.match(functionBody, /console\.log/);
    });
  });

  // ============================================================================
  // main() Integration
  // ============================================================================

  describe('main() integration', () => {
    it('should route /product-manager to handleProductManager()', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');

      const mainBody = mainMatch[0];
      assert.match(mainBody, /matchesCommand\(prompt, 'product-manager'\)/);
      assert.match(mainBody, /handleProductManager\(\)/);
    });

    it('should call handleProductManager() when /product-manager is detected', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      const mainBody = mainMatch[0];

      // Should have: if (matchesCommand(prompt, 'product-manager')) { return handleProductManager(); }
      const productManagerBlock = mainBody.match(/if \(matchesCommand\(prompt, 'product-manager'\)\) \{[\s\S]*?handleProductManager\(\)[\s\S]*?\}/);
      assert.ok(productManagerBlock, '/product-manager command must route to handleProductManager()');
    });
  });

  // ============================================================================
  // Output Structure
  // ============================================================================

  describe('Output structure', () => {
    it('should match Mode 2 handler pattern (continue: true)', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      // Mode 2 handlers return continue: true and provide data
      assert.match(functionBody, /continue:\s*true/);
    });

    it('should provide gathered data in output', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      assert.match(functionBody, /gathered:/);
    });

    it('should set command field to "product-manager"', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      assert.match(functionBody, /command:\s*'product-manager'/);
    });
  });

  // ============================================================================
  // Error Handling
  // ============================================================================

  describe('Error handling', () => {
    it('should handle missing database gracefully', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      // Should have conditional logic for when openDb returns null/falsy
      assert.match(functionBody, /if \(pmDb\)|if \(!pmDb\)|else \{/);
    });

    it('should have try-catch for database operations', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      // Should have error handling
      assert.ok(
        /try \{/.test(functionBody) && /catch/.test(functionBody),
        'Must handle database errors gracefully'
      );
    });
  });

  // ============================================================================
  // Demo Scenario Coverage
  // ============================================================================

  describe('Demo scenario coverage', () => {
    it('should query user-feedback.db for GUI persona scenario coverage', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      // Should open user-feedback.db
      assert.match(functionBody, /openDb\(USER_FEEDBACK_DB\)/);
    });

    it('should query only enabled GUI-mode personas', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      // Query must filter on enabled=1 and consumption_mode='gui'
      assert.match(functionBody, /enabled = 1 AND consumption_mode = 'gui'/);
    });

    it('should query demo_scenarios table grouped by persona_id', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      assert.match(functionBody, /FROM demo_scenarios WHERE enabled = 1 GROUP BY persona_id/);
    });

    it('should output demoScenarios field with totalScenarios', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      // output.gathered.demoScenarios = { ... }
      assert.match(functionBody, /output\.gathered\.demoScenarios/);
      assert.match(functionBody, /totalScenarios:/);
    });

    it('should output guiPersonas array with scenarioCount per persona', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      assert.match(functionBody, /guiPersonas:/);
      assert.match(functionBody, /scenarioCount:/);
    });

    it('should output uncoveredPersonas list of GUI persona names with no scenarios', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      assert.match(functionBody, /uncoveredPersonas:/);
      // Filter logic: personas with no entry in scenarioMap
      assert.match(functionBody, /scenarioMap\[p\.id\]/);
    });

    it('should close user-feedback.db after query', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      // feedbackDb.close() must appear in the function
      assert.match(functionBody, /feedbackDb\.close\(\)/);
    });

    it('should silently ignore errors from user-feedback.db query', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const functionBody = handleProductManagerMatch[0];

      // The catch block for demoScenarios must be empty (non-fatal)
      assert.match(functionBody, /catch \{ \/\* non-fatal \*\/ \}|catch \{[^}]*\}/);
    });
  });

  // ============================================================================
  // Consistency with Other Handlers
  // ============================================================================

  describe('Consistency with other Mode 2 handlers', () => {
    it('should use same output pattern as handleCtoReport', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const handleCtoReportMatch = hookCode.match(/function handleCtoReport\(\) \{[\s\S]*?\n\}/);

      assert.ok(handleCtoReportMatch, 'handleCtoReport must exist for comparison');

      const productManagerBody = handleProductManagerMatch[0];
      const ctoBody = handleCtoReportMatch[0];

      // Both should have: { continue: true, hookSpecificOutput: {...} }
      assert.match(productManagerBody, /continue:\s*true/);
      assert.match(ctoBody, /continue:\s*true/);
      assert.match(productManagerBody, /hookSpecificOutput:/);
      assert.match(ctoBody, /hookSpecificOutput:/);
    });

    it('should use same hookEventName as other handlers', () => {
      const handleProductManagerMatch = hookCode.match(/function handleProductManager\(\) \{[\s\S]*?\n\}/);
      const productManagerBody = handleProductManagerMatch[0];

      assert.match(productManagerBody, /hookEventName:\s*'UserPromptSubmit'/);
    });
  });
});

describe('Slash Command Prefetch - /product-manager Integration', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(SLASH_COMMAND_PREFETCH_HOOK, 'utf8');
  });

  it('should include /product-manager in commands list alongside other commands', () => {
    const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
    const mainBody = mainMatch[0];

    // Should have handlers for all commands including product-manager
    const commands = [
      'cto-report',
      'deputy-cto',
      'toggle-automation',
      'overdrive',
      'setup-gentyr',
      'push-migrations',
      'push-secrets',
      'configure-personas',
      'spawn-tasks',
      'show',
      'product-manager'
    ];

    for (const cmd of commands) {
      assert.match(mainBody, new RegExp(`matchesCommand\\(.*'${cmd}'\\)`));
    }
  });

  it('should have 17 total slash commands (including demo-interactive and demo-autonomous)', () => {
    const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
    const sentinelsObject = sentinelsMatch[0];

    // Count command definitions
    const commandCount = (sentinelsObject.match(/'[\w-]+':/g) || []).length;
    assert.strictEqual(commandCount, 17, 'Should have 17 slash commands total');
  });

  it('should place /product-manager handler in correct position in main()', () => {
    const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
    const mainBody = mainMatch[0];

    // product-manager should be after database-dependent commands
    const productManagerIndex = mainBody.indexOf("matchesCommand(prompt, 'product-manager')");
    const showIndex = mainBody.indexOf("matchesCommand(prompt, 'show')");

    assert.ok(productManagerIndex > 0, '/product-manager handler must exist');
    assert.ok(productManagerIndex < showIndex, '/product-manager handler should come before /show');
  });
});
