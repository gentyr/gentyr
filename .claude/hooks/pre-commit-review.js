#!/usr/bin/env node
/**
 * Pre-Commit Review Hook (v3.0 - Approval Token)
 *
 * Flow:
 * 1. First commit attempt → Rejected, spawns deputy-cto review in background
 * 2. Deputy-CTO reviews and approves → Writes approval token
 * 3. Second commit attempt → Token valid? Allow. Otherwise reject.
 *
 * Token expires after 5 minutes and is tied to the staged files hash.
 *
 * @version 3.0.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { registerSpawn, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { getCooldown } from './config-reader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DEPUTY_CTO_DB = path.join(PROJECT_DIR, '.claude', 'deputy-cto.db');
const APPROVAL_TOKEN_FILE = path.join(PROJECT_DIR, '.claude', 'commit-approval-token.json');

// Token expires after configured minutes (default 5)
const TOKEN_EXPIRY_MS = getCooldown('pre_commit_review', 5) * 60 * 1000;

// Try to import better-sqlite3
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  console.error('[pre-commit] Warning: better-sqlite3 not available');
}

/**
 * Get staged files and compute a hash for token validation
 */
function getStagedInfo() {
  try {
    const files = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
    const stat = execSync('git diff --cached --stat', { encoding: 'utf8' }).trim();
    const diff = execSync('git diff --cached', { encoding: 'utf8' });

    // Hash the diff to ensure token matches the staged changes
    const diffHash = crypto.createHash('sha256').update(diff).digest('hex').substring(0, 16);

    // Truncate diff if too long
    const truncatedDiff = diff.length > 10000
      ? diff.substring(0, 10000) + '\n\n... [diff truncated, ' + diff.length + ' chars total]'
      : diff;

    return {
      files: files.split('\n').filter(f => f),
      stat,
      diff: truncatedDiff,
      diffHash,
      error: false,
    };
  } catch (err) {
    console.error(`[pre-commit] Error getting staged diff: ${err.message}`);
    return { files: [], stat: '', diff: '', diffHash: '', error: true };
  }
}

/**
 * Check for pending CTO items that block commits (G020 compliance)
 * This includes ALL pending questions (not just rejections) and pending triage items.
 */
function hasPendingCtoItems() {
  if (!Database || !fs.existsSync(DEPUTY_CTO_DB)) {
    return { hasItems: false, count: 0, error: false };
  }

  try {
    const db = new Database(DEPUTY_CTO_DB, { readonly: true });

    // Check ALL pending questions (any type, not just rejections)
    const questionsResult = db.prepare(
      "SELECT COUNT(*) as count FROM questions WHERE status = 'pending'"
    ).get();
    const questionCount = questionsResult?.count || 0;

    db.close();

    // Also check pending triage items from cto-reports.db
    let triageCount = 0;
    const CTO_REPORTS_DB = path.join(PROJECT_DIR, '.claude', 'cto-reports.db');
    if (fs.existsSync(CTO_REPORTS_DB)) {
      try {
        const reportsDb = new Database(CTO_REPORTS_DB, { readonly: true });
        // Check if triage_status column exists
        const columns = reportsDb.pragma('table_info(reports)');
        const hasTriageStatus = columns.some(c => c.name === 'triage_status');

        if (hasTriageStatus) {
          const triageResult = reportsDb.prepare(
            "SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'"
          ).get();
          triageCount = triageResult?.count || 0;
        } else {
          // Fallback for databases without triage_status column
          const triageResult = reportsDb.prepare(
            "SELECT COUNT(*) as count FROM reports WHERE triaged_at IS NULL"
          ).get();
          triageCount = triageResult?.count || 0;
        }
        reportsDb.close();
      } catch {
        // G001: Fail closed - if we can't read triage count, assume there are pending items
        // This blocks commits when the database is corrupted/unreadable (safer default)
        triageCount = 1;
      }
    }

    const totalCount = questionCount + triageCount;
    return { hasItems: totalCount > 0, count: totalCount, questionCount, triageCount, error: false };
  } catch (err) {
    console.error(`[pre-commit] Error checking CTO items: ${err.message}`);
    // G001: Fail closed - on error reading DB, block commits (safer default)
    return { hasItems: true, count: 1, error: true };
  }
}

/**
 * Check if a valid approval token exists for the current staged changes
 */
