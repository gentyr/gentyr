#!/usr/bin/env node
/**
 * PreToolUse Hook: Spawned Main-Tree Edit Guard
 *
 * Hard-blocks `Write`, `Edit`, and `NotebookEdit` tool calls for SPAWNED
 * sessions (`CLAUDE_SPAWNED_SESSION=true`) when the target path resolves
 * inside the project's main tree but NOT inside a worktree.
 *
 * Closes a class of harness bugs where a spawned agent's CWD silently
 * falls back to PROJECT_DIR (the user's main working tree) instead of an
 * isolated worktree. Three paths can produce this state today:
 *   1. spawnQueueItem() falls back to project_dir when worktree_path is
 *      missing (e.g., reactive cleanup reaped the directory between
 *      enqueue and spawn).
 *   2. Step 1d revival enqueues without worktree_path at all.
 *   3. urgent-task-spawner.js falls back silently when createWorktree()
 *      throws.
 *
 * In all three cases, file edits would land on whatever branch the CTO has
 * checked out, mingling with in-progress work. This hook makes that
 * impossible regardless of how the agent ended up with that CWD.
 *
 * Allowed paths (NOT blocked):
 *   - Anything inside `<PROJECT_DIR>/.claude/worktrees/` (the worktree the
 *     spawn was supposed to land in).
 *   - Anything inside `<PROJECT_DIR>/.claude/` other than `worktrees/` —
 *     hook progress files, session-state writes, etc. (Worktrees subtree
 *     is already covered by the broader worktrees rule.)
 *   - Anything inside the user's home `.claude/` directory (auto-memory).
 *   - Anything entirely OUTSIDE the project tree (system tmp, /etc, etc.).
 *
 * Interactive sessions (no `CLAUDE_SPAWNED_SESSION` set) are unrestricted
 * by this hook — `interactive-lockdown-guard.js` enforces the equivalent
 * rule for that case.
 *
 * G001: fail-closed on parse errors and missing PROJECT_DIR.
 *
 * SECURITY: This file should be root-owned via `npx gentyr protect`.
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TARGETED_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

function canonicalize(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    // Path may not exist on disk yet (Write to a new file). Resolve to the
    // first ancestor that DOES exist, then re-append the missing tail.
    let cur = path.resolve(p);
    const segments = [];
    while (cur && !fs.existsSync(cur)) {
      const next = path.dirname(cur);
      if (next === cur) break;
      segments.unshift(path.basename(cur));
      cur = next;
    }
    try {
      const realParent = fs.realpathSync(cur);
      return path.join(realParent, ...segments);
    } catch {
      return path.resolve(p);
    }
  }
}

function resolveProjectDir() {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv) return canonicalize(fromEnv);

  // Walk up from CWD looking for a .claude directory.
  //
  // In worktrees, `.claude` is a SYMLINK back to the main project's `.claude`.
  // `fs.existsSync()` follows symlinks, so a naive check would STOP at the
  // worktree root and misidentify it as PROJECT_DIR — causing every write
  // inside the worktree to be misclassified as main_tree_pollution and DENIED.
  // Skip directories where `.claude` is a symlink and keep walking up to the
  // real project root (where `.claude` is a real directory).
  let dir = canonicalize(process.cwd());
  for (let i = 0; i < 16; i++) {
    if (fs.existsSync(path.join(dir, '.claude'))) {
      try {
        if (fs.lstatSync(path.join(dir, '.claude')).isSymbolicLink()) {
          const parent = path.dirname(dir);
          if (parent !== dir) { dir = parent; continue; }
        }
      } catch {}
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Extract the target file path from the tool input for the three supported tools.
 * Returns the raw value as supplied by the agent (may be relative).
 */
function extractFilePath(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;

  if (toolName === 'Write' || toolName === 'Edit') {
    return typeof toolInput.file_path === 'string' ? toolInput.file_path : null;
  }
  if (toolName === 'NotebookEdit') {
    return typeof toolInput.notebook_path === 'string' ? toolInput.notebook_path : null;
  }
  return null;
}

/**
 * Decide whether the resolved absolute path is allowed for a spawned agent.
 *
 * @param {string} absPath - absolute, fully-resolved target path
 * @param {string} projectDir - absolute project directory
 * @returns {{allowed: boolean, reason: string}}
 */
