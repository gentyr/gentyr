#!/usr/bin/env node
/**
 * Hourly Automation Runner
 *
 * Wrapper script called by systemd/launchd hourly service.
 * Delegates to individual automation scripts based on config.
 *
 * This design allows changing behavior without re-installing the service.
 *
 * Automations:
 * 1. Plan Executor - Execute pending project plans
 * 2. CLAUDE.md Refactor - Compact CLAUDE.md when it exceeds size threshold
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { spawn, execSync, execFileSync } from 'child_process';
import { registerSpawn, updateAgent, registerHookExecution, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { enqueueSession, drainQueue } from './lib/session-queue.js';
import { getCooldown } from './config-reader.js';
import { runFeedbackPipeline, startFeedbackRun, personaRanRecently } from './feedback-orchestrator.js';
import { createWorktree, cleanupMergedWorktrees, listWorktrees, removeWorktree } from './lib/worktree-manager.js';
import { killProcessGroup, isClaudeProcess } from './lib/process-tree.js';
import { getFeatureBranchName } from './lib/feature-branch-helper.js';
import { detectStaleWork, formatReport } from './stale-work-detector.js';
import { reviveInterruptedSessions } from './session-reviver.js';
import { buildPersistentMonitorDemoInstructions } from './lib/persistent-monitor-demo-instructions.js';
import { reapAsyncPass, getStuckAliveSessions } from './lib/session-reaper.js';
import { buildRevivalContext } from './lib/persistent-revival-context.js';
import { buildPersistentMonitorRevivalPrompt } from './lib/persistent-monitor-revival-prompt.js';
import { auditEvent, cleanupAuditLog } from './lib/session-audit.js';
import { debugLog, cleanupDebugLog } from './lib/debug-log.js';
import { buildSpawnEnv } from './lib/spawn-env.js';
import { resolveUserPrompts } from './lib/user-prompt-resolver.js';
import { buildStrictInfraGuidancePrompt } from './lib/strict-infra-guidance-prompt.js';
import { resolveCategory, buildPromptFromCategory } from './lib/task-category.js';
import { isLocalModeEnabled } from '../../lib/shared-mcp-config.js';
// shouldAllowSpawn import removed — session queue handles memory pressure internally

// Try to import better-sqlite3 for task runner
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (err) {
  // Non-fatal: task runner will be skipped if unavailable
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_FILE = path.join(PROJECT_DIR, '.claude', 'autonomous-mode.json');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'hourly-automation.log');
const STATE_FILE = path.join(PROJECT_DIR, '.claude', 'hourly-automation-state.json');
const CTO_REPORTS_DB = path.join(PROJECT_DIR, '.claude', 'cto-reports.db');

// Thresholds
const CLAUDE_MD_SIZE_THRESHOLD = 25000; // 25K characters
// Note: Per-item cooldown (1 hour) is now handled by the agent-reports MCP server

// Task Runner: section-to-agent mapping
const SECTION_AGENT_MAP = {
  'CODE-REVIEWER': { agent: 'code-reviewer', agentType: AGENT_TYPES.TASK_RUNNER_CODE_REVIEWER },
  'INVESTIGATOR & PLANNER': { agent: 'investigator', agentType: AGENT_TYPES.TASK_RUNNER_INVESTIGATOR },
  'TEST-WRITER': { agent: 'test-writer', agentType: AGENT_TYPES.TASK_RUNNER_TEST_WRITER },
  'PROJECT-MANAGER': { agent: 'project-manager', agentType: AGENT_TYPES.TASK_RUNNER_PROJECT_MANAGER },
  'DEPUTY-CTO': { agent: 'deputy-cto', agentType: AGENT_TYPES.TASK_RUNNER_DEPUTY_CTO },
  'PRODUCT-MANAGER': { agent: 'product-manager', agentType: AGENT_TYPES.TASK_RUNNER_PRODUCT_MANAGER },
  'DEMO-MANAGER': { agent: 'demo-manager', agentType: AGENT_TYPES.TASK_RUNNER_DEMO_MANAGER },
};
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');

// Category-aware agent mapping (uses shared module, falls back to SECTION_AGENT_MAP)
function getAgentMapping(task) {
  const category = resolveCategory(TODO_DB_PATH, {
    category_id: task.category_id,
    section: task.section,
  });
  if (category) {
    return {
      agent: 'task-runner',
      agentType: AGENT_TYPES.TASK_RUNNER,
      category,
    };
  }
  // Fallback to legacy section map
  const mapping = SECTION_AGENT_MAP[task.section];
  return mapping ? { ...mapping, category: null } : null;
}

// Concurrency guard: max simultaneous automation agents
const MAX_CONCURRENT_AGENTS = 5;
const MAX_TASKS_PER_CYCLE = 3;

// ---------------------------------------------------------------------------
// CREDENTIAL CACHE: Lazily resolve 1Password credentials on first agent spawn.
// Credentials exist only in this process's memory and are passed to child
// processes via environment variables. MCP servers (started by Claude CLI
// from .mcp.json env blocks) skip `op read` when the credential is already
// in process.env.
//
// Lazy resolution means credentials are NOT resolved on cycles where all
// tasks hit cooldowns and no agents are spawned (~90% of cycles). This
// eliminates unnecessary `op` CLI calls that trigger macOS TCC prompts
// ("node would like to access data from other apps") and 1Password Touch ID
// prompts in background/launchd contexts.
// ---------------------------------------------------------------------------
let resolvedCredentials = {};
let credentialsResolved = false;

/**
 * Parse a SQLite datetime string as UTC.
 * SQLite's datetime('now') produces "YYYY-MM-DD HH:MM:SS" (UTC, no Z suffix).
 * JavaScript's new Date() parses this as local time without timezone indicator.
 * This helper ensures correct UTC interpretation.
 */
function parseSqliteDatetime(str) {
  if (!str) return new Date(NaN);
  if (str.includes('T')) return new Date(str); // Already ISO 8601
  return new Date(str.replace(' ', 'T') + 'Z');
}

/**
 * Ensure credentials have been resolved (lazy, called only when spawning).
 * Wraps preResolveCredentials() with a guard flag so it runs at most once
 * per automation cycle.
 */
function ensureCredentials() {
  if (credentialsResolved) return;
  credentialsResolved = true;
  preResolveCredentials();
}

/**
 * Preflight check: verify that the 3 infrastructure credentials required by
 * health monitor agents are available (either resolved from 1Password or
 * already present in process.env).  Returns false and logs a message when
 * any are missing, so the caller can skip the spawn.
 */
function hasHealthMonitorCredentials() {
  ensureCredentials();
  const required = ['RENDER_API_KEY', 'VERCEL_TOKEN', 'ELASTIC_API_KEY'];
  const missing = required.filter(k => !resolvedCredentials[k] && !process.env[k]);
  if (missing.length > 0) {
    log(`Health monitor preflight: missing ${missing.join(', ')}. Skipping spawn.`);
    log('Health monitor preflight: reinstall with: setup-automation-service.sh setup --op-token <TOKEN>');
    return false;
  }
  return true;
}

/**
 * Pre-resolve all 1Password credentials needed by infrastructure MCP servers.
 * Reads vault-mappings.json for op:// references and protected-actions.json
 * for which keys each server needs. Calls `op read` once per unique reference.
 * Results are cached in `resolvedCredentials` (in-memory only, never on disk).
 *
 * In headless contexts (launchd/systemd), skips `op read` calls unless
 * OP_SERVICE_ACCOUNT_TOKEN is set, to prevent macOS permission prompts.
 */
function preResolveCredentials() {
  // Headless guard: In launchd/systemd contexts, `op` communicates with the
  // 1Password desktop app via IPC, triggering macOS TCC and Touch ID prompts.
  // OP_SERVICE_ACCOUNT_TOKEN uses the 1Password API directly (no desktop app).
  const hasServiceAccount = !!process.env.OP_SERVICE_ACCOUNT_TOKEN;
  const isLaunchdService = process.env.GENTYR_LAUNCHD_SERVICE === 'true';

  if (isLaunchdService && !hasServiceAccount) {
    log('Credential cache: headless mode without OP_SERVICE_ACCOUNT_TOKEN — skipping op read to prevent macOS prompts.');
    log('Credential cache: spawned agents will start MCP servers without pre-resolved credentials.');
    log('Credential cache: for full headless credentials, reinstall with: setup-automation-service.sh setup --op-token <TOKEN>');
    return;
  }

  const mappingsPath = path.join(PROJECT_DIR, '.claude', 'vault-mappings.json');
  const actionsPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'protected-actions.json');

  let mappings = {};
  let servers = {};

  try {
    const data = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    mappings = data.mappings || {};
  } catch (err) {
    console.error('[hourly-automation] Warning:', err.message);
    log('Credential cache: no vault-mappings.json, skipping pre-resolution.');
    return;
  }

  try {
    const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
    servers = actions.servers || {};
  } catch (err) {
    console.error('[hourly-automation] Warning:', err.message);
    log('Credential cache: no protected-actions.json, skipping pre-resolution.');
    return;
  }

  // Collect all unique credential keys across all servers
  const allKeys = new Set();
  for (const server of Object.values(servers)) {
    if (server.credentialKeys) {
      for (const key of server.credentialKeys) {
        allKeys.add(key);
      }
    }
  }

  let resolved = 0;
  let skipped = 0;
  let failed = 0;

  for (const key of allKeys) {
    // Skip if already in environment
    if (process.env[key]) {
      skipped++;
      continue;
    }

    const ref = mappings[key];
    if (!ref) continue;

    if (ref.startsWith('op://')) {
      try {
        const value = execFileSync('op', ['read', ref], {
          encoding: 'utf-8',
          timeout: 15000,
          stdio: 'pipe',
        }).trim();

        if (value) {
          resolvedCredentials[key] = value;
          resolved++;
        }
      } catch (err) {
        failed++;
        log(`Credential cache: failed to resolve ${key} from ${ref}: ${err.message || err}`);
      }
    } else {
      // Direct value (non-secret like URL, zone ID)
      resolvedCredentials[key] = ref;
      resolved++;
    }
  }

  if (allKeys.size > 0) {
    log(`Credential cache: resolved ${resolved}/${allKeys.size} credentials (${skipped} from env, ${failed} failed).`);
  }
}

/**
 * Read .claude/config/services.json and return parsed contents.
 * Returns null on any failure (file missing, unreadable, invalid JSON).
 *
 * The Node process running hourly-automation.js is NOT subject to the
 * credential-file-guard hook (that only applies to AI agent tool use),
 * so it can read services.json directly via the filesystem.
 */
function readServiceConfig() {
  const configPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    log(`readServiceConfig: failed to read ${configPath}: ${err.message}`);
    return null;
  }
}

/**
 * Extract Render service ID from a services.json render entry.
 * Handles both formats:
 *   - Object form: { "serviceId": "srv-xxx", "label": "..." }
 *   - String form: "srv-xxx"
 */
function extractRenderServiceId(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && entry.serviceId) return entry.serviceId;
  return null;
}

// buildSpawnEnv() is imported from lib/spawn-env.js above.
// It's used directly for non-Claude process spawns (e.g., demo validation playwright runs).
// For Claude agent spawns, buildSpawnEnv is called internally by enqueueSession.
// Credentials are passed via extraEnv after ensureCredentials() is called by each spawner.

/**
 * Append to log file
 */
function log(message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, logLine);
}

/**
 * Get config (autonomous mode settings)
 *
 * G001 Note: If config is corrupted, we use safe defaults (enabled: false).
 * This is intentional fail-safe behavior - corrupt config should NOT enable automation.
 * The corruption is logged prominently for CTO awareness.
 */
function getConfig() {
  const defaults = {
    enabled: false,
    claudeMdRefactorEnabled: true,
    lintCheckerEnabled: true,
    taskRunnerEnabled: true,
    standaloneAntipatternHunterEnabled: true,
    standaloneComplianceCheckerEnabled: true,
    productManagerEnabled: false,
    demoValidationEnabled: false,
    dailyFeedbackEnabled: false,
    lastModified: null,
    intervals: {},
  };

  if (!fs.existsSync(CONFIG_FILE)) {
    return defaults;
  }

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const mergedIntervals = { ...defaults.intervals, ...(config.intervals || {}) };
    return { ...defaults, ...config, intervals: mergedIntervals };
  } catch (err) {
    // G001: Config corruption is logged but we fail-safe to disabled mode
    // This is intentional - corrupt config should never enable automation
    log(`ERROR: Config file corrupted - automation DISABLED for safety: ${err.message}`);
    log(`Fix: Delete or repair ${CONFIG_FILE}`);
    return defaults;
  }
}

/**
 * Check CTO activity gate.
 * G001: Fail-closed - if lastCtoBriefing is missing or older than 24h, automation is gated.
 *
 * @returns {{ open: boolean, reason: string, hoursSinceLastBriefing: number | null }}
 */
function checkCtoActivityGate(config) {
  const lastCtoBriefing = config.lastCtoBriefing;

  if (!lastCtoBriefing) {
    return {
      open: false,
      reason: 'No CTO briefing recorded. Start a Claude Code session or run /deputy-cto to activate.',
      hoursSinceLastBriefing: null,
    };
  }

  try {
    const briefingTime = new Date(lastCtoBriefing).getTime();
    if (isNaN(briefingTime)) {
      return {
        open: false,
        reason: 'CTO briefing timestamp is invalid. Start a Claude Code session or run /deputy-cto to reset.',
        hoursSinceLastBriefing: null,
      };
    }

    const hoursSince = (Date.now() - briefingTime) / (1000 * 60 * 60);
    if (hoursSince >= 24) {
      return {
        open: false,
        reason: `CTO briefing was ${Math.floor(hoursSince)}h ago (>24h). Start a Claude Code session or run /deputy-cto to reactivate.`,
        hoursSinceLastBriefing: Math.floor(hoursSince),
      };
    }

    return {
      open: true,
      reason: `CTO briefing was ${Math.floor(hoursSince)}h ago. Gate is open.`,
      hoursSinceLastBriefing: Math.floor(hoursSince),
    };
  } catch (err) {
    // G001: Parse error = fail closed
    return {
      open: false,
      reason: `Failed to parse CTO briefing timestamp: ${err.message}`,
      hoursSinceLastBriefing: null,
    };
  }
}

// ---------------------------------------------------------------------------
// GAP 2: PERSISTENT ALERTS SYSTEM
// Tracks recurring issues (production errors, CI failures, merge chain gaps)
// with automatic re-escalation when issues persist beyond thresholds.
// ---------------------------------------------------------------------------
const PERSISTENT_ALERTS_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent_alerts.json');
const ALERT_RE_ESCALATION_HOURS = { critical: 4, high: 12, medium: 24 };
const ALERT_RESOLVED_GC_DAYS = 7;
const MERGE_CHAIN_GAP_THRESHOLD = 50;

/**
 * Read persistent alerts state file. Returns default structure if missing/corrupt.
 */
function readPersistentAlerts() {
  try {
    if (fs.existsSync(PERSISTENT_ALERTS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(PERSISTENT_ALERTS_PATH, 'utf8'));
      // Validate structure
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw) ||
          typeof raw.alerts !== 'object' || raw.alerts === null || Array.isArray(raw.alerts)) {
        log('Persistent alerts: invalid structure, using defaults.');
        return { version: 1, alerts: {} };
      }
      // Validate individual alerts — drop malformed entries
      for (const [key, alert] of Object.entries(raw.alerts)) {
        if (typeof alert !== 'object' || alert === null ||
            typeof alert.severity !== 'string' ||
            typeof alert.resolved !== 'boolean') {
          log(`Persistent alerts: dropping malformed alert '${key}'.`);
          delete raw.alerts[key];
        }
      }
      return raw;
    }
  } catch (err) {
    log(`Persistent alerts: failed to read state (${err.message}), using defaults.`);
  }
  return { version: 1, alerts: {} };
}

/**
 * Write persistent alerts state file.
 */
function writePersistentAlerts(data) {
  try {
    const dir = path.dirname(PERSISTENT_ALERTS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PERSISTENT_ALERTS_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    log(`Persistent alerts: failed to write state: ${err.message}`);
  }
}

/**
 * Record or update a persistent alert.
 * @param {string} key - Alert key (e.g., 'production_error', 'ci_main_failure')
 * @param {object} opts - { title, severity, source }
 */
function recordAlert(key, { title, severity, source }) {
  const data = readPersistentAlerts();
  const now = new Date().toISOString();

  if (data.alerts[key] && !data.alerts[key].resolved) {
    // Update existing unresolved alert
    data.alerts[key].last_detected_at = now;
    data.alerts[key].detection_count += 1;
    data.alerts[key].title = title;
  } else {
    // Create new alert (or replace resolved one)
    data.alerts[key] = {
      key,
      title,
      severity,
      first_detected_at: now,
      last_detected_at: now,
      last_escalated_at: null,
      detection_count: 1,
      escalation_count: 0,
      resolved: false,
      resolved_at: null,
      source,
    };
  }

  writePersistentAlerts(data);
  return data.alerts[key];
}

/**
 * Resolve a persistent alert if it exists and is unresolved.
 */
function resolveAlert(key) {
  const data = readPersistentAlerts();
  if (data.alerts[key] && !data.alerts[key].resolved) {
    data.alerts[key].resolved = true;
    data.alerts[key].resolved_at = new Date().toISOString();
    writePersistentAlerts(data);
    log(`Persistent alerts: resolved '${key}'.`);
  }
}

/**
 * Sanitize an alert field for safe prompt interpolation.
 * Strips backticks, newlines, and template-like syntax to prevent prompt injection.
 */
function sanitizeAlertField(val) {
  if (typeof val !== 'string') return String(val ?? '');
  return val.replace(/[`\n\r]/g, '').replace(/\$\{/g, '$ {').slice(0, 200);
}

/**
 * Spawn a minimal re-escalation agent that posts to deputy-CTO.
 */
function spawnAlertEscalation(alert) {
  // Sanitize all alert fields before any interpolation to prevent prompt injection
  const safeTitle = sanitizeAlertField(alert.title);
  const safeKey = sanitizeAlertField(alert.key);
  const safeSeverity = sanitizeAlertField(alert.severity);
  const safeSource = sanitizeAlertField(alert.source);
  const safeFirstDetected = sanitizeAlertField(alert.first_detected_at);
  const safeDetectionCount = Number(alert.detection_count) || 0;
  const safeEscalationCount = Number(alert.escalation_count) || 0;

  const firstDetectedTs = new Date(alert.first_detected_at).getTime();
  const ageHours = Number.isFinite(firstDetectedTs) ? Math.round((Date.now() - firstDetectedTs) / 3600000) : 0;

  ensureCredentials();
  enqueueSession({
    title: `Alert re-escalation: ${safeKey}`,
    agentType: AGENT_TYPES.PRODUCTION_HEALTH_MONITOR,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    tagContext: 'alert-escalation',
    source: 'hourly-automation',
    priority: 'low',
    buildPrompt: (agentId) => `[Automation][alert-escalation][AGENT:${agentId}] ALERT RE-ESCALATION

A persistent issue has NOT been resolved and requires CTO attention.

**Alert:** ${safeTitle}
**Key:** ${safeKey}
**Severity:** ${safeSeverity}
**First detected:** ${safeFirstDetected} (${ageHours}h ago)
**Detection count:** ${safeDetectionCount} times
**Previous escalations:** ${safeEscalationCount}

Call \`mcp__deputy-cto__add_question\` with:
- type: "escalation"
- title: "PERSISTENT: ${safeTitle} (${ageHours}h, ${safeDetectionCount} detections)"
- description: "This issue was first detected ${ageHours}h ago and has been detected ${safeDetectionCount} times. It has been escalated ${safeEscalationCount} time(s) previously but remains unresolved. Source: ${safeSource}."
- recommendation: "Investigate and resolve the ${safeKey} issue. Previous escalations were cleared but the underlying problem persists."

Then exit immediately.`,
    extraEnv: { ...resolvedCredentials },
    metadata: { alertKey: safeKey, escalationCount: safeEscalationCount },
    projectDir: PROJECT_DIR,
  });
  return true;
}

/**
 * GAP 2: Check persistent alerts for re-escalation needs.
 * Runs every cycle (gate-exempt). Spawns re-escalation agents for
 * unresolved alerts past their re-escalation threshold. Garbage-collects
 * resolved alerts older than 7 days.
 */
function checkPersistentAlerts() {
  const data = readPersistentAlerts();
  const now = Date.now();
  let escalated = 0;
  let gcCount = 0;

  for (const [key, alert] of Object.entries(data.alerts)) {
    if (!alert.resolved) {
      // Check re-escalation threshold
      const thresholdHours = ALERT_RE_ESCALATION_HOURS[alert.severity] || 24;
      const lastEscalated = alert.last_escalated_at ? new Date(alert.last_escalated_at).getTime() : 0;
      const hoursSinceEscalation = (now - lastEscalated) / 3600000;

      if (hoursSinceEscalation >= thresholdHours) {
        log(`Persistent alerts: re-escalating '${key}' (${alert.severity}, ${Math.round(hoursSinceEscalation)}h since last escalation).`);
        spawnAlertEscalation(alert);
        alert.last_escalated_at = new Date().toISOString();
        alert.escalation_count += 1;
        escalated++;
      }
    } else {
      // Garbage-collect resolved alerts older than 7 days
      const resolvedAt = alert.resolved_at ? new Date(alert.resolved_at).getTime() : 0;
      if (resolvedAt > 0 && (now - resolvedAt) > ALERT_RESOLVED_GC_DAYS * 86400000) {
        delete data.alerts[key];
        gcCount++;
      }
    }
  }

  if (escalated > 0 || gcCount > 0) {
    writePersistentAlerts(data);
  }

  if (escalated > 0) log(`Persistent alerts: ${escalated} alert(s) re-escalated.`);
  if (gcCount > 0) log(`Persistent alerts: ${gcCount} resolved alert(s) garbage-collected.`);
  return { escalated, gcCount };
}

/**
 * GAP 3: Check CI status for main and staging branches via GitHub Actions API.
 * Creates/resolves persistent alerts for CI failures.
 */
function checkCiStatus() {
  let owner, repo;
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
    }).trim();
    // Parse owner/repo from git URL (handles SSH and HTTPS)
    const match = remoteUrl.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (!match) {
      log('CI monitoring: could not parse owner/repo from remote URL.');
      return;
    }
    [, owner, repo] = match;
  } catch (err) {
    console.error('[hourly-automation] Warning:', err.message);
    log('CI monitoring: failed to get git remote URL.');
    return;
  }

  const branches = ['main', 'staging'];
  for (const branch of branches) {
    const alertKey = `ci_${branch}_failure`;
    try {
      const result = execFileSync('gh', [
        'api',
        `repos/${owner}/${repo}/actions/runs?branch=${branch}&per_page=5&status=completed`,
        '--jq',
        '.workflow_runs | map({conclusion, name, html_url, created_at})',
      ], {
        cwd: PROJECT_DIR, encoding: 'utf8', timeout: 15000, stdio: 'pipe',
      });

      const runs = JSON.parse(result || '[]');
      if (!Array.isArray(runs) || runs.length === 0) {
        log(`CI monitoring (${branch}): no completed runs found.`);
        continue;
      }

      const latestRun = runs[0];
      if (typeof latestRun.conclusion !== 'string') {
        log(`CI monitoring (${branch}): unexpected API response shape. Skipping.`);
        continue;
      }
      if (latestRun.conclusion === 'failure') {
        log(`CI monitoring (${branch}): latest run FAILED — ${latestRun.name}`);
        recordAlert(alertKey, {
          title: `CI failure on ${branch}: ${latestRun.name}`,
          severity: branch === 'main' ? 'critical' : 'high',
          source: 'ci-monitoring',
        });
      } else {
        if (latestRun.conclusion === 'success') {
          resolveAlert(alertKey);
        }
        log(`CI monitoring (${branch}): latest run ${latestRun.conclusion}.`);
      }
    } catch (err) {
      log(`CI monitoring (${branch}): gh api call failed (${err.message}). Skipping.`);
    }
  }
}

