/**
 * Tests for /persona-feedback slash command detection and prefetch
 *
 * Validates:
 * 1. SENTINELS map includes 'persona-feedback' command
 * 2. matchesCommand() detects /persona-feedback and sentinel marker
 * 3. handlePersonaFeedback() queries personas, runs, sessions, findings
 * 4. main() routes /persona-feedback to handlePersonaFeedback()
 * 5. The total SENTINELS count (17) is current
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/slash-command-prefetch-persona-feedback.test.js
 *
 * @version 1.0.0
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const SLASH_COMMAND_PREFETCH_HOOK = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'slash-command-prefetch.js');

describe('Slash Command Prefetch - /persona-feedback Command', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(SLASH_COMMAND_PREFETCH_HOOK, 'utf8');
  });

  // ============================================================================
  // SENTINELS Map
  // ============================================================================

  describe('SENTINELS map', () => {
    it('should include "persona-feedback" command', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.ok(sentinelsMatch, 'SENTINELS constant must exist');
      assert.match(sentinelsMatch[0], /'persona-feedback':/);
    });

    it('should map "persona-feedback" to the correct sentinel marker', () => {
      const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
      assert.ok(sentinelsMatch, 'SENTINELS constant must exist');
      assert.match(sentinelsMatch[0], /'persona-feedback':\s*'<!-- HOOK:GENTYR:persona-feedback -->'/);
    });

    it('should have 17 total sentinel entries', () => {
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
  // handlePersonaFeedback() Function
  // ============================================================================

  describe('handlePersonaFeedback() function', () => {
    it('should define handlePersonaFeedback function', () => {
      assert.match(hookCode, /function handlePersonaFeedback\(/);
    });

    it('should query personas from user-feedback.db', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /SELECT.*FROM personas/);
    });

    it('should query feedback_runs table with started_at column', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /SELECT.*FROM feedback_runs/);
      assert.match(fnMatch[0], /started_at/);
    });

    it('should query feedback_sessions for per-persona stats with completed_at column', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /feedback_sessions/);
      assert.match(fnMatch[0], /completed_at/);
    });

    it('should query satisfaction_level (not satisfaction_score)', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /satisfaction_level/);
      assert.doesNotMatch(fnMatch[0], /satisfaction_score/);
    });

    it('should compute totalFindings from SUM(findings_count) on feedback_sessions', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /SUM\(findings_count\)/);
    });

    it('should NOT query a feedback_findings table', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.doesNotMatch(fnMatch[0], /FROM feedback_findings/);
    });

    it('should store personas in output.gathered.personas', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /gathered\.personas/);
    });

    it('should compute and store enabledCount', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /gathered\.enabledCount/);
    });

    it('should store recentRuns in output.gathered.recentRuns', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /gathered\.recentRuns/);
    });

    it('should store perPersonaStats in output.gathered.perPersonaStats', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /gathered\.perPersonaStats/);
    });

    it('should store totalSessions in output.gathered.totalSessions', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /gathered\.totalSessions/);
    });

    it('should store totalFindings in output.gathered.totalFindings', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /gathered\.totalFindings/);
    });

    it('should return command field set to "persona-feedback"', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /command:\s*'persona-feedback'/);
    });

    it('should output JSON with continue: true', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /continue:\s*true/);
    });

    it('should output hookSpecificOutput with hookEventName: UserPromptSubmit', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /hookEventName:\s*'UserPromptSubmit'/);
    });

    it('should include [PREFETCH:persona-feedback] marker in additionalContext', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /\[PREFETCH:persona-feedback\]/);
    });

    it('should write to console.log not console.error', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /console\.log/);
    });

    it('should include "persona-feedback" in needsDb array', () => {
      const needsDbMatch = hookCode.match(/const needsDb = \[[\s\S]*?\];/);
      assert.ok(needsDbMatch, 'needsDb array must exist');
      assert.match(needsDbMatch[0], /'persona-feedback'/);
    });

    it('should have nested try-catch blocks for secondary queries', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      // Count try blocks — should have at least 5 (1 outer + 4 inner for recentRuns, perPersonaStats, totalSessions, totalFindings)
      const tryCount = (fnMatch[0].match(/\btry\s*\{/g) || []).length;
      assert.ok(tryCount >= 5, `Should have at least 5 try blocks (outer + 4 inner), found ${tryCount}`);
    });
  });

  // ============================================================================
  // main() Routing
  // ============================================================================

  describe('main() routing', () => {
    it('should route /persona-feedback to handlePersonaFeedback()', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');
      assert.match(mainMatch[0], /matchesCommand\(prompt, 'persona-feedback'\)/);
      assert.match(mainMatch[0], /handlePersonaFeedback\(\)/);
    });

    it('should have a dedicated if-block for /persona-feedback routing', () => {
      const mainMatch = hookCode.match(/async function main\(\) \{[\s\S]*?\n\}/);
      assert.ok(mainMatch, 'main function must exist');
      const block = mainMatch[0].match(
        /if \(matchesCommand\(prompt, 'persona-feedback'\)\) \{[\s\S]*?handlePersonaFeedback\(\)/
      );
      assert.ok(block, '/persona-feedback must have its own if-block routing to handlePersonaFeedback()');
    });
  });

  // ============================================================================
  // Output Structure
  // ============================================================================

  describe('Output structure', () => {
    it('should match Mode 2 handler pattern (continue: true)', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /continue:\s*true/);
    });

    it('should provide gathered data in output', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /gathered:/);
    });

    it('should use same hookSpecificOutput wrapper as handleCtoReport', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      const ctoReportMatch = hookCode.match(/function handleCtoReport\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback must exist');
      assert.ok(ctoReportMatch, 'handleCtoReport must exist for comparison');
      assert.match(fnMatch[0], /hookSpecificOutput:/);
      assert.match(ctoReportMatch[0], /hookSpecificOutput:/);
    });
  });

  // ============================================================================
  // Error Handling
  // ============================================================================

  describe('Error handling', () => {
    it('should handle missing user-feedback database gracefully', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /else \{/);
    });

    it('should have try-catch for database operations', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.ok(
        /try \{/.test(fnMatch[0]) && /catch/.test(fnMatch[0]),
        'Must handle database errors gracefully'
      );
    });

    it('should set note when user-feedback.db is not found', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /user-feedback\.db not found/);
    });

    it('should default enabledCount to 0 when DB is missing', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      assert.match(fnMatch[0], /enabledCount\s*=\s*0/);
    });

    it('should default totalSessions to 0 when DB is missing', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      // Check the else branch has totalSessions: 0
      const elseBranch = fnMatch[0].match(/else \{[\s\S]*$/);
      assert.ok(elseBranch, 'else branch must exist');
      assert.match(elseBranch[0], /totalSessions.*0/);
    });

    it('should default totalFindings to 0 when DB is missing', () => {
      const fnMatch = hookCode.match(/function handlePersonaFeedback\(\) \{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handlePersonaFeedback function must exist');
      const elseBranch = fnMatch[0].match(/else \{[\s\S]*$/);
      assert.ok(elseBranch, 'else branch must exist');
      assert.match(elseBranch[0], /totalFindings.*0/);
    });
  });
});

describe('Slash Command Prefetch - /persona-feedback Integration', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(SLASH_COMMAND_PREFETCH_HOOK, 'utf8');
  });

  it('should include /persona-feedback in commands list alongside other commands', () => {
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
      'persona-feedback',
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

  it('should have 17 total slash commands in SENTINELS', () => {
    const sentinelsMatch = hookCode.match(/const SENTINELS = \{[\s\S]*?\};/);
    assert.ok(sentinelsMatch, 'SENTINELS constant must exist');
    const commandCount = (sentinelsMatch[0].match(/'[\w-]+':/g) || []).length;
    assert.strictEqual(commandCount, 17, 'Should have 17 slash commands total');
  });

  it('should place handlePersonaFeedback before handleDemo in file order', () => {
    const handlePersonaFeedbackIndex = hookCode.indexOf('function handlePersonaFeedback(');
    const handleDemoIndex = hookCode.indexOf('function handleDemo(');
    assert.ok(handlePersonaFeedbackIndex > 0, 'handlePersonaFeedback must be defined');
    assert.ok(handleDemoIndex > 0, 'handleDemo must be defined');
    assert.ok(
      handlePersonaFeedbackIndex < handleDemoIndex,
      'handlePersonaFeedback must be defined before handleDemo'
    );
  });
});
