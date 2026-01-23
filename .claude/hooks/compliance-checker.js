#!/usr/bin/env node

/**
 * Compliance Checker System for ODIN
 *
 * Orchestrates batch compliance checking with DUAL ENFORCEMENT MODES:
 *
 * GLOBAL ENFORCEMENT (spec-file-mappings.json):
 * - Validates mapping file
 * - Checks specific files against global specs
 * - Per-file cooldown (7 days default)
 * - Daily agent cap (22 agents default)
 *
 * LOCAL ENFORCEMENT (specs/local/*.md):
 * - No file mappings required
 * - Agent explores codebase freely using Glob/Grep
 * - Per-spec cooldown (7 days default)
 * - Daily agent cap (3 agents default)
 * - One agent per spec file
 *
 * Key Features:
 * - Dual rate limiting (global + local separate budgets)
 * - Mapping validation with auto-fix/review (global only)
 * - Fire-and-forget post-commit integration
 * - Full enforcement history tracking per mode
 *
 * Exit codes:
 * - 0: Success
 * - 1: Error
 * - 2: Validation failed (mapping file issues)
 *
 * Usage:
 *   node compliance-checker.js [--status] [--dry-run]
 *   node compliance-checker.js [--global-only] [--local-only]
 *   node compliance-checker.js [--history] [--history-global] [--history-local]
 *
 * @author Claude Code Hooks
 * @version 2.0.0
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { validateMappings, formatValidationResult } from './mapping-validator.js';
import { registerSpawn, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';

// Project directory
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Load configuration
const configPath = path.join(projectDir, '.claude/hooks/compliance-config.json');
let CONFIG;
try {
  const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  // Backwards compatibility: migrate old flat config to nested structure
  if (!rawConfig.global && !rawConfig.local) {
    CONFIG = {
      global: {
        maxAgentsPerDay: rawConfig.maxAgentsPerDay || 22,
        fileVerificationCooldownDays: rawConfig.fileVerificationCooldownDays || 7,
        mappingReviewCooldownDays: rawConfig.mappingReviewCooldownDays || 7,
        mappingFixCooldownHours: rawConfig.mappingFixCooldownHours || 3
      },
      local: {
        maxAgentsPerDay: rawConfig.local?.maxAgentsPerDay || 3,
        specCooldownDays: rawConfig.local?.specCooldownDays || 7
      },
      autoRunIntervalDays: rawConfig.autoRunIntervalDays || 7,
      concurrency: rawConfig.concurrency || 5,
      mappingFile: rawConfig.mappingFile || '.claude/hooks/spec-file-mappings.json',
      stateFile: rawConfig.stateFile || '.claude/hooks/compliance-state.json',
      logFile: rawConfig.logFile || '.claude/hooks/compliance-log.json',
      specsGlobalDir: rawConfig.specsGlobalDir || 'specs/global',
      specsLocalDir: rawConfig.specsLocalDir || 'specs/local'
    };
  } else {
    CONFIG = rawConfig;
  }
} catch (err) {
  console.error(`Failed to load compliance-config.json: ${err.message}`);
  process.exit(1);
}

// State file paths
const STATE_FILE = path.join(projectDir, CONFIG.stateFile);
const LOG_FILE = path.join(projectDir, CONFIG.logFile);
const MAPPING_FILE = path.join(projectDir, CONFIG.mappingFile);

/**
 * Parse command line arguments
 * @param {string[]} args
 * @returns {object}
 */
function parseArgs(args) {
  return {
    status: args.includes('--status'),
    dryRun: args.includes('--dry-run'),
    globalOnly: args.includes('--global-only'),
    localOnly: args.includes('--local-only'),
    postCommit: args.includes('--post-commit'),
    history: args.includes('--history'),
    historyGlobal: args.includes('--history-global'),
    historyLocal: args.includes('--history-local')
  };
}

/**
 * Read state file
 * @returns {object}
 */
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    // Return default state if file doesn't exist
    return {
      version: 1,
      globalSpecs: { lastRun: null, nextEligible: null },
      localSpecs: { lastRun: null, nextEligible: null, perSpecLastRun: {} }
    };
  }
}

/**
 * Write state file
 * @param {object} state
 */
function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Read daily spawn log
 * @returns {object}
 */
function readLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch {
    // Return default log if file doesn't exist
    return {
      version: 1,
      dailySpawns: {},
      history: []
    };
  }
}

