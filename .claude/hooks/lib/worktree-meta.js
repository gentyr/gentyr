/**
 * Worktree metadata helpers — Fix 2 of the toasty-skipping-penguin plan.
 *
 * For every `cto-interactive-*` worktree we provision, we write a small
 * meta file at `<worktree>/.claude/worktree-meta.json` recording the
 * branch the worktree was provisioned for. The post-checkout-pin git
 * hook (`.claude/worktree-git-hooks/post-checkout-pin`) reads this file
 * and reverts any checkout that moves HEAD off the pinned branch unless
 * `GENTYR_CTO_WORKTREE_CHECKOUT_OK=1` is set.
 *
 * The pin protects CTO worktrees from external processes (other Claude
 * sessions, shell windows, automation) silently switching their HEAD —
 * the failure mode behind the xy session a5b87d5f "hijacks".
 *
 * @module worktree-meta
 */

import fs from 'fs';
import path from 'path';

/**
 * Return the absolute path to the meta file for a given worktree.
 * @param {string} worktreePath
 */
export function metaPathFor(worktreePath) {
  return path.join(worktreePath, '.claude', 'worktree-meta.json');
}

/**
 * True iff the worktree's basename matches the CTO-interactive pattern.
 * The pin only applies to these worktrees today; feature/automation
 * worktrees need fluid HEAD movement (e.g., for merges) and are exempt.
 * @param {string} worktreePath
 */
export function isCtoInteractiveWorktree(worktreePath) {
  return /^cto-interactive-/.test(path.basename(worktreePath));
}

/**
 * Write the meta file for a CTO-interactive worktree.
 * Atomic via tmp+rename. Idempotent: overwrites any existing meta.
 *
 * @param {string} worktreePath
 * @param {object} fields
 * @param {string} fields.startedOnBranch  Branch the worktree was provisioned on.
 * @param {string} [fields.ownerSessionId] Session UUID that owns this worktree.
 * @returns {boolean} true on success, false on I/O error (non-fatal).
 */
export function writeWorktreeMeta(worktreePath, { startedOnBranch, ownerSessionId = null } = {}) {
  if (!startedOnBranch) return false;
  try {
    const dir = path.join(worktreePath, '.claude');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = metaPathFor(worktreePath);
    const tmp = file + '.tmp';
    const payload = {
      startedOnBranch,
      ownerSessionId,
      provisionedAt: new Date().toISOString(),
      pinVersion: 1,
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the meta file. Returns null if absent or malformed.
 * @param {string} worktreePath
 */
export function readWorktreeMeta(worktreePath) {
  try {
    const raw = fs.readFileSync(metaPathFor(worktreePath), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.startedOnBranch) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Install the post-checkout pin into the worktree's git hooks directory.
 * The pin is a small executable shell script that reverts unauthorized
 * checkouts. Idempotent: overwriting an existing file is fine.
 *
 * Git worktrees have their own per-worktree hooks dir at
 * `<worktree>/.git/hooks/` (where `<worktree>/.git` is a file pointing
 * at the main repo's `worktrees/<name>/` metadata dir). We chase that
 * one indirection and write into the metadata dir's hooks/ folder.
 *
 * @param {string} worktreePath
 * @returns {boolean} true on success
 */
export function installPostCheckoutPin(worktreePath) {
  try {
    // Resolve the per-worktree hooks dir.
    // <worktree>/.git is a file: "gitdir: /abs/path/to/main/.git/worktrees/<name>"
    const gitFile = path.join(worktreePath, '.git');
    let hooksDir;
    const stat = fs.statSync(gitFile);
    if (stat.isDirectory()) {
      // Main tree-style .git directory (shouldn't happen for worktrees, but be safe).
      hooksDir = path.join(gitFile, 'hooks');
    } else {
      const raw = fs.readFileSync(gitFile, 'utf8').trim();
      const m = raw.match(/^gitdir:\s*(.+)$/);
      if (!m) return false;
      let gitdir = m[1].trim();
      if (!path.isAbsolute(gitdir)) {
        gitdir = path.resolve(worktreePath, gitdir);
      }
      hooksDir = path.join(gitdir, 'hooks');
    }
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookFile = path.join(hooksDir, 'post-checkout');
    const body = POST_CHECKOUT_SCRIPT;
    fs.writeFileSync(hookFile, body, { mode: 0o755 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Body of the post-checkout pin script. Inlined here so callers don't
 * need a separate file shipped with the repo. The script:
 *   - Receives (prev-HEAD, new-HEAD, flag) on argv per git's post-checkout
 *     contract. flag=1 means a branch checkout (not a file checkout).
 *   - No-op for file checkouts.
 *   - Reads worktree-meta.json and the current branch.
 *   - If GENTYR_CTO_WORKTREE_CHECKOUT_OK=1 in env, no-op (escape hatch
 *     for GENTYR's own remediation paths).
 *   - If the current branch differs from `startedOnBranch`, reverts by
 *     checking out the pinned branch and prints a deny message to stderr.
 *
 * NOTE: post-checkout fires AFTER the checkout has happened. Reverting
 * is the simplest cross-Git-version mechanism — there is no pre-checkout
 * hook in git.
 */
const POST_CHECKOUT_SCRIPT = `#!/usr/bin/env bash
# GENTYR CTO worktree HEAD pin — Fix 2 of the toasty-skipping-penguin plan.
# Reverts checkouts that move HEAD off the pinned branch.

set -e

# $3 is the "flag": 1 for branch checkout, 0 for file checkout.
if [ "\${3:-0}" != "1" ]; then
  exit 0
fi

# Escape hatch — set by GENTYR's own auto-fixers when a switch is needed.
if [ "\${GENTYR_CTO_WORKTREE_CHECKOUT_OK:-0}" = "1" ]; then
  exit 0
fi

WORKTREE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "\$WORKTREE_ROOT" ]; then exit 0; fi

META="\$WORKTREE_ROOT/.claude/worktree-meta.json"
if [ ! -f "\$META" ]; then exit 0; fi

PINNED="$(grep -E '"startedOnBranch"\\s*:' "\$META" 2>/dev/null \\
  | head -1 | sed -E 's/.*"startedOnBranch"\\s*:\\s*"([^"]+)".*/\\1/' || true)"
if [ -z "\$PINNED" ]; then exit 0; fi

CURRENT="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ "\$CURRENT" = "\$PINNED" ]; then exit 0; fi

# Mismatch — revert and log to a structured event file (best-effort).
EVT="\$WORKTREE_ROOT/.claude/state/worktree-pin-events.jsonl"
mkdir -p "$(dirname "\$EVT")" 2>/dev/null || true
TS="$(date -u +%FT%TZ)"
printf '{"ts":"%s","worktree":"%s","attempted":"%s","pinned":"%s","source_pid":%d}\\n' \\
  "\$TS" "\$WORKTREE_ROOT" "\$CURRENT" "\$PINNED" "\$PPID" >> "\$EVT" 2>/dev/null || true

git checkout "\$PINNED" --quiet 2>/dev/null || true

echo "GENTYR pin: reverted unauthorized checkout in \$WORKTREE_ROOT (\$CURRENT → \$PINNED)." 1>&2
echo "  To switch deliberately, set GENTYR_CTO_WORKTREE_CHECKOUT_OK=1 for the single command." 1>&2
exit 0
`;
