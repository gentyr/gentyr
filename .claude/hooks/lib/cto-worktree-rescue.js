/**
 * CTO Worktree Pollution Detection + Rescue (Fix 7 — complete autonomous version).
 *
 * Detects when a `cto-interactive-*` worktree has orphaned work (staged,
 * modified, or untracked files from a previous session) and enqueues the
 * `gentyr-internal-worktree-rescuer` agent to salvage it to a draft PR.
 *
 * Spawned by two trigger surfaces:
 *   - `session-briefing.js` at SessionStart of an interactive session with
 *     lockdown off (the case the xy session a5b87d5f failure mode hits).
 *   - `hourly-automation.js` `cto_worktree_pollution_rescue` runIfDue block
 *     (15-minute cooldown) for sessions whose owner has been quiet for 30
 *     min and whose worktree is dirty.
 *
 * The CTO never has to do anything — autonomous detection + autonomous
 * rescue (the rescuer opens a draft PR; nothing is auto-merged).
 *
 * @module cto-worktree-rescue
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

/**
 * Detect whether a worktree has orphaned/polluted work.
 *
 * Returns one of:
 *   - { polluted: false } — clean (nothing to rescue)
 *   - { polluted: true, staged, modified, untracked, currentBranch,
 *       pinnedBranch, branchMismatch } — needs rescue
 *
 * Fail-open: any error returns { polluted: false } so we never block a
 * SessionStart on a detection failure.
 *
 * @param {string} worktreePath
 */
export function detectPollution(worktreePath) {
  try {
    if (!worktreePath || !fs.existsSync(worktreePath)) {
      return { polluted: false };
    }
    const currentBranch = execFileSync(
      'git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', timeout: 3000, stdio: 'pipe' },
    ).trim();
    const status = execFileSync(
      'git', ['-C', worktreePath, 'status', '--porcelain'],
      { encoding: 'utf8', timeout: 5000, stdio: 'pipe' },
    ).trim();
    let pinnedBranch = '';
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(worktreePath, '.claude', 'worktree-meta.json'), 'utf8'),
      );
      if (meta && typeof meta.startedOnBranch === 'string') pinnedBranch = meta.startedOnBranch;
    } catch { /* no meta — pre-Fix-2 worktree, branchMismatch unknown */ }

    let staged = 0, modified = 0, untracked = 0;
    if (status) {
      for (const line of status.split('\n')) {
        if (!line) continue;
        const code = line.slice(0, 2);
        if (code === '??') untracked += 1;
        else if (code[0] !== ' ') staged += 1;
        else modified += 1;
      }
    }
    const dirty = staged + modified + untracked > 0;
    const branchMismatch = !!(pinnedBranch && currentBranch && pinnedBranch !== currentBranch);
    if (!dirty && !branchMismatch) return { polluted: false };
    return {
      polluted: true,
      staged, modified, untracked,
      currentBranch, pinnedBranch, branchMismatch,
    };
  } catch {
    return { polluted: false };
  }
}

/**
 * Derive a short turn-hash for the rescue branch name. Stable across
 * repeated calls for the same worktree + day so we don't end up with
 * dozens of `rescue/*` branches when SessionStart triggers fire often.
 *
 * @param {string} worktreePath
 */
export function computeTurnHash(worktreePath) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return crypto
    .createHash('sha256')
    .update(`${worktreePath}|${day}`)
    .digest('hex')
    .slice(0, 8);
}

/**
 * Check whether a rescue for this worktree is already in flight or recently
 * completed (within the last 30 minutes). Avoids spawning duplicate rescuers
 * when the SessionStart trigger and hourly-automation trigger fire on the
 * same polluted worktree within minutes of each other.
 *
 * Uses a small JSONL ledger at .claude/state/cto-worktree-rescue-log.jsonl.
 *
 * @param {string} projectDir
 * @param {string} worktreePath
 * @returns {boolean} true if a rescue was logged in the last 30 minutes
 */
export function rescueRecentlyAttempted(projectDir, worktreePath) {
  try {
    const ledger = path.join(projectDir, '.claude', 'state', 'cto-worktree-rescue-log.jsonl');
    if (!fs.existsSync(ledger)) return false;
    const cutoff = Date.now() - 30 * 60 * 1000;
    const raw = fs.readFileSync(ledger, 'utf8');
    for (const line of raw.split('\n').reverse()) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.worktreePath !== worktreePath) continue;
      const ts = Date.parse(entry.ts || '');
      if (Number.isFinite(ts) && ts >= cutoff) return true;
      // Older entry — anything before this is also older; safe to break
      if (Number.isFinite(ts) && ts < cutoff) return false;
    }
  } catch { /* fail-open */ }
  return false;
}

/**
 * Record a rescue attempt in the ledger.
 *
 * @param {string} projectDir
 * @param {object} record
 */