/**
 * Write daily spawn log
 * @param {object} log
 */
function writeLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
}

/**
 * Get date string in YYYY-MM-DD format
 * @param {Date} [date] - Optional date to format (defaults to today)
 * @returns {string}
 */
function getTodayString(date = null) {
  const now = date || new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Check if daily agent cap has been reached for a specific mode
 * @param {string} mode - 'global' or 'local'
 * @returns {{ allowed: boolean, used: number, limit: number, remaining: number }}
 */
function checkDailyAgentCap(mode = 'global') {
  const log = readLog();
  const today = getTodayString();

  // Count spawns for this mode today
  const todaySpawns = log.history.filter(h => {
    const spawnDate = getTodayString(new Date(h.date));
    return spawnDate === today && h.mode === mode;
  });

  const used = todaySpawns.reduce((sum, h) => sum + h.count, 0);
  const limit = mode === 'global' ? CONFIG.global.maxAgentsPerDay : CONFIG.local.maxAgentsPerDay;

  return {
    allowed: used < limit,
    used,
    limit,
    remaining: Math.max(0, limit - used)
  };
}

/**
 * Record agent spawns for today
 * @param {string} mode - 'global' or 'local' enforcement mode
 * @param {Array<{spec: string, file: string, priority: string}>} agents - Array of agent details
 */
function recordAgentSpawns(mode, agents) {
  const log = readLog();
  const today = getTodayString();

  // Update daily count
  log.dailySpawns[today] = (log.dailySpawns[today] || 0) + agents.length;

  // Add to history with full details per agent
  log.history.push({
    date: new Date().toISOString(),
    mode,
    count: agents.length,
    agents: agents.map(a => ({
      spec: a.spec,
      file: a.file,
      priority: a.priority
    }))
  });

  // Keep only last 30 days of daily spawns
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoffDate = getTodayString(thirtyDaysAgo);

  const newDailySpawns = {};
  for (const [date, count] of Object.entries(log.dailySpawns)) {
    if (date >= cutoffDate) {
      newDailySpawns[date] = count;
    }
  }
  log.dailySpawns = newDailySpawns;

  // Keep only last 1000 history entries
  if (log.history.length > 1000) {
    log.history = log.history.slice(-1000);
  }

  writeLog(log);
}

/**
 * Check if we're within the per-file verification cooldown
 * @param {string} lastVerified - ISO timestamp or null
 * @returns {boolean} true if within cooldown (should skip)
 */
function isWithinFileCooldown(lastVerified) {
  if (!lastVerified) return false;

  const lastVerifiedDate = new Date(lastVerified);
  const now = new Date();
  const daysSince = (now - lastVerifiedDate) / (1000 * 60 * 60 * 24);

  return daysSince < CONFIG.global.fileVerificationCooldownDays;
}

/**
 * Check if we're within the per-spec enforcement cooldown (for local specs)
 * @param {string} specName - Name of the spec file (e.g., 'THOR.md')
 * @param {object} state - Current state object
 * @returns {boolean} true if within cooldown (should skip)
 */
function isWithinSpecCooldown(specName, state) {
  if (!state.localSpecs.perSpecLastRun) {
    state.localSpecs.perSpecLastRun = {};
  }

  const lastRun = state.localSpecs.perSpecLastRun[specName];
  if (!lastRun) return false;

  const lastRunDate = new Date(lastRun);
  const now = new Date();
  const daysSince = (now - lastRunDate) / (1000 * 60 * 60 * 24);

  return daysSince < CONFIG.local.specCooldownDays;
}

/**
 * Update the last run timestamp for a local spec
 * @param {string} specName - Name of the spec file
 * @param {object} state - Current state object
 */
function updateSpecCooldown(specName, state) {
  if (!state.localSpecs.perSpecLastRun) {
    state.localSpecs.perSpecLastRun = {};
  }

  state.localSpecs.perSpecLastRun[specName] = new Date().toISOString();
  writeState(state);
}

/**
 * Update lastVerified timestamp for a file in the mapping
 * @param {string} specName
 * @param {string} filePath
 */
function updateFileVerificationTimestamp(specName, filePath) {
  try {
    const mappings = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));

    if (mappings.specs[specName]) {
      const fileEntry = mappings.specs[specName].files.find(f => f.path === filePath);
      if (fileEntry) {
        fileEntry.lastVerified = new Date().toISOString();
        fs.writeFileSync(MAPPING_FILE, JSON.stringify(mappings, null, 2), 'utf8');
      }
    }
  } catch (err) {
    console.error(`Warning: Failed to update lastVerified for ${filePath}: ${err.message}`);
  }
}

