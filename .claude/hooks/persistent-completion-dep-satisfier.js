#!/usr/bin/env node
/**
 * PostToolUse Hook: cross-entity dependency satisfier for
 * mcp__persistent-task__complete_persistent_task.
 *
 * When a persistent task completes successfully, scans workstream.db for
 * active deps where this task is the blocker, marks them satisfied, and
 * cascades unblocks (auto-activates draft persistent tasks, drains todos,
 * promotes plan_tasks).
 *
 * Must exit 0 — PostToolUse hooks cannot block.
 *
 * @version 1.0.0
 */

let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || '';
    if (toolName !== 'mcp__persistent-task__complete_persistent_task') {
      process.exit(0);
    }

    const id = extractEntityId(hookInput);
    if (!id) {
      process.exit(0);
    }

    const { satisfyAndCascade } = await import('./lib/cross-dep-satisfier.js');
    await satisfyAndCascade({
      entity_type: 'persistent',
      entity_id: id,
      completedBy: 'persistent-completion-dep-satisfier',
    });
  } catch (err) {
    process.stderr.write(`[persistent-completion-dep-satisfier] ${err.message}\n`);
  }
  process.exit(0);
});

function extractEntityId(hookInput) {
  // Tool args carry `id`; response may also echo it.
  if (hookInput.tool_input?.id) return hookInput.tool_input.id;

  const response = hookInput.tool_response;
  if (response && typeof response === 'object') {
    if (typeof response.id === 'string') return response.id;
    if (Array.isArray(response.content)) {
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          try {
            const parsed = JSON.parse(block.text);
            if (parsed.id) return parsed.id;
          } catch { /* keep scanning */ }
        }
      }
    }
  }
  if (typeof response === 'string') {
    try {
      const parsed = JSON.parse(response);
      if (parsed.id) return parsed.id;
    } catch { /* nothing to do */ }
  }
  return null;
}
