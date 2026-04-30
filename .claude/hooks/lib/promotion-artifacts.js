/**
 * Promotion Artifacts — shared module for preview→staging promotion artifact collection.
 *
 * Manages promotion directories, manifests, reports, and promotion history
 * for the preview-to-staging promotion pipeline.
 *
 * @module lib/promotion-artifacts
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ============================================================================
// Logging
// ============================================================================

function log(message) {
  const timestamp = new Date().toISOString();
  try {
    const logPath = path.join(PROJECT_DIR, '.claude', 'session-queue.log');
    fs.appendFileSync(logPath, `[${timestamp}] [promotion-artifacts] ${message}\n`);
  } catch (_) {
    // Non-fatal — log file not writable
  }
}

// ============================================================================
// Template Resolution
// ============================================================================

/**
 * Resolve the promotion report template path.
 *
 * Searches in order:
 *   1. node_modules/gentyr/templates/promotion-report-template.md
 *   2. .claude-framework/templates/promotion-report-template.md
 *   3. ./templates/promotion-report-template.md
 *
 * @param {string} [projectDir]
 * @returns {string|null} Absolute path to the template, or null if not found.
 */
function resolveTemplatePath(projectDir = PROJECT_DIR) {
  const candidates = [
    path.join(projectDir, 'node_modules', 'gentyr', 'templates', 'promotion-report-template.md'),
    path.join(projectDir, '.claude-framework', 'templates', 'promotion-report-template.md'),
    path.join(projectDir, 'templates', 'promotion-report-template.md'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ============================================================================
// Promotion Directory Management
// ============================================================================

/**
 * Create the promotion artifact directory.
 *
 * @param {string} promotionId - Unique promotion identifier.
 * @param {string} [projectDir] - Project root directory.
 * @returns {string} Absolute path to the created directory.
 * @throws {Error} If directory creation fails.
 */
export function createPromotionDir(promotionId, projectDir = PROJECT_DIR) {
  if (!promotionId || typeof promotionId !== 'string') {
    throw new Error('promotion-artifacts: promotionId is required and must be a non-empty string');
  }

  const promotionDir = path.join(projectDir, '.claude', 'promotions', promotionId);
  fs.mkdirSync(promotionDir, { recursive: true });
  log(`Created promotion directory: ${promotionDir}`);
  return promotionDir;
}

// ============================================================================
// Manifest
// ============================================================================

/**
 * Write a promotion manifest to the promotion directory.
 *
 * @param {string} promotionId - Unique promotion identifier.
 * @param {object} data - Manifest data object.
 * @param {string} data.id - Promotion ID.
 * @param {string} data.preview_sha - Preview branch SHA at promotion time.
 * @param {string} data.staging_sha_before - Staging SHA before merge.
 * @param {string} data.staging_sha_after - Staging SHA after merge.
 * @param {number|null} data.pr_number - PR number used for promotion.
 * @param {string|null} data.pr_url - PR URL.
 * @param {number} data.commit_count - Number of commits promoted.
 * @param {Array<{sha: string, message: string, author: string}>} data.commits - Commit details.
 * @param {string} data.quality_verdict - 'passed' | 'failed' | 'skipped'.
 * @param {string} data.test_verdict - 'passed' | 'failed' | 'skipped'.
 * @param {string} data.demo_verdict - 'passed' | 'failed' | 'skipped'.
 * @param {string} data.deploy_status - 'verified' | 'unhealthy' | 'skipped'.
 * @param {string|null} data.agent_session_id - Session ID of the promoting agent.
 * @param {string} data.created_at - ISO timestamp when promotion started.
 * @param {string|null} data.completed_at - ISO timestamp when promotion completed.
 * @param {number|null} data.duration_seconds - Total promotion duration in seconds.
 * @param {object} [data.deploy_artifact] - Deployment artifact details from deploy-verifier.
 * @param {string} [data.deploy_artifact.platform] - Deployment platform ('vercel' | 'render').
 * @param {string} [data.deploy_artifact.deploy_id] - Platform-specific deployment ID.
 * @param {string} [data.deploy_artifact.deploy_url] - Deployment URL (if available).
 * @param {string} [data.deploy_artifact.commit_sha] - Commit SHA the deployment was built from.
 * @param {string} [data.deploy_artifact.status] - Deployment status ('READY', 'live', etc).
 * @param {string} [data.deploy_artifact.deploy_ready_at] - ISO timestamp when deployment became ready.
 * @param {number} [data.deploy_artifact.build_duration_seconds] - Build duration (if available).
 * @param {object} [data.post_deploy_verification] - Post-deploy smoke test results.
 * @param {boolean} [data.post_deploy_verification.verified] - Whether the smoke test passed.
 * @param {object} [data.post_deploy_verification.smokeTest] - Smoke test details (url, healthy, statusCode, responseTimeMs).
 * @param {string} [projectDir] - Project root directory.
 * @returns {string} Absolute path to the written manifest file.
 * @throws {Error} If promotionId or data is invalid, or write fails.
 */
export function writeManifest(promotionId, data, projectDir = PROJECT_DIR) {
  if (!promotionId || typeof promotionId !== 'string') {
    throw new Error('promotion-artifacts: promotionId is required and must be a non-empty string');
  }
  if (!data || typeof data !== 'object') {
    throw new Error('promotion-artifacts: data is required and must be an object');
  }

  const promotionDir = path.join(projectDir, '.claude', 'promotions', promotionId);
  if (!fs.existsSync(promotionDir)) {
    fs.mkdirSync(promotionDir, { recursive: true });
  }

  const manifestPath = path.join(promotionDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(data, null, 2), 'utf8');
  log(`Wrote manifest: ${manifestPath}`);
  return manifestPath;
}

// ============================================================================
// Report Generation
// ============================================================================

/**
 * Generate a promotion report from the template.
 *
 * Reads the template from templates/promotion-report-template.md, fills all
 * {placeholder} values from templateData, and writes report.md to the
 * promotion directory.
 *
 * @param {string} promotionId - Unique promotion identifier.
 * @param {Record<string, string>} templateData - Key-value pairs for template placeholders.
 * @param {string} [projectDir] - Project root directory.
 * @returns {string} Absolute path to the written report file.
 * @throws {Error} If template is not found, or write fails.
 */
export function writeReport(promotionId, templateData, projectDir = PROJECT_DIR) {
  if (!promotionId || typeof promotionId !== 'string') {
    throw new Error('promotion-artifacts: promotionId is required and must be a non-empty string');
  }
  if (!templateData || typeof templateData !== 'object') {
    throw new Error('promotion-artifacts: templateData is required and must be an object');
  }

  const templatePath = resolveTemplatePath(projectDir);
  if (!templatePath) {
    throw new Error(
      'promotion-artifacts: Could not find promotion-report-template.md in any of: ' +
      'node_modules/gentyr/templates/, .claude-framework/templates/, or ./templates/'
    );
  }

  let template = fs.readFileSync(templatePath, 'utf8');

  // Replace all {placeholder} occurrences with values from templateData
  for (const [key, value] of Object.entries(templateData)) {
    const placeholder = `{${key}}`;
    // Replace all occurrences of this placeholder
    while (template.includes(placeholder)) {
      template = template.replace(placeholder, String(value));
    }
  }

  const promotionDir = path.join(projectDir, '.claude', 'promotions', promotionId);
  if (!fs.existsSync(promotionDir)) {
    fs.mkdirSync(promotionDir, { recursive: true });
  }

  const reportPath = path.join(promotionDir, 'report.md');
  fs.writeFileSync(reportPath, template, 'utf8');
  log(`Wrote report: ${reportPath}`);
  return reportPath;
}

// ============================================================================
// Promotion History
// ============================================================================

/**
 * List all promotions by scanning .claude/promotions/*/manifest.json.
 *
 * @param {string} [projectDir] - Project root directory.
 * @returns {Array<object>} Array of parsed manifest objects, sorted by created_at descending.
 */
export function listPromotions(projectDir = PROJECT_DIR) {
  const promotionsDir = path.join(projectDir, '.claude', 'promotions');

  if (!fs.existsSync(promotionsDir)) {
    return [];
  }

  const manifests = [];

  try {
    const entries = fs.readdirSync(promotionsDir);
    for (const entry of entries) {
      const manifestPath = path.join(promotionsDir, entry, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const content = fs.readFileSync(manifestPath, 'utf8');
          const parsed = JSON.parse(content);
          manifests.push(parsed);
        } catch (err) {
          log(`Failed to parse manifest at ${manifestPath}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    log(`Failed to read promotions directory: ${err.message}`);
    return [];
  }

  // Sort by created_at descending (most recent first)
  manifests.sort((a, b) => {
    const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
    const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
    return dateB - dateA;
  });

  return manifests;
}

/**
 * Get promotions whose commits overlap with a given git range.
 *
 * Uses `git log --format=%H {fromSha}..{toSha}` to enumerate commit SHAs,
 * then filters listPromotions() to those with at least one matching commit.
 *
 * @param {string} fromSha - Start of the commit range (exclusive).
 * @param {string} toSha - End of the commit range (inclusive).
 * @param {string} [projectDir] - Project root directory.
 * @returns {Array<object>} Filtered array of manifest objects.
 */
export function getPromotionsInRange(fromSha, toSha, projectDir = PROJECT_DIR) {
  if (!fromSha || !toSha) {
    throw new Error('promotion-artifacts: fromSha and toSha are required');
  }

  let commitShas = [];
  try {
    const output = execSync(`git log --format=%H ${fromSha}..${toSha}`, {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    });
    commitShas = output.trim().split('\n').filter(Boolean);
  } catch (err) {
    log(`Failed to get commit range ${fromSha}..${toSha}: ${err.message}`);
    return [];
  }

  if (commitShas.length === 0) {
    return [];
  }

  const commitSet = new Set(commitShas);
  const allPromotions = listPromotions(projectDir);

  return allPromotions.filter((manifest) => {
    if (!Array.isArray(manifest.commits)) return false;
    return manifest.commits.some((commit) => commitSet.has(commit.sha));
  });
}

/**
 * Get the most recent promotion.
 *
 * @param {string} [projectDir] - Project root directory.
 * @returns {object|null} The most recent manifest object, or null if none exist.
 */
export function getLatestPromotion(projectDir = PROJECT_DIR) {
  const promotions = listPromotions(projectDir);
  return promotions.length > 0 ? promotions[0] : null;
}
