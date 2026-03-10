#!/usr/bin/env node
/**
 * PostToolUse Hook: Project Manager Reminder
 *
 * Fires after mcp__todo-db__summarize_work. When the orchestrator is in a
 * worktree with uncommitted changes, injects additionalContext reminding it
 * to spawn project-manager before calling complete_task.
 *
 * Only affects spawned sessions in worktrees — interactive sessions and
 * non-worktree agents are skipped.
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import { execFileSync } from 'child_process';
import fs from 'fs';

async function main() {
  // Only applies to spawned (automated) sessions
  if (process.env.CLAUDE_SPAWNED_SESSION !== 'true') {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  // Check if we're in a worktree (.git is a file, not a directory)
  const cwd = process.cwd();
  const gitPath = `${cwd}/.git`;
  let inWorktree = false;
  try {
    const stat = fs.lstatSync(gitPath);
    inWorktree = stat.isFile(); // Worktrees have .git as a file pointing to main repo
  } catch {
    // No .git at all — not in a worktree
  }

  if (!inWorktree) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  // Check for uncommitted changes
  let hasUncommitted = false;
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe',
    }).trim();
    hasUncommitted = status.length > 0;
  } catch {
    // If git status fails, assume no changes
  }

  if (hasUncommitted) {
    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `WARNING: You have UNCOMMITTED CHANGES in your worktree. Before calling mcp__todo-db__complete_task, you MUST spawn Task(subagent_type='project-manager') to commit, push, and merge your work. The project-manager is the ONLY agent that handles git operations.`,
      },
    }));
  } else {
    console.log(JSON.stringify({ continue: true }));
  }

  process.exit(0);
}

// Read stdin (required for PostToolUse hooks) then run
const rl = createInterface({ input: process.stdin });
const chunks = [];
rl.on('line', (line) => chunks.push(line));
rl.on('close', () => main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}));