function classifyPath(absPath, projectDir) {
  const projectPrefix = projectDir.endsWith(path.sep) ? projectDir : projectDir + path.sep;
  const homeClaudePrefix = path.join(os.homedir(), '.claude') + path.sep;

  // Outside the project tree entirely — allow.
  // (Includes /tmp scratch files, system paths, etc.)
  if (absPath !== projectDir && !absPath.startsWith(projectPrefix)) {
    // Special-case: anything under ~/.claude/ is auto-memory / framework state — allow.
    // Covered by the outside-project branch already, but explicit for clarity.
    return { allowed: true, reason: 'outside_project_tree' };
  }

  // Inside the project tree. Now check the .claude/ exception.
  const claudeDir = path.join(projectDir, '.claude');
  const claudePrefix = claudeDir + path.sep;
  const worktreesPrefix = path.join(claudeDir, 'worktrees') + path.sep;

  if (absPath.startsWith(worktreesPrefix)) {
    return { allowed: true, reason: 'inside_worktree' };
  }

  if (absPath.startsWith(claudePrefix)) {
    // Inside .claude/ but not under worktrees/ — framework state files.
    // Allow (hook progress files, session-state, etc.).
    return { allowed: true, reason: 'inside_claude_state' };
  }

  // Inside the project tree but outside worktrees/ and .claude/ —
  // this is the main tree. DENY.
  void homeClaudePrefix; // for symmetry; ~/.claude/ already handled by outside-project branch
  return { allowed: false, reason: 'main_tree_pollution' };
}

function buildDenyMessage(filePath, absPath, projectDir) {
  return [
    `BLOCKED: spawned agent cannot Write/Edit/NotebookEdit into the main tree.`,
    ``,
    `Target file: ${filePath}`,
    `Resolved to: ${absPath}`,
    `Project dir: ${projectDir}`,
    ``,
    `This is a GENTYR harness invariant — file edits by spawned agents MUST land`,
    `inside a worktree under ${projectDir}/.claude/worktrees/, never in the main`,
    `working tree. Otherwise your edits would mingle with whatever branch the CTO`,
    `has checked out.`,
    ``,
    `If you're seeing this, your CWD has fallen back to the main tree. Common causes:`,
    `  - Your queue item had no worktree_path set (Step 1d revival path).`,
    `  - Your worktree was reaped between enqueue and spawn.`,
    `  - createWorktree() failed silently during enqueue.`,
    ``,
    `Recovery: call \`mcp__agent-tracker__submit_bypass_request\` with category`,
    `"infrastructure", explain the situation, and exit via \`summarize_work\`.`,
    `The CTO will provision a fresh worktree and re-spawn you.`,
    ``,
    `DO NOT attempt to chdir into a worktree manually — agent CWD is fixed at`,
    `spawn time.`,
  ].join('\n');
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch (err) {
    // G001: fail-closed on parse errors
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[spawned-main-tree-edit-guard] G001 FAIL-CLOSED: ${err.message}`,
      },
    }));
    return;
  }

  // Fast-exit: interactive sessions (handled by interactive-lockdown-guard.js)
  if (process.env.CLAUDE_SPAWNED_SESSION !== 'true') {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  const toolName = event?.tool_name || '';

  // Fast-exit: not one of the targeted tools
  if (!TARGETED_TOOLS.has(toolName)) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  const toolInput = event?.tool_input;
  const rawPath = extractFilePath(toolName, toolInput);
  if (!rawPath) {
    // Tool was called without a file path — let the tool itself report the validation error.
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  const projectDir = resolveProjectDir();
  if (!projectDir) {
    // G001: fail-closed when we can't establish PROJECT_DIR
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[spawned-main-tree-edit-guard] G001 FAIL-CLOSED: cannot resolve PROJECT_DIR (no CLAUDE_PROJECT_DIR env var and no .claude/ found in CWD ancestry)`,
      },
    }));
    return;
  }

  // Resolve to absolute path. If the agent passed a relative path, it resolves
  // against process.cwd() — which IS the polluted CWD we want to detect.
  // Canonicalize via realpath so /var/folders/... and /private/var/folders/...
  // (macOS symlinks) compare correctly against the canonicalized PROJECT_DIR.
  const absPath = canonicalize(path.resolve(process.cwd(), rawPath));
  const decision = classifyPath(absPath, projectDir);

  if (decision.allowed) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: buildDenyMessage(rawPath, absPath, projectDir),
    },
  }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[spawned-main-tree-edit-guard] G001 FAIL-CLOSED: unhandled error — ${err.message}`,
    },
  }));
});
