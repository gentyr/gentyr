#!/usr/bin/env node
/**
 * Plan Executor Hook
 *
 * Spawns a Claude session with deputy-cto to analyze and execute pending plans.
 * Called hourly by systemd timer (Linux) or launchd (macOS).
 *
 * The deputy-cto agent will:
 * 1. Study PLAN.md and /plans subdirectory
 * 2. Identify completed vs pending plans
 * 3. For pending plans: spawn investigator → code-writer → test-writer → code-reviewer → project-manager
 * 4. For completed plans: verify specs exist, archive plan, update CLAUDE.md
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { getCooldown } from './config-reader.js';
import { enqueueSession } from './lib/session-queue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_FILE = path.join(PROJECT_DIR, '.claude', 'plan-executor-state.json');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'plan-executor.log');

// Cooldown: dynamic from config, default 55 minutes
const COOLDOWN_MS = getCooldown('plan_executor', 55) * 60 * 1000;

/**
 * Append to log file
 */
function log(message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, logLine);
  console.log(logLine.trim());
}

/**
 * Get state from file
 * G001: Fail-closed if state file exists but is corrupted
 */
function getState() {
  if (!fs.existsSync(STATE_FILE)) {
    // No state file = first run, return defaults
    return { lastRun: 0, lastPlanHash: null, runsToday: 0 };
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    // G001: State file exists but is corrupted - fail closed
    log(`FATAL: State file corrupted: ${err.message}`);
    log(`Delete ${STATE_FILE} to reset, or fix the JSON manually.`);
    process.exit(1);
  }
}

/**
 * Save state to file
 * G001: Fail-closed if state can't be saved (breaks rate limiting)
 */
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    // G001: If we can't save state, rate limiting breaks - fail closed
    log(`FATAL: Cannot save state: ${err.message}`);
    log(`This would break rate limiting. Fix permissions on ${STATE_FILE}`);
    process.exit(1);
  }
}

/**
 * Get list of plan files
 */
function getPlanFiles() {
  const plansDir = path.join(PROJECT_DIR, 'plans');
  const files = [];

  // Check PLAN.md in root
  const rootPlan = path.join(PROJECT_DIR, 'PLAN.md');
  if (fs.existsSync(rootPlan)) {
    files.push({ path: 'PLAN.md', name: 'PLAN.md (root)' });
  }

  // Check plans/ directory
  if (fs.existsSync(plansDir)) {
    const planFiles = fs.readdirSync(plansDir)
      .filter(f => f.endsWith('.md'))
      .sort();
    for (const f of planFiles) {
      files.push({ path: `plans/${f}`, name: f });
    }
  }

  return files;
}

/**
 * Build the prompt for deputy-cto
 */
