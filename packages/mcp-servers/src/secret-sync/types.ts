/**
 * Secret Sync MCP Server Types
 *
 * Type definitions for orchestrating secret syncing from 1Password to Render and Vercel.
 * Secret values never pass through the agent's context window.
 */

import { z } from 'zod';

// ============================================================================
// Tool Argument Schemas
// ============================================================================

export const SyncSecretsArgsSchema = z.object({
  target: z.enum(['render-production', 'render-staging', 'vercel', 'all'])
    .describe('Target platform to sync secrets to'),
});

export const ListMappingsArgsSchema = z.object({
  target: z.enum(['render-production', 'render-staging', 'vercel', 'all'])
    .optional()
    .describe('Target platform to list mappings for (default: all)'),
});

export const VerifySecretsArgsSchema = z.object({
  target: z.enum(['render-production', 'render-staging', 'vercel', 'all'])
    .describe('Target platform to verify secrets on'),
});

// ============================================================================
// Type Exports
// ============================================================================

export type SyncSecretsArgs = z.infer<typeof SyncSecretsArgsSchema>;
export type ListMappingsArgs = z.infer<typeof ListMappingsArgsSchema>;
export type VerifySecretsArgs = z.infer<typeof VerifySecretsArgsSchema>;

// ============================================================================
// Services Config Schema
// ============================================================================

export const ServicesConfigSchema = z.object({
  render: z.object({
    production: z.object({
      serviceId: z.string(),
    }).optional(),
    staging: z.object({
      serviceId: z.string(),
    }).optional(),
  }).optional(),
  vercel: z.object({
    projectId: z.string(),
  }).optional(),
  secrets: z.object({
    renderProduction: z.record(z.string(), z.string()).optional(),
    renderStaging: z.record(z.string(), z.string()).optional(),
    vercel: z.record(z.string(), z.object({
      ref: z.string(),
      target: z.array(z.string()),
      type: z.string(),
    })).optional(),
    manual: z.array(z.object({
      service: z.string(),
      key: z.string(),
      notes: z.string(),
    })).optional(),
  }),
});

export type ServicesConfig = z.infer<typeof ServicesConfigSchema>;

// ============================================================================
// Response Types
// ============================================================================

export interface SyncedSecret {
  key: string;
  service: string;
  status: 'created' | 'updated' | 'error';
  error?: string;
}

export interface SyncResult {
  synced: SyncedSecret[];
  errors: Array<{
    key: string;
    service: string;
    error: string;
  }>;
  manual: Array<{
    service: string;
    key: string;
    notes: string;
  }>;
}

export interface SecretMapping {
  key: string;
  reference: string;
  service: string;
}

export interface MappingResult {
  mappings: SecretMapping[];
  manual: Array<{
    service: string;
    key: string;
    notes: string;
  }>;
}

export interface VerifiedSecret {
  key: string;
  service: string;
  exists: boolean;
  error?: string;
}

export interface VerifyResult {
  verified: VerifiedSecret[];
  errors: Array<{
    service: string;
    error: string;
  }>;
}
