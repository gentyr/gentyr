#!/usr/bin/env node
/**
 * Render MCP Server
 *
 * Provides tools for managing Render services, deployments, and environment variables.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * Required env vars:
 * - RENDER_API_KEY: Render API key (from https://dashboard.render.com/account/api-keys)
 *
 * @version 1.0.0
 */

import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  ListServicesArgsSchema,
  GetServiceArgsSchema,
  CreateServiceArgsSchema,
  UpdateServiceArgsSchema,
  DeleteServiceArgsSchema,
  SuspendServiceArgsSchema,
  ResumeServiceArgsSchema,
  ListDeploysArgsSchema,
  GetDeployArgsSchema,
  TriggerDeployArgsSchema,
  ListEnvVarsArgsSchema,
  CreateEnvVarArgsSchema,
  UpdateEnvVarArgsSchema,
  DeleteEnvVarArgsSchema,
  type ListServicesArgs,
  type GetServiceArgs,
  type CreateServiceArgs,
  type UpdateServiceArgs,
  type DeleteServiceArgs,
  type SuspendServiceArgs,
  type ResumeServiceArgs,
  type ListDeploysArgs,
  type GetDeployArgs,
  type TriggerDeployArgs,
  type ListEnvVarsArgs,
  type CreateEnvVarArgs,
  type UpdateEnvVarArgs,
  type DeleteEnvVarArgs,
  type ServiceSummary,
  type ServiceDetails,
  type DeploymentSummary,
  type DeploymentDetails,
  type EnvVarSummary,
  type SuccessResult,
} from './types.js';

const { RENDER_API_KEY } = process.env;
const BASE_URL = 'https://api.render.com/v1';

// G001: Fail-closed on missing API key
if (!RENDER_API_KEY) {
  console.error('RENDER_API_KEY environment variable is required');
  process.exit(1);
}

/**
 * Generic fetch wrapper for Render API calls
 * Handles authentication, error handling, and response parsing
 */
