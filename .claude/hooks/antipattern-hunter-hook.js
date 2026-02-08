#!/usr/bin/env node

/**
 * Antipattern Hunter Hook
 *
 * Called from husky post-commit hook. If 6 hours have passed since the last spawn,
 * spawns TWO Claude sessions:
 *   1. Repo-wide hunter: Scans the entire codebase for spec violations
 *   2. Commit-focused hunter: Reviews only the files changed in the current commit
 *
 * Both hunters raise critical issues to the CTO via mcp__agent-reports__report_to_deputy_cto.
 *
 * Usage: node .claude/hooks/antipattern-hunter-hook.js
 *
 * @version 2.0.0
 */

import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { registerSpawn, registerHookExecution, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { getCooldown } from './config-reader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project directory
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Configuration
const CONFIG = {
  stateFile: path.join(projectDir, '.claude', 'state', 'antipattern-hunter-state.json'),
  cooldownHours: getCooldown('antipattern_hunter', 360) / 60, // config is in minutes, convert to hours
};

/**
 * Read state file
 */
function readState() {
  try {
    if (!fs.existsSync(CONFIG.stateFile)) {
      return { lastSpawn: null };
    }
    return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
  } catch {
    return { lastSpawn: null };
  }
}

/**
 * Write state file
 */
function writeState(state) {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Check if cooldown has elapsed
 */
function isCooldownElapsed() {
  const state = readState();

  if (!state.lastSpawn) {
    return true;
  }

  const lastSpawn = new Date(state.lastSpawn);
  const now = new Date();
  const hoursSince = (now - lastSpawn) / (1000 * 60 * 60);

  return hoursSince >= CONFIG.cooldownHours;
}

/**
 * Get the files changed in the most recent commit
 * @returns {object} { files: string[], diff: string, commitMessage: string }
 */
function getCommitChanges() {
  try {
    // Get list of changed files
    const filesOutput = execSync('git diff-tree --no-commit-id --name-only -r HEAD', {
      cwd: projectDir,
      encoding: 'utf8'
    }).trim();

    const files = filesOutput ? filesOutput.split('\n').filter(Boolean) : [];

    // Get the diff for the commit
    const diff = execSync('git show --stat HEAD', {
      cwd: projectDir,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 // 1MB max
    }).trim();

    // Get commit message
    const commitMessage = execSync('git log -1 --pretty=%B', {
      cwd: projectDir,
      encoding: 'utf8'
    }).trim();

    return { files, diff, commitMessage };
  } catch (err) {
    console.error(`[antipattern-hunter] Failed to get commit changes: ${err.message}`);
    return { files: [], diff: '', commitMessage: '' };
  }
}

/**
 * CTO reporting instructions (shared by both hunters)
 */
const CTO_REPORTING_INSTRUCTIONS = `
## CTO Reporting (CRITICAL)

You MUST report important findings to the CTO using the agent-reports MCP server.

**Report when you find:**
- Security violations (G004 hardcoded credentials, G009 missing RLS, G010 missing auth)
- Architecture boundary violations (cross-product separation)
- Critical spec violations requiring immediate attention
- Patterns of repeated violations (3+ similar issues)

**How to report:**
\`\`\`javascript
mcp__agent-reports__report_to_deputy_cto({
  reporting_agent: "antipattern-hunter",
  title: "Brief title (max 200 chars)",
  summary: "Detailed summary with file paths, line numbers, and severity (max 2000 chars)",
  category: "security" | "architecture" | "performance" | "breaking-change" | "blocker" | "decision" | "other",
  priority: "low" | "normal" | "high" | "critical"
})
\`\`\`

**Priority guidelines:**
- critical: Security issues, data exposure risks
- high: Architecture violations, widespread pattern issues
- normal: Standard spec violations
- low: Minor style/consistency issues
`;

/**
 * Spawn repo-wide antipattern hunter
 */
function spawnRepoWideHunter() {
  const prompt = `[Task][antipattern-hunter-repo] REPO-WIDE ANTIPATTERN HUNT - Scan the entire codebase for spec violations.

You are a REPO-WIDE antipattern hunter. Your job is to systematically scan the ENTIRE codebase
looking for spec violations, focusing on areas that may have accumulated technical debt.

## Your Focus Areas
- Hunt across ALL directories: src/, packages/, products/, integrations/
- Look for systemic patterns of violations
- Check areas that don't change frequently (may have old violations)
- Prioritize high-severity specs (G001, G004, G009, G010, G016)

## Workflow

### Step 1: Load Specifications
\`\`\`javascript
mcp__specs-browser__list_specs({})
mcp__specs-browser__get_spec({ spec_id: "G001" })  // No graceful fallbacks
mcp__specs-browser__get_spec({ spec_id: "G004" })  // No hardcoded credentials
mcp__specs-browser__get_spec({ spec_id: "G009" })  // RLS policies required
mcp__specs-browser__get_spec({ spec_id: "G010" })  // Session auth validation
mcp__specs-browser__get_spec({ spec_id: "G016" })  // Integration boundary
\`\`\`

### Step 2: Hunt for Violations
Use Grep to systematically scan for violation patterns:
- G001: \`|| null\`, \`|| undefined\`, \`?? 0\`, \`|| []\`, \`|| {}\`
- G002: \`TODO\`, \`FIXME\`, \`throw new Error('Not implemented')\`
- G004: Hardcoded API keys, credentials, secrets
- G011: \`MOCK_MODE\`, \`isSimulation\`, \`isMockMode\`

### Step 3: For Each Violation
a. Call code-reviewer sub-agent to review proposed fix
b. Create TODO item:
   \`\`\`javascript
   mcp__todo-db__create_task({
     section: "CODE-WRITER",
     title: "Fix [SPEC-ID] violation in [file]",
     description: "[Details and approved fix]",
     assigned_by: "ANTIPATTERN-HUNTER-REPO"
   })
   \`\`\`

### Step 4: Report Critical Issues to CTO
${CTO_REPORTING_INSTRUCTIONS}

### Step 5: END SESSION
After creating TODO items and CTO reports, provide a summary and END YOUR SESSION.
Do NOT implement fixes yourself.

Focus on finding SYSTEMIC issues across the codebase, not just isolated violations.`;

  // Register spawn
  const agentId = registerSpawn({
    type: AGENT_TYPES.ANTIPATTERN_HUNTER_REPO,
    hookType: HOOK_TYPES.ANTIPATTERN_HUNTER,
    description: 'Repo-wide antipattern hunt after commit',
    prompt,
    metadata: { trigger: 'post-commit', scope: 'repo-wide', cooldownHours: CONFIG.cooldownHours },
    projectDir
  });

  // Spawn Claude session (fire-and-forget, detached)
  const claude = spawn('claude', [
    '--dangerously-skip-permissions',
    '-p',
    prompt
  ], {
    detached: true,
    stdio: 'ignore',
    cwd: projectDir,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_SPAWNED_SESSION: 'true'
    }
  });

  claude.unref();

  console.log(`[antipattern-hunter] Spawned REPO-WIDE hunter ${agentId} (PID: ${claude.pid})`);
  return agentId;
}

/**
 * Spawn commit-focused antipattern hunter
 */
function spawnCommitFocusedHunter() {
  const { files, diff, commitMessage } = getCommitChanges();

  if (files.length === 0) {
    console.log('[antipattern-hunter] No files in commit, skipping commit-focused hunter');
    return null;
  }

  const fileList = files.join('\n  - ');

  const prompt = `[Task][antipattern-hunter-commit] COMMIT-FOCUSED ANTIPATTERN HUNT - Review only the changes in the current commit.

You are a COMMIT-FOCUSED antipattern hunter. Your job is to deeply review ONLY the files
that were changed in the most recent commit, checking for spec violations introduced or
existing in those specific files.

## Commit Information
**Message:** ${commitMessage}

**Changed Files:**
  - ${fileList}

**Commit Summary:**
\`\`\`
${diff}
\`\`\`

## Your Focus
- ONLY examine the files listed above
- Check for violations INTRODUCED by this commit
- Check for PRE-EXISTING violations in these files that should be fixed
- Be thorough - read each changed file completely

## Workflow

### Step 1: Load Relevant Specifications
\`\`\`javascript
mcp__specs-browser__list_specs({})
// Load specs most relevant to the changed files
mcp__specs-browser__get_spec({ spec_id: "G001" })  // No graceful fallbacks
mcp__specs-browser__get_spec({ spec_id: "G003" })  // Input validation required
mcp__specs-browser__get_spec({ spec_id: "G004" })  // No hardcoded credentials
\`\`\`

### Step 2: Read and Analyze Each Changed File
For each file in the commit:
1. Read the file using the Read tool
2. Check against ALL relevant specs
3. Note any violations with exact line numbers

### Step 3: For Each Violation
a. Call code-reviewer sub-agent to review proposed fix
b. Create TODO item:
   \`\`\`javascript
   mcp__todo-db__create_task({
     section: "CODE-WRITER",
     title: "Fix [SPEC-ID] violation in [file]:[line]",
     description: "[Details and approved fix]. Found in commit: ${commitMessage.split('\n')[0]}",
     assigned_by: "ANTIPATTERN-HUNTER-COMMIT"
   })
   \`\`\`

### Step 4: Report Critical Issues to CTO
${CTO_REPORTING_INSTRUCTIONS}

### Step 5: END SESSION
After creating TODO items and CTO reports, provide a summary and END YOUR SESSION.
Do NOT implement fixes yourself.

Be THOROUGH with the commit files - this is a deep review, not a surface scan.`;

  // Register spawn
  const agentId = registerSpawn({
    type: AGENT_TYPES.ANTIPATTERN_HUNTER_COMMIT,
    hookType: HOOK_TYPES.ANTIPATTERN_HUNTER,
    description: `Commit-focused antipattern hunt: ${commitMessage.split('\n')[0].substring(0, 50)}`,
    prompt,
    metadata: {
      trigger: 'post-commit',
      scope: 'commit-focused',
      filesChanged: files.length,
      files: files.slice(0, 20), // Store first 20 files
      cooldownHours: CONFIG.cooldownHours
    },
    projectDir
  });

  // Spawn Claude session (fire-and-forget, detached)
  const claude = spawn('claude', [
    '--dangerously-skip-permissions',
    '-p',
    prompt
  ], {
    detached: true,
    stdio: 'ignore',
    cwd: projectDir,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_SPAWNED_SESSION: 'true'
    }
  });

  claude.unref();

  console.log(`[antipattern-hunter] Spawned COMMIT-FOCUSED hunter ${agentId} (PID: ${claude.pid})`);
  return agentId;
}

