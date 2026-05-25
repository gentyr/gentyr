#!/usr/bin/env node
/**
 * process-inventory.js — Map every running `claude` process to its origin,
 * cross-check against session-queue.db, and identify orphans.
 *
 * Background:
 *   A long-running gentyr install accumulates `claude` subprocesses that may
 *   be true revival chains, structurally-expected per-session stdio servers,
 *   or genuine orphans (parent died, child survived). When the host runs hot
 *   (~600+ node processes from ~12 active sessions × ~27 MCP stdio servers
 *   each), it's hard to tell which is which by eyeballing `ps`.
 *
 * Usage:
 *   node scripts/process-inventory.js [--project-dir DIR] [--json]
 *                                     [--kill-orphans] [--dry-run]
 *
 * Output (default): human-readable table with columns:
 *   PID  ETIME  STATE  AGENT_TYPE  LANE  QUEUE_ID  ORIGIN
 *
 *   ORIGIN classification:
 *     - tracked    — PID matches an active queue_item (running/spawning)
 *     - completed  — PID matches a queue_item already marked completed/failed
 *                    (process should have exited but is still alive)
 *     - subagent   — child of a tracked claude PID (Task() sub-agent)
 *     - orphan     — no matching queue row anywhere
 *
 * --kill-orphans: SIGTERM (then SIGKILL after 5s) every classified orphan.
 *   Skips `tracked` and `subagent`. Default refuses to touch processes <60s
 *   old to avoid racing with concurrent spawns.
 *
 * Exit code: 0 always (diagnostic tool — don't fail a wrapping pipeline).
 */

import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function getFlag(name, def = null) {
  const idx = args.indexOf(name);
  if (idx < 0) return def;
  return args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : true;
}
const PROJECT_DIR = getFlag('--project-dir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const KILL_ORPHANS = args.includes('--kill-orphans');
const DRY_RUN = args.includes('--dry-run');
const JSON_OUT = args.includes('--json');
const MIN_AGE_SECONDS = 60;

function parseEtime(s) {
  // [dd-]hh:mm:ss or mm:ss
  const m = s.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d, h, mm, ss] = m;
  return ((parseInt(d || '0', 10) * 86400) + (parseInt(h || '0', 10) * 3600) + (parseInt(mm, 10) * 60) + parseInt(ss, 10));
}

function listClaudeProcesses() {
  let out;
  try {
    out = execSync('ps -axo pid=,ppid=,etime=,stat=,command=', { encoding: 'utf8', timeout: 5000 });
  } catch (err) {
    process.stderr.write(`ps failed: ${err.message}\n`);
    return [];
  }
  const procs = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const [, pidS, ppidS, etime, state, cmd] = m;
    if (!cmd.match(/^(\/[\w./-]+\/)?claude(\s|$)/) || !cmd.includes('--dangerously-skip-permissions')) continue;
    procs.push({
      pid: parseInt(pidS, 10),
      ppid: parseInt(ppidS, 10),
      etime,
      ageSeconds: parseEtime(etime) ?? 0,
      state,
      cmd: cmd.slice(0, 200),
    });
  }
  return procs;
}

function loadQueueIndex(projectDir) {
  // Uses sqlite3 CLI for portability — avoids pulling better-sqlite3 native
  // module into a diagnostic script that may run on a host where mcp-servers
  // node_modules isn't built yet.
  const dbPath = path.join(projectDir, '.claude', 'state', 'session-queue.db');
  if (!fs.existsSync(dbPath)) return new Map();
  const idx = new Map();
  try {
    const sql = 'SELECT pid, id, status, lane, agent_type FROM queue_items WHERE pid IS NOT NULL AND pid > 0;';
    const out = execFileSync('sqlite3', [dbPath, '-cmd', '.mode tabs', sql], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 32 * 1024 * 1024, // queue_items table can be large after months of history
    });
    for (const line of out.split('\n')) {
      const cols = line.split('\t');
      if (cols.length < 5) continue;
      const pid = parseInt(cols[0], 10);
      if (!pid) continue;
      const row = { pid, queueId: cols[1], status: cols[2], lane: cols[3], agentType: cols[4] };
      // Keep the LATEST row per PID by overwriting (queue items don't guarantee insertion order,
      // but for diagnostic purposes the active row tends to be inserted last; if multiple match
      // we'll prefer running > queued > others).
      const prior = idx.get(pid);
      if (!prior || statusRank(row.status) > statusRank(prior.status)) {
        idx.set(pid, row);
      }
    }
  } catch (err) {
    process.stderr.write(`sqlite3 read failed (non-fatal): ${err.message}\n`);
  }
  return idx;
}
function statusRank(s) {
  return ({ running: 4, spawning: 3, queued: 2, suspended: 1 })[s] || 0;
}