async function renderFetch(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  const url = `${BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${RENDER_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  // G001: Fail-closed on non-OK responses
  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorData = await response.json() as { message?: string; errors?: unknown[] };
      if (errorData.message) {
        errorMessage = errorData.message;
      } else if (errorData.errors && Array.isArray(errorData.errors)) {
        errorMessage = `HTTP ${response.status}: ${JSON.stringify(errorData.errors)}`;
      }
    } catch {
      // If parsing error response fails, use status code
      errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    }
    throw new Error(errorMessage);
  }

  // Handle 204 No Content responses
  if (response.status === 204) {
    return null;
  }

  const data = await response.json() as Record<string, unknown>;
  return data;
}

// ============================================================================
// Render API Response Types
// ============================================================================

/**
 * Actual Render API response shape for a service.
 * Key differences from what was previously assumed:
 * - autoDeploy is a top-level field (not in serviceDetails)
 * - branch is a top-level field
 * - rootDir is a top-level field
 * - buildCommand/startCommand are nested under serviceDetails.envSpecificDetails
 */
interface RenderServiceResponse {
  id: string;
  name: string;
  type: string;
  ownerId: string;
  autoDeploy: string;
  branch?: string;
  repo?: string;
  rootDir?: string;
  serviceDetails: {
    url?: string;
    env?: string;
    envSpecificDetails?: {
      buildCommand?: string;
      startCommand?: string;
    };
    plan?: string;
    region?: string;
  };
  suspended?: string;
  state?: string;
  createdAt: string;
  updatedAt: string;
}

function mapServiceResponse(data: RenderServiceResponse): ServiceDetails {
  return {
    id: data.id,
    name: data.name,
    type: data.type,
    state: data.state || 'unknown',
    ownerId: data.ownerId,
    repo: data.repo,
    branch: data.branch,
    autoDeploy: data.autoDeploy === 'yes',
    suspended: data.suspended === 'suspended',
    rootDir: data.rootDir,
    buildCommand: data.serviceDetails.envSpecificDetails?.buildCommand,
    startCommand: data.serviceDetails.envSpecificDetails?.startCommand,
    plan: data.serviceDetails.plan || 'unknown',
    region: data.serviceDetails.region || 'unknown',
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    serviceUrl: data.serviceDetails.url,
  };
}

// ============================================================================
// Service Handler Functions
// ============================================================================

async function listServices(args: ListServicesArgs): Promise<ServiceSummary[]> {
  const params = new URLSearchParams();
  if (args.limit) { params.set('limit', args.limit.toString()); }
  if (args.cursor) { params.set('cursor', args.cursor); }
  if (args.name) { params.set('name', args.name); }
  if (args.type) { params.set('type', args.type); }

  // List endpoint wraps each service in a { service: {...} } object
  const data = await renderFetch(`/services?${params}`) as Array<{
    service: RenderServiceResponse;
  }>;

  return data.map(item => {
    const s = item.service;
    return {
      id: s.id,
      name: s.name,
      type: s.type,
      state: s.state || 'unknown',
      repo: s.repo,
      branch: s.branch,
      autoDeploy: s.autoDeploy === 'yes',
      suspended: s.suspended === 'suspended',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      serviceUrl: s.serviceDetails.url,
    };
  });
}

async function getService(args: GetServiceArgs): Promise<ServiceDetails> {
  const data = await renderFetch(`/services/${args.serviceId}`) as RenderServiceResponse;
  return mapServiceResponse(data);
}

async function createService(args: CreateServiceArgs): Promise<ServiceDetails> {
  const serviceDetails: Record<string, unknown> = {
    plan: args.plan,
    region: args.region,
  };

  // Build/start commands go under envSpecificDetails
  if (args.buildCommand || args.startCommand) {
    const envSpecificDetails: Record<string, unknown> = {};
    if (args.buildCommand) { envSpecificDetails.buildCommand = args.buildCommand; }
    if (args.startCommand) { envSpecificDetails.startCommand = args.startCommand; }
    serviceDetails.envSpecificDetails = envSpecificDetails;
  }

  const body: Record<string, unknown> = {
    type: args.type,
    name: args.name,
    ownerId: args.ownerId,
    autoDeploy: args.autoDeploy ? 'yes' : 'no',
    serviceDetails,
  };

  // Top-level fields (not nested in serviceDetails per Render API spec)
  if (args.repo) { body.repo = args.repo; }
  if (args.branch) { body.branch = args.branch; }
  if (args.rootDir) { body.rootDir = args.rootDir; }
  if (args.envVars) { body.envVars = args.envVars; }

  const data = await renderFetch('/services', {
    method: 'POST',
    body: JSON.stringify(body),
  }) as RenderServiceResponse;

  return mapServiceResponse(data);
}

async function updateService(args: UpdateServiceArgs): Promise<ServiceDetails> {
  const body: Record<string, unknown> = {};

  if (args.name !== undefined) { body.name = args.name; }
  if (args.branch !== undefined) { body.branch = args.branch; }
  if (args.rootDir !== undefined) { body.rootDir = args.rootDir; }
  if (args.autoDeploy !== undefined) { body.autoDeploy = args.autoDeploy ? 'yes' : 'no'; }

  // Render API nests build/start commands under serviceDetails.envSpecificDetails
  const hasServiceDetails = args.buildCommand !== undefined || args.startCommand !== undefined || args.plan !== undefined;
  if (hasServiceDetails) {
    const serviceDetails: Record<string, unknown> = {};
    if (args.plan !== undefined) {
      serviceDetails.plan = args.plan;
    }
    if (args.buildCommand !== undefined || args.startCommand !== undefined) {
      const envSpecificDetails: Record<string, unknown> = {};
      if (args.buildCommand !== undefined) {
        envSpecificDetails.buildCommand = args.buildCommand;
      }
      if (args.startCommand !== undefined) {
        envSpecificDetails.startCommand = args.startCommand;
      }
      serviceDetails.envSpecificDetails = envSpecificDetails;
    }
    body.serviceDetails = serviceDetails;
  }

  const data = await renderFetch(`/services/${args.serviceId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }) as RenderServiceResponse;

  return mapServiceResponse(data);
}

