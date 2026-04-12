/**
 * Shared helper to build persistent monitor revival prompts.
 * Used by hourly-automation.js and crash-loop-resume.js.
 *
 * @module lib/persistent-monitor-revival-prompt
 */

import { buildRevivalContext } from './persistent-revival-context.js';
import { buildPersistentMonitorDemoInstructions } from './persistent-monitor-demo-instructions.js';

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
  try {
    const taskMeta = task.metadata ? JSON.parse(task.metadata) : {};
    if (taskMeta.demo_involved) {
      demoInstructions = buildPersistentMonitorDemoInstructions();
    }
    if (taskMeta.strict_infra_guidance === true) {
      const { buildPersistentMonitorStrictInfraInstructions: buildStrictInfra } = await import('./persistent-monitor-strict-infra-instructions.js');
      strictInfraInstructions = buildStrictInfra();
    }
  } catch (err) {
    process.stderr.write(`[persistent-monitor-revival-prompt] demo/strict-infra instructions failed for ${task.id}: ${err.message || err}\n`);
  }

  const prompt = `[Automation][persistent-monitor][AGENT:{AGENT_ID}]

## Persistent Task: ${task.title}

Your previous monitor session died. Here is your last known state:
${revivalContext || '(no prior state available — this may be the first revival)'}

Read full task details to fill any gaps:
mcp__persistent-task__get_persistent_task({ id: "${task.id}", include_amendments: true, include_subtasks: true })
${demoInstructions}${strictInfraInstructions}`;

  const extraEnv = {
    GENTYR_PERSISTENT_TASK_ID: task.id,
    GENTYR_PERSISTENT_MONITOR: 'true',
  };

  const metadata = {
    persistentTaskId: task.id,
    revivalReason,
  };

  return { prompt, extraEnv, metadata };
}
