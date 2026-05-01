#!/usr/bin/env node
/**
 * PR Auto-Merge Nudge Hook
 *
 * PostToolUse hook for Bash commands. When a `gh pr create` command results
 * in a PR URL in the response, injects a reminder to self-merge immediately.
 *
 * @version 1.1.0
 */

const NOOP = JSON.stringify({ continue: true });

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch (err) {
    console.error('[pr-auto-merge-nudge] Warning:', err.message);
    process.stdout.write(NOOP);
    return;
  }

  // Only fire on Bash tool calls
  if (event?.tool_name !== 'Bash') {
    process.stdout.write(NOOP);
    return;
  }

  const command = event?.tool_input?.command || '';

  // Check if this was a `gh pr create` command
  if (!command.includes('gh pr create')) {
    process.stdout.write(NOOP);
    return;
  }

  // Look for a PR URL in the response
  const toolResponse = typeof event?.tool_response === 'string'
    ? event.tool_response
    : JSON.stringify(event?.tool_response || '');
  const prUrlMatch = toolResponse.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
  if (!prUrlMatch) {
    process.stdout.write(NOOP);
    return;
  }

  const prNumber = prUrlMatch[1];
  const prUrl = prUrlMatch[0];

  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `PR created: ${prUrl}\n\nYou MUST now wait for CI checks, then self-merge:\n\n1. Wait for CI:\n\`\`\`bash\ngh pr checks ${prNumber} --watch --fail-on-fail\n\`\`\`\nIf CI fails, report the failures and do NOT merge.\n\n2. If CI passes, self-merge:\n\`\`\`bash\ngh pr merge ${prNumber} --squash --delete-branch\n\`\`\`\n\nThen clean up the worktree and local branch. Your session is NOT complete until the PR is merged.`
    }
  }));
}

main().catch(() => {
  process.stdout.write(NOOP);
});