/**
 * Spawn Claude instance (fire-and-forget)
 * @param {string} prompt - Prompt to send
 * @param {object} env - Additional environment variables
 * @param {object} trackingInfo - Agent tracking info (type, description, metadata)
 * @returns {number} PID of spawned process
 */
function spawnClaudeInstance(prompt, env = {}, trackingInfo = null) {
  // Use type from trackingInfo for [Task][type] format, fallback to 'compliance' for untyped spawns
  const taskType = trackingInfo?.type || 'compliance';
  const taggedPrompt = `[Task][${taskType}] ${prompt}`;

  // Register spawn with agent tracker if tracking info provided
  if (trackingInfo) {
    registerSpawn({
      type: trackingInfo.type,
      hookType: HOOK_TYPES.COMPLIANCE_CHECKER,
      description: trackingInfo.description,
      prompt: taggedPrompt,
      metadata: trackingInfo.metadata || {},
      projectDir
    });
  }

  const claude = spawn('claude', [
    '--dangerously-skip-permissions',
    '-p',
    taggedPrompt
  ], {
    detached: true,
    stdio: 'ignore',
    cwd: projectDir,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_SPAWNED_SESSION: 'true',
      ...env
    }
  });

  claude.unref();
  return claude.pid;
}

/**
 * Build prompt from template with variable substitution
 * @param {string} templatePath
 * @param {object} variables
 * @returns {string}
 */
function buildPrompt(templatePath, variables) {
  let template = fs.readFileSync(templatePath, 'utf8');

  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    template = template.replace(regex, value);
  }

  return template;
}

/**
 * Check if mapping fix spawn is rate limited
 * @returns {{ allowed: boolean, nextEligible: string|null }}
 */
function checkMappingFixRateLimit() {
  const state = readState();
  const cooldownHours = CONFIG.global.mappingFixCooldownHours || 3;

  if (!state.mappingFix?.lastSpawn) {
    return { allowed: true, nextEligible: null };
  }

  const lastSpawn = new Date(state.mappingFix.lastSpawn);
  const now = new Date();
  const hoursSinceSpawn = (now - lastSpawn) / (1000 * 60 * 60);

  if (hoursSinceSpawn >= cooldownHours) {
    return { allowed: true, nextEligible: null };
  }

  const nextEligible = new Date(lastSpawn.getTime() + cooldownHours * 60 * 60 * 1000);
  return {
    allowed: false,
    nextEligible: nextEligible.toISOString(),
    hoursRemaining: Math.ceil(cooldownHours - hoursSinceSpawn)
  };
}

/**
 * Record mapping fix spawn
 */
function recordMappingFixSpawn() {
  const state = readState();
  const now = new Date();
  const cooldownHours = CONFIG.global.mappingFixCooldownHours || 3;
  const nextEligible = new Date(now.getTime() + cooldownHours * 60 * 60 * 1000);

  state.mappingFix = {
    lastSpawn: now.toISOString(),
    nextEligible: nextEligible.toISOString()
  };

  writeState(state);
}

/**
 * Handle mapping validation failure - spawn Claude to fix it (rate limited)
 * @param {ValidationResult} result
 */
