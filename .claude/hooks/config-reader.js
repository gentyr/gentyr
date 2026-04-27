/**
 * Config Reader - Shared Cooldown Configuration
 *
 * Centralized configuration for all automation cooldowns.
 * Reads from .claude/state/automation-config.json, falls back to hardcoded defaults on error.
 *
 * Usage:
 *   import { getCooldown, getTimeout } from './config-reader.js';
 *   const cooldownMs = getCooldown('hourly_tasks', 55) * 60 * 1000;
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');

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
  persistent_stale_pause_resume: 5,    // 5 minutes
  persistent_heartbeat_stale_minutes: 5, // 5 minutes
  plan_orphan_detection: 10,             // 10 minutes
  session_hard_kill_minutes: 60,         // 60 minutes
  screenshot_cleanup: 1440,              // daily (24h)
  report_auto_resolve: 2,              // 2 minutes
  report_dedup: 30,                    // 30 minutes
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
 * Returns the value in minutes.
 *
 * Priority: effective (dynamic) > defaults (config) > fallbackMinutes (hardcoded)
 *
 * @param {string} key - The cooldown key (e.g., 'hourly_tasks', 'task_runner')
 * @param {number} [fallbackMinutes] - Hardcoded fallback if config is unavailable
 * @returns {number} Cooldown in minutes
 */
export function getCooldown(key, fallbackMinutes) {
  const hardDefault = fallbackMinutes ?? DEFAULTS[key] ?? 55;

  const config = readConfig();
  if (!config) {
    return hardDefault;
  }

  // Use effective (dynamically adjusted) value first, then defaults from config
  if (config.effective && typeof config.effective[key] === 'number') {
    return config.effective[key];
  }

  if (config.defaults && typeof config.defaults[key] === 'number') {
    return config.defaults[key];
  }

  return hardDefault;
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
