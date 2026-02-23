/**
 * Types for the Product Manager MCP Server
 *
 * Manages product-market-fit analysis: lifecycle, sections, entries,
 * pain-point-persona mappings, and compliance reporting.
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const ANALYSIS_STATUS = [
  'not_started', 'pending_approval', 'approved', 'in_progress', 'completed',
] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUS)[number];

export const SECTION_KEYS = [
  'market_space', 'buyer_personas', 'competitor_differentiation',
  'pricing_models', 'niche_strengths', 'user_sentiment',
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_TITLES: Record<SectionKey, string> = {
  market_space: 'Market Space & Players',
  buyer_personas: 'Buyer Personas',
  competitor_differentiation: 'Competitor Differentiation',
  pricing_models: 'Pricing Models',
  niche_strengths: 'Niche Strengths & Weaknesses',
  user_sentiment: 'User Sentiment',
};

/** Sections that use list entries (add_entry) rather than single content (write_section) */
export const LIST_SECTIONS = [2, 6] as const;

// ============================================================================
// Lifecycle Tool Schemas
// ============================================================================

export const GetAnalysisStatusArgsSchema = z.object({});

export const InitiateAnalysisArgsSchema = z.object({
  initiated_by: z.string().min(1).describe('Identity of the agent or user initiating the analysis'),
});

export const ApproveAnalysisArgsSchema = z.object({
  approved_by: z.string().min(1).describe('Identity of the approver (typically deputy-cto)'),
});

// ============================================================================
// Section Read/Write Schemas
// ============================================================================

export const ReadSectionArgsSchema = z.object({
  section: z.coerce.number().min(1).max(6).describe('Section number (1-6)'),
});

export const WriteSectionArgsSchema = z.object({
  section: z.coerce.number().min(1).max(6).describe('Section number (1-6). Must NOT be a list section (2 or 6)'),
  content: z.string().min(1).describe('Markdown content for this section'),
  populated_by: z.string().optional().describe('Agent identity'),
});

export const AddEntryArgsSchema = z.object({
  section: z.coerce.number().refine(n => n === 2 || n === 6, { message: 'Section must be 2 or 6' }).describe('Section number (must be 2 or 6)'),
  title: z.string().min(1).max(200).describe('Entry title'),
  content: z.string().min(1).describe('Entry content (markdown)'),
  metadata: z.string().optional().refine(s => { if (!s) return true; try { JSON.parse(s); return true; } catch { return false; } }, { message: 'Must be valid JSON' }).describe('JSON metadata string'),
  populated_by: z.string().optional().describe('Agent identity'),
});

export const UpdateEntryArgsSchema = z.object({
  id: z.string().describe('Entry UUID'),
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).optional(),
  metadata: z.string().optional().refine(s => { if (!s) return true; try { JSON.parse(s); return true; } catch { return false; } }, { message: 'Must be valid JSON' }).describe('JSON metadata string'),
});

export const DeleteEntryArgsSchema = z.object({
  id: z.string().describe('Entry UUID'),
});

// ============================================================================
// Compliance Tool Schemas
// ============================================================================

export const ListPainPointsArgsSchema = z.object({
  unmapped_only: z.coerce.boolean().optional().default(false)
    .describe('If true, only return pain points without a mapped persona'),
});

export const MapPainPointPersonaArgsSchema = z.object({
  pain_point_id: z.string().describe('Section 6 entry UUID'),
  persona_id: z.string().describe('Persona UUID from user-feedback.db'),
  created_by: z.string().optional().default('product-manager').describe('Agent identity'),
});

export const GetComplianceReportArgsSchema = z.object({});

// ============================================================================
// Automation Tool Schemas
// ============================================================================

export const ClearAndRespawnArgsSchema = z.object({
  initiated_by: z.string().optional().default('product-manager').describe('Agent identity'),
});

export const CompleteAnalysisArgsSchema = z.object({
  completed_by: z.string().optional().default('product-manager'),
});

export const RegenerateMdArgsSchema = z.object({});

// ============================================================================
// Type Definitions (inferred from Zod)
// ============================================================================

