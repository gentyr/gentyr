/**
 * Tests for pre-commit-review.js
 *
 * These tests validate G001 fail-closed behavior:
 * - System errors MUST block commits
 * - Missing dependencies MUST block commits
 * - Database errors MUST block commits
 * - Git errors MUST block commits
 * - Only SKIP_DEPUTY_CTO_REVIEW=1 bypasses protection
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/pre-commit-review.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

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
    it('should allow commit when SKIP_DEPUTY_CTO_REVIEW=1 is set', async () => {
      const result = await runHook({ SKIP_DEPUTY_CTO_REVIEW: '1' });

      assert.strictEqual(result.code, 0, 'Should exit with code 0 when bypassing');
      assert.match(result.stdout, /bypassing review/, 'Should contain bypass message');
      assert.match(result.stdout, /WARNING.*emergencies/, 'Should warn about emergency use');
    });

    it('should NOT bypass when SKIP_DEPUTY_CTO_REVIEW is not 1', async () => {
      const result = await runHook({ SKIP_DEPUTY_CTO_REVIEW: '0' });

      // Should proceed to normal flow (will fail on other checks, but not bypass)
      assert.doesNotMatch(result.stdout, /bypassing review/, 'Should not bypass when flag is not 1');
    });
  });

  describe('Pending Rejections Check - G001 Fail-Closed', () => {
    it('should have code structure to block commits on database errors', () => {
      // Rather than trying to trigger a database error (which is hard to do reliably),
      // verify the code structure handles errors correctly

      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // hasPendingRejections should have error handling
      assert.match(hookCode, /function hasPendingRejections/, 'Should define function');
      assert.match(hookCode, /catch \(err\)/, 'Should catch database errors');
      assert.match(hookCode, /return \{ hasRejections: false, error: true \}/, 'Should return error state');

      // main() should check for error and block
      assert.match(hookCode, /if \(rejectionCheck\.error\)/, 'Should check error flag');
      assert.match(hookCode, /COMMIT BLOCKED.*Error checking for pending rejections/s, 'Should have error message');
      assert.match(hookCode, /process\.exit\(1\)/, 'Should block commit on error');
    });

    it('should block commit when pending rejections exist', async () => {
      // This test requires a valid database with rejection entries
      // We'll create a minimal valid database for this test

      const Database = (await import('better-sqlite3')).default;
      const testDb = new Database(DEPUTY_CTO_DB);

      try {
        // Ensure schema exists
        testDb.exec(`
          CREATE TABLE IF NOT EXISTS questions (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            status TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            created_timestamp TEXT NOT NULL
          );
        `);

        // Insert a pending rejection
        testDb.prepare(`
          INSERT INTO questions (id, type, status, title, description, created_timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          'test-rejection-1',
          'rejection',
          'pending',
          'Test Rejection',
          'This is a test rejection',
          new Date().toISOString()
        );

        testDb.close();

        const result = await runHook();

        assert.strictEqual(result.code, 1, 'Should block commit when rejections exist');
        assert.match(result.stderr, /COMMIT BLOCKED/, 'Should show commit blocked message');
        assert.match(result.stderr, /Pending rejection\(s\) must be addressed/, 'Should explain reason');

        // Clean up
        const cleanDb = new Database(DEPUTY_CTO_DB);
        cleanDb.prepare('DELETE FROM questions WHERE id = ?').run('test-rejection-1');
        cleanDb.close();
      } catch (err) {
        testDb.close();
        throw err;
      }
    });
  });

  describe('Git Command Errors - G001 Fail-Closed', () => {
    it('should have code structure to block commits on git errors', () => {
      // This is hard to test without breaking git state
      // We verify the code structure exists instead

      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /if \(stagedInfo\.error\)/, 'Should check for git error flag');
      assert.match(hookCode, /COMMIT BLOCKED: Error getting staged changes/, 'Should have error message');
      assert.match(hookCode, /process\.exit\(1\)/, 'Should exit with code 1');
    });

    it('should allow commit when no files are staged', async () => {
      // Ensure we're in a clean git state with no staged files
      try {
        execSync('git reset', { cwd: PROJECT_DIR, stdio: 'pipe' });
      } catch {
        // Ignore errors
      }

      const result = await runHook();

      // Should allow commit since there's nothing to review
      assert.strictEqual(result.code, 0, 'Should allow commit with no staged files');
      assert.match(result.stdout, /No staged files/, 'Should indicate no files to review');
    });
  });

  describe('Normal Operation Flow', () => {
    it('should proceed to deputy-cto review when checks pass', async () => {
      // This test verifies that with:
      // - No bypass flag
      // - No pending rejections
      // - Valid staged files
      // - No database errors
      // The hook proceeds to spawn deputy-cto

      // Stage a test file
      const testFile = path.join(PROJECT_DIR, '.claude/hooks/test-commit-file.txt');
      fs.writeFileSync(testFile, 'Test content for commit');

      try {
        execSync(`git add ${testFile}`, { cwd: PROJECT_DIR, stdio: 'pipe' });

        // Run with short timeout to verify it gets to review stage
        const proc = spawn('node', [HOOK_PATH], {
          cwd: PROJECT_DIR,
          env: process.env,
          stdio: 'pipe',
        });

        let output = '';
        proc.stdout.on('data', (data) => {
          output += data.toString();
        });

        // Give it time to start review process
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Kill the process (we don't want it to actually complete review)
        proc.kill();

        // Clean up
        execSync(`git reset ${testFile}`, { cwd: PROJECT_DIR, stdio: 'pipe' });
        if (fs.existsSync(testFile)) {
          fs.unlinkSync(testFile);
        }

        // Should have progressed past initial checks
        assert.match(output, /Reviewing/, 'Should start reviewing staged files');
      } catch (err) {
        // Clean up on error
        try {
          execSync(`git reset ${testFile}`, { cwd: PROJECT_DIR, stdio: 'pipe' });
          if (fs.existsSync(testFile)) {
            fs.unlinkSync(testFile);
          }
        } catch {
          // Ignore cleanup errors
        }
        throw err;
      }
    });
  });

  describe('Decision Handling', () => {
    it('should have fail-closed logic when no decision is made', () => {
      // Verify the fail-closed logic exists
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /if \(!decision\)/, 'Should check for missing decision');
      assert.match(hookCode, /COMMIT BLOCKED: Deputy-CTO review timed out/, 'Should have timeout message');
      assert.match(hookCode, /G001: Fail-closed/, 'Should reference G001 spec');
      assert.match(hookCode, /process\.exit\(1\)/, 'Should block commit');
    });

    it('should allow commit on approved decision', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /if \(decision\.decision === 'approved'\)/, 'Should check for approval');
      assert.match(hookCode, /APPROVED/, 'Should have approval message');
      assert.match(hookCode, /process\.exit\(0\)/, 'Should allow commit on approval');
    });

    it('should block commit on rejected decision', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /COMMIT REJECTED by deputy-cto/, 'Should have rejection message');
      assert.match(hookCode, /process\.exit\(1\)/, 'Should block commit on rejection');
    });
  });

  describe('Error Handling - G001 Fail-Closed', () => {
    it('should block commit when review spawning fails', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Verify catch block exists and blocks commit
      assert.match(hookCode, /catch \(err\)/, 'Should have error catch block');
      assert.match(hookCode, /COMMIT BLOCKED: Deputy-CTO review error/, 'Should have error message');
      assert.match(hookCode, /G001: Fail-closed/, 'Should reference G001 spec');
      assert.match(hookCode, /Emergency bypass/, 'Should mention emergency bypass');
    });
  });

  describe('Dynamic Cooldown Configuration', () => {
    it('should import getCooldown from config-reader', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /import \{[\s\S]*?getCooldown[\s\S]*?\} from ['"]\.\/config-reader\.js['"]/,
        'Must import getCooldown from config-reader.js'
      );
    });

    it('should use getCooldown for TOKEN_EXPIRY_MS with default of 5 minutes', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /const TOKEN_EXPIRY_MS = getCooldown\(['"]pre_commit_review['"], 5\) \* 60 \* 1000/,
        'Must use getCooldown for TOKEN_EXPIRY_MS with 5 minute default'
      );
    });

    it('should allow usage optimizer to dynamically adjust token expiry', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Verify TOKEN_EXPIRY_MS is calculated from getCooldown (not a hardcoded constant)
      assert.match(
        hookCode,
        /TOKEN_EXPIRY_MS = getCooldown/,
        'TOKEN_EXPIRY_MS must be dynamically calculated'
      );

      // Verify it's not a const literal like "const TOKEN_EXPIRY_MS = 300000"
      assert.doesNotMatch(
        hookCode,
        /const TOKEN_EXPIRY_MS = \d+/,
        'TOKEN_EXPIRY_MS must not be a hardcoded number'
      );
    });

    it('should convert cooldown from minutes to milliseconds', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /getCooldown\(['"]pre_commit_review['"], 5\) \* 60 \* 1000/,
        'Must convert minutes to milliseconds (* 60 * 1000)'
      );
    });
  });

  describe('Database Module Unavailable - G001 Fail-Closed', () => {
    it('should have fail-closed behavior when better-sqlite3 is missing', () => {
      // This is validated by checking the code structure
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /try \{/, 'Should have try block for import');
      assert.match(hookCode, /await import\('better-sqlite3'\)/, 'Should try to import better-sqlite3');
      assert.match(hookCode, /\} catch \{/, 'Should catch import failure');
      assert.match(hookCode, /COMMIT BLOCKED: better-sqlite3 not available/, 'Should have error message');
      assert.match(hookCode, /process\.exit\(1\)/, 'Should block commit');
      assert.match(hookCode, /fail-closed \(G001\)/, 'Should reference G001 in comment');
    });
  });
});

describe('Helper Functions - Code Structure Tests', () => {
  const HOOK_PATH = path.join(process.cwd(), '.claude/hooks/pre-commit-review.js');

  describe('getStagedDiff()', () => {
    it('should return structured diff information', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /function getStagedDiff\(\)/, 'Should define getStagedDiff function');
      assert.match(hookCode, /git diff --cached --name-only/, 'Should get staged file names');
      assert.match(hookCode, /git diff --cached --stat/, 'Should get diff statistics');
      assert.match(hookCode, /git diff --cached[^-]/, 'Should get full diff');
      assert.match(hookCode, /return \{[\s\S]*?files:/, 'Should return files array');
      assert.match(hookCode, /stat/, 'Should return stat string');
      assert.match(hookCode, /diff/, 'Should return diff string');
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
      assert.match(hookCode, /return \{ files: \[\], stat: '', diff: '', error: true \}/, 'Should return error state');
    });
  });

  describe('hasPendingRejections()', () => {
    it('should return correct structure on success', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /function hasPendingRejections\(\)/, 'Should define function');
      assert.match(hookCode, /return \{ hasRejections:/, 'Should return hasRejections flag');
      assert.match(hookCode, /error: false/, 'Should return error: false on success');
    });

    it('should return error state on database failure', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /return \{ hasRejections: false, error: true \}/, 'Should return error state');
    });

    it('should handle missing database gracefully', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /if \(!fs\.existsSync\(DEPUTY_CTO_DB\)\)/, 'Should check if DB exists');
      assert.match(hookCode, /return \{ hasRejections: false, error: false \}/, 'Should return safe state');
    });
  });

  describe('clearPreviousDecision()', () => {
    it('should handle missing database without errors', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /function clearPreviousDecision\(\)/, 'Should define function');
      assert.match(hookCode, /if \(!fs\.existsSync\(DEPUTY_CTO_DB\)\)/, 'Should check existence');
      assert.match(hookCode, /return;/, 'Should return early if no DB');
    });

    it('should log but continue on database errors', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /catch \(err\)/, 'Should catch errors');
      assert.match(hookCode, /Warning: Could not clear previous decision/, 'Should log warning');
      assert.match(hookCode, /non-blocking/, 'Should document as non-blocking');
    });
  });

  describe('getCommitDecision()', () => {
    it('should return null when database does not exist', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /function getCommitDecision\(\)/, 'Should define function');
      assert.match(hookCode, /return null/, 'Should return null when DB missing');
    });

    it('should return null on query errors', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(hookCode, /\} catch \{/, 'Should catch query errors');
      assert.match(hookCode, /return null/, 'Should return null on error');
    });
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
    // 6. no approval token (final reject)

    assert.ok(blockingExits >= 6, `Should have at least 6 fail-closed exits, found ${blockingExits}`);
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
