/**
 * Deployments Data Reader
 *
 * Fetches deployment status from Render and Vercel APIs, plus pipeline
 * promotion state from local automation files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { resolveCredential, fetchWithTimeout } from './credentials.js';

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const AUTOMATION_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'hourly-automation-state.json');

// ============================================================================
// Types
// ============================================================================

export type DeployEnvironment = 'preview' | 'staging' | 'production';

export interface DeploymentEntry {
  service: string;
  platform: 'render' | 'vercel';
  status: string;
  deployedAt: string;
  commitMessage?: string;
  commitSha?: string;
  url?: string;
  environment: DeployEnvironment;
}

export interface DeploymentsData {
  hasData: boolean;
  render: {
    services: Array<{ name: string; status: string; type: string; suspended: boolean; url?: string }>;
    recentDeploys: DeploymentEntry[];
  };
  vercel: {
    projects: Array<{ name: string; framework?: string }>;
    recentDeploys: DeploymentEntry[];
  };
  pipeline: {
    previewStatus: string | null;
    stagingStatus: string | null;
    lastPromotionAt: string | null;
    lastPreviewCheck: string | null;
    lastStagingCheck: string | null;
    localDevCount: number;
    stagingFreezeActive: boolean;
  };
  combined: DeploymentEntry[];
  byEnvironment: {
    preview: DeploymentEntry[];
    staging: DeploymentEntry[];
    production: DeploymentEntry[];
  };
  stats: {
    totalDeploys24h: number;
    successCount24h: number;
    failedCount24h: number;
  };
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeRenderStatus(status: string): string {
  // Render deploy statuses: live, build_in_progress, update_in_progress, deactivated, canceled, build_failed, update_failed
  if (status === 'live') return 'live';
  if (status.includes('in_progress')) return 'building';
  if (status.includes('failed')) return 'failed';
  if (status === 'deactivated' || status === 'canceled') return 'failed';
  return status;
}

function normalizeVercelStatus(state: string): string {
  // Vercel states: READY, ERROR, BUILDING, QUEUED, CANCELED, INITIALIZING
  if (state === 'READY') return 'ready';
  if (state === 'ERROR' || state === 'CANCELED') return 'failed';
  if (state === 'BUILDING' || state === 'QUEUED' || state === 'INITIALIZING') return 'building';
  return state.toLowerCase();
}

function inferEnvironment(serviceName: string, target?: string): DeployEnvironment {
  if (target === 'production') return 'production';
  if (target === 'preview' || target === 'development') return 'preview';
  const lower = serviceName.toLowerCase();
  if (lower.includes('staging') || lower.includes('stg')) return 'staging';
  if (lower.includes('preview') || lower.includes('dev')) return 'preview';
  return 'production';
}

function truncateMessage(msg: string | undefined | null, maxLen = 60): string | undefined {
  if (!msg) return undefined;
  const line = msg.split('\n')[0].trim();
  if (line.length <= maxLen) return line;
  return line.slice(0, maxLen - 1) + '\u2026';
}

// ============================================================================
// Render API
// ============================================================================

interface RenderService {
  service: { id: string; name: string; type: string; suspended: string; serviceDetails?: { url?: string } };
}

interface RenderDeploy {
  deploy: {
    id: string;
    status: string;
    createdAt: string;
    commit?: { message?: string; id?: string };
  };
}

async function fetchRenderData(apiKey: string): Promise<{
  services: DeploymentsData['render']['services'];
  deploys: DeploymentEntry[];
}> {
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  // Fetch services
  const servicesResp = await fetchWithTimeout(
    'https://api.render.com/v1/services?limit=20',
    { headers },
  );
  if (!servicesResp.ok) return { services: [], deploys: [] };

  const rawServices = await servicesResp.json() as RenderService[];
  const services = rawServices.map(s => ({
    name: s.service.name,
    status: s.service.suspended === 'suspended' ? 'suspended' : 'active',
    type: s.service.type,
    suspended: s.service.suspended === 'suspended',
    url: s.service.serviceDetails?.url,
  }));

  // Fetch recent deploys per service (top 3 each, parallel)
  const deployPromises = rawServices.slice(0, 5).map(async (s) => {
    try {
      const resp = await fetchWithTimeout(
        `https://api.render.com/v1/services/${s.service.id}/deploys?limit=3`,
        { headers },
      );
      if (!resp.ok) return [];
      const deploys = await resp.json() as RenderDeploy[];
      return deploys.map(d => ({
        service: s.service.name,
        platform: 'render' as const,
        status: normalizeRenderStatus(d.deploy.status),
        deployedAt: d.deploy.createdAt,
        commitMessage: truncateMessage(d.deploy.commit?.message),
        commitSha: d.deploy.commit?.id?.slice(0, 7),
        url: s.service.serviceDetails?.url,
        environment: inferEnvironment(s.service.name),
      }));
    } catch {
      return [];
    }
  });

  const deployResults = await Promise.allSettled(deployPromises);
  const deploys: DeploymentEntry[] = [];
  for (const r of deployResults) {
    if (r.status === 'fulfilled') {
      deploys.push(...r.value);
    }
  }

  return { services, deploys };
}

// ============================================================================
// Vercel API
// ============================================================================

interface VercelProject {
  id: string;
  name: string;
  framework?: string;
}

interface VercelDeployment {
  uid: string;
  name: string;
  state: string;
  created: number;
  target?: string;
  meta?: { githubCommitMessage?: string; githubCommitSha?: string };
  url?: string;
}

async function fetchVercelData(token: string): Promise<{
  projects: DeploymentsData['vercel']['projects'];
  deploys: DeploymentEntry[];
}> {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  // Fetch projects
  const [projectsResult, deploysResult] = await Promise.allSettled([
    fetchWithTimeout('https://api.vercel.com/v9/projects?limit=20', { headers }),
    fetchWithTimeout('https://api.vercel.com/v6/deployments?limit=10', { headers }),
  ]);

  let projects: VercelProject[] = [];
  if (projectsResult.status === 'fulfilled' && projectsResult.value.ok) {
    const data = await projectsResult.value.json() as { projects?: VercelProject[] };
    projects = data.projects || [];
  }

  let deploys: DeploymentEntry[] = [];
  if (deploysResult.status === 'fulfilled' && deploysResult.value.ok) {
    const data = await deploysResult.value.json() as { deployments?: VercelDeployment[] };
    deploys = (data.deployments || []).map(d => ({
      service: d.name,
      platform: 'vercel' as const,
      status: normalizeVercelStatus(d.state),
      deployedAt: new Date(d.created).toISOString(),
      commitMessage: truncateMessage(d.meta?.githubCommitMessage),
      commitSha: d.meta?.githubCommitSha?.slice(0, 7),
      url: d.url ? `https://${d.url}` : undefined,
      environment: inferEnvironment(d.name, d.target),
    }));
  }

  return {
    projects: projects.map(p => ({ name: p.name, framework: p.framework })),
    deploys,
  };
}

// ============================================================================
// Pipeline State
// ============================================================================

interface AutomationState {
  lastPreviewPromotionCheck?: string;
  lastStagingPromotionCheck?: string;
  lastPromotionAt?: string;
  stagingFreezeActive?: boolean;
}

function countLocalDevWorktrees(): number {
  try {
    const output = execSync('git worktree list --porcelain', {
      encoding: 'utf8',
      timeout: 5000,
      cwd: PROJECT_DIR,
      stdio: 'pipe',
    });
    let count = 0;
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ') && line.includes('.claude/worktrees/')) {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function readPipelineState(): DeploymentsData['pipeline'] {
  const fallback: DeploymentsData['pipeline'] = {
    previewStatus: null,
    stagingStatus: null,
    lastPromotionAt: null,
    lastPreviewCheck: null,
    lastStagingCheck: null,
    localDevCount: 0,
    stagingFreezeActive: false,
  };

  const localDevCount = countLocalDevWorktrees();

  try {
    if (!fs.existsSync(AUTOMATION_STATE_PATH)) {
      return { ...fallback, localDevCount };
    }
    const state = JSON.parse(fs.readFileSync(AUTOMATION_STATE_PATH, 'utf8')) as AutomationState;
    return {
      previewStatus: state.lastPreviewPromotionCheck ? 'checked' : null,
      stagingStatus: state.lastStagingPromotionCheck ? 'checked' : null,
      lastPromotionAt: state.lastPromotionAt || null,
      lastPreviewCheck: state.lastPreviewPromotionCheck || null,
      lastStagingCheck: state.lastStagingPromotionCheck || null,
      localDevCount,
      stagingFreezeActive: state.stagingFreezeActive === true,
    };
  } catch {
    return { ...fallback, localDevCount };
  }
}

// ============================================================================
// Main
// ============================================================================

export async function getDeploymentsData(): Promise<DeploymentsData> {
  const result: DeploymentsData = {
    hasData: false,
    render: { services: [], recentDeploys: [] },
    vercel: { projects: [], recentDeploys: [] },
    pipeline: readPipelineState(),
    combined: [],
    byEnvironment: { preview: [], staging: [], production: [] },
    stats: { totalDeploys24h: 0, successCount24h: 0, failedCount24h: 0 },
  };

  const renderKey = resolveCredential('RENDER_API_KEY');
  const vercelToken = resolveCredential('VERCEL_TOKEN');

  if (!renderKey && !vercelToken) return result;

  const [renderResult, vercelResult] = await Promise.allSettled([
    renderKey ? fetchRenderData(renderKey) : Promise.resolve(null),
    vercelToken ? fetchVercelData(vercelToken) : Promise.resolve(null),
  ]);

  if (renderResult.status === 'fulfilled' && renderResult.value) {
    result.render.services = renderResult.value.services;
    result.render.recentDeploys = renderResult.value.deploys;
    result.hasData = true;
  }

  if (vercelResult.status === 'fulfilled' && vercelResult.value) {
    result.vercel.projects = vercelResult.value.projects;
    result.vercel.recentDeploys = vercelResult.value.deploys;
    result.hasData = true;
  }

  // Combine and sort all deploys (newest first, limit 8)
  result.combined = [
    ...result.render.recentDeploys,
    ...result.vercel.recentDeploys,
  ]
    .sort((a, b) => new Date(b.deployedAt).getTime() - new Date(a.deployedAt).getTime())
    .slice(0, 8);

  // Group deploys by environment (newest first, limit 5 each)
  const allDeploysSorted = [
    ...result.render.recentDeploys,
    ...result.vercel.recentDeploys,
  ].sort((a, b) => new Date(b.deployedAt).getTime() - new Date(a.deployedAt).getTime());

  result.byEnvironment = {
    preview: allDeploysSorted.filter(d => d.environment === 'preview').slice(0, 5),
    staging: allDeploysSorted.filter(d => d.environment === 'staging').slice(0, 5),
    production: allDeploysSorted.filter(d => d.environment === 'production').slice(0, 5),
  };

  // Compute 24h deploy stats
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  const allDeploys = [...result.render.recentDeploys, ...result.vercel.recentDeploys];
  const deploys24h = allDeploys.filter(d => new Date(d.deployedAt).getTime() > cutoff24h);
  const successStatuses = new Set(['live', 'ready', 'active']);
  const failedStatuses = new Set(['failed', 'error']);
  result.stats = {
    totalDeploys24h: deploys24h.length,
    successCount24h: deploys24h.filter(d => successStatuses.has(d.status)).length,
    failedCount24h: deploys24h.filter(d => failedStatuses.has(d.status)).length,
  };

  return result;
}