function buildPrompt(planFiles) {
  const fileList = planFiles.map(f => `- ${f.path}`).join('\n');

  return `[Task][plan-executor] You are an orchestrator performing HOURLY PLAN EXECUTION.

## IMMEDIATE ACTION

Your first action MUST be to spawn the deputy-cto sub-agent:
\`\`\`
Task(subagent_type='deputy-cto', prompt='Perform hourly plan execution. Study the project plans and execute any that are ready for implementation. Plan files: ${fileList.replace(/\n/g, ', ')}')
\`\`\`

The deputy-cto sub-agent has specialized instructions loaded from .claude/agents/deputy-cto.md.

## Your Mission

Study the project plans and execute any that are ready for implementation.

## Plan Files Found

${fileList}

## Execution Workflow

For EACH plan file:

### Step 1: Analyze Plan Status

Read the plan and determine:
- Is this plan COMPLETED (all items done)?
- Is this plan IN-PROGRESS (some items done)?
- Is this plan PENDING (not started)?
- Does this plan have clear, actionable items?

### Step 2: For PENDING/IN-PROGRESS Plans

If the plan is ready to work on:

1. **Spawn INVESTIGATOR** to analyze requirements and create detailed tasks
   - Wait for investigator to complete and create tasks

2. **Spawn CODE-REVIEWER** to review the planned changes BEFORE implementation
   - The code-reviewer should validate the approach

3. **Spawn CODE-WRITER** to implement the changes
   - Wait for implementation to complete

4. **Spawn TEST-WRITER** to add/update tests
   - Wait for tests to be written

5. **Spawn CODE-REVIEWER** again for final sign-off
   - Wait for approval

6. **Spawn PROJECT-MANAGER** to sync documentation

Use \`mcp__todo-db__create_task\` with \`priority: "urgent"\` to create tasks for each agent step.
Map to sections: INVESTIGATOR & PLANNER, CODE-REVIEWER, TEST-WRITER, PROJECT-MANAGER.
The urgent dispatcher picks these up within seconds.

### Step 3: For COMPLETED Plans

If the plan is fully implemented:

1. Verify the feature is documented in:
   - \`specs/local/\` (component specs) OR
   - \`specs/global/\` (invariants) OR
   - \`CLAUDE.md\` (architecture docs)

2. If documentation exists, the plan can be archived:
   - Create a summary of what was implemented
   - Add entry to CTO reports noting completion
   - The project-manager will handle cleanup

3. If documentation is missing:
   - Spawn PROJECT-MANAGER to create proper documentation
   - Do NOT archive until documented

## Plan Improvement

You are empowered to IMPROVE plans when you identify issues:

1. **Add missing details** - If a plan lacks specificity, add concrete steps
2. **Fix inconsistencies** - Correct any conflicting information
3. **Clarify ambiguity** - Make vague items actionable

### When to Ask CTO

Use \`mcp__deputy-cto__add_question\` for:
- Major architectural decisions with multiple valid approaches
- Scope changes or feature additions
- Conflicting requirements between plans
- Prioritization when resources are limited

When asking CTO, add a note in the plan:
\`\`\`markdown
<!-- CTO-PENDING: [question-id] - [brief description] -->
<!-- Do not implement items below this note until CTO responds -->
\`\`\`

### Check for Existing CTO-PENDING Notes

BEFORE implementing any plan:
1. Search the plan for \`<!-- CTO-PENDING:\` markers
2. For each marker, use \`mcp__deputy-cto__search_cleared_items\` to check if the CTO has addressed it
3. If addressed, remove the marker and proceed
4. If NOT addressed, skip that section and work on other items

## Important Rules

1. **One plan at a time** - Don't try to execute multiple plans simultaneously
2. **Check dependencies** - Some plans depend on others
3. **Respect order** - Plans are numbered (01, 02, etc.) for a reason
4. **Report progress** - Use \`mcp__agent-reports__report_to_deputy_cto\` to log what you're doing
5. **Don't rush** - Better to do one plan well than many poorly
6. **Improve as you go** - Fix plan issues when you find them
7. **Demos use MCP tools** - When a plan step says "run a demo" or "launch Playwright", use the Playwright MCP tools (\`mcp__playwright__launch_ui_mode\`, \`mcp__playwright__run_tests\`, \`mcp__playwright__get_coverage_status\`, etc.) — do NOT run \`npx playwright\` via Bash

## Rate Limiting

- Maximum 3 agent spawns per hour
- If a plan is large, split across multiple hourly runs
- Add questions for CTO if unsure about priority

## Start Now

1. Read PLAN.md first to understand the overall project status
2. Search for any \`CTO-PENDING\` markers and check their status
3. Then examine each plan file in /plans
3. Report your findings and planned actions
4. Execute the most important pending plan (if any)`;
}

/**
 * Enqueue Claude with deputy-cto for plan execution
 */
function enqueuePlanExecutor(prompt) {
  log(`Enqueueing plan executor agent`);
  log(`Working directory: ${PROJECT_DIR}`);

  const { queueId } = enqueueSession({
    title: 'Executing pending plans from PLAN.md',
    agentType: AGENT_TYPES.TASK_RUNNER_DEPUTY_CTO,
    hookType: HOOK_TYPES.TASK_RUNNER,
    tagContext: 'plan-executor',
    source: 'plan-executor',
    prompt,
    priority: 'normal',
    cwd: PROJECT_DIR,
    projectDir: PROJECT_DIR,
    metadata: {},
    ttlMs: 35 * 60 * 1000, // 35 minutes — slightly longer than previous 30m timeout
  });

  log(`Enqueued plan executor as queue item ${queueId}`);
  return queueId;
}

/**
 * Main entry point
 */
function main() {
  log('Plan executor starting...');

  // Check cooldown
  const state = getState();
  const now = Date.now();
  const timeSinceLastRun = now - state.lastRun;

  if (timeSinceLastRun < COOLDOWN_MS) {
    const minutesLeft = Math.ceil((COOLDOWN_MS - timeSinceLastRun) / 60000);
    log(`Cooldown active. ${minutesLeft} minutes until next run.`);
    process.exit(0);
  }

  // Get plan files
  const planFiles = getPlanFiles();

  if (planFiles.length === 0) {
    log('No plan files found. Nothing to execute.');
    process.exit(0);
  }

  log(`Found ${planFiles.length} plan file(s): ${planFiles.map(f => f.name).join(', ')}`);

  // Build prompt
  const prompt = buildPrompt(planFiles);

  // Update state before running
  state.lastRun = now;
  state.runsToday = (state.runsToday || 0) + 1;
  saveState(state);

  try {
    log('Enqueueing Claude for plan execution...');
    enqueuePlanExecutor(prompt);
  } catch (err) {
    log(`Plan execution enqueue error: ${err.message}`);
    process.exit(1);
  }

  log('Plan executor finished.');
}

main();
