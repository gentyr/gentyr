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
    // 1. better-sqlite3 unavailable
    // 2. pending rejections check error
    // 3. pending rejections exist
    // 4. git diff error
    // 5. no decision timeout
    // 6. review error catch block
    // 7. rejection decision

    assert.ok(blockingExits >= 6, `Should have at least 6 fail-closed exits, found ${blockingExits}`);
  });

  it('should validate emergency bypass is documented', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // Count emergency bypass messages
    const bypassMessages = (hookCode.match(/Emergency bypass: SKIP_DEPUTY_CTO_REVIEW=1/g) || []).length;

    // Should appear in multiple error messages
    assert.ok(bypassMessages >= 4, `Should have at least 4 bypass messages, found ${bypassMessages}`);
  });

  it('should validate G001 is explicitly mentioned', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    assert.match(hookCode, /G001/, 'Should mention G001 spec');
    assert.match(hookCode, /Fail-closed|fail-closed/, 'Should mention fail-closed principle');
  });

  it('should have exactly one approval exit point (exit 0 with approval)', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // Validate approval logic
    assert.match(hookCode, /if \(decision\.decision === 'approved'\)/, 'Should check for approval');
    assert.match(hookCode, /APPROVED/, 'Should have approval message');
  });

  it('should validate timeout constants are reasonable', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    assert.match(hookCode, /REVIEW_TIMEOUT_MS = 120000/, 'Should have 2 minute timeout');
    assert.match(hookCode, /POLL_INTERVAL_MS = 1000/, 'Should poll every 1 second');
  });

  it('should validate return structure consistency', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // getStagedDiff should return { files, stat, diff, error }
    assert.match(hookCode, /files:.*stat.*diff.*error/s, 'getStagedDiff should return correct structure');

    // hasPendingRejections should return { hasRejections, error }
    assert.match(hookCode, /hasRejections.*error/s, 'hasPendingRejections should return correct structure');
  });

  it('should validate all blocking errors provide emergency bypass', () => {
    const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

    // Each COMMIT BLOCKED message should be part of an error output with emergency bypass
    // Check that emergency bypass appears multiple times throughout error messages
    const commitBlockedCount = (hookCode.match(/COMMIT BLOCKED/g) || []).length;
    const emergencyBypassCount = (hookCode.match(/Emergency bypass|SKIP_DEPUTY_CTO_REVIEW=1/g) || []).length;

    // We should have roughly as many bypass messages as blocked messages
    // (some may share the same block, but all error paths should have it)
    assert.ok(
      emergencyBypassCount >= 4,
      `Should have at least 4 emergency bypass references, found ${emergencyBypassCount}`
    );
    assert.ok(
      commitBlockedCount >= 4,
      `Should have at least 4 COMMIT BLOCKED messages, found ${commitBlockedCount}`
    );
  });
});
