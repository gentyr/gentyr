#!/usr/bin/env node
/**
 * AI PR Review Hook
 *
 * PostToolUse hook for Bash. When a `gh pr create` command results in a PR URL,
 * spawns a Haiku-tier AI reviewer that reads the diff, checks for security issues,
 * logic errors, performance concerns, and API contract changes.
 *
 * The reviewer posts findings as PR comments and adds labels.
 * Critical findings block merge via the "review-pending" label.
 *
 * @version 1.0.0
 */

import { enqueueSession } from './lib/session-queue.js';
import { HOOK_TYPES } from './agent-tracker.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const NOOP = JSON.stringify({ continue: true });

// Cooldown: don't re-review the same PR within 5 minutes
const COOLDOWN_MS = 5 * 60 * 1000;
const _recentReviews = new Map();

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

  // Only fire on Bash tool calls
  if (event?.tool_name !== 'Bash') {
    process.stdout.write(NOOP);
    return;
  }

  const command = event?.tool_input?.command || '';

  // Only fire on gh pr create commands
  if (!command.includes('gh pr create')) {
    process.stdout.write(NOOP);
    return;
  }

  // Look for a PR URL in the response
  const toolResponse = typeof event?.tool_response === 'string'
    ? event.tool_response
    : JSON.stringify(event?.tool_response || '');
  const prUrlMatch = toolResponse.match(/https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!prUrlMatch) {
    process.stdout.write(NOOP);
    return;
  }

  const repoSlug = prUrlMatch[1];
  const prNumber = prUrlMatch[2];
  const prUrl = prUrlMatch[0];

  // Cooldown check
  const cooldownKey = `${repoSlug}#${prNumber}`;
  const lastReview = _recentReviews.get(cooldownKey);
  if (lastReview && Date.now() - lastReview < COOLDOWN_MS) {
    process.stdout.write(NOOP);
    return;
  }
  _recentReviews.set(cooldownKey, Date.now());

  // Don't spawn reviewer for the gentyr repo itself (meta-reviews are noisy)
  if (repoSlug.endsWith('/gentyr')) {
    process.stdout.write(NOOP);
    return;
  }

  // Enqueue AI review agent
  try {
    const prompt = [
      `[Automation][ai-pr-reviewer][AGENT:{AGENT_ID}]`,
      `## AI Code Review for PR #${prNumber}`,
      ``,
      `Review the diff for PR #${prNumber} (${prUrl}).`,
      ``,
      `1. Get the diff: \`gh pr diff ${prNumber}\``,
      `2. Analyze for:`,
      `   - **Security**: SQL injection, XSS, auth bypass, CSRF, hardcoded secrets`,
      `   - **Logic errors**: off-by-one, race conditions, null/undefined handling, unhandled promise rejections`,
      `   - **Performance**: N+1 queries, unbounded loops, missing pagination, memory leaks`,
      `   - **API contract**: breaking changes to public interfaces, missing input validation`,
      `3. If you find CRITICAL issues (security vulnerabilities, data loss risks):`,
      `   - Post a PR comment: \`gh pr comment ${prNumber} --body "AI Review: ..."\``,
      `   - Add label: \`gh pr edit ${prNumber} --add-label "review-pending"\``,
      `4. If the code is clean or only has minor observations:`,
      `   - Add label: \`gh pr edit ${prNumber} --add-label "ai-reviewed"\``,
      `5. Call summarize_work when done.`,
      ``,
      `Keep the review concise. Only flag genuine issues — not style preferences.`,
      `Do NOT block PRs for minor style issues, missing comments, or subjective preferences.`,
      `Only add "review-pending" for security, data loss, or correctness issues.`,
    ].join('\n');

    enqueueSession({
      title: `[AI Review] PR #${prNumber}`,
      agentType: 'ai-pr-reviewer',
      hookType: HOOK_TYPES.HOURLY_AUTOMATION,
      tagContext: `ai-pr-review-${prNumber}`,
      source: 'ai-pr-review-hook',
      priority: 'normal',
      lane: 'gate',
      model: 'claude-haiku-4-5-20251001',
      buildPrompt: (agentId) => prompt.replace('{AGENT_ID}', agentId),
      metadata: { prNumber, prUrl, repoSlug },
      projectDir: PROJECT_DIR,
    });
  } catch (err) {
    // Non-fatal — don't block the parent agent
    try {
      process.stderr.write(`[ai-pr-review-hook] Failed to enqueue: ${err.message}\n`);
    } catch { /* truly non-fatal */ }
  }

  process.stdout.write(NOOP);
}

main().catch(() => {
  process.stdout.write(NOOP);
});
