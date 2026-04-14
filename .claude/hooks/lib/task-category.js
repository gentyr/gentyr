#!/usr/bin/env node
/**
 * Task Category Resolution & Prompt Building
 *
 * Single source of truth replacing:
 * - SECTION_AGENT_MAP (3 copies across spawners)
 * - buildTaskRunnerPrompt() (3 copies across spawners)
 * - PIPELINE_TEMPLATES (progress-tracker.js)
 *
 * @version 1.0.0
 */

import Database from 'better-sqlite3';

/**
 * Resolve a category by ID or deprecated section name.
 * Returns null if the DB is unavailable or no matching category is found.
 *
 * @param {string} dbPath - Absolute path to todo.db
 * @param {{ section?: string, category_id?: string }} opts
 * @returns {object|null} Parsed category with sequence as array, or null
 */
export function resolveCategory(dbPath, { section, category_id } = {}) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }

  try {
    let row;
    if (category_id) {
      row = db.prepare('SELECT * FROM task_categories WHERE id = ?').get(category_id);
    } else if (section) {
      row = db.prepare('SELECT * FROM task_categories WHERE deprecated_section = ?').get(section);
    } else {
      row = db.prepare('SELECT * FROM task_categories WHERE is_default = 1').get();
    }

    if (!row) return null;

    return parseCategory(row);
  } catch {
    // Table may not exist yet (Phase 1/2 not yet applied to this DB)
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * Get all categories from the database.
 *
 * @param {string} dbPath - Absolute path to todo.db
 * @returns {object[]} Array of parsed category objects (empty array on error)
 */
export function getAllCategories(dbPath) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }

  try {
    const rows = db.prepare('SELECT * FROM task_categories ORDER BY is_default DESC, name ASC').all();
    return rows.map(parseCategory);
  } catch {
    // Table may not exist yet (Phase 1/2 not yet applied to this DB)
    return [];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * Get the pipeline stages from a category (replacement for PIPELINE_TEMPLATES).
 *
 * @param {object} category - Parsed category object from resolveCategory()
 * @returns {string[]} Array of agent_type strings (empty if category is null)
 */
export function getPipelineStages(category) {
  if (!category?.sequence) return [];
  return category.sequence.map(step => step.agent_type);
}

/**
 * Build a numbered agent sequence list for prompt injection.
 *
 * @param {Array<{agent_type: string, label: string}>} sequence
 * @returns {string} Formatted numbered list
 */
export function buildSequenceList(sequence) {
  return sequence.map((step, i) =>
    `${i + 1}. \`Task(subagent_type='${step.agent_type}')\` - ${step.label}`
  ).join('\n');
}

/**
 * Build the orchestrator prompt from a category config.
 * Replaces buildTaskRunnerPrompt() and the section-specific action blocks.
 *
 * Dependency-injected functions avoid circular imports:
 * - resolveUserPrompts: from lib/user-prompt-resolver.js
 * - buildStrictInfraGuidancePrompt: from lib/strict-infra-guidance-prompt.js
 *
 * @param {object} task - Task record from todo.db
 * @param {object} category - Parsed category from resolveCategory()
 * @param {string} agentId - Agent ID for the spawned session
 * @param {string|null} worktreePath - Path to git worktree (null if main tree)
 * @param {object} [options] - Additional options
 * @param {function} [options.resolveUserPrompts] - (uuids, projectDir) => string
 * @param {function} [options.buildStrictInfraGuidancePrompt] - (worktreePath, demoInvolved) => string
 * @returns {string} Complete orchestrator prompt
 */
export function buildPromptFromCategory(task, category, agentId, worktreePath = null, options = {}) {
  const { resolveUserPrompts, buildStrictInfraGuidancePrompt } = options;

  // ── Strict infrastructure guidance ──────────────────────────────────────────
  const strictInfraSection = (task.strict_infra_guidance && worktreePath && buildStrictInfraGuidancePrompt)
    ? buildStrictInfraGuidancePrompt(worktreePath, !!task.demo_involved)
    : '';

  // ── User prompt references ───────────────────────────────────────────────────
  let userPromptBlock = '';
  if (task.user_prompt_uuids && resolveUserPrompts) {
    try {
      const uuids = typeof task.user_prompt_uuids === 'string'
        ? JSON.parse(task.user_prompt_uuids)
        : task.user_prompt_uuids;
      if (Array.isArray(uuids) && uuids.length > 0) {
        const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        userPromptBlock = resolveUserPrompts(uuids, PROJECT_DIR);
      }
    } catch { /* non-fatal — prompt UUIDs are best-effort */ }
  }

  // ── Task details header ──────────────────────────────────────────────────────
  const taskDetails = `[Automation][task-runner][AGENT:${agentId}] You are an orchestrator processing a TODO task.

## Task Details

- **Task ID**: ${task.id}
- **Category**: ${category.name} (${category.id})
- **Title**: ${task.title}
${task.description ? `- **Description**: ${task.description}` : ''}
${userPromptBlock}`;

  // ── Worktree context ─────────────────────────────────────────────────────────
  const worktreeNote = worktreePath ? `
## Working Directory

You are in a git worktree at: ${worktreePath}
All git operations (commit, push, PR, merge, worktree cleanup) are handled by the project-manager sub-agent.
You MUST NOT run git add, git commit, git push, or gh pr create yourself.
CRITICAL: You MUST spawn the project-manager before completing your task. The project-manager
is responsible for merging your work AND removing this worktree. If you skip it, the worktree
will be orphaned and your changes will not be merged.
` : '';

  // ── Error handling block ─────────────────────────────────────────────────────
  const errorHandlingBlock = `## Error Handling — DIAGNOSE BEFORE GIVING UP

When a tool call or sub-agent fails:

1. **Read the error message** — understand what actually failed
2. **Diagnose** — is this transient (retry), a missing dependency (fix), or a systemic blocker (escalate)?
3. **Attempt recovery** — try at least ONE alternative approach before declaring blocked:
   - Secret resolution failed → check dev server: \`mcp__secret-sync__secret_dev_server_status\`, start if needed
   - Build failed → read the error output, fix the code, rebuild
   - Demo failed → read \`check_demo_result\`, inspect screenshots/frames, fix and re-run
   - Tool timeout → retry once with a longer timeout
4. **Only escalate if recovery fails** — report via \`mcp__agent-reports__report_to_deputy_cto\` with what failed, what you tried, and why it's unrecoverable

Do NOT immediately call summarize_work(success: false) on the first failure. Iterate.
`;

  // ── Completion block ─────────────────────────────────────────────────────────
  const completionBlock = `${errorHandlingBlock}
## When Done

### Step 1: Run project-manager (MANDATORY for code/test changes)
If you made ANY file changes (code, tests, config), you MUST spawn the project-manager sub-agent
BEFORE completing the task. The project-manager commits, pushes, creates a PR, self-merges,
and removes the worktree. Skipping this step leaves orphaned worktrees and unmerged code.
\`\`\`
Task(subagent_type='project-manager', prompt='Commit all changes, push, create PR, self-merge, and clean up the worktree.')
\`\`\`
If no file changes were made (investigation/research only), skip to Step 2.

### Step 2: Summarize Your Work (MANDATORY)
\`\`\`
mcp__todo-db__summarize_work({ summary: "<concise description of what you did and the outcome>", success: true/false })
\`\`\`
task_id is auto-resolved from your CLAUDE_AGENT_ID — do not pass it manually.

### Step 3: Mark Task Complete
\`\`\`
mcp__todo-db__complete_task({ id: "${task.id}" })
\`\`\`
${worktreeNote}
## Constraints

- Focus only on this specific task
- Do NOT create new tasks. Report findings in your summarize_work summary instead
- Report any issues via mcp__agent-reports__report_to_deputy_cto`;

  // ── Workflow section ─────────────────────────────────────────────────────────
  const sequenceList = buildSequenceList(category.sequence);
  const hasMultipleSteps = category.sequence.length > 1;

  let workflowSection;
  if (hasMultipleSteps) {
    if (category.prompt_template) {
      // Template-based: interpolate category-defined variables
      workflowSection = category.prompt_template
        .replace(/\$\{task\.id\}/g, task.id)
        .replace(/\$\{task\.title\}/g, task.title)
        .replace(/\$\{task\.description\}/g, task.description || '')
        .replace(/\$\{category\.name\}/g, category.name)
        .replace(/\$\{category\.description\}/g, category.description || '')
        .replace(/\$\{agent_sequence_numbered_list\}/g, sequenceList);
    } else {
      // Generated default workflow
      workflowSection = `## RECOMMENDED SUB-AGENT WORKFLOW

You are an ORCHESTRATOR. Do NOT edit files directly. Follow this sequence using the Task tool:

${sequenceList}

Pass the full task context to each sub-agent. Each sub-agent has specialized
instructions loaded from .claude/agents/ configs.

You SHOULD follow this sequence. Deviations are allowed when clearly justified by the task,
but must be explained in summarize_work. Do NOT edit files directly — always use the appropriate sub-agent.

**WORKFLOW DEFAULTS:**
This sequence is the recommended workflow for "${category.name}" tasks. However, if the task
description provides EXPLICIT alternative workflow instructions, follow those instead.
The task creator knows the context — trust their instructions over the default pipeline.
The only invariant is: if you made file changes, you MUST spawn project-manager before completing.`;
    }
  } else {
    // Single-step category: emit an immediate-action block
    const step = category.sequence[0];
    workflowSection = `## IMMEDIATE ACTION

Your first action MUST be:
\`\`\`
Task(subagent_type='${step.agent_type}', prompt='${task.title}. ${task.description || ''}')
\`\`\`

The ${step.agent_type} sub-agent has specialized instructions loaded from .claude/agents/${step.agent_type}.md.
Pass the full task context including title and description.`;
  }

  // ── Assemble final prompt ────────────────────────────────────────────────────
  const prompt = `${taskDetails}
${workflowSection}

${completionBlock}`;

  return strictInfraSection ? `${prompt}${strictInfraSection}` : prompt;
}

// ── Private helpers ────────────────────────────────────────────────────────────

/**
 * Parse a raw DB row into a typed category object.
 * Throws if sequence JSON is malformed — callers should catch as needed.
 *
 * @param {object} row - Raw SQLite row
 * @returns {object} Parsed category
 */
function parseCategory(row) {
  return {
    ...row,
    sequence: JSON.parse(row.sequence),
    creator_restrictions: row.creator_restrictions ? JSON.parse(row.creator_restrictions) : null,
    force_followup: row.force_followup === 1,
    urgency_authorized: row.urgency_authorized === 1,
    is_default: row.is_default === 1,
  };
}
