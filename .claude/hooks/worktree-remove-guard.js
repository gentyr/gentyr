#!/usr/bin/env node
/**
 * PreToolUse Hook: Worktree Remove Guard (Bug #6 Defense — Layer 3)
 *
 * Intercepts Bash commands containing `git worktree remove` and checks whether
 * the target worktree is owned by another active session. Prevents agents from
 * destroying worktrees that other agents are actively using.
 *
 * Decision logic:
 * - Current session owns the worktree → ALLOW (self-cleanup after merge)
 * - Another active session owns it → DENY
 * - No session owns it → ALLOW (orphaned worktree cleanup)
 * - DB unavailable or error → ALLOW (fail-open: don't block all worktree removals)
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision (allow/deny)
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const AGENT_ID = process.env.CLAUDE_AGENT_ID || null;
const QUEUE_ID = process.env.CLAUDE_QUEUE_ID || null;

// ============================================================================
// Shell Parsing (from main-tree-commit-guard.js)
// ============================================================================

/**
 * Basic shell tokenizer — splits a command string into tokens,
 * respecting single/double quotes and backslash escapes.
 */
function tokenize(str) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const ch of str) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if ((ch === ' ' || ch === '\t') && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Split a command string on shell operators (|, ||, &&, ;) while
 * respecting quotes.
 */
function splitOnShellOperators(command) {
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }
    if (!inSingle && !inDouble) {
      if ((ch === '&' || ch === '|') && i + 1 < command.length && command[i + 1] === ch) {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
      if (ch === '|') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i++;
        continue;
      }
      if (ch === ';') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i++;
        continue;
      }
    }
    current += ch;
    i++;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// ============================================================================
// Worktree Path Extraction
// ============================================================================

/**
 * Detect if a sub-command contains `git worktree remove` and extract the target path.
 * Returns null if the sub-command is not a worktree remove command.
 */
function extractWorktreeRemovePath(subCommand) {
  const tokens = tokenize(subCommand);

  // Find 'git' followed by 'worktree' followed by 'remove'
  let gitIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'git') { gitIdx = i; break; }
    // Also handle paths like /usr/bin/git
    if (tokens[i].endsWith('/git')) { gitIdx = i; break; }
  }
  if (gitIdx === -1) return null;

  // Look for 'worktree' and 'remove' after 'git', skipping flags
  let worktreeIdx = -1;
  let removeIdx = -1;
  for (let i = gitIdx + 1; i < tokens.length; i++) {
    if (tokens[i].startsWith('-')) continue; // skip flags like -C
    if (tokens[i] === 'worktree' && worktreeIdx === -1) {
      worktreeIdx = i;
      continue;
    }
    if (worktreeIdx !== -1 && tokens[i] === 'remove' && removeIdx === -1) {
      removeIdx = i;
      continue;
    }
  }
  if (worktreeIdx === -1 || removeIdx === -1) return null;

  // The path argument is the first non-flag token after 'remove'
  for (let i = removeIdx + 1; i < tokens.length; i++) {
    if (tokens[i].startsWith('-')) continue; // skip --force etc.
    // Handle shell variable substitution patterns like "$WORKTREE_PATH"
    let targetPath = tokens[i];
    // Resolve to absolute path
    if (!path.isAbsolute(targetPath)) {
      targetPath = path.resolve(PROJECT_DIR, targetPath);
    }
    return targetPath.replace(/\/+$/, ''); // normalize trailing slashes
  }

  return null;
}

// ============================================================================
// Session-Queue Check
// ============================================================================

// Lazy-loaded Database
let _Database = null;
try {
  _Database = (await import('better-sqlite3')).default;
} catch { /* better-sqlite3 not available */ }

/**
 * Check if the target worktree is owned by the current session or another.
 * Returns { allow: true } or { allow: false, reason: string }.
 */
function checkWorktreeOwnership(targetPath) {
  if (!_Database) {
    return { allow: true }; // No DB module — fail-open
  }

  const queueDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
  if (!fs.existsSync(queueDbPath)) {
    return { allow: true }; // No DB file — fail-open
  }

  let db;
  try {
    db = new _Database(queueDbPath, { readonly: true });
    db.pragma('busy_timeout = 3000');

    const normalizedPath = targetPath.replace(/\/+$/, '');

    // Find all active sessions using this worktree
    const activeSessions = db.prepare(
      "SELECT id, title, agent_id, status, pid FROM queue_items WHERE status IN ('running', 'queued', 'spawning', 'suspended') AND (worktree_path = ? OR cwd = ?)"
    ).all(normalizedPath, normalizedPath);

    if (activeSessions.length === 0) {
      return { allow: true }; // No session owns it — orphaned, safe to remove
    }

    // Check if the current session is the only owner
    const ownEntry = activeSessions.find(s =>
      (QUEUE_ID && s.id === QUEUE_ID) || (AGENT_ID && s.agent_id === AGENT_ID)
    );
    const otherEntries = activeSessions.filter(s =>
      !(QUEUE_ID && s.id === QUEUE_ID) && !(AGENT_ID && s.agent_id === AGENT_ID)
    );

    if (otherEntries.length === 0) {
      return { allow: true }; // Only we own it — self-cleanup is fine
    }

    // Another session owns it — verify it's actually alive
    const aliveOthers = otherEntries.filter(s => {
      if (!s.pid) return true; // No PID = assume alive (fail-closed)
      try { process.kill(s.pid, 0); return true; } catch { return false; }
    });

    if (aliveOthers.length === 0) {
      return { allow: true }; // Other sessions are all dead — safe to remove
    }

    const other = aliveOthers[0];
    return {
      allow: false,
      reason: `Worktree ${normalizedPath} is actively used by session ${other.id} ("${other.title}", status: ${other.status}, pid: ${other.pid}). ` +
        `You cannot remove another session's worktree. The cleanup automation will handle it after the session completes.`,
    };
  } catch (err) {
    return { allow: true }; // DB error — fail-open
  } finally {
    if (db) try { db.close(); } catch (_) { /* cleanup */ }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    // Invalid JSON — allow (fail-open)
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  const toolName = event?.tool_name || '';

  // Only guard Bash tool
  if (toolName !== 'Bash') {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  const command = event?.tool_input?.command || '';
  if (!command) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Fast path: skip if command doesn't contain 'worktree'
  if (!command.includes('worktree')) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Split on shell operators and check each sub-command
  const subCommands = splitOnShellOperators(command);

  for (const sub of subCommands) {
    const targetPath = extractWorktreeRemovePath(sub);
    if (!targetPath) continue;

    // Only guard paths inside .claude/worktrees/ (GENTYR-managed worktrees)
    if (!targetPath.includes('.claude/worktrees/')) continue;

    const result = checkWorktreeOwnership(targetPath);
    if (!result.allow) {
      process.stdout.write(JSON.stringify({
        permissionDecision: 'deny',
        permissionDecisionReason: `[worktree-remove-guard] BLOCKED: ${result.reason}`,
      }));
      return;
    }
  }

  process.stdout.write(JSON.stringify({ allow: true }));
}

main().catch(() => {
  // Fatal error — fail-open
  process.stdout.write(JSON.stringify({ allow: true }));
});
