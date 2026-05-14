/**
 * Config Reader - Shared Cooldown Configuration
 *
 * Centralized configuration for all automation cooldowns.
 * Reads from .claude/state/automation-config.json, falls back to hardcoded defaults on error.
 *
 * Also manages the automation rate system (none/low/medium/high) which applies
 * a multiplier to all non-infrastructure cooldowns.
 *
 * Usage:
 *   import { getCooldown, getTimeout, getAutomationRate } from './config-reader.js';
 *   const cooldownMs = getCooldown('hourly_tasks', 55) * 60 * 1000;
 *
 * @version 2.0.0
 */

import * as fs from 'fs';
import * as path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');
const AUTOMATION_RATE_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'automation-rate.json');

// ============================================================================
// Automation Rate System
// ============================================================================

/**
 * Valid automation rate levels.
 * - none: no automated agents spawn (blocks at enqueue)
 * - low: automations run at very slow rates (5x slower than baseline)
 * - medium: moderate rates (2x slower than baseline)
 * - high: current baseline rates (multiplier 1x)
 */
export const AUTOMATION_RATES = ['none', 'low', 'medium', 'high'];

/**
 * Rate multipliers applied to non-infrastructure cooldowns.
 * Infinity for 'none' means cooldowns are effectively infinite (never fires),
 * but the actual blocking is done at the enqueue level in session-queue.js.
 */
export const RATE_MULTIPLIERS = {
  none: Infinity,
  low: 5,
  medium: 2,
  high: 1,
};

/**
 * Infrastructure keys that are NOT multiplied by the automation rate.
 * These are system maintenance operations that must run at fixed intervals
 * regardless of the automation rate setting — they don't spawn agents or
 * consume significant resources.
 */
export const INFRASTRUCTURE_KEYS = new Set([
  'session_reviver',
  'worktree_cleanup',
  'report_auto_resolve',
  'report_dedup',
  'rate_limit_cooldown_check',
  'rate_limit_cooldown_minutes',
  'usage_quota_cooldown_minutes',
  'persistent_stale_pause_resume',
  'persistent_heartbeat_stale_minutes',
  'plan_orphan_detection',
  'deferred_action_resume',
  'self_heal_fix_check',
  'self_heal_max_fix_attempts',
  'self_heal_fix_task_timeout_minutes',
  'session_hard_kill_minutes',
  'crash_backoff_base_minutes',
  'crash_backoff_max_minutes',
  'context_pressure_suggestion_tokens',
  'context_pressure_warning_tokens',
  'context_pressure_critical_tokens',
  'context_pressure_suggestion_minutes',
  'context_pressure_warning_minutes',
  'context_pressure_critical_minutes',
  'context_pressure_nudge_cooldown_minutes',
  'revival_compact_min_tokens',
  'revival_compact_max_minutes',
  'revival_compact_timeout_ms',
  'session_reaper',
  'screenshot_cleanup',
  'auto_rollback_check',
  'fly_image_freshness',
  'fly_project_image_freshness',
  'global_monitor_health',
  'stale_wait_detection_minutes',
  'stale_wait_escalation_minutes',
  'stale_wait_tool_call_threshold',
  'preview_promotion',
  'promotion_retry_check',
]);

/**
 * Get the current automation rate level.
 * Reads from .claude/state/automation-rate.json, defaults to 'low'.
 *
 * @returns {'none' | 'low' | 'medium' | 'high'}
 */
export function getAutomationRate() {
  try {
    if (!fs.existsSync(AUTOMATION_RATE_PATH)) return 'low';
    const content = fs.readFileSync(AUTOMATION_RATE_PATH, 'utf8');
    const state = JSON.parse(content);
    if (state && AUTOMATION_RATES.includes(state.rate)) {
      return state.rate;
    }
    return 'low';
  } catch (_) {
    return 'low';
  }
}

/**
 * Get the full automation rate state (rate + metadata).
 * @returns {{ rate: string, set_at: string|null, set_by: string|null }}
 */
export function getAutomationRateState() {
  try {
    if (!fs.existsSync(AUTOMATION_RATE_PATH)) {
      return { rate: 'low', set_at: null, set_by: null };
    }
    const content = fs.readFileSync(AUTOMATION_RATE_PATH, 'utf8');
    const state = JSON.parse(content);
    if (state && AUTOMATION_RATES.includes(state.rate)) {
      return {
        rate: state.rate,
        set_at: state.set_at || null,
        set_by: state.set_by || null,
      };
    }
    return { rate: 'low', set_at: null, set_by: null };
  } catch (_) {
    return { rate: 'low', set_at: null, set_by: null };
  }
}