async function deleteService(args: DeleteServiceArgs): Promise<SuccessResult> {
  await renderFetch(`/services/${args.serviceId}`, {
    method: 'DELETE',
  });
  return { success: true, message: `Deleted service ${args.serviceId}` };
}

async function suspendService(args: SuspendServiceArgs): Promise<SuccessResult> {
  await renderFetch(`/services/${args.serviceId}/suspend`, {
    method: 'POST',
  });
  return { success: true, message: `Suspended service ${args.serviceId}` };
}

async function resumeService(args: ResumeServiceArgs): Promise<SuccessResult> {
  await renderFetch(`/services/${args.serviceId}/resume`, {
    method: 'POST',
  });
  return { success: true, message: `Resumed service ${args.serviceId}` };
}

// ============================================================================
// Deployment Handler Functions
// ============================================================================

async function listDeploys(args: ListDeploysArgs): Promise<DeploymentSummary[]> {
  const params = new URLSearchParams();
  if (args.limit) { params.set('limit', args.limit.toString()); }
  if (args.cursor) { params.set('cursor', args.cursor); }

  const data = await renderFetch(`/services/${args.serviceId}/deploys?${params}`) as Array<{
    deploy: {
      id: string;
      status: string;
      createdAt: string;
      updatedAt: string;
      finishedAt?: string;
      commit?: {
        id: string;
        message: string;
        createdAt: string;
      };
    };
  }>;

  return data.map(item => {
    const d = item.deploy;
    return {
      id: d.id,
      status: d.status,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      finishedAt: d.finishedAt,
      commit: d.commit,
    };
  });
}

async function getDeploy(args: GetDeployArgs): Promise<DeploymentDetails> {
  const data = await renderFetch(`/deploys/${args.deployId}`) as {
    id: string;
    serviceId: string;
    status: string;
    buildCommand?: string;
    startCommand?: string;
    createdAt: string;
    updatedAt: string;
    finishedAt?: string;
    commit?: {
      id: string;
      message: string;
      createdAt: string;
    };
  };

  return {
    id: data.id,
    serviceId: data.serviceId,
    status: data.status,
    buildCommand: data.buildCommand,
    startCommand: data.startCommand,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    finishedAt: data.finishedAt,
    commit: data.commit,
  };
}

async function triggerDeploy(args: TriggerDeployArgs): Promise<DeploymentDetails> {
  const body: Record<string, unknown> = {};
  if (args.clearCache) {
    body.clearCache = 'clear';
  }

  const data = await renderFetch(`/services/${args.serviceId}/deploys`, {
    method: 'POST',
    body: JSON.stringify(body),
  }) as {
    id: string;
    serviceId: string;
    status: string;
    buildCommand?: string;
    startCommand?: string;
    createdAt: string;
    updatedAt: string;
    finishedAt?: string;
    commit?: {
      id: string;
      message: string;
      createdAt: string;
    };
  };

  return {
    id: data.id,
    serviceId: data.serviceId,
    status: data.status,
    buildCommand: data.buildCommand,
    startCommand: data.startCommand,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    finishedAt: data.finishedAt,
    commit: data.commit,
  };
}

// ============================================================================
// Environment Variable Handler Functions
// ============================================================================

async function listEnvVars(args: ListEnvVarsArgs): Promise<EnvVarSummary[]> {
  const params = new URLSearchParams();
  if (args.cursor) { params.set('cursor', args.cursor); }

  const data = await renderFetch(`/services/${args.serviceId}/env-vars?${params}`) as Array<{
    envVar: {
      key: string;
      value?: string;
      updatedAt: string;
    };
  }>;

  return data.map(item => ({
    key: item.envVar.key,
    value: item.envVar.value,
    updatedAt: item.envVar.updatedAt,
  }));
}

async function createEnvVar(args: CreateEnvVarArgs): Promise<EnvVarSummary> {
  const body = {
    key: args.key,
    value: args.value,
  };

  const data = await renderFetch(`/services/${args.serviceId}/env-vars`, {
    method: 'POST',
    body: JSON.stringify(body),
  }) as {
    key: string;
    value?: string;
    updatedAt: string;
  };

  return {
    key: data.key,
    value: data.value,
    updatedAt: data.updatedAt,
  };
}

