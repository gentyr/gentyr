#!/usr/bin/env node
/**
 * PostToolUse Hook: Worktree Cleanup Gate
 *
 * Fires after mcp__todo-db__summarize_work. When the agent is running inside
 * a worktree (CLAUDE_WORKTREE_DIR is set and the path exists on disk), injects
 * a mandatory cleanup reminder into the model's context.
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran).
 *
 * @version 1.0.0
 */

import fs from 'fs';

// Detect worktree from CWD (CLAUDE_WORKTREE_DIR is only in MCP server env, not hook env).
// Hooks run as children of the Claude process, which has its CWD set to the worktree.
const cwd = process.cwd();
const worktreeMatch = cwd.match(/^(.+\/\.claude\/worktrees\/[^/]+)/);
const WORKTREE_DIR = process.env.CLAUDE_WORKTREE_DIR || (worktreeMatch ? worktreeMatch[1] : null);

// Fast exit: not in a worktree or the worktree directory no longer exists
if (!WORKTREE_DIR || !fs.existsSync(WORKTREE_DIR)) {
  console.log(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

// Drain stdin (PostToolUse contract — we must consume it even if unused)
let _input = '';
for await (const chunk of process.stdin) {
  _input += chunk;
}

const message = `[MANDATORY WORKTREE CLEANUP] You are running in worktree: ${WORKTREE_DIR}
Before completing your task, you MUST clean up this worktree:
  git worktree remove ${WORKTREE_DIR} --force && git worktree prune
Your task is NOT complete until the worktree is removed. The project-manager agent handles this.`;

console.log(JSON.stringify({
  decision: 'approve',
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: message,
  },
}));