/**
 * Set the automation rate level.
 * Writes state to .claude/state/automation-rate.json.
 *
 * @param {'none' | 'low' | 'medium' | 'high'} rate
 * @param {string} [setBy='cto']
 * @returns {{ rate: string, set_at: string, set_by: string }}
 */
export function setAutomationRate(rate, setBy = 'cto') {
  if (!AUTOMATION_RATES.includes(rate)) {
    throw new Error(`Invalid automation rate: ${rate}. Must be one of: ${AUTOMATION_RATES.join(', ')}`);
  }
  const state = { rate, set_at: new Date().toISOString(), set_by: setBy };
  const dir = path.dirname(AUTOMATION_RATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AUTOMATION_RATE_PATH, JSON.stringify(state, null, 2));
  return state;
}

/**
 * Get the effective multiplier for the current automation rate.
 * @returns {number}
 */
export function getAutomationRateMultiplier() {
  const rate = getAutomationRate();
  return RATE_MULTIPLIERS[rate] ?? 1;
}

// Hardcoded defaults (minutes) - used when config file is missing or corrupted
const DEFAULTS = {
  hourly_tasks: 180,                   // 3h cycle
  triage_check: 30,                    // 30min
  antipattern_hunter: 1440,            // daily
  schema_mapper: 1440,
  lint_checker: 180,                   // 3h
  todo_maintenance: 60,                // 1h
  task_runner: 240,                    // 4h
  triage_per_item: 180,                // 3h per-item
  staging_reactive_review: 60,          // 1h
  preview_promotion: 30,                // 30min
  deploy_event_monitor: 5,              // 5min
  dora_metrics_collection: 1440,       // daily (24h)
  staging_health_monitor: 480,         // 8h
  production_health_monitor: 240,      // 4h
  standalone_antipattern_hunter: 1440, // daily
  standalone_compliance_checker: 720,  // 12h
  user_feedback: 720,                  // 12h
  test_failure_reporter: 480,          // 8h per-suite spawn cooldown
  pre_commit_review: 5,                // 5min approval token expiry
  compliance_checker_file: 10080,      // 7 days in minutes (per-file cooldown)
  compliance_checker_spec: 10080,      // 7 days in minutes (per-spec cooldown)
  branch_drift_check: 120,             // 2h
  session_reviver: 10,                 // 10 minutes
  daily_feedback: 2880,                // 48 hours
  usage_optimizer: 5,                  // 5 minutes
  key_sync: 5,                         // 5 minutes
  version_watch: 5,                    // 5 minutes
  pr_sweep: 60,                        // 1h
  worktree_cleanup: 5,                 // 5 minutes
  abandoned_worktree_rescue: 15,       // 15 minutes
  stale_worktree_reaper: 20,           // 20 minutes
  stale_work_detector: 2880,           // 48 hours
  demo_validation: 1440,               // daily
  timed_pause_auto_resume: 1,          // 1 minute (check frequently for expired timed pauses)
  persistent_stale_pause_resume: 5,    // 5 minutes
  persistent_heartbeat_stale_minutes: 5, // 5 minutes
  plan_orphan_detection: 10,             // 10 minutes
  session_hard_kill_minutes: 60,         // 60 minutes
  screenshot_cleanup: 1440,              // daily (24h)
  promotion_retry_check: 5,             // 5 minutes
  report_auto_resolve: 2,              // 2 minutes
  report_dedup: 30,                    // 30 minutes
  rate_limit_cooldown_minutes: 5,      // 5 minutes cooldown after rate limit death
  usage_quota_cooldown_minutes: 60,    // 60 minutes cooldown after usage quota exhaustion
  rate_limit_cooldown_check: 2,        // check every 2 minutes for expired cooldowns
  self_heal_max_fix_attempts: 3,       // max fix attempts before escalating to CTO
  self_heal_fix_task_timeout_minutes: 15, // timeout for fix task completion check
  self_heal_fix_check: 5,             // 5 minutes between fix task completion checks
  crash_backoff_base_minutes: 5,       // base backoff for crash-loop (exponential)
  crash_backoff_max_minutes: 60,       // max backoff cap for crash-loop
  context_pressure_suggestion_tokens: 200000,  // context pressure: suggestion tier
  context_pressure_warning_tokens: 300000,     // context pressure: warning tier
  context_pressure_critical_tokens: 400000,    // context pressure: critical tier
  context_pressure_suggestion_minutes: 15,     // time-based: suggestion tier
  context_pressure_warning_minutes: 30,        // time-based: warning tier
  context_pressure_critical_minutes: 60,       // time-based: critical tier
  context_pressure_nudge_cooldown_minutes: 5,  // cooldown between nudges at same tier
  revival_compact_min_tokens: 200000,          // min tokens to trigger revival compaction
  revival_compact_max_minutes: 30,             // max minutes since last compact for revival
  revival_compact_timeout_ms: 120000,          // timeout for compact command (ms)
  security_audit: 10080,                       // weekly (7 days)
  environment_parity: 360,                     // 6 hours
  vulnerability_scan: 1440,                    // daily (24 hours)
  load_test: 360,                              // 6 hours (only runs during promotion)
  auto_rollback_check: 2,                      // 2 minutes
  fly_image_freshness: 60,                     // 1 hour
  fly_project_image_freshness: 30,             // 30 minutes
  global_monitor_health: 5,                    // 5 minutes
  global_monitor_idle_check: 1,                // 1 minute — fast idle pause/resume
  stale_wait_detection_minutes: 8,             // minutes before first stale-wait nudge
  stale_wait_escalation_minutes: 5,            // minutes after detection before instruction signal
  stale_wait_tool_call_threshold: 20,          // minimum non-progress tool calls to trigger
};

