/**
 * Toy App SDK
 *
 * Programmatic interface for task management.
 * Used by SDK-mode feedback agents to test the application as a developer would.
 *
 * Intentional bugs:
 * 1. createTask() accepts null/undefined/empty title without validation
 * 2. getTask() returns property "complted" instead of "completed" (typo)
 * 3. deleteTask() returns success even for non-existent IDs
 * 4. listTasks({ completed: true }) filter won't match integer 1/0 values
 */

'use strict';

const tasks = new Map();
let nextId = 1;

// Seed data (mirrors server.js seed)
tasks.set(1, { id: 1, title: 'Buy groceries', completed: false, created_at: new Date().toISOString() });
tasks.set(2, { id: 2, title: 'Write documentation', completed: true, created_at: new Date().toISOString() });
nextId = 3;

/**
 * List all tasks, optionally filtered by completion status.
 *
 * @param {Object} [options]
 * @param {boolean} [options.completed] - Filter by completion status (true/false)
 * @returns {Array<Object>} Array of task objects
 */
function listTasks(options) {
  let result = Array.from(tasks.values());

  if (options && options.completed !== undefined) {
    // BUG #4: Uses strict equality — passing 1 or 0 (integers) won't match
    // because internal storage uses boolean true/false
    result = result.filter(t => t.completed === options.completed);
  }

  return result;
}

/**
 * Create a new task.
 *
 * @param {string} title - The task title
 * @returns {Object} The created task
 */
function createTask(title) {
  // BUG #1: No validation — accepts null, undefined, empty string, numbers, etc.
  const task = {
    id: nextId++,
    title: title,
    completed: false,
    created_at: new Date().toISOString(),
  };
  tasks.set(task.id, task);
  return task;
}

/**
 * Get a task by ID.
 *
 * @param {number|string} id - The task ID
 * @returns {Object|null} The task object or null if not found
 */
function getTask(id) {
  const task = tasks.get(Number(id));
  if (!task) return null;

  // BUG #2: Typo — "complted" instead of "completed"
  return {
    id: task.id,
    title: task.title,
    complted: task.completed,
    created_at: task.created_at,
  };
}

/**
 * Mark a task as completed.
 *
 * @param {number|string} id - The task ID
 * @returns {Object} Result with success boolean
 */
function completeTask(id) {
  const task = tasks.get(Number(id));
  if (!task) {
    return { success: false };
  }
  task.completed = true;
  return { success: true };
}

/**
 * Delete a task by ID.
 *
 * @param {number|string} id - The task ID
 * @returns {Object} Result with success boolean
 */
function deleteTask(id) {
  // BUG #3: Returns success even if task doesn't exist
  tasks.delete(Number(id));
  return { success: true, deleted: true };
}

module.exports = { listTasks, createTask, getTask, completeTask, deleteTask };
