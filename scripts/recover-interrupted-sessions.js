#!/usr/bin/env node
/**
 * Recover Interrupted Sessions - One-time recovery script
 *
 * Scans a project for sessions interrupted by quota hits and revives them.
 * Cross-references agent-tracker-history with TODO database to find
 * in_progress tasks with no corresponding live process.
 *
 * Usage:
 *   node scripts/recover-interrupted-sessions.js [--path /project] [--dry-run] [--max-concurrent 3]
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn } from 'child_process';

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const pathIdx = args.indexOf('--path');
const projectDir = pathIdx >= 0 && args[pathIdx + 1]
  ? args[pathIdx + 1]
  : (process.env.CLAUDE_PROJECT_DIR || process.cwd());
const maxConcIdx = args.indexOf('--max-concurrent');
const maxConcurrent = maxConcIdx >= 0 && args[maxConcIdx + 1]
  ? parseInt(args[maxConcIdx + 1], 10) || 3
  : 3;

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const HISTORY_PATH = path.join(projectDir, '.claude', 'state', 'agent-tracker-history.json');
const TODO_DB_PATH = path.join(projectDir, '.claude', 'todo.db');
const HEAD_BYTES = 2000;
const TAIL_BYTES = 8192;
const MAX_AGE_DAYS = 7;

// Lazy SQLite
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  console.error('ERROR: better-sqlite3 not available. Install it first.');
  process.exit(1);
}

function log(msg) {
  const prefix = dryRun ? '[DRY-RUN] ' : '';
  console.log(`${prefix}${msg}`);
}

function getSessionDir() {
  const projectPath = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  const sessionDir = path.join(CLAUDE_PROJECTS_DIR, projectPath);
  if (fs.existsSync(sessionDir)) return sessionDir;

  const altPath = path.join(CLAUDE_PROJECTS_DIR, projectPath.replace(/^-/, ''));
  if (fs.existsSync(altPath)) return altPath;

  return null;
}

function readHead(filePath, numBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(numBytes);
    const bytesRead = fs.readSync(fd, buf, 0, numBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readTail(filePath, numBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, stat.size - numBytes);
    const buf = Buffer.alloc(Math.min(numBytes, stat.size));
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function findSessionFileByAgentId(sessionDir, agentId) {
  const marker = `[AGENT:${agentId}]`;
  let files;
  try {
    files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return null;
  }

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    const head = readHead(filePath, HEAD_BYTES);
    if (head.includes(marker)) return filePath;
  }

  return null;
}

function countAssistantMessages(sessionFile) {
  const content = readTail(sessionFile, 32768);
  return (content.match(/"type":"assistant"/g) || []).length;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means process exists but we lack permission — it's alive
    return err.code !== 'ESRCH';
  }
}

function countRunningAgents() {
  try {
    const result = execSync(
      "pgrep -cf 'claude.*--dangerously-skip-permissions'",
      { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
    ).trim();
    return parseInt(result, 10) || 0;
  } catch {
    return 0;
  }
}

function extractSessionIdFromPath(filePath) {
  const basename = path.basename(filePath, '.jsonl');
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return uuidRegex.test(basename) ? basename : null;
}

function hasRateLimitInTail(sessionFile) {
  const tail = readTail(sessionFile, TAIL_BYTES);
  return tail.includes('"error":"rate_limit"') || tail.includes('"isApiErrorMessage":true');
}

async function main() {
  log(`Scanning project: ${projectDir}`);
  log(`Max concurrent revivals: ${maxConcurrent}`);
  log('');

  // Validate paths
  if (!fs.existsSync(projectDir)) {
    console.error(`ERROR: Project directory not found: ${projectDir}`);
    process.exit(1);
  }

  if (!fs.existsSync(HISTORY_PATH)) {
    console.error(`ERROR: Agent tracker history not found: ${HISTORY_PATH}`);
    process.exit(1);
  }

  if (!fs.existsSync(TODO_DB_PATH)) {
    console.error(`ERROR: TODO database not found: ${TODO_DB_PATH}`);
    process.exit(1);
  }

  const sessionDir = getSessionDir();
  if (!sessionDir) {
    console.error('ERROR: Session directory not found.');
    process.exit(1);
  }

  // Load history
  const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  if (!Array.isArray(history.agents)) {
    console.error('ERROR: Invalid agent tracker history.');
    process.exit(1);
  }

  // Open TODO database
  const db = new Database(TODO_DB_PATH, { readonly: true });

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const candidates = [];

  log('=== Scanning for interrupted sessions ===');
  log('');

  for (const agent of history.agents) {
    // Filter: must be a task runner that died unexpectedly
    const isDead = (agent.status === 'completed' && agent.reapReason === 'process_already_dead') ||
                   (agent.status === 'reaped' && agent.reapReason === 'process_already_dead');

    // Also check for running agents that are actually dead
    const isZombie = agent.status === 'running' && agent.pid && !isProcessAlive(agent.pid);

    if (!isDead && !isZombie) continue;

    const taskId = agent.metadata?.taskId;
    if (!taskId) continue;

    const agentTime = new Date(agent.timestamp).getTime();
    if (agentTime < cutoff) continue;

    // Check TODO status
    const task = db.prepare('SELECT id, title, status, section FROM tasks WHERE id = ?').get(taskId);
    if (!task) continue;

    // Find session file
    const sessionFile = agent.sessionFile || findSessionFileByAgentId(sessionDir, agent.id);
    if (!sessionFile || !fs.existsSync(sessionFile)) continue;

    const sessionId = extractSessionIdFromPath(sessionFile);
    if (!sessionId) continue;

    const assistantMsgCount = countAssistantMessages(sessionFile);
    const wasRateLimited = hasRateLimitInTail(sessionFile);

    candidates.push({
      agent,
      task,
      sessionFile,
      sessionId,
      assistantMsgCount,
      wasRateLimited,
      isZombie,
    });
  }

  db.close();

  if (candidates.length === 0) {
    log('No interrupted sessions found.');
    return;
  }

  log(`Found ${candidates.length} interrupted session(s):`);
  log('');

  // Display summary
  for (const c of candidates) {
    const status = c.isZombie ? 'ZOMBIE' : 'DEAD';
    const rateLimited = c.wasRateLimited ? ' [RATE-LIMITED]' : '';
    const workDone = c.assistantMsgCount > 10 ? 'significant work' : 'minimal work';
    log(`  [${status}${rateLimited}] ${c.agent.id}`);
    log(`    Task: "${c.task.title}" (${c.task.section})`);
    log(`    TODO status: ${c.task.status}`);
    log(`    Session: ${c.sessionId.slice(0, 8)}... (${c.assistantMsgCount} assistant messages - ${workDone})`);
    log(`    Age: ${Math.round((Date.now() - new Date(c.agent.timestamp).getTime()) / 3600000)}h`);

    const action = c.task.status === 'in_progress'
      ? (c.assistantMsgCount > 10 ? 'RESUME with --resume' : 'RESET to pending for fresh spawn')
      : (c.task.status === 'pending' ? 'RE-SPAWN (already reset)' : 'SKIP (task already completed)');
    log(`    Planned action: ${action}`);
    log('');
  }

  if (dryRun) {
    log('=== DRY RUN - no actions taken ===');
    return;
  }

  // Execute recovery
  log('=== Executing recovery ===');
  log('');

  const running = countRunningAgents();
  let availableSlots = Math.max(0, maxConcurrent - running);
  log(`Running agents: ${running}, available slots: ${availableSlots}`);

  let revived = 0;
  let reset = 0;
  let skipped = 0;

  const writeDb = new Database(TODO_DB_PATH);

  for (const c of candidates) {
    if (availableSlots <= 0) {
      log(`  Concurrency limit reached, deferring remaining sessions.`);
      break;
    }

    // Skip already-completed tasks
    if (c.task.status === 'completed') {
      log(`  SKIP ${c.agent.id}: task already completed.`);
      skipped++;
      continue;
    }

    // Reset TODO to pending if it's in_progress
    if (c.task.status === 'in_progress') {
      writeDb.prepare("UPDATE tasks SET status = 'pending', started_at = NULL WHERE id = ?").run(c.task.id);
      log(`  RESET TODO ${c.task.id} to pending.`);
      reset++;
    }

    // Decide: resume or fresh spawn
    if (c.assistantMsgCount > 10) {
      // Significant work done - resume
      log(`  RESUMING session ${c.sessionId.slice(0, 8)}...`);

      // Mark task back to in_progress
      writeDb.prepare("UPDATE tasks SET status = 'in_progress', started_at = datetime('now') WHERE id = ?").run(c.task.id);

      const mcpConfig = path.join(projectDir, '.mcp.json');
      const child = spawn('claude', [
        '--resume', c.sessionId,
        '--dangerously-skip-permissions',
        '--mcp-config', mcpConfig,
        '--output-format', 'json',
      ], {
        cwd: projectDir,
        stdio: 'inherit',
        detached: true,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectDir,
          CLAUDE_SPAWNED_SESSION: 'true',
        },
      });

      child.unref();
      if (child.pid) {
        log(`    Spawned PID ${child.pid}`);
        revived++;
        availableSlots--;
      }
    } else {
      // Minimal work - leave as pending for regular automation to pick up
      log(`  LEFT as pending for fresh spawn: ${c.task.title}`);
    }
  }

  writeDb.close();

  log('');
  log('=== Recovery Summary ===');
  log(`  Revived (resumed): ${revived}`);
  log(`  TODOs reset to pending: ${reset}`);
  log(`  Skipped (already complete): ${skipped}`);
  log(`  Remaining candidates: ${candidates.length - revived - skipped}`);
}

main().catch(err => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