/**
 * Read the automation config file.
 * Returns null on any error (fail-safe: callers use fallback).
 */
function readConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return null;
    }
    const content = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = JSON.parse(content);
    if (!config || config.version !== 1) {
      return null;
    }
    return config;
  } catch {
    return null;
  }
}

/**
 * Get the effective cooldown for a given key.
 * Returns the value in minutes, multiplied by the automation rate multiplier
 * unless the key is in the INFRASTRUCTURE_KEYS set.
 *
 * Priority: effective (dynamic) > defaults (config) > fallbackMinutes (hardcoded)
 * Then: base value * rate multiplier (for non-infrastructure keys)
 *
 * @param {string} key - The cooldown key (e.g., 'hourly_tasks', 'task_runner')
 * @param {number} [fallbackMinutes] - Hardcoded fallback if config is unavailable
 * @returns {number} Cooldown in minutes
 */
export function getCooldown(key, fallbackMinutes) {
  const hardDefault = fallbackMinutes ?? DEFAULTS[key] ?? 55;

  let baseCooldown = hardDefault;

  const config = readConfig();
  if (config) {
    // Use effective (dynamically adjusted) value first, then defaults from config
    if (config.effective && typeof config.effective[key] === 'number') {
      baseCooldown = config.effective[key];
    } else if (config.defaults && typeof config.defaults[key] === 'number') {
      baseCooldown = config.defaults[key];
    }
  }

  // Apply automation rate multiplier to non-infrastructure keys
  if (!INFRASTRUCTURE_KEYS.has(key)) {
    const multiplier = getAutomationRateMultiplier();
    if (multiplier === Infinity) {
      return Infinity;
    }
    baseCooldown = baseCooldown * multiplier;
  }

  return baseCooldown;
}

/**
 * Get a timeout value for a given key.
 * Alias for getCooldown - semantically different but same mechanism.
 *
 * @param {string} key - The timeout key
 * @param {number} [fallbackMinutes] - Hardcoded fallback
 * @returns {number} Timeout in minutes
 */
export function getTimeout(key, fallbackMinutes) {
  return getCooldown(key, fallbackMinutes);
}

/**
 * Get the current adjustment factor from config.
 * Returns 1.0 if unavailable.
 *
 * @returns {{ factor: number, lastUpdated: string|null, constrainingMetric: string|null, projectedAtReset: number|null }}
 */
export function getAdjustment() {
  const config = readConfig();
  if (!config || !config.adjustment) {
    return { factor: 1.0, lastUpdated: null, constrainingMetric: null, projectedAtReset: null };
  }
  return {
    factor: config.adjustment.factor ?? 1.0,
    lastUpdated: config.adjustment.last_updated ?? null,
    constrainingMetric: config.adjustment.constraining_metric ?? null,
    projectedAtReset: config.adjustment.projected_at_reset ?? null,
  };
}

/**
 * Get all default cooldown values.
 * @returns {Record<string, number>}
 */
export function getDefaults() {
  const config = readConfig();
  if (!config || !config.defaults) {
    return { ...DEFAULTS };
  }
  return { ...DEFAULTS, ...config.defaults };
}

/**
 * Get the config file path.
 * @returns {string}
 */
export function getConfigPath() {
  return CONFIG_PATH;
}
