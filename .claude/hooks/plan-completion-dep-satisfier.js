#!/usr/bin/env node
/**
 * PostToolUse Hook: cross-entity dependency satisfier for
 * mcp__plan-orchestrator__update_plan_status when a plan reaches a
 * satisfying terminal state ('signed_off' or 'completed').
 *
 * Lets downstream tasks declare "blocked by the whole plan finishing" and
 * auto-fire once the plan is signed off.
 *
 * Fires alongside plan-activation-spawner.js (registered on the same matcher).
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
    if (toolName !== 'mcp__plan-orchestrator__update_plan_status') {
      process.exit(0);
    }

    const args = hookInput.tool_input || {};
    const status = args.status;
    if (status !== 'signed_off' && status !== 'completed') {
      process.exit(0);
    }

    const planId = args.plan_id;
    if (!planId) {
      process.exit(0);
    }

    const { satisfyAndCascade } = await import('./lib/cross-dep-satisfier.js');
    await satisfyAndCascade({
      entity_type: 'plan',
      entity_id: planId,
      completedBy: 'plan-completion-dep-satisfier',
    });
  } catch (err) {
    process.stderr.write(`[plan-completion-dep-satisfier] ${err.message}\n`);
  }
  process.exit(0);
});