function handleMappingValidationFailure(result) {
  console.error('\n' + formatValidationResult(result));

  // Check rate limit before spawning
  const rateLimit = checkMappingFixRateLimit();
  if (!rateLimit.allowed) {
    console.error('\n╔═══════════════════════════════════════════════════════════════╗');
    console.error('║              MAPPING FIX RATE LIMITED                          ║');
    console.error('╠═══════════════════════════════════════════════════════════════╣');
    console.error(`║ Cannot spawn Claude to fix mapping (cooldown: ${CONFIG.global.mappingFixCooldownHours || 3}h)        ║`);
    console.error(`║ Next eligible: ${rateLimit.nextEligible.substring(0, 19).replace('T', ' ')}                   ║`);
    console.error(`║ Hours remaining: ${rateLimit.hoursRemaining}                                          ║`);
    console.error('╠═══════════════════════════════════════════════════════════════╣');
    console.error('║ Fix the mapping file manually or wait for cooldown to expire. ║');
    console.error('╚═══════════════════════════════════════════════════════════════╝');
    return;
  }

  console.error('\nSpawning Claude to fix mapping file...\n');

  const promptPath = path.join(projectDir, '.claude/hooks/prompts/mapping-fix.md');

  if (!fs.existsSync(promptPath)) {
    console.error(`Error: Prompt template not found at ${promptPath}`);
    process.exit(2);
  }

  // Read current mappings
  let currentMappings = '{}';
  try {
    currentMappings = fs.readFileSync(MAPPING_FILE, 'utf8');
  } catch {
    currentMappings = '{}';
  }

  // Read schema
  const schemaPath = path.join(projectDir, '.claude/hooks/spec-file-mappings-schema.json');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  // Format errors for prompt
  const errorsOutput = result.errors.map(e =>
    `[${e.severity.toUpperCase()}] ${e.code}\n  ${e.message}\n  Suggestion: ${e.suggestion}`
  ).join('\n\n');

  const prompt = buildPrompt(promptPath, {
    VALIDATION_ERRORS: errorsOutput,
    CURRENT_MAPPINGS: currentMappings,
    SCHEMA_CONTENT: schema,
    REQUIRED_SPECS_LIST: '- ' + [
      'BARDE.md',
      'HEIMDALL.md',
      'HUGINN.md',
      'OVERSEER.md',
      'UNDERSEER.md',
      'THOR.md',
      'SIGNALS.md',
      'CORE-INVARIANTS.md'
    ].join('\n- '),
    MAX_AGENTS: CONFIG.global.maxAgentsPerDay.toString(),
    CURRENT_AGENT_COUNT: result.agentCount.toString(),
    EXCESS_COUNT: result.errors.find(e => e.code === 'AGENT_LIMIT_EXCEEDED')?.details?.excess?.toString() || '0'
  });

  spawnClaudeInstance(prompt, { COMPLIANCE_MODE: 'mapping-fix' }, {
    type: AGENT_TYPES.COMPLIANCE_MAPPING_FIX,
    description: `Fixing mapping validation errors (${result.errors.length} errors)`,
    metadata: { errorCount: result.errors.length, agentCount: result.agentCount }
  });
  recordMappingFixSpawn();
  console.log('Claude spawned to fix mapping file. Run this script again after fixes are applied.');
}

/**
 * Handle mapping validation success - optionally spawn Claude to review
 * @param {ValidationResult} result
 */
function handleMappingValidationSuccess(result) {
  console.log('\n' + formatValidationResult(result));

  // Check if we should review the mappings (weekly cooldown)
  const mappings = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
  const lastReviewed = mappings.lastReviewed ? new Date(mappings.lastReviewed) : null;
  const now = new Date();

  if (lastReviewed) {
    const daysSinceReview = (now - lastReviewed) / (1000 * 60 * 60 * 24);
    if (daysSinceReview < CONFIG.global.mappingReviewCooldownDays) {
      console.log(`\nMapping review skipped (last reviewed ${Math.round(daysSinceReview)} days ago, cooldown: ${CONFIG.global.mappingReviewCooldownDays} days)\n`);
      return;
    }
  }

  console.log('\nSpawning Claude to review mappings...\n');

  const promptPath = path.join(projectDir, '.claude/hooks/prompts/mapping-review.md');

  if (!fs.existsSync(promptPath)) {
    console.log('Note: mapping-review.md prompt not found, skipping review');
    return;
  }

  // Build spec breakdown table
  const breakdownLines = Object.entries(result.specBreakdown)
    .map(([spec, data]) => `| ${spec.padEnd(25)} | ${String(data.fileCount).padStart(3)} | ${data.priority.padEnd(8)} |`)
    .join('\n');

  const breakdownTable = `| Spec | Files | Priority |\n|------|-------|----------|\n${breakdownLines}`;

  const prompt = buildPrompt(promptPath, {
    CURRENT_MAPPINGS: fs.readFileSync(MAPPING_FILE, 'utf8'),
    CURRENT_AGENT_COUNT: result.agentCount.toString(),
    MAX_AGENTS: CONFIG.global.maxAgentsPerDay.toString(),
    UTILIZATION_PERCENT: result.utilizationPercent.toString(),
    REMAINING_BUDGET: (result.limit - result.agentCount).toString(),
    SPEC_BREAKDOWN_TABLE: breakdownTable
  });

  spawnClaudeInstance(prompt, { COMPLIANCE_MODE: 'mapping-review' }, {
    type: AGENT_TYPES.COMPLIANCE_MAPPING_REVIEW,
    description: `Reviewing spec-file-mappings.json (${result.agentCount} agents, ${result.utilizationPercent}% utilization)`,
    metadata: { agentCount: result.agentCount, utilizationPercent: result.utilizationPercent }
  });
  console.log('Claude spawned to review mappings.');
}

