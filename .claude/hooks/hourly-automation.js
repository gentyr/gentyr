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
import { spawn, execSync, execFileSync } from 'child_process';
import { registerSpawn, updateAgent, registerHookExecution, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { getCooldown } from './config-reader.js';
import { runUsageOptimizer } from './usage-optimizer.js';
import { syncKeys } from './key-sync.js';
import { runFeedbackPipeline } from './feedback-orchestrator.js';
import { createWorktree, cleanupMergedWorktrees } from './lib/worktree-manager.js';
import { getFeatureBranchName } from './lib/feature-branch-helper.js';
import { detectStaleWork, formatReport } from './stale-work-detector.js';
import { reviveInterruptedSessions } from './session-reviver.js';

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

// Rotation proxy
const PROXY_PORT = process.env.GENTYR_PROXY_PORT || 18080;
const PROXY_HEALTH_URL = `http://localhost:${PROXY_PORT}/__health`;

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
};
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');

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
  } catch {
    log('Credential cache: no vault-mappings.json, skipping pre-resolution.');
    return;
  }

  try {
    const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
    servers = actions.servers || {};
  } catch {
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

/**
 * Build the env object for spawning claude processes.
 * Lazily resolves credentials on first call, then includes them so
 * MCP servers skip `op read`.
 */
function buildSpawnEnv(agentId) {
  ensureCredentials();
  const infraKeys = ['RENDER_API_KEY', 'VERCEL_TOKEN', 'ELASTIC_API_KEY', 'ELASTIC_CLOUD_ID', 'ELASTIC_ENDPOINT'];
  const missing = infraKeys.filter(k => !resolvedCredentials[k] && !process.env[k]);
  if (missing.length > 0) {
    log(`buildSpawnEnv(${agentId}): MISSING infrastructure credentials: ${missing.join(', ')}`);
  }
  return {
    ...process.env,
    ...resolvedCredentials,
    CLAUDE_PROJECT_DIR: PROJECT_DIR,
    CLAUDE_SPAWNED_SESSION: 'true',
    CLAUDE_AGENT_ID: agentId,
    HTTPS_PROXY: 'http://localhost:18080',
    HTTP_PROXY: 'http://localhost:18080',
    NO_PROXY: 'localhost,127.0.0.1',
    NODE_EXTRA_CA_CERTS: path.join(process.env.HOME || '/tmp', '.claude', 'proxy-certs', 'ca.pem'),
  };
}

/**
 * Check if the rotation proxy is running and healthy.
 * Non-blocking, returns status for logging only. Agents still spawn if proxy is down.
 */
async function checkProxyHealth() {
  const http = await import('http');
  return new Promise((resolve) => {
    const req = http.request(PROXY_HEALTH_URL, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const health = JSON.parse(data);
          resolve({ running: true, ...health });
        } catch {
          resolve({ running: true, raw: data });
        }
      });
    });
    req.on('error', () => resolve({ running: false }));
    req.on('timeout', () => { req.destroy(); resolve({ running: false }); });
    req.end();
  });
}

/**
 * Count running automation agents to prevent process accumulation
 */
