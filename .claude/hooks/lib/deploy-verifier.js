/**
 * Deploy Verifier
 *
 * Post-deploy verification module for smoke testing and deployment artifact tracking.
 * Used by the preview-promoter agent and the deploy-event-monitor automation block.
 *
 * @version 1.0.0
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * Read environment configuration from services.json
 */
function getEnvironments(projectDir = PROJECT_DIR) {
  try {
    const configPath = path.join(projectDir, '.claude', 'config', 'services.json');
    if (!fs.existsSync(configPath)) return {};
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.environments || {};
  } catch { return {}; }
}

/**
 * Detect which deployment platform is configured
 */
function detectPlatform(projectDir = PROJECT_DIR) {
  try {
    const configPath = path.join(projectDir, '.claude', 'config', 'services.json');
    if (!fs.existsSync(configPath)) return null;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.vercel?.projectId) return 'vercel';
    if (config.render?.production?.serviceId || config.render?.staging?.serviceId) return 'render';
    return null;
  } catch { return null; }
}

/**
 * HTTP health check against a URL.
 * Returns { healthy, statusCode, responseTimeMs, error }
 */
export function runSmokeTest(baseUrl, healthEndpoint = '/api/health', timeoutMs = 10000) {
  return new Promise((resolve) => {
    const url = `${baseUrl}${healthEndpoint}`;
    const mod = url.startsWith('https') ? https : http;
    const startTime = Date.now();

    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      const responseTimeMs = Date.now() - startTime;
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const healthy = res.statusCode >= 200 && res.statusCode < 400;
        resolve({ healthy, statusCode: res.statusCode, responseTimeMs, body: body.slice(0, 500), error: null });
      });
    });

    req.on('error', (err) => {
      resolve({ healthy: false, statusCode: null, responseTimeMs: Date.now() - startTime, body: null, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ healthy: false, statusCode: null, responseTimeMs: timeoutMs, body: null, error: 'timeout' });
    });
  });
}

/**
 * Wait for a deployment to complete on the configured platform.
 * Polls the platform API via CLI tools (gh/curl) since MCP tools aren't available from hooks.
 * Returns { found, deployId, deployUrl, commitSha, status, buildDurationSeconds } or { found: false }
 */
export async function waitForDeploy(environment, opts = {}) {
  const {
    projectDir = PROJECT_DIR,
    targetSha = null,
    timeoutMs = 300000, // 5 minutes
    pollIntervalMs = 15000, // 15 seconds
  } = opts;

  const platform = detectPlatform(projectDir);
  if (!platform) {
    return { found: false, error: 'No deployment platform configured in services.json' };
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (platform === 'vercel') {
        // Query Vercel deployments via CLI
        const result = execSync(
          `npx vercel ls --json 2>/dev/null | head -c 10000`,
          { cwd: projectDir, encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
        );
        // Parse and find matching deployment
        try {
          const deployments = JSON.parse(result);
          if (Array.isArray(deployments)) {
            const match = deployments.find(d =>
              d.state === 'READY' && (!targetSha || d.meta?.githubCommitSha?.startsWith(targetSha.slice(0, 7)))
            );
            if (match) {
              return {
                found: true,
                platform: 'vercel',
                deployId: match.uid || match.id,
                deployUrl: match.url ? `https://${match.url}` : null,
                commitSha: match.meta?.githubCommitSha || null,
                status: match.state,
                buildDurationSeconds: null, // Vercel doesn't expose this easily
              };
            }
          }
        } catch { /* JSON parse failed, retry */ }
      }

      if (platform === 'render') {
        // Query Render deployments
        const config = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'config', 'services.json'), 'utf8'));
        const serviceId = config.render?.[environment]?.serviceId || config.render?.staging?.serviceId;
        if (serviceId) {
          const result = execSync(
            `curl -sf "https://api.render.com/v1/services/${serviceId}/deploys?limit=5" -H "Authorization: Bearer $RENDER_API_KEY" 2>/dev/null`,
            { cwd: projectDir, encoding: 'utf8', timeout: 15000, stdio: 'pipe', env: process.env }
          );
          try {
            const deploys = JSON.parse(result);
            if (Array.isArray(deploys)) {
              const match = deploys.find(d =>
                d.deploy?.status === 'live' && (!targetSha || d.deploy?.commit?.id?.startsWith(targetSha.slice(0, 7)))
              );
              if (match) {
                return {
                  found: true,
                  platform: 'render',
                  deployId: match.deploy?.id,
                  deployUrl: null, // Render URLs are service-based, not deploy-based
                  commitSha: match.deploy?.commit?.id || null,
                  status: match.deploy?.status,
                  buildDurationSeconds: null,
                };
              }
            }
          } catch { /* JSON parse failed, retry */ }
        }
      }
    } catch { /* command failed, retry */ }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  return { found: false, error: `Timed out waiting for ${platform} deployment after ${timeoutMs / 1000}s` };
}

/**
 * Get deployment artifact details for evidence chain.
 * Returns structured deployment info for the promotion manifest.
 */
export function getDeployArtifact(environment, deployResult) {
  if (!deployResult || !deployResult.found) {
    return { platform: null, deploy_id: null, deploy_url: null, commit_sha: null, status: 'not_found' };
  }

  return {
    platform: deployResult.platform,
    deploy_id: deployResult.deployId,
    deploy_url: deployResult.deployUrl,
    commit_sha: deployResult.commitSha,
    status: deployResult.status,
    build_started_at: null, // Could be enriched with platform-specific queries
    deploy_ready_at: new Date().toISOString(),
    build_duration_seconds: deployResult.buildDurationSeconds,
  };
}

/**
 * Run a complete post-deploy verification cycle.
 * Combines deployment polling + smoke test.
 * Returns { verified, deploy, smokeTest }
 */
export async function verifyDeployment(environment, opts = {}) {
  const { projectDir = PROJECT_DIR, targetSha = null } = opts;

  const environments = getEnvironments(projectDir);
  const envConfig = environments[environment];

  if (!envConfig || !envConfig.baseUrl) {
    return {
      verified: false,
      skipped: true,
      reason: `No baseUrl configured for '${environment}' in services.json environments`,
      deploy: null,
      smokeTest: null,
    };
  }

  // Step 1: Wait for deployment
  const deployResult = await waitForDeploy(environment, { projectDir, targetSha });
  const deployArtifact = getDeployArtifact(environment, deployResult);

  // Step 2: Run smoke test
  const healthEndpoint = envConfig.healthEndpoint || '/api/health';
  const smokeResult = await runSmokeTest(envConfig.baseUrl, healthEndpoint);

  return {
    verified: smokeResult.healthy,
    skipped: false,
    deploy: deployArtifact,
    smokeTest: {
      url: `${envConfig.baseUrl}${healthEndpoint}`,
      ...smokeResult,
    },
  };
}
