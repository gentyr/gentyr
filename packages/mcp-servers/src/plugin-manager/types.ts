/**
 * Types for the Plugin Manager MCP Server
 */

import { z } from 'zod';

// ============================================================================
// Plugin Config Schema
// ============================================================================

/**
 * Per-project plugin mapping. `projectDir` is the unique key (1:1 constraint).
 * Plugin-specific fields are stored as additional properties.
 */
export const PluginMappingSchema = z.object({
  projectDir: z.string().describe('Absolute path to the target project directory'),
}).catchall(z.unknown());

/**
 * Standard plugin configuration schema. Stored at `plugins/{name}/config.json`.
 */
export const PluginConfigSchema = z.object({
  plugin: z.string().describe('Plugin name — must match the directory name'),
  version: z.string().describe('Semantic version (e.g. "1.0.0")'),
  enabled: z.boolean().describe('Whether this plugin is active'),
  mappings: z.array(PluginMappingSchema).describe('Per-project configurations (one per projectDir)'),
});

export type PluginMapping = z.infer<typeof PluginMappingSchema>;
export type PluginConfig = z.infer<typeof PluginConfigSchema>;

// ============================================================================
// Tool Argument Schemas
// ============================================================================

export const ListPluginsArgsSchema = z.object({});

// Safe plugin name: alphanumeric, hyphens, underscores only — prevents path traversal
const PluginNameSchema = z.string()
  .regex(/^[a-zA-Z0-9_-]+$/, 'Plugin name must contain only letters, numbers, hyphens, or underscores')
  .describe('Plugin name (directory name under plugins/)');

export const GetPluginConfigArgsSchema = z.object({
  plugin: PluginNameSchema,
});

export const SetPluginConfigArgsSchema = z.object({
  plugin: PluginNameSchema,
  config: PluginConfigSchema.describe('Full plugin config to write (replaces existing)'),
});

export const AddPluginMappingArgsSchema = z.object({
  plugin: PluginNameSchema,
  mapping: PluginMappingSchema.describe('Mapping to add or update — upsert by projectDir'),
});

export const RemovePluginMappingArgsSchema = z.object({
  plugin: PluginNameSchema,
  projectDir: z.string().describe('Absolute path of the project mapping to remove'),
});

export type ListPluginsArgs = z.infer<typeof ListPluginsArgsSchema>;
export type GetPluginConfigArgs = z.infer<typeof GetPluginConfigArgsSchema>;
export type SetPluginConfigArgs = z.infer<typeof SetPluginConfigArgsSchema>;
export type AddPluginMappingArgs = z.infer<typeof AddPluginMappingArgsSchema>;
export type RemovePluginMappingArgs = z.infer<typeof RemovePluginMappingArgsSchema>;

// ============================================================================
// Result Types
// ============================================================================

export interface PluginListItem {
  name: string;
  enabled: boolean;
  mappings: number;
  hasServer: boolean;
}

export interface ListPluginsResult {
  plugins: PluginListItem[];
}

export interface ErrorResult {
  error: string;
}
