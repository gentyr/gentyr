/**
 * Types for the Specs Browser MCP Server
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const SPEC_CATEGORIES = ['local', 'global', 'reference', 'framework', 'patterns'] as const;
export type SpecCategory = typeof SPEC_CATEGORIES[number];

export interface CategoryInfoItem {
  path: string;
  description: string;
  source: 'project' | 'framework';
}

export const CATEGORY_INFO: Record<SpecCategory, CategoryInfoItem> = {
  // Project specs (in $PROJECT_DIR/specs/)
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
  // Framework specs (in $PROJECT_DIR/.claude-framework/specs/)
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

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const ListSpecsArgsSchema = z.object({
  category: z.enum(SPEC_CATEGORIES).optional().describe(
    'Filter by category (optional). local=component specs, global=invariants, reference=docs'
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
