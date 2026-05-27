#!/usr/bin/env node
/**
 * PreToolUse Hook: CTO Worktree Sub-Agent Guard
 *
 * Blocks destructive bash and filesystem operations by Task() sub-agents running
 * INSIDE a cto-interactive-<sid8> worktree they don't own.
 *
 * Background — the 2026-05-26 PR A wipe:
 *
 *   The CTO disabled lockdown, opened cto-interactive-7bc37e23, ran code-writer
 *   in-session via Task(cwd=<worktree>). Code-writer wrote 6 files to the
 *   worktree and exited. Then test-writer was spawned in the same worktree and
 *   ran `ln -sf` commands that overwrote some of code-writer's files with
 *   symlinks back to the main tree. Result: code-writer's modifications to
 *   callback/route.ts, error/page.tsx, sign-in/page.tsx were destroyed.
 *
 *   This hook would have blocked the `ln -sf` cascade. It would have blocked
 *   `git reset --hard` (the failure mode the CTO initially suspected). It would
 *   have blocked `rm -rf` of project paths and other sub-agent destructive ops.
 *
 * What the hook does NOT cover:
 *
 *   - The CTO's own interactive root session has full access to its worktree.
 *     Only Task() sub-agents are guarded.
 *   - Spawned sessions (CLAUDE_SPAWNED_SESSION=true) run in their own
 *     dedicated worktrees provisioned by GENTYR, and are guarded elsewhere
 *     (main-tree-commit-guard, etc.). This hook fast-exits for them.
 *   - Edits to individual files via Edit/Write tools — those are the
 *     legitimate work product. Only ops that wipe other agents' work in
 *     the shared cto-interactive worktree are blocked.
 *
 * Detection model:
 *
 *   A Task() sub-agent inherits the CTO's process.env (no CLAUDE_SPAWNED_SESSION
 *   set), but the PreToolUse event carries its own `session_id`. The
 *   `ctoWorktreePathsRegistry` in automation-config.json maps interactive ROOT
 *   session IDs to their worktree paths. If the event's session_id is NOT in
 *   the registry AND the registry has entries AND the cwd is inside a
 *   cto-interactive-* worktree, the caller is a Task sub-agent operating in
 *   the CTO's worktree.
 *
 * SECURITY: This file should be root-owned via npx gentyr protect
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * Bash command patterns that destroy other agents' uncommitted work in the
 * shared worktree. Tokenized matching — each pattern fires on the raw command
 * string (joined args). False positives are acceptable here because the
 * blocked actions have valid alternatives (use Edit/Write, work in your own
 * isolated worktree, ask the CTO for approval).
 */
const DESTRUCTIVE_GIT_PATTERNS = [
  // git reset --hard / git reset --merge / git reset --keep — all rewind the tree
  { re: /\bgit\s+reset\s+(--hard|--merge|--keep)\b/, label: 'git reset --hard' },
  // git checkout <branch> | <ref> | -B <branch> — switches tree to another ref
  // We allow `git checkout -- <file>` (single-file revert) and `git checkout HEAD <file>`
  // by requiring the next non-flag token to look like a branch/sha, not a path
  { re: /\bgit\s+checkout\s+(?!--?[a-z])(?!HEAD\s+--)[a-zA-Z0-9_\/\.\-]+\s*$/, label: 'git checkout <ref>' },
  { re: /\bgit\s+checkout\s+-B?\s+\S+/, label: 'git checkout -b/-B <branch>' },
  // git switch <branch>
  { re: /\bgit\s+switch\b/, label: 'git switch' },
  // git clean -fd / -ff / -fdx — removes untracked files
  { re: /\bgit\s+clean\s+-[fdx]+/, label: 'git clean -fd' },
  // git stash drop / git stash clear — discards stash
  { re: /\bgit\s+stash\s+(drop|clear)\b/, label: 'git stash drop/clear' },
  // git restore --staged | --worktree — also overwrites worktree state
  { re: /\bgit\s+restore\b/, label: 'git restore' },
  // git worktree remove — sub-agents must never remove the CTO's worktree
  { re: /\bgit\s+worktree\s+remove\b/, label: 'git worktree remove' },
  // git worktree add at the SAME path the sub-agent is inside — caught by the
  // existing worktree-exclusivity guard in session-queue, but adding belt+braces
  { re: /\bgit\s+worktree\s+add\b/, label: 'git worktree add (sub-agent should never re-provision)' },
];

const DESTRUCTIVE_FS_PATTERNS = [
  // rm -rf with anything beyond /tmp — catches rm -rf <worktree> and rm -rf <main>
  { re: /\brm\s+-[rRf]+\b/, label: 'rm -rf' },
  // ln -sf — overwrites target file/symlink (the actual PR A wipe vector)
  { re: /\bln\s+-[sf]+\b/, label: 'ln -sf (cross-tree symlinks corrupt the shared worktree)' },
  // mv with a tracked-looking source path — can move files out of the worktree
  // Skip: too many false positives. Edit/Write covers normal moves.
];