export type GetAnalysisStatusArgs = z.infer<typeof GetAnalysisStatusArgsSchema>;
export type InitiateAnalysisArgs = z.infer<typeof InitiateAnalysisArgsSchema>;
export type ApproveAnalysisArgs = z.infer<typeof ApproveAnalysisArgsSchema>;
export type ReadSectionArgs = z.infer<typeof ReadSectionArgsSchema>;
export type WriteSectionArgs = z.infer<typeof WriteSectionArgsSchema>;
export type AddEntryArgs = z.infer<typeof AddEntryArgsSchema>;
export type UpdateEntryArgs = z.infer<typeof UpdateEntryArgsSchema>;
export type DeleteEntryArgs = z.infer<typeof DeleteEntryArgsSchema>;
export type ListPainPointsArgs = z.infer<typeof ListPainPointsArgsSchema>;
export type MapPainPointPersonaArgs = z.infer<typeof MapPainPointPersonaArgsSchema>;
export type GetComplianceReportArgs = z.infer<typeof GetComplianceReportArgsSchema>;
export type ClearAndRespawnArgs = z.infer<typeof ClearAndRespawnArgsSchema>;
export type CompleteAnalysisArgs = z.infer<typeof CompleteAnalysisArgsSchema>;
export type RegenerateMdArgs = z.infer<typeof RegenerateMdArgsSchema>;

// ============================================================================
// Record Types (SQLite rows)
// ============================================================================

export interface AnalysisMetaRecord {
  id: string;
  status: string;
  initiated_at: string | null;
  initiated_by: string | null;
  approved_at: string | null;
  approved_by: string | null;
  last_updated_at: string | null;
  md_path: string;
}

export interface SectionRecord {
  id: string;
  section_number: number;
  section_key: string;
  title: string;
  content: string | null;
  populated_at: string | null;
  populated_by: string | null;
  updated_at: string | null;
}

export interface SectionEntryRecord {
  id: string;
  section_number: number;
  title: string;
  content: string;
  metadata: string;
  created_at: string;
  created_timestamp: number;
  updated_at: string;
}

export interface PainPointPersonaRecord {
  pain_point_id: string;
  persona_id: string;
  created_at: string;
  created_by: string;
}

// ============================================================================
// Result Types
// ============================================================================

export interface ErrorResult {
  error: string;
}

export interface AnalysisStatusResult {
  status: AnalysisStatus;
  initiated_at: string | null;
  initiated_by: string | null;
  approved_at: string | null;
  approved_by: string | null;
  last_updated_at: string | null;
  sections_populated: number;
  total_sections: 6;
  sections: Array<{
    number: number;
    key: string;
    title: string;
    populated: boolean;
    entry_count?: number;
    min_entries_required?: number;
  }>;
  compliance: {
    total_pain_points: number;
    mapped: number;
    unmapped: number;
    pct: number;
  } | null;
}

export interface InitiateResult {
  status: 'pending_approval';
  initiated_at: string;
  initiated_by: string;
}

export interface ApproveResult {
  status: 'approved';
  approved_at: string;
  approved_by: string;
}

export interface ReadSectionResult {
  previous_context: Array<{
    number: number;
    title: string;
    content: string | null;
    entries?: Array<{ title: string; content: string }>;
  }>;
  requested_section: {
    number: number;
    key: string;
    title: string;
    content: string | null;
    entries?: Array<{ id: string; title: string; content: string; metadata: string }>;
  };
}

export interface WriteSectionResult {
  section_number: number;
  title: string;
  populated_at: string;
}

export interface AddEntryResult {
  id: string;
  section_number: number;
  title: string;
  created_at: string;
}

export interface UpdateEntryResult {
  id: string;
  updated_at: string;
}

export interface DeleteEntryResult {
  deleted: true;
  id: string;
}

export interface PainPointEntry {
  id: string;
  title: string;
  content: string;
  metadata: string;
  created_at: string;
  mapped_personas: string[];
}

export interface ListPainPointsResult {
  pain_points: PainPointEntry[];
  total: number;
  unmapped_count: number;
}

export interface MapPainPointResult {
  pain_point_id: string;
  persona_id: string;
  created_at: string;
}

export interface ComplianceReportResult {
  total_pain_points: number;
  mapped: number;
  unmapped: number;
  compliance_pct: number;
  pain_points: Array<{
    id: string;
    title: string;
    mapped_personas: string[];
  }>;
}

export interface ClearAndRespawnResult {
  cleared: true;
  task_ids: string[];
  message: string;
}

export interface CompleteAnalysisResult {
  status: 'completed';
  completed_at: string;
  completed_by: string | null;
  compliance: { total_pain_points: number; mapped: number; unmapped: number; pct: number } | null;
}

export interface RegenerateMdResult {
  path: string;
  regenerated_at: string;
}