async function updateEnvVar(args: UpdateEnvVarArgs): Promise<EnvVarSummary> {
  const body = {
    value: args.value,
  };

  const data = await renderFetch(`/services/${args.serviceId}/env-vars/${args.envVarKey}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }) as {
    key: string;
    value?: string;
    updatedAt: string;
  };

  return {
    key: data.key,
    value: data.value,
    updatedAt: data.updatedAt,
  };
}

async function deleteEnvVar(args: DeleteEnvVarArgs): Promise<SuccessResult> {
  await renderFetch(`/services/${args.serviceId}/env-vars/${args.envVarKey}`, {
    method: 'DELETE',
  });
  return { success: true, message: `Deleted env var ${args.envVarKey}` };
}

// ============================================================================
// Server Setup
// ============================================================================

// Cast handlers to ToolHandler - args are validated by McpServer before calling
const tools = [
  // Service tools
  {
    name: 'render_list_services',
    description: 'List all services in your Render account. Returns service ID, name, type, state, and repository info.',
    schema: ListServicesArgsSchema,
    handler: listServices as (args: unknown) => unknown,
  },
  {
    name: 'render_get_service',
    description: 'Get detailed information about a specific service including configuration and settings',
    schema: GetServiceArgsSchema,
    handler: getService as (args: unknown) => unknown,
  },
  {
    name: 'render_create_service',
    description: 'Create a new Render service (web service, worker, static site, etc.)',
    schema: CreateServiceArgsSchema,
    handler: createService as (args: unknown) => unknown,
  },
  {
    name: 'render_update_service',
    description: 'Update service settings (name, branch, commands, plan, etc.)',
    schema: UpdateServiceArgsSchema,
    handler: updateService as (args: unknown) => unknown,
  },
  {
    name: 'render_delete_service',
    description: 'Delete a service permanently. This action cannot be undone.',
    schema: DeleteServiceArgsSchema,
    handler: deleteService as (args: unknown) => unknown,
  },
  {
    name: 'render_suspend_service',
    description: 'Suspend a service to stop it from running (saves costs while preserving configuration)',
    schema: SuspendServiceArgsSchema,
    handler: suspendService as (args: unknown) => unknown,
  },
  {
    name: 'render_resume_service',
    description: 'Resume a suspended service to start it running again',
    schema: ResumeServiceArgsSchema,
    handler: resumeService as (args: unknown) => unknown,
  },
  // Deployment tools
  {
    name: 'render_list_deploys',
    description: 'List deployments for a service. Returns deployment ID, status, timestamps, and commit info.',
    schema: ListDeploysArgsSchema,
    handler: listDeploys as (args: unknown) => unknown,
  },
  {
    name: 'render_get_deploy',
    description: 'Get detailed information about a specific deployment',
    schema: GetDeployArgsSchema,
    handler: getDeploy as (args: unknown) => unknown,
  },
  {
    name: 'render_trigger_deploy',
    description: 'Trigger a new deployment for a service. Optionally clear build cache.',
    schema: TriggerDeployArgsSchema,
    handler: triggerDeploy as (args: unknown) => unknown,
  },
  // Environment variable tools
  {
    name: 'render_list_env_vars',
    description: 'List all environment variables for a service',
    schema: ListEnvVarsArgsSchema,
    handler: listEnvVars as (args: unknown) => unknown,
  },
  {
    name: 'render_create_env_var',
    description: 'Create a new environment variable for a service',
    schema: CreateEnvVarArgsSchema,
    handler: createEnvVar as (args: unknown) => unknown,
  },
  {
    name: 'render_update_env_var',
    description: 'Update the value of an existing environment variable',
    schema: UpdateEnvVarArgsSchema,
    handler: updateEnvVar as (args: unknown) => unknown,
  },
  {
    name: 'render_delete_env_var',
    description: 'Delete an environment variable from a service',
    schema: DeleteEnvVarArgsSchema,
    handler: deleteEnvVar as (args: unknown) => unknown,
  },
] satisfies AnyToolHandler[];

// Create and start server
const server = new McpServer({
  name: 'render-mcp',
  version: '1.0.0',
  tools,
});

server.start();
