/**
 * Tests for GENTYR_DIR path resolution in slash command markdown files.
 *
 * The `setup-gentyr.md` and `toggle-automation-gentyr.md` commands were updated
 * to replace hardcoded `node_modules/gentyr/` paths with `$GENTYR_DIR/`, making
 * them work across all three install models:
 *   1. npm link: node_modules/gentyr -> ~/git/gentyr
 *   2. legacy symlink: .claude-framework -> ~/git/gentyr
 *   3. running from within the gentyr repo: .
 *
 * These tests validate:
 * 1. No hardcoded `node_modules/gentyr/` paths remain in the command files
 * 2. The `$GENTYR_DIR` resolution expression is present and correct
 * 3. The resolution expression covers all three install models
 * 4. The `handleSetupGentyr()` prefetch handler uses compatible resolution logic
 * 5. `toggle-automation-gentyr.md` instructs resolving GENTYR_DIR before removal
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/slash-command-markdown-gentyr-dir.test.js
 *
 * @version 1.0.0
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.cwd();
const SETUP_GENTYR_MD = path.join(PROJECT_DIR, '.claude/commands/setup-gentyr.md');
const TOGGLE_AUTOMATION_MD = path.join(PROJECT_DIR, '.claude/commands/toggle-automation-gentyr.md');
const SLASH_COMMAND_PREFETCH_HOOK = path.join(PROJECT_DIR, '.claude/hooks/slash-command-prefetch.js');

// The canonical GENTYR_DIR resolution expression: must support npm, legacy, and repo-root
const GENTYR_DIR_EXPRESSION = `[ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; }`;

describe('setup-gentyr.md - GENTYR_DIR path resolution', () => {
  let mdContent;

  beforeEach(() => {
    mdContent = fs.readFileSync(SETUP_GENTYR_MD, 'utf8');
  });

  describe('No hardcoded node_modules/gentyr paths', () => {
    it('should not contain hardcoded node_modules/gentyr/scripts references', () => {
      // All script paths must use $GENTYR_DIR, not hardcoded node_modules/gentyr
      const hardcoded = mdContent.match(/node_modules\/gentyr\/scripts\/\w/g);
      assert.ok(
        !hardcoded,
        `setup-gentyr.md must not contain hardcoded node_modules/gentyr/scripts/ paths. Found: ${hardcoded}`
      );
    });

    it('should not contain hardcoded node_modules/gentyr/docs references', () => {
      const hardcoded = mdContent.match(/node_modules\/gentyr\/docs\/\w/g);
      assert.ok(
        !hardcoded,
        `setup-gentyr.md must not contain hardcoded node_modules/gentyr/docs/ paths. Found: ${hardcoded}`
      );
    });

    it('should not contain hardcoded node_modules/gentyr/ path prefix in bash commands', () => {
      // Matches patterns like: node node_modules/gentyr/scripts/...
      // Does NOT match the resolution expression itself (which uses 'node_modules/gentyr' without trailing /)
      const hardcoded = mdContent.match(/`node node_modules\/gentyr\//g);
      assert.ok(
        !hardcoded,
        `setup-gentyr.md must not use hardcoded node node_modules/gentyr/ in commands. Found: ${hardcoded}`
      );
    });
  });

  describe('Framework Path Resolution section', () => {
    it('should contain a Framework Path Resolution section', () => {
      assert.match(mdContent, /## Framework Path Resolution/);
    });

    it('should define GENTYR_DIR variable', () => {
      assert.match(mdContent, /GENTYR_DIR=/);
    });

    it('should include the npm link model (node_modules/gentyr)', () => {
      assert.match(mdContent, /node_modules\/gentyr/);
    });

    it('should include the legacy symlink model (.claude-framework)', () => {
      assert.match(mdContent, /\.claude-framework/);
    });

    it('should include the repo-root fallback (echo .)', () => {
      // The resolution expression falls back to "." when neither install model is found
      assert.match(mdContent, /echo \./);
    });

    it('should use the canonical three-way resolution expression', () => {
      assert.ok(
        mdContent.includes(GENTYR_DIR_EXPRESSION),
        'setup-gentyr.md must contain the canonical GENTYR_DIR resolution expression covering all three install models'
      );
    });
  });

  describe('Script references use $GENTYR_DIR', () => {
    it('should use $GENTYR_DIR for setup-check.js', () => {
      assert.match(mdContent, /"\$GENTYR_DIR\/scripts\/setup-check\.js"/);
    });

    it('should use $GENTYR_DIR for setup-validate.js', () => {
      assert.match(mdContent, /"\$GENTYR_DIR\/scripts\/setup-validate\.js"/);
    });

    it('should use $GENTYR_DIR for reinstall.sh', () => {
      assert.match(mdContent, /"\$GENTYR_DIR\/scripts\/reinstall\.sh"/);
    });

    it('should use $GENTYR_DIR for docs references', () => {
      assert.match(mdContent, /\$GENTYR_DIR\/docs\//);
    });

    it('should use $GENTYR_DIR for DEPLOYMENT-FLOW.md reference', () => {
      assert.match(mdContent, /\$GENTYR_DIR\/docs\/DEPLOYMENT-FLOW\.md/);
    });
  });

  describe('Phase coverage — all script invocations use $GENTYR_DIR', () => {
    it('should have at least 4 $GENTYR_DIR references', () => {
      const refs = (mdContent.match(/\$GENTYR_DIR\//g) || []).length;
      assert.ok(
        refs >= 4,
        `setup-gentyr.md must have at least 4 $GENTYR_DIR references (one per phase using scripts/docs), found ${refs}`
      );
    });
  });
});

describe('toggle-automation-gentyr.md - GENTYR_DIR path resolution', () => {
  let mdContent;

  beforeEach(() => {
    mdContent = fs.readFileSync(TOGGLE_AUTOMATION_MD, 'utf8');
  });

  it('should not contain hardcoded node_modules/gentyr/scripts references', () => {
    const hardcoded = mdContent.match(/node_modules\/gentyr\/scripts\//g);
    assert.ok(
      !hardcoded,
      `toggle-automation-gentyr.md must not contain hardcoded node_modules/gentyr/scripts/ paths. Found: ${hardcoded}`
    );
  });

  it('should reference GENTYR_DIR for the removal command', () => {
    assert.match(
      mdContent,
      /\$GENTYR_DIR\/scripts\/setup-automation-service\.sh/,
      'toggle-automation-gentyr.md must use $GENTYR_DIR for setup-automation-service.sh reference'
    );
  });

  it('should instruct resolving GENTYR_DIR before running removal command', () => {
    assert.match(
      mdContent,
      /resolve.*GENTYR_DIR|GENTYR_DIR.*first/i,
      'toggle-automation-gentyr.md must instruct users to resolve GENTYR_DIR before running the removal command'
    );
  });

  it('should cross-reference /setup-gentyr for GENTYR_DIR resolution', () => {
    assert.match(
      mdContent,
      /\/setup-gentyr|setup-gentyr/,
      'toggle-automation-gentyr.md should reference /setup-gentyr as the source of GENTYR_DIR resolution'
    );
  });
});

describe('handleSetupGentyr() - framework resolution consistency with markdown', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(SLASH_COMMAND_PREFETCH_HOOK, 'utf8');
  });

  it('should define handleSetupGentyr function', () => {
    assert.match(hookCode, /function handleSetupGentyr\(\)/);
  });

  it('should resolve framework dir via .claude/hooks symlink (primary method)', () => {
    const fnMatch = hookCode.match(/function handleSetupGentyr\(\) \{[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'handleSetupGentyr must exist');
    const body = fnMatch[0];

    // lstatSync and isSymbolicLink() appear on separate lines — check for both individually
    assert.match(body, /lstatSync/, 'Must use lstatSync to inspect .claude/hooks');
    assert.match(body, /isSymbolicLink\(\)/, 'Must call isSymbolicLink() to detect hooks symlink');
  });

  it('should include node_modules/gentyr as fallback resolution path', () => {
    const fnMatch = hookCode.match(/function handleSetupGentyr\(\) \{[\s\S]*?\n\}/);
    const body = fnMatch[0];

    assert.match(
      body,
      /node_modules.*gentyr/,
      'handleSetupGentyr must check node_modules/gentyr as a fallback'
    );
  });

  it('should include .claude-framework as fallback resolution path', () => {
    const fnMatch = hookCode.match(/function handleSetupGentyr\(\) \{[\s\S]*?\n\}/);
    const body = fnMatch[0];

    assert.match(
      body,
      /\.claude-framework/,
      'handleSetupGentyr must check .claude-framework as a fallback'
    );
  });

  it('should use fs.realpathSync to follow symlinks', () => {
    const fnMatch = hookCode.match(/function handleSetupGentyr\(\) \{[\s\S]*?\n\}/);
    const body = fnMatch[0];

    assert.match(body, /realpathSync/);
  });

  it('should include frameworkDir in gathered output', () => {
    const fnMatch = hookCode.match(/function handleSetupGentyr\(\) \{[\s\S]*?\n\}/);
    const body = fnMatch[0];

    assert.match(body, /frameworkDir/);
  });

  it('should handle missing framework directory gracefully', () => {
    const fnMatch = hookCode.match(/function handleSetupGentyr\(\) \{[\s\S]*?\n\}/);
    const body = fnMatch[0];

    // Must have try-catch or existsSync to handle missing dirs
    assert.ok(
      /try \{/.test(body) && /catch/.test(body),
      'handleSetupGentyr must handle missing framework dir gracefully'
    );
  });

  it('should produce output matching PREFETCH:setup-gentyr format', () => {
    const fnMatch = hookCode.match(/function handleSetupGentyr\(\) \{[\s\S]*?\n\}/);
    const body = fnMatch[0];

    assert.match(body, /PREFETCH:setup-gentyr/);
    assert.match(body, /continue:\s*true/);
    assert.match(body, /hookEventName:\s*'UserPromptSubmit'/);
  });
});

describe('Regression prevention - no hardcoded paths in command markdown files', () => {
  it('setup-gentyr.md: no instances of bare node_modules/gentyr/ as a path prefix in bash code blocks', () => {
    const mdContent = fs.readFileSync(SETUP_GENTYR_MD, 'utf8');

    // Look for patterns like: node node_modules/gentyr/ or sudo node_modules/gentyr/
    const hardcoded = mdContent.match(/(node|sudo)\s+node_modules\/gentyr\//g);
    assert.ok(
      !hardcoded,
      `setup-gentyr.md must not use node_modules/gentyr/ as a path prefix in commands. Found: ${hardcoded}`
    );
  });

  it('toggle-automation-gentyr.md: no instances of bare node_modules/gentyr/ as a path prefix', () => {
    const mdContent = fs.readFileSync(TOGGLE_AUTOMATION_MD, 'utf8');
    const hardcoded = mdContent.match(/node_modules\/gentyr\/scripts\//g);
    assert.ok(
      !hardcoded,
      `toggle-automation-gentyr.md must not use node_modules/gentyr/scripts/ paths. Found: ${hardcoded}`
    );
  });

  it('both files contain the sentinel comments required by the prefetch hook', () => {
    const setupContent = fs.readFileSync(SETUP_GENTYR_MD, 'utf8');
    const toggleContent = fs.readFileSync(TOGGLE_AUTOMATION_MD, 'utf8');

    assert.match(
      setupContent,
      /<!-- HOOK:GENTYR:setup-gentyr -->/,
      'setup-gentyr.md must contain sentinel comment for prefetch hook detection'
    );
    assert.match(
      toggleContent,
      /<!-- HOOK:GENTYR:toggle-automation -->/,
      'toggle-automation-gentyr.md must contain sentinel comment for prefetch hook detection'
    );
  });
});
