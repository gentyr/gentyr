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
import { registerSpawn, registerHookExecution, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { getCooldown } from './config-reader.js';

// Project directory
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Suites config path (optional feature)
const SUITES_CONFIG_PATH = path.join(projectDir, '.claude/hooks/suites-config.json');

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

// Overlay dynamic cooldowns from usage-optimizer (allows overdrive to scale these)
CONFIG.global.fileVerificationCooldownDays = getCooldown('compliance_checker_file', 10080) / (60 * 24);
CONFIG.local.specCooldownDays = getCooldown('compliance_checker_spec', 10080) / (60 * 24);

// State file paths
const STATE_FILE = path.join(projectDir, CONFIG.stateFile);
const LOG_FILE = path.join(projectDir, CONFIG.logFile);
const MAPPING_FILE = path.join(projectDir, CONFIG.mappingFile);

// ============================================================================
// Suite Config Support (Optional Feature)
// ============================================================================

/**
 * Load suites config from suites-config.json
 * Returns null if file doesn't exist (feature is optional)
 */
function loadSuitesConfig() {
  if (!fs.existsSync(SUITES_CONFIG_PATH)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(SUITES_CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`Failed to load suites-config.json: ${err.message}`);
    return null;
  }
}

/**
 * Simple glob pattern matching (minimatch-like)
 * Supports: *, **, ?
 */
function matchesGlob(filePath, pattern) {
  // Convert glob pattern to regex
  let regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars
    .replace(/\*\*/g, '{{DOUBLESTAR}}')     // Placeholder for **
    .replace(/\*/g, '[^/]*')                // * matches anything except /
    .replace(/\?/g, '[^/]')                 // ? matches single char except /
    .replace(/\{\{DOUBLESTAR\}\}/g, '.*');  // ** matches everything

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(filePath);
}

/**
 * Get all suites that match a file path
 * @param {string} filePath - Relative path to check
 * @param {object} suitesConfig - Loaded suites config (or null)
 * @returns {Array<{id: string, ...suite}>} Array of matching suites
 */
function getSuitesForFile(filePath, suitesConfig) {
  if (!suitesConfig) return [];

  const matches = [];
  for (const [suiteId, suite] of Object.entries(suitesConfig.suites)) {
    if (!suite.enabled) continue;
    if (matchesGlob(filePath, suite.scope)) {
      matches.push({ id: suiteId, ...suite });
    }
  }
  return matches;
}

/**
 * Get ALL specs that apply to a file (main specs + subspecs)
 * Single function used by enforcement - DRY principle
 *
 * @param {string} filePath - Relative path to check
 * @param {object} mappings - Loaded spec-file-mappings.json
 * @param {object} suitesConfig - Loaded suites config (or null)
 * @returns {Array<{name: string, dir: string, priority: string, lastVerified: string|null, suiteId: string|null, suiteScope: string|null}>}
 */
function getAllApplicableSpecs(filePath, mappings, suitesConfig) {
  const specs = [];

  // 1. Main specs from spec-file-mappings.json (existing behavior)
  for (const [specName, specData] of Object.entries(mappings.specs || {})) {
    const fileEntry = specData.files?.find(f => f.path === filePath);
    if (fileEntry) {
      specs.push({
        name: specName,
        dir: CONFIG.specsGlobalDir,  // specs/global by default
        priority: specData.priority,
        lastVerified: fileEntry.lastVerified,
        suiteId: null,  // null = main spec
        suiteScope: null
      });
    }
  }

  // 2. Subspecs from matching suites (extension)
  if (suitesConfig) {
    const matchingSuites = getSuitesForFile(filePath, suitesConfig);
    for (const suite of matchingSuites) {
      if (!suite.mappedSpecs) continue;
      const specsDir = path.join(projectDir, suite.mappedSpecs.dir);
      if (!fs.existsSync(specsDir)) continue;

      const pattern = suite.mappedSpecs.pattern || '*.md';
      const specFiles = fs.readdirSync(specsDir).filter(f => {
        if (!f.endsWith('.md')) return false;
        return matchesGlob(f, pattern);
      });

      for (const specFile of specFiles) {
        specs.push({
          name: specFile,
          dir: suite.mappedSpecs.dir,
          priority: suite.priority || 'medium',
          lastVerified: null,  // TODO: track per-suite cooldowns
          suiteId: suite.id,
          suiteScope: suite.scope
        });
      }
    }
  }

  return specs;
}

/**
 * Get ALL exploratory specs (main local specs + suite exploratory specs)
 * Single function used by local enforcement - DRY principle
 *
 * @param {object} suitesConfig - Loaded suites config (or null)
 * @returns {Array<{name: string, dir: string, suiteId: string|null, suiteScope: string}>}
 */
function getAllExploratorySpecs(suitesConfig) {
  const specs = [];

  // 1. Main local specs (existing behavior)
  const mainLocalDir = path.join(projectDir, CONFIG.specsLocalDir);
  if (fs.existsSync(mainLocalDir)) {
    const files = fs.readdirSync(mainLocalDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      specs.push({
        name: f,
        dir: CONFIG.specsLocalDir,
        suiteId: null,
        suiteScope: '**/*'  // main local specs explore entire codebase
      });
    }
  }

  // 2. Suite exploratory specs (extension)
  if (suitesConfig) {
    for (const [suiteId, suite] of Object.entries(suitesConfig.suites)) {
      if (!suite.enabled || !suite.exploratorySpecs) continue;
      const specsDir = path.join(projectDir, suite.exploratorySpecs.dir);
      if (!fs.existsSync(specsDir)) continue;

      const pattern = suite.exploratorySpecs.pattern || '*.md';
      const specFiles = fs.readdirSync(specsDir).filter(f => {
        if (!f.endsWith('.md')) return false;
        return matchesGlob(f, pattern);
      });

      for (const specFile of specFiles) {
        specs.push({
          name: specFile,
          dir: suite.exploratorySpecs.dir,
          suiteId: suiteId,
          suiteScope: suite.scope  // agent explores only within this scope
        });
      }
    }
  }

  return specs;
}

// ============================================================================
// Command Line Parsing
// ============================================================================

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
 * Run global spec enforcement for files that need checking (uses spec-file-mappings.json + suites)
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

  // Load mappings and suites config
  const mappings = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
  const suitesConfig = loadSuitesConfig();  // null if not configured

  if (suitesConfig) {
    const suiteCount = Object.keys(suitesConfig.suites).length;
    console.log(`[GLOBAL] Loaded ${suiteCount} suite(s) from suites-config.json\n`);
  }

  // Collect ALL files from mappings
  const allFiles = new Set();
  for (const specData of Object.values(mappings.specs || {})) {
    for (const fileEntry of specData.files || []) {
      allFiles.add(fileEntry.path);
    }
  }

  // Collect files that need checking with their applicable specs
  const filesToCheck = [];

  for (const filePath of allFiles) {
    // Check if file exists
    const fullPath = path.join(projectDir, filePath);
    if (!fs.existsSync(fullPath)) {
      console.warn(`Warning: File ${filePath} not found, skipping`);
      continue;
    }

    // Get ALL specs for this file (main + subspecs) - UNIFIED
    const applicableSpecs = getAllApplicableSpecs(filePath, mappings, suitesConfig);

    for (const spec of applicableSpecs) {
      // Skip if within cooldown
      if (isWithinFileCooldown(spec.lastVerified)) {
        continue;
      }

      filesToCheck.push({
        spec: spec.name,
        specDir: spec.dir,
        file: filePath,
        priority: spec.priority,
        suiteId: spec.suiteId,
        suiteScope: spec.suiteScope
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
      const suiteInfo = item.suiteId ? ` [suite: ${item.suiteId}]` : '';
      console.log(`  [${item.priority.toUpperCase()}] ${item.spec}: ${item.file}${suiteInfo}`);
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

  // Read spec files and store their paths (keyed by dir+name for uniqueness)
  const specContents = {};
  const specPaths = {};
  for (const item of filesToCheck) {
    const specKey = `${item.specDir}/${item.spec}`;
    if (!specContents[specKey]) {
      // Use the spec's directory (from suite or default)
      let specPath = path.join(projectDir, item.specDir, item.spec);

      // Fallback search order for main specs only (not suite specs)
      if (!item.suiteId && !fs.existsSync(specPath)) {
        specPath = path.join(projectDir, 'specs/local', item.spec);
        if (!fs.existsSync(specPath)) {
          specPath = path.join(projectDir, 'specs/global', item.spec);
        }
        if (!fs.existsSync(specPath)) {
          specPath = path.join(projectDir, 'specs/reference', item.spec);
        }
      }

      // Fail hard if spec file cannot be read (per CLAUDE.md - no graceful fallbacks)
      if (!fs.existsSync(specPath)) {
        throw new Error(`CRITICAL: Spec file '${item.spec}' not found in ${item.specDir}. Cannot proceed with compliance checking without spec definition.`);
      }

      try {
        specContents[specKey] = fs.readFileSync(specPath, 'utf8');
        // Store relative path for the agent to use when updating specs
        specPaths[specKey] = specPath.replace(projectDir + '/', '');
      } catch (err) {
        throw new Error(`CRITICAL: Failed to read spec file '${item.spec}' at ${specPath}: ${err.message}. Per CLAUDE.md, no graceful fallbacks allowed.`);
      }
    }
  }

  // Spawn agents
  for (const item of filesToCheck) {
    const specKey = `${item.specDir}/${item.spec}`;

    // Build prompt with optional suite context
    const promptVars = {
      FILE_PATH: item.file,
      SPEC_NAME: item.spec,
      SPEC_PATH: specPaths[specKey],
      SPEC_CONTENT: specContents[specKey]
    };

    // Add suite context if this is a subspec
    if (item.suiteId) {
      promptVars.SUITE_ID = item.suiteId;
      promptVars.SUITE_SCOPE = item.suiteScope;
    }

    const prompt = buildPrompt(promptPath, promptVars);

    const suiteInfo = item.suiteId ? ` [suite: ${item.suiteId}]` : '';
    spawnClaudeInstance(prompt, {
      COMPLIANCE_MODE: 'enforcement',
      COMPLIANCE_SPEC: item.spec,
      COMPLIANCE_FILE: item.file,
      COMPLIANCE_SUITE: item.suiteId || ''
    }, {
      type: AGENT_TYPES.COMPLIANCE_GLOBAL,
      description: `Global enforcement: ${item.file} against ${item.spec}${suiteInfo}`,
      metadata: { spec: item.spec, file: item.file, priority: item.priority, suiteId: item.suiteId }
    });

    console.log(`  ✓ Spawned for ${item.file} (${item.spec})${suiteInfo}`);

    // Update lastVerified timestamp (only for main specs)
    if (!item.suiteId) {
      updateFileVerificationTimestamp(item.spec, item.file);
    }
  }

  // Record spawns in log (global specs enforcement)
  recordAgentSpawns('global', filesToCheck);

  console.log(`\n[GLOBAL] Spawned ${filesToCheck.length} enforcement agents`);
  console.log('Agents will run in background and report results when complete');
}

/**
 * Run local spec enforcement (no file mappings, agent explores codebase + suites)
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

  // Load suites config (optional)
  const suitesConfig = loadSuitesConfig();

  // Get ALL exploratory specs (main + suites) - UNIFIED
  const allSpecs = getAllExploratorySpecs(suitesConfig);

  if (allSpecs.length === 0) {
    console.log('[LOCAL] No exploratory specs found');
    return;
  }

  if (suitesConfig) {
    const suiteSpecs = allSpecs.filter(s => s.suiteId);
    if (suiteSpecs.length > 0) {
      console.log(`[LOCAL] Found ${allSpecs.length} specs (${allSpecs.length - suiteSpecs.length} main + ${suiteSpecs.length} from suites)\n`);
    }
  }

  // Filter out specs within cooldown
  const specsToRun = [];
  for (const spec of allSpecs) {
    // Use suite:specName as cooldown key for suite specs
    const cooldownKey = spec.suiteId ? `${spec.suiteId}:${spec.name}` : spec.name;
    if (isWithinSpecCooldown(cooldownKey, state)) {
      const lastRun = state.localSpecs.perSpecLastRun[cooldownKey];
      const daysSince = Math.round((Date.now() - new Date(lastRun)) / (1000 * 60 * 60 * 24));
      const suiteInfo = spec.suiteId ? ` [suite: ${spec.suiteId}]` : '';
      console.log(`[LOCAL] Skipping ${spec.name}${suiteInfo} (last run ${daysSince} days ago, cooldown: ${CONFIG.local.specCooldownDays} days)`);
      continue;
    }
    specsToRun.push(spec);
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
    for (const spec of specsToRunToday) {
      const suiteInfo = spec.suiteId ? ` [suite: ${spec.suiteId}, scope: ${spec.suiteScope}]` : '';
      console.log(`  - ${spec.name}${suiteInfo}`);
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

  for (const spec of specsToRunToday) {
    const specPath = path.join(projectDir, spec.dir, spec.name);
    const specContent = fs.readFileSync(specPath, 'utf8');
    const specRelativePath = path.join(spec.dir, spec.name);

    // Build prompt with optional suite context
    const promptVars = {
      SPEC_NAME: spec.name,
      SPEC_PATH: specRelativePath,
      SPEC_CONTENT: specContent
    };

    // Add suite context if this is a suite exploratory spec
    if (spec.suiteId) {
      promptVars.SUITE_ID = spec.suiteId;
      promptVars.SUITE_SCOPE = spec.suiteScope;
    }

    const prompt = buildPrompt(promptPath, promptVars);

    const suiteInfo = spec.suiteId ? ` [suite: ${spec.suiteId}]` : '';
    spawnClaudeInstance(prompt, {
      COMPLIANCE_MODE: 'local-enforcement',
      COMPLIANCE_SPEC: spec.name,
      COMPLIANCE_SUITE: spec.suiteId || ''
    }, {
      type: AGENT_TYPES.COMPLIANCE_LOCAL,
      description: `Local enforcement: exploring for ${spec.name}${suiteInfo}`,
      metadata: { spec: spec.name, specPath: specRelativePath, suiteId: spec.suiteId, suiteScope: spec.suiteScope }
    });

    console.log(`  ✓ Spawned for ${spec.name}${suiteInfo}`);

    // Update last run timestamp (use suite:specName for suite specs)
    const cooldownKey = spec.suiteId ? `${spec.suiteId}:${spec.name}` : spec.name;
    updateSpecCooldown(cooldownKey, state);

    agentsSpawned.push({
      spec: spec.name,
      file: spec.suiteScope || '**/* (agent explores)',
      priority: 'N/A',
      suiteId: spec.suiteId
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
  const startTime = Date.now();
  const args = parseArgs(process.argv.slice(2));

  // Prevent chain reactions
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    console.log('Spawned session detected - skipping compliance check');
    registerHookExecution({
      hookType: HOOK_TYPES.COMPLIANCE_CHECKER,
      status: 'skipped',
      durationMs: Date.now() - startTime,
      metadata: { reason: 'spawned_session' }
    });
    process.exit(0);
  }

  // Show status
  if (args.status) {
    showStatus();
    registerHookExecution({
      hookType: HOOK_TYPES.COMPLIANCE_CHECKER,
      status: 'success',
      durationMs: Date.now() - startTime,
      metadata: { mode: 'status' }
    });
    process.exit(0);
  }

  // Show history
  if (args.history) {
    showHistory('all');
    registerHookExecution({
      hookType: HOOK_TYPES.COMPLIANCE_CHECKER,
      status: 'success',
      durationMs: Date.now() - startTime,
      metadata: { mode: 'history' }
    });
    process.exit(0);
  }
  if (args.historyGlobal) {
    showHistory('global');
    registerHookExecution({
      hookType: HOOK_TYPES.COMPLIANCE_CHECKER,
      status: 'success',
      durationMs: Date.now() - startTime,
      metadata: { mode: 'history-global' }
    });
    process.exit(0);
  }
  if (args.historyLocal) {
    showHistory('local');
    registerHookExecution({
      hookType: HOOK_TYPES.COMPLIANCE_CHECKER,
      status: 'success',
      durationMs: Date.now() - startTime,
      metadata: { mode: 'history-local' }
    });
    process.exit(0);
  }

  // Step 1: Validate mapping file (only for global enforcement)
  if (!args.localOnly) {
    console.log('Validating spec-file-mappings.json...\n');
    const validationResult = validateMappings(projectDir, CONFIG);

    if (!validationResult.valid) {
      handleMappingValidationFailure(validationResult);
      registerHookExecution({
        hookType: HOOK_TYPES.COMPLIANCE_CHECKER,
        status: 'failure',
        durationMs: Date.now() - startTime,
        metadata: { reason: 'mapping_validation_failed', errorCount: validationResult.errors?.length }
      });
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

  registerHookExecution({
    hookType: HOOK_TYPES.COMPLIANCE_CHECKER,
    status: 'success',
    durationMs: Date.now() - startTime,
    metadata: { globalOnly: args.globalOnly, localOnly: args.localOnly, dryRun: args.dryRun }
  });

  process.exit(0);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  registerHookExecution({
    hookType: HOOK_TYPES.COMPLIANCE_CHECKER,
    status: 'failure',
    durationMs: 0,
    metadata: { error: err.message }
  });
  process.exit(1);
});