function checkApprovalToken(diffHash) {
  if (!fs.existsSync(APPROVAL_TOKEN_FILE)) {
    return { valid: false, reason: 'no-token' };
  }

  try {
    const token = JSON.parse(fs.readFileSync(APPROVAL_TOKEN_FILE, 'utf8'));

    // Empty object means token was consumed (overwrite pattern for sticky-bit compat)
    if (!token.expiresAt && !token.diffHash) {
      return { valid: false, reason: 'no-token' };
    }

    const now = Date.now();

    // Check expiry
    const expiresAt = new Date(token.expiresAt).getTime();
    if (isNaN(expiresAt) || now > expiresAt) {
      fs.writeFileSync(APPROVAL_TOKEN_FILE, '{}'); // Clean up expired token (overwrite for sticky-bit compat)
      return { valid: false, reason: 'expired' };
    }

    // Check diff hash matches
    if (token.diffHash !== diffHash) {
      return { valid: false, reason: 'diff-changed' };
    }

    return { valid: true, token };
  } catch (err) {
    console.error(`[pre-commit] Error reading token: ${err.message}`);
    return { valid: false, reason: 'read-error' };
  }
}

/**
 * Consume (delete) the approval token after successful use
 */
function consumeApprovalToken() {
  try {
    if (fs.existsSync(APPROVAL_TOKEN_FILE)) {
      fs.writeFileSync(APPROVAL_TOKEN_FILE, '{}');
    }
  } catch (err) {
    console.error(`[pre-commit] Warning: Could not clear token: ${err.message}`);
  }
}

/**
 * Get branch info
 */
function getBranchInfo() {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Spawn deputy-cto to review and potentially approve the commit
 */
function spawnDeputyCtoReview(stagedInfo) {
  const branch = getBranchInfo();

  const prompt = `[Task][deputy-cto-review] You are an orchestrator. Review this pending commit and decide whether to approve it.

## IMMEDIATE ACTION

Your first action MUST be to spawn the deputy-cto sub-agent:
\`\`\`
Task(subagent_type='deputy-cto', prompt='Review this pending commit on branch ${branch} (${stagedInfo.files.length} files changed) and decide whether to approve or reject it. Use mcp__deputy-cto__approve_commit or mcp__deputy-cto__reject_commit.')
\`\`\`

The deputy-cto sub-agent has specialized instructions loaded from .claude/agents/deputy-cto.md.

## Context
- Branch: ${branch}
- Files changed: ${stagedInfo.files.length}
- Diff hash: ${stagedInfo.diffHash}

## Staged Files
${stagedInfo.files.join('\n')}

## Diff Statistics
${stagedInfo.stat}

## Full Diff
\`\`\`diff
${stagedInfo.diff}
\`\`\`

## Your Task

1. Review the changes for:
   - Security issues (hardcoded credentials, exposed secrets) - CRITICAL
   - Architectural violations (cross-product boundary violations) - CRITICAL
   - Breaking changes without documentation - IMPORTANT
   - Code quality issues - NOTE for later

2. Make a decision:
   - If APPROVED: Call mcp__deputy-cto__approve_commit({ rationale: "..." })
     This writes an approval token so the developer can commit.
   - If REJECTED: Call mcp__deputy-cto__reject_commit({ title: "...", description: "..." })
     This blocks commits until addressed via /deputy-cto.

3. For non-critical observations, use mcp__deputy-cto__add_question() to note items for CTO review.

IMPORTANT: You MUST call either approve_commit or reject_commit. The developer is waiting to commit.`;

  // Register spawn
  const agentId = registerSpawn({
    type: AGENT_TYPES.DEPUTY_CTO_REVIEW,
    hookType: HOOK_TYPES.PRE_COMMIT_REVIEW,
    description: `Review: ${stagedInfo.files.length} files on ${branch}`,
    prompt: prompt,
    metadata: {
      fileCount: stagedInfo.files.length,
      files: stagedInfo.files.slice(0, 10),
      branch,
      diffHash: stagedInfo.diffHash,
    },
  });

  const mcpConfigPath = path.join(PROJECT_DIR, '.mcp.json');

  // Spawn as detached background process
  const claude = spawn('claude', [
    '--dangerously-skip-permissions',
    '--mcp-config', mcpConfigPath,
    '-p', prompt,
  ], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
      CLAUDE_SPAWNED_SESSION: 'true',
      CLAUDE_AGENT_ID: agentId,
      DEPUTY_CTO_DIFF_HASH: stagedInfo.diffHash, // Pass hash for token creation
    },
  });

  claude.unref();

  return { agentId, pid: claude.pid };
}