/**
 * Run global spec enforcement for files that need checking (uses spec-file-mappings.json)
 * @param {object} args - Command line arguments
 */
function runGlobalEnforcement(args) {
  // Check daily agent cap first
  const agentCap = checkDailyAgentCap('global');

  if (!agentCap.allowed) {
    console.log(`[GLOBAL] Daily agent cap reached: ${agentCap.used}/${agentCap.limit} agents used today`);
    console.log('Adjust global.maxAgentsPerDay in compliance-config.json to increase limit');
    return;
  }

  console.log(`[GLOBAL] Daily agent budget: ${agentCap.used}/${agentCap.limit} used, ${agentCap.remaining} remaining\n`);

  // Load mappings
  const mappings = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));

  // Collect files that need checking
  const filesToCheck = [];

  for (const [specName, specData] of Object.entries(mappings.specs)) {
    for (const fileEntry of specData.files) {
      // Skip if within cooldown
      if (isWithinFileCooldown(fileEntry.lastVerified)) {
        continue;
      }

      // Check if file exists
      const filePath = path.join(projectDir, fileEntry.path);
      if (!fs.existsSync(filePath)) {
        console.warn(`Warning: File ${fileEntry.path} not found, skipping`);
        continue;
      }

      filesToCheck.push({
        spec: specName,
        file: fileEntry.path,
        priority: specData.priority
      });
    }
  }

  if (filesToCheck.length === 0) {
    console.log('[GLOBAL] No files need checking (all within cooldown period)');
    console.log('Adjust global.fileVerificationCooldownDays in compliance-config.json to change cooldown');
    return;
  }

  // Check if we have enough budget
  const needed = filesToCheck.length;
  if (needed > agentCap.remaining) {
    console.log(`Cannot spawn ${needed} agents (only ${agentCap.remaining} remaining in daily budget)`);
    console.log(`Files needing check: ${needed}`);
    console.log(`Files that will be checked today: ${agentCap.remaining}`);
    console.log('\nPrioritizing by spec priority and checking what we can...\n');

    // Sort by priority (critical > high > medium > low)
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    filesToCheck.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    // Take only what we can check
    filesToCheck.splice(agentCap.remaining);
  }

  if (args.dryRun) {
    console.log('DRY RUN - would check these files:\n');
    for (const item of filesToCheck) {
      console.log(`  [${item.priority.toUpperCase()}] ${item.spec}: ${item.file}`);
    }
    console.log(`\nTotal agents: ${filesToCheck.length}`);
    return;
  }

  // Spawn enforcement agents
  console.log(`Spawning ${filesToCheck.length} compliance enforcement agents...\n`);

  const promptPath = path.join(projectDir, '.claude/hooks/prompts/spec-enforcement.md');

  if (!fs.existsSync(promptPath)) {
    console.error(`Error: spec-enforcement.md prompt not found at ${promptPath}`);
    process.exit(1);
  }

  // Read spec files and store their paths
  const specContents = {};
  const specPaths = {};
  for (const item of filesToCheck) {
    if (!specContents[item.spec]) {
      // Try local specs first, then global specs, then reference specs
      let specPath = path.join(projectDir, 'specs/local', item.spec);
      if (!fs.existsSync(specPath)) {
        specPath = path.join(projectDir, 'specs/global', item.spec);
      }
      if (!fs.existsSync(specPath)) {
        specPath = path.join(projectDir, 'specs/reference', item.spec);
      }

      // Fail hard if spec file cannot be read (per CLAUDE.md - no graceful fallbacks)
      if (!fs.existsSync(specPath)) {
        throw new Error(`CRITICAL: Spec file '${item.spec}' not found in specs/local/, specs/global/, or specs/reference/. Cannot proceed with compliance checking without spec definition.`);
      }

      try {
        specContents[item.spec] = fs.readFileSync(specPath, 'utf8');
        // Store relative path for the agent to use when updating specs
        specPaths[item.spec] = specPath.replace(projectDir + '/', '');
      } catch (err) {
        throw new Error(`CRITICAL: Failed to read spec file '${item.spec}' at ${specPath}: ${err.message}. Per CLAUDE.md, no graceful fallbacks allowed.`);
      }
    }
  }

  // Group by spec for logging
  const bySpec = {};
  for (const item of filesToCheck) {
    if (!bySpec[item.spec]) bySpec[item.spec] = [];
    bySpec[item.spec].push(item.file);
  }

  // Spawn agents
  for (const item of filesToCheck) {
    const prompt = buildPrompt(promptPath, {
      FILE_PATH: item.file,
      SPEC_NAME: item.spec,
      SPEC_PATH: specPaths[item.spec],
      SPEC_CONTENT: specContents[item.spec]
    });

    spawnClaudeInstance(prompt, {
      COMPLIANCE_MODE: 'enforcement',
      COMPLIANCE_SPEC: item.spec,
      COMPLIANCE_FILE: item.file
    }, {
      type: AGENT_TYPES.COMPLIANCE_GLOBAL,
      description: `Global enforcement: ${item.file} against ${item.spec}`,
      metadata: { spec: item.spec, file: item.file, priority: item.priority }
    });

    console.log(`  ✓ Spawned for ${item.file} (${item.spec})`);

    // Update lastVerified timestamp
    updateFileVerificationTimestamp(item.spec, item.file);
  }

  // Record spawns in log (global specs enforcement)
  recordAgentSpawns('global', filesToCheck);

  console.log(`\n[GLOBAL] Spawned ${filesToCheck.length} enforcement agents`);
  console.log('Agents will run in background and report results when complete');
}

