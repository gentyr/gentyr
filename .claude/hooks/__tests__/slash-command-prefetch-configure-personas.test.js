/**
 * Tests for /configure-personas slash command detection and prefetch
 *
 * Validates:
 * 1. SENTINELS map includes 'configure-personas' command
 * 2. matchesCommand() detects /configure-personas and sentinel marker
 * 3. detectProjectFeatures() scans route/feature/component directories with caps
 * 4. handleConfigurePersonas() integrates feature detector and persona/feature queries
 * 5. main() routes /configure-personas to handleConfigurePersonas()
 * 6. The total SENTINELS count (16) is unchanged
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/slash-command-prefetch-configure-personas.test.js
 *
 * @version 2.0.0
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const SLASH_COMMAND_PREFETCH_HOOK = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'slash-command-prefetch.js');

describe('Slash Command Prefetch - /configure-personas Command', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(SLASH_COMMAND_PREFETCH_HOOK, 'utf8');
  });

  // ============================================================================
  // SENTINELS Map
  // ============================================================================

  describe('SENTINELS map', () => {
    it('should include "configure-personas" command', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.ok(sentinelsMatch, 'SENTINELS constant must exist');
      assert.match(sentinelsMatch[0], /'configure-personas':/);
    });

    it('should map "configure-personas" to the correct sentinel marker', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.ok(sentinelsMatch, 'SENTINELS constant must exist');
      assert.match(sentinelsMatch[0], /'configure-personas':\s*'<!-- HOOK:GENTYR:configure-personas -->'/);
    });

    it('should have 16 total sentinel entries', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.ok(sentinelsMatch, 'SENTINELS constant must exist');
      const commandCount = (sentinelsMatch[0].match(/'[\w-]+':/g) || []).length;
      assert.strictEqual(commandCount, 16, 'Should have 16 slash commands total');
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
  // detectProjectFeatures() Function
  // ============================================================================

  describe('detectProjectFeatures() function', () => {
    it('should define detectProjectFeatures function', () => {
      assert.match(hookCode, /function detectProjectFeatures\(/);
    });

    it('should NOT define detect' + 'Project' + 'Type function (project analysis is done by the agent)', () => {
      assert.doesNotMatch(hookCode, new RegExp('function detect' + 'Project' + 'Type\\('));
    });

    it('should define EXCLUDE set with node_modules', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /EXCLUDE.*new Set/);
      assert.match(fnMatch[0], /node_modules/);
    });

    it('should define EXCLUDE set with .git', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /\.git/);
    });

    it('should define EXCLUDE set with .next', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /\.next/);
    });

    it('should define EXCLUDE set with dist', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /'dist'/);
    });

    it('should define EXCLUDE set with build', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /'build'/);
    });

    it('should define EXCLUDE set with coverage', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /'coverage'/);
    });

    it('should define EXCLUDE set with .cache', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /\.cache/);
    });

    it('should define MAX_FEATURES cap of 20', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /MAX_FEATURES\s*=\s*20/);
    });

    it('should scan "app" route directory', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /base:\s*'app'/);
    });

    it('should scan "src/app" route directory', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /src.*app/);
    });

    it('should scan "routes" route directory', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /base:\s*'routes'/);
    });

    it('should scan "src/routes" route directory', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /src.*routes/);
    });

    it('should scan "pages" route directory', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /base:\s*'pages'/);
    });

    it('should scan "src/pages" route directory', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /src.*pages/);
    });

    it('should scan "src/features" feature directory', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /src.*features/);
    });

    it('should scan "src/modules" module directory', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /src.*modules/);
    });

    it('should scan "lib" lib directory', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /base:\s*'lib'/);
    });

    it('should scan "src/components" component directory', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /src.*components/);
    });

    it('should return objects with name field', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /name:/);
    });

    it('should return objects with suggested_file_patterns field', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /suggested_file_patterns:/);
    });

    it('should return objects with suggested_url_patterns field', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /suggested_url_patterns:/);
    });

    it('should return objects with category field', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /category:/);
    });

    it('should return objects with source field', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /source:/);
    });

    it('should enforce MAX_FEATURES cap with boundary check', () => {
      const fnMatch = hookCode.match(/function detectProjectFeatures\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'detectProjectFeatures function must exist');
      assert.match(fnMatch[0], /features\.length >= MAX_FEATURES/);
    });
  });

  // ============================================================================
  // handleConfigurePersonas() Function
  // ============================================================================

  describe('handleConfigurePersonas() function', () => {
    it('should define handleConfigurePersonas function', () => {
      assert.match(hookCode, /function handleConfigurePersonas\(/);
    });

    it('should call detectProjectFeatures() and store result in output.gathered.detectedFeatures', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /detectProjectFeatures\(\)/);
      assert.match(fnMatch[0], /gathered\.detectedFeatures/);
    });

    it('should NOT call detect' + 'Project' + 'Type (project analysis delegated to agent)', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.doesNotMatch(fnMatch[0], new RegExp('detect' + 'Project' + 'Type\\(\\)'));
      assert.doesNotMatch(fnMatch[0], new RegExp('gathered\\.' + 'project' + 'Type'));
    });

    it('should query personas from user-feedback.db', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /SELECT.*FROM personas/);
    });

    it('should query features from user-feedback.db', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /SELECT.*FROM features/);
    });

    it('should query persona_features mappings', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /SELECT.*FROM persona_features/);
    });

    it('should store personas in output.gathered.personas', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /gathered\.personas/);
    });

    it('should store features in output.gathered.features', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /gathered\.features/);
    });

    it('should store mappings in output.gathered.mappings', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /gathered\.mappings/);
    });

    it('should return command field set to "configure-personas"', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /command:\s*'configure-personas'/);
    });

    it('should output JSON with continue: true', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /continue:\s*true/);
    });

    it('should output hookSpecificOutput with hookEventName: UserPromptSubmit', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /hookEventName:\s*'UserPromptSubmit'/);
    });

    it('should include [PREFETCH:configure-personas] marker in additionalContext', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /\[PREFETCH:configure-personas\]/);
    });

    it('should write to console.log not console.error', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /console\.log/);
    });

    it('should use hookSpecificOutput wrapper (same pattern as handleCtoReport)', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      const ctoReportMatch = hookCode.match(/function handleCtoReport\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas must exist');
      assert.ok(ctoReportMatch, 'handleCtoReport must exist for comparison');
      assert.match(fnMatch[0], /hookSpecificOutput:/);
      assert.match(ctoReportMatch[0], /hookSpecificOutput:/);
    });

    it('should include "configure-personas" in needsDb array', () => {
      const needsDbMatch = hookCode.match(/const needsDb = \[[\s\S]*?\];/);
      assert.ok(needsDbMatch, 'needsDb array must exist');
      assert.match(needsDbMatch[0], /'configure-personas'/);
    });
  });

  // ============================================================================
  // main() Routing
  // ============================================================================

  describe('main() routing', () => {
    it('should route /configure-personas to handleConfigurePersonas()', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');
      assert.match(mainMatch[0], /matchesCommand\(prompt, 'configure-personas'\)/);
      assert.match(mainMatch[0], /handleConfigurePersonas\(\)/);
    });

    it('should have a dedicated if-block for /configure-personas routing', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');
      const block = mainMatch[0].match(
        /if \(matchesCommand\(prompt, 'configure-personas'\)\) \{[\s\S]*?handleConfigurePersonas\(\)/
      );
      assert.ok(block, '/configure-personas must have its own if-block routing to handleConfigurePersonas()');
    });
  });

  // ============================================================================
  // Output Structure
  // ============================================================================

  describe('Output structure', () => {
    it('should match Mode 2 handler pattern (continue: true)', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /continue:\s*true/);
    });

    it('should provide gathered data in output', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /gathered:/);
    });
  });

  // ============================================================================
  // Error Handling
  // ============================================================================

  describe('Error handling', () => {
    it('should handle missing user-feedback database gracefully', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /else \{/);
    });

    it('should have try-catch for database operations', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.ok(
        /try \{/.test(fnMatch[0]) && /catch/.test(fnMatch[0]),
        'Must handle database errors gracefully'
      );
    });

    it('should set note when user-feedback.db is not found', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas function must exist');
      assert.match(fnMatch[0], /user-feedback\.db not found/);
    });
  });

  // ============================================================================
  // Consistency with Other Mode 2 Handlers
  // ============================================================================

  describe('Consistency with other Mode 2 handlers', () => {
    it('should use same output pattern as handleCtoReport (hookSpecificOutput wrapper)', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      const ctoMatch = hookCode.match(/function handleCtoReport\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas must exist');
      assert.ok(ctoMatch, 'handleCtoReport must exist for comparison');
      assert.match(fnMatch[0], /hookSpecificOutput:/);
      assert.match(ctoMatch[0], /hookSpecificOutput:/);
      assert.match(fnMatch[0], /continue:\s*true/);
      assert.match(ctoMatch[0], /continue:\s*true/);
    });

    it('should use same hookEventName as other handlers', () => {
      const fnMatch = hookCode.match(/function handleConfigurePersonas\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleConfigurePersonas must exist');
      assert.match(fnMatch[0], /hookEventName:\s*'UserPromptSubmit'/);
    });
  });
});

describe('Slash Command Prefetch - /configure-personas Integration', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(SLASH_COMMAND_PREFETCH_HOOK, 'utf8');
  });

  it('should include /configure-personas in commands list alongside other commands', () => {
    const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
    assert.ok(mainMatch, 'main function must exist');
    const mainBody = mainMatch[0];

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
      'product-manager',
      'show',
    ];

    for (const cmd of commands) {
      assert.match(
        mainBody,
        new RegExp(`matchesCommand\\(.*'${cmd}'\\)`),
        `main() must handle /${cmd}`
      );
    }
  });

  it('should have 16 total slash commands in SENTINELS (unchanged)', () => {
    const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
    assert.ok(sentinelsMatch, 'SENTINELS constant must exist');
    const commandCount = (sentinelsMatch[0].match(/'[\w-]+':/g) || []).length;
    assert.strictEqual(commandCount, 16, 'Should have 16 slash commands total');
  });

  it('should place detectProjectFeatures before handleConfigurePersonas in file order', () => {
    const detectFeaturesIndex = hookCode.indexOf('function detectProjectFeatures(');
    const handleConfigureIndex = hookCode.indexOf('function handleConfigurePersonas(');
    assert.ok(detectFeaturesIndex > 0, 'detectProjectFeatures must be defined');
    assert.ok(handleConfigureIndex > 0, 'handleConfigurePersonas must be defined');
    assert.ok(
      detectFeaturesIndex < handleConfigureIndex,
      'detectProjectFeatures must be defined before handleConfigurePersonas'
    );
  });
});
