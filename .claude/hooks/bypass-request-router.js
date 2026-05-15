#!/usr/bin/env node
/**
 * Bypass Request Router
 *
 * PostToolUse hook on mcp__agent-tracker__submit_bypass_request.
 * Routes new bypass requests to the Global Deputy-CTO Monitor (if active)
 * via a directive signal, giving the monitor a 5-minute window to handle
 * the request before the CTO sees it.
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import { debugLog } from './lib/debug-log.js';
import { auditEvent } from './lib/session-audit.js';
import { sendSignal } from './lib/session-signals.js';

let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (_) {
  console.log(JSON.stringify({}));
  process.exit(0);
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PT_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
const QUEUE_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');

const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'session-queue.log');
function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [bypass-request-router] ${message}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) { /* non-fatal */ }
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => { data += line; });
    rl.on('close', () => { resolve(data); });
    setTimeout(() => { rl.close(); resolve(data); }, 200);
  });
}

/**
 * Find the active global monitor's agent ID and verify it's alive.
 * Returns { agentId, taskId } or null if not active.
 */
function findActiveGlobalMonitor() {
  if (!Database || !fs.existsSync(PT_DB_PATH)) return null;

  let ptDb;
  try {
    ptDb = new Database(PT_DB_PATH, { readonly: true });
    ptDb.pragma('busy_timeout = 1000');
    const task = ptDb.prepare(
      "SELECT id, status, monitor_agent_id, monitor_pid FROM persistent_tasks WHERE metadata LIKE '%\"task_type\":\"global_monitor\"%' LIMIT 1"
    ).get();
    ptDb.close();
    ptDb = null;

    if (!task || task.status !== 'active' || !task.monitor_agent_id) return null;

    // Verify PID is alive
    if (task.monitor_pid) {
      try { process.kill(task.monitor_pid, 0); } catch (_) { return null; }
    }

    // Cross-check session queue for a running session
    if (fs.existsSync(QUEUE_DB_PATH)) {
      let qDb;
      try {
        qDb = new Database(QUEUE_DB_PATH, { readonly: true });
        qDb.pragma('busy_timeout = 1000');
        const queueItem = qDb.prepare(
          "SELECT id, status FROM queue_items WHERE json_extract(metadata, '$.persistentTaskId') = ? AND status IN ('running', 'spawning') LIMIT 1"
        ).get(task.id);
        qDb.close();
        qDb = null;
        if (!queueItem) return null;
      } catch (_) {
        try { qDb?.close(); } catch (_e) { /* */ }
        // Fail-open: if we can't check the queue, trust the PID check
      }
    }

    return { agentId: task.monitor_agent_id, taskId: task.id };
  } catch (_) {
    try { ptDb?.close(); } catch (_e) { /* */ }
    return null;
  }
}

async function main() {
  const stdinData = await readStdin();
  if (!stdinData) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  let input;
  try {
    input = JSON.parse(stdinData);
  } catch (_) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  const toolResponse = input.tool_response || input.result;
  if (!toolResponse) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  let responseData = null;

  // Format 1: MCP content wrapper
  if (toolResponse && typeof toolResponse === 'object' && Array.isArray(toolResponse.content)) {
    for (const block of toolResponse.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try { responseData = JSON.parse(block.text); break; } catch (_) { /* */ }
      }
    }
  }

  // Format 2: Bare content array
  if (!responseData && Array.isArray(toolResponse)) {
    for (const block of toolResponse) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try { responseData = JSON.parse(block.text); break; } catch (_) { /* */ }
      }
    }
  }

  // Format 3: Plain string
  if (!responseData && typeof toolResponse === 'string') {
    try { responseData = JSON.parse(toolResponse); } catch (_) { /* */ }
  }

  // Format 4: Plain object
  if (!responseData && toolResponse && typeof toolResponse === 'object' && !Array.isArray(toolResponse) && (toolResponse.status || toolResponse.bypass_request_id)) {
    responseData = toolResponse;
  }

  if (!responseData || !responseData.bypass_request_id || responseData.status !== 'pending') {
    // Not a successful bypass request submission — exit silently
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  // Timed auto-resume pauses resolve autonomously — no CTO or monitor routing needed
  if (responseData.auto_resume_at) {
    log(`Bypass request ${responseData.bypass_request_id}: timed pause (auto_resume_at: ${responseData.auto_resume_at}) — skipping monitor signal`);
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  // Check if global monitor is active
  const monitor = findActiveGlobalMonitor();
  if (!monitor) {
    log(`Bypass request ${responseData.bypass_request_id}: no active global monitor — CTO sees immediately`);
    debugLog('bypass-request-router', 'no_active_monitor', { requestId: responseData.bypass_request_id });
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  // Send directive signal to the monitor
  try {
    sendSignal({
      fromAgentId: process.env.CLAUDE_AGENT_ID || 'bypass-request-router',
      fromAgentType: 'hook',
      fromTaskTitle: responseData.task_title || '',
      toAgentId: monitor.agentId,
      toAgentType: 'deputy-cto-monitor',
      tier: 'directive',
      type: 'BYPASS_REQUEST',
      message: [
        `NEW BYPASS REQUEST requiring your triage (you have ~5 minutes before the CTO sees it):`,
        ``,
        `  Request ID: ${responseData.bypass_request_id}`,
        `  Task: "${responseData.task_title}" (${responseData.task_type})`,
        `  Category: ${responseData.category || 'general'}`,
        `  Summary: ${responseData.summary || 'No summary provided'}`,
        ``,
        `Actions:`,
        `  - If you can decide: deputy_resolve_bypass_request({ request_id: "${responseData.bypass_request_id}", decision: "approved"|"rejected", reasoning: "..." })`,
        `  - If CTO must decide: deputy_escalate_to_cto({ request_id: "${responseData.bypass_request_id}", reason: "...", urgency: "normal"|"high"|"critical" })`,
      ].join('\n'),
      metadata: {
        bypass_request_id: responseData.bypass_request_id,
        task_type: responseData.task_type,
        task_id: responseData.task_id,
        task_title: responseData.task_title,
        category: responseData.category,
      },
      projectDir: PROJECT_DIR,
    });

    log(`Bypass request ${responseData.bypass_request_id} routed to global monitor (agent: ${monitor.agentId})`);
    try { auditEvent('bypass_request_routed_to_monitor', { bypass_request_id: responseData.bypass_request_id, monitor_agent_id: monitor.agentId }); } catch (_) { /* non-fatal */ }
  } catch (err) {
    log(`Failed to route bypass request ${responseData.bypass_request_id} to monitor: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(JSON.stringify({}));
}

main().catch(() => {
  console.log(JSON.stringify({}));
  process.exit(0);
});