/**
 * Run local spec enforcement (no file mappings, agent explores codebase)
 * @param {object} args - Command line arguments
 */
async function runLocalEnforcement(args) {
  const state = readState();

  // Check daily agent cap first
  const agentCap = checkDailyAgentCap('local');

  if (!agentCap.allowed) {
    console.log(`[LOCAL] Daily agent cap reached: ${agentCap.used}/${agentCap.limit} agents used today`);
    console.log('Adjust local.maxAgentsPerDay in compliance-config.json to increase limit');
    return;
  }

  console.log(`[LOCAL] Daily agent budget: ${agentCap.used}/${agentCap.limit} used, ${agentCap.remaining} remaining\n`);

  // Read all .md files from specs/local/
  const specsLocalDir = path.join(projectDir, CONFIG.specsLocalDir);

  if (!fs.existsSync(specsLocalDir)) {
    console.log(`[LOCAL] specs/local/ directory not found at ${specsLocalDir}`);
    return;
  }

  const allSpecFiles = fs.readdirSync(specsLocalDir).filter(f => f.endsWith('.md'));

  if (allSpecFiles.length === 0) {
    console.log('[LOCAL] No spec files found in specs/local/');
    return;
  }

  // Filter out specs within cooldown
  const specsToRun = [];
  for (const specFile of allSpecFiles) {
    if (isWithinSpecCooldown(specFile, state)) {
      const lastRun = state.localSpecs.perSpecLastRun[specFile];
      const daysSince = Math.round((Date.now() - new Date(lastRun)) / (1000 * 60 * 60 * 24));
      console.log(`[LOCAL] Skipping ${specFile} (last run ${daysSince} days ago, cooldown: ${CONFIG.local.specCooldownDays} days)`);
      continue;
    }
    specsToRun.push(specFile);
  }

  if (specsToRun.length === 0) {
    console.log('[LOCAL] No specs need enforcement (all within cooldown period)');
    console.log('Adjust local.specCooldownDays in compliance-config.json to change cooldown');
    return;
  }

  // Respect daily agent cap (one agent per spec)
  const specsToRunToday = specsToRun.slice(0, agentCap.remaining);

  if (specsToRun.length > agentCap.remaining) {
    console.log(`[LOCAL] Cannot spawn agents for ${specsToRun.length} specs (only ${agentCap.remaining} remaining in daily budget)`);
    console.log(`[LOCAL] Will enforce first ${agentCap.remaining} specs today\n`);
  }

  if (args.dryRun) {
    console.log('[LOCAL] DRY RUN - would enforce these specs:\n');
    for (const specFile of specsToRunToday) {
      console.log(`  - ${specFile}`);
    }
    console.log(`\nTotal agents: ${specsToRunToday.length}`);
    return;
  }

  // Spawn enforcement agents
  console.log(`[LOCAL] Spawning ${specsToRunToday.length} local spec enforcement agents...\n`);

  const promptPath = path.join(projectDir, '.claude/hooks/prompts/local-spec-enforcement.md');

  if (!fs.existsSync(promptPath)) {
    console.error(`Error: local-spec-enforcement.md prompt not found at ${promptPath}`);
    process.exit(1);
  }

  const agentsSpawned = [];

  for (const specFile of specsToRunToday) {
    const specPath = path.join(specsLocalDir, specFile);
    const specContent = fs.readFileSync(specPath, 'utf8');
    const specRelativePath = path.join(CONFIG.specsLocalDir, specFile);

    const prompt = buildPrompt(promptPath, {
      SPEC_NAME: specFile,
      SPEC_PATH: specRelativePath,
      SPEC_CONTENT: specContent
    });

    spawnClaudeInstance(prompt, {
      COMPLIANCE_MODE: 'local-enforcement',
      COMPLIANCE_SPEC: specFile
    }, {
      type: AGENT_TYPES.COMPLIANCE_LOCAL,
      description: `Local enforcement: exploring codebase for ${specFile}`,
      metadata: { spec: specFile, specPath: specRelativePath }
    });

    console.log(`  ✓ Spawned for ${specFile}`);

    // Update last run timestamp
    updateSpecCooldown(specFile, state);

    agentsSpawned.push({
      spec: specFile,
      file: 'N/A (agent explores)', // Local enforcement doesn't target specific files
      priority: 'N/A'
    });
  }

  // Record spawns in log (local specs enforcement)
  recordAgentSpawns('local', agentsSpawned);

  console.log(`\n[LOCAL] Spawned ${specsToRunToday.length} enforcement agents`);
  console.log('Agents will explore codebase and report results when complete');
}