/**
 * Get state
 * G001: Fail-closed if state file is corrupted
 */
function getState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      lastRun: 0, lastClaudeMdRefactor: 0, lastTriageCheck: 0, lastTaskRunnerCheck: 0,
      lastPreviewPromotionCheck: 0, lastStagingPromotionCheck: 0,
      lastStagingHealthCheck: 0, lastProductionHealthCheck: 0,
      lastStandaloneAntipatternHunt: 0, lastStandaloneComplianceCheck: 0,
      lastFeedbackCheck: 0, lastFeedbackSha: null,
      lastPreviewToStagingMergeAt: 0,
      stagingFreezeActive: false,
      stagingFreezeActivatedAt: 0,
      lastSessionReviverCheck: 0,
      lastSessionReaperRun: 0,
      lastVersionWatchRun: 0,
      lastCiMonitoringRun: 0,
      lastMergeChainGapRun: 0,
      lastPersistentAlertsRun: 0,
      lastUrgentDispatcherRun: 0,
      lastTaskGateCleanupRun: 0,
      lastUserFeedbackRun: 0,
      lastDailyFeedbackCheck: 0,
    };
  }

  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Migration for existing state files
    if (state.lastTriageCheck === undefined) {
      state.lastTriageCheck = state.lastTriage || 0;
      delete state.lastTriage;
    }
    // Remove legacy triageAttempts if present (now handled by MCP server)
    delete state.triageAttempts;
    // Migration for staging freeze fields
    if (state.lastPreviewToStagingMergeAt === undefined) state.lastPreviewToStagingMergeAt = 0;
    if (state.stagingFreezeActive === undefined) state.stagingFreezeActive = false;
    if (state.stagingFreezeActivatedAt === undefined) state.stagingFreezeActivatedAt = 0;
    if (state.lastSessionReviverCheck === undefined) state.lastSessionReviverCheck = 0;
    if (state.lastSessionReaperRun === undefined) state.lastSessionReaperRun = 0;
    if (state.lastVersionWatchRun === undefined) state.lastVersionWatchRun = 0;
    if (state.lastCiMonitoringRun === undefined) state.lastCiMonitoringRun = 0;
    if (state.lastMergeChainGapRun === undefined) state.lastMergeChainGapRun = 0;
    if (state.lastPersistentAlertsRun === undefined) state.lastPersistentAlertsRun = 0;
    if (state.lastUrgentDispatcherRun === undefined) state.lastUrgentDispatcherRun = 0;
    if (state.lastTaskGateCleanupRun === undefined) state.lastTaskGateCleanupRun = 0;
    if (state.lastUserFeedbackRun === undefined) state.lastUserFeedbackRun = 0;
    if (state.lastDailyFeedbackCheck === undefined) state.lastDailyFeedbackCheck = 0;
    return state;
  } catch (err) {
    log(`FATAL: State file corrupted: ${err.message}`);
    log(`Delete ${STATE_FILE} to reset.`);
    process.exit(1);
  }
}

/**
 * Save state
 * G001: Fail-closed if state can't be saved
 */
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`FATAL: Cannot save state: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Run a task if its cooldown has elapsed.
 * Replaces the repeated manual cooldown pattern throughout main().
 *
 * @param {string} key - Cooldown key name
 * @param {object} opts - Options
 * @param {object} opts.state - Current state object
 * @param {number} opts.now - Current timestamp (Date.now())
 * @param {object} opts.intervals - Optional intervals from config (seconds)
 * @param {string} opts.stateKey - Override state key (default: `${key}LastRun`)
 * @param {string} opts.configToggle - Config toggle key to check
 * @param {object} opts.config - Config object (for configToggle check)
 * @param {Function} opts.fn - Async function to run
 * @param {string} opts.label - Display label (default: key)
 * @returns {Promise<{ran: boolean, skipped?: string, result?: any}>}
 */
async function runIfDue(key, opts) {
  const { state, now, intervals, stateKey, configToggle, config, fn, label = key, localModeSkip } = opts;

  // Check local mode skip
  if (localModeSkip) {
    log(`${label}: skipped (local mode)`);
    return { ran: false, skipped: 'local_mode' };
  }

  // Check feature toggle
  if (configToggle && config && config[configToggle] === false) {
    log(`${label}: disabled in config.`);
    return { ran: false, skipped: 'disabled' };
  }

  const effectiveStateKey = stateKey || `${key}LastRun`;

  // Resolve interval: autonomous-mode.json intervals (seconds) > getCooldown() (minutes)
  let intervalMs;
  if (intervals && typeof intervals[key] === 'number') {
    intervalMs = intervals[key] * 1000;
  } else {
    intervalMs = getCooldown(key, null) * 60 * 1000;
  }
  if (intervalMs <= 0) intervalMs = 0;

  const lastRun = state[effectiveStateKey] || 0;
  const elapsed = now - lastRun;

  if (intervalMs > 0 && elapsed < intervalMs) {
    const minutesLeft = Math.ceil((intervalMs - elapsed) / 60000);
    log(`${label} cooldown active. ${minutesLeft}m until next run.`);
    return { ran: false, skipped: 'cooldown' };
  }

  try {
    const result = await fn();
    state[effectiveStateKey] = now;
    saveState(state);
    return { ran: true, result };
  } catch (err) {
    log(`${label} error (non-fatal): ${err.message}`);
    state[effectiveStateKey] = now;
    saveState(state);
    return { ran: false, skipped: 'error' };
  }
}

/**
 * Check CLAUDE.md size
 */
function getClaudeMdSize() {
  const claudeMdPath = path.join(PROJECT_DIR, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    return 0;
  }

  try {
    const stats = fs.statSync(claudeMdPath);
    return stats.size;
  } catch (err) {
    console.error('[hourly-automation] Warning:', err.message);
    return 0;
  }
}

/**
 * Check if there are any reports ready for triage
 * Uses simple sqlite3 query - MCP server handles cooldown filtering
 */
function hasReportsReadyForTriage() {
  if (!Database || !fs.existsSync(CTO_REPORTS_DB)) {
    return false;
  }

  try {
    const db = new Database(CTO_REPORTS_DB, { readonly: true });
    const row = db.prepare("SELECT COUNT(*) as cnt FROM reports WHERE triage_status = 'pending'").get();
    db.close();
    return (row?.cnt || 0) > 0;
  } catch (err) {
    log(`WARN: Failed to check for pending reports: ${err.message}`);
    return false;
  }
}

/**
 * Spawn deputy-cto to triage pending reports (fire-and-forget via queue).
 * The agent will discover reports via MCP tools (which handle cooldown filtering).
 */
function spawnReportTriage() {
  const promptBody = `You are an orchestrator performing REPORT TRIAGE.

## IMMEDIATE ACTION

Your first action MUST be to spawn the deputy-cto sub-agent:
\`\`\`
Task(subagent_type='deputy-cto', prompt='Triage all pending agent reports. Use mcp__agent-reports__get_reports_for_triage to get reports, then investigate and decide on each.')
\`\`\`

The deputy-cto sub-agent has specialized instructions loaded from .claude/agents/deputy-cto.md.

## Mission

Triage all pending agent reports that are ready (past cooldown). For each report:
1. Investigate to understand the context
2. Decide whether to handle it yourself, escalate to CTO, or dismiss
3. Take appropriate action

## Step 1: Get Reports Ready for Triage

\`\`\`
mcp__agent-reports__get_reports_for_triage({ limit: 10 })
\`\`\`

This returns reports that are:
- Status = pending
- Past the 1-hour per-item cooldown (if previously attempted)

If no reports are returned, output "No reports ready for triage" and exit.

## Step 2: Triage Each Report

For each report from the list above:

### 2a: Start Triage
\`\`\`
mcp__agent-reports__start_triage({ id: "<report-id>" })
\`\`\`

### 2b: Read the Report
\`\`\`
mcp__agent-reports__read_report({ id: "<report-id>" })
\`\`\`

### 2c: Investigate

**Search for related work:**
\`\`\`
mcp__todo-db__list_tasks({ limit: 50 })  // Check current tasks
mcp__deputy-cto__search_cleared_items({ query: "<keywords from report>" })  // Check past CTO items
mcp__agent-tracker__search_sessions({ query: "<keywords>", limit: 10 })  // Search session history
\`\`\`

**If needed, search the codebase:**
- Use Grep to find related code
- Use Read to examine specific files mentioned in the report

### 2d: Check Auto-Escalation Rules

**ALWAYS ESCALATE (no exceptions):**
- **G002 Violations**: Any report mentioning stub code, placeholder, TODO, FIXME, or "not implemented"
- **Security vulnerabilities**: Any report with category "security" or mentioning vulnerabilities
- **Bypass requests**: Any bypass-request type (these require CTO approval)

If the report matches ANY auto-escalation rule, skip to "If ESCALATING" - do not self-handle or dismiss.

### 2e: Apply Decision Framework (if no auto-escalation)

| ESCALATE to CTO | SELF-HANDLE | DISMISS |
|-----------------|-------------|---------|
| Active security breach | Breaking change (fix path clear) | Already resolved |
| Resource/budget implications | Architecture (precedent exists) | Not a real problem |
| Cross-team coordination | Issue already in todos | False positive |
| Policy/process change | Similar issue recently fixed | Duplicate report |
|  | Clear fix, low risk | Informational only |
|  | Obvious code quality fix | Outdated concern |
|  | Documentation/test gap | Style suggestions |
|  | Performance fix clear path | Minor improvements |
|  | Isolated bug fix | Low-severity patterns |
|  | Uncertain but low-impact | Tangential observations |

**Decision Rules:**
- **>70% confident** you know the right action AND issue is not high-severity → self-handle
- **<70% confident** AND high-severity → escalate
- **Not actionable** (already fixed, false positive, duplicate, low-impact) → dismiss
- **Default to dismiss** for informational-only reports, minor suggestions, and low-severity patterns
- Target distribution: dismiss ~40%, self-handle ~40%, escalate ~20%

### 2f: Take Action

**If SELF-HANDLING:**
\`\`\`
// Create a task — processed by the task runner on next cycle
mcp__todo-db__create_task({
  section: "CODE-REVIEWER",  // Choose based on task type (see section mapping below)
  title: "Brief actionable title",
  description: "Full context: what to fix, where, why, and acceptance criteria",
  assigned_by: "deputy-cto",
  priority: "normal"
})

// Complete the triage
mcp__agent-reports__complete_triage({
  id: "<report-id>",
  status: "self_handled",
  outcome: "Created task to [brief description of fix]"
})
\`\`\`

Section mapping for self-handled tasks:
- Code changes (full agent sequence) → "CODE-REVIEWER"
- Research/analysis only → "INVESTIGATOR & PLANNER"
- Test creation/updates → "TEST-WRITER"
- Documentation/cleanup → "PROJECT-MANAGER"
- Orchestration/delegation → "DEPUTY-CTO"

**If ESCALATING:**
\`\`\`
// Add to CTO queue with context
mcp__deputy-cto__add_question({
  type: "escalation",  // or "decision" if CTO needs to choose
  title: "Brief title of the issue",
  description: "Context from investigation + why CTO input needed",
  suggested_options: ["Option A", "Option B"],  // if applicable
  recommendation: "Your recommended course of action and why"  // REQUIRED for escalations
})

// Complete the triage
mcp__agent-reports__complete_triage({
  id: "<report-id>",
  status: "escalated",
  outcome: "Escalated: [reason CTO input is needed]"
})
\`\`\`

**If DISMISSING:**
\`\`\`
// Complete the triage - no further action needed
mcp__agent-reports__complete_triage({
  id: "<report-id>",
  status: "dismissed",
  outcome: "Dismissed: [reason - e.g., already resolved, not actionable, duplicate]"
})
\`\`\`

**IMPORTANT: Only dismiss when you have clear evidence** the issue is not actionable.
If in doubt, escalate instead.

## Question Types for Escalation

Use the appropriate type when calling \`add_question\`:
- \`decision\` - CTO needs to choose between options
- \`approval\` - CTO needs to approve a proposed action
- \`question\` - Seeking CTO guidance/input
- \`escalation\` - Raising awareness of an issue

## IMPORTANT

- Process ALL reports returned by get_reports_for_triage
- Always call \`start_triage\` before investigating
- Always call \`complete_triage\` when done
- Be thorough in investigation but efficient in execution
- When self-handling, the spawned task prompt should be detailed enough to succeed independently
- PREFER dismissing or self-handling over escalating — only escalate when CTO input is truly required
- When self-handling, create tasks with priority "normal" (not "urgent") unless it is a security or production issue
- After self-handling code changes, also create a user-alignment check task in INVESTIGATOR & PLANNER section

## Output

After processing all reports, output a summary:
- How many self-handled vs escalated vs dismissed
- Brief description of each action taken`;

  ensureCredentials();
  return enqueueSession({
    title: 'Triaging pending CTO reports',
    agentType: AGENT_TYPES.DEPUTY_CTO_REVIEW,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    tagContext: 'report-triage',
    source: 'hourly-automation',
    priority: 'low',
    buildPrompt: (agentId) => `[Automation][report-triage][AGENT:${agentId}] ${promptBody}`,
    extraEnv: { ...resolvedCredentials },
    metadata: {},
    projectDir: PROJECT_DIR,
  });
}

/**
 * Spawn Claude for CLAUDE.md refactoring (fire-and-forget via queue).
 */
function spawnClaudeMdRefactor() {
  const promptBody = `You are an orchestrator performing CLAUDE.md REFACTORING.

## IMMEDIATE ACTION

Your first action MUST be to spawn the project-manager sub-agent:
\`\`\`
Task(subagent_type='project-manager', prompt='CLAUDE.md has grown beyond 25,000 characters. Refactor it by moving detailed content to sub-files in docs/ or specs/, replacing moved content with brief summaries and links. Preserve ALL information. NEVER modify anything below the CTO-PROTECTED divider.')
\`\`\`

The project-manager sub-agent has specialized instructions loaded from .claude/agents/project-manager.md.

## Mission

CLAUDE.md has grown beyond 25,000 characters. Your job is to carefully refactor it by:
1. Moving detailed content to sub-files in \`docs/\` or \`specs/\`
2. Replacing moved content with brief summaries and links
3. Preserving ALL information (nothing lost, just reorganized)

## CRITICAL RULE

There is a divider line "---" near the bottom of CLAUDE.md followed by:
\`\`\`
<!-- CTO-PROTECTED: Changes below this line require CTO approval -->
\`\`\`

**NEVER modify anything below that divider.** That section contains critical instructions that must remain in CLAUDE.md.

## Refactoring Strategy

1. **Read CLAUDE.md carefully** - Understand the full content
2. **Identify movable sections** - Look for:
   - Detailed code examples (move to specs/reference/)
   - Long tables (summarize, link to full version)
   - Verbose explanations (condense, link to details)
3. **Create sub-files** - Use existing directories:
   - \`specs/reference/\` for development guides
   - \`specs/local/\` for component details
   - \`docs/\` for general documentation
4. **Update CLAUDE.md** - Replace with concise summary + link
5. **Verify nothing lost** - All information must be preserved

## Example Refactor

Before:
\`\`\`markdown
## MCP Tools Reference

### Core Tools
- \`page_get_snapshot\` - Get page structure
- \`page_click\` - Click element
[... 50 more lines ...]
\`\`\`

After:
\`\`\`markdown
## MCP Tools Reference

See [specs/reference/MCP-TOOLS.md](specs/reference/MCP-TOOLS.md) for complete tool reference.

Key tools: \`page_get_snapshot\`, \`page_click\`, \`mcp__todo-db__*\`, \`mcp__specs-browser__*\`
\`\`\`

## Rate Limiting

- Make at most 5 file edits per run
- If more refactoring needed, it will continue next hour

## Start Now

1. Read CLAUDE.md
2. Identify the largest movable sections
3. Create sub-files and update CLAUDE.md
4. Report what you refactored via mcp__agent-reports__report_to_deputy_cto`;

  ensureCredentials();
  return enqueueSession({
    title: 'Refactoring oversized CLAUDE.md',
    agentType: AGENT_TYPES.CLAUDEMD_REFACTOR,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    tagContext: 'claudemd-refactor',
    source: 'hourly-automation',
    priority: 'low',
    buildPrompt: (agentId) => `[Automation][claudemd-refactor][AGENT:${agentId}] ${promptBody}`,
    extraEnv: { ...resolvedCredentials },
    metadata: {},
    projectDir: PROJECT_DIR,
  });
}

/**
 * Run linter and return errors if any
 * Returns { hasErrors: boolean, output: string }
 */
function runLintCheck() {
  try {
    // Run ESLint and capture output
    const result = execSync('npm run lint 2>&1', {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: 60000, // 1 minute timeout
    });

    // If we got here without throwing, there were no errors
    return { hasErrors: false, output: result };
  } catch (err) {
    // ESLint exits with non-zero code when there are errors
    // The output is in err.stdout or err.message
    const output = err.stdout || err.message || 'Unknown error';

    // Check if it's actually lint errors (not a command failure)
    if (output.includes('error') && !output.includes('Command failed')) {
      return { hasErrors: true, output: output };
    }

    // Actual command failure
    log(`WARN: Lint check failed unexpectedly: ${output.substring(0, 200)}`);
    return { hasErrors: false, output: '' };
  }
}

/**
 * Spawn Claude to fix lint errors (fire-and-forget via queue).
 * Worktree is created synchronously before enqueueing.
 */
function spawnLintFixer(lintOutput) {
  // Extract just the errors, not warnings
  const errorLines = lintOutput.split('\n')
    .filter(line => line.includes('error'))
    .slice(0, 50) // Limit to first 50 error lines
    .join('\n');

  // --- Worktree setup (lint fixer must not run in main tree) ---
  let worktreePath = null;
  try {
    const branchName = getFeatureBranchName('lint-fix', `lint-${Date.now()}`);
    const worktree = createWorktree(branchName);
    worktreePath = worktree.path;
    log(`Lint fixer: worktree ready at ${worktree.path} (branch ${branchName})`);
  } catch (err) {
    log(`Lint fixer: worktree creation failed, aborting spawn (main tree must stay on main): ${err.message}`);
    throw new Error(`Worktree creation failed: ${err.message}`);
  }

  const agentMcpConfig = path.join(worktreePath, '.mcp.json');

  ensureCredentials();
  return enqueueSession({
    title: 'Fixing lint errors',
    agentType: AGENT_TYPES.LINT_FIXER,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    tagContext: 'lint-fixer',
    source: 'hourly-automation',
    priority: 'low',
    buildPrompt: (agentId) => `[Automation][lint-fixer][AGENT:${agentId}] You are an orchestrator fixing LINT ERRORS.

## IMMEDIATE ACTION

Your first action MUST be to spawn the code-writer sub-agent to fix the lint errors:
\`\`\`
Task(subagent_type='code-writer', prompt='Fix the following ESLint lint errors. Read each file, understand the context, fix the error, then verify by re-running the linter.\\n\\nLint Errors:\\n${errorLines.replace(/`/g, '\\`').replace(/\n/g, '\\n')}')
\`\`\`

Then after code-writer completes, spawn code-reviewer to review and commit the fixes:
\`\`\`
Task(subagent_type='code-reviewer', prompt='Review the lint fix changes and commit them if they look correct.')
\`\`\`

Each sub-agent has specialized instructions loaded from .claude/agents/ configs.

## Mission

The project's ESLint linter has detected errors that need to be fixed.

## Lint Errors Found

\`\`\`
${errorLines}
\`\`\`

## Process

1. **Spawn code-writer** to fix the lint errors
2. **Spawn code-reviewer** to review and commit the fixes

## Constraints

- Make at most 20 file edits per run
- If more fixes are needed, they will continue next hour
- Focus on errors only - warnings can be ignored

## When Done

Report completion via mcp__agent-reports__report_to_deputy_cto with a summary of what was fixed.`,
    extraEnv: { ...resolvedCredentials, CLAUDE_PROJECT_DIR: PROJECT_DIR },
    metadata: { errorCount: errorLines.split('\n').length, worktreePath },
    cwd: worktreePath,
    mcpConfig: agentMcpConfig,
    worktreePath,
    projectDir: PROJECT_DIR,
  });
}

