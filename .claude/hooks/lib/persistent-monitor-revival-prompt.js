/**
 * Shared helper to build persistent monitor revival prompts.
 * Used by hourly-automation.js and crash-loop-resume.js.
 *
 * @module lib/persistent-monitor-revival-prompt
 */

import fs from 'fs';
import path from 'path';
import { buildRevivalContext } from './persistent-revival-context.js';
import { buildPersistentMonitorDemoInstructions } from './persistent-monitor-demo-instructions.js';
import { getBypassResolutionContext } from './bypass-guard.js';

// Lazy-load Database — only needed for self-heal section
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (_) { /* non-fatal */ }

/**
 * Build a full revival prompt for a persistent task monitor.
 *
 * @param {object} task  - Row from persistent_tasks (id, title, metadata, monitor_session_id)
 * @param {string} revivalReason - Reason string stored in queue metadata
 * @param {string} projectDir - Project directory path
 * @returns {Promise<{ prompt: string, extraEnv: object, metadata: object }>}
 */
export async function buildPersistentMonitorRevivalPrompt(task, revivalReason, projectDir) {
  let revivalContext = '';
  try {
    revivalContext = buildRevivalContext(task.id, projectDir, { monitorSessionId: task.monitor_session_id });
  } catch (err) {
    process.stderr.write(`[persistent-monitor-revival-prompt] buildRevivalContext failed for ${task.id}: ${err.message || err}\n`);
  }

  let demoInstructions = '';
  let strictInfraInstructions = '';
  let planSection = '';
  let planId = null;
  let releaseId = null;
  try {
    const taskMeta = task.metadata ? JSON.parse(task.metadata) : {};
    if (taskMeta.demo_involved) {
      demoInstructions = buildPersistentMonitorDemoInstructions();
    }
    if (taskMeta.strict_infra_guidance === true) {
      const { buildPersistentMonitorStrictInfraInstructions: buildStrictInfra } = await import('./persistent-monitor-strict-infra-instructions.js');
      strictInfraInstructions = buildStrictInfra();
    }
    if (taskMeta.plan_id) {
      planId = taskMeta.plan_id;
      planSection = `\nYou are a PLAN MANAGER for plan "${taskMeta.plan_title || planId}" (ID: ${planId}).
Follow the plan-manager agent instructions. Poll get_spawn_ready_tasks, create persistent tasks for ready plan steps, monitor them, and advance the plan until all phases complete.\n`;
    }
    if (taskMeta.releaseId) {
      releaseId = taskMeta.releaseId;
    }
  } catch (err) {
    process.stderr.write(`[persistent-monitor-revival-prompt] demo/strict-infra instructions failed for ${task.id}: ${err.message || err}\n`);
  }

  // Check for resolved bypass request context
  let bypassSection = '';
  try {
    const bypassCtx = getBypassResolutionContext('persistent', task.id);
    if (bypassCtx) {
      const decisionLabel = bypassCtx.decision === 'approved' ? 'APPROVED' : 'REJECTED';
      bypassSection = `\n## CTO Bypass Resolution
Your previous session submitted a bypass request:
  Category: ${bypassCtx.category}
  Summary: ${bypassCtx.summary}

CTO Decision: ${decisionLabel}
CTO Instructions: "${bypassCtx.context}"

${bypassCtx.decision === 'approved' ? 'Proceed with the work, following the CTO\'s instructions above.' : 'The CTO rejected your request. Take an alternative approach or wrap up without the bypassed action.'}
`;
    }
  } catch (_) { /* non-fatal */ }

  // Check for active self-healing fix tasks
  let selfHealSection = '';
  try {
    if (Database) {
      const ptDbPath2 = path.join(projectDir, '.claude', 'state', 'persistent-tasks.db');
      if (fs.existsSync(ptDbPath2)) {
        const ptDb = new Database(ptDbPath2, { readonly: true });
        ptDb.pragma('busy_timeout = 3000');
        try {
          const tableExists = ptDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blocker_diagnosis'").get();
          if (tableExists) {
            const activeBlockers = ptDb.prepare(
              "SELECT error_type, fix_attempts, max_fix_attempts, fix_task_ids, status, diagnosis_details FROM blocker_diagnosis WHERE persistent_task_id = ? AND status IN ('active', 'fix_in_progress', 'cooling_down') ORDER BY created_at DESC LIMIT 3"
            ).all(task.id);
            if (activeBlockers.length > 0) {
              const lines = activeBlockers.map(b => {
                let details;
                try { details = JSON.parse(b.diagnosis_details); } catch { details = {}; }
                return `- ${b.error_type} [${b.status}]: ${b.fix_attempts}/${b.max_fix_attempts} fix attempts. ${details.sample_error || ''}${b.fix_task_ids ? ` Fix tasks: ${b.fix_task_ids}` : ''}`;
              });
              selfHealSection = `\n## Active Self-Healing\n${lines.join('\n')}\n\nCheck fix task status before retrying blocked operations. If fixes were applied, verify they resolved the issue.\n`;
            }
          }
        } catch (_) { /* non-fatal */ }
        ptDb.close();
      }
    }
  } catch (_) { /* non-fatal */ }

  const prompt = `[Automation][persistent-monitor][AGENT:{AGENT_ID}]

## Persistent Task: ${task.title}
${planSection}
Your previous monitor session died. Here is your last known state:
${revivalContext || '(no prior state available — this may be the first revival)'}
${bypassSection}${selfHealSection}
CRITICAL: You are an ORCHESTRATOR, not an implementer. Never edit files, read source code, or execute sub-tasks directly. Spawn existing pending sub-tasks via force_spawn_tasks. Create new sub-tasks via create_task. All implementation goes through the task queue.

Read full task details to fill any gaps:
mcp__persistent-task__get_persistent_task({ id: "${task.id}", include_amendments: true, include_subtasks: true })
${demoInstructions}${strictInfraInstructions}`;

  const extraEnv = {
    GENTYR_PERSISTENT_TASK_ID: task.id,
    GENTYR_PERSISTENT_MONITOR: 'true',
  };

  // Preserve plan-manager env vars if this is a plan-manager persistent task
  if (planId) {
    extraEnv.GENTYR_PLAN_MANAGER = 'true';
    extraEnv.GENTYR_PLAN_ID = planId;
  }

  // Preserve release ID env var if this task is part of a release
  if (releaseId) {
    extraEnv.GENTYR_RELEASE_ID = releaseId;
  }

  const metadata = {
    persistentTaskId: task.id,
    revivalReason,
  };
  // Include planId so plan-level dedup in enqueueSession/requeueDeadPersistentMonitor can
  // detect duplicate monitors for the same plan across different persistentTaskId values
  if (planId) {
    metadata.planId = planId;
    if (task.title && task.title.startsWith('Plan Manager:')) {
      metadata.isPlanManager = true;
    }
  }
  if (releaseId) metadata.releaseId = releaseId;

  const agent = planId ? 'plan-manager' : 'persistent-monitor';

  return { prompt, extraEnv, metadata, agent };
}