/**
 * Show status
 */
function showStatus() {
  const state = readState();
  const globalAgentCap = checkDailyAgentCap('global');
  const localAgentCap = checkDailyAgentCap('local');
  const mappings = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));

  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║              COMPLIANCE CHECKER STATUS                         ║');
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log('║ Daily Agent Budget (GLOBAL - mapped files)                    ║');
  console.log(`║   Used Today:      ${String(globalAgentCap.used).padStart(3)} / ${String(globalAgentCap.limit).padStart(3)}                                    ║`);
  console.log(`║   Remaining:       ${String(globalAgentCap.remaining).padStart(3)}                                            ║`);
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log('║ Daily Agent Budget (LOCAL - explore codebase)                 ║');
  console.log(`║   Used Today:      ${String(localAgentCap.used).padStart(3)} / ${String(localAgentCap.limit).padStart(3)}                                    ║`);
  console.log(`║   Remaining:       ${String(localAgentCap.remaining).padStart(3)}                                            ║`);
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log('║ Mapped Files                                                   ║');
  console.log(`║   Total Files:     ${String(mappings.totalMappedFiles).padStart(3)}                                            ║`);
  console.log(`║   Last Reviewed:   ${mappings.lastReviewed ? new Date(mappings.lastReviewed).toISOString().substring(0, 16).replace('T', ' ') : 'Never'.padEnd(16)}                        ║`);
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log('║ Global Spec Breakdown (mapped files)                          ║');

  for (const [spec, data] of Object.entries(mappings.specs)) {
    const filesNeedingCheck = data.files.filter(f => !isWithinFileCooldown(f.lastVerified)).length;
    const specStr = spec.substring(0, 20).padEnd(20);
    const filesStr = String(data.files.length).padStart(2);
    const needsStr = String(filesNeedingCheck).padStart(2);

    console.log(`║   ${specStr} ${filesStr} files (${needsStr} need check)              ║`);
  }

  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log('║ Local Spec Breakdown (explore codebase)                       ║');

  const specsLocalDir = path.join(projectDir, CONFIG.specsLocalDir);
  if (fs.existsSync(specsLocalDir)) {
    const localSpecFiles = fs.readdirSync(specsLocalDir).filter(f => f.endsWith('.md'));

    if (localSpecFiles.length === 0) {
      console.log('║   (no local specs found)                                       ║');
    } else {
      for (const specFile of localSpecFiles) {
        const needsEnforcement = !isWithinSpecCooldown(specFile, state);
        const specStr = specFile.substring(0, 20).padEnd(20);
        const statusStr = needsEnforcement ? 'needs check' : 'in cooldown';

        console.log(`║   ${specStr} ${statusStr.padEnd(20)}                   ║`);
      }
    }
  } else {
    console.log('║   (specs/local/ directory not found)                          ║');
  }

  console.log('╚═══════════════════════════════════════════════════════════════╝');
}

