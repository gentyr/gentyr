#!/usr/bin/env node
/**
 * Repair Main Tree Drift
 *
 * Standalone script invoked by the `repair_main_tree_drift` MCP tool
 * (registered on the agent-tracker server). Detects main-tree drift,
 * dedups against in-flight rescue sessions, and enqueues a project-manager
 * rescue agent with GENTYR_MAIN_TREE_REPAIR=true so it can salvage any
 * orphaned work to a draft PR before restoring the main tree to its base
 * branch.
 *
 * Usage:
 *   node scripts/repair-main-tree-drift.js --project-dir /path/to/project [--reason "..."] [--force]
 *
 * Output: single JSON object on stdout. Fields:
 *   - status: 'enqueued' | 'no_drift' | 'already_queued' | 'error'
 *   - queueId, agentId, baseBranch, currentBranch (when applicable)
 *   - divergence (when computed)
 *   - message (human-readable summary)
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    reason: null,
    force: false,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-dir' && args[i + 1]) {
      result.projectDir = args[++i];
    } else if (args[i] === '--reason' && args[i + 1]) {
      result.reason = args[++i];
    } else if (args[i] === '--force') {
      result.force = true;
    } else if (args[i] === '--dry-run') {
      result.dryRun = true;
    }
  }
  return result;
}

function emitAndExit(payload, exitCode = 0) {
  process.stdout.write(JSON.stringify(payload));
  process.exit(exitCode);
}

async function main() {
  const args = parseArgs();
  process.env.CLAUDE_PROJECT_DIR = args.projectDir;

  // Dynamic imports — these resolve relative to the framework root.
  const frameworkRoot = path.resolve(__dirname, '..');
  const rescueModPath = path.join(frameworkRoot, '.claude', 'hooks', 'lib', 'main-tree-rescue.js');
  const queueModPath = path.join(frameworkRoot, '.claude', 'hooks', 'lib', 'session-queue.js');
  const auditModPath = path.join(frameworkRoot, '.claude', 'hooks', 'lib', 'session-audit.js');
  const trackerModPath = path.join(frameworkRoot, '.claude', 'hooks', 'agent-tracker.js');

  let detectMainTreeDrift, buildMainTreeRescuePrompt, enqueueSession, auditEvent, AGENT_TYPES, HOOK_TYPES;
  try {
    ({ detectMainTreeDrift, buildMainTreeRescuePrompt } = await import(rescueModPath));
    ({ enqueueSession } = await import(queueModPath));
    ({ auditEvent } = await import(auditModPath));
    ({ AGENT_TYPES, HOOK_TYPES } = await import(trackerModPath));
  } catch (err) {
    emitAndExit({ status: 'error', message: `Failed to load framework modules: ${err.message}` }, 1);
  }

  // 1. Detect drift
  let drift;
  try {
    drift = detectMainTreeDrift(args.projectDir);
  } catch (err) {
    emitAndExit({ status: 'error', message: `Drift detection failed: ${err.message}` }, 1);
  }

  if (!drift.drifted && !args.force) {
    emitAndExit({
      status: 'no_drift',
      currentBranch: drift.currentBranch,
      baseBranch: drift.baseBranch,
      message: drift.baseBranch
        ? `Main tree is clean and on '${drift.currentBranch}' (expected '${drift.baseBranch}'). No repair needed.`
        : 'No base branch resolved — repository may not be configured for preview-watcher.',
    });
  }

  // 2. Dedup against in-flight rescue sessions
  let alreadyQueued = null;
  try {
    // Use better-sqlite3 via dynamic require to avoid hard dependency at script-import time.
    const { default: Database } = await import('better-sqlite3');
    const queueDbPath = path.join(args.projectDir, '.claude', 'state', 'session-queue.db');
    if (fs.existsSync(queueDbPath)) {
      const db = new Database(queueDbPath, { readonly: true });
      db.pragma('busy_timeout = 3000');
      const row = db.prepare(
        "SELECT id, agent_id FROM queue_items WHERE status IN ('queued', 'running', 'spawning') AND tag_context = 'rescue-main-tree' AND (cwd = ? OR worktree_path = ?)"
      ).get(args.projectDir, args.projectDir);
      db.close();
      if (row) alreadyQueued = row;
    }
  } catch (err) {
    // Non-fatal — enqueueSession has its own dedup layers, so even if this
    // pre-check fails we won't double-spawn. Just log and continue.
    process.stderr.write(`[repair-main-tree-drift] dedup pre-check failed (non-fatal): ${err.message}\n`);
  }

  if (alreadyQueued) {
    emitAndExit({
      status: 'already_queued',
      queueId: alreadyQueued.id,
      agentId: alreadyQueued.agent_id,
      currentBranch: drift.currentBranch,
      baseBranch: drift.baseBranch,
      message: `A main-tree rescue session is already queued/running: ${alreadyQueued.id}`,
    });
  }

  // 3. Enqueue the rescue agent
  const baseBranch = drift.baseBranch;
  const currentBranch = drift.currentBranch;
  const dirty = drift.dirty;
  const midMerge = drift.midMerge;
  const detached = drift.detached;
  const divergence = drift.divergence;

  if (args.dryRun) {
    emitAndExit({
      status: 'dry_run',
      wouldEnqueue: true,
      baseBranch,
      currentBranch,
      dirty,
      midMerge,
      detached,
      divergence,
      reason: args.reason,
      message: 'Dry run — would have enqueued a critical-priority rescue session. Re-run without --dry-run to proceed.',
    });
  }

  let result;
  try {
    result = enqueueSession({
      title: `Rescue main tree drift: ${currentBranch ?? 'unknown'} -> ${baseBranch ?? 'preview'}`,
      agentType: AGENT_TYPES.TASK_RUNNER_PROJECT_MANAGER,
      hookType: HOOK_TYPES.TASK_RUNNER,
      tagContext: 'rescue-main-tree',
      source: 'main-tree-drift-repair',
      priority: 'critical',
      buildPrompt: (agentId) => buildMainTreeRescuePrompt({
        agentId,
        projectDir: args.projectDir,
        baseBranch,
        currentBranch,
        dirty,
        midMerge,
        detached,
        divergence,
        reason: args.reason,
      }),
      extraEnv: { GENTYR_MAIN_TREE_REPAIR: 'true' },
      metadata: {
        source: 'main-tree-drift-repair',
        baseBranch,
        currentBranch,
        dirty,
        midMerge,
        detached,
        commitsAhead: divergence?.commitsAhead ?? null,
        commitsBehind: divergence?.commitsBehind ?? null,
        dirtyFileCount: divergence?.dirtyFileCount ?? null,
        probableCase: divergence?.probableCase ?? null,
        reason: args.reason ?? null,
      },
      cwd: args.projectDir,
      projectDir: args.projectDir,
    });
  } catch (err) {
    emitAndExit({ status: 'error', message: `enqueueSession failed: ${err.message}` }, 1);
  }

  // 4. Audit event
  try {
    auditEvent('main_tree_repair_enqueued', {
      queue_id: result.queueId,
      project_dir: args.projectDir,
      base_branch: baseBranch,
      current_branch: currentBranch,
      dirty,
      mid_merge: midMerge,
      detached,
      commits_behind: divergence?.commitsBehind ?? null,
      commits_ahead: divergence?.commitsAhead ?? null,
      probable_case: divergence?.probableCase ?? null,
      reason: args.reason ?? null,
    });
  } catch {
    // Non-fatal; the queue entry itself is the durable record.
  }

  emitAndExit({
    status: 'enqueued',
    queueId: result.queueId,
    baseBranch,
    currentBranch,
    dirty,
    midMerge,
    detached,
    divergence,
    message: `Enqueued main-tree rescue session ${result.queueId} (priority: critical)`,
  });
}

main().catch((err) => {
  emitAndExit({ status: 'error', message: `Unexpected error: ${err.message ?? String(err)}` }, 1);
});
