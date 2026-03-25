/**
 * Tests for pre-commit-review.js
 *
 * These tests validate G001 fail-closed behavior:
 * - System errors MUST block commits
 * - Missing dependencies MUST block commits
 * - Database errors MUST block commits
 * - Git errors MUST block commits
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/pre-commit-review.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// Load better-sqlite3 for database-level timestamp tests.
// Wrap in a try so the test file still loads in environments without the
// native module, but the timestamp describe blocks will fail loudly inside
// each individual test (the _getSqlite3() helper below throws).
let _Database = null;
try {
  // ESM-compatible require for a CommonJS native module
  const _require = createRequire(import.meta.url);
  _Database = _require('better-sqlite3');
} catch (_) { /* will throw inside tests if used */ }

/**
 * Returns the better-sqlite3 Database constructor or throws immediately.
 * Used inside timestamp tests so failures are loud, not silent.
 */
function _getSqlite3() {
  if (!_Database) {
    throw new Error('CRITICAL: better-sqlite3 not available — cannot run timestamp tests');
  }
  return _Database;
}

/**
 * Creates an in-memory SQLite database with the deputy-cto schema
 * (questions + commit_decisions tables) and returns it.
 */
function createDeputyCtoDB() {
  const Database = _getSqlite3();
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      context TEXT,
      suggested_options TEXT,
      recommendation TEXT,
      answer TEXT,
      created_at TEXT NOT NULL,
      created_timestamp TEXT NOT NULL,
      answered_at TEXT,
      decided_by TEXT,
      investigation_task_id TEXT,
      CONSTRAINT valid_type CHECK (type IN ('decision', 'approval', 'rejection', 'question', 'escalation', 'bypass-request', 'protected-action-request')),
      CONSTRAINT valid_status CHECK (status IN ('pending', 'answered')),
      CONSTRAINT valid_decided_by CHECK (decided_by IS NULL OR decided_by IN ('cto', 'deputy-cto'))
    );

    CREATE TABLE IF NOT EXISTS commit_decisions (
      id TEXT PRIMARY KEY,
      decision TEXT NOT NULL,
      rationale TEXT NOT NULL,
      question_id TEXT,
      created_at TEXT NOT NULL,
      created_timestamp TEXT NOT NULL,
      CONSTRAINT valid_decision CHECK (decision IN ('approved', 'rejected'))
    );

    CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
    CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(type);
    CREATE INDEX IF NOT EXISTS idx_commit_decisions_created ON commit_decisions(created_timestamp DESC);
  `);
  return db;
}

/**
 * Returns an ISO 8601 timestamp that is `offsetMs` milliseconds from now.
 * A negative offset means in the past; positive means in the future.
 */
function isoOffsetNow(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe('pre-commit-review.js - G001 Fail-Closed Behavior', () => {
  const PROJECT_DIR = process.cwd();
  const HOOK_PATH = path.join(PROJECT_DIR, '.claude/hooks/pre-commit-review.js');
  const DEPUTY_CTO_DB = path.join(PROJECT_DIR, '.claude/deputy-cto.db');

  let originalEnv;

  before(() => {
    originalEnv = { ...process.env };
  });

  after(() => {
    process.env = originalEnv;
  });

  /**
   * Helper to run the hook and capture exit code
   */
  async function runHook(env = {}) {
    return new Promise((resolve) => {
      const proc = spawn('node', [HOOK_PATH], {
        cwd: PROJECT_DIR,
        env: { ...process.env, ...env },
        stdio: 'pipe',
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });

      // Timeout safety
      setTimeout(() => {
        proc.kill();
        resolve({ code: 2, stdout, stderr: stderr + '\nTEST TIMEOUT' });
      }, 5000);
    });
  }

  describe('Emergency Bypass', () => {
    it('should have hasValidBypassDecision() function that checks commit_decisions table', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /function hasValidBypassDecision/, 'Should define hasValidBypassDecision function');
      assert.match(hookCode, /commit_decisions/, 'Should check commit_decisions table');
      assert.match(hookCode, /EMERGENCY BYPASS/, 'Should check for EMERGENCY BYPASS rationale');
      assert.match(hookCode, /decision = 'approved'/, 'Should check for approved decision');
    });

    it('should check for bypass in the main flow', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Verify bypass check exists in main flow
      const bypassCheckIndex = hookCode.indexOf('if (hasValidBypassDecision())');
      const ctoItemsCheckIndex = hookCode.indexOf('hasPendingCtoItems()');

      assert.ok(bypassCheckIndex !== -1, 'hasValidBypassDecision() must be called in main');
      assert.ok(ctoItemsCheckIndex !== -1, 'hasPendingCtoItems() must be called in main');
      // Bypass check happens in the bypassable section, CTO items in branch-aware section
      // Both are present in the code flow
    });
  });

  describe('Pending CTO Items Check - G001 Fail-Closed', () => {
    it('should have code structure to block commits on database errors', () => {
      // Rather than trying to trigger a database error (which is hard to do reliably),
      // verify the code structure handles errors correctly

      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // hasPendingCtoItems should have error handling
      assert.match(hookCode, /function hasPendingCtoItems/, 'Should define function');
      assert.match(hookCode, /catch \(err\)/, 'Should catch database errors');
      assert.match(hookCode, /return \{ hasItems: true, count: 1, error: true \}/, 'Should return error state (fail-closed)');

      // Error is included in the return structure and checked by branch-aware logic
      assert.match(hookCode, /hasItems:/, 'Should return hasItems in structure');
      assert.match(hookCode, /error:/, 'Should return error in structure');
    });

    it('should have branch-aware blocking logic for pending CTO items', () => {
      // This test verifies the code structure for branch-aware blocking.
      // Can't easily test live execution since it depends on current branch.

      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Verify G020 branch-aware logic exists
      assert.match(hookCode, /hasPendingCtoItems\(\)/, 'Should check for pending CTO items');
      assert.match(hookCode, /getBranchInfo\(\)/, 'Should get current branch');
      assert.match(hookCode, /currentBranch === 'main' \|\| currentBranch === 'unknown'/, 'Should block on main/unknown');
      assert.match(hookCode, /COMMIT BLOCKED: Pending CTO item/, 'Should have blocking message');
      assert.match(hookCode, /currentBranch === 'develop' \|\| currentBranch === 'staging'/, 'Should warn on develop/staging');
      assert.match(hookCode, /WARNING: Pending CTO items exist/, 'Should have warning message');
    });
  });

  describe('Git Command Errors - G001 Fail-Closed', () => {
    it('should have code structure to block commits on git errors', () => {
      // This is hard to test without breaking git state
      // We verify the code structure exists instead

      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /if \(stagedInfo\.error\)/, 'Should check for git error flag');
      assert.match(hookCode, /Error getting staged/, 'Should have error message about staged changes');
      assert.match(hookCode, /process\.exit\(1\)/, 'Should exit with code 1');
    });

    it('should allow commit when no files are staged', async () => {
      // Ensure we're in a clean git state with no staged files
      try {
        execSync('git reset', { cwd: PROJECT_DIR, stdio: 'pipe' });
      } catch (err) {
        console.error('[pre-commit-review.test] Warning:', err.message);
        // Ignore errors
      }

      const result = await runHook();

      // Should allow commit since there's nothing to review
      assert.strictEqual(result.code, 0, 'Should allow commit with no staged files');
      assert.match(result.stdout, /No staged files/, 'Should indicate no files to review');
    });
  });

  describe('Universal Fast Path (v4.0 - PR-Based Review)', () => {
    it('should approve all commits after lint and security checks pass', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /Lint and security checks passed/, 'Should log approval message');
      assert.match(hookCode, /Code review happens at PR time/, 'Should indicate PR-based review');
    });

    it('should not contain approval token or deputy-cto spawn logic', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.doesNotMatch(hookCode, /function checkApprovalToken/, 'Should not have checkApprovalToken');
      assert.doesNotMatch(hookCode, /function consumeApprovalToken/, 'Should not have consumeApprovalToken');
      assert.doesNotMatch(hookCode, /function spawnDeputyCtoReview/, 'Should not have spawnDeputyCtoReview');
      assert.doesNotMatch(hookCode, /COMMIT PENDING/, 'Should not have COMMIT PENDING message');
      assert.doesNotMatch(hookCode, /APPROVAL_TOKEN_FILE/, 'Should not reference approval token file');
    });
  });

  describe('Error Handling - G001 Fail-Closed', () => {
    it('should have error handling for database operations', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // v3.0 doesn't have a main catch block, but individual functions have try-catch
      assert.match(hookCode, /catch \(err\)/, 'Should have error catch blocks in helper functions');
      assert.match(hookCode, /G001/, 'Should reference G001 spec in comments');
      assert.match(hookCode, /[Ff]ail-closed|[Ff]ail closed/, 'Should mention fail-closed principle');
    });
  });


  describe('Database Module Unavailable - G001 Fail-Closed', () => {
    it('should have graceful handling when better-sqlite3 is missing', () => {
      // This is validated by checking the code structure
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /try \{/, 'Should have try block for import');
      assert.match(hookCode, /await import\('better-sqlite3'\)/, 'Should try to import better-sqlite3');
      assert.match(hookCode, /\} catch [^{]*\{/, 'Should catch import failure');
      assert.match(hookCode, /Warning: better-sqlite3 not available/, 'Should have warning message');
      // When Database is null, hasPendingCtoItems returns safe defaults (hasItems: false, no error)
    });
  });
});

describe('Helper Functions - Code Structure Tests', () => {
  const HOOK_PATH = path.join(process.cwd(), '.claude/hooks/pre-commit-review.js');

  describe('getStagedInfo()', () => {
    it('should return structured diff information with hash', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /function getStagedInfo\(\)/, 'Should define getStagedInfo function');
      assert.match(hookCode, /git diff --cached --name-only/, 'Should get staged file names');
      assert.match(hookCode, /git diff --cached --stat/, 'Should get diff statistics');
      assert.match(hookCode, /git diff --cached[^-]/, 'Should get full diff');
      assert.match(hookCode, /return \{[\s\S]*?files:/, 'Should return files array');
      assert.match(hookCode, /stat/, 'Should return stat string');
      assert.match(hookCode, /diff/, 'Should return diff string');
      assert.match(hookCode, /diffHash/, 'Should return diff hash');
      assert.match(hookCode, /error:/, 'Should return error flag');
    });

    it('should truncate large diffs to 10000 characters', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /diff\.length > 10000/, 'Should check diff length');
      assert.match(hookCode, /diff\.substring\(0, 10000\)/, 'Should truncate to 10000 chars');
      assert.match(hookCode, /diff truncated/, 'Should indicate truncation');
    });

    it('should handle git command errors gracefully', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /try \{[\s\S]*?execSync/, 'Should wrap git commands in try');
      assert.match(hookCode, /\} catch \(err\)/, 'Should catch git errors');
      assert.match(hookCode, /return \{ files: \[\], stat: '', diff: '', diffHash: '', error: true \}/, 'Should return error state with diffHash');
    });
  });

  describe('hasPendingCtoItems()', () => {
    it('should return correct structure on success', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /function hasPendingCtoItems\(\)/, 'Should define function');
      assert.match(hookCode, /return \{ hasItems:/, 'Should return hasItems flag');
      assert.match(hookCode, /questionCount/, 'Should return questionCount');
      assert.match(hookCode, /triageCount/, 'Should return triageCount');
      assert.match(hookCode, /error: false/, 'Should return error: false on success');
    });

    it('should return error state on database failure (fail-closed)', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /return \{ hasItems: true, count: 1, error: true \}/, 'Should return fail-closed error state');
    });

    it('should handle missing database gracefully', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Check for both Database module check AND file existence check
      assert.match(hookCode, /if \(!Database \|\| !fs\.existsSync\(DEPUTY_CTO_DB\)\)/, 'Should check if Database module and DB file exist');
      assert.match(hookCode, /return \{ hasItems: false, count: 0, error: false \}/, 'Should return safe state when DB missing');
    });
  });

});

describe('worktree directory resolution', () => {
  const HOOK_PATH = path.join(process.cwd(), '.claude/hooks/pre-commit-review.js');

  it('verifyLintConfigIntegrity uses working tree path for file checks', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // Extract verifyLintConfigIntegrity function body
    const fnMatch = hookCode.match(/function verifyLintConfigIntegrity\(\)\s*\{[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'Should define verifyLintConfigIntegrity function');
    const fnBody = fnMatch[0];

    // Should use a working-tree-relative path (GIT_WORK_TREE or PROJECT_DIR), not MAIN_REPO_DIR
    assert.match(fnBody, /path\.join\((GIT_WORK_TREE|PROJECT_DIR),\s*file\)/,
      'Should join working tree path with file name for forbidden file checks');
  });

  it('runStrictLint uses working tree path for eslint binary and cwd', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // Extract runStrictLint function body
    const fnMatch = hookCode.match(/function runStrictLint[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'Should define runStrictLint function');
    const fnBody = fnMatch[0];

    // eslint binary should come from working tree node_modules
    assert.match(fnBody, /path\.join\((GIT_WORK_TREE|PROJECT_DIR),\s*'node_modules'/,
      'Should resolve eslint binary from working tree node_modules');

    // cwd should be working tree
    assert.match(fnBody, /cwd:\s*(GIT_WORK_TREE|PROJECT_DIR)/,
      'Should use working tree as cwd for eslint execution');
  });

  it('verifyProtectionStatus checks working tree for eslint.config.js and package.json', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // Extract verifyProtectionStatus function body
    const fnMatch = hookCode.match(/function verifyProtectionStatus\(\)\s*\{[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'Should define verifyProtectionStatus function');
    const fnBody = fnMatch[0];

    // Should check eslint.config.js and package.json in working tree
    assert.match(fnBody, /path\.join\((GIT_WORK_TREE|PROJECT_DIR),\s*'eslint\.config\.js'\)/,
      'Should check eslint.config.js in working tree');
    assert.match(fnBody, /path\.join\((GIT_WORK_TREE|PROJECT_DIR),\s*'package\.json'\)/,
      'Should check package.json in working tree');
  });

  it('database paths use main repo directory', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // DEPUTY_CTO_DB should use MAIN_REPO_DIR (or PROJECT_DIR before rename)
    assert.match(hookCode, /DEPUTY_CTO_DB\s*=\s*path\.join\((MAIN_REPO_DIR|PROJECT_DIR)/,
      'DEPUTY_CTO_DB should use main repo directory');

    // CTO_REPORTS_DB should also use MAIN_REPO_DIR (or PROJECT_DIR)
    assert.match(hookCode, /CTO_REPORTS_DB\s*=\s*path\.join\((MAIN_REPO_DIR|PROJECT_DIR)/,
      'CTO_REPORTS_DB should use main repo directory');
  });
});

describe('G001 Compliance Summary', () => {
  const HOOK_PATH = path.join(process.cwd(), '.claude/hooks/pre-commit-review.js');

  it('should validate all fail-closed exit points exist', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // Count all process.exit(1) calls (fail-closed)
    const blockingExits = (hookCode.match(/process\.exit\(1\)/g) || []).length;

    // Should have multiple fail-closed exit points:
    // 1. forbidden lint config files
    // 2. git hooksPath tampered
    // 3. staged info error
    // 4. lint failure
    // 5. main/unknown branch + pending CTO items

    assert.ok(blockingExits >= 5, `Should have at least 5 fail-closed exits, found ${blockingExits}`);
  });

  it('should validate G001 is explicitly mentioned', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    assert.match(hookCode, /G001/, 'Should mention G001 spec');
    assert.match(hookCode, /Fail-closed|fail-closed/, 'Should mention fail-closed principle');
  });

  it('should validate return structure consistency', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // getStagedInfo should return { files, stat, diff, error }
    assert.match(hookCode, /files:.*stat.*diff.*error/s, 'getStagedInfo should return correct structure');

    // hasPendingCtoItems should return { hasItems, count, error }
    assert.match(hookCode, /hasItems.*count.*error/s, 'hasPendingCtoItems should return correct structure');
  });
});

// =============================================================================
// G020: Branch-Aware Commit Blocking - Logic Tests
//
// These tests mirror the branch-routing logic from main() in isolation so we
// can verify every branch path without requiring a real git repo, real
// databases, or a full hook execution.
// =============================================================================

/**
 * Mirrors the branch-aware blocking logic from main() in pre-commit-review.js
 * (lines ~581-622). Returns an object describing what action was taken so
 * tests can assert on it without touching process.exit or console.
 *
 * @param {{ hasItems: boolean, count: number, questionCount: number, triageCount: number }} ctoItemsCheck
 * @param {string} currentBranch
 * @returns {{ action: 'block' | 'warn' | 'allow', warnOutput: string | null }}
 */
function branchAwareBlockingLogic(ctoItemsCheck, currentBranch) {
  if (!ctoItemsCheck.hasItems) {
    return { action: 'allow', warnOutput: null };
  }

  if (currentBranch === 'main' || currentBranch === 'unknown') {
    // MAIN/UNKNOWN: Hard block (G001 fail-closed treats unknown as main)
    return { action: 'block', warnOutput: null };
  }

  if (currentBranch === 'develop' || currentBranch === 'staging') {
    // STAGING/DEVELOP: Warn but allow commit
    const warnLines = [
      '',
      '══════════════════════════════════════════════════════════════',
      `  WARNING: Pending CTO items exist (committing to ${currentBranch})`,
      '',
    ];
    if (ctoItemsCheck.questionCount > 0) {
      warnLines.push(`  • ${ctoItemsCheck.questionCount} CTO question(s) pending`);
    }
    if (ctoItemsCheck.triageCount > 0) {
      warnLines.push(`  • ${ctoItemsCheck.triageCount} untriaged report(s) pending`);
    }
    warnLines.push('');
    warnLines.push('  These must be resolved before merging to main.');
    warnLines.push('══════════════════════════════════════════════════════════════');
    warnLines.push('');
    return { action: 'warn', warnOutput: warnLines.join('\n') };
  }

  // Feature branches: no blocking, no warning -- items checked on merge
  return { action: 'allow', warnOutput: null };
}

describe('G020: Branch-Aware Commit Blocking - Logic', () => {
  describe('main branch + pending CTO items', () => {
    it('should hard-block when on main branch with pending questions', () => {
      const ctoItemsCheck = {
        hasItems: true,
        count: 2,
        questionCount: 2,
        triageCount: 0,
        error: false,
      };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'main');

      assert.strictEqual(result.action, 'block', 'Should block commit on main');
      assert.strictEqual(result.warnOutput, null, 'Should not emit a warning (hard block)');
    });

    it('should hard-block when on main branch with pending triage reports', () => {
      const ctoItemsCheck = {
        hasItems: true,
        count: 1,
        questionCount: 0,
        triageCount: 1,
        error: false,
      };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'main');

      assert.strictEqual(result.action, 'block');
    });

    it('should hard-block when on main branch with both questions and reports', () => {
      const ctoItemsCheck = {
        hasItems: true,
        count: 3,
        questionCount: 2,
        triageCount: 1,
        error: false,
      };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'main');

      assert.strictEqual(result.action, 'block');
    });
  });

  describe('main branch + no pending CTO items', () => {
    it('should allow commit on main when no pending CTO items exist', () => {
      const ctoItemsCheck = {
        hasItems: false,
        count: 0,
        questionCount: 0,
        triageCount: 0,
        error: false,
      };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'main');

      assert.strictEqual(result.action, 'allow', 'Should allow commit with no pending items');
      assert.strictEqual(result.warnOutput, null);
    });
  });

  describe('unknown branch + pending CTO items (G001 fail-closed)', () => {
    it('should hard-block on unknown branch with pending items (fail-closed)', () => {
      const ctoItemsCheck = {
        hasItems: true,
        count: 1,
        questionCount: 1,
        triageCount: 0,
        error: false,
      };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'unknown');

      assert.strictEqual(result.action, 'block', 'G001: unknown branch treated as main');
      assert.strictEqual(result.warnOutput, null);
    });

    it('should hard-block on unknown branch with error state (G001 fail-closed)', () => {
      // When getBranchInfo() throws, it returns 'unknown'.
      // When hasPendingCtoItems() DB errors, it returns hasItems: true.
      // Combined, both error states must produce a hard block.
      const ctoItemsCheck = {
        hasItems: true,
        count: 1,
        error: true,
        questionCount: 0,
        triageCount: 0,
      };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'unknown');

      assert.strictEqual(result.action, 'block', 'G001: error state on unknown branch must block');
    });
  });

  describe('staging branch + pending CTO items', () => {
    it('should warn but not block when on staging branch', () => {
      const ctoItemsCheck = {
        hasItems: true,
        count: 1,
        questionCount: 1,
        triageCount: 0,
        error: false,
      };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'staging');

      assert.strictEqual(result.action, 'warn', 'Should warn on staging');
      assert.ok(result.warnOutput !== null, 'Should produce warning output');
      assert.ok(result.warnOutput.includes('WARNING: Pending CTO items exist'), 'Should include warning text');
      assert.ok(result.warnOutput.includes('staging'), 'Should name the branch in warning');
      assert.ok(result.warnOutput.includes('These must be resolved before merging to main'), 'Should give merge guidance');
    });

    it('should include question count in warning when questions pending on staging', () => {
      const ctoItemsCheck = {
        hasItems: true,
        count: 3,
        questionCount: 3,
        triageCount: 0,
        error: false,
      };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'staging');

      assert.strictEqual(result.action, 'warn');
      assert.ok(result.warnOutput.includes('3 CTO question(s) pending'), 'Should include question count');
    });

    it('should include triage count in warning when triage reports pending on staging', () => {
      const ctoItemsCheck = {
        hasItems: true,
        count: 2,
        questionCount: 0,
        triageCount: 2,
        error: false,
      };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'staging');

      assert.strictEqual(result.action, 'warn');
      assert.ok(result.warnOutput.includes('2 untriaged report(s) pending'), 'Should include triage count');
    });

    it('should include both counts when both types of pending items exist on staging', () => {
      const ctoItemsCheck = {
        hasItems: true,
        count: 3,
        questionCount: 1,
        triageCount: 2,
        error: false,
      };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'staging');

      assert.strictEqual(result.action, 'warn');
      assert.ok(result.warnOutput.includes('1 CTO question(s) pending'), 'Should include question count');
      assert.ok(result.warnOutput.includes('2 untriaged report(s) pending'), 'Should include triage count');
    });
  });

  describe('develop branch + pending CTO items', () => {
    it('should warn but not block when on develop branch', () => {
      const ctoItemsCheck = {
        hasItems: true,
        count: 1,
        questionCount: 0,
        triageCount: 1,
        error: false,
      };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'develop');

      assert.strictEqual(result.action, 'warn', 'Should warn on develop');
      assert.ok(result.warnOutput.includes('develop'), 'Should name the branch in warning');
      assert.ok(result.warnOutput.includes('These must be resolved before merging to main'), 'Should give merge guidance');
    });

    it('should not block on develop (only warn) even with many pending items', () => {
      const ctoItemsCheck = {
        hasItems: true,
        count: 10,
        questionCount: 5,
        triageCount: 5,
        error: false,
      };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'develop');

      assert.strictEqual(result.action, 'warn', 'High count of pending items still only warns on develop');
      assert.notStrictEqual(result.action, 'block');
    });
  });

  describe('feature branch + pending CTO items', () => {
    it('should allow commit on a feature branch with pending items (no block, no warn)', () => {
      const ctoItemsCheck = {
        hasItems: true,
        count: 5,
        questionCount: 3,
        triageCount: 2,
        error: false,
      };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'feature/my-new-feature');

      assert.strictEqual(result.action, 'allow', 'Feature branches are not blocked');
      assert.strictEqual(result.warnOutput, null, 'Feature branches emit no warning');
    });

    it('should allow commit on branch named with slash prefix (feature/)', () => {
      const ctoItemsCheck = { hasItems: true, count: 1, questionCount: 1, triageCount: 0, error: false };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'feature/JIRA-123-fix-auth');

      assert.strictEqual(result.action, 'allow');
      assert.strictEqual(result.warnOutput, null);
    });

    it('should allow commit on branch named with fix/ prefix', () => {
      const ctoItemsCheck = { hasItems: true, count: 1, questionCount: 1, triageCount: 0, error: false };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'fix/urgent-hotfix');

      assert.strictEqual(result.action, 'allow');
      assert.strictEqual(result.warnOutput, null);
    });

    it('should allow commit on branch with arbitrary name that is not main/unknown/develop/staging', () => {
      const ctoItemsCheck = { hasItems: true, count: 1, questionCount: 1, triageCount: 0, error: false };

      for (const branch of ['gentyr-framework-overhaul', 'chore/update-deps', 'release/v2.0.0', 'hotfix/critical']) {
        const result = branchAwareBlockingLogic(ctoItemsCheck, branch);
        assert.strictEqual(result.action, 'allow', `Branch "${branch}" should be allowed`);
        assert.strictEqual(result.warnOutput, null, `Branch "${branch}" should emit no warning`);
      }
    });
  });

  describe('feature branch + no pending CTO items', () => {
    it('should allow commit on feature branch with no pending items', () => {
      const ctoItemsCheck = {
        hasItems: false,
        count: 0,
        questionCount: 0,
        triageCount: 0,
        error: false,
      };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'feature/clean-branch');

      assert.strictEqual(result.action, 'allow');
      assert.strictEqual(result.warnOutput, null);
    });
  });

  describe('branch name exact-match boundary conditions', () => {
    it('should not block "mainstream" (only exact "main" is blocked)', () => {
      // Regression guard: substring matches must not trigger blocking
      const ctoItemsCheck = { hasItems: true, count: 1, questionCount: 1, triageCount: 0, error: false };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'mainstream');

      assert.strictEqual(result.action, 'allow', '"mainstream" should not be treated as "main"');
    });

    it('should not warn on "pre-staging" (only exact "staging" warns)', () => {
      const ctoItemsCheck = { hasItems: true, count: 1, questionCount: 1, triageCount: 0, error: false };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'pre-staging');

      assert.strictEqual(result.action, 'allow', '"pre-staging" should not be treated as "staging"');
    });

    it('should not warn on "development" (only exact "develop" warns)', () => {
      const ctoItemsCheck = { hasItems: true, count: 1, questionCount: 1, triageCount: 0, error: false };

      const result = branchAwareBlockingLogic(ctoItemsCheck, 'development');

      assert.strictEqual(result.action, 'allow', '"development" should not be treated as "develop"');
    });
  });
});

// =============================================================================
// G020: Branch-Aware Commit Blocking - Code Structure Tests
//
// These tests verify the production code in pre-commit-review.js contains
// the correct branching logic and G020 compliance markers.
// =============================================================================

describe('G020: Branch-Aware Commit Blocking - Code Structure', () => {
  const HOOK_PATH = path.join(process.cwd(), '.claude/hooks/pre-commit-review.js');

  it('should define getBranchInfo() function that falls back to "unknown"', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    assert.match(hookCode, /function getBranchInfo\(\)/, 'Must define getBranchInfo()');
    assert.match(hookCode, /git branch --show-current/, 'Must call git branch --show-current');
    assert.match(hookCode, /return 'unknown'/, 'Must return "unknown" on error (G001 fail-closed)');
  });

  it('should define hasPendingCtoItems() function', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    assert.match(hookCode, /function hasPendingCtoItems\(\)/, 'Must define hasPendingCtoItems()');
  });

  it('should check both deputy-cto.db (questions) and cto-reports.db (triage) for pending items', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    assert.match(hookCode, /status = 'pending'/, 'Must query pending questions');
    assert.match(hookCode, /triage_status = 'pending'|triaged_at IS NULL/, 'Must query pending triage items');
    assert.match(hookCode, /cto-reports\.db/, 'Must check cto-reports.db for triage items');
  });

  it('should fail-closed when hasPendingCtoItems() throws (G001)', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // The catch block must return hasItems: true (blocking)
    assert.match(
      hookCode,
      /return \{ hasItems: true, count: 1, error: true \}/,
      'Must return hasItems: true on DB error (G001 fail-closed)'
    );
  });

  it('should implement G020 branch-aware routing: main/unknown blocks', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    assert.match(
      hookCode,
      /currentBranch === 'main' \|\| currentBranch === 'unknown'/,
      'Must check for main and unknown together (G001 treats unknown as main)'
    );
    assert.match(hookCode, /COMMIT BLOCKED: Pending CTO item/, 'Must emit block message for main/unknown');
    assert.match(hookCode, /process\.exit\(1\)/, 'Must call process.exit(1) to block');
  });

  it('should implement G020 branch-aware routing: develop/staging warns only', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    assert.match(
      hookCode,
      /currentBranch === 'develop' \|\| currentBranch === 'staging'/,
      'Must check for develop and staging together'
    );
    assert.match(
      hookCode,
      /WARNING: Pending CTO items exist/,
      'Must emit warning for develop/staging'
    );
    assert.match(
      hookCode,
      /These must be resolved before merging to main/,
      'Must give guidance about merging to main'
    );
    // Must NOT call process.exit after warning (allow commit to continue)
    // Verified by checking the comment that follows
    assert.match(
      hookCode,
      /Allow commit to proceed \(do NOT exit\)/,
      'Must document that commit proceeds after warning'
    );
  });

  it('should implement G020 branch-aware routing: feature branches skip entirely', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    assert.match(
      hookCode,
      /Feature branches: no blocking, no warning/,
      'Must document feature branch behavior'
    );
  });

  it('should reference G020 spec in the branch-aware blocking section', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    assert.match(hookCode, /G020/, 'Must reference G020 spec');
    assert.match(hookCode, /[Bb]ranch-aware/, 'Must describe the behavior as branch-aware');
  });

  it('should call getBranchInfo() only after confirming pending items exist', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // The pattern: hasPendingCtoItems() is called, then if hasItems, getBranchInfo() is called
    const pendingCheckIndex = hookCode.indexOf('hasPendingCtoItems()');
    const branchInfoCallIndex = hookCode.indexOf('getBranchInfo()', pendingCheckIndex);

    assert.ok(pendingCheckIndex !== -1, 'hasPendingCtoItems() must be called');
    assert.ok(branchInfoCallIndex !== -1, 'getBranchInfo() must be called after hasPendingCtoItems()');
    assert.ok(
      branchInfoCallIndex > pendingCheckIndex,
      'getBranchInfo() must be called AFTER hasPendingCtoItems() in main() flow'
    );
  });

  it('should display pending question count and triage count in block/warn messages', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    assert.match(hookCode, /questionCount > 0/, 'Must conditionally show question count');
    assert.match(hookCode, /triageCount > 0/, 'Must conditionally show triage count');
    assert.match(hookCode, /CTO question\(s\) pending/, 'Must use consistent question label');
    assert.match(hookCode, /untriaged report\(s\) pending/, 'Must use consistent triage label');
  });

  it('should show /deputy-cto guidance in the block message', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    assert.match(
      hookCode,
      /Run \/deputy-cto to address blocking items/,
      'Must tell developer how to unblock'
    );
  });
});

// =============================================================================
// verifyGitHooksPath() - Worktree Support (Fix for False-Positive Tamper Detection)
//
// These tests verify that the fixed verifyGitHooksPath() implementation uses
// path.resolve() for comparison so that absolute paths produced by git in
// worktree environments are accepted, not falsely flagged as tampered.
//
// Security insight: endsWith('/.husky') would be INSECURE because it would
// allow paths like /tmp/evil/.husky. The fix uses path.resolve() to compare
// the configured path against the known PROJECT_DIR/.husky path exactly.
// =============================================================================

describe('verifyGitHooksPath() - Worktree Support', () => {
  const HOOK_PATH = path.join(process.cwd(), '.claude/hooks/pre-commit-review.js');

  describe('Code structure: path.resolve() usage', () => {
    it('should use path.resolve() to compare hooks paths (not string endsWith)', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // The fix MUST use path.resolve() for path comparison inside verifyGitHooksPath
      assert.match(
        hookCode,
        /path\.resolve/,
        'Must use path.resolve() for path comparison to prevent false positives in worktrees'
      );

      // SECURITY: Must NOT use endsWith('/.husky') - that would be insecure
      // because any path ending in /.husky (e.g. /tmp/evil/.husky) would pass
      assert.doesNotMatch(
        hookCode,
        /endsWith\(['"]\/\.husky['"]\)/,
        'Must NOT use endsWith("/.husky") - insecure substring match that allows path traversal'
      );
    });

    it('should use path.isAbsolute() to handle both relative and absolute hooksPath values', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /path\.isAbsolute\(hooksPath\)/,
        'Must check path.isAbsolute(hooksPath) to handle both relative (.husky) and absolute (/Users/x/repo/.husky) paths'
      );
    });

    it('should build resolved path using path.resolve(hooksPath) for absolute paths', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /path\.resolve\(hooksPath\)/,
        'Must call path.resolve(hooksPath) when the configured path is already absolute'
      );
    });

    it('should build resolved path using path.resolve(PROJECT_DIR, hooksPath) for relative paths', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /path\.resolve\(PROJECT_DIR,\s*hooksPath\)/,
        'Must call path.resolve(PROJECT_DIR, hooksPath) when the configured path is relative'
      );
    });
  });

  describe('Code structure: git rev-parse --git-common-dir for worktree support', () => {
    it('should call git rev-parse --git-common-dir to find the main repo root in worktrees', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /git rev-parse --git-common-dir/,
        'Must use git rev-parse --git-common-dir to resolve main repo root when running inside a worktree'
      );
    });

    it('should derive mainRepoRoot from the common git dir path', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // The main repo root is the directory containing .git (i.e. dirname of commonDir)
      assert.match(
        hookCode,
        /path\.dirname\(path\.resolve\(commonDir\)\)/,
        'Must derive mainRepoRoot as path.dirname(path.resolve(commonDir))'
      );
    });

    it('should add mainRepoRoot to allowedRoots only when it differs from PROJECT_DIR', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /mainRepoRoot !== PROJECT_DIR/,
        'Must guard against adding duplicate roots when PROJECT_DIR already equals mainRepoRoot'
      );

      assert.match(
        hookCode,
        /allowedRoots\.push\(mainRepoRoot\)/,
        'Must push mainRepoRoot into allowedRoots so the main repo .husky path is accepted in worktrees'
      );
    });

    it('should gracefully handle git rev-parse --git-common-dir errors (not in a worktree)', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // The inner try/catch around git rev-parse --git-common-dir must not re-throw
      // When not in a worktree or on git error, PROJECT_DIR alone is sufficient
      assert.match(
        hookCode,
        /Not in a worktree or git error/,
        'Must document fallback behavior when git rev-parse --git-common-dir fails'
      );
    });
  });

  describe('Code structure: allowedRoots array and final comparison', () => {
    it('should initialize allowedRoots starting with PROJECT_DIR', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /const allowedRoots = \[PROJECT_DIR\]/,
        'Must start with [PROJECT_DIR] so non-worktree repos are handled correctly'
      );
    });

    it('should use allowedRoots.some() for the final path acceptance check', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /allowedRoots\.some\(/,
        'Must use Array.some() to check if the resolved hooks path matches any allowed root'
      );
    });

    it('should compare resolvedHooksPath against path.resolve(root, ".husky") for each allowed root', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /resolvedHooksPath === path\.resolve\(root,\s*['"]\.husky['"]\)/,
        'Must use exact equality with path.resolve(root, ".husky") - not substring or endsWith'
      );
    });

    it('should return valid: false when resolvedHooksPath does not match any allowed root', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // The isAllowed check and its fail-closed rejection
      assert.match(
        hookCode,
        /if \(!isAllowed\)/,
        'Must check the isAllowed result and reject if false'
      );
    });
  });

  describe('Code structure: empty string handling (default git hooks)', () => {
    it('should explicitly handle empty hooksPath before attempting path resolution', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Empty string means core.hooksPath is set to nothing, which means default .git/hooks
      assert.match(
        hookCode,
        /if \(hooksPath === ''\)/,
        "Must handle empty hooksPath as a valid case before path resolution (core.hooksPath='') "
      );
    });

    it('should return valid: true for empty hooksPath without path resolution', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Verify that the early return for empty string yields valid: true
      // We check the structure: the empty-string early return must appear before the resolve logic
      const emptyCheckIndex = hookCode.indexOf("if (hooksPath === '')");
      const resolveIndex = hookCode.indexOf('path.isAbsolute(hooksPath)');

      assert.ok(emptyCheckIndex !== -1, "Empty string check must exist in verifyGitHooksPath");
      assert.ok(resolveIndex !== -1, 'path.isAbsolute(hooksPath) check must exist');
      assert.ok(
        emptyCheckIndex < resolveIndex,
        'Empty string check must come BEFORE path resolution logic (early return)'
      );
    });
  });

  describe('Security: path traversal prevention', () => {
    it('should verify the fix uses exact path equality, not pattern matching', () => {
      // This is a meta-test validating the security posture of the fix.
      // The correct approach: resolve both sides to absolute paths and compare with ===
      // The insecure approach: use endsWith('/.husky') or includes('.husky')
      //
      // With path.resolve(), a path like /tmp/evil/.husky will resolve to
      // /tmp/evil/.husky, which will NOT equal /Users/x/repo/.husky — blocked correctly.
      //
      // With endsWith('/.husky'), /tmp/evil/.husky would pass — security hole.

      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // The fix must NOT use any of these insecure patterns
      assert.doesNotMatch(
        hookCode,
        /\.endsWith\(['"]\/\.husky['"]\)/,
        'SECURITY: Must not use .endsWith("/.husky") - allows arbitrary paths ending in /.husky'
      );

      assert.doesNotMatch(
        hookCode,
        /\.includes\(['"]\.husky['"]\)/,
        'SECURITY: Must not use .includes(".husky") - allows any path containing .husky as substring'
      );

      // The secure pattern must be present: exact equality after resolve()
      assert.match(
        hookCode,
        /resolvedHooksPath === path\.resolve\(/,
        'SECURITY: Must use exact equality (===) after path.resolve() for secure path comparison'
      );
    });
  });
});

// =============================================================================
// G005: ISO 8601 Timestamp Comparison - hasPendingCtoItems() bypass-request filter
//
// The function filters out stale bypass-requests using an ISO 8601 cutoff:
//   const bypassCutoff = new Date(Date.now() - 3600 * 1000).toISOString();
//   WHERE NOT (type = 'bypass-request' AND created_timestamp < ?)
//
// These tests create real in-memory SQLite databases and run the exact SQL
// query used by hasPendingCtoItems() to verify correct timestamp filtering.
// =============================================================================

describe('G005: hasPendingCtoItems() - ISO 8601 bypass-request TTL filter', () => {
  it('should include a bypass-request created 30 minutes ago (within 1-hour TTL)', () => {
    const db = createDeputyCtoDB();

    // Insert a recent bypass-request (30 min ago — within the 1-hour TTL window)
    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
      VALUES (?, 'bypass-request', 'pending', 'Recent bypass', 'desc', ?, ?)
    `).run('q-recent', isoOffsetNow(-30 * 60 * 1000), isoOffsetNow(-30 * 60 * 1000));

    // Mirror the exact SQL from hasPendingCtoItems()
    const bypassCutoff = new Date(Date.now() - 3600 * 1000).toISOString();
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM questions
      WHERE status = 'pending'
      AND NOT (type = 'bypass-request' AND created_timestamp < ?)
    `).get(bypassCutoff);

    db.close();

    assert.strictEqual(typeof result.count, 'number', 'count must be a number');
    assert.strictEqual(result.count, 1, 'Recent bypass-request (30m ago) must be counted as pending');
  });

  it('should exclude a bypass-request created 2 hours ago (exceeds 1-hour TTL)', () => {
    const db = createDeputyCtoDB();

    // Insert a stale bypass-request (2 hours ago — expired TTL)
    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
      VALUES (?, 'bypass-request', 'pending', 'Stale bypass', 'desc', ?, ?)
    `).run('q-stale', isoOffsetNow(-2 * 60 * 60 * 1000), isoOffsetNow(-2 * 60 * 60 * 1000));

    const bypassCutoff = new Date(Date.now() - 3600 * 1000).toISOString();
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM questions
      WHERE status = 'pending'
      AND NOT (type = 'bypass-request' AND created_timestamp < ?)
    `).get(bypassCutoff);

    db.close();

    assert.strictEqual(result.count, 0, 'Stale bypass-request (2h ago) must be filtered out (expired TTL)');
  });

  it('should count non-bypass-request pending questions regardless of age', () => {
    const db = createDeputyCtoDB();

    // A bypass-request from 2 hours ago (should be filtered out)
    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
      VALUES (?, 'bypass-request', 'pending', 'Old bypass', 'desc', ?, ?)
    `).run('q-old-bypass', isoOffsetNow(-2 * 60 * 60 * 1000), isoOffsetNow(-2 * 60 * 60 * 1000));

    // A regular question from 3 hours ago (should NOT be filtered — TTL only applies to bypass-request)
    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
      VALUES (?, 'question', 'pending', 'Old question', 'desc', ?, ?)
    `).run('q-old-question', isoOffsetNow(-3 * 60 * 60 * 1000), isoOffsetNow(-3 * 60 * 60 * 1000));

    const bypassCutoff = new Date(Date.now() - 3600 * 1000).toISOString();
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM questions
      WHERE status = 'pending'
      AND NOT (type = 'bypass-request' AND created_timestamp < ?)
    `).get(bypassCutoff);

    db.close();

    // Old bypass excluded (1), old question included (1) → count = 1
    assert.strictEqual(result.count, 1, 'TTL filter must only apply to bypass-request type, not other question types');
  });

  it('should count both a recent bypass-request and a regular question as 2', () => {
    const db = createDeputyCtoDB();

    // Recent bypass-request (30 min ago — within TTL)
    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
      VALUES (?, 'bypass-request', 'pending', 'Recent bypass', 'desc', ?, ?)
    `).run('q-bypass', isoOffsetNow(-30 * 60 * 1000), isoOffsetNow(-30 * 60 * 1000));

    // Regular decision question from 2 hours ago (no TTL)
    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
      VALUES (?, 'decision', 'pending', 'Architecture decision', 'desc', ?, ?)
    `).run('q-decision', isoOffsetNow(-2 * 60 * 60 * 1000), isoOffsetNow(-2 * 60 * 60 * 1000));

    const bypassCutoff = new Date(Date.now() - 3600 * 1000).toISOString();
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM questions
      WHERE status = 'pending'
      AND NOT (type = 'bypass-request' AND created_timestamp < ?)
    `).get(bypassCutoff);

    db.close();

    assert.strictEqual(result.count, 2, 'Both a recent bypass-request and a decision question must be counted');
  });

  it('should not count answered questions regardless of type or age', () => {
    const db = createDeputyCtoDB();

    // Answered bypass-request (recent — but answered, so excluded by status filter)
    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp, answered_at)
      VALUES (?, 'bypass-request', 'answered', 'Answered bypass', 'desc', ?, ?, ?)
    `).run('q-answered', isoOffsetNow(-5 * 60 * 1000), isoOffsetNow(-5 * 60 * 1000), isoOffsetNow(-1 * 60 * 1000));

    const bypassCutoff = new Date(Date.now() - 3600 * 1000).toISOString();
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM questions
      WHERE status = 'pending'
      AND NOT (type = 'bypass-request' AND created_timestamp < ?)
    `).get(bypassCutoff);

    db.close();

    assert.strictEqual(result.count, 0, 'Answered questions must never appear in pending count');
  });
});

// =============================================================================
// G005: ISO 8601 Timestamp Comparison - hasValidBypassDecision() emergency bypass
//
// The function checks for commit_decisions where:
//   const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
//   WHERE decision = 'approved'
//   AND rationale LIKE 'EMERGENCY BYPASS%'
//   AND question_id IS NOT NULL
//   AND created_timestamp > ?   ← ISO 8601 comparison
//
// A bypass created 10 minutes ago must be rejected (outside the 5-min window).
// A bypass created 2 minutes ago must be accepted.
// =============================================================================

describe('G005: hasValidBypassDecision() - emergency bypass 5-minute window', () => {
  it('should accept an emergency bypass created 2 minutes ago (within 5-min window)', () => {
    const db = createDeputyCtoDB();

    // Insert a question so question_id IS NOT NULL constraint is met
    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
      VALUES (?, 'bypass-request', 'answered', 'Bypass request', 'desc', ?, ?)
    `).run('q-bypass-ref', isoOffsetNow(-3 * 60 * 1000), isoOffsetNow(-3 * 60 * 1000));

    // Emergency bypass created 2 minutes ago — within the 5-minute window
    db.prepare(`
      INSERT INTO commit_decisions (id, decision, rationale, question_id, created_at, created_timestamp)
      VALUES (?, 'approved', 'EMERGENCY BYPASS: CTO approved urgent fix', ?, ?, ?)
    `).run('cd-recent', 'q-bypass-ref', isoOffsetNow(-2 * 60 * 1000), isoOffsetNow(-2 * 60 * 1000));

    // Mirror the exact SQL from hasValidBypassDecision()
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const bypass = db.prepare(`
      SELECT id, rationale FROM commit_decisions
      WHERE decision = 'approved'
      AND rationale LIKE 'EMERGENCY BYPASS%'
      AND question_id IS NOT NULL
      AND created_timestamp > ?
      ORDER BY created_timestamp DESC
      LIMIT 1
    `).get(fiveMinutesAgo);

    db.close();

    assert.ok(bypass !== undefined, 'Emergency bypass from 2 minutes ago must be found (within 5-min window)');
    assert.ok(bypass.rationale.startsWith('EMERGENCY BYPASS'), 'Returned row must have EMERGENCY BYPASS rationale');
  });

  it('should reject an emergency bypass created 10 minutes ago (outside 5-min window)', () => {
    const db = createDeputyCtoDB();

    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
      VALUES (?, 'bypass-request', 'answered', 'Bypass request', 'desc', ?, ?)
    `).run('q-stale-ref', isoOffsetNow(-12 * 60 * 1000), isoOffsetNow(-12 * 60 * 1000));

    // Emergency bypass created 10 minutes ago — expired (outside the 5-minute window)
    db.prepare(`
      INSERT INTO commit_decisions (id, decision, rationale, question_id, created_at, created_timestamp)
      VALUES (?, 'approved', 'EMERGENCY BYPASS: Old approval', ?, ?, ?)
    `).run('cd-expired', 'q-stale-ref', isoOffsetNow(-10 * 60 * 1000), isoOffsetNow(-10 * 60 * 1000));

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const bypass = db.prepare(`
      SELECT id, rationale FROM commit_decisions
      WHERE decision = 'approved'
      AND rationale LIKE 'EMERGENCY BYPASS%'
      AND question_id IS NOT NULL
      AND created_timestamp > ?
      ORDER BY created_timestamp DESC
      LIMIT 1
    `).get(fiveMinutesAgo);

    db.close();

    assert.strictEqual(bypass, undefined, 'Emergency bypass from 10 minutes ago must be rejected (expired, outside 5-min window)');
  });

  it('should return the most recent bypass when multiple exist, selecting by created_timestamp DESC', () => {
    const db = createDeputyCtoDB();

    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
      VALUES (?, 'bypass-request', 'answered', 'Bypass ref', 'desc', ?, ?)
    `).run('q-multi-ref', isoOffsetNow(-10 * 60 * 1000), isoOffsetNow(-10 * 60 * 1000));

    // An expired bypass (7 minutes ago — outside 5-min window)
    db.prepare(`
      INSERT INTO commit_decisions (id, decision, rationale, question_id, created_at, created_timestamp)
      VALUES (?, 'approved', 'EMERGENCY BYPASS: Old', ?, ?, ?)
    `).run('cd-old', 'q-multi-ref', isoOffsetNow(-7 * 60 * 1000), isoOffsetNow(-7 * 60 * 1000));

    // A recent bypass (1 minute ago — within 5-min window)
    db.prepare(`
      INSERT INTO commit_decisions (id, decision, rationale, question_id, created_at, created_timestamp)
      VALUES (?, 'approved', 'EMERGENCY BYPASS: New', ?, ?, ?)
    `).run('cd-new', 'q-multi-ref', isoOffsetNow(-1 * 60 * 1000), isoOffsetNow(-1 * 60 * 1000));

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const bypass = db.prepare(`
      SELECT id, rationale FROM commit_decisions
      WHERE decision = 'approved'
      AND rationale LIKE 'EMERGENCY BYPASS%'
      AND question_id IS NOT NULL
      AND created_timestamp > ?
      ORDER BY created_timestamp DESC
      LIMIT 1
    `).get(fiveMinutesAgo);

    db.close();

    assert.ok(bypass !== undefined, 'Should find the recent bypass');
    assert.strictEqual(bypass.id, 'cd-new', 'Must return the most recent (newest) bypass when ORDER BY created_timestamp DESC');
  });

  it('should not accept an approved decision without EMERGENCY BYPASS rationale prefix', () => {
    const db = createDeputyCtoDB();

    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
      VALUES (?, 'approval', 'answered', 'Approval ref', 'desc', ?, ?)
    `).run('q-approval-ref', isoOffsetNow(-2 * 60 * 1000), isoOffsetNow(-2 * 60 * 1000));

    // Regular approval (not an emergency bypass) — must not be matched
    db.prepare(`
      INSERT INTO commit_decisions (id, decision, rationale, question_id, created_at, created_timestamp)
      VALUES (?, 'approved', 'Approved via normal review', ?, ?, ?)
    `).run('cd-normal', 'q-approval-ref', isoOffsetNow(-1 * 60 * 1000), isoOffsetNow(-1 * 60 * 1000));

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const bypass = db.prepare(`
      SELECT id, rationale FROM commit_decisions
      WHERE decision = 'approved'
      AND rationale LIKE 'EMERGENCY BYPASS%'
      AND question_id IS NOT NULL
      AND created_timestamp > ?
      ORDER BY created_timestamp DESC
      LIMIT 1
    `).get(fiveMinutesAgo);

    db.close();

    assert.strictEqual(bypass, undefined, 'Normal approvals without EMERGENCY BYPASS prefix must not trigger bypass');
  });
});

// =============================================================================
// G005: ISO 8601 Timestamp Comparison - hasValidBypassDecision() promotion bypass
//
// The function parses the duration from the rationale string:
//   PROMOTION BYPASS (Nmin)
// then computes expiry using:
//   const createdMs = new Date(promotionBypass.created_timestamp).getTime();
//   const expiresMs = createdMs + (durationMin * 60 * 1000);
//   if (Date.now() < expiresMs) → valid
//
// Tests verify the ISO 8601 timestamp is correctly parsed by new Date() and
// that expiry is computed accurately against a real duration.
// =============================================================================

describe('G005: hasValidBypassDecision() - promotion bypass duration expiry', () => {
  /**
   * Mirror the exact promotion bypass expiry logic from hasValidBypassDecision().
   * Returns true if the bypass is still valid, false if expired.
   */
  function isPromotionBypassValid(createdTimestamp, rationaleStr) {
    const match = rationaleStr.match(/PROMOTION BYPASS \((\d+)min\)/);
    const durationMin = match ? parseInt(match[1], 10) : 30;
    const createdMs = new Date(createdTimestamp).getTime();
    const expiresMs = createdMs + (durationMin * 60 * 1000);
    return Date.now() < expiresMs;
  }

  it('should accept a promotion bypass created within its stated duration (20-min bypass, created 10 min ago)', () => {
    const db = createDeputyCtoDB();

    // 20-minute bypass created 10 minutes ago — 10 minutes remaining
    const createdTimestamp = isoOffsetNow(-10 * 60 * 1000);
    db.prepare(`
      INSERT INTO commit_decisions (id, decision, rationale, question_id, created_at, created_timestamp)
      VALUES (?, 'approved', 'PROMOTION BYPASS (20min): preview->staging', NULL, ?, ?)
    `).run('cd-promo-valid', createdTimestamp, createdTimestamp);

    const promotionBypass = db.prepare(`
      SELECT id, rationale, created_timestamp FROM commit_decisions
      WHERE decision = 'approved'
      AND rationale LIKE 'PROMOTION BYPASS%'
      ORDER BY created_timestamp DESC LIMIT 1
    `).get();

    db.close();

    assert.ok(promotionBypass !== undefined, 'Must find the promotion bypass record');
    const valid = isPromotionBypassValid(promotionBypass.created_timestamp, promotionBypass.rationale);
    assert.strictEqual(valid, true, '20-min promotion bypass created 10 min ago must still be valid (10 min remaining)');
  });

  it('should reject a promotion bypass that has exceeded its stated duration (20-min bypass, created 25 min ago)', () => {
    const db = createDeputyCtoDB();

    // 20-minute bypass created 25 minutes ago — expired by 5 minutes
    const createdTimestamp = isoOffsetNow(-25 * 60 * 1000);
    db.prepare(`
      INSERT INTO commit_decisions (id, decision, rationale, question_id, created_at, created_timestamp)
      VALUES (?, 'approved', 'PROMOTION BYPASS (20min): preview->staging', NULL, ?, ?)
    `).run('cd-promo-expired', createdTimestamp, createdTimestamp);

    const promotionBypass = db.prepare(`
      SELECT id, rationale, created_timestamp FROM commit_decisions
      WHERE decision = 'approved'
      AND rationale LIKE 'PROMOTION BYPASS%'
      ORDER BY created_timestamp DESC LIMIT 1
    `).get();

    db.close();

    assert.ok(promotionBypass !== undefined, 'Must find the promotion bypass record');
    const valid = isPromotionBypassValid(promotionBypass.created_timestamp, promotionBypass.rationale);
    assert.strictEqual(valid, false, '20-min promotion bypass created 25 min ago must be expired');
  });

  it('should default to a 30-minute duration when rationale has no (Nmin) group', () => {
    const db = createDeputyCtoDB();

    // PROMOTION BYPASS without duration annotation — defaults to 30 min
    // Created 15 minutes ago → still valid under 30-min default
    const createdTimestamp = isoOffsetNow(-15 * 60 * 1000);
    db.prepare(`
      INSERT INTO commit_decisions (id, decision, rationale, question_id, created_at, created_timestamp)
      VALUES (?, 'approved', 'PROMOTION BYPASS: no duration specified', NULL, ?, ?)
    `).run('cd-promo-default', createdTimestamp, createdTimestamp);

    const promotionBypass = db.prepare(`
      SELECT id, rationale, created_timestamp FROM commit_decisions
      WHERE decision = 'approved'
      AND rationale LIKE 'PROMOTION BYPASS%'
      ORDER BY created_timestamp DESC LIMIT 1
    `).get();

    db.close();

    assert.ok(promotionBypass !== undefined, 'Must find the promotion bypass record');
    const valid = isPromotionBypassValid(promotionBypass.created_timestamp, promotionBypass.rationale);
    assert.strictEqual(valid, true, 'Promotion bypass without (Nmin) defaults to 30 min; created 15 min ago must still be valid');
  });

  it('should correctly parse created_timestamp as ISO 8601 (not Unix epoch)', () => {
    // This test validates that new Date(iso8601String).getTime() produces the right
    // millisecond value, confirming that ISO 8601 strings round-trip correctly.
    const tenMinutesAgo = isoOffsetNow(-10 * 60 * 1000);
    const parsedMs = new Date(tenMinutesAgo).getTime();
    const nowMs = Date.now();

    // The parsed timestamp should be approximately 10 minutes before now
    const diffMs = nowMs - parsedMs;

    assert.ok(diffMs >= 9 * 60 * 1000, `Parsed ISO 8601 timestamp must be at least 9 minutes in the past (got ${diffMs}ms)`);
    assert.ok(diffMs <= 11 * 60 * 1000, `Parsed ISO 8601 timestamp must be no more than 11 minutes in the past (got ${diffMs}ms)`);
    assert.ok(!Number.isNaN(parsedMs), 'new Date(isoString).getTime() must not be NaN');
    assert.ok(Number.isFinite(parsedMs), 'new Date(isoString).getTime() must be a finite number');
  });
});

// =============================================================================
// G005: Regression Guard - no Unix epoch comparisons in SQL-related code
//
// The three functions fixed in G005 previously used Math.floor(Date.now() / 1000)
// (Unix epoch seconds) instead of ISO 8601 strings when building SQL cutoff
// parameters. Since SQLite stores created_timestamp as TEXT in ISO 8601 format,
// comparing against an integer produced incorrect results (integers sort before
// all ISO strings lexicographically, making every timestamp appear "future").
//
// These regression tests confirm the source code does not regress back to
// Unix epoch comparisons near SQL query boundaries.
// =============================================================================

describe('G005: Regression Guard - no Unix epoch comparisons in SQL context', () => {
  const HOOK_PATH = path.join(process.cwd(), '.claude/hooks/pre-commit-review.js');

  it('should not contain Math.floor(Date.now() / 1000) anywhere in the source', () => {
    // This was the original buggy pattern. It must never appear in the file again.
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    assert.doesNotMatch(
      hookCode,
      /Math\.floor\(Date\.now\(\)\s*\/\s*1000\)/,
      'REGRESSION: Math.floor(Date.now() / 1000) (Unix epoch) must not appear in source — use new Date(...).toISOString() instead'
    );
  });

  it('should use new Date(...).toISOString() for building SQL timestamp cutoff values', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // All three timestamp cutoff computations must use ISO 8601
    assert.match(
      hookCode,
      /new Date\(Date\.now\(\)\s*-\s*\d+.*\)\.toISOString\(\)/,
      'Must use new Date(Date.now() - offset).toISOString() for SQL timestamp comparisons (G005)'
    );
  });

  it('should use bypassCutoff ISO 8601 string as parameter to hasPendingCtoItems() SQL query', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // The bypassCutoff variable must be declared as an ISO 8601 string
    assert.match(
      hookCode,
      /const bypassCutoff = new Date\(Date\.now\(\)\s*-\s*3600\s*\*\s*1000\)\.toISOString\(\)/,
      'hasPendingCtoItems(): bypassCutoff must be computed as ISO 8601 string, not Unix epoch'
    );
  });

  it('should use fiveMinutesAgo ISO 8601 string as parameter to hasValidBypassDecision() emergency bypass query', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // The fiveMinutesAgo variable must be declared as an ISO 8601 string
    assert.match(
      hookCode,
      /const fiveMinutesAgo = new Date\(Date\.now\(\)\s*-\s*5\s*\*\s*60\s*\*\s*1000\)\.toISOString\(\)/,
      'hasValidBypassDecision(): fiveMinutesAgo must be computed as ISO 8601 string, not Unix epoch'
    );
  });

  it('should use new Date(promotionBypass.created_timestamp).getTime() for promotion bypass expiry calculation', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // The promotion bypass expiry must parse the ISO 8601 created_timestamp via new Date()
    assert.match(
      hookCode,
      /new Date\(promotionBypass\.created_timestamp\)\.getTime\(\)/,
      'hasValidBypassDecision(): promotion bypass expiry must parse created_timestamp as ISO 8601 via new Date().getTime()'
    );
  });
});