export function recordRescueAttempt(projectDir, record) {
  try {
    const dir = path.join(projectDir, '.claude', 'state');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ledger = path.join(dir, 'cto-worktree-rescue-log.jsonl');
    fs.appendFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch { /* non-fatal */ }
}

/**
 * Enqueue the `gentyr-internal-worktree-rescuer` agent in the audit lane.
 * Returns { enqueued: true, queueId } on success or
 * { enqueued: false, reason } on skip / failure.
 *
 * Soft-imports the session-queue module so callers (session-briefing,
 * hourly-automation) don't pay the cost when the worktree isn't polluted.
 *
 * @param {object} params
 * @param {string} params.projectDir
 * @param {string} params.worktreePath
 * @param {ReturnType<typeof detectPollution>} params.detection
 * @param {string} [params.source] — for the queue item's `source` field
 */
export async function enqueueRescuer({ projectDir, worktreePath, detection, source }) {
  if (!detection || !detection.polluted) return { enqueued: false, reason: 'not_polluted' };
  if (rescueRecentlyAttempted(projectDir, worktreePath)) {
    return { enqueued: false, reason: 'recent_attempt' };
  }
  const turnHash = computeTurnHash(worktreePath);
  let enqueueSession;
  try {
    ({ enqueueSession } = await import('./session-queue.js'));
  } catch (err) {
    return { enqueued: false, reason: `session_queue_unavailable: ${err.message}` };
  }
  const title = `CTO worktree rescue (turn ${turnHash})`;
  const prompt = [
    `You are gentyr-internal-worktree-rescuer.`,
    ``,
    `Polluted worktree: ${worktreePath}`,
    `Pinned branch:     ${detection.pinnedBranch || '<unknown — pre-Fix-2>'}`,
    `Current branch:    ${detection.currentBranch || '<unknown>'}`,
    `Staged: ${detection.staged}, Modified: ${detection.modified}, Untracked: ${detection.untracked}`,
    `Turn hash:         ${turnHash}`,
    ``,
    `Follow the step-by-step in your agent definition strictly:`,
    `  - draft PR only`,
    `  - never auto-merge`,
    `  - never force-push`,
    `  - never use --no-verify`,
    `  - on any failure, file a deputy-CTO report (report_to_deputy_cto) and exit`,
  ].join('\n');
  const extraEnv = {
    GENTYR_RESCUE_WORKTREE_PATH: worktreePath,
    GENTYR_RESCUE_PINNED_BRANCH: detection.pinnedBranch || '',
    GENTYR_RESCUE_CURRENT_BRANCH: detection.currentBranch || '',
    GENTYR_RESCUE_TURN_HASH: turnHash,
  };
  try {
    const result = await enqueueSession({
      agent: 'gentyr-internal-worktree-rescuer',
      agentType: 'gentyr-internal-worktree-rescuer',
      title,
      prompt,
      model: 'sonnet',
      lane: 'audit',
      priority: 'urgent',
      cwd: worktreePath,
      source: source || 'cto-worktree-rescue',
      ttlMinutes: 10,
      extraEnv,
      metadata: {
        worktreePath,
        pinnedBranch: detection.pinnedBranch || null,
        currentBranch: detection.currentBranch || null,
        turnHash,
      },
    });
    recordRescueAttempt(projectDir, {
      worktreePath,
      queueId: result?.queueId || null,
      turnHash,
      source: source || 'cto-worktree-rescue',
      detection: {
        staged: detection.staged,
        modified: detection.modified,
        untracked: detection.untracked,
        currentBranch: detection.currentBranch || null,
        pinnedBranch: detection.pinnedBranch || null,
      },
    });
    if (result?.blocked) {
      return { enqueued: false, reason: `enqueue_blocked: ${result.blocked}` };
    }
    return { enqueued: true, queueId: result?.queueId || null, turnHash };
  } catch (err) {
    return { enqueued: false, reason: `enqueue_threw: ${err.message}` };
  }
}

/**
 * Iterate every `cto-interactive-*` worktree recorded in
 * `automation-config.json` `ctoWorktreePaths`. For each one whose owner
 * session is quiet (no heartbeat in 30 min) AND whose worktree is dirty,
 * enqueue a rescuer.
 *
 * Returns a summary `{ scanned, enqueued, skipped }` for logging.
 *
 * @param {object} params
 * @param {string} params.projectDir
 */
export async function scanAndRescue({ projectDir }) {
  const summary = { scanned: 0, enqueued: 0, skipped: 0, errors: 0 };
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(
      path.join(projectDir, '.claude', 'state', 'automation-config.json'), 'utf8',
    ));
  } catch { return summary; }
  const paths = config.ctoWorktreePaths;
  if (!paths || typeof paths !== 'object') return summary;

  let livenessByPath = new Map();
  try {
    const liveness = JSON.parse(fs.readFileSync(
      path.join(projectDir, '.claude', 'state', 'interactive-sessions.json'), 'utf8',
    ));
    for (const entry of Object.values(liveness)) {
      if (entry && entry.ctoWorktreePath) {
        livenessByPath.set(entry.ctoWorktreePath, entry);
      }
    }
  } catch { /* no liveness file — treat all as quiet */ }

  const quietCutoff = Date.now() - 30 * 60 * 1000;

  for (const [sessionId, wtPath] of Object.entries(paths)) {
    if (!wtPath || typeof wtPath !== 'string') continue;
    summary.scanned += 1;
    const live = livenessByPath.get(wtPath);
    const lastHeartbeat = live ? Date.parse(live.lastHeartbeat || '') : NaN;
    const isQuiet = !Number.isFinite(lastHeartbeat) || lastHeartbeat < quietCutoff;
    if (!isQuiet) { summary.skipped += 1; continue; }
    const detection = detectPollution(wtPath);
    if (!detection.polluted) { summary.skipped += 1; continue; }
    try {
      const res = await enqueueRescuer({
        projectDir,
        worktreePath: wtPath,
        detection,
        source: 'hourly-automation:cto_worktree_pollution_rescue',
      });
      if (res.enqueued) summary.enqueued += 1;
      else summary.skipped += 1;
    } catch {
      summary.errors += 1;
    }
    // Sanity: don't enqueue more than 5 rescuers per pass.
    if (summary.enqueued >= 5) break;
    // sessionId is unused but documents the iteration shape for future readers
    void sessionId;
  }
  return summary;
}