// =========================================================================
// TASK RUNNER HELPERS
// =========================================================================

/**
 * Query todo.db for ALL pending tasks older than 1 hour.
 * Each task gets its own Claude session. No section limits.
 */
function getPendingTasksForRunner() {
  if (!Database || !fs.existsSync(TODO_DB_PATH)) {
    return [];
  }

  try {
    const db = new Database(TODO_DB_PATH, { readonly: true });
    const nowTimestamp = Math.floor(Date.now() / 1000);
    const oneHourAgo = nowTimestamp - 3600;

    const candidates = db.prepare(`
      SELECT id, section, category_id, title, description, strict_infra_guidance, demo_involved, persistent_task_id, user_prompt_uuids
      FROM tasks
      WHERE status = 'pending'
        AND section IN (${Object.keys(SECTION_AGENT_MAP).map(() => '?').join(',')})
        AND created_timestamp <= ?
      ORDER BY created_timestamp ASC
    `).all(...Object.keys(SECTION_AGENT_MAP), oneHourAgo);

    db.close();
    return candidates;
  } catch (err) {
    log(`Task runner: DB query error: ${err.message}`);
    return [];
  }
}

/**
 * Query todo.db for pending tasks with priority = 'urgent'.
 * No age filter, no batch limit — urgent tasks are dispatched immediately.
 */
function getUrgentPendingTasks() {
  if (!Database || !fs.existsSync(TODO_DB_PATH)) return [];

  try {
    const db = new Database(TODO_DB_PATH, { readonly: true });
    const candidates = db.prepare(`
      SELECT id, section, category_id, title, description, strict_infra_guidance, demo_involved, persistent_task_id, user_prompt_uuids
      FROM tasks
      WHERE status = 'pending'
        AND priority = 'urgent'
        AND section IN (${Object.keys(SECTION_AGENT_MAP).map(() => '?').join(',')})
      ORDER BY created_timestamp ASC
    `).all(...Object.keys(SECTION_AGENT_MAP));
    db.close();
    return candidates;
  } catch (err) {
    log(`Urgent dispatcher: DB query error: ${err.message}`);
    return [];
  }
}

/**
 * Mark a task as in_progress before spawning the agent
 */
function markTaskInProgress(taskId) {
  if (!Database || !fs.existsSync(TODO_DB_PATH)) return false;

  try {
    const db = new Database(TODO_DB_PATH);
    const now = new Date();
    const started_at = now.toISOString();
    const started_timestamp = Math.floor(now.getTime() / 1000);
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', started_at = ?, started_timestamp = ? WHERE id = ?"
    ).run(started_at, started_timestamp, taskId);
    db.close();
    return true;
  } catch (err) {
    log(`Task runner: Failed to mark task ${taskId} in_progress: ${err.message}`);
    return false;
  }
}

/**
 * Reset a task back to pending on spawn failure
 */
function resetTaskToPending(taskId) {
  if (!Database || !fs.existsSync(TODO_DB_PATH)) return;

  try {
    const db = new Database(TODO_DB_PATH);
    db.prepare(
      "UPDATE tasks SET status = 'pending', started_at = NULL, started_timestamp = NULL WHERE id = ?"
    ).run(taskId);
    db.close();
  } catch (err) {
    log(`Task runner: Failed to reset task ${taskId}: ${err.message}`);
  }
}

/**
 * Build the prompt for a deputy-cto task orchestrator agent
 */
function buildDeputyCtoTaskPrompt(task, agentId) {
  return `[Automation][task-runner-deputy-cto][AGENT:${agentId}] You are the Deputy-CTO processing a high-level task assignment.

## Task Details

- **Task ID**: ${task.id}
- **Section**: ${task.section}
- **Title**: ${task.title}
${task.description ? `- **Description**: ${task.description}` : ''}

## Your Mission

You are an ORCHESTRATOR. You do NOT implement tasks yourself — you evaluate, decompose, and delegate.

## Process (FOLLOW THIS ORDER)

### Step 1: Evaluate Alignment
Before doing anything, evaluate whether this task aligns with:
- The project's specs (read specs/global/ and specs/local/ as needed)
- Existing plans (check plans/ directory)
- CTO directives (check mcp__deputy-cto__list_questions for relevant decisions)

If the task does NOT align with specs, plans, or CTO requests:
- Report the misalignment via mcp__agent-reports__report_to_deputy_cto
- Mark this task complete WITHOUT creating sub-tasks
- Explain in the completion why you declined

### Step 2: Create Investigator Task FIRST
Always start by creating an investigator task:
\`\`\`
mcp__todo-db__create_task({
  section: "INVESTIGATOR & PLANNER",
  title: "Investigate: ${task.title}",
  description: "You are the INVESTIGATOR. Analyze the following task and create a detailed implementation plan with specific sub-tasks:\\n\\nTask: ${task.title}\\n${task.description || ''}\\n\\nInvestigate the codebase, read relevant specs, and create TODO items in the appropriate sections via mcp__todo-db__create_task for each sub-task you identify.",
  assigned_by: "deputy-cto",
  priority: "normal"
})
\`\`\`

### Step 3: Create Implementation Sub-Tasks
Based on your own analysis (don't wait for the investigator — it runs async), create concrete sub-tasks:

For non-urgent work (picked up by hourly automation):
\`\`\`
mcp__todo-db__create_task({
  section: "INVESTIGATOR & PLANNER",  // or CODE-REVIEWER, TEST-WRITER, PROJECT-MANAGER
  title: "Specific actionable task title",
  description: "Detailed context and acceptance criteria",
  assigned_by: "deputy-cto"
})
\`\`\`

Section mapping:
- Code changes (triggers full agent sequence: investigator → code-writer → test-writer → code-reviewer → project-manager) → CODE-REVIEWER
- Research, analysis, planning only → INVESTIGATOR & PLANNER
- Test creation/updates only → TEST-WRITER
- Documentation, cleanup only → PROJECT-MANAGER

### Step 4: Summarize and Complete
After all sub-tasks are created:
\`\`\`
mcp__todo-db__summarize_work({ summary: "<what you triaged, how many sub-tasks created, key decisions>", success: true/false })
\`\`\`
Then:
\`\`\`
mcp__todo-db__complete_task({ id: "${task.id}" })
\`\`\`
This will automatically create a follow-up verification task.

## Constraints

- Do NOT write code yourself (you have no Edit/Write tools)
- Create the minimum sub-tasks needed (prefer 1-3 focused tasks over exhaustive decomposition)
- Each sub-task must be self-contained with enough context to execute independently
- Only delegate tasks that align with project specs and plans
- Report blockers via mcp__agent-reports__report_to_deputy_cto
- If the task needs CTO input, create a question via mcp__deputy-cto__add_question`;
}

/**
 * Build the prompt for a task runner agent
 */
function buildTaskRunnerPrompt(task, agentName, agentId, worktreePath = null) {
  // Strict infra guidance: inject MCP-only infrastructure instructions when strict_infra_guidance is set
  const strictInfraSection = (task.strict_infra_guidance && worktreePath)
    ? buildStrictInfraGuidancePrompt(worktreePath, !!task.demo_involved)
    : '';
  const appendBridgeSection = (prompt) => strictInfraSection ? `${prompt}${strictInfraSection}` : prompt;

  // Resolve user prompt references if available
  let userPromptBlock = '';
  if (task.user_prompt_uuids) {
    try {
      const uuids = typeof task.user_prompt_uuids === 'string'
        ? JSON.parse(task.user_prompt_uuids)
        : task.user_prompt_uuids;
      if (Array.isArray(uuids) && uuids.length > 0) {
        const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        userPromptBlock = resolveUserPrompts(uuids, PROJECT_DIR);
      }
    } catch (err) {
      console.error('[hourly-automation] Warning: user prompt resolution failed:', err.message);
    }
  }

  const taskDetails = `[Automation][task-runner-${agentName}][AGENT:${agentId}] You are an orchestrator processing a TODO task.

## Task Details

- **Task ID**: ${task.id}
- **Section**: ${task.section}
- **Title**: ${task.title}
${task.description ? `- **Description**: ${task.description}` : ''}
${userPromptBlock}`;

  // Working directory note for worktree-based agents
  const worktreeNote = worktreePath ? `
## Working Directory

You are in a git worktree at: ${worktreePath}
All git operations (commit, push, PR, merge, worktree cleanup) are handled by the project-manager sub-agent.
You MUST NOT run git add, git commit, git push, or gh pr create yourself.
CRITICAL: You MUST spawn the project-manager before completing your task. The project-manager
is responsible for merging your work AND removing this worktree. If you skip it, the worktree
will be orphaned and your changes will not be merged.
` : '';

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

  // Section-specific workflow instructions
  if (task.section === 'CODE-REVIEWER') {
    return appendBridgeSection(`${taskDetails}

## MANDATORY SUB-AGENT WORKFLOW

You are an ORCHESTRATOR. Do NOT edit files directly. Follow this sequence using the Task tool:

1. \`Task(subagent_type='investigator')\` - Research the task, understand the codebase
2. \`Task(subagent_type='code-writer')\` - Implement the changes
3. \`Task(subagent_type='test-writer')\` - Add/update tests
4. \`Task(subagent_type='code-reviewer')\` - Review changes, commit
5. \`Task(subagent_type='user-alignment')\` - Verify implementation honors user intent
6. \`Task(subagent_type='project-manager')\` - Commit, push, and merge (ALWAYS LAST)

Pass the full task context to each sub-agent. Each sub-agent has specialized
instructions loaded from .claude/agents/ configs.

**YOU ARE PROHIBITED FROM:**
- Directly editing ANY files using Edit, Write, or NotebookEdit tools
- Making code changes without the code-writer sub-agent
- Making test changes without the test-writer sub-agent
- Skipping investigation before implementation
- Skipping code-reviewer after any code/test changes
- Skipping user-alignment after code-reviewer
- Skipping project-manager at the end
- Running git add, git commit, git push, or gh pr create yourself

**WORKFLOW DEFAULTS:**
This 6-step sequence is the standard development workflow and the DEFAULT for all code change tasks. However, if the task description provides EXPLICIT alternative workflow instructions (e.g., "skip investigation, just build and run the demo" or "only run the test suite"), follow those instructions instead. The task creator knows the context — trust their instructions over the default pipeline. The only invariant is: if you made file changes, you MUST spawn project-manager before completing.

${completionBlock}`);
  }

  if (task.section === 'INVESTIGATOR & PLANNER') {
    return appendBridgeSection(`${taskDetails}

## IMMEDIATE ACTION

Your first action MUST be:
\`\`\`
Task(subagent_type='investigator', prompt='${task.title}. ${task.description || ''}')
\`\`\`

The investigator sub-agent has specialized instructions loaded from .claude/agents/investigator.md.
Pass the full task context including title and description.

${completionBlock}`);
  }

  if (task.section === 'TEST-WRITER') {
    return appendBridgeSection(`${taskDetails}

## MANDATORY SUB-AGENT WORKFLOW

You are an ORCHESTRATOR. Do NOT edit files directly. Follow this sequence using the Task tool:

1. \`Task(subagent_type='test-writer')\` - Write/update tests
2. \`Task(subagent_type='code-reviewer')\` - Review the test changes
3. \`Task(subagent_type='project-manager')\` - Commit, push, and merge (ALWAYS LAST)

Pass the full task context to each sub-agent. Each sub-agent has specialized
instructions loaded from .claude/agents/ configs.

**YOU ARE PROHIBITED FROM:**
- Directly editing ANY files using Edit, Write, or NotebookEdit tools
- Making test changes without the test-writer sub-agent
- Skipping code-reviewer after test changes
- Skipping project-manager at the end
- Running git add, git commit, git push, or gh pr create yourself

${completionBlock}`);
  }

  if (task.section === 'PROJECT-MANAGER') {
    return appendBridgeSection(`${taskDetails}

## IMMEDIATE ACTION

Your first action MUST be:
\`\`\`
Task(subagent_type='project-manager', prompt='${task.title}. ${task.description || ''}')
\`\`\`

The project-manager sub-agent has specialized instructions loaded from .claude/agents/project-manager.md.
Pass the full task context including title and description.

${completionBlock}`);
  }

  if (task.section === 'DEMO-MANAGER') {
    return appendBridgeSection(`${taskDetails}

## MANDATORY SUB-AGENT WORKFLOW

You are an ORCHESTRATOR for demo lifecycle work. Follow this sequence using the Task tool:

1. \`Task(subagent_type='investigator')\` - Investigate the issue (read .demo.ts, check selectors, review error)
2. \`Task(subagent_type='demo-manager', isolation='worktree')\` - Plan and implement .demo.ts fixes, register prerequisites/scenarios
3. \`Task(subagent_type='code-reviewer')\` - Review changes
4. \`Task(subagent_type='project-manager')\` - Commit, push, merge, cleanup worktree (ALWAYS LAST)

If the issue is in APPLICATION CODE (not demo code):
- Escalate via mcp__agent-reports__report_to_deputy_cto
- Do NOT attempt app code fixes

**YOU ARE PROHIBITED FROM:**
- Directly editing ANY files using Edit, Write, or NotebookEdit tools
- Modifying application source code
- Skipping project-manager at the end
- Running git add, git commit, git push, or gh pr create yourself

${completionBlock}`);
  }

  // Fallback for any other section
  return appendBridgeSection(`${taskDetails}

## Your Role

You are the \`${agentName}\` agent. Complete the task described above using your expertise.
Use the Task tool to spawn the appropriate sub-agent: \`Task(subagent_type='${agentName}')\`

${completionBlock}`);
}

/**
 * Spawn a fire-and-forget Claude agent for a task via the session queue.
 * When worktrees are available, each agent gets its own isolated worktree
 * on a feature branch (base auto-detected: preview or main). Falls back (aborts) if
 * worktree creation fails.
 */
function spawnTaskAgent(task) {
  const mapping = getAgentMapping(task);
  if (!mapping) return false;

  // NOTE: Memory pressure check is handled by the session queue. Do NOT check here.

  // --- Worktree setup (aborts if it fails — main tree must not be used) ---
  let worktreePath = null;

  try {
    const branchName = getFeatureBranchName(task.title, task.id);
    const worktree = createWorktree(branchName);
    worktreePath = worktree.path;
    log(`Task runner: worktree ready at ${worktree.path} (branch ${branchName}, created=${worktree.created})`);
  } catch (err) {
    log(`Task runner: worktree creation failed, aborting spawn (main tree must stay on main): ${err.message}`);
    return false;
  }

  const agentMcpConfig = path.join(worktreePath, '.mcp.json');

  ensureCredentials();
  const result = enqueueSession({
    title: `Task runner: ${mapping.category?.name || mapping.agent} - ${task.title}`,
    agentType: mapping.agentType,
    hookType: HOOK_TYPES.TASK_RUNNER,
    tagContext: `task-runner-${mapping.agent}`,
    source: 'hourly-automation',
    priority: 'low',
    agent: mapping.agent,
    buildPrompt: (agentId) => {
      if (mapping.category) {
        return buildPromptFromCategory(task, mapping.category, agentId, worktreePath, {
          resolveUserPrompts,
          buildStrictInfraGuidancePrompt,
        });
      }
      // Legacy fallback
      return mapping.agent === 'deputy-cto'
        ? buildDeputyCtoTaskPrompt(task, agentId)
        : buildTaskRunnerPrompt(task, mapping.agent, agentId, worktreePath);
    },
    extraEnv: {
      ...resolvedCredentials,
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
      ...(task.strict_infra_guidance ? { GENTYR_STRICT_INFRA_GUIDANCE: 'true' } : {}),
    },
    metadata: { taskId: task.id, section: task.section, categoryId: task.category_id, worktreePath },
    cwd: worktreePath,
    mcpConfig: agentMcpConfig,
    worktreePath,
    projectDir: PROJECT_DIR,
  });

  // If the session was blocked (focus mode, bypass request, etc.), clean up the worktree.
  // Callers handle resetting the task to pending on false return.
  if (result.blocked) {
    log(`Task runner: enqueue blocked for "${task.title}" (reason: ${result.blocked}) — removing worktree`);
    try { removeWorktree(getFeatureBranchName(task.title, task.id)); } catch (_) { /* non-fatal */ }
    return false;
  }

  return true;
}

// =========================================================================
// STALE WORKTREE REAPER
// =========================================================================

/**
 * Reap worktrees older than 4 hours with no active agent process.
 * If the worktree has uncommitted changes, it's skipped (rescue handles those).
 * Frees port allocations and disk space from forgotten worktrees.
 *
 * @returns {number} Number of worktrees reaped
 */
function reapStaleWorktrees() {
  const worktrees = listWorktrees();
  let reaped = 0;
  const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
  const now = Date.now();

  // Read port allocations to get creation times
  let allocations = {};
  try {
    const allocPath = path.join(PROJECT_DIR, '.claude', 'state', 'port-allocations.json');
    if (fs.existsSync(allocPath)) {
      allocations = JSON.parse(fs.readFileSync(allocPath, 'utf8'));
    }
  } catch { /* non-fatal */ }

  for (const wt of worktrees) {
    if (!wt.path || !fs.existsSync(wt.path)) continue;

    // Check age from port allocation or fallback to git reflog
    const alloc = allocations[wt.path];
    let createdAt = alloc?.allocatedAt ? new Date(alloc.allocatedAt).getTime() : 0;
    if (!createdAt) {
      // Fallback: check mtime of the worktree .git file
      try {
        const gitFile = path.join(wt.path, '.git');
        if (fs.existsSync(gitFile)) {
          createdAt = fs.statSync(gitFile).mtimeMs;
        }
      } catch { /* skip */ }
    }
    if (!createdAt || (now - createdAt) < STALE_THRESHOLD_MS) continue;

    // Check for active processes — removeWorktree() will kill them before removal,
    // but log a warning so we have visibility into force-killed processes
    try {
      const result = execFileSync('lsof', ['+D', wt.path, '-t'], {
        encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (result.trim().length > 0) {
        const pids = result.trim().split('\n').filter(Boolean);
        log(`Stale reaper: worktree ${wt.branch} has ${pids.length} active process(es) — will be killed during removal`);
      }
    } catch { /* lsof returned no results or errored — proceed */ }

    // Skip if uncommitted changes (rescue handles those)
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: wt.path, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
      }).trim();
      if (status.length > 0) {
        log(`Stale reaper: skipping ${wt.path} (has uncommitted changes, rescue will handle)`);
        continue;
      }
    } catch { continue; }

    // Safe to reap
    try {
      removeWorktree(wt.branch);
      log(`Stale reaper: removed stale worktree ${wt.branch} (age: ${Math.round((now - createdAt) / 3600000)}h)`);
      reaped++;
    } catch (err) {
      log(`Stale reaper: failed to remove ${wt.branch}: ${err.message}`);
    }
  }

  return reaped;
}

// =========================================================================
// ORPHAN PROCESS REAPER
// =========================================================================

/**
 * Find and kill orphaned node/esbuild processes whose CWD is a
 * non-existent worktree path. These are children that survived
 * after their parent session was killed and worktree was removed.
 *
 * @returns {number} Number of orphan processes killed
 */
function reapOrphanProcesses() {
  let killed = 0;
  const worktreesDir = path.join(PROJECT_DIR, '.claude', 'worktrees');

  try {
    // Get all node/esbuild processes and their CWDs
    const psOutput = execFileSync('ps', ['-eo', 'pid,command'], {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    });

    const candidatePids = [];
    for (const line of psOutput.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Match node, esbuild, vitest processes
      if (!/\b(node|esbuild|vitest)\b/.test(trimmed)) continue;
      const pidMatch = trimmed.match(/^(\d+)/);
      if (!pidMatch) continue;
      candidatePids.push(parseInt(pidMatch[1], 10));
    }

    for (const pid of candidatePids) {
      if (pid === process.pid) continue; // Never kill ourselves
      try {
        // Get the process's CWD via lsof
        const lsofOutput = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
          encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Parse lsof output: lines starting with 'n' contain the path
        const cwdLine = lsofOutput.split('\n').find(l => l.startsWith('n'));
        if (!cwdLine) continue;
        const cwd = cwdLine.slice(1); // Remove 'n' prefix

        // Check if the CWD is inside a worktree directory that no longer exists
        if (cwd.startsWith(worktreesDir) && !fs.existsSync(cwd)) {
          log(`Orphan reaper: killing PID ${pid} (CWD: ${cwd} no longer exists)`);
          killProcessGroup(pid);
          killed++;
        }
      } catch (_) {
        // lsof or kill failed — process may have already exited
      }
    }
  } catch (err) {
    log(`Orphan reaper: scan failed (non-fatal): ${err.message}`);
  }

  return killed;
}

// =========================================================================
// ABANDONED WORKTREE RESCUE
// =========================================================================