/**
 * Main entry point
 */
function main() {
  const startTime = Date.now();

  // Check cooldown
  if (!isCooldownElapsed()) {
    const state = readState();
    const hoursSince = (Date.now() - new Date(state.lastSpawn).getTime()) / (1000 * 60 * 60);
    const hoursRemaining = CONFIG.cooldownHours - hoursSince;
    console.log(`[antipattern-hunter] Cooldown active (${hoursRemaining.toFixed(1)}h remaining)`);

    registerHookExecution({
      hookType: HOOK_TYPES.ANTIPATTERN_HUNTER,
      status: 'skipped',
      durationMs: Date.now() - startTime,
      metadata: { reason: 'cooldown', hoursRemaining: hoursRemaining.toFixed(1) }
    });
    return;
  }

  console.log('[antipattern-hunter] Spawning antipattern hunters...');

  // Spawn BOTH hunters
  const repoAgentId = spawnRepoWideHunter();
  const commitAgentId = spawnCommitFocusedHunter();

  // Update state (cooldown applies to both)
  writeState({ lastSpawn: new Date().toISOString() });

  console.log(`[antipattern-hunter] Spawned 2 hunters:`);
  console.log(`  - Repo-wide: ${repoAgentId}`);
  console.log(`  - Commit-focused: ${commitAgentId || 'skipped (no files)'}`);

  registerHookExecution({
    hookType: HOOK_TYPES.ANTIPATTERN_HUNTER,
    status: 'success',
    durationMs: Date.now() - startTime,
    metadata: { repoAgentId, commitAgentId }
  });
}

main();
