#!/usr/bin/env node
/**
 * PostToolUse Hook: Worktree Enter Provisioner
 *
 * Fires after Claude Code's built-in EnterWorktree tool. When a new worktree
 * is created, calls GENTYR's provisionWorktree() to symlink hooks, commands,
 * settings.json, agents, .husky, and .mcp.json into the worktree.
 *
 * Without this hook, EnterWorktree creates a bare git worktree that is missing
 * all GENTYR infrastructure — pre-commit hooks fail, agents lack definitions,
 * and MCP config is absent.
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Drain stdin
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
}

let event;
try {
  event = JSON.parse(input);
} catch {
  console.log(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

// Extract worktree path from the tool result
// EnterWorktree returns a message like "Switched to worktree on branch <branch>\n<path>"
const toolResponse = event?.tool_response || '';
const responseStr = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);

// The worktree path is in .claude/worktrees/<name>/
const worktreePathMatch = responseStr.match(/([^\s\n]*\.claude\/worktrees\/[^\s\n]+)/);
if (!worktreePathMatch) {
  // Couldn't extract path — approve silently
  console.log(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

const worktreePath = worktreePathMatch[1];

// Verify the worktree actually exists
if (!fs.existsSync(worktreePath)) {
  console.log(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

// Check if already provisioned (hooks symlink exists)
const hooksSymlink = path.join(worktreePath, '.claude', 'hooks');
if (fs.existsSync(hooksSymlink)) {
  // Already provisioned — approve silently
  console.log(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

// Provision the worktree with GENTYR infrastructure
let provisioned = false;
try {
  const { provisionWorktree } = await import('./lib/worktree-manager.js');
  provisionWorktree(worktreePath);
  provisioned = true;
} catch (err) {
  // Non-fatal — worktree was created, just not fully provisioned
  process.stderr.write(`[worktree-enter-provision] provisionWorktree failed: ${err.message}\n`);
}

const context = provisioned
  ? `[WORKTREE PROVISIONED] GENTYR hooks, commands, agents, and .mcp.json symlinked into ${worktreePath}. Pre-commit hooks will work normally.`
  : `[WARNING] Worktree at ${worktreePath} could not be fully provisioned. Pre-commit hooks may fail. Run: ln -s ${path.join(PROJECT_DIR, '.claude', 'hooks')} ${hooksSymlink}`;

console.log(JSON.stringify({
  decision: 'approve',
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: context,
  },
}));
