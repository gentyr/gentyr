/**
 * Type definitions and Zod schemas for feedback-reporter MCP server
 *
 * This server bridges isolated feedback agents to the agent-reports pipeline.
 * Feedback agents submit findings which are stored locally and forwarded to the
 * deputy-CTO triage queue.
 *
 * @module feedback-reporter/types
 */

import { z } from 'zod';

// ============================================================================
// Finding Types
// ============================================================================

export const FINDING_SEVERITY = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITY)[number];

export const FINDING_CATEGORY = [
  'usability',        // UX issues, confusing workflows
  'functionality',    // Broken features, errors
  'performance',      // Slow loading, unresponsive UI
  'accessibility',    // Screen reader issues, contrast, keyboard nav
  'visual',           // Layout problems, rendering glitches
  'content',          // Typos, misleading text, missing info
  'security',         // Exposed data, insecure forms
  'other',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORY)[number];

// ============================================================================
// Session Summary Types
// ============================================================================

export const OVERALL_IMPRESSION = ['positive', 'neutral', 'negative', 'unusable'] as const;
export type OverallImpression = (typeof OVERALL_IMPRESSION)[number];

export const CONFIDENCE_LEVEL = ['high', 'medium', 'low'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVEL)[number];

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const SubmitFindingArgsSchema = z.object({
  title: z.string().min(1).max(200).describe('Brief title of the finding'),
  category: z.enum(FINDING_CATEGORY).describe('Type of issue found'),
  severity: z.enum(FINDING_SEVERITY).describe('How severe is this issue'),
  description: z.string().min(1).max(2000).describe('Detailed description of the issue'),
  steps_to_reproduce: z.array(z.string().max(500)).max(10).optional()
    .describe('Steps to reproduce the issue'),
  expected_behavior: z.string().max(500).optional()
    .describe('What should have happened'),
  actual_behavior: z.string().max(500).optional()
    .describe('What actually happened'),
  screenshot_ref: z.string().optional()
    .describe('Reference to a screenshot (if taken via playwright-feedback)'),
  url: z.string().optional()
    .describe('URL where the issue was found'),
});

export type SubmitFindingArgs = z.infer<typeof SubmitFindingArgsSchema>;

export const SubmitSummaryArgsSchema = z.object({
  overall_impression: z.enum(OVERALL_IMPRESSION),
  areas_tested: z.array(z.string().max(200)).max(20)
    .describe('Features/areas that were tested'),
  areas_not_tested: z.array(z.string().max(200)).max(20).optional()
    .describe('Features/areas that could not be tested (and why)'),
  confidence: z.enum(CONFIDENCE_LEVEL)
    .describe('Confidence in the test coverage'),
  summary_notes: z.string().max(2000).optional()
    .describe('Overall notes about the testing session'),
});

export type SubmitSummaryArgs = z.infer<typeof SubmitSummaryArgsSchema>;

export const ListFindingsArgsSchema = z.object({
  category: z.enum(FINDING_CATEGORY).optional(),
  severity: z.enum(FINDING_SEVERITY).optional(),
});

export type ListFindingsArgs = z.infer<typeof ListFindingsArgsSchema>;

// ============================================================================
// Database Record Types
// ============================================================================

export interface FindingRecord {
  id: string;
  title: string;
  category: FindingCategory;
  severity: FindingSeverity;
  description: string;
  steps_to_reproduce: string; // JSON array
  expected_behavior: string | null;
  actual_behavior: string | null;
  screenshot_ref: string | null;
  url: string | null;
  report_id: string | null;
  created_at: string;
}

export interface SessionSummaryRecord {
  id: string;
  overall_impression: OverallImpression;
  areas_tested: string; // JSON array
  areas_not_tested: string; // JSON array
  confidence: ConfidenceLevel;
  summary_notes: string | null;
  created_at: string;
}

// ============================================================================
// Result Types
// ============================================================================

export interface FindingResult {
  id: string;
  title: string;
  category: FindingCategory;
  severity: FindingSeverity;
  description: string;
  steps_to_reproduce?: string[];
  expected_behavior?: string;
  actual_behavior?: string;
  screenshot_ref?: string;
  url?: string;
  report_id?: string;
  created_at: string;
}

export interface SubmitFindingResult {
  id: string;
  report_id: string;
  message: string;
}

export interface SummaryResult {
  id: string;
  overall_impression: OverallImpression;
  areas_tested: string[];
  areas_not_tested?: string[];
  confidence: ConfidenceLevel;
  summary_notes?: string;
  created_at: string;
}

export interface SubmitSummaryResult {
  id: string;
  report_id: string;
  message: string;
}

export interface ListFindingsResult {
  findings: FindingResult[];
  total: number;
}

export interface ErrorResult {
  error: string;
}
