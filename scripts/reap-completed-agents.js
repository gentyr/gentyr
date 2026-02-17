#!/usr/bin/env node
/**
 * Agent Reaper — Precision process cleanup for completed spawned Claude sessions.
 *
 * Finds agents tracked by agent-tracker that have finished their work
 * (last JSONL line is assistant-only text with no tool_use) and kills them.
 *
 * Safety guarantees:
 *   - Only kills processes whose session file starts with [Task] (automated)
 *   - Only kills processes whose last assistant message has no tool_use blocks
 *   - Never kills interactive (non-[Task]) sessions
 *   - Never kills processes it can't match to a known session file
 *   - Processes that are already dead are simply marked completed
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================================
// Configuration
// ============================================================================

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const HEAD_BYTES = 2000;  // Bytes to read from start of JSONL for agent ID match
const TAIL_BYTES = 4000;  // Bytes to read from end of JSONL for completion check

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Check if a process is alive.
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * Discover the normalized session directory for a project.
 * @param {string} projectDir
 * @returns {string|null}
 */
function getSessionDir(projectDir) {
  const projectPath = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  const sessionDir = path.join(CLAUDE_PROJECTS_DIR, projectPath);
  if (fs.existsSync(sessionDir)) return sessionDir;

  const altPath = path.join(CLAUDE_PROJECTS_DIR, projectPath.replace(/^-/, ''));
  if (fs.existsSync(altPath)) return altPath;

  return null;
}

/**
 * Read the first N bytes of a file using a file descriptor (no full-file read).
 * @param {string} filePath
 * @param {number} numBytes
 * @returns {string}
 */
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

/**
 * Read the last N bytes of a file using a file descriptor (seek to end).
 * @param {string} filePath
 * @param {number} numBytes
 * @returns {string}
 */
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

/**
 * Find the session file that contains a given agent tracking ID
 * by scanning the first bytes of each JSONL file.
 *
 * @param {string} sessionDir - Directory containing JSONL session files
 * @param {string} agentId - The agent ID to search for (e.g. "agent-mlr08lpw-2444b1e0")
 * @returns {string|null} Full path to matching session file, or null
 */
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
    if (head.includes(marker)) {
      return filePath;
    }
  }

  return null;
}

/**
 * Check if a session's last assistant message indicates completion.
 * Completion = last JSON line is type=assistant with text-only content (no tool_use).
 *
 * @param {string} sessionFile - Path to the JSONL session file
 * @returns {boolean}
 */
function isSessionComplete(sessionFile) {
  const tail = readTail(sessionFile, TAIL_BYTES);
  if (!tail) return false;

  // Split into lines and find the last parseable JSON line
  const lines = tail.split('\n').filter(l => l.trim());

  // Work backwards to find the last parseable line
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    // Must be an assistant message
    if (parsed.type !== 'assistant') return false;

    // Check content array for tool_use blocks
    const content = parsed.message?.content;
    if (!Array.isArray(content)) {
      // If content isn't an array, it's text-only — session is complete
      return true;
    }

    // If any content block is tool_use, agent is still working
    const hasToolUse = content.some(c => c.type === 'tool_use');
    return !hasToolUse;
  }

  return false;
}

/**
 * Verify that a session is automated (starts with [Task]) — defense-in-depth.
 *
 * @param {string} sessionFile - Path to the JSONL session file
 * @returns {boolean}
 */
function isAutomatedSession(sessionFile) {
  const head = readHead(sessionFile, HEAD_BYTES);
  return head.includes('[Task]');
}

/**
 * Reap completed automated agents.
 *
 * @param {string} projectDir - The project directory
 * @returns {{ reaped: Array<{agentId: string, pid: number, reason: string}>, skipped: Array<{agentId: string, reason: string}>, errors: Array<{agentId: string, error: string}> }}
 */
export function reapCompletedAgents(projectDir) {
  const result = { reaped: [], skipped: [], errors: [] };

  // Load agent tracker
  const historyPath = path.join(projectDir, '.claude', 'state', 'agent-tracker-history.json');
  let history;
  try {
    if (!fs.existsSync(historyPath)) return result;
    history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  } catch {
    return result;
  }

  if (!Array.isArray(history.agents)) return result;

  // Find the session directory
  const sessionDir = getSessionDir(projectDir);
  if (!sessionDir) return result;

  // Track whether we made any changes
  let dirty = false;

  for (const agent of history.agents) {
    // Only process agents with status=running and a stored PID
    if (agent.status !== 'running' || !agent.pid) continue;

    const agentId = agent.id;
    const pid = agent.pid;

    // Step 1: Check if process is still alive
    if (!isProcessAlive(pid)) {
      agent.status = 'completed';
      agent.reapReason = 'process_already_dead';
      agent.reapedAt = new Date().toISOString();
      dirty = true;
      result.reaped.push({ agentId, pid, reason: 'process_already_dead' });
      continue;
    }

    // Step 2: Discover session file (use cached if available)
    let sessionFile = agent.sessionFile || null;
    if (!sessionFile) {
      sessionFile = findSessionFileByAgentId(sessionDir, agentId);
      if (!sessionFile) {
        result.skipped.push({ agentId, reason: 'session_file_not_found' });
        continue;
      }
      // Cache for future runs
      agent.sessionFile = sessionFile;
      dirty = true;
    }

    // Step 3: Check completion via JSONL
    if (!isSessionComplete(sessionFile)) {
      result.skipped.push({ agentId, reason: 'session_not_complete' });
      continue;
    }

    // Step 4: Verify automated session (defense-in-depth)
    if (!isAutomatedSession(sessionFile)) {
      result.skipped.push({ agentId, reason: 'not_automated_session' });
      continue;
    }

    // Step 5: Kill the process
    try {
      process.kill(pid, 'SIGKILL');
      agent.status = 'reaped';
      agent.reapedAt = new Date().toISOString();
      agent.reapReason = 'session_complete';
      dirty = true;
      result.reaped.push({ agentId, pid, reason: 'session_complete' });
    } catch (err) {
      if (err.code === 'ESRCH') {
        // Already dead between our check and kill
        agent.status = 'completed';
        agent.reapedAt = new Date().toISOString();
        agent.reapReason = 'process_already_dead';
        dirty = true;
        result.reaped.push({ agentId, pid, reason: 'process_already_dead' });
      } else {
        result.errors.push({ agentId, error: `kill failed: ${err.message}` });
      }
    }
  }

  // Write back if changes were made
  if (dirty) {
    try {
      fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
    } catch (err) {
      result.errors.push({ agentId: '_history_write', error: err.message });
    }
  }

  return result;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (process.argv[1] && (
  process.argv[1].endsWith('reap-completed-agents.js') ||
  process.argv[1].endsWith('reap-completed-agents')
)) {
  const projectDir = process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const result = reapCompletedAgents(projectDir);

  if (result.reaped.length > 0) {
    console.log(`Reaped ${result.reaped.length} completed agent(s):`);
    for (const r of result.reaped) {
      console.log(`  ${r.agentId} (PID ${r.pid}): ${r.reason}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log(`Skipped ${result.skipped.length} agent(s):`);
    for (const s of result.skipped) {
      console.log(`  ${s.agentId}: ${s.reason}`);
    }
  }

  if (result.errors.length > 0) {
    console.error(`Errors: ${result.errors.length}`);
    for (const e of result.errors) {
      console.error(`  ${e.agentId}: ${e.error}`);
    }
  }

  if (result.reaped.length === 0 && result.skipped.length === 0) {
    console.log('No agents with tracking data found (expected for pre-tracking agents).');
  }
}
