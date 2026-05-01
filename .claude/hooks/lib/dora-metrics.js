/**
 * DORA Metrics Collection
 *
 * Computes the four DORA metrics from existing data sources:
 * 1. Deployment Frequency — merges to main per day
 * 2. Lead Time for Changes — average PR created → merged (hours)
 * 3. Change Failure Rate — rollbacks / total deploys (%)
 * 4. Mean Time to Recovery — average alert → resolved (minutes)
 *
 * Uses DORA 2024 benchmarks for rating.
 *
 * @version 1.0.0
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * Get deployment frequency (merges to main per day).
 *
 * @param {string} projectDir - Project root directory
 * @param {number} [days=30] - Look-back period in days
 * @returns {number|null} Deploys per day (null on error)
 */
export function getDeploymentFrequency(projectDir, days = 30) {
  if (!projectDir) {
    throw new Error('getDeploymentFrequency requires projectDir');
  }

  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Count merged PRs to main in the period
    const output = execSync(
      `gh pr list --state merged --base main --search "merged:>=${since}" --limit 500 --json mergedAt`,
      { cwd: projectDir, encoding: 'utf8', timeout: 30000, stdio: 'pipe' }
    ).trim();

    if (!output) return 0;

    const prs = JSON.parse(output);
    if (!Array.isArray(prs) || prs.length === 0) return 0;

    // Count PRs merged within the date range
    const cutoff = new Date(since).getTime();
    const mergedInRange = prs.filter(pr => {
      if (!pr.mergedAt) return false;
      return new Date(pr.mergedAt).getTime() >= cutoff;
    });

    return Math.round((mergedInRange.length / days) * 100) / 100;
  } catch {
    return null;
  }
}

/**
 * Get lead time for changes (average PR created → merged in hours).
 *
 * @param {string} projectDir - Project root directory
 * @param {number} [days=30] - Look-back period in days
 * @returns {number|null} Average lead time in hours (null on error)
 */
export function getLeadTime(projectDir, days = 30) {
  if (!projectDir) {
    throw new Error('getLeadTime requires projectDir');
  }

  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const output = execSync(
      `gh pr list --state merged --base main --search "merged:>=${since}" --limit 200 --json createdAt,mergedAt`,
      { cwd: projectDir, encoding: 'utf8', timeout: 30000, stdio: 'pipe' }
    ).trim();

    if (!output) return null;

    const prs = JSON.parse(output);
    if (!Array.isArray(prs) || prs.length === 0) return null;

    let totalHours = 0;
    let count = 0;

    for (const pr of prs) {
      if (!pr.createdAt || !pr.mergedAt) continue;
      const created = new Date(pr.createdAt).getTime();
      const merged = new Date(pr.mergedAt).getTime();
      if (merged <= created) continue;

      totalHours += (merged - created) / (1000 * 60 * 60);
      count++;
    }

    if (count === 0) return null;
    return Math.round((totalHours / count) * 10) / 10;
  } catch {
    return null;
  }
}

/**
 * Get change failure rate (rollbacks / total deploys as a percentage).
 *
 * @param {string} projectDir - Project root directory
 * @param {number} [days=30] - Look-back period in days
 * @returns {number|null} Change failure rate as percentage (null on error)
 */
export function getChangeFailureRate(projectDir, days = 30) {
  if (!projectDir) {
    throw new Error('getChangeFailureRate requires projectDir');
  }

  try {
    const statePath = path.join(projectDir, '.claude', 'state', 'deploy-tracking.json');
    if (!fs.existsSync(statePath)) return 0;

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const rollbackHistory = Array.isArray(state.rollbackHistory) ? state.rollbackHistory : [];

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const rollbacksInRange = rollbackHistory.filter(r => {
      if (!r.timestamp) return false;
      return new Date(r.timestamp).getTime() >= cutoff;
    });

    // Get total deploys (PRs merged to main) for the same period
    const deployFreq = getDeploymentFrequency(projectDir, days);
    if (deployFreq === null || deployFreq === 0) {
      // Can't compute rate without total deploys
      return rollbacksInRange.length > 0 ? 100 : 0;
    }

    const totalDeploys = Math.round(deployFreq * days);
    if (totalDeploys === 0) return 0;

    const rate = (rollbacksInRange.length / totalDeploys) * 100;
    return Math.round(rate * 10) / 10;
  } catch {
    return null;
  }
}

/**
 * Get mean time to recovery (average alert resolved_at - first_detected_at in minutes).
 *
 * @param {string} projectDir - Project root directory
 * @param {number} [days=30] - Look-back period in days
 * @returns {number|null} MTTR in minutes (null on error)
 */
