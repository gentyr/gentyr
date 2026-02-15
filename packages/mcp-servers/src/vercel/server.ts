#!/usr/bin/env node
/**
 * Vercel MCP Server
 *
 * Provides tools for managing Vercel deployments, projects, domains, and environment variables.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * Required env vars:
 * - VERCEL_TOKEN: Vercel API token
 * Optional:
 * - VERCEL_TEAM_ID: Team ID for team accounts
 *
 * @version 1.0.0
 */

import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  ListDeploymentsArgsSchema,
  GetDeploymentArgsSchema,
  GetDeploymentEventsArgsSchema,
  CancelDeploymentArgsSchema,
  RedeployArgsSchema,
  ListProjectsArgsSchema,
  GetProjectArgsSchema,
  ListEnvVarsArgsSchema,
  CreateEnvVarArgsSchema,
  DeleteEnvVarArgsSchema,
  ListDomainsArgsSchema,
  AddDomainArgsSchema,
  RemoveDomainArgsSchema,
  PromoteDeploymentArgsSchema,
  RollbackArgsSchema,
  type ListDeploymentsArgs,
  type GetDeploymentArgs,
  type GetDeploymentEventsArgs,
  type CancelDeploymentArgs,
  type RedeployArgs,
  type ListProjectsArgs,
  type GetProjectArgs,
  type ListEnvVarsArgs,
  type CreateEnvVarArgs,
  type DeleteEnvVarArgs,
  type ListDomainsArgs,
  type AddDomainArgs,
  type RemoveDomainArgs,
  type PromoteDeploymentArgs,
  type RollbackArgs,
  type DeploymentSummary,
  type ProjectSummary,
  type EnvVarSummary,
  type SuccessResult,
} from './types.js';

const { VERCEL_TOKEN, VERCEL_TEAM_ID } = process.env;
const BASE_URL = 'https://api.vercel.com';

if (!VERCEL_TOKEN) {
  console.error('VERCEL_TOKEN environment variable is required');
  process.exit(1);
}

