#!/usr/bin/env node
/**
 * Persistent Task Auto-Linker
 *
 * PostToolUse hook on mcp__todo-db__create_task. When the response includes
 * a persistent_task_id, auto-links the new task as a sub-task in persistent-tasks.db.
 *
 * Response format note: MCP servers always return results wrapped in the MCP
 * content array format: { content: [{ type: 'text', text: JSON.stringify(result) }] }.
 * The linker tries this format first, then falls back to plain object / string.
 * It also checks tool_input.persistent_task_id as a fallback, since create_task
 * may not echo back every input field in all code paths.
 *
 * @version 1.1.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import { debugLog } from './lib/debug-log.js';

let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (err) {
  process.stderr.write(`[persistent-task-linker] Failed to import better-sqlite3: ${err.message}\n`);
  console.log(JSON.stringify({ }));
  process.exit(0);
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PT_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');

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
 * Parse the MCP tool response into a plain object.
 *
 * MCP servers always wrap results in:
 *   { content: [{ type: 'text', text: JSON.stringify(result) }] }
 *
 * But hooks may also receive the unwrapped object directly (e.g. in tests or
 * alternate code paths). Try all known formats and return the first that works.
 *
 * Returns null if parsing fails in all formats.
 */
function parseToolResponse(toolResponse) {
  // Format 1: MCP content array — the standard MCP server response format.
  // Try this first because it is always what a running MCP server sends.
  if (toolResponse && typeof toolResponse === 'object' && Array.isArray(toolResponse.content)) {
    for (const block of toolResponse.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try {
          return JSON.parse(block.text);
        } catch (err) {
          debugLog('persistent-task-linker', 'response_parse_error', {
            format: 'mcp_content_text',
            error: err.message,
            text_preview: block.text.slice(0, 200),
          }, 'warn');
          // Continue to next block
        }
      }
    }
    // All blocks failed — return null rather than falling through to wrong formats
    debugLog('persistent-task-linker', 'response_parse_error', {
      format: 'mcp_content_array',
      error: 'No parseable text block found in content array',
      block_count: toolResponse.content.length,
    }, 'warn');
    return null;
  }

  // Format 2: Bare content array — [{ type: 'text', text: '...' }]
  // Claude Code passes tool_response as a bare array (no { content: ... } wrapper).
  if (Array.isArray(toolResponse)) {
    for (const block of toolResponse) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try {
          return JSON.parse(block.text);
        } catch (_) { /* try next block */ }
      }
    }
  }

  // Format 3: Plain string — JSON-encoded result
  if (typeof toolResponse === 'string') {
    try {
      return JSON.parse(toolResponse);
    } catch (err) {
      debugLog('persistent-task-linker', 'response_parse_error', {
        format: 'string',
        error: err.message,
        text_preview: toolResponse.slice(0, 200),
      }, 'warn');
      return null;
    }
  }

  // Format 3: Plain object — already deserialized (non-MCP path, e.g. tests)
  if (toolResponse && typeof toolResponse === 'object') {
    return toolResponse;
  }

  debugLog('persistent-task-linker', 'response_parse_error', {
    format: 'unknown',
    type: typeof toolResponse,
    error: 'tool_response is null, undefined, or unrecognised type',
  }, 'warn');
  return null;
}

async function main() {
  const stdinData = await readStdin();
  if (!stdinData) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  let input;
  try {
    input = JSON.parse(stdinData);
  } catch (err) {
    process.stderr.write(`[persistent-task-linker] Failed to parse stdin JSON: ${err.message}\n`);
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // Extract tool input — used as fallback source for persistent_task_id
  const toolInput = input.tool_input || {};

  // Extract task creation response
  const toolResponse = input.tool_response || input.result;
  if (!toolResponse) {
    debugLog('persistent-task-linker', 'no_tool_response', {
      has_tool_input: !!Object.keys(toolInput).length,
    }, 'warn');
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  const responseData = parseToolResponse(toolResponse);

  if (!responseData) {
    debugLog('persistent-task-linker', 'unparseable_response', {
      tool_response_type: typeof toolResponse,
    }, 'error');
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // persistent_task_id: prefer the response (echoed back by create_task), but fall
  // back to tool_input in case the response omits it (e.g. race-condition fallback path
  // in createTask returns taskToResponse(fallback) which always includes persistent_task_id,
  // but guard against any future divergence).
  const persistentTaskId = responseData.persistent_task_id || toolInput.persistent_task_id || null;
  const todoTaskId = responseData.id || null;

  if (!persistentTaskId) {
    // Task was not created with a persistent_task_id — nothing to link
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  if (!todoTaskId) {
    debugLog('persistent-task-linker', 'missing_todo_task_id', {
      persistent_task_id: persistentTaskId,
      response_keys: Object.keys(responseData),
    }, 'error');
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // Auto-link in persistent-tasks.db
  if (!fs.existsSync(PT_DB_PATH)) {
    debugLog('persistent-task-linker', 'db_not_found', {
      pt_db_path: PT_DB_PATH,
      persistent_task_id: persistentTaskId,
      todo_task_id: todoTaskId,
    }, 'error');
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  try {
    const db = new Database(PT_DB_PATH);
    db.pragma('busy_timeout = 3000');

    // Verify the persistent task exists
    const task = db.prepare("SELECT id FROM persistent_tasks WHERE id = ?").get(persistentTaskId);
    if (!task) {
      debugLog('persistent-task-linker', 'persistent_task_not_found', {
        persistent_task_id: persistentTaskId,
        todo_task_id: todoTaskId,
      }, 'error');
      db.close();
      console.log(JSON.stringify({ }));
      process.exit(0);
    }

    // Insert sub-task link (ignore if duplicate)
    const result = db.prepare(`
      INSERT OR IGNORE INTO sub_tasks (persistent_task_id, todo_task_id, linked_at, linked_by)
      VALUES (?, ?, ?, ?)
    `).run(persistentTaskId, todoTaskId, new Date().toISOString(), 'auto-linker');

    if (result.changes === 0) {
      // Row already existed — duplicate, not an error
      debugLog('persistent-task-linker', 'already_linked', {
        persistent_task_id: persistentTaskId,
        todo_task_id: todoTaskId,
      }, 'debug');
    } else {
      debugLog('persistent-task-linker', 'linked', {
        persistent_task_id: persistentTaskId,
        todo_task_id: todoTaskId,
      }, 'info');
    }

    // Record event
    const { randomUUID } = await import('crypto');
    db.prepare(`
      INSERT INTO events (id, persistent_task_id, event_type, details, created_at)
      VALUES (?, ?, 'subtask_linked', ?, ?)
    `).run(randomUUID(), persistentTaskId, JSON.stringify({ todo_task_id: todoTaskId, linked_by: 'auto-linker' }), new Date().toISOString());

    db.close();
  } catch (err) {
    // Log DB errors — they indicate a real problem (schema mismatch, lock, etc.)
    process.stderr.write(`[persistent-task-linker] DB error: ${err.message}\n`);
    debugLog('persistent-task-linker', 'db_error', {
      persistent_task_id: persistentTaskId,
      todo_task_id: todoTaskId,
      error: err.message,
      stack: err.stack,
    }, 'error');
  }

  console.log(JSON.stringify({ }));
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[persistent-task-linker] Unhandled error: ${err.message}\n`);
  console.log(JSON.stringify({ }));
  process.exit(0);
});
