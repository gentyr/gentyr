#!/usr/bin/env node
/**
 * Persistent Task Auto-Linker
 *
 * PostToolUse hook on mcp__todo-db__create_task. When the response includes
 * a persistent_task_id, auto-links the new task as a sub-task in persistent-tasks.db.
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';

let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (_) {
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

async function main() {
  const stdinData = await readStdin();
  if (!stdinData) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  let input;
  try {
    input = JSON.parse(stdinData);
  } catch (_) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // Extract task creation response
  const toolResponse = input.tool_response || input.result;
  if (!toolResponse) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // Parse the tool response to find persistent_task_id
  let responseData;
  try {
    responseData = typeof toolResponse === 'string' ? JSON.parse(toolResponse) : toolResponse;
  } catch (_) {
    // Try MCP content array format
    try {
      if (toolResponse?.content && Array.isArray(toolResponse.content)) {
        for (const block of toolResponse.content) {
          if (block.type === 'text' && block.text) {
            responseData = JSON.parse(block.text);
            break;
          }
        }
      }
    } catch (_inner) {
      // Give up
    }
  }

  if (!responseData) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  const persistentTaskId = responseData.persistent_task_id;
  const todoTaskId = responseData.id;

  if (!persistentTaskId || !todoTaskId) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // Auto-link in persistent-tasks.db
  if (!fs.existsSync(PT_DB_PATH)) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  try {
    const db = new Database(PT_DB_PATH);
    db.pragma('busy_timeout = 3000');

    // Verify the persistent task exists
    const task = db.prepare("SELECT id FROM persistent_tasks WHERE id = ?").get(persistentTaskId);
    if (!task) {
      db.close();
      console.log(JSON.stringify({ }));
      process.exit(0);
    }

    // Insert sub-task link (ignore if duplicate)
    db.prepare(`
      INSERT OR IGNORE INTO sub_tasks (persistent_task_id, todo_task_id, linked_at, linked_by)
      VALUES (?, ?, ?, ?)
    `).run(persistentTaskId, todoTaskId, new Date().toISOString(), 'auto-linker');

    // Record event
    const { randomUUID } = await import('crypto');
    db.prepare(`
      INSERT INTO events (id, persistent_task_id, event_type, details, created_at)
      VALUES (?, ?, 'subtask_linked', ?, ?)
    `).run(randomUUID(), persistentTaskId, JSON.stringify({ todo_task_id: todoTaskId, linked_by: 'auto-linker' }), new Date().toISOString());

    db.close();
  } catch (_) {
    // Non-fatal
  }

  console.log(JSON.stringify({ }));
  process.exit(0);
}

main().catch(() => {
  console.log(JSON.stringify({ }));
  process.exit(0);
});
