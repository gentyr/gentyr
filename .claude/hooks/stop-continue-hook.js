#!/usr/bin/env node

/**
 * Stop Hook - Auto-continue for automated [Task] sessions
 *
 * This hook forces one continuation cycle for spawned sessions that begin with "[Task]".
 * It checks:
 * 1. Was the initial prompt tagged with "[Task]"? (automated session)
 * 2. Is stop_hook_active false? (first stop, not already continuing)
 */

import { createInterface } from 'readline';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { debugLog as gentyrDebugLog } from './lib/debug-log.js';

// Lazy-loaded SQLite (needed for persistent-tasks.db check)
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (_) {
  // Non-fatal: persistent monitor check will fail open
}

// Debug logging - writes to file since stdout is used for hook response
const DEBUG = true;
const DEBUG_LOG_PATH = path.join(process.cwd(), '.claude', 'hooks', 'stop-hook-debug.log');

function debugLog(message, data = null) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString();
  let logLine = `[${timestamp}] ${message}`;
  if (data !== null) {
    logLine += '\n' + JSON.stringify(data, null, 2);
  }
  logLine += '\n---\n';
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, logLine);
  } catch (err) {
    // Ignore write errors
  }
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => { data += line; });
    rl.on('close', () => { resolve(data); });
    // Timeout after 100ms if no data
    setTimeout(() => { rl.close(); resolve(data); }, 100);
  });
}

const TAIL_BYTES = 8192;

/**
 * Read the last N bytes of a file (seek to end, no full-file read).
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
  } catch (_) { /* cleanup - failure expected */
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}


