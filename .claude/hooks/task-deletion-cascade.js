#!/usr/bin/env node
/**
 * PostToolUse Hook: Task Deletion Cascade
 *
 * When a task is deleted via delete_task, cascade-kills all running sessions
 * linked to that task. Prevents zombie sessions from continuing work on
 * deleted tasks.
 *
 * Fires on: mcp__todo-db__delete_task
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 *
 * @version 1.0.0
 */

import { cancelSessionsByTaskId } from './lib/session-queue.js';

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let event;
  try { event = JSON.parse(input); } catch { process.exit(0); }

  const response = event?.tool_response;
  if (!response) { process.exit(0); }

  // Parse the response — could be string, object, or MCP content array
  let parsed;
  try {
    if (typeof response === 'string') {
      parsed = JSON.parse(response);
    } else if (Array.isArray(response)) {
      // Bare content array: [{ type: 'text', text: '...' }]
      for (const block of response) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parsed = JSON.parse(block.text);
          break;
        }
      }
    } else if (response && typeof response === 'object' && Array.isArray(response.content)) {
      // MCP content array: { content: [{ type: 'text', text: '...' }] }
      for (const block of response.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parsed = JSON.parse(block.text);
          break;
        }
      }
    } else if (response && typeof response === 'object') {
      parsed = response;
    }
  } catch { process.exit(0); }

  if (!parsed?.deleted || !parsed?.id) { process.exit(0); }

  const taskId = parsed.id;
  const reason = parsed.deletion_reason || 'task deleted';

  try {
    const results = cancelSessionsByTaskId(taskId, `Task deleted: ${reason}`);
    if (results.length > 0) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `Cascade: ${results.length} session(s) terminated for deleted task ${taskId}: ${results.map(r => `${r.id} (${r.action})`).join(', ')}`,
        },
      }));
    }
  } catch (err) {
    // Non-fatal — task deletion should not be blocked by cascade failure
    process.stderr.write(`[task-deletion-cascade] Warning: ${err.message}\n`);
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