/**
 * Check for a valid emergency bypass decision (created by execute_bypass)
 * Returns true if there's a recent bypass that should allow the commit through
 */
function hasValidBypassDecision() {
  if (!Database || !fs.existsSync(DEPUTY_CTO_DB)) {
    return false;
  }

  try {
    const db = new Database(DEPUTY_CTO_DB, { readonly: true });
    const fiveMinutesAgo = Math.floor((Date.now() - 5 * 60 * 1000) / 1000);

    // Check for recent bypass decisions (created by execute_bypass)
    const bypass = db.prepare(`
      SELECT id, rationale FROM commit_decisions
      WHERE decision = 'approved'
      AND rationale LIKE 'EMERGENCY BYPASS%'
      AND created_timestamp > ?
      ORDER BY created_timestamp DESC
      LIMIT 1
    `).get(fiveMinutesAgo);

    db.close();

    if (bypass) {
      console.log('[deputy-cto] ✓ Emergency bypass active - commit allowed');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Verify that git core.hooksPath hasn't been tampered with.
 * An agent could bypass hooks entirely by changing this setting.
 */
function verifyGitHooksPath() {
  try {
    const hooksPath = execSync('git config --get core.hooksPath', { encoding: 'utf8' }).trim();
    // Allow .husky (standard) or empty (default .git/hooks)
    const allowedPaths = ['.husky', ''];
    if (!allowedPaths.includes(hooksPath)) {
      return { valid: false, path: hooksPath };
    }
    return { valid: true, path: hooksPath };
  } catch {
    // No hooksPath set means using default .git/hooks - that's fine if this hook is running
    return { valid: true, path: '(default)' };
  }
}

/**
 * Verify that critical files are protected (root-owned).
 * This is defense-in-depth: even if an agent modifies files, this check catches it.
 */
function verifyProtectionStatus() {
  const protectedFiles = [
    path.join(__dirname, 'pre-commit-review.js'),
    path.join(__dirname, 'bypass-approval-hook.js'),
    path.join(PROJECT_DIR, 'eslint.config.js'),
    path.join(PROJECT_DIR, '.husky', 'pre-commit'),
    path.join(PROJECT_DIR, 'package.json'),
  ];

  const unprotectedFiles = [];

  for (const file of protectedFiles) {
    if (!fs.existsSync(file)) {
      continue; // File doesn't exist, skip
    }

    try {
      const stats = fs.statSync(file);
      // Check if file is owned by root (uid 0)
      if (stats.uid !== 0) {
        unprotectedFiles.push(file);
      }
    } catch {
      // Skip files we can't stat
    }
  }

  // Also check git hooksPath
  const hooksPathCheck = verifyGitHooksPath();

  return {
    protected: unprotectedFiles.length === 0 && hooksPathCheck.valid,
    unprotectedFiles,
    hooksPathTampered: !hooksPathCheck.valid,
    hooksPath: hooksPathCheck.path,
  };
}

/**
 * Verify lint configuration integrity.
 * Blocks if any files exist that could weaken linting strictness.
 */
function verifyLintConfigIntegrity() {
  const forbiddenFiles = [
    // ESLint override files
    '.eslintignore',
    'eslint.config.mjs',
    'eslint.config.cjs',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yaml',
    '.eslintrc.yml',
    // lint-staged override files
    '.lintstagedrc',
    '.lintstagedrc.json',
    '.lintstagedrc.yaml',
    '.lintstagedrc.yml',
    '.lintstagedrc.mjs',
    '.lintstagedrc.cjs',
    '.lintstagedrc.js',
    'lint-staged.config.js',
    'lint-staged.config.mjs',
    'lint-staged.config.cjs',
    // Husky override files
    '.huskyrc',
    '.huskyrc.json',
    '.huskyrc.js',
    '.huskyrc.yaml',
    '.huskyrc.yml',
    'husky.config.js',
  ];

  const foundFiles = [];

  for (const file of forbiddenFiles) {
    const filePath = path.join(PROJECT_DIR, file);
    if (fs.existsSync(filePath)) {
      foundFiles.push(file);
    }
  }

  return {
    valid: foundFiles.length === 0,
    forbiddenFiles: foundFiles,
  };
}

/**
 * Run ESLint directly on staged TypeScript files with --max-warnings 0.
 * This is belt-and-suspenders enforcement - even if lint-staged is bypassed,
 * this check will catch lint issues.
 *
 * SECURITY: Uses project-local eslint from node_modules to prevent PATH manipulation.
 */
function runStrictLint(stagedFiles) {
  // Filter to only TypeScript files that exist on disk (exclude deleted files)
  const tsFiles = stagedFiles.filter(f =>
    (f.endsWith('.ts') || f.endsWith('.tsx')) && fs.existsSync(path.join(PROJECT_DIR, f))
  );

  if (tsFiles.length === 0) {
    return { success: true, skipped: true };
  }

  // SECURITY: Use project-local eslint binary directly, not npx (which could be PATH-manipulated)
  const eslintBin = path.join(PROJECT_DIR, 'node_modules', '.bin', 'eslint');

  if (!fs.existsSync(eslintBin)) {
    return {
      success: false,
      output: `ESLint binary not found at ${eslintBin}. Run npm install.`,
    };
  }

  try {
    // Run eslint with max-warnings 0 on staged TS files
    // Use absolute path to eslint binary to prevent PATH manipulation attacks
    const result = execSync(
      `"${eslintBin}" --max-warnings 0 ${tsFiles.map(f => `"${f}"`).join(' ')}`,
      {
        encoding: 'utf8',
        cwd: PROJECT_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Clear any potentially malicious env vars
          ESLINT_USE_FLAT_CONFIG: 'true',
        },
      }
    );
    return { success: true, output: result };
  } catch (err) {
    // ESLint returns non-zero exit code on errors/warnings
    const output = err.stdout || err.stderr || err.message;
    return { success: false, output };
  }
}

/**
 * Main entry point
 */
async function main() {
  // NOTE: SKIP_DEPUTY_CTO_REVIEW env var bypass has been REMOVED.
  // To bypass, agents must use request_bypass() and the CTO must type
  // "APPROVE BYPASS <code>" in the chat. This creates an approval token
  // that execute_bypass() verifies.

  // ============================================================================
  // UNBYPASSABLE SECURITY CHECKS (run before any bypass checks)
  // ============================================================================

  // Check for forbidden lint config files (CRITICAL - no bypass allowed)
  const lintConfigCheck = verifyLintConfigIntegrity();
  if (!lintConfigCheck.valid) {
    console.error('');
    console.error('══════════════════════════════════════════════════════════════');
    console.error('  COMMIT BLOCKED: Forbidden lint configuration files detected!');
    console.error('');
    console.error('  These files can weaken linting strictness and must be removed:');
    for (const file of lintConfigCheck.forbiddenFiles) {
      console.error(`    - ${file}`);
    }
    console.error('');
    console.error('  This check cannot be bypassed. Remove the files to proceed.');
    console.error('══════════════════════════════════════════════════════════════');
    console.error('');
    process.exit(1);
  }

  // Check protection status (defense in depth)
  const protectionCheck = verifyProtectionStatus();

  // BLOCK if git hooksPath has been tampered with (critical security issue)
  if (protectionCheck.hooksPathTampered) {
    console.error('');
    console.error('══════════════════════════════════════════════════════════════');
    console.error('  COMMIT BLOCKED: Git hooks path has been tampered with!');
    console.error('');
    console.error(`  Current core.hooksPath: ${protectionCheck.hooksPath}`);
    console.error('  Expected: .husky (or unset)');
    console.error('');
    console.error('  This may be an attempt to bypass security hooks.');
    console.error('  To fix: git config --unset core.hooksPath');
    console.error('══════════════════════════════════════════════════════════════');
    console.error('');
    process.exit(1);
  }

  // Warn if files not protected (but don't block)
  if (protectionCheck.unprotectedFiles.length > 0) {
    console.error('');
    console.error('══════════════════════════════════════════════════════════════');
    console.error('  WARNING: Framework protection not enabled');
    console.error('');
    console.error('  Unprotected files:');
    for (const file of protectionCheck.unprotectedFiles) {
      console.error(`    - ${file}`);
    }
    console.error('');
    console.error('  Run: sudo ./scripts/protect-framework.sh');
    console.error('══════════════════════════════════════════════════════════════');
    console.error('');
    // Continue anyway - this is a warning, not a block
  }

  // Get staged changes (needed for lint check)
  const stagedInfo = getStagedInfo();

  if (stagedInfo.error) {
    console.error('[pre-commit] Error getting staged changes');
    process.exit(1);
  }

  if (stagedInfo.files.length === 0) {
    console.log('[deputy-cto] No staged files, skipping review.');
    process.exit(0);
  }

  // ============================================================================
  // STRICT LINT CHECK (UNBYPASSABLE - runs before any bypass checks)
  // ============================================================================
  const lintResult = runStrictLint(stagedInfo.files);
  if (!lintResult.success && !lintResult.skipped) {
    console.error('');
    console.error('══════════════════════════════════════════════════════════════');
    console.error('  COMMIT BLOCKED: ESLint errors or warnings detected!');
    console.error('');
    console.error('  Lint output:');
    console.error(lintResult.output);
    console.error('');
    console.error('  This check cannot be bypassed. Fix all lint issues to proceed.');
    console.error('  Rule: --max-warnings 0 (zero tolerance for warnings)');
    console.error('══════════════════════════════════════════════════════════════');
    console.error('');
    process.exit(1);
  }

  // ============================================================================
  // BYPASSABLE CHECKS (emergency bypass can skip CTO review, but NOT lint)
  // ============================================================================

  // Check for emergency bypass (allows commit even with pending CTO items)
  if (hasValidBypassDecision()) {
    console.log('[deputy-cto] ✓ Emergency bypass active - skipping CTO review');
    console.log('[deputy-cto] ✓ Lint passed - commit approved');
    process.exit(0);
  }

  // G020: Branch-aware commit blocking
  const ctoItemsCheck = hasPendingCtoItems();
  if (ctoItemsCheck.hasItems) {
    const currentBranch = getBranchInfo();

    if (currentBranch === 'main' || currentBranch === 'unknown') {
      // MAIN/UNKNOWN: Hard block (G001 fail-closed treats unknown as main)
      console.error('');
      console.error('══════════════════════════════════════════════════════════════');
      console.error('  COMMIT BLOCKED: Pending CTO item(s) require attention');
      console.error('');
      if (ctoItemsCheck.questionCount > 0) {
        console.error(`  • ${ctoItemsCheck.questionCount} CTO question(s) pending`);
      }
      if (ctoItemsCheck.triageCount > 0) {
        console.error(`  • ${ctoItemsCheck.triageCount} untriaged report(s) pending`);
      }
      console.error('');
      console.error('  Run /deputy-cto to address blocking items');
      console.error('══════════════════════════════════════════════════════════════');
      console.error('');
      process.exit(1);
    } else if (currentBranch === 'develop' || currentBranch === 'staging') {
      // STAGING/DEVELOP: Warn but allow commit
      console.warn('');
      console.warn('══════════════════════════════════════════════════════════════');
      console.warn(`  WARNING: Pending CTO items exist (committing to ${currentBranch})`);
      console.warn('');
      if (ctoItemsCheck.questionCount > 0) {
        console.warn(`  • ${ctoItemsCheck.questionCount} CTO question(s) pending`);
      }
      if (ctoItemsCheck.triageCount > 0) {
        console.warn(`  • ${ctoItemsCheck.triageCount} untriaged report(s) pending`);
      }
      console.warn('');
      console.warn('  These must be resolved before merging to main.');
      console.warn('══════════════════════════════════════════════════════════════');
      console.warn('');
      // Allow commit to proceed (do NOT exit)
    }
    // Feature branches: no blocking, no warning -- items checked on merge
  }

  // Check for valid approval token
  const tokenCheck = checkApprovalToken(stagedInfo.diffHash);

  if (tokenCheck.valid) {
    // Token is valid - allow the commit
    console.log('[deputy-cto] ✓ Lint passed (--max-warnings 0)');
    console.log('[deputy-cto] ✓ Approval token valid - commit approved');
    console.log(`[deputy-cto] Approved by: ${tokenCheck.token.approvedBy || 'deputy-cto'}`);
    consumeApprovalToken(); // One-time use
    process.exit(0);
  }

  // No valid token - spawn review and reject this attempt
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  COMMIT PENDING: Deputy-CTO review required');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`  Files: ${stagedInfo.files.length} staged`);
  console.log(`  Hash:  ${stagedInfo.diffHash}`);
  console.log('');

  // Spawn the review
  const { agentId, pid } = spawnDeputyCtoReview(stagedInfo);

  console.log(`  Review spawned (agent: ${agentId})`);
  console.log('');
  console.log('  → Wait for approval, then retry your commit');
  console.log(`  → Token expires in ${Math.round(TOKEN_EXPIRY_MS / 60000)} minutes after approval`);
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');

  // Reject this commit attempt
  process.exit(1);
}

main();