export function getMTTR(projectDir, days = 30) {
  if (!projectDir) {
    throw new Error('getMTTR requires projectDir');
  }

  try {
    const alertsPath = path.join(projectDir, '.claude', 'state', 'persistent_alerts.json');
    if (!fs.existsSync(alertsPath)) return null;

    const alerts = JSON.parse(fs.readFileSync(alertsPath, 'utf8'));
    if (!alerts || typeof alerts !== 'object') return null;

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    let totalMinutes = 0;
    let count = 0;

    // Iterate over all alert entries looking for resolved ones
    for (const [, alert] of Object.entries(alerts)) {
      if (!alert || !alert.resolved_at || !alert.first_detected_at) continue;

      const detected = new Date(alert.first_detected_at).getTime();
      const resolved = new Date(alert.resolved_at).getTime();

      if (detected < cutoff) continue;
      if (resolved <= detected) continue;

      totalMinutes += (resolved - detected) / (1000 * 60);
      count++;
    }

    if (count === 0) return null;
    return Math.round(totalMinutes / count);
  } catch {
    return null;
  }
}

/**
 * Rate DORA metrics according to DORA 2024 benchmarks.
 *
 * Elite: freq >= 1/day, lead < 1h, CFR < 5%, MTTR < 60min
 * High:  freq >= 1/week, lead < 24h, CFR < 10%, MTTR < 24h
 * Medium: freq >= 1/month, lead < 168h (1 week), CFR < 15%, MTTR < 48h
 * Low: everything else
 *
 * @param {number|null} freq - Deploys per day
 * @param {number|null} lead - Lead time in hours
 * @param {number|null} cfr - Change failure rate (%)
 * @param {number|null} mttr - MTTR in minutes
 * @returns {'elite'|'high'|'medium'|'low'}
 */
export function rateDORA(freq, lead, cfr, mttr) {
  // Count how many metrics fall into each tier
  const scores = { elite: 0, high: 0, medium: 0, low: 0 };
  let metricsWithData = 0;

  if (freq !== null && freq !== undefined) {
    metricsWithData++;
    if (freq >= 1) scores.elite++;
    else if (freq >= 1 / 7) scores.high++;
    else if (freq >= 1 / 30) scores.medium++;
    else scores.low++;
  }

  if (lead !== null && lead !== undefined) {
    metricsWithData++;
    if (lead < 1) scores.elite++;
    else if (lead < 24) scores.high++;
    else if (lead < 168) scores.medium++;
    else scores.low++;
  }

  if (cfr !== null && cfr !== undefined) {
    metricsWithData++;
    if (cfr < 5) scores.elite++;
    else if (cfr < 10) scores.high++;
    else if (cfr < 15) scores.medium++;
    else scores.low++;
  }

  if (mttr !== null && mttr !== undefined) {
    metricsWithData++;
    if (mttr < 60) scores.elite++;
    else if (mttr < 1440) scores.high++;  // 24h
    else if (mttr < 2880) scores.medium++; // 48h
    else scores.low++;
  }

  if (metricsWithData === 0) return 'low';

  // Overall rating: the tier with the most metrics
  // Tie-break: prefer the lower tier (conservative)
  if (scores.elite > metricsWithData / 2) return 'elite';
  if (scores.elite + scores.high > metricsWithData / 2) return 'high';
  if (scores.elite + scores.high + scores.medium > metricsWithData / 2) return 'medium';
  return 'low';
}

/**
 * Collect all four DORA metrics.
 *
 * @param {string} projectDir - Project root directory
 * @returns {{deployment_frequency: number|null, lead_time_hours: number|null, change_failure_rate: number|null, mttr_minutes: number|null, rating: string}}
 */
export function collectDoraMetrics(projectDir) {
  if (!projectDir) {
    throw new Error('collectDoraMetrics requires projectDir');
  }

  const freq = getDeploymentFrequency(projectDir, 30);
  const lead = getLeadTime(projectDir, 30);
  const cfr = getChangeFailureRate(projectDir, 30);
  const mttr = getMTTR(projectDir, 30);
  const rating = rateDORA(freq, lead, cfr, mttr);

  return {
    deployment_frequency: freq,
    lead_time_hours: lead,
    change_failure_rate: cfr,
    mttr_minutes: mttr,
    rating,
  };
}

/**
 * Format DORA metrics as a one-liner for session briefing.
 *
 * @param {{deployment_frequency: number|null, lead_time_hours: number|null, change_failure_rate: number|null, mttr_minutes: number|null, rating: string}} metrics
 * @returns {string}
 */
export function formatDoraBriefing(metrics) {
  if (!metrics) return 'DORA: unavailable';

  const parts = [];
  if (metrics.deployment_frequency != null) parts.push(`freq ${metrics.deployment_frequency}/day`);
  if (metrics.lead_time_hours != null) parts.push(`lead ${metrics.lead_time_hours}h`);
  if (metrics.change_failure_rate != null) parts.push(`CFR ${metrics.change_failure_rate}%`);
  if (metrics.mttr_minutes != null) parts.push(`MTTR ${metrics.mttr_minutes}m`);

  if (parts.length === 0) return 'DORA: no data';

  return `DORA: ${(metrics.rating || 'N/A').toUpperCase()} (${parts.join(', ')})`;
}
