/**
 * Shared module: hotfix promotion agent spawn.
 *
 * Builds the hotfix-promotion agent prompt and enqueues it via the session queue.
 * Called by the deferred-action-audit-executor after the CTO's verbatim approval
 * has been verified by the authorization-auditor.
 */

import { enqueueSession } from './session-queue.js';

/**
 * Spawn the hotfix-promotion agent for an approved staging->main emergency merge.
 *
 * @param {string[]} commits - Array of commit lines (one per commit, "<sha> <subject>")
 * @param {string} projectDir - Absolute project directory
 * @returns {{ queueId: string|null, position?: number, blocked?: string }} - enqueueSession result
 */
export function spawnHotfixPromoter(commits, projectDir) {
  if (!Array.isArray(commits) || commits.length === 0) {
    throw new Error('spawnHotfixPromoter: commits must be a non-empty array');
  }
  if (!projectDir) {
    throw new Error('spawnHotfixPromoter: projectDir is required');
  }

  const commitList = commits.join('\n');

  return enqueueSession({
    title: 'Emergency hotfix: staging -> main promotion',
    agentType: 'hotfix-promotion',
    hookType: 'hourly-automation',
    tagContext: 'hotfix-promotion',
    source: 'deferred-action-audit-executor',
    priority: 'critical',
    buildPrompt: (agentId) => `[Automation][hotfix-promotion][AGENT:${agentId}] You are the EMERGENCY HOTFIX Promotion Pipeline.

## Mission

Immediately merge staging into main. This is a CTO-approved emergency hotfix that bypasses:
- The 24-hour stability requirement
- The midnight deployment window

Code review and quality checks still apply.

## Commits being promoted

\`\`\`
${commitList}
\`\`\`

## Process

### Step 1: Code Review

Spawn a code-reviewer sub-agent (Task tool, subagent_type: code-reviewer) to review the commits:
- Check for security issues, code quality, spec violations
- Look for disabled tests, placeholder code, hardcoded credentials
- Verify no spec violations (G001-G019)

### Step 2: Create and Merge PR

If code review passes:
1. Run: gh pr create --base main --head staging --title "HOTFIX: Emergency promotion staging -> main" --body "CTO-approved emergency hotfix. Bypasses 24h stability and midnight window."
2. Wait for CI: gh pr checks <number> --watch
3. If CI passes: gh pr merge <number> --merge
4. If CI fails: Report failure via mcp__agent-reports__report_to_deputy_cto

If code review fails:
- Report findings via mcp__agent-reports__report_to_deputy_cto with priority "critical"
- Do NOT proceed with merge

## Timeout

Complete within 25 minutes. If blocked, report and exit.`,
    extraEnv: { GENTYR_PROMOTION_PIPELINE: 'true' },
    projectDir,
    metadata: { commitCount: commits.length, isHotfix: true },
  });
}