function countRunningAgents() {
  try {
    const result = execSync(
      "pgrep -cf 'claude.*--dangerously-skip-permissions'",
      { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
    ).trim();
    return parseInt(result, 10) || 0;
  } catch {
    // pgrep returns exit code 1 when no processes match
    return 0;
  }
}

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
    lastModified: null,
  };

  if (!fs.existsSync(CONFIG_FILE)) {
    return defaults;
  }

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...defaults, ...config };
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

  const agentId = registerSpawn({
    type: AGENT_TYPES.PRODUCTION_HEALTH_MONITOR,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: `Alert re-escalation: ${safeKey}`,
    prompt: '',
    metadata: { alertKey: safeKey, escalationCount: safeEscalationCount },
  });

  const firstDetectedTs = new Date(alert.first_detected_at).getTime();
  const ageHours = Number.isFinite(firstDetectedTs) ? Math.round((Date.now() - firstDetectedTs) / 3600000) : 0;

  const prompt = `[Task][alert-escalation][AGENT:${agentId}] ALERT RE-ESCALATION

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

Then exit immediately.`;

  try {
    const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '--output-format', 'json',
      '-p', prompt,
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env: buildSpawnEnv(agentId),
    });
    claude.unref();
    updateAgent(agentId, { pid: claude.pid, status: 'running', prompt });
    return true;
  } catch (err) {
    log(`Alert escalation spawn error: ${err.message}`);
    return false;
  }
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
  } catch {
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
  } catch {
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
 * Spawn deputy-cto to triage pending reports
 * The agent will discover reports via MCP tools (which handle cooldown filtering)
 */
function spawnReportTriage() {
  // Register spawn first to get agentId for prompt embedding
  const agentId = registerSpawn({
    type: AGENT_TYPES.DEPUTY_CTO_REVIEW,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Triaging pending CTO reports',
    prompt: '',
    metadata: {},
  });

  const prompt = `[Task][report-triage][AGENT:${agentId}] You are an orchestrator performing REPORT TRIAGE.

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
| Breaking change to users | Issue already in todos | Already resolved |
| Architectural decision needed | Similar issue recently fixed | Not a real problem |
| Resource/budget implications | Clear fix, low risk | False positive |
| Cross-team coordination | Obvious code quality fix | Duplicate report |
| Uncertain about approach | Documentation/test gap | Informational only |
| High priority + ambiguity | Performance fix clear path | Outdated concern |
| Policy/process change | Routine maintenance | |
| | Isolated bug fix | |

**Decision Rules:**
- **>80% confident** you know the right action → self-handle
- **<80% confident** OR sensitive → escalate
- **Not actionable** (already fixed, false positive, duplicate) → dismiss

### 2f: Take Action

**If SELF-HANDLING:**
\`\`\`
// Create an urgent task — dispatched immediately by the urgent dispatcher
mcp__todo-db__create_task({
  section: "CODE-REVIEWER",  // Choose based on task type (see section mapping below)
  title: "Brief actionable title",
  description: "Full context: what to fix, where, why, and acceptance criteria",
  assigned_by: "deputy-cto",
  priority: "urgent"
})

// Complete the triage
mcp__agent-reports__complete_triage({
  id: "<report-id>",
  status: "self_handled",
  outcome: "Created urgent task to [brief description of fix]"
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

## Output

After processing all reports, output a summary:
- How many self-handled vs escalated vs dismissed
- Brief description of each action taken`;

  // Store prompt now that it's built
  updateAgent(agentId, { prompt });

  return new Promise((resolve, reject) => {
    const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    const spawnArgs = [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '-p',
      prompt,
    ];

    // Use stdio: 'inherit' - Claude CLI requires TTY-like environment
    // Output goes directly to parent process stdout/stderr
    const claude = spawn('claude', [...spawnArgs, '--output-format', 'json'], {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      env: buildSpawnEnv(agentId),
    });

    claude.on('close', (code) => {
      resolve({ code, output: '(output sent to inherit stdio)' });
    });

    claude.on('error', (err) => {
      reject(err);
    });

    // 15 minute timeout for triage
    setTimeout(() => {
      claude.kill();
      reject(new Error('Report triage timed out after 15 minutes'));
    }, 15 * 60 * 1000);
  });
}

/**
 * Spawn Claude for CLAUDE.md refactoring
 */
function spawnClaudeMdRefactor() {
  // Register spawn first to get agentId for prompt embedding
  const agentId = registerSpawn({
    type: AGENT_TYPES.CLAUDEMD_REFACTOR,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Refactoring oversized CLAUDE.md',
    prompt: '',
    metadata: {},
  });

  const prompt = `[Task][claudemd-refactor][AGENT:${agentId}] You are an orchestrator performing CLAUDE.md REFACTORING.

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

  // Store prompt now that it's built
  updateAgent(agentId, { prompt });

  return new Promise((resolve, reject) => {
    const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    const spawnArgs = [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '-p',
      prompt,
    ];

    // Use stdio: 'inherit' - Claude CLI requires TTY-like environment
    // Output goes directly to parent process stdout/stderr
    const claude = spawn('claude', [...spawnArgs, '--output-format', 'json'], {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      env: buildSpawnEnv(agentId),
    });

    claude.on('close', (code) => {
      resolve({ code, output: '(output sent to inherit stdio)' });
    });

    claude.on('error', (err) => {
      reject(err);
    });

    // 30 minute timeout
    setTimeout(() => {
      claude.kill();
      reject(new Error('CLAUDE.md refactor timed out after 30 minutes'));
    }, 30 * 60 * 1000);
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
 * Spawn Claude to fix lint errors
 */
function spawnLintFixer(lintOutput) {
  // Extract just the errors, not warnings
  const errorLines = lintOutput.split('\n')
    .filter(line => line.includes('error'))
    .slice(0, 50) // Limit to first 50 error lines
    .join('\n');

  // Register spawn first to get agentId for prompt embedding
  const agentId = registerSpawn({
    type: AGENT_TYPES.LINT_FIXER,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Fixing lint errors',
    prompt: '',
    metadata: { errorCount: errorLines.split('\n').length },
  });

  const prompt = `[Task][lint-fixer][AGENT:${agentId}] You are an orchestrator fixing LINT ERRORS.

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

Report completion via mcp__agent-reports__report_to_deputy_cto with a summary of what was fixed.`;

  // Store prompt now that it's built
  updateAgent(agentId, { prompt });

  return new Promise((resolve, reject) => {
    const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    const spawnArgs = [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '-p',
      prompt,
    ];

    // Use stdio: 'inherit' - Claude CLI requires TTY-like environment
    const claude = spawn('claude', [...spawnArgs, '--output-format', 'json'], {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      env: buildSpawnEnv(agentId),
    });

    claude.on('close', (code) => {
      resolve({ code, output: '(output sent to inherit stdio)' });
    });

    claude.on('error', (err) => {
      reject(err);
    });

    // 20 minute timeout for lint fixing
    setTimeout(() => {
      claude.kill();
      reject(new Error('Lint fixer timed out after 20 minutes'));
    }, 20 * 60 * 1000);
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
      SELECT id, section, title, description
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
      SELECT id, section, title, description
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
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', started_at = ? WHERE id = ?"
    ).run(now, taskId);
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
      "UPDATE tasks SET status = 'pending', started_at = NULL WHERE id = ?"
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
  return `[Task][task-runner-deputy-cto][AGENT:${agentId}] You are the Deputy-CTO processing a high-level task assignment.

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
Always start by creating an urgent investigator task:
\`\`\`
mcp__todo-db__create_task({
  section: "INVESTIGATOR & PLANNER",
  title: "Investigate: ${task.title}",
  description: "You are the INVESTIGATOR. Analyze the following task and create a detailed implementation plan with specific sub-tasks:\\n\\nTask: ${task.title}\\n${task.description || ''}\\n\\nInvestigate the codebase, read relevant specs, and create TODO items in the appropriate sections via mcp__todo-db__create_task for each sub-task you identify.",
  assigned_by: "deputy-cto",
  priority: "urgent"
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
- Create 3-8 specific sub-tasks per high-level task
- Each sub-task must be self-contained with enough context to execute independently
- Only delegate tasks that align with project specs and plans
- Report blockers via mcp__agent-reports__report_to_deputy_cto
- If the task needs CTO input, create a question via mcp__deputy-cto__add_question`;
}

/**
 * Build the prompt for a task runner agent
 */
function buildTaskRunnerPrompt(task, agentName, agentId, worktreePath = null) {
  const taskDetails = `[Task][task-runner-${agentName}][AGENT:${agentId}] You are an orchestrator processing a TODO task.

## Task Details

- **Task ID**: ${task.id}
- **Section**: ${task.section}
- **Title**: ${task.title}
${task.description ? `- **Description**: ${task.description}` : ''}`;

  // Git workflow block for worktree-based agents
  const gitWorkflowBlock = worktreePath ? `
## Git Workflow

You are working in a git worktree on a feature branch.
Your working directory: ${worktreePath}
MCP tools access shared state in the main project directory.

Commits on feature branches are non-blocking (lint + security only, no review gate).
Code review happens asynchronously at PR time.

When your work is complete:
1. \`git add <specific files>\` (never \`git add .\` or \`git add -A\`)
2. \`git commit -m "descriptive message"\`
3. Push and create PR:
\`\`\`
git push -u origin HEAD
gh pr create --base preview --head "$(git branch --show-current)" --title "${task.title}" --body "Automated: ${task.section} task" 2>/dev/null || true
\`\`\`
4. Request PR review (creates urgent task, triggers immediate deputy-CTO session):
\`\`\`
mcp__todo-db__create_task({ section: "DEPUTY-CTO", title: "Review PR: ${task.title}", description: "Review and merge the PR from this feature branch to preview. Run gh pr diff, review for security/architecture/quality, then approve+merge or request changes.", assigned_by: "pr-reviewer", priority: "urgent" })
\`\`\`

Do NOT self-merge. Deputy-CTO reviews and merges PRs asynchronously.
` : '';

  const completionBlock = `## When Done

### Step 1: Summarize Your Work (MANDATORY)
\`\`\`
mcp__todo-db__summarize_work({ summary: "<concise description of what you did and the outcome>", success: true/false })
\`\`\`
task_id is auto-resolved from your CLAUDE_AGENT_ID — do not pass it manually.

### Step 2: Mark Task Complete
\`\`\`
mcp__todo-db__complete_task({ id: "${task.id}" })
\`\`\`
${gitWorkflowBlock}
## Constraints

- Focus only on this specific task
- Do not create new tasks unless absolutely necessary
- Report any issues via mcp__agent-reports__report_to_deputy_cto`;

  // Section-specific workflow instructions
  if (task.section === 'CODE-REVIEWER') {
    return `${taskDetails}

## MANDATORY SUB-AGENT WORKFLOW

You are an ORCHESTRATOR. Do NOT edit files directly. Follow this sequence using the Task tool:

1. \`Task(subagent_type='investigator')\` - Research the task, understand the codebase
2. \`Task(subagent_type='code-writer')\` - Implement the changes
3. \`Task(subagent_type='test-writer')\` - Add/update tests
4. \`Task(subagent_type='code-reviewer')\` - Review changes, commit
5. \`Task(subagent_type='project-manager')\` - Sync documentation (ALWAYS LAST)

Pass the full task context to each sub-agent. Each sub-agent has specialized
instructions loaded from .claude/agents/ configs.

**YOU ARE PROHIBITED FROM:**
- Directly editing ANY files using Edit, Write, or NotebookEdit tools
- Making code changes without the code-writer sub-agent
- Making test changes without the test-writer sub-agent
- Skipping investigation before implementation
- Skipping code-reviewer after any code/test changes
- Skipping project-manager at the end

${completionBlock}`;
  }

  if (task.section === 'INVESTIGATOR & PLANNER') {
    return `${taskDetails}

## IMMEDIATE ACTION

Your first action MUST be:
\`\`\`
Task(subagent_type='investigator', prompt='${task.title}. ${task.description || ''}')
\`\`\`

The investigator sub-agent has specialized instructions loaded from .claude/agents/investigator.md.
Pass the full task context including title and description.

${completionBlock}`;
  }

  if (task.section === 'TEST-WRITER') {
    return `${taskDetails}

## IMMEDIATE ACTION

Your first action MUST be:
\`\`\`
Task(subagent_type='test-writer', prompt='${task.title}. ${task.description || ''}')
\`\`\`

Then after test-writer completes:
\`\`\`
Task(subagent_type='code-reviewer', prompt='Review the test changes from the previous step')
\`\`\`

Each sub-agent has specialized instructions loaded from .claude/agents/ configs.

${completionBlock}`;
  }

  if (task.section === 'PROJECT-MANAGER') {
    return `${taskDetails}

## IMMEDIATE ACTION

Your first action MUST be:
\`\`\`
Task(subagent_type='project-manager', prompt='${task.title}. ${task.description || ''}')
\`\`\`

The project-manager sub-agent has specialized instructions loaded from .claude/agents/project-manager.md.
Pass the full task context including title and description.

${completionBlock}`;
  }

  // Fallback for any other section
  return `${taskDetails}

## Your Role

You are the \`${agentName}\` agent. Complete the task described above using your expertise.
Use the Task tool to spawn the appropriate sub-agent: \`Task(subagent_type='${agentName}')\`

${completionBlock}`;
}

/**
 * Spawn a fire-and-forget Claude agent for a task.
 * When worktrees are available (preview branch exists), each agent gets its
 * own isolated worktree on a feature branch.  Falls back to PROJECT_DIR if
 * worktree creation fails.
 */
function spawnTaskAgent(task) {
  const mapping = SECTION_AGENT_MAP[task.section];
  if (!mapping) return false;

  // --- Worktree setup (best-effort) ---
  let agentCwd = PROJECT_DIR;
  let agentMcpConfig = path.join(PROJECT_DIR, '.mcp.json');
  let worktreePath = null;

  try {
    const branchName = getFeatureBranchName(task.title, task.id);
    const worktree = createWorktree(branchName);
    worktreePath = worktree.path;
    agentCwd = worktree.path;
    agentMcpConfig = path.join(worktree.path, '.mcp.json');
    log(`Task runner: worktree ready at ${worktree.path} (branch ${branchName}, created=${worktree.created})`);
  } catch (err) {
    log(`Task runner: worktree creation failed, falling back to PROJECT_DIR: ${err.message}`);
  }

  // Register first to get agentId for prompt embedding
  const agentId = registerSpawn({
    type: mapping.agentType,
    hookType: HOOK_TYPES.TASK_RUNNER,
    description: `Task runner: ${mapping.agent} - ${task.title}`,
    prompt: '',
    metadata: { taskId: task.id, section: task.section, worktreePath },
  });

  const prompt = mapping.agent === 'deputy-cto'
    ? buildDeputyCtoTaskPrompt(task, agentId)
    : buildTaskRunnerPrompt(task, mapping.agent, agentId, worktreePath);

  // Store prompt now that it's built
  updateAgent(agentId, { prompt });

  try {
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--mcp-config', agentMcpConfig,
      '--output-format', 'json',
      '-p',
      prompt,
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: agentCwd,
      env: {
        ...buildSpawnEnv(agentId),
        CLAUDE_PROJECT_DIR: PROJECT_DIR,  // State files always in main project
      },
    });

    claude.unref();

    // Store PID for reaper tracking
    updateAgent(agentId, { pid: claude.pid, status: 'running' });

    return true;
  } catch (err) {
    log(`Task runner: Failed to spawn ${mapping.agent} for task ${task.id}: ${err.message}`);
    return false;
  }
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
  } catch {
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
  } catch {
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
  } catch {
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
      } catch { /* non-fatal */ }
    }
    return { cwd: worktree.path, mcpConfig: path.join(worktree.path, '.mcp.json') };
  } catch (err) {
    log(`Promotion worktree creation failed for ${promotionType}, falling back to PROJECT_DIR: ${err.message}`);
    return { cwd: PROJECT_DIR, mcpConfig: path.join(PROJECT_DIR, '.mcp.json') };
  }
}