/**
 * Detect worktrees with uncommitted changes that have no active agent running.
 * Spawns a project-manager for each to commit, push, and merge the abandoned work.
 *
 * @returns {number} Number of rescue agents spawned
 */
function rescueAbandonedWorktrees() {
  const worktrees = listWorktrees();
  let rescued = 0;

  for (const wt of worktrees) {
    if (!wt.path || !fs.existsSync(wt.path)) continue;

    // Check for uncommitted changes
    let hasChanges = false;
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: wt.path,
        encoding: 'utf8',
        timeout: 5000,
        stdio: 'pipe',
      }).trim();
      hasChanges = status.length > 0;
    } catch (err) {
      console.error('[hourly-automation] Warning:', err.message);
      continue;
    }

    if (!hasChanges) continue;

    // Check if any agent process is still active in this worktree
    let inUse = false;
    try {
      const result = execFileSync('lsof', ['+D', wt.path, '-t'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      inUse = result.trim().length > 0;
    } catch (err) {
      console.error('[hourly-automation] Warning:', err.message);
      // lsof returned no results (exit 1) or failed — not in use
    }

    if (inUse) {
      log(`Rescue: skipping ${wt.path} (active processes detected)`);
      continue;
    }

    // Spawn project-manager to rescue this worktree
    log(`Rescue: spawning project-manager for abandoned worktree ${wt.path} (branch: ${wt.branch})`);

    const wtPath = wt.path;
    const wtBranch = wt.branch;
    const mcpConfig = path.join(wtPath, '.mcp.json');
    const actualMcp = fs.existsSync(mcpConfig) ? mcpConfig : path.join(PROJECT_DIR, '.mcp.json');

    ensureCredentials();
    enqueueSession({
      title: `Rescue abandoned worktree: ${wtBranch}`,
      agentType: AGENT_TYPES.TASK_RUNNER_PROJECT_MANAGER,
      hookType: HOOK_TYPES.TASK_RUNNER,
      tagContext: 'rescue-project-manager',
      source: 'hourly-automation',
      priority: 'low',
      buildPrompt: (agentId) => `[Automation][rescue-project-manager][AGENT:${agentId}] You are a project-manager rescuing abandoned work in a worktree.

## Context

A previous agent left uncommitted changes in this worktree at: ${wtPath}
Branch: ${wtBranch}

## Your Mission

1. Run \`git status\` to see what changed
2. Run \`git diff\` to understand the changes
3. Stage the relevant files: \`git add <specific files>\` (never \`git add .\`)
4. Commit with a descriptive message
5. Push and create a PR:
\`\`\`
git push -u origin HEAD
BASE=$(git rev-parse --verify origin/preview 2>/dev/null && echo preview || echo main)
gh pr create --base "$BASE" --head "$(git branch --show-current)" --title "Rescue: ${wtBranch}" --body "Automated rescue of abandoned worktree changes" 2>/dev/null || true
\`\`\`
6. Self-merge: \`gh pr merge --squash --delete-branch\`

Then summarize and exit.`,
      extraEnv: { ...resolvedCredentials },
      metadata: { worktreePath: wtPath, branch: wtBranch, source: 'rescue-abandoned-worktree' },
      cwd: wtPath,
      mcpConfig: actualMcp,
      worktreePath: wtPath,
      projectDir: PROJECT_DIR,
    });
    rescued++;
  }

  return rescued;
}

// =========================================================================
// PROMOTION & HEALTH MONITOR SPAWN FUNCTIONS
// =========================================================================

/**
 * Check if a git branch exists on the remote
 */
function remoteBranchExists(branch) {
  try {
    execSync(`git rev-parse --verify origin/${branch}`, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    });
    return true;
  } catch (err) {
    console.error('[hourly-automation] Warning:', err.message);
    return false;
  }
}

/**
 * Get commits on source not yet in target
 */
function getNewCommits(source, target) {
  try {
    const result = execSync(`git log origin/${target}..origin/${source} --oneline`, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    }).trim();
    return result ? result.split('\n') : [];
  } catch (err) {
    console.error('[hourly-automation] Warning:', err.message);
    return [];
  }
}

/**
 * Get Unix timestamp of last commit on a branch
 */
function getLastCommitTimestamp(branch) {
  try {
    const result = execSync(`git log origin/${branch} -1 --format=%ct`, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    }).trim();
    return parseInt(result, 10) || 0;
  } catch (err) {
    console.error('[hourly-automation] Warning:', err.message);
    return 0;
  }
}

/**
 * Check if any commit messages contain bug-fix keywords
 */
function hasBugFixCommits(commits) {
  const bugFixPattern = /\b(fix|bug|hotfix|patch|critical)\b/i;
  return commits.some(line => bugFixPattern.test(line));
}

/**
 * Read the active test scope from services.json and return a context block
 * for injection into promotion agent prompts. Returns empty string if no scope.
 */
function getTestScopePromptContext() {
  try {
    const configPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
    if (!fs.existsSync(configPath)) return '';
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const scopeName = process.env.GENTYR_TEST_SCOPE || cfg.activeTestScope;
    if (!scopeName || !cfg.testScopes?.[scopeName]) return '';
    const scope = cfg.testScopes[scopeName];
    return `\n**Active Test Scope:** \`${scopeName}\`${scope.description ? ` — ${scope.description}` : ''}
- Only failures in tests matching scope patterns are BLOCKING
- Non-scoped test failures are INFORMATIONAL (report but do not block promotion)
- Include "[scope: ${scopeName}]" in the promotion commit message\n`;
  } catch { /* non-fatal */ }
  return '';
}

/**
 * Create or reuse a worktree for promotion agents.
 * Uses deterministic branch names so worktrees persist across cycles.
 * Falls back to PROJECT_DIR on failure (matches task runner pattern).
 */
function getPromotionWorktree(promotionType) {
  const branchName = `automation/${promotionType}`;
  const baseBranch = promotionType === 'preview-promotion' ? 'preview' : 'staging';
  try {
    const worktree = createWorktree(branchName, baseBranch);
    if (!worktree.created) {
      // Worktree exists, pull latest
      try {
        execSync('git pull --ff-only', { cwd: worktree.path, encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
      } catch (err) {
        console.error('[hourly-automation] Warning:', err.message);
        /* non-fatal */
      }
    }
    return { cwd: worktree.path, mcpConfig: path.join(worktree.path, '.mcp.json') };
  } catch (err) {
    log(`Promotion worktree creation failed for ${promotionType}, falling back to PROJECT_DIR: ${err.message}`);
    return { cwd: PROJECT_DIR, mcpConfig: path.join(PROJECT_DIR, '.mcp.json') };
  }
}

/**
 * Spawn Preview -> Staging promotion orchestrator (fire-and-forget via queue).
 */
function spawnPreviewPromotion(newCommits, hoursSinceLastStagingMerge, hasBugFix) {
  const commitList = newCommits.join('\n');
  const wt = getPromotionWorktree('preview-promotion');

  ensureCredentials();
  return enqueueSession({
    title: 'Preview -> Staging promotion pipeline',
    agentType: AGENT_TYPES.PREVIEW_PROMOTION,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    tagContext: 'preview-promotion',
    source: 'hourly-automation',
    priority: 'low',
    buildPrompt: (agentId) => `[Automation][preview-promotion][AGENT:${agentId}] You are the PREVIEW -> STAGING Promotion Pipeline orchestrator.

## Mission

Evaluate whether commits on the \`preview\` branch are ready to be promoted to \`staging\`.

## Context

**New commits on preview (not in staging):**
\`\`\`
${commitList}
\`\`\`

**Hours since last staging merge:** ${hoursSinceLastStagingMerge}
**Bug-fix commits detected:** ${hasBugFix ? 'YES (24h waiting period bypassed)' : 'No'}
${getTestScopePromptContext()}
## Process

### Step 1: Code Review

Spawn a code-reviewer sub-agent (Task tool, subagent_type: code-reviewer) to review the commits:
- Check for security issues, code quality, spec violations
- Look for disabled tests, placeholder code, hardcoded credentials
- Verify no spec violations (G001-G019)

### Step 2: Test Assessment

Spawn a test-writer sub-agent (Task tool, subagent_type: test-writer) to assess test quality:
- Check if new code has adequate test coverage
- Verify no tests were disabled or weakened${getTestScopePromptContext() ? `\n- NOTE: Active test scope is in effect. Only scoped test failures are blocking. Report non-scoped failures as warnings.` : ''}

### Step 3: Evaluate Results

If EITHER agent reports issues:
- Report findings via mcp__cto-reports__report_to_cto with category "decision", priority "normal"
- Create TODO tasks for fixes
- Do NOT proceed with promotion
- Output: "Promotion blocked: [reasons]"

### Step 4: Deputy-CTO Decision

If both agents pass, spawn a deputy-cto sub-agent (Task tool, subagent_type: deputy-cto) with:
- The review results from both agents
- The commit list
- Request: Evaluate stability and decide whether to promote

The deputy-cto should:
- **If approving**: Report approval via \`mcp__cto-reports__report_to_cto\` with category "decision", summary "Preview promotion approved"
- **If rejecting**: Report issues via \`mcp__cto-reports__report_to_cto\`, create TODO tasks for fixes

### Step 5: Execute Promotion (after deputy-cto approves)

If the deputy-cto approved, execute the promotion yourself:
1. Run: \`gh pr create --base staging --head preview --title "Promote preview to staging" --body "Automated promotion. Commits: ${newCommits.length} new commits. Reviewed by code-reviewer and test-writer agents."\`
2. Wait for CI: \`gh pr checks <number> --watch\`
3. If CI passes: \`gh pr merge <number> --merge\`
4. If CI fails: Report failure via \`mcp__cto-reports__report_to_cto\`

## Timeout

Complete within 25 minutes. If blocked, report and exit.

## Output

Summarize the promotion decision and actions taken.`,
    extraEnv: {
      ...resolvedCredentials,
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
      GENTYR_PROMOTION_PIPELINE: 'true',
    },
    metadata: { commitCount: newCommits.length, hoursSinceLastStagingMerge, hasBugFix },
    cwd: wt.cwd,
    mcpConfig: wt.mcpConfig,
    projectDir: PROJECT_DIR,
  });
}

/**
 * Spawn Staging -> Production promotion orchestrator (fire-and-forget via queue).
 */
function spawnStagingPromotion(newCommits, hoursSinceLastStagingCommit) {
  const commitList = newCommits.join('\n');
  const wt = getPromotionWorktree('staging-promotion');

  ensureCredentials();
  return enqueueSession({
    title: 'Staging -> Production promotion pipeline',
    agentType: AGENT_TYPES.STAGING_PROMOTION,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    tagContext: 'staging-promotion',
    source: 'hourly-automation',
    priority: 'low',
    buildPrompt: (agentId) => `[Automation][staging-promotion][AGENT:${agentId}] You are the STAGING -> PRODUCTION Promotion Pipeline orchestrator.

## Mission

Evaluate whether commits on the \`staging\` branch are ready to be promoted to \`main\` (production).

## Context

**New commits on staging (not in main):**
\`\`\`
${commitList}
\`\`\`

**Hours since last staging commit:** ${hoursSinceLastStagingCommit} (must be >= 24 for stability)
${getTestScopePromptContext()}
## Process

### Step 1: Code Review

Spawn a code-reviewer sub-agent (Task tool, subagent_type: code-reviewer) to review all staging commits:
- Full security audit
- Spec compliance check (G001-G019)
- No placeholder code, disabled tests, or hardcoded credentials

### Step 2: Test Assessment

Spawn a test-writer sub-agent (Task tool, subagent_type: test-writer) to assess:
- Test coverage meets thresholds (80% global, 100% critical paths)
- No tests disabled or weakened${getTestScopePromptContext() ? `\n- NOTE: Active test scope is in effect. Only scoped test failures are blocking. Report non-scoped failures as warnings.` : ''}

### Step 3: Evaluate Results

If EITHER agent reports issues:
- Report via mcp__cto-reports__report_to_cto with priority "high"
- Create TODO tasks for fixes
- Do NOT proceed with promotion
- Output: "Production promotion blocked: [reasons]"

### Step 4: Deputy-CTO Decision

If both agents pass, spawn a deputy-cto sub-agent (Task tool, subagent_type: deputy-cto) with:
- The review results from both agents
- The commit list
- Request: Create the production release PR and CTO decision task

The deputy-cto should:
1. Call \`mcp__deputy-cto__add_question\` with:
   - type: "approval"
   - title: "Production Release: Merge staging -> main (${newCommits.length} commits)"
   - description: Include review results, commit list, stability assessment
   - suggested_options: ["Approve merge to production", "Reject - needs more work"]

2. Report via mcp__cto-reports__report_to_cto

### Step 5: Create Production PR (after deputy-cto approves)

If the deputy-cto approved, create the PR yourself:
1. Run: \`gh pr create --base main --head staging --title "Production Release: ${newCommits.length} commits" --body "Automated production promotion. Staging stable for ${hoursSinceLastStagingCommit}h. Reviewed by code-reviewer and test-writer."\`
   Do NOT merge — CTO approval required via /deputy-cto.

**CTO approval**: When CTO approves via /deputy-cto, an urgent merge task is created:
\`\`\`
mcp__todo-db__create_task({
  section: "CODE-REVIEWER",
  title: "Merge production release PR #<number>",
  description: "CTO approved. Run: gh pr merge <number> --merge",
  assigned_by: "deputy-cto",
  priority: "urgent"
})
\`\`\`

## Timeout

Complete within 25 minutes. If blocked, report and exit.

## Output

Summarize the promotion decision and actions taken.`,
    extraEnv: {
      ...resolvedCredentials,
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
      GENTYR_PROMOTION_PIPELINE: 'true',
    },
    metadata: { commitCount: newCommits.length, hoursSinceLastStagingCommit },
    cwd: wt.cwd,
    mcpConfig: wt.mcpConfig,
    projectDir: PROJECT_DIR,
  });
}

/**
 * Spawn Emergency Hotfix Promotion (staging -> main, bypasses 24h + midnight).
 * Fire-and-forget via the session queue.
 *
 * Called by the deputy-cto MCP server's execute_hotfix_promotion tool.
 * Uses the staging-promotion worktree for isolation, sets GENTYR_PROMOTION_PIPELINE=true.
 *
 * @param {string[]} commits - Commit oneline summaries being promoted
 * @returns {{ queueId: string, position: number, drained: object }}
 */
export function spawnHotfixPromotion(commits) {
  const commitList = commits.join('\n');
  const wt = getPromotionWorktree('staging-promotion');

  ensureCredentials();
  return enqueueSession({
    title: 'Emergency hotfix: staging -> main promotion',
    agentType: AGENT_TYPES.HOTFIX_PROMOTION,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    tagContext: 'hotfix-promotion',
    source: 'hourly-automation',
    buildPrompt: (agentId) => `[Automation][hotfix-promotion][AGENT:${agentId}] You are the EMERGENCY HOTFIX Promotion Pipeline.

## Mission

Immediately merge staging into main. This is a CTO-approved emergency hotfix that bypasses:
- The 24-hour stability requirement
- The midnight deployment window

Code review and quality checks still apply.

## Commits being promoted

\`\`\`
${commitList}
\`\`\`
${getTestScopePromptContext()}
## Process

### Step 1: Code Review

Spawn a code-reviewer sub-agent (Task tool, subagent_type: code-reviewer) to review the commits:
- Check for security issues, code quality, spec violations
- Look for disabled tests, placeholder code, hardcoded credentials
- Verify no spec violations (G001-G019)

### Step 2: Create and Merge PR

If code review passes:
1. Run: gh pr create --base main --head staging --title "HOTFIX: Emergency promotion staging -> main" --body "CTO-approved emergency hotfix. Bypasses 24h stability and midnight window."
2. Wait for CI: gh pr checks <number> --watch
3. If CI passes: gh pr merge <number> --merge
4. If CI fails: Report failure via mcp__agent-reports__report_to_deputy_cto

If code review fails:
- Report findings via mcp__agent-reports__report_to_deputy_cto with priority "critical"
- Do NOT proceed with merge

## Timeout

Complete within 25 minutes. If blocked, report and exit.`,
    extraEnv: {
      ...resolvedCredentials,
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
      GENTYR_PROMOTION_PIPELINE: 'true',
    },
    metadata: { commitCount: commits.length, isHotfix: true },
    cwd: wt.cwd,
    mcpConfig: wt.mcpConfig,
    projectDir: PROJECT_DIR,
  });
}



/**
 * Spawn Staging Health Monitor (fire-and-forget via queue).
 * Returns the enqueueSession result: { queueId, position, drained }.
 */
function spawnStagingHealthMonitor() {
  // Read service config directly (Node process is not subject to credential-file-guard).
  // Fall back to known hardcoded values from CLAUDE.md memory if the file is unavailable.
  const serviceConfig = readServiceConfig();
  const stagingRenderId = extractRenderServiceId(serviceConfig?.render?.staging)
    || 'srv-d64bnq0gjchc739kt3q0';
  const vercelProjectId = serviceConfig?.vercel?.projectId || null;

  if (!serviceConfig) {
    log('spawnStagingHealthMonitor: services.json unavailable, using hardcoded staging service ID.');
  }

  const vercelNote = vercelProjectId
    ? `Use Vercel project ID \`${vercelProjectId}\` in your MCP calls.`
    : 'No Vercel project ID configured — skip Vercel checks or use mcp__vercel__vercel_list_projects to discover it.';

  const promptBody = `You are the STAGING Health Monitor.

## Mission

Check all deployment infrastructure for staging environment health. Query services, check for errors, and report any issues found.

## Service IDs (pre-resolved — do NOT read services.json)

- Render staging service ID: \`${stagingRenderId}\`
- Vercel: ${vercelNote}

## Process

### Step 1: Check Render Staging

- Use \`mcp__render__render_get_service\` with the staging service ID for service status
- Use \`mcp__render__render_list_deploys\` to check for recent deploy failures
- Flag: service down, deploy failures, stuck deploys

### Step 2: Check Vercel Staging

- Use \`mcp__vercel__vercel_list_deployments\` for recent staging deployments
- Flag: build failures, deployment errors

### Step 3: Query Elasticsearch for Errors

- Use \`mcp__elastic-logs__query_logs\` with query: \`level:error\`, from: \`now-3h\`, to: \`now\`
- Use \`mcp__elastic-logs__get_log_stats\` grouped by service for error counts
- Flag: error spikes, new error types, critical errors

### Step 4: Compile Health Report

**If issues found:**
1. Call \`mcp__cto-reports__report_to_cto\` with:
   - reporting_agent: "staging-health-monitor"
   - title: "Staging Health Issue: [summary]"
   - summary: Full findings
   - category: "performance" or "blocker" based on severity
   - priority: "normal" or "high" based on severity

2. For actionable issues, create a fix task:
   \`\`\`
   mcp__todo-db__create_task({
     section: "CODE-REVIEWER",
     title: "Fix staging health issue: [summary]",
     description: "[Detailed description of the issue and how to fix it. Include all relevant context: error messages, service IDs, etc.]",
     assigned_by: "staging-health-monitor",
     priority: "normal"
   })
   \`\`\`

**If all clear:**
- Log "Staging environment healthy" and exit

### Step 5: Update Persistent Alerts

Read \`.claude/state/persistent_alerts.json\` (create if missing with \`{"version":1,"alerts":{}}\`).

**If issues found:** Update or create alert with key \`staging_error\`:
- Set \`last_detected_at\` to current ISO timestamp
- Increment \`detection_count\`
- Set \`severity\` to "high"
- Set \`resolved\` to false, \`source\` to "staging-health-monitor"
- If new alert, set \`first_detected_at\`, \`escalation_count\`: 0

**If all clear:** If \`staging_error\` alert exists and is unresolved, set \`resolved: true\`, \`resolved_at\` to current ISO timestamp.

## Timeout

Complete within 10 minutes. This is a read-only monitoring check.`;

  ensureCredentials();
  return enqueueSession({
    title: 'Staging health monitor check',
    agentType: AGENT_TYPES.STAGING_HEALTH_MONITOR,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    tagContext: 'staging-health-monitor',
    source: 'hourly-automation',
    priority: 'low',
    buildPrompt: (agentId) => `[Automation][staging-health-monitor][AGENT:${agentId}] ${promptBody}`,
    extraEnv: { ...resolvedCredentials },
    metadata: {},
    projectDir: PROJECT_DIR,
  });
}

/**
 * Spawn Production Health Monitor (fire-and-forget via queue).
 * Returns the enqueueSession result: { queueId, position, drained }.
 */
function spawnProductionHealthMonitor() {

  // Read service config directly (Node process is not subject to credential-file-guard).
  // Fall back to known hardcoded values from CLAUDE.md memory if the file is unavailable.
  const serviceConfig = readServiceConfig();
  const productionRenderId = extractRenderServiceId(serviceConfig?.render?.production)
    || 'srv-d645aq7pm1nc738i22m0';
  const vercelProjectId = serviceConfig?.vercel?.projectId || null;

  if (!serviceConfig) {
    log('spawnProductionHealthMonitor: services.json unavailable, using hardcoded production service ID.');
  }

  const vercelNote = vercelProjectId
    ? `Use Vercel project ID \`${vercelProjectId}\` in your MCP calls.`
    : 'No Vercel project ID configured — skip Vercel checks or use mcp__vercel__vercel_list_projects to discover it.';

  const promptBody = `You are the PRODUCTION Health Monitor.

## Mission

Check all deployment infrastructure for production environment health. This is CRITICAL -- production issues must be escalated to both deputy-CTO and CTO.

## Service IDs (pre-resolved — do NOT read services.json)

- Render production service ID: \`${productionRenderId}\`
- Vercel: ${vercelNote}

## Process

### Step 1: Check Render Production

- Use \`mcp__render__render_get_service\` with the production service ID for service status
- Use \`mcp__render__render_list_deploys\` to check for recent deploy failures
- Flag: service down, deploy failures, stuck deploys

### Step 2: Check Vercel Production

- Use \`mcp__vercel__vercel_list_deployments\` for recent production deployments
- Flag: build failures, deployment errors

### Step 3: Query Elasticsearch for Errors

- Use \`mcp__elastic-logs__query_logs\` with query: \`level:error\`, from: \`now-1h\`, to: \`now\`
- Use \`mcp__elastic-logs__get_log_stats\` grouped by service for error counts
- Flag: error spikes, new error types, critical errors

### Step 4: Compile Health Report

**If issues found:**
1. Call \`mcp__cto-reports__report_to_cto\` with:
   - reporting_agent: "production-health-monitor"
   - title: "PRODUCTION Health Issue: [summary]"
   - summary: Full findings
   - category: "performance" or "blocker" based on severity
   - priority: "high" or "critical" based on severity

2. Call \`mcp__deputy-cto__add_question\` with:
   - type: "escalation"
   - title: "Production Health Issue: [summary]"
   - description: Full health report findings
   - recommendation: Your recommended fix or action based on the health findings
   - This creates a CTO decision task visible in /deputy-cto

3. For actionable issues, create a fix task:
   \`\`\`
   mcp__todo-db__create_task({
     section: "CODE-REVIEWER",
     title: "Fix production health issue: [summary]",
     description: "[Detailed description of the issue and how to fix it. Include all relevant context: error messages, service IDs, etc.]",
     assigned_by: "production-health-monitor",
     priority: "normal"
   })
   \`\`\`

**If all clear:**
- Log "Production environment healthy" and exit

### Step 5: Update Persistent Alerts

Read \`.claude/state/persistent_alerts.json\` (create if missing with \`{"version":1,"alerts":{}}\`).

**If issues found:** Update or create alert with key \`production_error\`:
- Set \`last_detected_at\` to current ISO timestamp
- Increment \`detection_count\`
- Set \`severity\` to "critical"
- Set \`resolved\` to false, \`source\` to "production-health-monitor"
- If new alert, set \`first_detected_at\`, \`escalation_count\`: 0

**If all clear:** If \`production_error\` alert exists and is unresolved, set \`resolved: true\`, \`resolved_at\` to current ISO timestamp.

## Timeout

Complete within 10 minutes. This is a read-only monitoring check.`;

  ensureCredentials();
  return enqueueSession({
    title: 'Production health monitor check',
    agentType: AGENT_TYPES.PRODUCTION_HEALTH_MONITOR,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    tagContext: 'production-health-monitor',
    source: 'hourly-automation',
    priority: 'low',
    buildPrompt: (agentId) => `[Automation][production-health-monitor][AGENT:${agentId}] ${promptBody}`,
    extraEnv: { ...resolvedCredentials },
    metadata: {},
    projectDir: PROJECT_DIR,
  });
}

/**
 * Get random spec file for standalone compliance checker
 * Reads specs/global/*.md and specs/local/*.md, returns a random one
 */
function getRandomSpec() {
  const specsDir = path.join(PROJECT_DIR, 'specs');
  const specs = [];

  for (const subdir of ['global', 'local']) {
    const dir = path.join(specsDir, subdir);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const f of files) {
        specs.push({ path: `specs/${subdir}/${f}`, id: f.replace('.md', '') });
      }
    }
  }

  if (specs.length === 0) return null;
  return specs[Math.floor(Math.random() * specs.length)];
}

