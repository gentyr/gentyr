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
  hourly_tasks: 55,
  triage_check: 5,
  antipattern_hunter: 360,
  schema_mapper: 1440,
  lint_checker: 30,
  todo_maintenance: 15,
  task_runner: 60,
  triage_per_item: 60,
  preview_promotion: 360,
  staging_promotion: 1200,
  staging_health_monitor: 180,
  production_health_monitor: 60,
  standalone_antipattern_hunter: 180,  // 3 hours
  standalone_compliance_checker: 60,   // 1 hour
  user_feedback: 120,                  // 2 hours
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
  } catch (err) {
    console.error(`[config-reader] Failed to read ${CONFIG_PATH}: ${err.message}`);
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
 * Get the config file path (for use by usage-optimizer when writing updates).
 * @returns {string}
 */
export function getConfigPath() {
  return CONFIG_PATH;
}