/**
 * Spawn Preview -> Staging promotion orchestrator
 */
function spawnPreviewPromotion(newCommits, hoursSinceLastStagingMerge, hasBugFix) {
  const commitList = newCommits.join('\n');

  const agentId = registerSpawn({
    type: AGENT_TYPES.PREVIEW_PROMOTION,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Preview -> Staging promotion pipeline',
    prompt: '',
    metadata: { commitCount: newCommits.length, hoursSinceLastStagingMerge, hasBugFix },
  });

  const prompt = `[Task][preview-promotion][AGENT:${agentId}] You are the PREVIEW -> STAGING Promotion Pipeline orchestrator.

## Mission

Evaluate whether commits on the \`preview\` branch are ready to be promoted to \`staging\`.

## Context

**New commits on preview (not in staging):**
\`\`\`
${commitList}
\`\`\`

**Hours since last staging merge:** ${hoursSinceLastStagingMerge}
**Bug-fix commits detected:** ${hasBugFix ? 'YES (24h waiting period bypassed)' : 'No'}

## Process

### Step 1: Code Review

Spawn a code-reviewer sub-agent (Task tool, subagent_type: code-reviewer) to review the commits:
- Check for security issues, code quality, spec violations
- Look for disabled tests, placeholder code, hardcoded credentials
- Verify no spec violations (G001-G019)

### Step 2: Test Assessment

Spawn a test-writer sub-agent (Task tool, subagent_type: test-writer) to assess test quality:
- Check if new code has adequate test coverage
- Verify no tests were disabled or weakened

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

Summarize the promotion decision and actions taken.`;

  // Store prompt now that it's built
  updateAgent(agentId, { prompt });

  try {
    const wt = getPromotionWorktree('preview-promotion');
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--mcp-config', wt.mcpConfig,
      '--output-format', 'json',
      '-p',
      prompt,
    ], {
      cwd: wt.cwd,
      stdio: 'inherit',
      env: {
        ...buildSpawnEnv(agentId),
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        GENTYR_PROMOTION_PIPELINE: 'true',
      },
    });

    return new Promise((resolve, reject) => {
      claude.on('close', (code) => {
        resolve({ code, output: '(output sent to inherit stdio)' });
      });
      claude.on('error', (err) => reject(err));
      setTimeout(() => {
        claude.kill();
        reject(new Error('Preview promotion timed out after 30 minutes'));
      }, 30 * 60 * 1000);
    });
  } catch (err) {
    log(`Preview promotion spawn error: ${err.message}`);
    return Promise.resolve({ code: 1, output: err.message });
  }
}

/**
 * Spawn Staging -> Production promotion orchestrator
 */