/**
 * Spawn Standalone Antipattern Hunter (fire-and-forget)
 * Scans entire codebase for spec violations, independent of git hooks
 */
function spawnStandaloneAntipatternHunter() {
  const promptBody = `STANDALONE ANTIPATTERN HUNT - Periodic repo-wide scan for spec violations.

You are a STANDALONE antipattern hunter running on a 3-hour schedule. Your job is to systematically scan
the ENTIRE codebase looking for spec violations and technical debt.

## Your Focus Areas
- Hunt across ALL directories: src/, packages/, products/, integrations/
- Look for systemic patterns of violations
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
a. Create TODO item:
   \`\`\`javascript
   mcp__todo-db__create_task({
     section: "CODE-REVIEWER",
     title: "Fix [SPEC-ID] violation in [file]",
     description: "[Details and location]",
     assigned_by: "STANDALONE-ANTIPATTERN-HUNTER"
   })
   \`\`\`

### Step 4: Report Critical Issues to CTO
Report when you find:
- Security violations (G004 hardcoded credentials, G009 missing RLS, G010 missing auth)
- Architecture boundary violations (cross-product separation)
- Critical spec violations requiring immediate attention
- Patterns of repeated violations (3+ similar issues)

\`\`\`javascript
mcp__cto-reports__report_to_cto({
  reporting_agent: "standalone-antipattern-hunter",
  title: "Brief title (max 200 chars)",
  summary: "Detailed summary with file paths, line numbers, and severity (max 2000 chars)",
  category: "security" | "architecture" | "performance" | "other",
  priority: "low" | "normal" | "high" | "critical"
})
\`\`\`

### Step 5: END SESSION
After creating TODO items and CTO reports, provide a summary and END YOUR SESSION.
Do NOT implement fixes yourself.

Focus on finding SYSTEMIC issues across the codebase, not just isolated violations.

**RESTRAINT**: Only create TODO items for CRITICAL violations (security, data exposure, spec G001/G004 violations). Do NOT create tasks for code style, minor improvements, or low-severity patterns. Document minor findings in your summary report instead. Maximum 3 tasks per scan.
`;

  ensureCredentials();
  enqueueSession({
    title: 'Standalone antipattern hunt (3h schedule)',
    agentType: AGENT_TYPES.STANDALONE_ANTIPATTERN_HUNTER,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    tagContext: 'standalone-antipattern-hunter',
    source: 'hourly-automation',
    priority: 'low',
    buildPrompt: () => promptBody,
    extraEnv: { ...resolvedCredentials },
    metadata: {},
    projectDir: PROJECT_DIR,
  });

  return true;
}

/**
 * Spawn Standalone Compliance Checker (fire-and-forget)
 * Picks a random spec and scans the codebase for violations of that specific spec
 */
function spawnStandaloneComplianceChecker(spec) {
  const promptBody = `STANDALONE COMPLIANCE CHECK - Audit codebase against spec: ${spec.id}

You are a STANDALONE compliance checker running on a 1-hour schedule. You have been assigned ONE specific spec to audit the codebase against.

## Your Assigned Spec

**Spec ID:** ${spec.id}
**Spec Path:** ${spec.path}

## Workflow

### Step 1: Load Your Assigned Spec
\`\`\`javascript
mcp__specs-browser__get_spec({ spec_id: "${spec.id}" })
\`\`\`

Read the spec thoroughly. Understand every requirement, constraint, and rule it defines.

### Step 2: Systematically Scan the Codebase
Based on the spec requirements:
1. Use Grep to search for patterns that violate the spec
2. Use Glob to find files that should comply with the spec
3. Read relevant files to check for compliance
4. Focus on areas most likely to have violations

### Step 3: For Each Violation Found
Create a TODO item:
\`\`\`javascript
mcp__todo-db__create_task({
  section: "CODE-REVIEWER",
  title: "Fix ${spec.id} violation in [file]:[line]",
  description: "[Violation details and what the spec requires]",
  assigned_by: "STANDALONE-COMPLIANCE-CHECKER"
})
\`\`\`

### Step 4: Report Critical Issues
If you find critical violations (security, data exposure, architectural), report to CTO:
\`\`\`javascript
mcp__cto-reports__report_to_cto({
  reporting_agent: "standalone-compliance-checker",
  title: "${spec.id} compliance issue: [summary]",
  summary: "Detailed findings with file paths and line numbers",
  category: "security" | "architecture" | "other",
  priority: "normal" | "high" | "critical"
})
\`\`\`

### Step 5: END SESSION
Provide a compliance summary:
- Total files checked
- Violations found (count and severity)
- Overall compliance status for ${spec.id}

Do NOT implement fixes yourself. Only report and create TODOs.

**RESTRAINT**: Only create TODO items for violations that could cause data loss, security exposure, or architectural degradation. Document minor findings in your summary report only. Maximum 2 tasks per scan.
`;

  ensureCredentials();
  enqueueSession({
    title: `Standalone compliance check: ${spec.id}`,
    agentType: AGENT_TYPES.STANDALONE_COMPLIANCE_CHECKER,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    tagContext: 'standalone-compliance-checker',
    source: 'hourly-automation',
    priority: 'low',
    buildPrompt: () => promptBody,
    extraEnv: { ...resolvedCredentials },
    metadata: { specId: spec.id, specPath: spec.path },
    projectDir: PROJECT_DIR,
  });

  return true;
}

/**
 * Main entry point
 */
