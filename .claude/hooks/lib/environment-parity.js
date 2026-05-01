/**
 * Environment Parity Checker
 *
 * Compares environment configurations between staging and production
 * to detect drift. Reports differences via persistent alerts.
 *
 * SECURITY: Never reads or exposes actual secret VALUES — only compares
 * env var NAMES and service configuration metadata.
 *
 * @version 1.0.0
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

export function getServicesConfig(projectDir = PROJECT_DIR) {
  try {
    const p = path.join(projectDir, '.claude', 'config', 'services.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  } catch { return {}; }
}

/**
 * Compare env var NAMES (not values) between two Vercel environments.
 */
export function compareVercelEnvVarNames(projectDir = PROJECT_DIR) {
  const drift = [];
  try {
    // Get staging env var names
    const stagingRaw = execSync(
      'npx vercel env ls --environment preview --json 2>/dev/null | head -c 50000',
      { cwd: projectDir, encoding: 'utf8', timeout: 20000, stdio: 'pipe' }
    );
    const prodRaw = execSync(
      'npx vercel env ls --environment production --json 2>/dev/null | head -c 50000',
      { cwd: projectDir, encoding: 'utf8', timeout: 20000, stdio: 'pipe' }
    );

    let stagingVars = [], prodVars = [];
    try { stagingVars = JSON.parse(stagingRaw).map(v => v.key); } catch { /* parse fail */ }
    try { prodVars = JSON.parse(prodRaw).map(v => v.key); } catch { /* parse fail */ }

    // Find vars in staging but not prod
    for (const key of stagingVars) {
      if (!prodVars.includes(key)) {
        drift.push({ category: 'env_vars', description: `${key} exists in staging but not production`, staging: 'present', production: 'missing' });
      }
    }
    // Find vars in prod but not staging
    for (const key of prodVars) {
      if (!stagingVars.includes(key)) {
        drift.push({ category: 'env_vars', description: `${key} exists in production but not staging`, staging: 'missing', production: 'present' });
      }
    }
  } catch { /* Vercel CLI not available or not configured */ }
  return drift;
}

/**
 * Compare Render service configurations between staging and production.
 */
export function compareRenderConfigs(projectDir = PROJECT_DIR) {
  const drift = [];
  const config = getServicesConfig(projectDir);
  const stagingId = config.render?.staging?.serviceId;
  const prodId = config.render?.production?.serviceId;

  if (!stagingId || !prodId) return drift;

  try {
    const stagingRaw = execSync(
      `curl -sf "https://api.render.com/v1/services/${stagingId}" -H "Authorization: Bearer $RENDER_API_KEY" 2>/dev/null`,
      { cwd: projectDir, encoding: 'utf8', timeout: 15000, stdio: 'pipe', env: process.env }
    );
    const prodRaw = execSync(
      `curl -sf "https://api.render.com/v1/services/${prodId}" -H "Authorization: Bearer $RENDER_API_KEY" 2>/dev/null`,
      { cwd: projectDir, encoding: 'utf8', timeout: 15000, stdio: 'pipe', env: process.env }
    );

    const staging = JSON.parse(stagingRaw);
    const prod = JSON.parse(prodRaw);

    // Compare key fields
    const fields = ['plan', 'region', 'numInstances', 'healthCheckPath'];
    for (const field of fields) {
      const sVal = staging[field] || staging.service?.[field];
      const pVal = prod[field] || prod.service?.[field];
      if (sVal !== undefined && pVal !== undefined && String(sVal) !== String(pVal)) {
        drift.push({
          category: 'service_config',
          description: `Render ${field} differs: staging=${sVal}, production=${pVal}`,
          staging: String(sVal),
          production: String(pVal),
        });
      }
    }
  } catch { /* Render API not available */ }
  return drift;
}

/**
 * Run a full environment parity check.
 * @returns {{ checked_at: string, drift: Array, parity: boolean }}
 */
export function checkEnvironmentParity(projectDir = PROJECT_DIR) {
  const drift = [
    ...compareVercelEnvVarNames(projectDir),
    ...compareRenderConfigs(projectDir),
  ];

  return {
    checked_at: new Date().toISOString(),
    drift,
    parity: drift.length === 0,
  };
}