async function vercelFetch(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  const url = new URL(endpoint, BASE_URL);
  if (VERCEL_TEAM_ID) {
    url.searchParams.set('teamId', VERCEL_TEAM_ID);
  }

  const response = await fetch(url.toString(), {
    ...options,
    headers: {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const data = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const error = data.error as { message?: string } | undefined;
    throw new Error(error?.message || `HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

// ============================================================================
// Handler Functions
// ============================================================================

async function listDeployments(args: ListDeploymentsArgs): Promise<DeploymentSummary[]> {
  const params = new URLSearchParams();
  if (args.limit) { params.set('limit', args.limit.toString()); }
  if (args.projectId) { params.set('projectId', args.projectId); }
  if (args.state) { params.set('state', args.state); }

  const data = await vercelFetch(`/v6/deployments?${params}`) as { deployments: Array<{
    uid: string;
    state: string;
    url: string;
    name: string;
    created: number;
    target?: string;
    source?: string;
  }> };

  return data.deployments.map(d => ({
    id: d.uid,
    state: d.state,
    url: d.url,
    name: d.name,
    created: new Date(d.created).toISOString(),
    target: d.target,
    source: d.source,
  }));
}

async function getDeployment(args: GetDeploymentArgs): Promise<unknown> {
  return await vercelFetch(`/v13/deployments/${args.idOrUrl}`);
}

async function getDeploymentEvents(args: GetDeploymentEventsArgs): Promise<string> {
  const events = await vercelFetch(`/v2/deployments/${args.deploymentId}/events`) as Array<{
    type: string;
    payload?: { text?: string };
  }>;

  return events
    .filter(e => e.type === 'stdout' || e.type === 'stderr')
    .map(e => e.payload?.text || '')
    .join('\n');
}

async function cancelDeployment(args: CancelDeploymentArgs): Promise<unknown> {
  return await vercelFetch(`/v12/deployments/${args.deploymentId}/cancel`, {
    method: 'PATCH',
  });
}

async function redeploy(args: RedeployArgs): Promise<unknown> {
  return await vercelFetch(`/v13/deployments`, {
    method: 'POST',
    body: JSON.stringify({
      deploymentId: args.deploymentId,
      target: args.target || 'production',
    }),
  });
}

async function listProjects(args: ListProjectsArgs): Promise<ProjectSummary[]> {
  const params = new URLSearchParams();
  if (args.limit) { params.set('limit', args.limit.toString()); }

  const data = await vercelFetch(`/v9/projects?${params}`) as { projects: Array<{
    id: string;
    name: string;
    framework?: string;
    updatedAt: number;
  }> };

  return data.projects.map(p => ({
    id: p.id,
    name: p.name,
    framework: p.framework,
    updatedAt: new Date(p.updatedAt).toISOString(),
  }));
}

async function getProject(args: GetProjectArgs): Promise<unknown> {
  return await vercelFetch(`/v9/projects/${args.projectId}`);
}

async function listEnvVars(args: ListEnvVarsArgs): Promise<EnvVarSummary[]> {
  const data = await vercelFetch(`/v9/projects/${args.projectId}/env`) as { envs: Array<{
    id: string;
    key: string;
    target: string[];
    type: string;
    updatedAt?: string;
  }> };

  return data.envs.map(e => ({
    id: e.id,
    key: e.key,
    target: e.target,
    type: e.type,
    updatedAt: e.updatedAt,
  }));
}

async function createEnvVar(args: CreateEnvVarArgs): Promise<unknown> {
  return await vercelFetch(`/v10/projects/${args.projectId}/env`, {
    method: 'POST',
    body: JSON.stringify({
      key: args.key,
      value: args.value,
      target: args.target || ['production', 'preview', 'development'],
      type: args.type || 'encrypted',
    }),
  });
}

async function deleteEnvVar(args: DeleteEnvVarArgs): Promise<SuccessResult> {
  await vercelFetch(`/v9/projects/${args.projectId}/env/${args.envId}`, {
    method: 'DELETE',
  });
  return { success: true, message: `Deleted env var ${args.envId}` };
}

async function listDomains(args: ListDomainsArgs): Promise<unknown> {
  const data = await vercelFetch(`/v9/projects/${args.projectId}/domains`) as { domains: unknown[] };
  return data.domains;
}

async function addDomain(args: AddDomainArgs): Promise<unknown> {
  return await vercelFetch(`/v10/projects/${args.projectId}/domains`, {
    method: 'POST',
    body: JSON.stringify({ name: args.domain }),
  });
}

async function removeDomain(args: RemoveDomainArgs): Promise<SuccessResult> {
  await vercelFetch(`/v9/projects/${args.projectId}/domains/${args.domain}`, {
    method: 'DELETE',
  });
  return { success: true, message: `Removed domain ${args.domain}` };
}

async function promoteDeployment(args: PromoteDeploymentArgs): Promise<unknown> {
  return await vercelFetch(`/v10/projects/${args.projectId}/promote/${args.deploymentId}`, {
    method: 'POST',
  });
}

async function rollback(args: RollbackArgs): Promise<unknown> {
  return await vercelFetch(`/v9/projects/${args.projectId}/rollback/${args.deploymentId}`, {
    method: 'POST',
  });
}

// ============================================================================
// Server Setup
// ============================================================================

// Cast handlers to ToolHandler - args are validated by McpServer before calling
const tools = [
  {
    name: 'vercel_list_deployments',
    description: 'List recent deployments. Returns deployment ID, state, URL, and creation time.',
    schema: ListDeploymentsArgsSchema,
    handler: listDeployments as (args: unknown) => unknown,
  },
  {
    name: 'vercel_get_deployment',
    description: 'Get details of a specific deployment by ID or URL',
    schema: GetDeploymentArgsSchema,
    handler: getDeployment as (args: unknown) => unknown,
  },
  {
    name: 'vercel_get_deployment_events',
    description: 'Get build logs/events for a deployment',
    schema: GetDeploymentEventsArgsSchema,
    handler: getDeploymentEvents as (args: unknown) => unknown,
  },
  {
    name: 'vercel_cancel_deployment',
    description: 'Cancel a deployment that is currently building',
    schema: CancelDeploymentArgsSchema,
    handler: cancelDeployment as (args: unknown) => unknown,
  },
  {
    name: 'vercel_redeploy',
    description: 'Trigger a redeployment of an existing deployment',
    schema: RedeployArgsSchema,
    handler: redeploy as (args: unknown) => unknown,
  },
  {
    name: 'vercel_list_projects',
    description: 'List all projects in the account/team',
    schema: ListProjectsArgsSchema,
    handler: listProjects as (args: unknown) => unknown,
  },
  {
    name: 'vercel_get_project',
    description: 'Get details of a specific project',
    schema: GetProjectArgsSchema,
    handler: getProject as (args: unknown) => unknown,
  },
  {
    name: 'vercel_list_env_vars',
    description: 'List environment variables for a project',
    schema: ListEnvVarsArgsSchema,
    handler: listEnvVars as (args: unknown) => unknown,
  },
  {
    name: 'vercel_create_env_var',
    description: 'Create or update an environment variable',
    schema: CreateEnvVarArgsSchema,
    handler: createEnvVar as (args: unknown) => unknown,
  },
  {
    name: 'vercel_delete_env_var',
    description: 'Delete an environment variable',
    schema: DeleteEnvVarArgsSchema,
    handler: deleteEnvVar as (args: unknown) => unknown,
  },
  {
    name: 'vercel_list_domains',
    description: 'List domains for a project',
    schema: ListDomainsArgsSchema,
    handler: listDomains as (args: unknown) => unknown,
  },
  {
    name: 'vercel_add_domain',
    description: 'Add a domain to a project',
    schema: AddDomainArgsSchema,
    handler: addDomain as (args: unknown) => unknown,
  },
  {
    name: 'vercel_remove_domain',
    description: 'Remove a domain from a project',
    schema: RemoveDomainArgsSchema,
    handler: removeDomain as (args: unknown) => unknown,
  },
  {
    name: 'vercel_promote_deployment',
    description: 'Promote a preview deployment to production',
    schema: PromoteDeploymentArgsSchema,
    handler: promoteDeployment as (args: unknown) => unknown,
  },
  {
    name: 'vercel_rollback',
    description: 'Rollback to a previous deployment',
    schema: RollbackArgsSchema,
    handler: rollback as (args: unknown) => unknown,
  },
] satisfies AnyToolHandler[];

// Create and start server
const server = new McpServer({
  name: 'vercel-mcp',
  version: '1.0.0',
  tools,
});

server.start();
