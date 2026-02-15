/**
 * Vercel MCP Server Types
 *
 * Type definitions for Vercel API interactions.
 */

import { z } from 'zod';

// Tool argument schemas
export const ListDeploymentsArgsSchema = z.object({
  limit: z.number().optional().default(10),
  projectId: z.string().optional(),
  state: z.enum(['BUILDING', 'ERROR', 'INITIALIZING', 'QUEUED', 'READY', 'CANCELED']).optional(),
});

export const GetDeploymentArgsSchema = z.object({
  idOrUrl: z.string(),
});

export const GetDeploymentEventsArgsSchema = z.object({
  deploymentId: z.string(),
});

export const CancelDeploymentArgsSchema = z.object({
  deploymentId: z.string(),
});

export const RedeployArgsSchema = z.object({
  deploymentId: z.string(),
  target: z.enum(['production', 'preview']).optional(),
});

export const ListProjectsArgsSchema = z.object({
  limit: z.number().optional().default(20),
});

export const GetProjectArgsSchema = z.object({
  projectId: z.string(),
});

export const ListEnvVarsArgsSchema = z.object({
  projectId: z.string(),
});

export const CreateEnvVarArgsSchema = z.object({
  projectId: z.string(),
  key: z.string(),
  value: z.string(),
  target: z.array(z.enum(['production', 'preview', 'development'])).optional().default(['production', 'preview', 'development']),
  type: z.enum(['plain', 'secret', 'encrypted']).optional().default('encrypted'),
});

export const DeleteEnvVarArgsSchema = z.object({
  projectId: z.string(),
  envId: z.string(),
});

export const ListDomainsArgsSchema = z.object({
  projectId: z.string(),
});

export const AddDomainArgsSchema = z.object({
  projectId: z.string(),
  domain: z.string(),
});

export const RemoveDomainArgsSchema = z.object({
  projectId: z.string(),
  domain: z.string(),
});

export const PromoteDeploymentArgsSchema = z.object({
  deploymentId: z.string(),
  projectId: z.string(),
});

export const RollbackArgsSchema = z.object({
  projectId: z.string(),
  deploymentId: z.string(),
});

// Type exports
export type ListDeploymentsArgs = z.infer<typeof ListDeploymentsArgsSchema>;
export type GetDeploymentArgs = z.infer<typeof GetDeploymentArgsSchema>;
export type GetDeploymentEventsArgs = z.infer<typeof GetDeploymentEventsArgsSchema>;
export type CancelDeploymentArgs = z.infer<typeof CancelDeploymentArgsSchema>;
export type RedeployArgs = z.infer<typeof RedeployArgsSchema>;
export type ListProjectsArgs = z.infer<typeof ListProjectsArgsSchema>;
export type GetProjectArgs = z.infer<typeof GetProjectArgsSchema>;
export type ListEnvVarsArgs = z.infer<typeof ListEnvVarsArgsSchema>;
export type CreateEnvVarArgs = z.infer<typeof CreateEnvVarArgsSchema>;
export type DeleteEnvVarArgs = z.infer<typeof DeleteEnvVarArgsSchema>;
export type ListDomainsArgs = z.infer<typeof ListDomainsArgsSchema>;
export type AddDomainArgs = z.infer<typeof AddDomainArgsSchema>;
export type RemoveDomainArgs = z.infer<typeof RemoveDomainArgsSchema>;
export type PromoteDeploymentArgs = z.infer<typeof PromoteDeploymentArgsSchema>;
export type RollbackArgs = z.infer<typeof RollbackArgsSchema>;

// Response types
export interface DeploymentSummary {
  id: string;
  state: string;
  url: string;
  name: string;
  created: string;
  target?: string;
  source?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  framework?: string;
  updatedAt: string;
}

export interface EnvVarSummary {
  id: string;
  key: string;
  target: string[];
  type: string;
  updatedAt?: string;
}

export interface SuccessResult {
  success: true;
  message: string;
}