async function main() {
  const startTime = Date.now();
  log('=== Hourly Automation Starting ===');

  // Drain any items that were queued but not yet spawned in a previous cycle.
  await drainQueue();

  // Check config
  const config = getConfig();

  // NOTE: !config.enabled check is deferred to after session reviver.
  // Session reviver runs even when automation is disabled (recovery operation).

  // CTO Activity Gate: require /deputy-cto within last 24h
  // GAP 5: Gate is now a flag, not an early exit. Monitoring steps (health monitors,
  // triage, CI checks, persistent alerts) always run. Gate-required steps (lint,
  // task runner, promotions, etc.) are skipped when gate is closed.
  const ctoGate = checkCtoActivityGate(config);
  const ctoGateOpen = ctoGate.open;
  if (!ctoGateOpen) {
    log(`CTO Activity Gate CLOSED: ${ctoGate.reason}`);
    log('Monitoring-only mode: health monitors, triage, and CI checks will still run.');
  } else {
    log(`Autonomous Deputy CTO Mode is ENABLED. ${ctoGate.reason}`);
  }

  // Credentials are resolved lazily on first agent spawn via ensureCredentials().
  // This avoids unnecessary `op` CLI calls on cycles where all tasks hit cooldowns.

  // Overdrive and reaper removed — session queue manages concurrency and stale PID cleanup.

  const localMode = isLocalModeEnabled(PROJECT_DIR);
  if (localMode) {
    log('Local mode is enabled. Skipping remote service automations.');
  }

  const state = getState();
  const now = Date.now();

  // =========================================================================
  // SESSION REVIVER
  // Gate-exempt: recovery operation. Runs even with config.enabled=false.
  // Phase 4a: Moved BEFORE concurrency guard so revival is never blocked by
  // a full agent pool. The reviver has its own internal concurrency check.
  // NOTE: Keeps manual cooldown pattern (retroactive first-run logic)
  // =========================================================================
  const SESSION_REVIVER_COOLDOWN_MS = getCooldown('session_reviver', 10) * 60 * 1000;
  const timeSinceLastSessionReviver = now - (state.lastSessionReviverCheck || 0);

  if (timeSinceLastSessionReviver >= SESSION_REVIVER_COOLDOWN_MS) {
    try {
      const reviverResult = await reviveInterruptedSessions(log, MAX_CONCURRENT_AGENTS);
      if (reviverResult.revivedDead > 0) {
        log(`Session reviver: revived ${reviverResult.revivedDead} dead sessions`);
      }
    } catch (err) {
      log(`Session reviver error (non-fatal): ${err.message}`);
    }
    state.lastSessionReviverCheck = now;
    saveState(state);
  } else {
    const minutesLeft = Math.ceil((SESSION_REVIVER_COOLDOWN_MS - timeSinceLastSessionReviver) / 60000);
    log(`Session reviver cooldown active. ${minutesLeft}m until next check.`);
  }

  // Concurrency is now managed by the session queue (drainQueue called at top of main).
  // No per-cycle guard needed — the queue enforces MAX_CONCURRENT_AGENTS on every enqueue.

  // =========================================================================
  // SESSION REAPER (after session reviver — complements revival with cleanup)
  // Gate-exempt: recovery/cleanup operation. Runs even with config.enabled=false.
  // =========================================================================
  await runIfDue('session_reaper', {
    state, now,
    stateKey: 'lastSessionReaperRun',
    label: 'Session reaper',
    fn: async () => {
      const stuckAlive = getStuckAliveSessions();
      if (stuckAlive.length > 0) {
        const reaperResult = await reapAsyncPass(PROJECT_DIR, stuckAlive, { log });
        log(`Session reaper: ${reaperResult.hardKilled} hard-killed, ${reaperResult.completedReaped} reaped`);
      }
      cleanupAuditLog();
      cleanupDebugLog();

      // Clean up old revival events (24h retention)
      try {
        const qDb = new Database(path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db'));
        qDb.pragma('busy_timeout = 3000');
        qDb.prepare("DELETE FROM revival_events WHERE created_at < datetime('now', '-24 hours')").run();
        qDb.close();
      } catch (_) { /* non-fatal — table may not exist yet */ }

      // Clean up orphaned progress files (agent no longer running)
      const agentProgressDir = path.join(PROJECT_DIR, '.claude', 'state', 'agent-progress');
      if (fs.existsSync(agentProgressDir)) {
        try {
          for (const file of fs.readdirSync(agentProgressDir)) {
            if (!file.endsWith('.json')) continue;
            const agentId = file.replace('.json', '');
            // Check if this agent is still running in the queue
            try {
              const queueDb = new Database(path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db'), { readonly: true });
              const running = queueDb.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE agent_id = ? AND status = 'running'").get(agentId);
              queueDb.close();
              if (!running || running.cnt === 0) {
                // Retire instead of delete — monitors may still need the data
                const filePath = path.join(agentProgressDir, file);
                try { fs.renameSync(filePath, filePath + '.retired'); } catch (_) { /* non-fatal */ }
              }
            } catch (_) { /* non-fatal */ }
          }
        } catch (_) { /* non-fatal */ }
      }
    },
  });

  // =========================================================================
  // PLAN ORPHAN REVIVAL HELPER
  // Creates a new plan-manager persistent task and enqueues it for an
  // active plan whose previous plan-manager is missing or terminal.
  // =========================================================================

  async function reviveOrphanedPlan(plan, ptDbPath, plansDbPath) {
    if (!Database) throw new Error('Database not available');

    const ptId = randomUUID();
    const nowTs = new Date().toISOString();

    // Create new persistent task for the plan-manager
    const ptDb = new Database(ptDbPath);
    ptDb.pragma('journal_mode = WAL');
    ptDb.pragma('busy_timeout = 3000');

    const prompt = `You are a plan-manager for plan "${plan.title}" (ID: ${plan.id}). ` +
      `Follow the plan-manager agent instructions. Your plan ID is ${plan.id}. ` +
      `Your persistent task ID is ${ptId}. ` +
      `Check get_spawn_ready_tasks, create and activate persistent tasks for ready plan tasks, ` +
      `monitor their progress, and advance the plan through all phases until complete.`;

    const metadata = JSON.stringify({ plan_id: plan.id, plan_title: plan.title });

    ptDb.prepare(
      `INSERT INTO persistent_tasks (id, title, prompt, outcome_criteria, status, metadata, created_at, activated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`
    ).run(
      ptId,
      `Plan Manager: ${plan.title}`,
      prompt,
      `All phases of plan ${plan.id} are completed or skipped.`,
      metadata,
      nowTs,
      nowTs,
    );

    ptDb.prepare(
      "INSERT INTO events (id, persistent_task_id, event_type, details, created_at) VALUES (?, ?, 'activated', ?, ?)"
    ).run(randomUUID(), ptId, JSON.stringify({ source: 'plan-orphan-detection', plan_id: plan.id, previous_pt_id: plan.persistent_task_id }), nowTs);

    ptDb.close();

    // Link the new persistent task to the plan (TOCTOU-safe: only update if still stale)
    const planDb = new Database(plansDbPath);
    planDb.pragma('journal_mode = WAL');
    planDb.pragma('busy_timeout = 3000');
    const updateResult = planDb.prepare(
      'UPDATE plans SET persistent_task_id = ?, updated_at = ? WHERE id = ? AND (persistent_task_id IS NULL OR persistent_task_id = ?)'
    ).run(ptId, nowTs, plan.id, plan.persistent_task_id);

    if (updateResult.changes === 0) {
      // Another mechanism already updated the plan — clean up orphaned persistent task
      planDb.close();
      log(`Plan orphan detection: plan "${plan.title}" was already claimed — cleaning up orphaned persistent task ${ptId}`);
      try {
        const ptDb2 = new Database(ptDbPath);
        ptDb2.pragma('busy_timeout = 3000');
        ptDb2.prepare("DELETE FROM persistent_tasks WHERE id = ?").run(ptId);
        ptDb2.prepare("DELETE FROM events WHERE persistent_task_id = ?").run(ptId);
        ptDb2.close();
      } catch (_) { /* non-fatal */ }
      return;
    }

    planDb.prepare(
      "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'plan', ?, 'persistent_task_id', ?, ?, ?, 'plan-orphan-detection')"
    ).run(randomUUID(), plan.id, plan.persistent_task_id || 'NULL', ptId, nowTs);
    planDb.close();

    // Enqueue the plan-manager monitor
    const monitorPrompt = [
      `[Automation][persistent-monitor][plan-manager] You are the plan-manager for plan "${plan.title}" (ID: ${plan.id}).`,
      `Your persistent task ID is ${ptId}.`,
      '',
      `Follow the plan-manager agent instructions in your agent definition.`,
      `Your job: poll get_spawn_ready_tasks, create persistent tasks for ready plan steps,`,
      `monitor them, and advance the plan until all phases complete.`,
      '',
      `This is a REVIVAL — the previous plan-manager died or was lost. Check plan status first.`,
      `Environment: GENTYR_PLAN_MANAGER=true, GENTYR_PLAN_ID=${plan.id}, GENTYR_PERSISTENT_TASK_ID=${ptId}`,
    ].join('\n');

    const result = enqueueSession({
      title: `[Plan Manager] Revival: ${plan.title}`,
      agentType: AGENT_TYPES.PERSISTENT_TASK_MONITOR,
      hookType: HOOK_TYPES.PERSISTENT_TASK_MONITOR,
      tagContext: 'plan-manager',
      source: 'hourly-automation',
      priority: 'critical',
      lane: 'persistent',
      ttlMs: 0,
      prompt: monitorPrompt,
      projectDir: PROJECT_DIR,
      agent: 'plan-manager',
      extraEnv: {
        GENTYR_PLAN_MANAGER: 'true',
        GENTYR_PLAN_ID: plan.id,
        GENTYR_PERSISTENT_TASK_ID: ptId,
        GENTYR_PERSISTENT_MONITOR: 'true',
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
      },
      metadata: {
        persistentTaskId: ptId,
        planId: plan.id,
        revivalReason: 'plan_orphan_detection',
      },
    });

    log(`Plan orphan detection: revived plan "${plan.title}" — new ptId=${ptId}, queueId=${result.queueId || 'blocked'}`);

    try {
      auditEvent('plan_manager_revived', { plan_id: plan.id, persistent_task_id: ptId, previous_pt_id: plan.persistent_task_id, queue_id: result.queueId });
    } catch (_) { /* non-fatal */ }
  }

  // =========================================================================
  // PERSISTENT MONITOR REVIVAL PROMPT HELPER
  // Shared by the health check and the stale-pause auto-resume block below.
  // =========================================================================

  /**
   * Build the revival prompt, extraEnv, and metadata for re-enqueueing a
   * persistent monitor session.
   *
   * @param {object} task  - Row from persistent_tasks (id, title, metadata, monitor_session_id)
   * @param {string} revivalReason - Reason string stored in queue metadata (e.g. 'monitor_dead', 'stale_pause_resumed')
   * @returns {{ prompt: string, extraEnv: object, metadata: object }}
   */
  // buildPersistentMonitorRevivalPrompt is now imported from lib/persistent-monitor-revival-prompt.js
  // Local wrapper that binds PROJECT_DIR for backward compatibility with callers in this file.
  async function buildRevivalPrompt(task, revivalReason) {
    return buildPersistentMonitorRevivalPrompt(task, revivalReason, PROJECT_DIR);
  }

  // =========================================================================
  // PERSISTENT MONITOR HEALTH CHECK (gate-exempt, 15-minute cooldown)
  // Detects dead persistent task monitors and re-spawns them.
  // =========================================================================
  await runIfDue('persistent_monitor_health', {
    state, now,
    stateKey: 'lastPersistentMonitorHealthRun',
    label: 'Persistent monitor health',
    fn: async () => {
      const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
      if (!Database || !fs.existsSync(ptDbPath)) return;

      let ptDb;
      try {
        ptDb = new Database(ptDbPath);
        ptDb.pragma('busy_timeout = 3000');
      } catch (err) {
        log(`Persistent monitor health: DB open failed: ${err.message}`);
        return;
      }

      const activeTasks = ptDb.prepare(
        "SELECT id, title, monitor_pid, monitor_agent_id, last_heartbeat, metadata, monitor_session_id FROM persistent_tasks WHERE status = 'active'"
      ).all();

      let revived = 0;
      for (const task of activeTasks) {
        // Check if monitor PID is alive
        let alive = false;
        if (task.monitor_pid) {
          try { process.kill(task.monitor_pid, 0); alive = true; } catch (_) { /* dead */ }
        }

        if (!alive) {
          // Dedup: check if a monitor is already queued or running in session-queue for this task
          try {
            const queueDb = new Database(path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db'), { readonly: true });
            const existing = queueDb.prepare(
              "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND metadata LIKE ?"
            ).get(`%"persistentTaskId":"${task.id}"%`);
            queueDb.close();
            if (existing && existing.cnt > 0) {
              log(`Persistent monitor health: monitor for "${task.title}" already queued/running/spawning in session-queue — skipping`);
              continue;
            }
          } catch (_) { /* non-fatal — proceed with enqueue */ }

          log(`Persistent monitor health: monitor for "${task.title}" (${task.id}) is dead — re-enqueuing`);

          try {
            const { prompt, extraEnv, metadata, agent } = await buildRevivalPrompt(task, 'monitor_dead');
            const result = enqueueSession({
              title: `[Persistent] Monitor revival: ${task.title}`,
              agentType: AGENT_TYPES.PERSISTENT_TASK_MONITOR,
              hookType: HOOK_TYPES.PERSISTENT_TASK_MONITOR,
              tagContext: 'persistent-monitor',
              source: 'hourly-automation',
              priority: 'critical',
              lane: 'persistent',
              ttlMs: 0,
              prompt,
              projectDir: PROJECT_DIR,
              extraEnv,
              metadata,
              agent,
            });

            log(`Persistent monitor health: re-enqueued for "${task.title}" (queueId: ${result.queueId})`);
            try { auditEvent('persistent_monitor_revived', { task_id: task.id, title: task.title, source: 'hourly-automation' }); } catch (_) { /* non-fatal */ }
            revived++;
          } catch (err) {
            log(`Persistent monitor health: failed to re-enqueue for "${task.title}": ${err.message}`);
          }
        } else if (task.last_heartbeat) {
          // PID alive but check for stale heartbeat
          const heartbeatAge = Date.now() - parseSqliteDatetime(task.last_heartbeat).getTime();
          const staleKillMinutes = (config.persistent_monitor_stale_kill_minutes != null)
            ? config.persistent_monitor_stale_kill_minutes
            : 30;
          const staleKillMs = staleKillMinutes * 60 * 1000;
          if (heartbeatAge > staleKillMs) {
            log(`Persistent monitor health: "${task.title}" has stale heartbeat (${Math.round(heartbeatAge / 60000)}min, threshold=${staleKillMinutes}min) — killing stuck monitor PID ${task.monitor_pid}`);

            // Verify PID identity before killing (defense against PID reuse)
            if (!isClaudeProcess(task.monitor_pid)) {
              log(`Persistent monitor health: PID ${task.monitor_pid} is no longer a Claude process — skipping kill for "${task.title}"`);
            } else {
              // Send SIGTERM first
              try {
                process.kill(task.monitor_pid, 'SIGTERM');
                log(`Persistent monitor health: sent SIGTERM to PID ${task.monitor_pid} for "${task.title}"`);
                auditEvent('persistent_monitor_killed', { task_id: task.id, pid: task.monitor_pid, signal: 'SIGTERM', reason: 'stale_heartbeat' });
              } catch (killErr) {
                log(`Persistent monitor health: SIGTERM failed for PID ${task.monitor_pid}: ${killErr.message} (may already be dead)`);
              }

              // Wait briefly for graceful shutdown
              try {
                execSync('sleep 2');
              } catch (_) { /* non-fatal */ }

              // Check if still alive and SIGKILL if needed
              let stillAlive = false;
              try {
                process.kill(task.monitor_pid, 0);
                stillAlive = true;
              } catch (_) { /* process is dead — good */ }

              if (stillAlive) {
                try {
                  process.kill(task.monitor_pid, 'SIGKILL');
                  log(`Persistent monitor health: sent SIGKILL to PID ${task.monitor_pid} for "${task.title}" (did not exit after SIGTERM)`);
                  auditEvent('persistent_monitor_killed', { task_id: task.id, pid: task.monitor_pid, signal: 'SIGKILL', reason: 'stale_heartbeat' });
                } catch (killErr) {
                  log(`Persistent monitor health: SIGKILL failed for PID ${task.monitor_pid}: ${killErr.message}`);
                }
              }
            }

            // Mark the queue item as failed so revival code can re-enqueue on next cycle
            try {
              const queueDb = new Database(path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db'));
              queueDb.pragma('busy_timeout = 3000');
              const updateResult = queueDb.prepare(
                "UPDATE queue_items SET status = 'failed', error = 'stale_heartbeat_killed', completed_at = datetime('now') WHERE pid = ? AND lane = 'persistent' AND status = 'running'"
              ).run(task.monitor_pid);
              queueDb.close();
              if (updateResult.changes > 0) {
                log(`Persistent monitor health: marked queue item failed for PID ${task.monitor_pid} (stale heartbeat kill)`);
              } else {
                log(`Persistent monitor health: no running queue item found for PID ${task.monitor_pid} — may have already completed`);
              }
            } catch (dbErr) {
              log(`Persistent monitor health: failed to update session-queue.db for PID ${task.monitor_pid}: ${dbErr.message}`);
            }
          }
        }
      }

      // Auto-deactivate reserved slots when no persistent tasks are active or paused
      if (activeTasks.length === 0) {
        const pausedCount = ptDb.prepare("SELECT COUNT(*) as cnt FROM persistent_tasks WHERE status = 'paused'").get().cnt;
        if (pausedCount === 0) {
          try {
            const { getReservedSlots, setReservedSlots } = await import('./lib/session-queue.js');
            if (getReservedSlots() > 0) {
              setReservedSlots(0);
              log('Persistent monitor health: no active/paused persistent tasks — released reserved slots');
            }
          } catch (_) { /* non-fatal */ }
        }
      }

      ptDb.close();
      if (revived > 0) {
        log(`Persistent monitor health: revived ${revived} monitor(s)`);
      }
      debugLog('hourly-automation', 'persistent_monitor_health', { activeCount: activeTasks.length, revived });
    },
  });

  // =========================================================================
  // PERSISTENT STALE PAUSE AUTO-RESUME (15-minute runIfDue cooldown)
  // Detects paused tasks whose pause event is older than the configured
  // threshold and auto-resumes them. Rate limits and other transient issues
  // should NOT cause self-pause (see persistent-monitor.md), but this block
  // is the safety net for cases where a monitor paused itself incorrectly.
  // =========================================================================
  await runIfDue('persistent_stale_pause_resume', {
    state, now,
    stateKey: 'lastPersistentStalePauseResumeRun',
    label: 'Persistent stale pause auto-resume',
    fn: async () => {
      const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
      if (!Database || !fs.existsSync(ptDbPath)) return;

      let ptDb;
      try {
        ptDb = new Database(ptDbPath);
        ptDb.pragma('busy_timeout = 3000');
      } catch (err) {
        log(`Persistent stale pause auto-resume: DB open failed: ${err.message}`);
        return;
      }

      try {
        const pausedTasks = ptDb.prepare(
          "SELECT id, title, metadata, monitor_session_id FROM persistent_tasks WHERE status = 'paused'"
        ).all();

        if (pausedTasks.length === 0) return;

        const thresholdMinutes = getCooldown('persistent_pause_auto_resume_minutes', 30);
        const thresholdMs = thresholdMinutes * 60 * 1000;
        const now2 = Date.now();
        let resumed = 0;

        for (const task of pausedTasks) {
          // Bypass request guard — skip tasks with pending CTO bypass requests
          try {
            const { checkBypassBlock } = await import('./lib/bypass-guard.js');
            const bypassCheck = checkBypassBlock('persistent', task.id);
            if (bypassCheck.blocked) {
              log(`Persistent stale pause auto-resume: "${task.title}" has pending CTO bypass request — skipping`);
              continue;
            }
          } catch (_) { /* non-fatal — fail open */ }

          // Find the most recent 'paused' event for this task
          const pauseEvent = ptDb.prepare(
            "SELECT created_at FROM events WHERE persistent_task_id = ? AND event_type = 'paused' ORDER BY created_at DESC LIMIT 1"
          ).get(task.id);

          if (!pauseEvent) {
            log(`Persistent stale pause auto-resume: "${task.title}" has no pause event — skipping`);
            continue;
          }

          const pauseAge = now2 - parseSqliteDatetime(pauseEvent.created_at).getTime();
          if (pauseAge < thresholdMs) {
            log(`Persistent stale pause auto-resume: "${task.title}" paused ${Math.round(pauseAge / 60000)}min ago — below ${thresholdMinutes}min threshold`);
            continue;
          }

          // Dedup: check if a monitor is already queued or running for this task
          try {
            const queueDb = new Database(path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db'), { readonly: true });
            const existing = queueDb.prepare(
              "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND metadata LIKE ?"
            ).get(`%"persistentTaskId":"${task.id}"%`);
            queueDb.close();
            if (existing && existing.cnt > 0) {
              log(`Persistent stale pause auto-resume: monitor for "${task.title}" already queued/running/spawning — skipping`);
              continue;
            }
          } catch (_) { /* non-fatal — proceed with resume */ }

          // Validate 1Password connectivity before auto-resuming
          // Only gates when token IS configured but unreachable — skip check entirely when unconfigured
          if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
            let opReachable = false;
            try {
              execFileSync('op', ['whoami'], {
                encoding: 'utf-8',
                timeout: 10000,
                stdio: 'pipe',
              });
              opReachable = true;
            } catch (_) { /* op unreachable */ }
            if (!opReachable) {
              log(`Persistent stale pause auto-resume: "${task.title}" — 1Password unreachable, skipping resume`);
              continue;
            }
          }

          // Crash-loop paused tasks use a separate cooldown (default 15min, configurable)
          const pauseDetails = (() => {
            try {
              const evt = ptDb.prepare(
                "SELECT details FROM events WHERE persistent_task_id = ? AND event_type = 'paused' ORDER BY created_at DESC LIMIT 1"
              ).get(task.id);
              return evt?.details ? JSON.parse(evt.details) : {};
            } catch { return {}; }
          })();

          if (pauseDetails.reason === 'crash_loop_circuit_breaker') {
            const crashLoopCooldownMinutes = getCooldown('crash_loop_auto_resume_minutes', 15);
            const crashLoopCooldownMs = crashLoopCooldownMinutes * 60 * 1000;
            if (pauseAge < crashLoopCooldownMs) {
              log(`Persistent stale pause auto-resume: "${task.title}" was crash-loop paused ${Math.round(pauseAge / 60000)}min ago — below ${crashLoopCooldownMinutes}min crash-loop threshold`);
              continue;
            }
          }

          // do_not_auto_resume metadata flag — set by CTO or amendments to permanently suppress auto-resume
          try {
            const meta = task.metadata ? JSON.parse(task.metadata) : {};
            if (meta.do_not_auto_resume) {
              log(`Persistent stale pause auto-resume: "${task.title}" has do_not_auto_resume flag — skipping`);
              continue;
            }
          } catch (_) { /* non-fatal */ }

          // Self-pause circuit breaker: if the monitor has paused itself 3+ times in the last hour,
          // it's likely reading an amendment telling it to stay paused. Stop reviving it.
          try {
            const oneHourAgo = new Date(now2 - 60 * 60 * 1000).toISOString();
            const recentPauses = ptDb.prepare(
              "SELECT COUNT(*) as cnt FROM events WHERE persistent_task_id = ? AND event_type = 'paused' AND created_at > ?"
            ).get(task.id, oneHourAgo);
            if (recentPauses && recentPauses.cnt >= 3) {
              log(`Persistent stale pause auto-resume: "${task.title}" has self-paused ${recentPauses.cnt} times in the last hour — suppressing auto-resume (likely amendment-directed)`);
              // Set the flag so we don't keep checking every cycle
              try {
                const meta = task.metadata ? JSON.parse(task.metadata) : {};
                meta.do_not_auto_resume = true;
                ptDb.prepare("UPDATE persistent_tasks SET metadata = ? WHERE id = ?").run(JSON.stringify(meta), task.id);
              } catch (_) { /* non-fatal */ }
              continue;
            }
          } catch (_) { /* non-fatal */ }

          log(`Persistent stale pause auto-resume: resuming "${task.title}" (paused ${Math.round(pauseAge / 60000)}min ago, threshold=${thresholdMinutes}min)`);

          // Transition task back to active
          ptDb.prepare("UPDATE persistent_tasks SET status = 'active' WHERE id = ?").run(task.id);
          ptDb.prepare(
            "INSERT INTO events (id, persistent_task_id, event_type, details, created_at) VALUES (?, ?, 'resumed', ?, datetime('now'))"
          ).run(
            randomUUID(),
            task.id,
            JSON.stringify({ reason: 'auto_resumed_stale_pause', pause_age_minutes: Math.round(pauseAge / 60000) })
          );

          // Enqueue the monitor
          try {
            const { prompt, extraEnv, metadata, agent } = await buildRevivalPrompt(task, 'stale_pause_resumed');
            const result = enqueueSession({
              title: `[Persistent] Stale-pause revival: ${task.title}`,
              agentType: AGENT_TYPES.PERSISTENT_TASK_MONITOR,
              hookType: HOOK_TYPES.PERSISTENT_TASK_MONITOR,
              tagContext: 'persistent-monitor',
              source: 'hourly-automation',
              priority: 'critical',
              lane: 'persistent',
              ttlMs: 0,
              prompt,
              projectDir: PROJECT_DIR,
              extraEnv,
              metadata,
              agent,
            });

            log(`Persistent stale pause auto-resume: enqueued monitor for "${task.title}" (queueId: ${result.queueId})`);
            try { auditEvent('persistent_task_auto_resumed', { task_id: task.id, title: task.title, pause_age_minutes: Math.round(pauseAge / 60000) }); } catch (_) { /* non-fatal */ }
            resumed++;
          } catch (err) {
            log(`Persistent stale pause auto-resume: failed to enqueue monitor for "${task.title}": ${err.message}`);
            // Roll back the status update so the task doesn't get stuck in active with no monitor
            try {
              ptDb.prepare("UPDATE persistent_tasks SET status = 'paused' WHERE id = ?").run(task.id);
            } catch (_) { /* non-fatal */ }
          }
        }

        if (resumed > 0) {
          log(`Persistent stale pause auto-resume: resumed ${resumed} task(s)`);
        }
        debugLog('hourly-automation', 'persistent_stale_pause_resume', { pausedCount: pausedTasks.length, resumed });
      } finally {
        try { ptDb.close(); } catch (_) { /* non-fatal */ }
      }
    },
  });

  // =========================================================================
  // PLAN ORPHAN DETECTION (gate-exempt, 10-minute cooldown)
  // Detects active plans whose plan-manager persistent task is missing,
  // dead, or in a terminal state, and re-creates the plan-manager.
  // =========================================================================
  await runIfDue('plan_orphan_detection', {
    state, now,
    stateKey: 'lastPlanOrphanDetectionRun',
    label: 'Plan orphan detection',
    fn: async () => {
      const plansDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
      const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
      if (!Database || !fs.existsSync(plansDbPath)) return;

      let plansDb;
      try {
        plansDb = new Database(plansDbPath, { readonly: true });
        plansDb.pragma('busy_timeout = 3000');
      } catch (err) {
        log(`Plan orphan detection: plans.db open failed: ${err.message}`);
        return;
      }

      try {
        const activePlans = plansDb.prepare(
          "SELECT id, title, persistent_task_id FROM plans WHERE status = 'active'"
        ).all();

        if (activePlans.length === 0) return;

        let revived = 0;
        for (const plan of activePlans) {
          // Case 1: Plan has no persistent_task_id at all — activation hook never fired or failed
          if (!plan.persistent_task_id) {
            log(`Plan orphan detection: plan "${plan.title}" (${plan.id}) has no persistent_task_id — re-creating plan-manager`);
            try {
              await reviveOrphanedPlan(plan, ptDbPath, plansDbPath);
              revived++;
            } catch (err) {
              log(`Plan orphan detection: failed to revive plan "${plan.title}": ${err.message}`);
            }
            continue;
          }

          // Case 2: Plan has a persistent_task_id — check if that task is still alive
          if (!fs.existsSync(ptDbPath)) {
            log(`Plan orphan detection: persistent-tasks.db not found — cannot verify plan "${plan.title}"`);
            continue;
          }

          let ptDb;
          try {
            ptDb = new Database(ptDbPath, { readonly: true });
            ptDb.pragma('busy_timeout = 3000');
            const ptTask = ptDb.prepare(
              "SELECT id, status FROM persistent_tasks WHERE id = ?"
            ).get(plan.persistent_task_id);
            ptDb.close();

            if (!ptTask) {
              log(`Plan orphan detection: plan "${plan.title}" linked to missing persistent task ${plan.persistent_task_id} — re-creating`);
              await reviveOrphanedPlan(plan, ptDbPath, plansDbPath);
              revived++;
            } else if (ptTask.status === 'completed' || ptTask.status === 'cancelled' || ptTask.status === 'failed') {
              log(`Plan orphan detection: plan "${plan.title}" linked to ${ptTask.status} persistent task ${plan.persistent_task_id} — re-creating`);
              await reviveOrphanedPlan(plan, ptDbPath, plansDbPath);
              revived++;
            } else if (ptTask.status === 'paused') {
              // Check if the persistent task is permanently blocked from auto-resume
              try {
                const ptDbRo = new Database(ptDbPath, { readonly: true });
                ptDbRo.pragma('busy_timeout = 3000');
                const ptFull = ptDbRo.prepare("SELECT metadata FROM persistent_tasks WHERE id = ?").get(plan.persistent_task_id);
                ptDbRo.close();
                if (ptFull?.metadata) {
                  const meta = JSON.parse(ptFull.metadata);
                  if (meta.do_not_auto_resume) {
                    log(`Plan orphan detection: plan "${plan.title}" linked to paused persistent task ${plan.persistent_task_id} with do_not_auto_resume — re-creating plan-manager`);
                    await reviveOrphanedPlan(plan, ptDbPath, plansDbPath);
                    revived++;
                  }
                }
              } catch (_) { /* non-fatal — if paused without the flag, stale-pause auto-resume handles it */ }
            }
            // If ptTask.status is 'active', the existing persistent task revival mechanisms handle it
            // If ptTask.status is 'paused' without do_not_auto_resume, stale-pause auto-resume handles it
          } catch (err) {
            log(`Plan orphan detection: error checking persistent task for plan "${plan.title}": ${err.message}`);
            try { ptDb?.close(); } catch (_) {}
          }
        }

        if (revived > 0) {
          log(`Plan orphan detection: revived ${revived} orphaned plan(s)`);
        }
        debugLog('hourly-automation', 'plan_orphan_detection', { activePlans: activePlans.length, revived });
      } finally {
        try { plansDb.close(); } catch (_) {}
      }
    },
  });

  // =========================================================================
  // ENABLED CHECK — session revival still ran above even if disabled
  // =========================================================================
  if (!config.enabled) {
    log('Autonomous Deputy CTO Mode is DISABLED. Exiting.');
    registerHookExecution({
      hookType: HOOK_TYPES.HOURLY_AUTOMATION,
      status: 'skipped',
      durationMs: Date.now() - startTime,
      metadata: { reason: 'disabled' }
    });
    process.exit(0);
  }

  // =========================================================================
  // BINARY PATCH VERSION WATCH (gate-exempt, cooldown-based)
  // Detects Claude updates and re-applies patches if needed
  // =========================================================================
  await runIfDue('version_watch', {
    state, now, intervals: config.intervals,
    stateKey: 'lastVersionWatchRun',
    label: 'Version watch',
    fn: async () => {
      try {
        const { checkAndRepatch } = await import(
          path.join(PROJECT_DIR, 'scripts', 'watch-claude-version.js')
        );
        await checkAndRepatch(log);
      } catch (err) {
        // Non-fatal: version watch is optional (module may not exist)
        if (err.code !== 'ERR_MODULE_NOT_FOUND') {
          throw err;
        }
      }
    },
  });

  // =========================================================================
  // TRIAGE CHECK (dynamic interval, default 5 min)
  // Per-item cooldown is handled by the MCP server's get_reports_for_triage
  // =========================================================================
  await runIfDue('triage_check', {
    state, now, intervals: config.intervals,
    stateKey: 'lastTriageCheck',
    label: 'Triage check',
    fn: async () => {
      if (hasReportsReadyForTriage()) {
        log('Pending reports found, spawning triage agent...');
        // The agent will call get_reports_for_triage which handles cooldown filtering
        spawnReportTriage();
        log('Report triage enqueued.');
      } else {
        log('No pending reports found.');
      }
    },
  });

  // =========================================================================
  // STAGING HEALTH MONITOR (3h cooldown, fire-and-forget) [GATE-EXEMPT]
  // Checks staging infrastructure health
  // =========================================================================
  await runIfDue('staging_health_monitor', {
    state, now, intervals: config.intervals,
    stateKey: 'lastStagingHealthCheck',
    configToggle: 'stagingHealthMonitorEnabled',
    config,
    localModeSkip: localMode,
    label: 'Staging health monitor',
    fn: async () => {
      try {
        execSync('git fetch origin staging --quiet 2>/dev/null || true', {
          cwd: PROJECT_DIR, encoding: 'utf8', timeout: 30000, stdio: 'pipe',
        });
      } catch (err) {
        console.error('[hourly-automation] Warning:', err.message);
        log('Staging health monitor: git fetch failed.');
      }

      if (!remoteBranchExists('staging')) {
        log('Staging health monitor: staging branch does not exist, skipping.');
        return;
      }
      if (!hasHealthMonitorCredentials()) {
        log('Staging health monitor: skipped (missing credentials).');
        return;
      }
      log('Staging health monitor: spawning health check...');
      spawnStagingHealthMonitor();
      log('Staging health monitor: enqueued (fire-and-forget).');
    },
  });

  // =========================================================================
  // PRODUCTION HEALTH MONITOR (1h cooldown, fire-and-forget) [GATE-EXEMPT]
  // Checks production infrastructure health, escalates to CTO
  // =========================================================================
  await runIfDue('production_health_monitor', {
    state, now, intervals: config.intervals,
    stateKey: 'lastProductionHealthCheck',
    configToggle: 'productionHealthMonitorEnabled',
    config,
    localModeSkip: localMode,
    label: 'Production health monitor',
    fn: async () => {
      if (!hasHealthMonitorCredentials()) {
        log('Production health monitor: skipped (missing credentials).');
        return;
      }
      log('Production health monitor: spawning health check...');
      spawnProductionHealthMonitor();
      log('Production health monitor: enqueued (fire-and-forget).');
    },
  });

  // =========================================================================
  // CI MONITORING (every cycle, gate-exempt)
  // GAP 3: Check GitHub Actions CI status for main and staging branches
  // =========================================================================
  try {
    checkCiStatus();
  } catch (err) {
    log(`CI monitoring error (non-fatal): ${err.message}`);
  }

  // =========================================================================
  // MERGE CHAIN GAP CHECK (every cycle, gate-exempt)
  // GAP 7: Alert when staging is too far ahead of main (>50 commits)
  // =========================================================================
  try {
    // Ensure we have fresh refs (staging health monitor may have fetched staging already)
    try {
      execSync('git fetch origin staging main --quiet 2>/dev/null || true', {
        cwd: PROJECT_DIR, encoding: 'utf8', timeout: 30000, stdio: 'pipe',
      });
    } catch (err) {
      console.error('[hourly-automation] Warning:', err.message);
      // Non-fatal, may already have fresh refs
    }

    if (remoteBranchExists('staging') && remoteBranchExists('main')) {
      const gapCommits = getNewCommits('staging', 'main');
      if (gapCommits.length >= MERGE_CHAIN_GAP_THRESHOLD) {
        log(`Merge chain gap: ${gapCommits.length} commits on staging not in main (threshold: ${MERGE_CHAIN_GAP_THRESHOLD}).`);
        recordAlert('merge_chain_gap', {
          title: `Merge chain gap: ${gapCommits.length} commits on staging not merged to main`,
          severity: 'high',
          source: 'merge-chain-monitor',
        });
      } else {
        resolveAlert('merge_chain_gap');
        log(`Merge chain gap: ${gapCommits.length} commits (under threshold ${MERGE_CHAIN_GAP_THRESHOLD}).`);
      }
    }
  } catch (err) {
    log(`Merge chain gap check error (non-fatal): ${err.message}`);
  }

  // =========================================================================
  // PERSISTENT ALERT CHECK (every cycle, gate-exempt)
  // GAP 2: Re-escalate unresolved alerts past their threshold and GC old ones
  // =========================================================================
  try {
    const alertResult = checkPersistentAlerts();
    if (alertResult.escalated > 0 || alertResult.gcCount > 0) {
      log(`Persistent alerts: processed (${alertResult.escalated} escalated, ${alertResult.gcCount} gc'd).`);
    }
  } catch (err) {
    log(`Persistent alerts error (non-fatal): ${err.message}`);
  }

  // =========================================================================
  // URGENT TASK DISPATCHER (no cooldown, gate-exempt)
  // Dispatches priority='urgent' tasks immediately without age filter.
  // These are typically created by deputy-cto during triage self-handling.
  // =========================================================================
  if (Database) {
    const urgentTasks = getUrgentPendingTasks();
    if (urgentTasks.length > 0) {
      log(`Urgent dispatcher: found ${urgentTasks.length} urgent task(s).`);
      // Concurrency is managed by the session queue — enqueue all urgent tasks.
      {
        let dispatched = 0;
        for (const task of urgentTasks) {
          const mapping = getAgentMapping(task);
          if (!mapping) continue;
          if (!markTaskInProgress(task.id)) {
            log(`Urgent dispatcher: skipping task ${task.id} (failed to mark in_progress).`);
            continue;
          }
          const success = spawnTaskAgent(task);
          if (success) {
            log(`Urgent dispatcher: spawned ${mapping.category?.name || mapping.agent} for "${task.title}" (${task.id})`);
            dispatched++;
          } else {
            resetTaskToPending(task.id);
            log(`Urgent dispatcher: spawn failed for task ${task.id}, reset to pending.`);
          }
        }
        log(`Urgent dispatcher: dispatched ${dispatched} agent(s).`);
      }
    }
  }

  // =========================================================================
  // PR SWEEP (10min cooldown)
  // Auto-merges stale open PRs to prevent branch accumulation
  // =========================================================================
  await runIfDue('pr_sweep', {
    state, now, intervals: config.intervals,
    stateKey: 'lastPrSweep',
    label: 'PR sweep',
    fn: async () => {
      log('PR sweep: checking for stale open PRs...');
      // Detect base branch: preview for target projects, main for gentyr repo
      let prBaseBranch = 'main';
      try {
        execSync('git rev-parse --verify origin/preview', { cwd: PROJECT_DIR, encoding: 'utf8', stdio: 'pipe' });
        prBaseBranch = 'preview';
      } catch (err) {
        console.error('[hourly-automation] Warning:', err.message);
      }

      const prListJson = execSync(
        `gh pr list --base ${prBaseBranch} --state open --json number,createdAt,headRefName --limit 20`,
        { cwd: PROJECT_DIR, encoding: 'utf8', stdio: 'pipe', timeout: 30000 }
      ).trim();
      const openPRs = JSON.parse(prListJson || '[]');
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      let merged = 0;

      for (const pr of openPRs) {
        const createdAt = new Date(pr.createdAt);
        if (createdAt < thirtyMinutesAgo) {
          try {
            execSync(
              `gh pr merge ${pr.number} --squash --delete-branch`,
              { cwd: PROJECT_DIR, encoding: 'utf8', stdio: 'pipe', timeout: 30000 }
            );
            log(`PR sweep: auto-merged PR #${pr.number} (${pr.headRefName}), created ${pr.createdAt}`);
            merged++;
          } catch (mergeErr) {
            log(`PR sweep: failed to merge PR #${pr.number}: ${mergeErr.message}`);
          }
        }
      }

      if (merged > 0) {
        log(`PR sweep: auto-merged ${merged} stale PR(s).`);
      } else if (openPRs.length === 0) {
        log('PR sweep: no open PRs.');
      } else {
        log(`PR sweep: ${openPRs.length} open PR(s), none older than 30 minutes.`);
      }
    },
  });

  // =========================================================================
  // CTO GATE CHECK — exit if gate is closed after all monitoring-only steps
  // GAP 5: Everything above this point (Usage Optimizer, Key Sync, Session
  // Reviver, Triage, Health Monitors, CI Monitoring, Persistent Alerts,
  // Merge Chain Gap, Urgent Dispatcher, PR Sweep) runs regardless of CTO gate status.
  // Everything below requires the gate to be open.
  // =========================================================================
  if (!ctoGateOpen) {
    log('CTO gate closed — monitoring-only steps complete. Skipping gate-required steps.');
    registerHookExecution({
      hookType: HOOK_TYPES.HOURLY_AUTOMATION,
      status: 'partial',
      durationMs: Date.now() - startTime,
      metadata: { reason: 'cto_gate_monitoring_only', hoursSinceLastBriefing: ctoGate.hoursSinceLastBriefing }
    });
    process.exit(0);
  }

  // =========================================================================
  // LINT CHECK (own cooldown, default 30 min)
  // =========================================================================
  await runIfDue('lint_checker', {
    state, now, intervals: config.intervals,
    stateKey: 'lastLintCheck',
    configToggle: 'lintCheckerEnabled',
    config,
    label: 'Lint check',
    fn: async () => {
      log('Running lint check...');
      const lintResult = runLintCheck();

      if (lintResult.hasErrors) {
        const errorCount = (lintResult.output.match(/\berror\b/gi) || []).length;
        log(`Lint check found ${errorCount} error(s), spawning fixer...`);
        try {
          spawnLintFixer(lintResult.output);
          log('Lint fixer enqueued.');
        } catch (err) {
          log(`Lint fixer: failed to enqueue: ${err.message}`);
          throw err;
        }
      } else {
        log('Lint check passed - no errors found.');
      }
    },
  });

  // =========================================================================
  // TASK RUNNER CHECK (1h cooldown)
  // Spawns a separate Claude session for every pending TODO item >1h old
  // =========================================================================
  await runIfDue('task_runner', {
    state, now, intervals: config.intervals,
    stateKey: 'lastTaskRunnerCheck',
    configToggle: 'taskRunnerEnabled',
    config,
    label: 'Task runner',
    fn: async () => {
      if (!Database) {
        log('Task runner: better-sqlite3 not available, skipping.');
        return;
      }
      log('Task runner: checking for pending tasks...');
      let candidates = getPendingTasksForRunner();

      // Gate PRODUCT-MANAGER tasks on feature toggle
      if (!config.productManagerEnabled) {
        const before = candidates.length;
        candidates = candidates.filter(t => t.section !== 'PRODUCT-MANAGER');
        const filtered = before - candidates.length;
        if (filtered > 0) {
          log(`Task runner: filtered ${filtered} PRODUCT-MANAGER task(s) (feature disabled).`);
        }
      }

      if (candidates.length === 0) {
        log('Task runner: no eligible pending tasks found.');
      } else {
        log(`Task runner: found ${candidates.length} candidate task(s).`);
        let spawned = 0;

        for (const task of candidates) {
          if (spawned >= MAX_TASKS_PER_CYCLE) {
            log(`Task runner: reached batch limit (${MAX_TASKS_PER_CYCLE}), deferring ${candidates.length - spawned} remaining tasks.`);
            break;
          }

          const mapping = getAgentMapping(task);
          if (!mapping) continue;

          if (!markTaskInProgress(task.id)) {
            log(`Task runner: skipping task ${task.id} (failed to mark in_progress).`);
            continue;
          }

          const success = spawnTaskAgent(task);
          if (success) {
            log(`Task runner: spawning ${mapping.category?.name || mapping.agent} for task "${task.title}" (${task.id})`);
            spawned++;
          } else {
            resetTaskToPending(task.id);
            log(`Task runner: spawn failed for task ${task.id}, reset to pending.`);
          }
        }

        log(`Task runner: spawned ${spawned} agent(s) this cycle.`);
      }
    },
  });

  // =========================================================================
  // STAGING -> PRODUCTION PROMOTION (midnight window, 20h cooldown)
  // Checks nightly for stable staging to promote to production
  // NOTE: Runs BEFORE preview→staging to prevent clock-reset starvation
  // =========================================================================
  {
    const currentHour = new Date().getHours();
    const currentMinute = new Date().getMinutes();
    const isMidnightWindow = currentHour === 0 && currentMinute <= 30;

    if (isMidnightWindow) {
      await runIfDue('staging_promotion', {
        state, now, intervals: config.intervals,
        stateKey: 'lastStagingPromotionCheck',
        configToggle: 'stagingPromotionEnabled',
        config,
        localModeSkip: localMode,
        label: 'Staging promotion',
        fn: async () => {
          log('Staging promotion: midnight window - checking for promotable commits...');

          try {
            execSync('git fetch origin staging main --quiet 2>/dev/null || true', {
              cwd: PROJECT_DIR, encoding: 'utf8', timeout: 30000, stdio: 'pipe',
            });
          } catch (err) {
            console.error('[hourly-automation] Warning:', err.message);
            log('Staging promotion: git fetch failed, skipping.');
          }

          if (remoteBranchExists('staging') && remoteBranchExists('main')) {
            const newCommits = getNewCommits('staging', 'main');

            if (newCommits.length === 0) {
              log('Staging promotion: no new commits on staging.');
            } else {
              const lastStagingTimestamp = getLastCommitTimestamp('staging');
              const hoursSinceLastStagingCommit = lastStagingTimestamp > 0
                ? Math.floor((Date.now() / 1000 - lastStagingTimestamp) / 3600) : 0;

              if (hoursSinceLastStagingCommit >= 24) {
                // GAP 6: Block promotion if production is in error state
                const alertData = readPersistentAlerts();
                const prodAlert = alertData.alerts['production_error'];
                if (prodAlert && !prodAlert.resolved) {
                  const ageHours = Math.round((Date.now() - new Date(prodAlert.first_detected_at).getTime()) / 3600000);
                  log(`Staging promotion: BLOCKED — production in error state for ${ageHours}h. Fix production before promoting.`);
                } else {
                  log(`Staging promotion: ${newCommits.length} commits ready. Staging stable for ${hoursSinceLastStagingCommit}h.`);

                  spawnStagingPromotion(newCommits, hoursSinceLastStagingCommit);
                  log('Staging promotion pipeline enqueued.');
                }
              } else {
                log(`Staging promotion: staging only ${hoursSinceLastStagingCommit}h old (need 24h stability).`);
              }
            }
          } else {
            log('Staging promotion: staging or main branch does not exist on remote.');
          }
        },
      });
    } else {
      // Only log at debug level since it runs every 5 minutes outside midnight window
    }
  }

  // =========================================================================
  // STAGING FREEZE: Pause preview→staging when staging approaches 24h stability
  // Prevents preview→staging from resetting the staging clock and starving
  // the staging→main midnight promotion window.
  // Fetch staging ref so freeze decisions use fresh data even outside midnight.
  // =========================================================================
  try {
    execSync('git fetch origin staging --quiet 2>/dev/null || true', {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 30000, stdio: 'pipe',
    });
  } catch (err) {
    console.error('[hourly-automation] Warning:', err.message);
    /* non-fatal */
  }

  const lastStagingTs = getLastCommitTimestamp('staging');
  const stagingAgeHours = lastStagingTs > 0 ? (Date.now() / 1000 - lastStagingTs) / 3600 : 0;

  if (stagingAgeHours >= 18 && !state.stagingFreezeActive) {
    state.stagingFreezeActive = true;
    state.stagingFreezeActivatedAt = now;
    saveState(state);
    log(`Staging freeze ACTIVATED: staging is ${Math.floor(stagingAgeHours)}h old, pausing preview→staging until staging→main resolves.`);
  }

  // Clear freeze conditions:
  // 1. Staging age dropped below 18h (staging→main promoted, new merge is fresh)
  // 2. 48h safety valve (prevents permanent lockout)
  if (state.stagingFreezeActive) {
    const freezeAge = (now - state.stagingFreezeActivatedAt) / (1000 * 3600);
    if (stagingAgeHours < 18) {
      state.stagingFreezeActive = false;
      saveState(state);
      log('Staging freeze CLEARED: staging age dropped below 18h (promotion completed).');
    } else if (freezeAge >= 48) {
      state.stagingFreezeActive = false;
      saveState(state);
      log('Staging freeze CLEARED: 48h safety valve triggered.');
    }
  }

  // =========================================================================
  // PREVIEW -> STAGING PROMOTION (6h cooldown)
  // Checks for new commits on preview, spawns review + promotion pipeline
  // NOTE: Gated by staging freeze to prevent staging→main starvation
  // =========================================================================
  if (state.stagingFreezeActive) {
    log(`Preview promotion: PAUSED by staging freeze (staging ${Math.floor(stagingAgeHours)}h old, waiting for staging→main).`);
    // Do NOT update lastPreviewPromotionCheck — so it fires immediately when freeze lifts
  } else {
    await runIfDue('preview_promotion', {
      state, now, intervals: config.intervals,
      stateKey: 'lastPreviewPromotionCheck',
      configToggle: 'previewPromotionEnabled',
      config,
      localModeSkip: localMode,
      label: 'Preview promotion',
      fn: async () => {
        log('Preview promotion: checking for promotable commits...');

        try {
          // Fetch latest remote state
          execSync('git fetch origin preview staging --quiet 2>/dev/null || true', {
            cwd: PROJECT_DIR, encoding: 'utf8', timeout: 30000, stdio: 'pipe',
          });
        } catch (err) {
          console.error('[hourly-automation] Warning:', err.message);
          log('Preview promotion: git fetch failed, skipping.');
        }

        if (remoteBranchExists('preview') && remoteBranchExists('staging')) {
          const newCommits = getNewCommits('preview', 'staging');

          if (newCommits.length === 0) {
            log('Preview promotion: no new commits on preview.');
          } else {
            const lastStagingTimestamp = getLastCommitTimestamp('staging');
            const hoursSinceLastStagingMerge = lastStagingTimestamp > 0
              ? Math.floor((Date.now() / 1000 - lastStagingTimestamp) / 3600) : 999;
            const hasBugFix = hasBugFixCommits(newCommits);

            if (hoursSinceLastStagingMerge >= 24 || hasBugFix) {
              log(`Preview promotion: ${newCommits.length} commits ready. Staging age: ${hoursSinceLastStagingMerge}h. Bug fix: ${hasBugFix}.`);

              spawnPreviewPromotion(newCommits, hoursSinceLastStagingMerge, hasBugFix);
              log('Preview promotion pipeline enqueued.');
              state.lastPreviewToStagingMergeAt = now;
              saveState(state);
            } else {
              log(`Preview promotion: ${newCommits.length} commits pending but staging only ${hoursSinceLastStagingMerge}h old (need 24h or bug fix).`);
            }
          }
        } else {
          log('Preview promotion: preview or staging branch does not exist on remote.');
        }
      },
    });
  }

  // =========================================================================
  // TASK GATE STALE CLEANUP
  // Auto-approve pending_review tasks older than 10 minutes (gate agent timed out)
  // Runs every cycle — no cooldown, simple DB update
  // =========================================================================
  if (Database) {
    try {
      const todoDbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
      if (fs.existsSync(todoDbPath)) {
        const todoDb = new Database(todoDbPath);
        const nowTimestamp = Math.floor(Date.now() / 1000);
        const result = todoDb.prepare(
          "UPDATE tasks SET status = 'pending' WHERE status = 'pending_review' AND created_timestamp < ?"
        ).run(nowTimestamp - 600);
        if (result.changes > 0) {
          log(`Task gate cleanup: auto-approved ${result.changes} stale pending_review task(s).`);
        }
        todoDb.close();
      }
    } catch (err) {
      log(`Task gate cleanup error (non-fatal): ${err.message}`);
    }
  }

  // =========================================================================
  // ABANDONED WORKTREE RESCUE (30min cooldown)
  // Spawns project-manager for worktrees with uncommitted changes and no active agent
  // NOTE: Must run BEFORE worktree_cleanup so abandoned worktrees with uncommitted
  // changes get a project-manager spawned to commit their work before cleanup deletes them.
  // =========================================================================
  await runIfDue('abandoned_worktree_rescue', {
    state, now, intervals: config.intervals,
    stateKey: 'lastAbandonedWorktreeRescue',
    configToggle: 'abandonedWorktreeRescueEnabled',
    config,
    label: 'Abandoned worktree rescue',
    fn: async () => {
      log('Abandoned worktree rescue: scanning for abandoned worktrees...');
      const rescued = rescueAbandonedWorktrees();
      if (rescued > 0) {
        log(`Abandoned worktree rescue: spawned ${rescued} project-manager(s) for abandoned worktrees.`);
      } else {
        log('Abandoned worktree rescue: no abandoned worktrees found.');
      }
    },
  });

  // =========================================================================
  // WORKTREE CLEANUP (30min cooldown)
  // Removes worktrees whose feature branches have been merged to the base branch
  // =========================================================================
  await runIfDue('worktree_cleanup', {
    state, now, intervals: config.intervals,
    stateKey: 'lastWorktreeCleanup',
    configToggle: 'worktreeCleanupEnabled',
    config,
    label: 'Worktree cleanup',
    fn: async () => {
      log('Worktree cleanup: checking for merged worktrees...');
      const cleaned = cleanupMergedWorktrees();
      if (cleaned > 0) {
        log(`Worktree cleanup: removed ${cleaned} merged worktree(s).`);
      } else {
        log('Worktree cleanup: no merged worktrees to remove.');
      }
    },
  });

  // =========================================================================
  // STALE WORKTREE REAPER (60min cooldown)
  // Removes worktrees older than 4 hours with no active process
  // =========================================================================
  await runIfDue('stale_worktree_reaper', {
    state, now, intervals: config.intervals,
    stateKey: 'lastStaleWorktreeReaper',
    configToggle: 'staleWorktreeReaperEnabled',
    config,
    label: 'Stale worktree reaper',
    fn: async () => {
      log('Stale worktree reaper: scanning for old worktrees...');
      const reaped = reapStaleWorktrees();
      if (reaped > 0) {
        log(`Stale worktree reaper: removed ${reaped} stale worktree(s).`);
      } else {
        log('Stale worktree reaper: no stale worktrees to reap.');
      }
    },
  });

  // =========================================================================
  // ORPHAN PROCESS REAPER (60min cooldown)
  // Kills node/esbuild processes whose CWD is a non-existent worktree path
  // =========================================================================
  await runIfDue('orphan_process_reaper', {
    state, now, intervals: config.intervals,
    stateKey: 'lastOrphanProcessReaper',
    configToggle: 'orphanProcessReaperEnabled',
    config,
    label: 'Orphan process reaper',
    fn: async () => {
      log('Orphan process reaper: scanning for orphaned processes...');
      const killed = reapOrphanProcesses();
      if (killed > 0) {
        log(`Orphan process reaper: killed ${killed} orphan process(es).`);
      } else {
        log('Orphan process reaper: no orphan processes found.');
      }
    },
  });

  // =========================================================================
  // STALE WORK DETECTOR (24h cooldown)
  // Reports uncommitted changes, unpushed branches, and stale feature branches
  // =========================================================================
  await runIfDue('stale_work_detector', {
    state, now, intervals: config.intervals,
    stateKey: 'lastStaleWorkCheck',
    configToggle: 'staleWorkDetectorEnabled',
    config,
    label: 'Stale work detector',
    fn: async () => {
      log('Stale work detector: scanning for stale work...');
      const report = detectStaleWork();
      if (report.hasIssues) {
        const reportText = formatReport(report);
        log(`Stale work detector: issues found - ${report.uncommittedFiles.length} uncommitted, ${report.unpushedBranches.length} unpushed, ${report.staleBranches.length} stale branches.`);

        // Report to deputy-CTO via agent-reports (if MCP available)
        try {
          const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
          if (fs.existsSync(mcpConfig)) {
            ensureCredentials();
            enqueueSession({
              title: `Stale work report: ${report.uncommittedFiles.length} uncommitted, ${report.unpushedBranches.length} unpushed`,
              agentType: AGENT_TYPES.DEPUTY_CTO_REVIEW,
              hookType: HOOK_TYPES.HOURLY_AUTOMATION,
              tagContext: 'stale-work-report',
              source: 'hourly-automation',
              priority: 'low',
              buildPrompt: (agentId) => `[Automation][stale-work-report][AGENT:${agentId}] Report this stale work finding to the deputy-CTO.

Use mcp__agent-reports__report_to_deputy_cto with:
- reporting_agent: "stale-work-detector"
- title: "Stale Work Detected: ${report.uncommittedFiles.length} uncommitted, ${report.unpushedBranches.length} unpushed, ${report.staleBranches.length} stale branches"
- summary: ${JSON.stringify(reportText).slice(0, 500)}
- category: "git-hygiene"
- priority: "${report.staleBranches.length > 0 ? 'medium' : 'low'}"

Then exit.`,
              extraEnv: { ...resolvedCredentials },
              projectDir: PROJECT_DIR,
            });
          }
        } catch (reportErr) {
          log(`Stale work detector: failed to spawn reporter: ${reportErr.message}`);
        }
      } else {
        log('Stale work detector: no issues found.');
      }
    },
  });

  // =========================================================================
  // STANDALONE ANTIPATTERN HUNTER (3h cooldown, fire-and-forget)
  // Repo-wide spec violation scan, independent of git hooks
  // =========================================================================
  await runIfDue('standalone_antipattern_hunter', {
    state, now, intervals: config.intervals,
    stateKey: 'lastStandaloneAntipatternHunt',
    configToggle: 'standaloneAntipatternHunterEnabled',
    config,
    label: 'Standalone antipattern hunter',
    fn: async () => {
      log('Standalone antipattern hunter: spawning repo-wide scan...');
      const success = spawnStandaloneAntipatternHunter();
      if (success) {
        log('Standalone antipattern hunter: spawned (fire-and-forget).');
      } else {
        throw new Error('spawn failed');
      }
    },
  });

  // =========================================================================
  // STANDALONE COMPLIANCE CHECKER (1h cooldown, fire-and-forget)
  // Picks a random spec and audits the codebase against it
  // =========================================================================
  await runIfDue('standalone_compliance_checker', {
    state, now, intervals: config.intervals,
    stateKey: 'lastStandaloneComplianceCheck',
    configToggle: 'standaloneComplianceCheckerEnabled',
    config,
    label: 'Standalone compliance checker',
    fn: async () => {
      const randomSpec = getRandomSpec();
      if (randomSpec) {
        log(`Standalone compliance checker: spawning audit for spec ${randomSpec.id}...`);
        const success = spawnStandaloneComplianceChecker(randomSpec);
        if (success) {
          log(`Standalone compliance checker: spawned for ${randomSpec.id} (fire-and-forget).`);
        } else {
          throw new Error('spawn failed');
        }
      } else {
        log('Standalone compliance checker: no specs found in specs/global/ or specs/local/.');
      }
    },
  });

  // =========================================================================
  // USER FEEDBACK PIPELINE (2h cooldown, fire-and-forget agents)
  // Detects staging changes, matches personas, spawns feedback agents
  // =========================================================================
  await runIfDue('user_feedback', {
    state, now, intervals: config.intervals,
    stateKey: 'lastUserFeedbackRun',
    configToggle: 'userFeedbackEnabled',
    config,
    localModeSkip: localMode,
    label: 'User feedback',
    fn: async () => {
      const feedbackResult = await runFeedbackPipeline(log, state, saveState, getCooldown('user_feedback', 120) * 60 * 1000);
      if (feedbackResult.ran) {
        log(`User feedback: ${feedbackResult.reason}`);
        registerSpawn({
          type: AGENT_TYPES.FEEDBACK_ORCHESTRATOR,
          hookType: HOOK_TYPES.HOURLY_AUTOMATION,
          description: feedbackResult.reason,
          prompt: '',
          metadata: { personasTriggered: feedbackResult.personasTriggered },
        });
      } else {
        log(`User feedback: skipped - ${feedbackResult.reason}`);
      }
    },
  });

  // =========================================================================
  // DEMO VALIDATION (6h cooldown, fire-and-forget repair agents)
  // Validates all enabled demo scenarios headless, spawns repair agents for failures
  // =========================================================================
  await runIfDue('demo_validation', {
    state, now, intervals: config.intervals,
    stateKey: 'lastDemoValidationRun',
    configToggle: 'demoValidationEnabled',
    config,
    localModeSkip: localMode,
    label: 'Demo validation',
    fn: async () => {
      // Query enabled demo scenarios from user-feedback.db
      const feedbackDbPath = path.join(PROJECT_DIR, '.claude', 'user-feedback.db');
      if (!fs.existsSync(feedbackDbPath) || !Database) {
        log('Demo validation: user-feedback.db not found or Database unavailable.');
        return;
      }
      let scenarios;
      try {
        const db = new Database(feedbackDbPath, { readonly: true });
        // Check if env_vars column exists
        let hasEnvVars = false;
        try { db.prepare('SELECT env_vars FROM demo_scenarios LIMIT 0').run(); hasEnvVars = true; } catch (err) {
          console.error('[hourly-automation] Warning:', err.message);
          /* column not yet migrated */
        }
        const cols = hasEnvVars
          ? 'ds.id, ds.title, ds.test_file, ds.persona_id, ds.playwright_project, ds.category, ds.env_vars'
          : 'ds.id, ds.title, ds.test_file, ds.persona_id, ds.playwright_project, ds.category';
        scenarios = db.prepare(`
          SELECT ${cols}
          FROM demo_scenarios ds
          WHERE ds.enabled = 1
        `).all();
        db.close();
      } catch (err) {
        log(`Demo validation: failed to query scenarios: ${err.message}`);
        return;
      }
      if (!scenarios.length) {
        log('Demo validation: no enabled scenarios found.');
        return;
      }

      // Query and run global prerequisites before validation
      let prerequisites;
      try {
        const db = new Database(feedbackDbPath, { readonly: true });
        prerequisites = db.prepare(`
          SELECT * FROM demo_prerequisites
          WHERE scope = 'global' AND enabled = 1
          ORDER BY sort_order ASC
        `).all();
        db.close();
      } catch (err) {
        log(`Demo validation: failed to query prerequisites: ${err.message}`);
        prerequisites = [];
      }

      for (const prereq of prerequisites) {
        // Health check first
        if (prereq.health_check) {
          try {
            execSync(prereq.health_check, {
              timeout: prereq.health_check_timeout_ms || 5000,
              stdio: 'pipe',
              cwd: PROJECT_DIR,
            });
            log(`Demo validation: prerequisite "${prereq.description}" health check passed, skipping.`);
            continue;
          } catch (_) { /* cleanup - failure expected */
            // Health check failed, run the command
          }
        }

        if (prereq.run_as_background) {
          // Spawn detached, poll health check
          const child = spawn('sh', ['-c', prereq.command], {
            detached: true, stdio: 'ignore', cwd: PROJECT_DIR,
          });
          child.unref();

          if (prereq.health_check) {
            const deadline = Date.now() + (prereq.timeout_ms || 30000);
            let ready = false;
            while (Date.now() < deadline) {
              try {
                execSync(prereq.health_check, { timeout: prereq.health_check_timeout_ms || 5000, stdio: 'pipe', cwd: PROJECT_DIR });
                ready = true;
                break;
              } catch (err) {
                console.error('[hourly-automation] Warning:', err.message);
                /* not ready yet */
              }
              await new Promise(r => setTimeout(r, 2000));
            }
            if (!ready) {
              log(`Demo validation: prerequisite "${prereq.description}" timed out waiting for health check.`);
            }
          }
        } else {
          try {
            execSync(prereq.command, {
              timeout: prereq.timeout_ms || 30000,
              stdio: 'pipe',
              cwd: PROJECT_DIR,
            });
            log(`Demo validation: prerequisite "${prereq.description}" completed.`);
          } catch (err) {
            log(`Demo validation: prerequisite "${prereq.description}" failed: ${err.message}`);
          }
        }
      }

      // Skip ADK category scenarios (require replay data)
      const runnableScenarios = scenarios.filter(s => s.category !== 'adk');
      log(`Demo validation: running ${runnableScenarios.length} scenario(s) headless...`);

      const results = [];
      for (const scenario of runnableScenarios) {
        const startTime = Date.now();
        // Parse scenario env_vars if present
        let scenarioEnv = {};
        if (scenario.env_vars) {
          try { scenarioEnv = JSON.parse(scenario.env_vars); } catch (err) {
            console.error('[hourly-automation] Warning:', err.message);
            /* invalid JSON */
          }
        }
        try {
          execFileSync('npx', [
            'playwright', 'test',
            '--project', scenario.playwright_project,
            scenario.test_file,
            '--reporter', 'json',
          ], {
            timeout: 120_000,
            cwd: PROJECT_DIR,
            env: { ...buildSpawnEnv('demo-validation'), DEMO_HEADLESS: '1', DEMO_SLOW_MO: '0', ...scenarioEnv },
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          results.push({
            id: scenario.id,
            title: scenario.title,
            success: true,
            duration_ms: Date.now() - startTime,
          });
        } catch (err) {
          results.push({
            id: scenario.id,
            title: scenario.title,
            success: false,
            duration_ms: Date.now() - startTime,
            error: err.stderr ? err.stderr.toString().slice(0, 500) : (err.message || 'Unknown error'),
          });
        }
      }

      // Persist validation results to demo-validation-history.json
      const historyPath = path.join(PROJECT_DIR, '.claude', 'state', 'demo-validation-history.json');
      let history = [];
      try {
        if (fs.existsSync(historyPath)) {
          history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        }
      } catch (err) {
        console.error('[hourly-automation] Warning:', err.message);
        history = [];
      }

      const passed = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      history.push({
        timestamp: new Date().toISOString(),
        total: results.length,
        passed,
        failed,
        skipped: scenarios.length - runnableScenarios.length,
        scenarios: results,
      });

      // Keep last 100 runs
      if (history.length > 100) history = history.slice(-100);

      // Ensure state directory exists
      const stateDir = path.join(PROJECT_DIR, '.claude', 'state');
      if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

      // Spawn repair agents for failed scenarios (max 3)
      const failedScenarios = results.filter(r => !r.success);
      if (failedScenarios.length > 0) {
        log(`Demo validation: ${failed}/${results.length} scenarios failed.`);

        const toRepair = failedScenarios.slice(0, 3);
        for (const failedScenario of toRepair) {
          // NOTE: Memory pressure check removed — session queue handles it internally.
          let worktreePath;
          try {
            const branchName = getFeatureBranchName('demo-repair', failedScenario.id.slice(0, 8));
            const worktree = createWorktree(branchName);
            worktreePath = worktree.path;
          } catch (err) {
            log(`Demo validation: failed to create worktree for repair: ${err.message}`);
            continue;
          }

          const agentMcpConfig = path.join(worktreePath, '.mcp.json');
          const repairScenarioId = failedScenario.id;
          const repairScenarioTitle = failedScenario.title;
          const repairScenarioError = failedScenario.error;

          ensureCredentials();
          const queueResult = enqueueSession({
            title: `Demo repair: ${repairScenarioTitle}`,
            agentType: AGENT_TYPES.DEMO_REPAIR,
            hookType: HOOK_TYPES.HOURLY_AUTOMATION,
            tagContext: 'demo-repair',
            source: 'hourly-automation',
            priority: 'low',
            buildPrompt: (agentId) => {
              // Query prerequisites for the failed scenario
              let prereqBlock = '';
              try {
                const feedbackDbPath = path.join(PROJECT_DIR, '.claude', 'user-feedback.db');
                if (Database && fs.existsSync(feedbackDbPath)) {
                  const feedbackDb = new Database(feedbackDbPath, { readonly: true });
                  const scenario = feedbackDb.prepare('SELECT persona_id FROM demo_scenarios WHERE id = ?').get(repairScenarioId);
                  const personaId = scenario?.persona_id;
                  const prereqs = feedbackDb.prepare(`
                    SELECT scope, description, command, health_check, run_as_background
                    FROM demo_prerequisites
                    WHERE scope = 'global'
                       OR (scope = 'persona' AND persona_id = ?)
                       OR (scope = 'scenario' AND scenario_id = ?)
                    ORDER BY sort_order
                  `).all(personaId || '', repairScenarioId);
                  feedbackDb.close();
                  if (prereqs.length > 0) {
                    const prereqLines = prereqs.map(p => {
                      let line = `  - [${p.scope}] ${p.description || p.command}`;
                      if (p.command) line += `\n    Command: \`${p.command}\``;
                      if (p.health_check) line += `\n    Health check: \`${p.health_check}\``;
                      if (p.run_as_background) line += ` (background)`;
                      return line;
                    });
                    prereqBlock = [
                      ``,
                      `**Registered Prerequisites:**`,
                      ...prereqLines,
                      ``,
                      `## Prerequisite Diagnosis`,
                      `Before modifying the .demo.ts file, check if the failure is caused by a prerequisite issue:`,
                      `1. Run \`list_prerequisites\` to see all registered prerequisites`,
                      `2. Run \`run_prerequisites\` to verify they pass`,
                      `3. If a prerequisite is missing or wrong, use \`register_prerequisite\` / \`update_prerequisite\` to fix it`,
                      `4. Only modify the .demo.ts file if prerequisites pass and the failure is in the test code`,
                    ].join('\n');
                  }
                }
              } catch (err) { console.error('[hourly-automation] Warning: failed to load prerequisite block for demo repair:', err.message); }

              return [
                `[Automation][demo-repair][AGENT:${agentId}] You are a demo repair agent. A demo scenario failed during automated validation.`,
                ``,
                `**Failed Scenario:**`,
                `- ID: ${repairScenarioId}`,
                `- Title: ${repairScenarioTitle}`,
                `- Error: ${repairScenarioError || 'Unknown error'}`,
                prereqBlock,
                ``,
                `Follow the repair protocol:`,
                `0. FIRST — Visual diagnosis (5 seconds, prevents 30 min of wrong-path investigation):`,
                `   - Call \`check_demo_result\` for the failed scenario to get \`failure_frames\` and \`screenshot_hint\``,
                `   - Use the Read tool to view failure_frames images (you are multimodal — you can see images)`,
                `   - Describe what you see: was the browser on the right page? What elements were visible?`,
                `   - If no failure_frames, call \`get_demo_screenshot\` at the failure timestamp to see browser state`,
                `1. Check registered prerequisites via \`list_prerequisites\` — verify all pass via \`run_prerequisites\``,
                `2. If a prerequisite is missing or broken, fix it via \`register_prerequisite\` / \`update_prerequisite\``,
                `3. Run preflight_check to verify environment`,
                `4. Read the failed .demo.ts file`,
                `5. Diagnose from the error output AND your visual analysis from Step 0`,
                `6. Fix the .demo.ts file or prerequisite configuration`,
                `7. Re-run the scenario headless to verify`,
                `8. If you cannot fix it (app code issue), report via report_to_deputy_cto`,
              ].join('\n');
            },
            cwd: worktreePath,
            mcpConfig: fs.existsSync(agentMcpConfig) ? agentMcpConfig : undefined,
            worktreePath,
            agent: 'demo-manager',
            extraEnv: { ...resolvedCredentials },
            metadata: { scenarioId: repairScenarioId, scenarioTitle: repairScenarioTitle },
            projectDir: PROJECT_DIR,
          });
          log(`Demo validation: enqueued repair agent for "${repairScenarioTitle}" (queue ${queueResult.queueId})`);

          // Track repair as DEMO-MANAGER task for visibility
          try {
            if (Database && fs.existsSync(TODO_DB_PATH)) {
              const db = new Database(TODO_DB_PATH);
              const taskId = 'dm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
              const now = new Date();
              db.prepare(`
                INSERT INTO tasks (id, section, status, title, description, assigned_by, created_at, created_timestamp, started_timestamp, priority)
                VALUES (?, 'DEMO-MANAGER', 'in_progress', ?, ?, 'demo-validation', ?, ?, ?, 'normal')
              `).run(taskId, `Repair: ${failedScenario.title}`, `Scenario: ${failedScenario.id}\nError: ${failedScenario.error}`, now.toISOString(), Math.floor(now.getTime() / 1000), Math.floor(now.getTime() / 1000));
              db.close();
            }
          } catch (_) { /* cleanup - failure expected */ /* non-fatal */ }
        }

        // Report failures to deputy-CTO via queue
        ensureCredentials();
        enqueueSession({
          title: `Demo validation report: ${failed} failures`,
          agentType: AGENT_TYPES.DEMO_VALIDATOR,
          hookType: HOOK_TYPES.HOURLY_AUTOMATION,
          tagContext: 'demo-validation-report',
          source: 'hourly-automation',
          priority: 'low',
          buildPrompt: (agentId) => [
            `[Automation][demo-validation-report][AGENT:${agentId}] Report the following demo validation failures to the deputy-CTO using mcp__agent-reports__report_to_deputy_cto.`,
            ``,
            `Category: "other"`,
            `Priority: "${failed >= 3 ? 'high' : 'normal'}"`,
            `Title: "Demo validation: ${failed}/${results.length} scenarios failed"`,
            `Summary:`,
            `${failedScenarios.map(s => `- ${s.title}: ${s.error || 'Unknown error'}`).join('\n')}`,
            ``,
            `Repair agents have been spawned for ${toRepair.length} scenario(s).`,
          ].join('\n'),
          extraEnv: { ...resolvedCredentials },
          projectDir: PROJECT_DIR,
        });
      } else {
        log(`Demo validation: all ${results.length} scenarios passed.`);
      }
    },
  });

  // =========================================================================
  // DAILY FEEDBACK PIPELINE (24h cooldown, disabled by default)
  // Runs feedback for ALL enabled personas regardless of staging changes
  // =========================================================================
  await runIfDue('daily_feedback', {
    state, now, intervals: config.intervals,
    stateKey: 'lastDailyFeedbackCheck',
    configToggle: 'dailyFeedbackEnabled',
    config,
    localModeSkip: localMode,
    label: 'Daily feedback',
    fn: async () => {
      log('Daily feedback: querying all enabled personas...');

      // Query all enabled personas from user-feedback.db
      const feedbackDb = path.join(PROJECT_DIR, '.claude', 'user-feedback.db');
      if (!fs.existsSync(feedbackDb) || !Database) {
        log('Daily feedback: user-feedback.db not found or Database unavailable.');
        return;
      }
      let personaIds;
      try {
        const db = new Database(feedbackDb, { readonly: true });
        const rows = db.prepare('SELECT id FROM personas WHERE enabled = 1').all();
        db.close();
        personaIds = rows.map(r => r.id);
      } catch (err) {
        log(`Daily feedback: failed to query personas: ${err.message}`);
        return;
      }
      if (!personaIds.length) {
        log('Daily feedback: no enabled personas found.');
        return;
      }

      // Filter out personas that ran within 12h
      const filtered = [];
      for (const pid of personaIds) {
        const recent = await personaRanRecently(pid, 12);
        if (!recent) filtered.push(pid);
      }
      if (!filtered.length) {
        log('Daily feedback: all personas ran recently (within 12h). Skipping.');
        return;
      }

      // Cap at 5 personas per run
      const capped = filtered.slice(0, 5);
      log(`Daily feedback: spawning for ${capped.length} persona(s)...`);

      const feedbackResult = await startFeedbackRun('daily', null, [], capped, 3);
      if (feedbackResult && feedbackResult.sessions && feedbackResult.sessions.length > 0) {
        log(`Daily feedback: started run ${feedbackResult.runId} with ${feedbackResult.sessions.length} persona(s).`);
      } else {
        log('Daily feedback: startFeedbackRun returned no sessions.');
      }
    },
  });

  // =========================================================================
  // HOURLY TASKS (dynamic cooldown, default 55 min)
  // =========================================================================
  await runIfDue('hourly_tasks', {
    state, now, intervals: config.intervals,
    stateKey: 'lastRun',
    label: 'Hourly tasks',
    fn: async () => {
      if (config.claudeMdRefactorEnabled) {
        const claudeMdSize = getClaudeMdSize();
        log(`CLAUDE.md size: ${claudeMdSize} characters (threshold: ${CLAUDE_MD_SIZE_THRESHOLD})`);
        if (claudeMdSize > CLAUDE_MD_SIZE_THRESHOLD) {
          log('CLAUDE.md exceeds threshold, spawning refactor...');
          spawnClaudeMdRefactor();
          log('CLAUDE.md refactor enqueued.');
          state.lastClaudeMdRefactor = now;
          saveState(state);
        } else {
          log('CLAUDE.md size is within threshold.');
        }
      } else {
        log('CLAUDE.md Refactor is disabled in config.');
      }
    },
  });

  log('=== Hourly Automation Complete ===');

  debugLog('hourly-automation', 'cycle_complete', { durationMs: Date.now() - startTime });

  registerHookExecution({
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    status: 'success',
    durationMs: Date.now() - startTime,
    metadata: { fullRun: true }
  });
}

main();
