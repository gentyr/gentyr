#!/usr/bin/env node
/**
 * Minimal CLI for Toy App
 *
 * Uses the REST API to perform operations.
 *
 * Intentional bugs:
 * - No --help flag (BUG #5)
 */

import { parseArgs } from 'util';

const DEFAULT_API_URL = 'http://localhost:3000';

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

async function listTasks(apiUrl) {
  const data = await fetchJSON(`${apiUrl}/api/tasks`);
  console.log('Tasks:');
  data.tasks.forEach(task => {
    const status = task.completed ? '[x]' : '[ ]';
    console.log(`  ${status} ${task.id}. ${task.title}`);
  });
  console.log(`Total: ${data.tasks.length} tasks`);
}

async function createTask(apiUrl, title) {
  const data = await fetchJSON(`${apiUrl}/api/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  console.log(`Created task #${data.id}: ${data.title}`);
}

async function completeTask(apiUrl, id) {
  await fetchJSON(`${apiUrl}/api/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ completed: 1 }),
  });
  console.log(`Completed task #${id}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node cli.js <command> [options]');
    console.error('Commands:');
    console.error('  tasks list [--api-url=URL]');
    console.error('  tasks create --title "Task name" [--api-url=URL]');
    console.error('  tasks complete --id <id> [--api-url=URL]');
    process.exit(1);
  }

  // BUG #5: No --help flag support
  // If user runs: node cli.js --help
  // It will just show the usage message above, not a dedicated help screen

  const command = args[0];
  const subcommand = args[1];

  // Parse named arguments
  const namedArgs = {};
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [key, value] = arg.substring(2).split('=');
      namedArgs[key] = value || true;
    }
  }

  const apiUrl = namedArgs['api-url'] || DEFAULT_API_URL;

  try {
    if (command === 'tasks') {
      if (subcommand === 'list') {
        await listTasks(apiUrl);
      } else if (subcommand === 'create') {
        if (!namedArgs.title) {
          console.error('Error: --title is required');
          process.exit(1);
        }
        await createTask(apiUrl, namedArgs.title);
      } else if (subcommand === 'complete') {
        if (!namedArgs.id) {
          console.error('Error: --id is required');
          process.exit(1);
        }
        await completeTask(apiUrl, namedArgs.id);
      } else {
        console.error(`Unknown subcommand: ${subcommand}`);
        process.exit(1);
      }
    } else {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