const COMBINED_PATTERNS = [...DESTRUCTIVE_GIT_PATTERNS, ...DESTRUCTIVE_FS_PATTERNS];

function emitApprove() {
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
}

function emitDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

/**
 * Read automation-config.json and resolve the cto worktree registry.
 * @returns {{ registry: Record<string, string> | null }}
 */
function loadCtoRegistry() {
  try {
    const configPath = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.ctoWorktreePaths && typeof config.ctoWorktreePaths === 'object') {
      return { registry: config.ctoWorktreePaths };
    }
  } catch { /* non-fatal */ }
  return { registry: null };
}

/**
 * Decide whether the calling session is a Task sub-agent operating inside
 * a CTO worktree it doesn't own.
 */
function isSubAgentInCtoWorktree(eventSessionId, eventCwd, registry) {
  if (!registry || Object.keys(registry).length === 0) return false;
  if (!eventCwd) return false;

  const worktreesPrefix = path.join(PROJECT_DIR, '.claude', 'worktrees') + path.sep;
  const cwd = path.resolve(eventCwd);
  if (!cwd.startsWith(worktreesPrefix)) return false;

  // Extract the worktree directory name (immediate child of .claude/worktrees/)
  const rel = cwd.slice(worktreesPrefix.length);
  const wtName = rel.split(path.sep)[0];
  if (!wtName || !wtName.startsWith('cto-interactive-')) return false;

  // The CTO root session's session_id is in the registry. Sub-agents have
  // their own session_id which is NOT in the registry.
  if (!eventSessionId) {
    // Defensive: if we somehow have no session_id, treat as sub-agent
    // (parent CTO sessions always have session_id from Claude Code).
    return true;
  }
  return !Object.prototype.hasOwnProperty.call(registry, eventSessionId);
}

async function main() {
  // Fast-exit for spawned sessions — they have their own worktrees, guarded elsewhere.
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    emitApprove();
    return;
  }
  // Fast-exit for promotion pipeline agents.
  if (process.env.GENTYR_PROMOTION_PIPELINE === 'true') {
    emitApprove();
    return;
  }
  // Fast-exit when no cto-interactive worktree exists (lockdown is on).
  const { registry } = loadCtoRegistry();
  if (!registry || Object.keys(registry).length === 0) {
    emitApprove();
    return;
  }

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let event;
  try {
    event = JSON.parse(input);
  } catch (err) {
    // G001: fail-closed on parse errors
    process.stderr.write(`[cto-worktree-subagent-guard] G001 FAIL-CLOSED: ${err.message}\n`);
    emitDeny(`G001 FAIL-CLOSED: hook input parse error — ${err.message}`);
    return;
  }

  // Only care about Bash. Edit/Write are legitimate sub-agent work.
  if (event?.tool_name !== 'Bash') {
    emitApprove();
    return;
  }

  const eventSessionId = event?.session_id || event?.sessionId || '';
  const eventCwd = event?.cwd || process.cwd();

  if (!isSubAgentInCtoWorktree(eventSessionId, eventCwd, registry)) {
    emitApprove();
    return;
  }

  const command = String(event?.tool_input?.command || '');
  if (!command) {
    emitApprove();
    return;
  }

  for (const { re, label } of COMBINED_PATTERNS) {
    if (re.test(command)) {
      emitDeny([
        `Sub-agent destructive op blocked: \`${label}\` is not allowed in the CTO's shared worktree.`,
        '',
        `You are running inside ${eventCwd}, which is owned by an interactive CTO session.`,
        'Other Task() sub-agents (code-writer, test-writer, code-reviewer) are using the same worktree.',
        `\`${label}\` would wipe their uncommitted edits.`,
        '',
        'Alternatives:',
        '  - For file edits, use the Edit or Write tool directly.',
        '  - To test against the main tree, read files via absolute paths — do NOT create symlinks.',
        '  - For experimental changes you need to discard, ask the CTO to commit a checkpoint first,',
        '    then you can iterate freely (your changes can be reset later via git).',
        '',
        'If this op is genuinely required (e.g., recovering from a known-bad state), the CTO can run it',
        'directly from their interactive session — that bypasses this guard.',
      ].join('\n'));
      return;
    }
  }

  emitApprove();
}

main().catch((err) => {
  try { process.stderr.write(`[cto-worktree-subagent-guard] G001 FAIL-CLOSED: ${err.message}\n`); } catch { /* ignore */ }
  emitDeny(`G001 FAIL-CLOSED: hook error — ${err.message}`);
});
