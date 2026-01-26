/**
 * Types for the Specs Browser MCP Server
 *
 * Supports project-configurable categories via .claude/specs-config.json
 */

import { z } from 'zod';

// ============================================================================
// Constants - Framework Categories (always available)
// ============================================================================

export const FRAMEWORK_CATEGORIES = ['framework', 'patterns'] as const;
export type FrameworkCategory = typeof FRAMEWORK_CATEGORIES[number];

export const DEFAULT_PROJECT_CATEGORIES = ['local', 'global', 'reference'] as const;
export type DefaultProjectCategory = typeof DEFAULT_PROJECT_CATEGORIES[number];

// Combined for backward compatibility
export const SPEC_CATEGORIES = [...DEFAULT_PROJECT_CATEGORIES, ...FRAMEWORK_CATEGORIES] as const;
export type SpecCategory = typeof SPEC_CATEGORIES[number];

// ============================================================================
// Category Info Types
// ============================================================================

export interface CategoryInfoItem {
  path: string;
  description: string;
  source: 'project' | 'framework';
  prefix?: string;  // Optional prefix for spec IDs (e.g., "INT-" for integrations)
}

// Framework categories (hardcoded, always available)
export const FRAMEWORK_CATEGORY_INFO: Record<FrameworkCategory, CategoryInfoItem> = {
  framework: {
    path: 'framework',
    description: 'Framework core invariants (F001-F005) that apply to all framework code',
    source: 'framework',
  },
  patterns: {
    path: 'patterns',
    description: 'Framework implementation patterns (MCP-SERVER, HOOK, AGENT patterns)',
    source: 'framework',
  },
};

// Default project categories (can be extended by projects)
export const DEFAULT_PROJECT_CATEGORY_INFO: Record<DefaultProjectCategory, CategoryInfoItem> = {
  local: {
    path: 'local',
    description: 'Component specifications (ACTION-EXECUTOR, PAGE-OBSERVER, SESSION-INTERCEPTOR, API-INTEGRATOR, OPPORTUNITY-TESTER, INTEGRATION-STRUCTURE, GUIDE-FLOW, DASHBOARD-COMPOSER, FLOW-AUTOMATOR)',
    source: 'project',
  },
  global: {
    path: 'global',
    description: 'System-wide invariants and rules (G001-G020) that apply to ALL code',
    source: 'project',
  },
  reference: {
    path: 'reference',
    description: 'Reference documentation (TESTING, INTEGRATION-RESEARCH, MCP-PATTERNS, OFFLINE-WORK)',
    source: 'project',
  },
};

// Combined CATEGORY_INFO for backward compatibility (will be overridden at runtime)
export const CATEGORY_INFO: Record<SpecCategory, CategoryInfoItem> = {
  ...DEFAULT_PROJECT_CATEGORY_INFO,
  ...FRAMEWORK_CATEGORY_INFO,
};

// ============================================================================
// Project Configuration Schema
// ============================================================================

/**
 * Schema for project-specific category configuration
 * Projects can add custom categories via .claude/specs-config.json
 */
export const ProjectCategorySchema = z.object({
  path: z.string().describe('Subdirectory name under specs/'),
  description: z.string().describe('Human-readable description for list_specs'),
  prefix: z.string().optional().describe('Optional prefix for spec IDs (e.g., "INT-")'),
});

export const SpecsConfigSchema = z.object({
  categories: z.record(z.string(), ProjectCategorySchema),
});

export type ProjectCategoryConfig = z.infer<typeof ProjectCategorySchema>;
export type SpecsConfig = z.infer<typeof SpecsConfigSchema>;

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

/**
 * ListSpecsArgsSchema - accepts any string for category
 * Validation happens at runtime against loaded categories (framework + project + custom)
 */
export const ListSpecsArgsSchema = z.object({
  category: z.string().optional().describe(
    'Filter by category (optional). Use list_specs without category to see all available categories.'
  ),
});

export const GetSpecArgsSchema = z.object({
  spec_id: z.string().describe('Spec identifier (e.g., "G001", "THOR", "TESTING")'),
});

// ============================================================================
// Type Definitions
// ============================================================================

export type ListSpecsArgs = z.infer<typeof ListSpecsArgsSchema>;
export type GetSpecArgs = z.infer<typeof GetSpecArgsSchema>;

export interface SpecMetadata {
  title: string;
  ruleId: string | null;
  severity: string | null;
  category: string | null;
  lastUpdated: string | null;
}

export interface SpecListItem {
  spec_id: string;
  title: string;
  severity: string | null;
  rule_id: string | null;
  file: string;
}

export interface CategorySpecs {
  description: string;
  specs: SpecListItem[];
}

export interface ListSpecsResult {
  categories: Record<string, CategorySpecs>;
  total: number;
}

export interface GetSpecResult {
  spec_id: string;
  category: string;
  file: string;
  title: string;
  severity: string | null;
  rule_id: string | null;
  last_updated: string | null;
  content: string;
}

export interface GetSpecErrorResult {
  error: string;
  hint: string;
}

// ============================================================================
// Spec Management Schemas
// ============================================================================

