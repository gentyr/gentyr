#!/usr/bin/env node
/**
 * Alignment Monitor Briefing — PostToolUse Hook
 *
 * Injects cycle status and alignment reminders for the global deputy-CTO monitor.
 * Full briefing every 5 tool calls; compact one-liner on intermediate calls.
 *
 * Keyed by: GENTYR_DEPUTY_CTO_MONITOR=true env var.
 *
 * @version 1.0.0
 */

// Fast exit for non-monitor sessions
if (process.env.GENTYR_DEPUTY_CTO_MONITOR !== 'true') {
  console.log(JSON.stringify({}));
  process.exit(0);
}

import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Track tool call count via a state file (survives across tool calls within a session)
const STATE_FILE = path.join(PROJECT_DIR, '.claude', 'state', 'alignment-monitor-cycle.json');

function readCycleCount() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return data.toolCallCount || 0;
  } catch { return 0; }
}

function writeCycleCount(count) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ toolCallCount: count }));
  } catch { /* non-fatal */ }
}

async function main() {
  // Read stdin (required for PostToolUse)
  let rawInput = '';
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  const toolCallCount = readCycleCount() + 1;
  writeCycleCount(toolCallCount);

  const isFullBriefing = toolCallCount % 5 === 0;

  if (!isFullBriefing) {
    // Compact briefing
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[GLOBAL MONITOR] Tool call ${toolCallCount}. Primary mission: verify CTO intent BEFORE code is written, not after. Spawn user-alignment checks for unchecked work items.`,
      },
    }));
    process.exit(0);
  }

  // Full briefing — gather stats
  let runningCount = 0;
  let pendingAuditCount = 0;

  try {
    const Database = (await import('better-sqlite3')).default;

    // Count running sessions
    const queueDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
    if (fs.existsSync(queueDbPath)) {
      const qDb = new Database(queueDbPath, { readonly: true });
      runningCount = (qDb.prepare("SELECT COUNT(*) as c FROM queue_items WHERE status IN ('running','spawning')").get()).c;
      qDb.close();
    }

    // Count pending_audit tasks
    const todoDbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
    if (fs.existsSync(todoDbPath)) {
      const tDb = new Database(todoDbPath, { readonly: true });
      try {
        pendingAuditCount += (tDb.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'pending_audit'").get()).c;
      } catch { /* column may not exist */ }
      tDb.close();
    }

    // Count pending_audit persistent tasks
    const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
    if (fs.existsSync(ptDbPath)) {
      const pDb = new Database(ptDbPath, { readonly: true });
      try {
        pendingAuditCount += (pDb.prepare("SELECT COUNT(*) as c FROM persistent_tasks WHERE status = 'pending_audit'").get()).c;
      } catch { /* column may not exist */ }
      pDb.close();
    }
  } catch { /* non-fatal — show what we have */ }

  const fullContext = `[GLOBAL MONITOR — FULL BRIEFING]

Tool call: ${toolCallCount}
Active agents: ${runningCount}
Pending audits: ${pendingAuditCount}${pendingAuditCount > 0 ? ' ⚠️ CHECK FOR STUCK AUDITORS' : ''}

## Cycle Checklist
1. Read latest project super-summary: mcp__session-activity__list_project_summaries({ limit: 1 })
2. Enumerate active work: mcp__todo-db__list_tasks({ status: 'in_progress' }) + mcp__persistent-task__list_persistent_tasks({ status: 'active' })
3. For unchecked items: search_user_prompts for CTO intent, spawn user-alignment if drift suspected
4. Check completed alignment sub-agents from prior cycles — act on misalignments
5. Zombie detection: sessions >2h with no activity → kill_session
6. Audit gate: tasks in pending_audit >10 min → auditor may have died

## Primary Mission
Verify CTO intent BEFORE code is written. Frame directives as POSITIVE instructions with exact MCP tool calls — never as prohibitions.`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: fullContext,
    },
  }));
}

main().catch(() => {
  console.log(JSON.stringify({}));
});