/**
 * Show enforcement history
 * @param {string} filter - 'all', 'global', or 'local'
 */
function showHistory(filter = 'all') {
  const log = readLog();

  if (!log.history || log.history.length === 0) {
    console.log('No enforcement history found.');
    return;
  }

  // Filter history by mode
  let filteredHistory = log.history;
  if (filter === 'global') {
    filteredHistory = log.history.filter(h => h.mode === 'global');
  } else if (filter === 'local') {
    filteredHistory = log.history.filter(h => h.mode === 'local');
  }

  if (filteredHistory.length === 0) {
    console.log(`No ${filter} enforcement history found.`);
    return;
  }

  const title = filter === 'all' ? 'ALL ENFORCEMENT' : `${filter.toUpperCase()} SPEC ENFORCEMENT`;
  console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
  console.log(`║              ${title} HISTORY                              ║`);
  console.log('╚═══════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  // Group by date and show sessions
  for (const session of filteredHistory.slice().reverse()) {
    const date = new Date(session.date);
    const dateStr = date.toISOString().substring(0, 19).replace('T', ' ');
    const modeLabel = session.mode === 'global' ? '[GLOBAL]' : '[LOCAL ]';

    console.log(`┌─────────────────────────────────────────────────────────────────────────────┐`);
    console.log(`│ ${modeLabel} ${dateStr}  (${session.count} agents spawned)`);
    console.log(`├─────────────────────────────────────────────────────────────────────────────┤`);

    if (session.agents && session.agents.length > 0) {
      // Group agents by spec
      const bySpec = {};
      for (const agent of session.agents) {
        if (!bySpec[agent.spec]) {
          bySpec[agent.spec] = [];
        }
        bySpec[agent.spec].push(agent.file);
      }

      for (const [spec, files] of Object.entries(bySpec)) {
        console.log(`│ ${spec}`);
        for (const file of files) {
          console.log(`│   └─ ${file}`);
        }
      }
    } else if (session.files) {
      // Legacy format support
      console.log(`│ ${session.spec || 'enforcement'}`);
      for (const file of session.files) {
        console.log(`│   └─ ${file}`);
      }
    }

    console.log(`└─────────────────────────────────────────────────────────────────────────────┘`);
    console.log('');
  }

  console.log(`Total sessions shown: ${filteredHistory.length}`);
}

/**
 * Main entry point
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Prevent chain reactions
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    console.log('Spawned session detected - skipping compliance check');
    process.exit(0);
  }

  // Show status
  if (args.status) {
    showStatus();
    process.exit(0);
  }

  // Show history
  if (args.history) {
    showHistory('all');
    process.exit(0);
  }
  if (args.historyGlobal) {
    showHistory('global');
    process.exit(0);
  }
  if (args.historyLocal) {
    showHistory('local');
    process.exit(0);
  }

  // Step 1: Validate mapping file (only for global enforcement)
  if (!args.localOnly) {
    console.log('Validating spec-file-mappings.json...\n');
    const validationResult = validateMappings(projectDir, CONFIG);

    if (!validationResult.valid) {
      handleMappingValidationFailure(validationResult);
      process.exit(2);
    }

    handleMappingValidationSuccess(validationResult);
  }

  // Step 2: Run enforcement (unless only showing status)
  if (!args.status) {
    console.log('\n═══════════════════════════════════════════════════════════════\n');
    console.log('Running compliance enforcement...\n');

    // Run global enforcement (mapped files)
    if (!args.localOnly) {
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('                    GLOBAL ENFORCEMENT');
      console.log('═══════════════════════════════════════════════════════════════\n');
      runGlobalEnforcement(args);
    }

    // Run local enforcement (explore codebase)
    if (!args.globalOnly) {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('                    LOCAL ENFORCEMENT');
      console.log('═══════════════════════════════════════════════════════════════\n');
      await runLocalEnforcement(args);
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('Compliance enforcement complete');
    console.log('═══════════════════════════════════════════════════════════════\n');
  }

  process.exit(0);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
