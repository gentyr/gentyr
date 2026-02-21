#!/usr/bin/env node

/**
 * Stale Work Detector for GENTYR Framework
 *
 * Detects stale work that may need attention:
 * 1. Uncommitted changes (git status --porcelain)
 * 2. Unpushed commits on local branches
 * 3. Stale remote feature branches with no recent PR activity
 *
 * Returns a structured report for deputy-CTO briefing.
 *
 * @version 1.0.0
 */

import { execSync } from 'child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DEFAULT_STALE_DAYS = 3;

const GIT_EXEC_OPTIONS = { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 15000, stdio: 'pipe' };

/**
 * Detect uncommitted changes via git status --porcelain.
 * @returns {string[]} List of uncommitted file status lines
 */
function getUncommittedFiles() {
  const status = execSync('git status --porcelain', { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 10000, stdio: 'pipe' }).trim();
  return status ? status.split('\n').map(l => l.trim()) : [];
}

/**
 * Detect local branches with commits not pushed to their remote tracking branch.
 * @returns {Array<{ branch: string, commitCount: number }>}
 */
function getUnpushedBranches() {
  const branchOutput = execSync("git branch --format='%(refname:short)'", GIT_EXEC_OPTIONS).trim();
  if (!branchOutput) return [];

  const branches = branchOutput.split('\n').map(b => b.trim().replace(/^'|'$/g, '')).filter(Boolean);
  const unpushed = [];

  for (const branch of branches) {
    try {
      const logOutput = execSync(`git log origin/${branch}..${branch} --oneline`, GIT_EXEC_OPTIONS).trim();
      if (logOutput) {
        const commitCount = logOutput.split('\n').length;
        unpushed.push({ branch, commitCount });
      }
    } catch {
      // Branch may not have a remote tracking branch - skip it
    }
  }

  return unpushed;
}

/**
 * Check if a branch has a PR and whether that PR is also stale.
 * @param {string} branchName - Branch name without origin/ prefix
 * @param {number} staleDays - Number of days to consider stale
 * @returns {{ hasPR: boolean, prStale: boolean }}
 */
function checkPRStatus(branchName, staleDays) {
  try {
    const prJson = execSync(
      `gh pr list --head ${branchName} --state all --json updatedAt --limit 1`,
      GIT_EXEC_OPTIONS
    ).trim();
    const prs = JSON.parse(prJson);

    if (!prs || prs.length === 0) {
      return { hasPR: false, prStale: false };
    }

    const prUpdatedAt = new Date(prs[0].updatedAt);
    const prAgeDays = (Date.now() - prUpdatedAt.getTime()) / (1000 * 86400);
    return { hasPR: true, prStale: prAgeDays > staleDays };
  } catch {
    // gh CLI may not be available or authenticated
    return { hasPR: false, prStale: false };
  }
}

/**
 * Detect remote feature branches that have gone stale.
 * @param {number} staleDays - Number of days without activity to consider stale
 * @returns {Array<{ branch: string, lastCommitAge: number, lastCommitDate: string, hasPR: boolean }>}
 */
function getStaleBranches(staleDays) {
  let branchOutput;
  try {
    branchOutput = execSync("git branch -r --list 'origin/feature/*'", GIT_EXEC_OPTIONS).trim();
  } catch {
    return [];
  }

  if (!branchOutput) return [];

  const remoteBranches = branchOutput.split('\n').map(b => b.trim()).filter(Boolean);
  const staleBranches = [];

  for (const remoteBranch of remoteBranches) {
    try {
      const timestampStr = execSync(`git log -1 --format=%ct ${remoteBranch}`, GIT_EXEC_OPTIONS).trim();
      const timestamp = parseInt(timestampStr, 10);

      if (isNaN(timestamp)) continue;

      const ageDays = (Date.now() / 1000 - timestamp) / 86400;

      if (ageDays > staleDays) {
        const branchWithoutOrigin = remoteBranch.replace(/^origin\//, '');
        const { hasPR, prStale } = checkPRStatus(branchWithoutOrigin, staleDays);

        // Only report as stale if there's no PR or the PR itself is stale
        if (!hasPR || prStale) {
          const lastCommitDate = new Date(timestamp * 1000).toISOString();
          staleBranches.push({
            branch: branchWithoutOrigin,
            lastCommitAge: Math.round(ageDays),
            lastCommitDate,
            hasPR
          });
        }
      }
    } catch {
      // Skip branches we can't inspect
    }
  }

  return staleBranches;
}

/**
 * Detect all stale work in the project.
 * @param {object} options
 * @param {number} [options.staleDays=3] - Number of days to consider a branch stale
 * @returns {{ uncommittedFiles: string[], unpushedBranches: Array<{ branch: string, commitCount: number }>, staleBranches: Array<{ branch: string, lastCommitAge: number, lastCommitDate: string, hasPR: boolean }>, hasIssues: boolean, timestamp: string }}
 */
function detectStaleWork(options = {}) {
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;

  const uncommittedFiles = getUncommittedFiles();
  const unpushedBranches = getUnpushedBranches();
  const staleBranches = getStaleBranches(staleDays);

  const hasIssues = uncommittedFiles.length > 0 || unpushedBranches.length > 0 || staleBranches.length > 0;

  return {
    uncommittedFiles,
    unpushedBranches,
    staleBranches,
    hasIssues,
    timestamp: new Date().toISOString()
  };
}

/**
 * Format a stale work report into a human-readable string for deputy-CTO briefing.
 * @param {{ uncommittedFiles: string[], unpushedBranches: Array<{ branch: string, commitCount: number }>, staleBranches: Array<{ branch: string, lastCommitAge: number, lastCommitDate: string, hasPR: boolean }>, hasIssues: boolean, timestamp: string }} report
 * @returns {string}
 */
function formatReport(report) {
  const lines = ['## Stale Work Report', ''];

  if (report.uncommittedFiles.length > 0) {
    lines.push('### Uncommitted Changes');
    for (const file of report.uncommittedFiles) {
      lines.push(`- ${file}`);
    }
    lines.push('');
  }

  if (report.unpushedBranches.length > 0) {
    lines.push('### Unpushed Branches');
    for (const { branch, commitCount } of report.unpushedBranches) {
      lines.push(`- ${branch} (${commitCount} commit${commitCount === 1 ? '' : 's'} ahead)`);
    }
    lines.push('');
  }

  if (report.staleBranches.length > 0) {
    lines.push(`### Stale Feature Branches (>${DEFAULT_STALE_DAYS} days)`);
    for (const { branch, lastCommitAge, hasPR } of report.staleBranches) {
      const prStatus = hasPR ? 'PR stale' : 'no PR';
      lines.push(`- ${branch} (${lastCommitAge} day${lastCommitAge === 1 ? '' : 's'}, ${prStatus})`);
    }
    lines.push('');
  }

  if (!report.hasIssues) {
    lines.push('No stale work detected.');
    lines.push('');
  }

  lines.push('---');
  lines.push(`Generated: ${report.timestamp}`);

  return lines.join('\n');
}

export { detectStaleWork, formatReport, DEFAULT_STALE_DAYS };

export default { detectStaleWork, formatReport, DEFAULT_STALE_DAYS };
