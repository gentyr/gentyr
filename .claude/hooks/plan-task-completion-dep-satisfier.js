#!/usr/bin/env node
/**
 * PostToolUse Hook: cross-entity dependency satisfier for
 * mcp__plan-orchestrator__update_task_progress when status transitions
 * to 'completed' (or 'skipped' — also a satisfying terminal state).
 *
 * Fires alongside plan-audit-spawner.js (registered on the same matcher).
 *
 * Must exit 0.
 *
 * @version 1.0.0
 */

let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || '';
    if (toolName !== 'mcp__plan-orchestrator__update_task_progress') {
      process.exit(0);
    }

    const args = hookInput.tool_input || {};
    const status = args.status;
    if (status !== 'completed' && status !== 'skipped') {
      // Only completion / skip triggers dep satisfaction.
      process.exit(0);
    }

    const taskId = args.task_id;
    if (!taskId) {
      process.exit(0);
    }

    const { satisfyAndCascade } = await import('./lib/cross-dep-satisfier.js');
    await satisfyAndCascade({
      entity_type: 'plan_task',
      entity_id: taskId,
      completedBy: 'plan-task-completion-dep-satisfier',
    });
  } catch (err) {
    process.stderr.write(`[plan-task-completion-dep-satisfier] ${err.message}\n`);
  }
  process.exit(0);
});
