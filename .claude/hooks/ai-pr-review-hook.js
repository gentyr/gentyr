#!/usr/bin/env node
/**
 * PostToolUse Hook: AI PR Code Review
 *
 * Fires after Bash tool calls. Detects PR creation (gh pr create command or
 * GitHub PR URL in output) and spawns a Haiku-tier reviewer in the gate lane
 * to analyze the diff for security, logic, performance, and API contract issues.
 *
 * Detection logic:
 *   1. Check if the Bash output contains a GitHub PR URL
 *   2. Check if the command was `gh pr create`
 *   3. If neither, fast-exit
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 *
 * @version 2.0.0
 */

import { enqueueSession } from './lib/session-queue.js';
import { AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const NOOP = JSON.stringify({ continue: true });

// PR URL pattern: https://github.com/<owner>/<repo>/pull/<number>
const PR_URL_REGEX = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/;

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.stdout.write(NOOP);
    return;
  }

  // Fast-exit: only fire on Bash tool calls
  if (event?.tool_name !== 'Bash') {
    process.stdout.write(NOOP);
    return;
  }

  const command = event?.tool_input?.command || '';
  const toolResponse = typeof event?.tool_response === 'string'
    ? event.tool_response
    : JSON.stringify(event?.tool_response || '');

  // Fast-exit: check if there is any PR URL in the output OR if command was gh pr create
  const isGhPrCreate = command.includes('gh pr create');
  const prUrlMatch = toolResponse.match(PR_URL_REGEX);

  if (!isGhPrCreate && !prUrlMatch) {
    process.stdout.write(NOOP);
    return;
  }

  // If we have gh pr create but no URL in output, the command may have failed — skip
  if (!prUrlMatch) {
    process.stdout.write(NOOP);
    return;
  }

  const repoSlug = prUrlMatch[1]; // e.g. "owner/repo"
  const prNumber = prUrlMatch[2]; // e.g. "123"
  const prUrl = prUrlMatch[0];

  // Enqueue AI review agent in the gate lane
  try {
    enqueueSession({
      title: `AI code review: PR #${prNumber} (${repoSlug})`,
      agentType: AGENT_TYPES.AI_PR_REVIEWER,
      hookType: HOOK_TYPES.AI_PR_REVIEW,
      tagContext: `ai-pr-review-${repoSlug}-${prNumber}`,
      source: 'ai-pr-review-hook',
      priority: 'normal',
      lane: 'gate',
      model: 'claude-haiku-4-5-20251001',
      ttlMs: 5 * 60 * 1000, // 5-minute TTL
      projectDir: PROJECT_DIR,
      metadata: { prNumber, prUrl, repoSlug },
      buildPrompt: (agentId) => buildReviewPrompt(agentId, prNumber, prUrl, repoSlug),
    });

    process.stdout.write(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `AI code review spawned for PR #${prNumber}. The review agent will post comments if critical issues are found.`,
      },
    }));
  } catch (err) {
    // Non-fatal — do not block the parent agent
    try {
      process.stderr.write(`[ai-pr-review-hook] Failed to enqueue review: ${err.message}\n`);
    } catch { /* truly non-fatal */ }
    process.stdout.write(NOOP);
  }
}

/**
 * Build the review prompt for the Haiku agent.
 */
function buildReviewPrompt(agentId, prNumber, prUrl, repoSlug) {
  return `[Automation][ai-pr-reviewer][AGENT:${agentId}] You are an AI code reviewer.

## Task: Review PR #${prNumber}

Repository: ${repoSlug}
URL: ${prUrl}

## Steps

1. Get the diff:
\`\`\`bash
gh pr diff ${prNumber}
\`\`\`

2. Analyze the diff for these 4 categories:

   **Security**: SQL injection, XSS, auth bypass, SSRF, path traversal, hardcoded secrets, insecure deserialization
   **Logic errors**: off-by-one, race conditions, null/undefined handling, infinite loops, unhandled promise rejections
   **Performance**: N+1 queries, unbounded loops, missing indexes, large allocations, memory leaks, missing pagination
   **API contract changes**: breaking public interfaces, removed endpoints, changed response shapes, missing input validation

3. Based on your findings:

   **If CRITICAL issues found** (security vulnerabilities, data loss risks, correctness bugs):
   - Post a PR comment with your findings:
     \`\`\`bash
     gh pr comment ${prNumber} --body "## AI Code Review

     **Status: CRITICAL issues found**

     <your findings here, organized by category>

     ---
     *Automated review by GENTYR AI PR Reviewer*"
     \`\`\`
   - Add the review-pending label:
     \`\`\`bash
     gh pr edit ${prNumber} --add-label "review-pending"
     \`\`\`

   **If code is clean** (no critical issues, only minor observations):
   - Add the ai-reviewed label:
     \`\`\`bash
     gh pr edit ${prNumber} --add-label "ai-reviewed"
     \`\`\`

4. Call mcp__todo-db__summarize_work with your review results.

## Guidelines

- Only flag genuine issues — not style preferences or subjective opinions.
- Do NOT add "review-pending" for minor style issues, missing comments, or naming preferences.
- Only "review-pending" for: security vulnerabilities, data loss risks, correctness bugs, or breaking API changes.
- Keep the review concise and actionable. Each finding should explain WHY it is a problem and suggest a fix.
- If the diff is very large, focus on the most critical files first (security-sensitive code, public APIs, database operations).`;
}

main().catch(() => {
  process.stdout.write(NOOP);
});
