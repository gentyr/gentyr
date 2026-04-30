#!/usr/bin/env node
/**
 * PostToolUse Hook: Orchestration Guidance
 *
 * Fires after mcp__todo-db__create_task. Detects complexity signals in the
 * newly created task and nudges the CTO toward better work decomposition:
 * parallel tasks, persistent tasks, or plans — depending on scope.
 *
 * Complexity signals (any one triggers guidance):
 *   - Task description contains 3+ "and", "also", "plus", "additionally" connectors
 *   - Task description contains 4+ distinct bullet points or numbered items
 *   - Title mentions multiple independent components (e.g., "fix X, Y, and Z")
 *   - Description length > 800 chars (suggests many sub-problems)
 *   - Description contains words like "all", "every", "entire", "throughout"
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 *
 * @version 1.0.0
 */

import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ── Input parsing ─────────────────────────────────────────────────────────────

let hookInput = '';
try {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  hookInput = Buffer.concat(chunks).toString('utf-8');
} catch {
  process.exit(0);
}

let input;
try {
  input = JSON.parse(hookInput);
} catch {
  process.exit(0);
}

// ── Fast exits ────────────────────────────────────────────────────────────────

// Only fire for interactive (CTO) sessions — spawned agents should not receive
// meta-guidance about orchestration while they are executing a specific task.
if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
  process.exit(0);
}

// Only fire on create_task
const toolName = input?.tool_name || '';
if (!toolName.includes('create_task')) {
  process.exit(0);
}

// ── Complexity signal detection ───────────────────────────────────────────────

const taskInput = input?.tool_input || {};
const taskResponse = input?.tool_response || {};

const title = (taskInput.title || '').toLowerCase();
const description = (taskInput.description || taskInput.notes || '').toLowerCase();
const combined = `${title} ${description}`;

// Signal 1: conjunction overload (suggests multiple independent problems)
const conjunctionCount = (combined.match(/\b(and|also|plus|additionally|furthermore|moreover)\b/g) || []).length;
const hasConjunctionOverload = conjunctionCount >= 3;

// Signal 2: multiple enumerated items (bullets or numbered list)
const bulletCount = (combined.match(/(?:^|\n)\s*[-*•]\s+/g) || []).length +
                    (combined.match(/(?:^|\n)\s*\d+[.)]\s+/g) || []).length;
const hasManyBullets = bulletCount >= 4;

// Signal 3: broad scope language
const broadScopeMatch = combined.match(/\b(all|every|entire|throughout|across all|everywhere)\b/);

// Signal 4: long description (many sub-problems crammed into one task)
const isLongDescription = description.length > 800;

// Signal 5: title mentions multiple distinct items with commas or slashes
const titleItemCount = (title.split(/[,\/]/).length);
const hasManyTitleItems = titleItemCount >= 3;

const signalCount = [hasConjunctionOverload, hasManyBullets, !!broadScopeMatch, isLongDescription, hasManyTitleItems]
  .filter(Boolean).length;

// Only nudge when 2+ signals present (reduces false positives)
if (signalCount < 2) {
  process.exit(0);
}

// ── Determine most likely appropriate structure ────────────────────────────────

// Heuristic: if description is very long AND has many bullets → likely plan or parallel tasks
// If moderate size → parallel tasks is the easy win
// If very long and mentions "monitor", "track", "ongoing" → persistent task

const persistentKeywords = /\b(monitor|ongoing|track|continuously|iterative|multi-day|multi-session|sustained|watch)\b/;
const planKeywords = /\b(phase|depend|after|before|block|sequence|order|milestone|stage)\b/;

let recommendation;
if (planKeywords.test(combined)) {
  recommendation = `ORCHESTRATION SUGGESTION: This task has ordering/dependency signals — consider using /plan to create a structured multi-phase plan instead. Plans auto-spawn a plan-manager and track phase dependencies. Use /plan for: "build X, then migrate Y which depends on X".`;
} else if (persistentKeywords.test(combined)) {
  recommendation = `ORCHESTRATION SUGGESTION: This task has multi-session/monitoring signals — consider using /persistent-task for sustained multi-session work with a dedicated monitor that spawns child agents as needed.`;
} else if (hasManyBullets || hasConjunctionOverload || hasManyTitleItems) {
  recommendation = `ORCHESTRATION SUGGESTION: This task appears to contain multiple independent work items. Consider splitting into parallel tasks: create separate create_task calls for each independent group, then force_spawn_tasks({ taskIds: [all] }) to run them concurrently. Parallel tasks complete faster and are easier to track individually.`;
} else {
  recommendation = `ORCHESTRATION SUGGESTION: This task looks large or broad-scoped. Before proceeding, consider whether it should be: (1) split into parallel tasks if items are independent, (2) a persistent task if it requires multi-session monitoring, or (3) a plan if it has ordered phases.`;
}

// ── Emit guidance via additionalContext ──────────────────────────────────────

const output = {
  continue: true,
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: recommendation,
  },
};

process.stdout.write(JSON.stringify(output));
process.exit(0);