async function main() {
  debugLog('Stop hook triggered');

  try {
    const stdinData = await readStdin();

    debugLog('Raw stdin data', stdinData ? stdinData.substring(0, 2000) : '(empty)');

    if (!stdinData) {
      // No input, allow stop
      debugLog('No stdin data, allowing stop');
      console.log(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
    }

    const input = JSON.parse(stdinData);

    debugLog('Parsed input keys', Object.keys(input));
    debugLog('Full input structure', input);

    // Check if this session was preempted (suspended by CTO priority preemption).
    // A suspended session should exit cleanly without attempting revival,
    // as it will be re-enqueued automatically.
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const suspendedPath = path.join(projectDir, '.claude', 'state', 'suspended-sessions.json');
    try {
      const data = JSON.parse(fs.readFileSync(suspendedPath, 'utf8'));
      const entries = Array.isArray(data) ? data : [data];
      const sessionId = input.session_id;
      const isSuspended = entries.some(
        e => (sessionId && e.sessionId === sessionId) ||
             (process.env.CLAUDE_AGENT_ID && e.agentId === process.env.CLAUDE_AGENT_ID)
      );
      if (isSuspended) {
        debugLog('Session is suspended (preempted) — exiting cleanly without revival');
        // Remove this entry from the file
        const remaining = entries.filter(
          e => !(sessionId && e.sessionId === sessionId) &&
               !(process.env.CLAUDE_AGENT_ID && e.agentId === process.env.CLAUDE_AGENT_ID)
        );
        if (remaining.length === 0) {
          fs.unlinkSync(suspendedPath);
        } else {
          fs.writeFileSync(suspendedPath, JSON.stringify(remaining, null, 2));
        }
        // Exit cleanly — don't attempt revival
        gentyrDebugLog('stop-hook', 'decision', { decision: 'approve', reason: 'suspended_session', isTask: false, isPersistent: !!process.env.GENTYR_PERSISTENT_MONITOR });
        console.log(JSON.stringify({ decision: 'approve' }));
        process.exit(0);
      }
    } catch (e) {
      // File doesn't exist (ENOENT) or JSON parse error — not suspended, continue normally
      if (e.code !== 'ENOENT') {
        debugLog('suspended-sessions.json read error (non-fatal)', { error: e.message });
      }
    }

    // Plan manager completion gate — must run before the generic persistent monitor check
    if (process.env.GENTYR_PLAN_MANAGER === 'true' && process.env.GENTYR_PLAN_ID) {
      const planId = process.env.GENTYR_PLAN_ID;
      debugLog('Plan manager session detected', { planId });

      try {
        const planDbPath = path.join(projectDir, '.claude', 'state', 'plans.db');
        if (Database && fs.existsSync(planDbPath)) {
          const planDb = new Database(planDbPath, { readonly: true });
          const plan = planDb.prepare('SELECT status FROM plans WHERE id = ?').get(planId);

          if (plan && plan.status === 'active') {
            const incompleteTasks = planDb.prepare(
              "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ? AND status NOT IN ('completed', 'skipped')"
            ).get(planId);
            planDb.close();

            if (incompleteTasks?.count > 0) {
              // Escape hatch: if the plan manager's persistent task is paused, allow exit
              // This prevents the pressure loop that forces agents to skip tasks
              const ptTaskId = process.env.GENTYR_PERSISTENT_TASK_ID;
              if (ptTaskId) {
                try {
                  const ptDbPath = path.join(projectDir, '.claude', 'state', 'persistent-tasks.db');
                  if (fs.existsSync(ptDbPath)) {
                    const ptDb = new Database(ptDbPath, { readonly: true });
                    const ptRow = ptDb.prepare('SELECT status FROM persistent_tasks WHERE id = ?').get(ptTaskId);
                    ptDb.close();
                    if (ptRow && (ptRow.status === 'paused' || ptRow.status === 'completed' || ptRow.status === 'cancelled')) {
                      debugLog('Decision: APPROVE (plan manager escape hatch — persistent task is ' + ptRow.status + ')', { ptTaskId });
                      gentyrDebugLog('stop-hook', 'decision', { decision: 'approve', reason: 'plan_manager_escape_hatch', ptStatus: ptRow.status });
                      console.log(JSON.stringify({ decision: 'approve' }));
                      process.exit(0);
                    }
                  }
                } catch (e) {
                  debugLog('persistent-tasks.db check in plan gate escape hatch (non-fatal)', { error: e.message });
                  // Fail open on this check — fall through to blocking
                }
              }

              debugLog('Decision: BLOCK (plan manager — incomplete plan tasks)', { count: incompleteTasks.count });
              gentyrDebugLog('stop-hook', 'decision', { decision: 'block', reason: 'plan_manager_incomplete', isTask: true, isPersistent: true });
              console.log(JSON.stringify({
                decision: 'block',
                reason: `[PLAN MANAGER] Plan has ${incompleteTasks.count} incomplete task(s). Continue executing the plan by spawning persistent tasks for each ready plan task. If blocked by an external dependency that requires CTO intervention, submit a bypass request via mcp__agent-tracker__submit_bypass_request (this auto-pauses your task, propagates to the plan, and notifies the CTO), then call summarize_work and stop. Do NOT skip tasks to escape this gate.`,
              }));
              process.exit(0);
            }
          } else {
            planDb.close();
          }
        }
      } catch (e) {
        debugLog('plans.db read error in plan manager gate (non-fatal)', { error: e.message });
        // Fail open — let the persistent monitor check handle it
      }
    }

    // Persistent monitor sessions: check if task is still active
    if (process.env.GENTYR_PERSISTENT_MONITOR === 'true') {
      const ptTaskId = process.env.GENTYR_PERSISTENT_TASK_ID;
      debugLog('Persistent monitor session detected', { taskId: ptTaskId });

      let taskStillActive = true;
      let ptStatus = 'active';
      try {
        const ptDbPath = path.join(projectDir, '.claude', 'state', 'persistent-tasks.db');
        if (Database && fs.existsSync(ptDbPath)) {
          const ptDb = new Database(ptDbPath, { readonly: true });
          const row = ptDb.prepare("SELECT status FROM persistent_tasks WHERE id = ?").get(ptTaskId);
          ptDb.close();
          ptStatus = row?.status ?? 'active';
          taskStillActive = ptStatus === 'active' || ptStatus === 'pending_audit';
        }
      } catch (e) {
        debugLog('persistent-tasks.db read error (non-fatal)', { error: e.message });
        // Fail open — assume active
      }

      if (taskStillActive) {
        const blockReason = ptStatus === 'pending_audit'
          ? '[AUDIT IN FLIGHT] Your persistent task is in pending_audit — an independent auditor is verifying your work. Wait for the verdict. Poll mcp__persistent-task__check_pt_audit({ id: "' + ptTaskId + '" }) every 30s. If pass → exit. If fail → address the failure.'
          : '[PERSISTENT MONITOR] Your persistent task is still active. Continue monitoring sub-tasks. Call mcp__persistent-task__complete_persistent_task when the outcome criteria are met, or mcp__persistent-task__pause_persistent_task if you need to pause.';
        debugLog('Decision: BLOCK (persistent task monitor — task still active)');
        gentyrDebugLog('stop-hook', 'decision', { decision: 'block', reason: 'persistent_monitor_active', isTask: true, isPersistent: true });
        console.log(JSON.stringify({
          decision: 'block',
          reason: blockReason,
        }));
        process.exit(0);
      }

      debugLog('Decision: APPROVE (persistent task no longer active)');
      gentyrDebugLog('stop-hook', 'decision', { decision: 'approve', reason: 'persistent_task_inactive', isTask: true, isPersistent: true });
      console.log(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
    }

    // Check if this is an automated [Task] session
    // The initial prompt should be in the conversation history
    const isTaskSession = checkIfTaskSession(input);

    // Check if we're already in a continuation cycle
    const alreadyContinuing = input.stop_hook_active === true;

    debugLog('Decision factors', {
      isTaskSession,
      alreadyContinuing,
      stop_hook_active: input.stop_hook_active,
      CLAUDE_SPAWNED_SESSION: process.env.CLAUDE_SPAWNED_SESSION
    });

    if (isTaskSession && !alreadyContinuing) {
      // Session completion gate for worktree agents:
      // Block if the worktree still exists (project-manager hasn't cleaned it up yet).
      if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
        const cwd = process.cwd();
        const worktreeActive = cwd.includes('.claude/worktrees/') ||
          cwd.includes('.claude\\worktrees\\');

        if (worktreeActive && fs.existsSync(cwd)) {
          // Worktree still exists — verify the agent ran the required sub-agents
          // by scanning the transcript tail for agent spawn markers.
          let alignmentFound = false;
          let projectManagerFound = false;
          const transcriptPath = input.transcript_path || null;

          if (transcriptPath) {
            const tail = readTail(transcriptPath, TAIL_BYTES);
            if (tail) {
              alignmentFound = tail.includes('"user-alignment"') ||
                tail.includes('[AGENT:user-alignment');
              projectManagerFound = tail.includes('"project-manager"') ||
                tail.includes('[AGENT:project-manager');
            }
          }

          if (!alignmentFound || !projectManagerFound) {
            const missingAgents = [];
            if (!alignmentFound) missingAgents.push('user-alignment');
            if (!projectManagerFound) missingAgents.push('project-manager');

            debugLog('Decision: BLOCK (session completion gate — missing sub-agents)', {
              missingAgents,
              worktree: cwd,
            });
            console.log(JSON.stringify({
              decision: 'block',
              reason: `[SESSION COMPLETION GATE] Your worktree still exists and the following required sub-agents have NOT been run: ${missingAgents.join(', ')}. You MUST: (1) Spawn the user-alignment agent to verify your work aligns with CTO intent. (2) Spawn the project-manager agent to commit, push, create PR, merge, and clean up the worktree. Do NOT call summarize_work or complete_task until both agents have completed and the worktree has been removed.`,
            }));
            process.exit(0);
          }

          // Both agents found but worktree still exists — project-manager may still be running.
          debugLog('Decision: BLOCK (session completion gate — worktree exists after sub-agents)', {
            worktree: cwd,
          });
          console.log(JSON.stringify({
            decision: 'block',
            reason: '[SESSION COMPLETION GATE] Your worktree still exists. The project-manager must have completed its PR merge and worktree cleanup before your session can end. Verify the project-manager finished successfully, then call summarize_work and complete_task.',
          }));
          process.exit(0);
        }
      }

      // First stop of a [Task] session - force one continuation
      // Check if in a worktree with uncommitted changes
      let uncommittedInWorktree = false;
      try {
        const cwd = process.cwd();
        const gitPath = path.join(cwd, '.git');
        const stat = fs.lstatSync(gitPath);
        if (stat.isFile()) {
          // We're in a worktree — check for uncommitted changes
          const status = execFileSync('git', ['status', '--porcelain'], {
            cwd,
            encoding: 'utf8',
            timeout: 5000,
            stdio: 'pipe',
          }).trim();
          uncommittedInWorktree = status.length > 0;
        }
      } catch (err) {
        console.error('[stop-continue-hook] Warning:', err.message);
        // Not in a worktree or git status failed — ignore
      }

      let reason;
      if (uncommittedInWorktree) {
        reason = 'You have UNCOMMITTED CHANGES in your worktree. You MUST spawn Task(subagent_type=\'project-manager\') to commit, push, and merge your work before stopping.';
      } else {
        reason = 'If there is more work to investigate or resolve related to the initial [Task] request, continue working. Otherwise, you may stop.';
      }
      debugLog('Decision: BLOCK (first stop of [Task] session)', { uncommittedInWorktree });
      gentyrDebugLog('stop-hook', 'decision', { decision: 'block', reason: uncommittedInWorktree ? 'uncommitted_changes' : 'first_task_stop', isTask: true, isPersistent: !!process.env.GENTYR_PERSISTENT_MONITOR });
      console.log(JSON.stringify({
        decision: 'block',
        reason,
      }));
    } else {
      // Either not a [Task] session, or already continued once - allow stop
      debugLog('Decision: APPROVE', { reason: isTaskSession ? 'already continued once' : 'not a [Task] session' });
      gentyrDebugLog('stop-hook', 'decision', { decision: 'approve', reason: isTaskSession ? 'already_continued' : 'not_task_session', isTask: isTaskSession, isPersistent: !!process.env.GENTYR_PERSISTENT_MONITOR });
      console.log(JSON.stringify({ decision: 'approve' }));
    }

    process.exit(0);
  } catch (err) {
    // On error, allow stop (fail open)
    debugLog('Error in hook', { error: err.message, stack: err.stack });
    console.error(`Stop hook error: ${err.message}`);
    console.log(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
  }
}

/**
 * Check if this session started with a [Task] prefix
 * @param {object} input - Hook input containing conversation context
 * @returns {boolean}
 */
function checkIfTaskSession(input) {
  // The Stop hook only receives: session_id, transcript_path, cwd, permission_mode, hook_event_name, stop_hook_active
  // We need to read the transcript file to find the initial prompt

  // 1. Read first 4KB of transcript file to find first user message (avoid full file read)
  if (input.transcript_path) {
    debugLog('Reading transcript head', input.transcript_path);
    try {
      let fd;
      let transcriptHead;
      try {
        fd = fs.openSync(input.transcript_path, 'r');
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
        transcriptHead = buf.toString('utf8', 0, bytesRead);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      const lines = transcriptHead.split('\n').filter(line => line.trim());

      // JSONL format - each line is a JSON object
      for (const line of lines.slice(0, 10)) { // Check first 10 lines
        try {
          const entry = JSON.parse(line);

          // Look for human/user message type
          if (entry.type === 'human' || entry.type === 'user') {
            const content = entry.message?.content || entry.content || '';
            debugLog('Found user message', content.substring(0, 300));

            if (content.startsWith('[Automation]') || content.startsWith('[Task]')) {
              debugLog('[Automation]/[Task] found in transcript first user message');
              return true;
            }
            // Only check first user message
            break;
          }
        } catch (parseErr) {
          // Skip malformed lines
          continue;
        }
      }
    } catch (err) {
      debugLog('Error reading transcript', { error: err.message });
    }
  }

  // 2. Fallback: Check for CLAUDE_SPAWNED_SESSION env var
  // This is set by hooks when spawning background agents
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    debugLog('[Task] detected via CLAUDE_SPAWNED_SESSION env var');
    return true;
  }

  debugLog('No [Task] marker found');
  return false;
}

main();
