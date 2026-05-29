#!/usr/bin/env node
/**
 * Per-Turn CTO Worktree Topology (Fix 9)
 *
 * One worktree PER TURN, not per session. Each new pipeline turn gets its
 * own `cto-interactive-<sid8>-<turnId>` provisioned off the base branch.
 * Six pipeline steps share that worktree. Auto-cleanup at PR merge.
 *
 * No pollution between turns; concurrent turns can't collide; CTO doesn't
 * run any provisioning command.
 *
 * Two-tier model:
 *  - ROOT worktree (`cto-interactive-<sid8>`) — provisioned by
 *    authorization-audit-spawner.js when /lockdown off is approved. Lives
 *    for the entire session. Used as a fallback default when no per-turn
 *    worktree is active.
 *  - PER-TURN worktrees (`cto-interactive-<sid8>-<turn>`) — provisioned
 *    lazily by this module on the first pipeline Task call of a turn.
 *    Cleaned up after PR merge.
 *
 * Ledger: `.claude/state/cto-turn-worktrees.jsonl`. One JSON-line per turn
 * provisioning event. Lookup is by `(sessionId, turnId)` tuple; the
 * authoritative active-turn record is the most-recent line for the session
 * whose `pr_merged` flag is false.
 *
 * @version 1.0.0 — minimal foundation cut. Auto-rewriting of Task `cwd`
 *                  arguments is deferred; today the module provides the
 *                  primitives + ledger management and an advisory nudge.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const LEDGER = path.join(STATE_DIR, 'cto-turn-worktrees.jsonl');
const AUTOMATION_CONFIG = path.join(STATE_DIR, 'automation-config.json');

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Deterministic 8-char turn id from session id + a per-turn seed
 * (typically the uuid of the first user message that opened the turn).
 * Stable across re-tries of the same turn.
 */
export function computeTurnId(sessionId, turnSeed) {
  if (!sessionId) return null;
  const seed = String(turnSeed || Date.now());
  return crypto.createHash('sha256')
    .update(`${sessionId}:${seed}`)
    .digest('hex')
    .slice(0, 8);
}

/**
 * Read the session's root cto-interactive worktree path from
 * automation-config.json. Returns null when lockdown is on or path is
 * unrecorded.
 */
export function getRootCtoWorktree(sessionId) {
  const cfg = readJsonSafe(AUTOMATION_CONFIG);
  if (!cfg || !cfg.ctoWorktreePaths) return null;
  if (!sessionId) return null;
  const recorded = cfg.ctoWorktreePaths[sessionId];
  if (!recorded) return null;
  // verify it actually exists on disk
  try { if (!fs.statSync(recorded).isDirectory()) return null; } catch { return null; }
  return recorded;
}

/**
 * Append a row to the per-turn ledger.
 */
function appendLedger(record) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch { /* non-fatal */ }
}

/**
 * Read all ledger rows. Returns [] on missing/empty.
 */
export function readLedger() {
  try {
    if (!fs.existsSync(LEDGER)) return [];
    return fs.readFileSync(LEDGER, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Look up the currently-active per-turn worktree for a session. Returns
 * the most-recent ledger row for the session where:
 *   - pr_merged is not yet true
 *   - the worktree path still exists on disk
 * Otherwise returns null.
 */
export function getActiveTurnWorktree(sessionId) {
  if (!sessionId) return null;
  const rows = readLedger();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.sessionId !== sessionId) continue;
    if (r.pr_merged === true) continue;
    if (!r.worktreePath) continue;
    try { if (!fs.statSync(r.worktreePath).isDirectory()) continue; } catch { continue; }
    return r;
  }
  return null;
}

/**
 * Record a new per-turn worktree provisioning. Caller is responsible for
 * actually invoking `createWorktree()` from worktree-manager.js; this
 * helper just persists the ledger record.
 */
export function recordTurnWorktree({ sessionId, turnId, worktreePath, branch, baseBranch }) {
  appendLedger({
    event: 'provisioned',
    sessionId,
    turnId,
    worktreePath,
    branch,
    baseBranch,
    pr_merged: false,
  });
}

/**
 * Mark the per-turn worktree as PR-merged. Called from
 * plan-merge-tracker.js when it detects `gh pr merge` of a branch whose
 * head matches a recorded turn worktree.
 */
export function markTurnWorktreePrMerged(branch) {
  if (!branch) return false;
  const rows = readLedger();
  let matched = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].branch === branch && rows[i].pr_merged !== true) {
      appendLedger({
        event: 'pr_merged',
        sessionId: rows[i].sessionId,
        turnId: rows[i].turnId,
        worktreePath: rows[i].worktreePath,
        branch,
        pr_merged: true,
      });
      matched = true;
      break;
    }
  }
  return matched;
}

/**
 * Find merged per-turn worktrees ready for automatic cleanup. Returns the
 * worktrees whose most-recent ledger entry says pr_merged=true AND whose
 * directory still exists on disk.
 */
export function findMergedTurnWorktrees() {
  const rows = readLedger();
  const byPath = new Map();
  for (const r of rows) {
    if (!r.worktreePath) continue;
    const prev = byPath.get(r.worktreePath);
    if (!prev || new Date(r.ts) > new Date(prev.ts)) byPath.set(r.worktreePath, r);
  }
  const merged = [];
  for (const [worktreePath, r] of byPath) {
    if (r.pr_merged !== true) continue;
    try { if (!fs.statSync(worktreePath).isDirectory()) continue; } catch { continue; }
    merged.push(r);
  }
  return merged;
}

/**
 * Detect whether a basename looks like a PER-TURN worktree (suffix has at
 * least one extra hyphen after the sid8) vs a ROOT cto-interactive worktree
 * (basename is exactly `cto-interactive-<sid8>` with no further suffix).
 */
export function isTurnWorktreeBasename(basename) {
  if (!basename) return false;
  // root form: cto-interactive-<sid8>  (1 hyphen segment after the prefix)
  // turn form: cto-interactive-<sid8>-<turn>  (2+ hyphen segments)
  return /^cto-interactive-[^-]+-[^-]+/.test(basename);
}

/**
 * Detect whether a basename looks like a ROOT cto-interactive worktree.
 */
export function isRootCtoBasename(basename) {
  if (!basename) return false;
  return /^cto-interactive-[^-]+$/.test(basename);
}

export const _LEDGER_PATH = LEDGER;