export const CreateSpecSchema = z.object({
  spec_id: z.string().min(1).describe('Spec ID (e.g., "G021", "INT-FRONTEND-AUTH")'),
  category: z.string().describe('Category: local, global, reference, or custom'),
  suite: z.string().optional().describe('Suite ID if creating a subspec (optional)'),
  title: z.string().min(1).describe('Spec title'),
  content: z.string().describe('Full markdown content'),
});

export const EditSpecSchema = z.object({
  spec_id: z.string().min(1).describe('Spec ID to edit'),
  content: z.string().optional().describe('New full content (replaces entire file)'),
  title: z.string().optional().describe('Update title only'),
  append: z.string().optional().describe('Append to existing content'),
});

export const DeleteSpecSchema = z.object({
  spec_id: z.string().min(1).describe('Spec ID to delete'),
  confirm: z.boolean().describe('Must be true to confirm deletion'),
});

// ============================================================================
// Suite Management Schemas
// ============================================================================

export const CreateSuiteSchema = z.object({
  suite_id: z.string().min(1).regex(/^[a-z0-9-]+$/).describe('Suite ID (e.g., "frontend-connector")'),
  description: z.string().min(1).describe('Human-readable description'),
  scope: z.string().min(1).describe('Glob pattern (e.g., "integrations/*/frontend-connector/**")'),
  mapped_specs_dir: z.string().optional().describe('Dir for mapped specs'),
  mapped_specs_pattern: z.string().optional().describe('Pattern (e.g., "INT-FRONTEND-*.md")'),
  exploratory_specs_dir: z.string().optional().describe('Dir for exploratory specs'),
  exploratory_specs_pattern: z.string().optional().describe('Pattern for exploratory specs'),
});

export const GetSuiteSchema = z.object({
  suite_id: z.string().min(1).describe('Suite ID to get'),
});

export const ListSuitesSchema = z.object({});

export const EditSuiteSchema = z.object({
  suite_id: z.string().min(1).describe('Suite ID to edit'),
  description: z.string().optional().describe('New description'),
  scope: z.string().optional().describe('New scope pattern'),
  mapped_specs_dir: z.string().optional().describe('Dir for mapped specs'),
  mapped_specs_pattern: z.string().optional().describe('Pattern for mapped specs'),
  exploratory_specs_dir: z.string().optional().describe('Dir for exploratory specs'),
  exploratory_specs_pattern: z.string().optional().describe('Pattern for exploratory specs'),
  enabled: z.boolean().optional().describe('Enable or disable the suite'),
});

export const DeleteSuiteSchema = z.object({
  suite_id: z.string().min(1).describe('Suite ID to delete'),
  confirm: z.boolean().describe('Must be true to confirm deletion'),
});

// ============================================================================
// Spec Management Types
// ============================================================================

export type CreateSpecArgs = z.infer<typeof CreateSpecSchema>;
export type EditSpecArgs = z.infer<typeof EditSpecSchema>;
export type DeleteSpecArgs = z.infer<typeof DeleteSpecSchema>;

export interface CreateSpecResult {
  success: boolean;
  file: string;
}

export interface EditSpecResult {
  success: boolean;
  file: string;
}

export interface DeleteSpecResult {
  success: boolean;
  deleted: string;
}

// ============================================================================
// Suite Management Types
// ============================================================================

export type CreateSuiteArgs = z.infer<typeof CreateSuiteSchema>;
export type GetSuiteArgs = z.infer<typeof GetSuiteSchema>;
export type EditSuiteArgs = z.infer<typeof EditSuiteSchema>;
export type DeleteSuiteArgs = z.infer<typeof DeleteSuiteSchema>;

export interface SuiteConfig {
  description: string;
  scope: string;
  mappedSpecs: {
    dir: string;
    pattern: string;
  } | null;
  exploratorySpecs: {
    dir: string;
    pattern: string;
  } | null;
  enabled: boolean;
}

export interface SuitesConfig {
  version: number;
  suites: Record<string, SuiteConfig>;
}

export interface CreateSuiteResult {
  success: boolean;
  suite_id: string;
}

export interface GetSuiteResult {
  suite_id: string;
  description: string;
  scope: string;
  mappedSpecs: {
    dir: string;
    pattern: string;
  } | null;
  exploratorySpecs: {
    dir: string;
    pattern: string;
  } | null;
  enabled: boolean;
}

export interface ListSuitesResult {
  suites: Array<{
    id: string;
    description: string;
    scope: string;
    enabled: boolean;
  }>;
}

export interface EditSuiteResult {
  success: boolean;
  suite_id: string;
}

export interface DeleteSuiteResult {
  success: boolean;
  deleted: string;
}

// ============================================================================
// Utility Schemas
// ============================================================================

export const GetSpecsForFileSchema = z.object({
  file_path: z.string().min(1).describe('File path (relative or absolute) to check for applicable specs'),
});

export type GetSpecsForFileArgs = z.infer<typeof GetSpecsForFileSchema>;

export interface SpecForFile {
  spec_id: string;
  file: string;
  priority?: string;
  lastVerified?: string | null;
}

export interface SubspecForFile {
  spec_id: string;
  file: string;
  suite_id: string;
  suite_scope: string;
  priority?: string;
}

export interface GetSpecsForFileResult {
  file_path: string;
  specs: SpecForFile[];
  subspecs: SubspecForFile[];
  total: number;
}