function classify(p, queueIdx, parents) {
  const row = queueIdx.get(p.pid);
  if (row) {
    if (row.status === 'running' || row.status === 'spawning') {
      return { origin: 'tracked', queueId: row.queueId, agentType: row.agentType, lane: row.lane };
    }
    return { origin: 'completed', queueId: row.queueId, agentType: row.agentType, lane: row.lane };
  }
  if (parents.has(p.ppid)) {
    return { origin: 'subagent', queueId: queueIdx.get(p.ppid)?.queueId || '-', agentType: '-', lane: '-' };
  }
  return { origin: 'orphan', queueId: '-', agentType: '-', lane: '-' };
}

// Track pending SIGKILL escalations so the script doesn't exit before they fire.
const _pendingKills = [];
function killOrphan(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    // Don't .unref() — we want the script to stay alive until the escalation
    // window closes. main() awaits flushKills() before returning.
    _pendingKills.push(new Promise(resolve => {
      setTimeout(() => {
        try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
        resolve();
      }, 5000);
    }));
    return 'sigterm-sent';
  } catch (err) {
    return `failed: ${err.code || err.message}`;
  }
}
function flushKills() {
  return Promise.all(_pendingKills);
}

async function main() {
  const queueIdx = loadQueueIndex(PROJECT_DIR);
  const procs = listClaudeProcesses();
  const parents = new Set(procs.map(p => p.pid));
  const enriched = procs.map(p => ({ ...p, ...classify(p, queueIdx, parents) }));

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(enriched, null, 2) + '\n');
    return;
  }

  // Summary header
  const counts = enriched.reduce((acc, p) => { acc[p.origin] = (acc[p.origin] || 0) + 1; return acc; }, {});
  process.stdout.write(`\n=== claude process inventory (${PROJECT_DIR}) ===\n`);
  process.stdout.write(`total: ${enriched.length}    ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('    ')}\n\n`);

  // Table
  const pad = (s, n) => String(s).padEnd(n);
  process.stdout.write(`${pad('PID', 8)}${pad('ETIME', 12)}${pad('STATE', 7)}${pad('AGENT_TYPE', 28)}${pad('LANE', 12)}${pad('QUEUE_ID', 28)}ORIGIN\n`);
  process.stdout.write('-'.repeat(120) + '\n');
  for (const p of enriched.sort((a, b) => b.ageSeconds - a.ageSeconds)) {
    process.stdout.write(
      `${pad(p.pid, 8)}${pad(p.etime, 12)}${pad(p.state, 7)}${pad(p.agentType || '-', 28)}${pad(p.lane || '-', 12)}${pad(p.queueId || '-', 28)}${p.origin}\n`
    );
  }

  if (KILL_ORPHANS) {
    process.stdout.write('\n=== killing orphans + stale-completed ===\n');
    // Kill rules:
    //   - 'orphan' (no queue row at all): kill if age >= MIN_AGE_SECONDS (60s)
    //   - 'completed' (queue row exists but marked completed/failed): kill if
    //     age >= 30 min — these are revived sessions that finished work but
    //     never exited; their queue row is the closest thing to a paper trail
    //     so we wait longer before terminating
    //   - 'tracked' / 'subagent': never killed by this script
    const STALE_COMPLETED_SECONDS = 30 * 60;
    const targets = enriched.filter(p => {
      if (p.origin === 'orphan' && p.ageSeconds >= MIN_AGE_SECONDS) return true;
      if (p.origin === 'completed' && p.ageSeconds >= STALE_COMPLETED_SECONDS) return true;
      return false;
    });
    if (targets.length === 0) {
      process.stdout.write(`(none — orphan threshold ${MIN_AGE_SECONDS}s, completed-stale threshold ${STALE_COMPLETED_SECONDS}s)\n`);
    }
    for (const p of targets) {
      if (DRY_RUN) {
        process.stdout.write(`would kill PID ${p.pid} (${p.origin}, age ${p.etime}, queue=${p.queueId})\n`);
      } else {
        const result = killOrphan(p.pid);
        process.stdout.write(`PID ${p.pid} (${p.origin}, age ${p.etime}): ${result}\n`);
      }
    }
    if (!DRY_RUN && targets.length > 0) {
      process.stdout.write('(waiting up to 5s for SIGTERM cleanup, then SIGKILL if needed)\n');
      await flushKills();
      process.stdout.write('done.\n');
    }
  }
}

try { await main(); } catch (err) {
  process.stderr.write(`process-inventory failed: ${err.stack || err.message}\n`);
  process.exit(0); // diagnostic — don't fail callers
}
