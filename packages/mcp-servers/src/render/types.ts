/**
 * Render MCP Server Types
 *
 * Type definitions for Render API interactions.
 * Based on Render API: https://api-docs.render.com/reference
 */

import { z } from 'zod';

// ============================================================================
// Service Tool Argument Schemas
// ============================================================================

export const ListServicesArgsSchema = z.object({
  limit: z.number().optional().default(20).describe('Maximum number of services to return'),
  cursor: z.string().optional().describe('Cursor for pagination'),
  name: z.string().optional().describe('Filter by service name'),
  type: z.enum([
    'web_service',
    'private_service',
    'background_worker',
    'static_site',
    'cron_job',
  ]).optional().describe('Filter by service type'),
});

export const GetServiceArgsSchema = z.object({
  serviceId: z.string().describe('The service ID'),
});

export const CreateServiceArgsSchema = z.object({
  type: z.enum(['web_service', 'private_service', 'background_worker', 'static_site', 'cron_job'])
    .describe('Service type'),
  name: z.string().describe('Service name'),
  ownerId: z.string().describe('Owner ID (user or team)'),
  repo: z.string().optional().describe('GitHub repository URL'),
  branch: z.string().optional().default('main').describe('Git branch'),
  autoDeploy: z.boolean().optional().default(true).describe('Enable auto-deploy on push'),
  rootDir: z.string().optional().describe('Root directory for the service'),
  buildCommand: z.string().optional().describe('Build command'),
  startCommand: z.string().optional().describe('Start command'),
  plan: z.enum(['starter', 'standard', 'pro', 'pro_plus', 'free'])
    .optional().default('starter').describe('Service plan'),
  region: z.enum(['oregon', 'frankfurt', 'singapore', 'ohio', 'virginia'])
    .optional().default('oregon').describe('Service region'),
  envVars: z.array(z.object({
    key: z.string(),
    value: z.string(),
  })).optional().describe('Environment variables'),
});

export const UpdateServiceArgsSchema = z.object({
  serviceId: z.string().describe('The service ID'),
  name: z.string().optional().describe('New service name'),
  branch: z.string().optional().describe('New branch'),
  autoDeploy: z.boolean().optional().describe('Enable/disable auto-deploy'),
  buildCommand: z.string().optional().describe('New build command'),
  startCommand: z.string().optional().describe('New start command'),
  plan: z.enum(['starter', 'standard', 'pro', 'pro_plus', 'free'])
    .optional().describe('New service plan'),
});

export const DeleteServiceArgsSchema = z.object({
  serviceId: z.string().describe('The service ID'),
});

export const SuspendServiceArgsSchema = z.object({
  serviceId: z.string().describe('The service ID'),
});

export const ResumeServiceArgsSchema = z.object({
  serviceId: z.string().describe('The service ID'),
});

// ============================================================================
// Deployment Tool Argument Schemas
// ============================================================================

export const ListDeploysArgsSchema = z.object({
  serviceId: z.string().describe('The service ID'),
  limit: z.number().optional().default(20).describe('Maximum number of deployments to return'),
  cursor: z.string().optional().describe('Cursor for pagination'),
});

export const GetDeployArgsSchema = z.object({
  deployId: z.string().describe('The deployment ID'),
});

export const TriggerDeployArgsSchema = z.object({
  serviceId: z.string().describe('The service ID'),
  clearCache: z.boolean().optional().default(false).describe('Clear build cache before deploying'),
});

// ============================================================================
// Environment Variable Tool Argument Schemas
// ============================================================================

export const ListEnvVarsArgsSchema = z.object({
  serviceId: z.string().describe('The service ID'),
  cursor: z.string().optional().describe('Cursor for pagination'),
});

export const CreateEnvVarArgsSchema = z.object({
  serviceId: z.string().describe('The service ID'),
  key: z.string().describe('Environment variable key'),
  value: z.string().describe('Environment variable value'),
});

export const UpdateEnvVarArgsSchema = z.object({
  serviceId: z.string().describe('The service ID'),
  envVarKey: z.string().describe('Environment variable key to update'),
  value: z.string().describe('New environment variable value'),
});

export const DeleteEnvVarArgsSchema = z.object({
  serviceId: z.string().describe('The service ID'),
  envVarKey: z.string().describe('Environment variable key to delete'),
});

// ============================================================================
// Type Exports
// ============================================================================

export type ListServicesArgs = z.infer<typeof ListServicesArgsSchema>;
export type GetServiceArgs = z.infer<typeof GetServiceArgsSchema>;
export type CreateServiceArgs = z.infer<typeof CreateServiceArgsSchema>;
export type UpdateServiceArgs = z.infer<typeof UpdateServiceArgsSchema>;
export type DeleteServiceArgs = z.infer<typeof DeleteServiceArgsSchema>;
export type SuspendServiceArgs = z.infer<typeof SuspendServiceArgsSchema>;
export type ResumeServiceArgs = z.infer<typeof ResumeServiceArgsSchema>;
export type ListDeploysArgs = z.infer<typeof ListDeploysArgsSchema>;
export type GetDeployArgs = z.infer<typeof GetDeployArgsSchema>;
export type TriggerDeployArgs = z.infer<typeof TriggerDeployArgsSchema>;
export type ListEnvVarsArgs = z.infer<typeof ListEnvVarsArgsSchema>;
export type CreateEnvVarArgs = z.infer<typeof CreateEnvVarArgsSchema>;
export type UpdateEnvVarArgs = z.infer<typeof UpdateEnvVarArgsSchema>;
export type DeleteEnvVarArgs = z.infer<typeof DeleteEnvVarArgsSchema>;

// ============================================================================
// Response Types
// ============================================================================

export interface ServiceSummary {
  id: string;
  name: string;
  type: string;
  state: string;
  repo?: string;
  branch?: string;
  autoDeploy: boolean;
  suspended: boolean;
  createdAt: string;
  updatedAt: string;
  serviceUrl?: string;
}

export interface ServiceDetails extends ServiceSummary {
  ownerId: string;
  rootDir?: string;
  buildCommand?: string;
  startCommand?: string;
  plan: string;
  region: string;
  envVars?: EnvVarSummary[];
}

export interface DeploymentSummary {
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
}

export interface DeploymentDetails extends DeploymentSummary {
  serviceId: string;
  buildCommand?: string;
  startCommand?: string;
}

export interface EnvVarSummary {
  key: string;
  value?: string;
  updatedAt: string;
}

export interface SuccessResult {
  success: true;
  message: string;
}