function spawnStagingPromotion(newCommits, hoursSinceLastStagingCommit) {
  const commitList = newCommits.join('\n');

  const agentId = registerSpawn({
    type: AGENT_TYPES.STAGING_PROMOTION,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Staging -> Production promotion pipeline',
    prompt: '',
    metadata: { commitCount: newCommits.length, hoursSinceLastStagingCommit },
  });

  const prompt = `[Task][staging-promotion][AGENT:${agentId}] You are the STAGING -> PRODUCTION Promotion Pipeline orchestrator.

## Mission

Evaluate whether commits on the \`staging\` branch are ready to be promoted to \`main\` (production).

## Context

**New commits on staging (not in main):**
\`\`\`
${commitList}
\`\`\`

**Hours since last staging commit:** ${hoursSinceLastStagingCommit} (must be >= 24 for stability)

## Process

### Step 1: Code Review

Spawn a code-reviewer sub-agent (Task tool, subagent_type: code-reviewer) to review all staging commits:
- Full security audit
- Spec compliance check (G001-G019)
- No placeholder code, disabled tests, or hardcoded credentials

### Step 2: Test Assessment

Spawn a test-writer sub-agent (Task tool, subagent_type: test-writer) to assess:
- Test coverage meets thresholds (80% global, 100% critical paths)
- No tests disabled or weakened

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

Summarize the promotion decision and actions taken.`;

  // Store prompt now that it's built
  updateAgent(agentId, { prompt });

  try {
    const wt = getPromotionWorktree('staging-promotion');
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--mcp-config', wt.mcpConfig,
      '--output-format', 'json',
      '-p',
      prompt,
    ], {
      cwd: wt.cwd,
      stdio: 'inherit',
      env: {
        ...buildSpawnEnv(agentId),
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        GENTYR_PROMOTION_PIPELINE: 'true',
      },
    });

    return new Promise((resolve, reject) => {
      claude.on('close', (code) => {
        resolve({ code, output: '(output sent to inherit stdio)' });
      });
      claude.on('error', (err) => reject(err));
      setTimeout(() => {
        claude.kill();
        reject(new Error('Staging promotion timed out after 30 minutes'));
      }, 30 * 60 * 1000);
    });
  } catch (err) {
    log(`Staging promotion spawn error: ${err.message}`);
    return Promise.resolve({ code: 1, output: err.message });
  }
}

/**
 * Spawn Emergency Hotfix Promotion (staging -> main, bypasses 24h + midnight)
 *
 * Called by the deputy-cto MCP server's execute_hotfix_promotion tool.
 * Uses the staging-promotion worktree for isolation, sets GENTYR_PROMOTION_PIPELINE=true.
 *
 * @param {string[]} commits - Commit oneline summaries being promoted
 * @returns {Promise<{code: number, output: string}>}
 */
export function spawnHotfixPromotion(commits) {
  const commitList = commits.join('\n');

  const agentId = registerSpawn({
    type: AGENT_TYPES.HOTFIX_PROMOTION,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Emergency hotfix: staging -> main promotion',
    prompt: '',
    metadata: { commitCount: commits.length, isHotfix: true },
  });

  const prompt = `[Task][hotfix-promotion][AGENT:${agentId}] You are the EMERGENCY HOTFIX Promotion Pipeline.

## Mission

Immediately merge staging into main. This is a CTO-approved emergency hotfix that bypasses:
- The 24-hour stability requirement
- The midnight deployment window

Code review and quality checks still apply.

## Commits being promoted

\`\`\`
${commitList}
\`\`\`

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

Complete within 25 minutes. If blocked, report and exit.`;

  updateAgent(agentId, { prompt });

  try {
    const wt = getPromotionWorktree('staging-promotion');
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--mcp-config', wt.mcpConfig,
      '--output-format', 'json',
      '-p',
      prompt,
    ], {
      cwd: wt.cwd,
      stdio: 'inherit',
      env: {
        ...buildSpawnEnv(agentId),
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        GENTYR_PROMOTION_PIPELINE: 'true',
      },
    });

    return new Promise((resolve, reject) => {
      claude.on('close', (code) => {
        resolve({ code, output: '(output sent to inherit stdio)' });
      });
      claude.on('error', (err) => reject(err));
      setTimeout(() => {
        claude.kill();
        reject(new Error('Hotfix promotion timed out after 30 minutes'));
      }, 30 * 60 * 1000);
    });
  } catch (err) {
    log(`Hotfix promotion spawn error: ${err.message}`);
    return Promise.resolve({ code: 1, output: err.message });
  }
}

/**
 * GAP 4: Verify a spawned process is still alive after a short delay.
 * Returns true if the PID responds to signal 0, false otherwise.
 * Prevents cooldown consumption when spawn() succeeds but the process dies immediately.
 */
async function verifySpawnAlive(pid, label) {
  if (!pid) return false;
  return new Promise(resolve => {
    setTimeout(() => {
      try {
        process.kill(pid, 0);
        resolve(true);
      } catch {
        log(`${label}: PID ${pid} not alive after 2s. Cooldown NOT consumed.`);
        resolve(false);
      }
    }, 2000);
  });
}

/**
 * Spawn Staging Health Monitor (fire-and-forget)
 * GAP 4: Returns { success, pid } instead of boolean for deferred cooldown stamps.
 */
