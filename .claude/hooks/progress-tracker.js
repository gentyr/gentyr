#!/usr/bin/env node
/**
 * Agent Progress Tracker
 *
 * PostToolUse hook that tracks task runner pipeline stages by detecting
 * Task/Agent tool calls with subagent_type. Writes structured progress
 * files to .claude/state/agent-progress/<agent-id>.json.
 *
 * Fast-exit for non-spawned sessions (zero overhead for interactive).
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import { resolveCategory, getPipelineStages } from './lib/task-category.js';

// Fast exit: only track spawned sessions
if ((process.env.CLAUDE_SPAWNED_SESSION !== 'true' && process.env.GENTYR_INTERACTIVE_MONITOR !== 'true') || !process.env.CLAUDE_AGENT_ID) {
  console.log(JSON.stringify({}));
  process.exit(0);
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const AGENT_ID = process.env.CLAUDE_AGENT_ID;
const PROGRESS_DIR = path.join(PROJECT_DIR, '.claude', 'state', 'agent-progress');
const PROGRESS_FILE = path.join(PROGRESS_DIR, `${AGENT_ID}.json`);
const HISTORY_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'agent-tracker-history.json');

// Completion tools that indicate the task runner is wrapping up
const COMPLETION_TOOLS = ['mcp__todo-db__complete_task', 'mcp__todo-db__summarize_work'];

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => { data += line; });
    rl.on('close', () => { resolve(data); });
    setTimeout(() => { rl.close(); resolve(data); }, 200);
  });
}

function readProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeProgress(progress) {
  try {
    fs.mkdirSync(PROGRESS_DIR, { recursive: true });
    const tmpPath = PROGRESS_FILE + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(progress, null, 2));
    fs.renameSync(tmpPath, PROGRESS_FILE);
  } catch (_) {
    // Non-fatal
  }
}

/**
 * Read agent metadata (section, categoryId, taskId) in a single history file read.
 * Returns an object with all three fields (nulls on error or missing).
 */
function lookupAgentMetadata() {
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const history = JSON.parse(raw);
    const agents = Array.isArray(history) ? history : (history.agents || []);
    const agent = agents.find(a => a.id === AGENT_ID);
    const metadata = agent?.metadata || {};
    return {
      section: metadata.section || null,
      categoryId: metadata.categoryId || null,
      taskId: metadata.taskId || null,
    };
  } catch (_) {
    return { section: null, categoryId: null, taskId: null };
  }
}

function createInitialProgress(section, categoryId, taskId) {
  // Try category-based pipeline lookup first (DB-driven, single source of truth)
  let pipeline = null;
  const dbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
  try {
    const category = resolveCategory(dbPath, { category_id: categoryId || undefined, section: (!categoryId && section) ? section : undefined });
    if (category) {
      pipeline = getPipelineStages(category);
    }
  } catch (_) {
    // Non-fatal: fall through to hardcoded templates
  }

  // Fallback to generic pipeline when category resolution fails
  if (!pipeline || pipeline.length === 0) {
    pipeline = ['investigator', 'code-writer', 'code-reviewer', 'project-manager'];
  }

  return {
    agentId: AGENT_ID,
    taskId: taskId || null,
    section: section || 'unknown',
    pipeline: {
      stages: pipeline.map(name => ({ name, status: 'pending', startedAt: null, completedAt: null })),
      currentStage: null,
      currentStageIndex: -1,
      totalStages: pipeline.length,
      progressPercent: 0,
    },
    lastToolCall: null,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

function computeProgress(stages) {
  const total = stages.length;
  if (total === 0) return 0;
  let score = 0;
  for (const s of stages) {
    if (s.status === 'completed') score += 1;
    else if (s.status === 'in_progress') score += 0.5;
  }
  return Math.round((score / total) * 100);
}

async function main() {
  const stdinData = await readStdin();
  if (!stdinData) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  let input;
  try {
    input = JSON.parse(stdinData);
  } catch (_) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  // Extract tool info from the PostToolUse event
  const toolName = input.tool_name || input.tool_use?.name || '';
  let toolInput = input.tool_input || input.tool_use?.input || {};

  // Handle stringified tool_input (some hooks pass it as a JSON string)
  if (typeof toolInput === 'string') {
    try {
      toolInput = JSON.parse(toolInput);
    } catch (_) {
      toolInput = {};
    }
  }

  // Read or create progress
  let progress = readProgress();
  if (!progress) {
    const { section, categoryId, taskId } = lookupAgentMetadata();
    progress = createInitialProgress(section, categoryId, taskId);
  }

  const now = new Date().toISOString();

  // Update last tool call
  let inputPreview = '';
  try {
    const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
    inputPreview = inputStr.substring(0, 120);
  } catch (_) {}

  progress.lastToolCall = { name: toolName, inputPreview, at: now };
  progress.updatedAt = now;

  // Increment tool calls since last stage change (for stale-wait detection)
  progress.toolCallsSinceStageChange = (progress.toolCallsSinceStageChange || 0) + 1;

  // Initialize lastStageChangeAt on first write if not already set
  if (!progress.lastStageChangeAt) {
    progress.lastStageChangeAt = progress.createdAt || now;
  }

  // Detect stage transitions from Task/Agent tool calls
  if ((toolName === 'Task' || toolName === 'Agent') && toolInput) {
    const subagentType = toolInput.subagent_type || toolInput.subagentType;
    if (subagentType) {
      const stages = progress.pipeline.stages;

      // Mark any currently in_progress stage as completed
      for (const s of stages) {
        if (s.status === 'in_progress') {
          s.status = 'completed';
          s.completedAt = now;
        }
      }

      // Find the matching stage and mark it in_progress
      const stageIndex = stages.findIndex(s => s.name === subagentType);
      if (stageIndex >= 0) {
        stages[stageIndex].status = 'in_progress';
        stages[stageIndex].startedAt = now;
        progress.pipeline.currentStage = subagentType;
        progress.pipeline.currentStageIndex = stageIndex;
      } else {
        // Unknown stage — append it dynamically
        stages.push({ name: subagentType, status: 'in_progress', startedAt: now, completedAt: null });
        progress.pipeline.currentStage = subagentType;
        progress.pipeline.currentStageIndex = stages.length - 1;
        progress.pipeline.totalStages = stages.length;
      }

      // Reset stale-wait tracking on stage transition
      progress.lastStageChangeAt = now;
      progress.toolCallsSinceStageChange = 0;

      progress.pipeline.progressPercent = computeProgress(stages);
    }
  }

  // Detect task completion
  if (COMPLETION_TOOLS.includes(toolName)) {
    for (const s of progress.pipeline.stages) {
      if (s.status !== 'completed') {
        s.status = 'completed';
        if (!s.startedAt) s.startedAt = now;
        s.completedAt = now;
      }
    }
    progress.pipeline.currentStage = null;
    progress.pipeline.progressPercent = 100;

    // Reset stale-wait tracking on completion
    progress.lastStageChangeAt = now;
    progress.toolCallsSinceStageChange = 0;
  }

  writeProgress(progress);

  console.log(JSON.stringify({}));
  process.exit(0);
}

main().catch(() => {
  console.log(JSON.stringify({}));
  process.exit(0);
});