function spawnStagingHealthMonitor() {
  const agentId = registerSpawn({
    type: AGENT_TYPES.STAGING_HEALTH_MONITOR,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Staging health monitor check',
    prompt: '',
    metadata: {},
  });

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

  const prompt = `[Task][staging-health-monitor][AGENT:${agentId}] You are the STAGING Health Monitor.

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

2. For actionable issues, create an urgent fix task:
   \`\`\`
   mcp__todo-db__create_task({
     section: "CODE-REVIEWER",
     title: "Fix staging health issue: [summary]",
     description: "[Detailed description of the issue and how to fix it. Include all relevant context: error messages, service IDs, etc.]",
     assigned_by: "staging-health-monitor",
     priority: "urgent"
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

  // Store prompt now that it's built
  updateAgent(agentId, { prompt });

  try {
    const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '--output-format', 'json',
      '-p',
      prompt,
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env: buildSpawnEnv(agentId),
    });

    claude.unref();
    updateAgent(agentId, { pid: claude.pid, status: 'running' });
    return { success: true, pid: claude.pid };
  } catch (err) {
    log(`Staging health monitor spawn error: ${err.message}`);
    return { success: false, pid: null };
  }
}

/**
 * Spawn Production Health Monitor (fire-and-forget)
 * GAP 4: Returns { success, pid } instead of boolean for deferred cooldown stamps.
 */
function spawnProductionHealthMonitor() {
  const agentId = registerSpawn({
    type: AGENT_TYPES.PRODUCTION_HEALTH_MONITOR,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Production health monitor check',
    prompt: '',
    metadata: {},
  });

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

  const prompt = `[Task][production-health-monitor][AGENT:${agentId}] You are the PRODUCTION Health Monitor.

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

3. For actionable issues, create an urgent fix task:
   \`\`\`
   mcp__todo-db__create_task({
     section: "CODE-REVIEWER",
     title: "Fix production health issue: [summary]",
     description: "[Detailed description of the issue and how to fix it. Include all relevant context: error messages, service IDs, etc.]",
     assigned_by: "production-health-monitor",
     priority: "urgent"
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

  try {
    const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '--output-format', 'json',
      '-p',
      prompt,
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env: buildSpawnEnv(agentId),
    });

    claude.unref();
    updateAgent(agentId, { pid: claude.pid, status: 'running', prompt });
    return { success: true, pid: claude.pid };
  } catch (err) {
    log(`Production health monitor spawn error: ${err.message}`);
    return { success: false, pid: null };
  }
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
  const agentId = registerSpawn({
    type: AGENT_TYPES.STANDALONE_ANTIPATTERN_HUNTER,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Standalone antipattern hunt (3h schedule)',
    prompt: '',
    metadata: {},
  });

  const prompt = `[Task][standalone-antipattern-hunter][AGENT:${agentId}] STANDALONE ANTIPATTERN HUNT - Periodic repo-wide scan for spec violations.

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

Focus on finding SYSTEMIC issues across the codebase, not just isolated violations.`;

  // Store prompt now that it's built
  updateAgent(agentId, { prompt });

  try {
    const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '--output-format', 'json',
      '-p',
      prompt,
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env: buildSpawnEnv(agentId),
    });

    claude.unref();
    updateAgent(agentId, { pid: claude.pid, status: 'running' });
    return true;
  } catch (err) {
    log(`Standalone antipattern hunter spawn error: ${err.message}`);
    return false;
  }
}

/**
 * Spawn Standalone Compliance Checker (fire-and-forget)
 * Picks a random spec and scans the codebase for violations of that specific spec
 */
function spawnStandaloneComplianceChecker(spec) {
  const agentId = registerSpawn({
    type: AGENT_TYPES.STANDALONE_COMPLIANCE_CHECKER,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: `Standalone compliance check: ${spec.id}`,
    prompt: '',
    metadata: { specId: spec.id, specPath: spec.path },
  });

  const prompt = `[Task][standalone-compliance-checker][AGENT:${agentId}] STANDALONE COMPLIANCE CHECK - Audit codebase against spec: ${spec.id}

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

Do NOT implement fixes yourself. Only report and create TODOs.`;

  // Store prompt now that it's built
  updateAgent(agentId, { prompt });

  try {
    const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '--output-format', 'json',
      '-p',
      prompt,
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env: buildSpawnEnv(agentId),
    });

    claude.unref();
    updateAgent(agentId, { pid: claude.pid, status: 'running' });
    return true;
  } catch (err) {
    log(`Standalone compliance checker spawn error: ${err.message}`);
    return false;
  }
}

/**
 * Main entry point
 */
async function main() {
  const startTime = Date.now();
  log('=== Hourly Automation Starting ===');

  // Check config
  const config = getConfig();

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

  // Check rotation proxy health (non-blocking, informational only)
  const proxyHealth = await checkProxyHealth();
  if (proxyHealth.running) {
    log(`Rotation proxy: UP (activeKey=${proxyHealth.activeKeyId?.slice(0, 8) || 'unknown'})`);
  } else {
    log('Rotation proxy: DOWN — agents will run without proxy-based rotation.');
  }

  // Check for overdrive concurrency override
  let effectiveMaxConcurrent = MAX_CONCURRENT_AGENTS;
  try {
    const autoConfigPath = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');
    if (fs.existsSync(autoConfigPath)) {
      const autoConfig = JSON.parse(fs.readFileSync(autoConfigPath, 'utf8'));
      if (autoConfig.overdrive?.active && new Date() < new Date(autoConfig.overdrive.expires_at)) {
        const override = autoConfig.overdrive.max_concurrent_override;
        effectiveMaxConcurrent = (typeof override === 'number' && override >= 1 && override <= 20)
          ? override : MAX_CONCURRENT_AGENTS;
        log(`Overdrive active: concurrency limit raised to ${effectiveMaxConcurrent}`);
      }
    }
  } catch {
    // Fail safe - use default
  }

  // Reap completed agents before counting to free concurrency slots
  try {
    const { reapCompletedAgents } = await import(path.resolve(__dirname, '..', '..', 'scripts', 'reap-completed-agents.js'));
    const reapResult = reapCompletedAgents(PROJECT_DIR);
    if (reapResult.reaped.length > 0) {
      log(`Reaper: cleaned up ${reapResult.reaped.length} completed agent(s).`);
    }
  } catch (err) {
    // Non-fatal — count will be conservative
    log(`Reaper: skipped (${err.message})`);
  }

  // Concurrency guard: skip cycle if too many agents are already running
  const runningAgents = countRunningAgents();
  if (runningAgents >= effectiveMaxConcurrent) {
    log(`Concurrency limit reached (${runningAgents}/${effectiveMaxConcurrent} agents running). Skipping this cycle.`);
    registerHookExecution({
      hookType: HOOK_TYPES.HOURLY_AUTOMATION,
      status: 'skipped',
      durationMs: Date.now() - startTime,
      metadata: { reason: 'concurrency_limit', runningAgents }
    });
    process.exit(0);
  }
  log(`Running agents: ${runningAgents}/${effectiveMaxConcurrent}`);

  const state = getState();
  const now = Date.now();

  // =========================================================================
  // USAGE OPTIMIZER (runs first - cheap: API call + math)
  // =========================================================================
  try {
    const optimizerResult = await runUsageOptimizer(log);
    if (optimizerResult.snapshotTaken) {
      log(`Usage optimizer: snapshot taken. Adjustment: ${optimizerResult.adjustmentMade ? 'yes' : 'no'}.`);
    }
  } catch (err) {
    log(`Usage optimizer error (non-fatal): ${err.message}`);
  }

  // =========================================================================
  // KEY SYNC (runs after usage optimizer - discovers keys from all sources)
  // Triggered by both 10-min timer and WatchPaths file change events
  // =========================================================================
  try {
    const syncResult = await syncKeys(log);
    if (syncResult.keysAdded > 0) {
      log(`Key sync: ${syncResult.keysAdded} new key(s) discovered.`);
    }
    if (syncResult.tokensRefreshed > 0) {
      log(`Key sync: ${syncResult.tokensRefreshed} token(s) refreshed.`);
    }
  } catch (err) {
    log(`Key sync error (non-fatal): ${err.message}`);
  }

  // =========================================================================
  // SESSION REVIVER (after key sync — credentials must be fresh first)
  // Gate-exempt: recovery operation
  // =========================================================================
  const SESSION_REVIVER_COOLDOWN_MS = getCooldown('session_reviver', 10) * 60 * 1000;
  const timeSinceLastSessionReviver = now - (state.lastSessionReviverCheck || 0);

  if (timeSinceLastSessionReviver >= SESSION_REVIVER_COOLDOWN_MS) {
    try {
      const isFirstRun = !state.lastSessionReviverCheck;
      const reviverResult = await reviveInterruptedSessions(log, effectiveMaxConcurrent, {
        retroactive: isFirstRun,
      });
      const total = reviverResult.revivedQuota + reviverResult.revivedDead + reviverResult.revivedPaused;
      if (total > 0) {
        log(`Session reviver: revived ${total} (quota:${reviverResult.revivedQuota} dead:${reviverResult.revivedDead} paused:${reviverResult.revivedPaused})${isFirstRun ? ' [retroactive]' : ''}`);
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

  // =========================================================================
  // BINARY PATCH VERSION WATCH (runs after key sync — detects Claude updates)
  // =========================================================================
  try {
    const { checkAndRepatch } = await import(
      path.join(PROJECT_DIR, 'scripts', 'watch-claude-version.js')
    );
    await checkAndRepatch(log);
  } catch (err) {
    // Non-fatal: version watch is optional
    if (err.code !== 'ERR_MODULE_NOT_FOUND') {
      log(`Version watch error (non-fatal): ${err.message}`);
    }
  }

  // Dynamic cooldowns from config
  const TRIAGE_CHECK_INTERVAL_MS = getCooldown('triage_check', 5) * 60 * 1000;
  const HOURLY_COOLDOWN_MS = getCooldown('hourly_tasks', 55) * 60 * 1000;
  const LINT_COOLDOWN_MS = getCooldown('lint_checker', 30) * 60 * 1000;
  const PREVIEW_PROMOTION_COOLDOWN_MS = getCooldown('preview_promotion', 360) * 60 * 1000;
  const STAGING_PROMOTION_COOLDOWN_MS = getCooldown('staging_promotion', 1200) * 60 * 1000;
  const STAGING_HEALTH_COOLDOWN_MS = getCooldown('staging_health_monitor', 180) * 60 * 1000;
  const PRODUCTION_HEALTH_COOLDOWN_MS = getCooldown('production_health_monitor', 60) * 60 * 1000;
  const STANDALONE_ANTIPATTERN_COOLDOWN_MS = getCooldown('standalone_antipattern_hunter', 180) * 60 * 1000;
  const STANDALONE_COMPLIANCE_COOLDOWN_MS = getCooldown('standalone_compliance_checker', 60) * 60 * 1000;
  const USER_FEEDBACK_COOLDOWN_MS = getCooldown('user_feedback', 120) * 60 * 1000;

  // =========================================================================
  // TRIAGE CHECK (dynamic interval, default 5 min)
  // Per-item cooldown is handled by the MCP server's get_reports_for_triage
  // =========================================================================
  const timeSinceLastTriageCheck = now - state.lastTriageCheck;

  if (timeSinceLastTriageCheck >= TRIAGE_CHECK_INTERVAL_MS) {
    // Quick check if there are any pending reports
    if (hasReportsReadyForTriage()) {
      log('Pending reports found, spawning triage agent...');
      state.lastTriageCheck = now;
      saveState(state);

      try {
        // The agent will call get_reports_for_triage which handles cooldown filtering
        const result = await spawnReportTriage();
        if (result.code === 0) {
          log('Report triage completed successfully.');
        } else {
          log(`Report triage exited with code ${result.code}`);
        }
      } catch (err) {
        log(`Report triage error: ${err.message}`);
      }
    } else {
      log('No pending reports found.');
      state.lastTriageCheck = now;
      saveState(state);
    }
  } else {
    const minutesLeft = Math.ceil((TRIAGE_CHECK_INTERVAL_MS - timeSinceLastTriageCheck) / 60000);
    log(`Triage check cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // STAGING HEALTH MONITOR (3h cooldown, fire-and-forget) [GATE-EXEMPT]
  // Checks staging infrastructure health
  // =========================================================================
  const timeSinceLastStagingHealth = now - (state.lastStagingHealthCheck || 0);
  const stagingHealthEnabled = config.stagingHealthMonitorEnabled !== false;

  if (timeSinceLastStagingHealth >= STAGING_HEALTH_COOLDOWN_MS && stagingHealthEnabled) {
    try {
      execSync('git fetch origin staging --quiet 2>/dev/null || true', {
        cwd: PROJECT_DIR, encoding: 'utf8', timeout: 30000, stdio: 'pipe',
      });
    } catch {
      log('Staging health monitor: git fetch failed.');
    }

    if (remoteBranchExists('staging')) {
      log('Staging health monitor: spawning health check...');
      const result = spawnStagingHealthMonitor();
      if (result.success) {
        const alive = await verifySpawnAlive(result.pid, 'Staging health monitor');
        if (alive) {
          state.lastStagingHealthCheck = now;
          saveState(state);
        }
        log('Staging health monitor: spawned (fire-and-forget).');
      } else {
        log('Staging health monitor: spawn failed.');
      }
    } else {
      log('Staging health monitor: staging branch does not exist, skipping.');
    }
  } else if (!stagingHealthEnabled) {
    log('Staging Health Monitor is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((STAGING_HEALTH_COOLDOWN_MS - timeSinceLastStagingHealth) / 60000);
    log(`Staging health monitor cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // PRODUCTION HEALTH MONITOR (1h cooldown, fire-and-forget) [GATE-EXEMPT]
  // Checks production infrastructure health, escalates to CTO
  // =========================================================================
  const timeSinceLastProdHealth = now - (state.lastProductionHealthCheck || 0);
  const prodHealthEnabled = config.productionHealthMonitorEnabled !== false;

  if (timeSinceLastProdHealth >= PRODUCTION_HEALTH_COOLDOWN_MS && prodHealthEnabled) {
    log('Production health monitor: spawning health check...');
    const result = spawnProductionHealthMonitor();
    if (result.success) {
      const alive = await verifySpawnAlive(result.pid, 'Production health monitor');
      if (alive) {
        state.lastProductionHealthCheck = now;
        saveState(state);
      }
      log('Production health monitor: spawned (fire-and-forget).');
    } else {
      log('Production health monitor: spawn failed.');
    }
  } else if (!prodHealthEnabled) {
    log('Production Health Monitor is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((PRODUCTION_HEALTH_COOLDOWN_MS - timeSinceLastProdHealth) / 60000);
    log(`Production health monitor cooldown active. ${minutesLeft} minutes until next check.`);
  }

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
    } catch {
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
      const currentRunning = countRunningAgents();
      const availableSlots = Math.max(0, effectiveMaxConcurrent - currentRunning);
      if (availableSlots === 0) {
        log(`Urgent dispatcher: no available slots (${currentRunning}/${effectiveMaxConcurrent}). Deferring urgent tasks.`);
      } else {
        log(`Urgent dispatcher: ${availableSlots} slot(s) available (${currentRunning}/${effectiveMaxConcurrent}).`);
        let dispatched = 0;
        for (const task of urgentTasks) {
          if (dispatched >= availableSlots) {
            log(`Urgent dispatcher: concurrency limit reached, deferring remaining urgent tasks.`);
            break;
          }
          const mapping = SECTION_AGENT_MAP[task.section];
          if (!mapping) continue;
          if (!markTaskInProgress(task.id)) {
            log(`Urgent dispatcher: skipping task ${task.id} (failed to mark in_progress).`);
            continue;
          }
          const success = spawnTaskAgent(task);
          if (success) {
            log(`Urgent dispatcher: spawned ${mapping.agent} for "${task.title}" (${task.id})`);
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
  // CTO GATE CHECK — exit if gate is closed after all monitoring-only steps
  // GAP 5: Everything above this point (Usage Optimizer, Key Sync, Session
  // Reviver, Triage, Health Monitors, CI Monitoring, Persistent Alerts,
  // Merge Chain Gap, Urgent Dispatcher) runs regardless of CTO gate status.
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
  const timeSinceLastLint = now - (state.lastLintCheck || 0);

  if (timeSinceLastLint >= LINT_COOLDOWN_MS && config.lintCheckerEnabled) {
    log('Running lint check...');
    const lintResult = runLintCheck();

    if (lintResult.hasErrors) {
      const errorCount = (lintResult.output.match(/\berror\b/gi) || []).length;
      log(`Lint check found ${errorCount} error(s), spawning fixer...`);

      try {
        const result = await spawnLintFixer(lintResult.output);
        if (result.code === 0) {
          log('Lint fixer completed successfully.');
        } else {
          log(`Lint fixer exited with code ${result.code}`);
        }
      } catch (err) {
        log(`Lint fixer error: ${err.message}`);
      }
    } else {
      log('Lint check passed - no errors found.');
    }

    state.lastLintCheck = now;
    saveState(state);
  } else if (!config.lintCheckerEnabled) {
    log('Lint Checker is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((LINT_COOLDOWN_MS - timeSinceLastLint) / 60000);
    log(`Lint check cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // TASK RUNNER CHECK (1h cooldown)
  // Spawns a separate Claude session for every pending TODO item >1h old
  // =========================================================================
  const TASK_RUNNER_COOLDOWN_MS = getCooldown('task_runner', 60) * 60 * 1000;
  const timeSinceLastTaskRunner = now - (state.lastTaskRunnerCheck || 0);

  if (timeSinceLastTaskRunner >= TASK_RUNNER_COOLDOWN_MS && config.taskRunnerEnabled) {
    if (!Database) {
      log('Task runner: better-sqlite3 not available, skipping.');
    } else {
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

          const mapping = SECTION_AGENT_MAP[task.section];
          if (!mapping) continue;

          if (!markTaskInProgress(task.id)) {
            log(`Task runner: skipping task ${task.id} (failed to mark in_progress).`);
            continue;
          }

          const success = spawnTaskAgent(task);
          if (success) {
            log(`Task runner: spawning ${mapping.agent} for task "${task.title}" (${task.id})`);
            spawned++;
          } else {
            resetTaskToPending(task.id);
            log(`Task runner: spawn failed for task ${task.id}, reset to pending.`);
          }
        }

        log(`Task runner: spawned ${spawned} agent(s) this cycle.`);
      }
    }

    state.lastTaskRunnerCheck = now;
    saveState(state);
  } else if (!config.taskRunnerEnabled) {
    log('Task Runner is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((TASK_RUNNER_COOLDOWN_MS - timeSinceLastTaskRunner) / 60000);
    log(`Task runner cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // STAGING -> PRODUCTION PROMOTION (midnight window, 20h cooldown)
  // Checks nightly for stable staging to promote to production
  // NOTE: Runs BEFORE preview→staging to prevent clock-reset starvation
  // =========================================================================
  const timeSinceLastStagingPromotion = now - (state.lastStagingPromotionCheck || 0);
  const stagingPromotionEnabled = config.stagingPromotionEnabled !== false;
  const currentHour = new Date().getHours();
  const currentMinute = new Date().getMinutes();
  const isMidnightWindow = currentHour === 0 && currentMinute <= 30;

  if (isMidnightWindow && timeSinceLastStagingPromotion >= STAGING_PROMOTION_COOLDOWN_MS && stagingPromotionEnabled) {
    log('Staging promotion: midnight window - checking for promotable commits...');

    try {
      execSync('git fetch origin staging main --quiet 2>/dev/null || true', {
        cwd: PROJECT_DIR, encoding: 'utf8', timeout: 30000, stdio: 'pipe',
      });
    } catch {
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

            try {
              const result = await spawnStagingPromotion(newCommits, hoursSinceLastStagingCommit);
              if (result.code === 0) {
                log('Staging promotion pipeline completed successfully.');
              } else {
                log(`Staging promotion pipeline exited with code ${result.code}`);
              }
            } catch (err) {
              log(`Staging promotion error: ${err.message}`);
            }
          }
        } else {
          log(`Staging promotion: staging only ${hoursSinceLastStagingCommit}h old (need 24h stability).`);
        }
      }
    } else {
      log('Staging promotion: staging or main branch does not exist on remote.');
    }

    state.lastStagingPromotionCheck = now;
    saveState(state);
  } else if (!stagingPromotionEnabled) {
    log('Staging Promotion is disabled in config.');
  } else if (!isMidnightWindow) {
    // Only log this at debug level since it runs every 10 minutes
  } else {
    const minutesLeft = Math.ceil((STAGING_PROMOTION_COOLDOWN_MS - timeSinceLastStagingPromotion) / 60000);
    log(`Staging promotion cooldown active. ${minutesLeft} minutes until next check.`);
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
  } catch { /* non-fatal */ }

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
  const timeSinceLastPreviewPromotion = now - (state.lastPreviewPromotionCheck || 0);
  const previewPromotionEnabled = config.previewPromotionEnabled !== false;

  if (state.stagingFreezeActive) {
    log(`Preview promotion: PAUSED by staging freeze (staging ${Math.floor(stagingAgeHours)}h old, waiting for staging→main).`);
    // Do NOT update lastPreviewPromotionCheck — so it fires immediately when freeze lifts
  } else if (timeSinceLastPreviewPromotion >= PREVIEW_PROMOTION_COOLDOWN_MS && previewPromotionEnabled) {
    log('Preview promotion: checking for promotable commits...');

    try {
      // Fetch latest remote state
      execSync('git fetch origin preview staging --quiet 2>/dev/null || true', {
        cwd: PROJECT_DIR, encoding: 'utf8', timeout: 30000, stdio: 'pipe',
      });
    } catch {
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

          try {
            const result = await spawnPreviewPromotion(newCommits, hoursSinceLastStagingMerge, hasBugFix);
            if (result.code === 0) {
              log('Preview promotion pipeline completed successfully.');
              state.lastPreviewToStagingMergeAt = now;
              saveState(state);
            } else {
              log(`Preview promotion pipeline exited with code ${result.code}`);
            }
          } catch (err) {
            log(`Preview promotion error: ${err.message}`);
          }
        } else {
          log(`Preview promotion: ${newCommits.length} commits pending but staging only ${hoursSinceLastStagingMerge}h old (need 24h or bug fix).`);
        }
      }
    } else {
      log('Preview promotion: preview or staging branch does not exist on remote.');
    }

    state.lastPreviewPromotionCheck = now;
    saveState(state);
  } else if (!previewPromotionEnabled) {
    log('Preview Promotion is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((PREVIEW_PROMOTION_COOLDOWN_MS - timeSinceLastPreviewPromotion) / 60000);
    log(`Preview promotion cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // WORKTREE CLEANUP (30min cooldown)
  // Removes worktrees whose feature branches have been merged to preview
  // =========================================================================
  const WORKTREE_CLEANUP_COOLDOWN_MS = getCooldown('worktree_cleanup', 30) * 60 * 1000;
  const timeSinceLastWorktreeCleanup = now - (state.lastWorktreeCleanup || 0);
  const worktreeCleanupEnabled = config.worktreeCleanupEnabled !== false;

  if (timeSinceLastWorktreeCleanup >= WORKTREE_CLEANUP_COOLDOWN_MS && worktreeCleanupEnabled) {
    log('Worktree cleanup: checking for merged worktrees...');
    try {
      const cleaned = cleanupMergedWorktrees();
      if (cleaned > 0) {
        log(`Worktree cleanup: removed ${cleaned} merged worktree(s).`);
      } else {
        log('Worktree cleanup: no merged worktrees to remove.');
      }
    } catch (err) {
      log(`Worktree cleanup error (non-fatal): ${err.message}`);
    }
    state.lastWorktreeCleanup = now;
    saveState(state);
  } else if (!worktreeCleanupEnabled) {
    log('Worktree Cleanup is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((WORKTREE_CLEANUP_COOLDOWN_MS - timeSinceLastWorktreeCleanup) / 60000);
    log(`Worktree cleanup cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // STALE WORK DETECTOR (24h cooldown)
  // Reports uncommitted changes, unpushed branches, and stale feature branches
  // =========================================================================
  const STALE_WORK_COOLDOWN_MS = getCooldown('stale_work_detector', 1440) * 60 * 1000;
  const timeSinceLastStaleCheck = now - (state.lastStaleWorkCheck || 0);
  const staleWorkEnabled = config.staleWorkDetectorEnabled !== false;

  if (timeSinceLastStaleCheck >= STALE_WORK_COOLDOWN_MS && staleWorkEnabled) {
    log('Stale work detector: scanning for stale work...');
    try {
      const report = detectStaleWork();
      if (report.hasIssues) {
        const reportText = formatReport(report);
        log(`Stale work detector: issues found - ${report.uncommittedFiles.length} uncommitted, ${report.unpushedBranches.length} unpushed, ${report.staleBranches.length} stale branches.`);

        // Report to deputy-CTO via agent-reports (if MCP available)
        try {
          const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
          if (fs.existsSync(mcpConfig)) {
            const reportPrompt = `[Task][stale-work-report] Report this stale work finding to the deputy-CTO.

Use mcp__agent-reports__report_to_deputy_cto with:
- reporting_agent: "stale-work-detector"
- title: "Stale Work Detected: ${report.uncommittedFiles.length} uncommitted, ${report.unpushedBranches.length} unpushed, ${report.staleBranches.length} stale branches"
- summary: ${JSON.stringify(reportText).slice(0, 500)}
- category: "git-hygiene"
- priority: "${report.staleBranches.length > 0 ? 'medium' : 'low'}"

Then exit.`;

            const reportAgent = spawn('claude', [
              '--dangerously-skip-permissions',
              '--mcp-config', mcpConfig,
              '--output-format', 'json',
              '-p', reportPrompt,
            ], {
              detached: true,
              stdio: 'ignore',
              cwd: PROJECT_DIR,
              env: buildSpawnEnv(`stale-report-${Date.now()}`),
            });
            reportAgent.unref();
          }
        } catch (reportErr) {
          log(`Stale work detector: failed to spawn reporter: ${reportErr.message}`);
        }
      } else {
        log('Stale work detector: no issues found.');
      }
    } catch (err) {
      log(`Stale work detector error (non-fatal): ${err.message}`);
    }
    state.lastStaleWorkCheck = now;
    saveState(state);
  } else if (!staleWorkEnabled) {
    log('Stale Work Detector is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((STALE_WORK_COOLDOWN_MS - timeSinceLastStaleCheck) / 60000);
    log(`Stale work detector cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // STANDALONE ANTIPATTERN HUNTER (3h cooldown, fire-and-forget)
  // Repo-wide spec violation scan, independent of git hooks
  // =========================================================================
  const timeSinceLastAntipatternHunt = now - (state.lastStandaloneAntipatternHunt || 0);
  const antipatternHuntEnabled = config.standaloneAntipatternHunterEnabled !== false;

  if (timeSinceLastAntipatternHunt >= STANDALONE_ANTIPATTERN_COOLDOWN_MS && antipatternHuntEnabled) {
    log('Standalone antipattern hunter: spawning repo-wide scan...');
    const success = spawnStandaloneAntipatternHunter();
    if (success) {
      log('Standalone antipattern hunter: spawned (fire-and-forget).');
    } else {
      log('Standalone antipattern hunter: spawn failed.');
    }

    state.lastStandaloneAntipatternHunt = now;
    saveState(state);
  } else if (!antipatternHuntEnabled) {
    log('Standalone Antipattern Hunter is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((STANDALONE_ANTIPATTERN_COOLDOWN_MS - timeSinceLastAntipatternHunt) / 60000);
    log(`Standalone antipattern hunter cooldown active. ${minutesLeft} minutes until next hunt.`);
  }

  // =========================================================================
  // STANDALONE COMPLIANCE CHECKER (1h cooldown, fire-and-forget)
  // Picks a random spec and audits the codebase against it
  // =========================================================================
  const timeSinceLastComplianceCheck = now - (state.lastStandaloneComplianceCheck || 0);
  const complianceCheckEnabled = config.standaloneComplianceCheckerEnabled !== false;

  if (timeSinceLastComplianceCheck >= STANDALONE_COMPLIANCE_COOLDOWN_MS && complianceCheckEnabled) {
    const randomSpec = getRandomSpec();
    if (randomSpec) {
      log(`Standalone compliance checker: spawning audit for spec ${randomSpec.id}...`);
      const success = spawnStandaloneComplianceChecker(randomSpec);
      if (success) {
        log(`Standalone compliance checker: spawned for ${randomSpec.id} (fire-and-forget).`);
      } else {
        log('Standalone compliance checker: spawn failed.');
      }
    } else {
      log('Standalone compliance checker: no specs found in specs/global/ or specs/local/.');
    }

    state.lastStandaloneComplianceCheck = now;
    saveState(state);
  } else if (!complianceCheckEnabled) {
    log('Standalone Compliance Checker is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((STANDALONE_COMPLIANCE_COOLDOWN_MS - timeSinceLastComplianceCheck) / 60000);
    log(`Standalone compliance checker cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // USER FEEDBACK PIPELINE (2h cooldown, fire-and-forget agents)
  // Detects staging changes, matches personas, spawns feedback agents
  // =========================================================================
  const userFeedbackEnabled = config.userFeedbackEnabled !== false;

  if (userFeedbackEnabled) {
    try {
      const feedbackResult = await runFeedbackPipeline(log, state, saveState, USER_FEEDBACK_COOLDOWN_MS);
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
    } catch (err) {
      log(`User feedback pipeline error (non-fatal): ${err.message}`);
    }
  } else {
    log('User Feedback Pipeline is disabled in config.');
  }

  // =========================================================================
  // HOURLY TASKS (dynamic cooldown, default 55 min)
  // =========================================================================
  const timeSinceLastRun = now - state.lastRun;

  if (timeSinceLastRun < HOURLY_COOLDOWN_MS) {
    const minutesLeft = Math.ceil((HOURLY_COOLDOWN_MS - timeSinceLastRun) / 60000);
    log(`Hourly tasks cooldown active. ${minutesLeft} minutes until next run.`);
    log('=== Hourly Automation Complete ===');
    registerHookExecution({
      hookType: HOOK_TYPES.HOURLY_AUTOMATION,
      status: 'success',
      durationMs: Date.now() - startTime,
      metadata: { fullRun: false, minutesUntilNext: minutesLeft }
    });
    return;
  }

  // Update state for hourly tasks
  state.lastRun = now;
  saveState(state);

  // Check CLAUDE.md size and run refactor if needed
  if (config.claudeMdRefactorEnabled) {
    const claudeMdSize = getClaudeMdSize();
    log(`CLAUDE.md size: ${claudeMdSize} characters (threshold: ${CLAUDE_MD_SIZE_THRESHOLD})`);

    if (claudeMdSize > CLAUDE_MD_SIZE_THRESHOLD) {
      log('CLAUDE.md exceeds threshold, spawning refactor...');
      try {
        const result = await spawnClaudeMdRefactor();
        if (result.code === 0) {
          log('CLAUDE.md refactor completed.');
          state.lastClaudeMdRefactor = now;
          saveState(state);
        } else {
          log(`CLAUDE.md refactor exited with code ${result.code}`);
        }
      } catch (err) {
        log(`CLAUDE.md refactor error: ${err.message}`);
      }
    } else {
      log('CLAUDE.md size is within threshold.');
    }
  } else {
    log('CLAUDE.md Refactor is disabled in config.');
  }

  log('=== Hourly Automation Complete ===');

  registerHookExecution({
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    status: 'success',
    durationMs: Date.now() - startTime,
    metadata: { fullRun: true }
  });
}

main();
