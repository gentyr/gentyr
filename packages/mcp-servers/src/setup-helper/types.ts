/**
 * Types for the Setup Helper MCP Server
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const ACTIONS = [
  'install',
  'uninstall',
  'reinstall',
  'protect',
  'unprotect',
  'status',
  'scaffold',
] as const;

export type Action = (typeof ACTIONS)[number];

export const MAKERKIT_OPTIONS = ['auto', 'force', 'skip'] as const;
export type MakerkitOption = (typeof MAKERKIT_OPTIONS)[number];

// ============================================================================
// Zod Schema (G003 Compliance)
// ============================================================================

export const GentyrSetupArgsSchema = z.object({
  action: z.enum(ACTIONS)
    .optional()
    .describe(
      'The setup action to perform. Omit to get an overview of all available actions.'
    ),
  project_path: z.string()
    .optional()
    .describe('Absolute path to the target project directory. Defaults to CLAUDE_PROJECT_DIR.'),
  protect: z.boolean()
    .optional()
    .describe('Enable file protection during install (makes critical files root-owned). Requires sudo.'),
  with_op_token: z.boolean()
    .optional()
    .describe('Include a secure 1Password token entry step. The token value is never passed through this tool.'),
  makerkit: z.enum(MAKERKIT_OPTIONS)
    .optional()
    .describe('Makerkit integration: auto (detect), force (always), skip (never).'),
  protect_mcp: z.boolean()
    .optional()
    .describe('Enable MCP server protection configuration during install.'),
});

export type GentyrSetupArgs = z.infer<typeof GentyrSetupArgsSchema>;

// ============================================================================
// Response Types
// ============================================================================

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  param_name: string;
  options: QuestionOption[];
  required: boolean;
}

export interface DetectedState {
  is_installed: boolean;
  is_protected: boolean;
  has_mcp_json: boolean;
  has_op_token: boolean;
  framework_path: string;
  project_path: string;
}

export interface OverviewAction {
  action: Action;
  description: string;
  requires_sudo: boolean;
}

export interface OverviewResponse {
  status: 'overview';
  message: string;
  detected_state: DetectedState;
  actions: OverviewAction[];
}

export interface NeedsInputResponse {
  status: 'needs_input';
  action: Action;
  description: string;
  questions: Question[];
}

export interface ReadyResponse {
  status: 'ready';
  commands: string[];
  requires_sudo: boolean;
  explanation: string;
  warnings: string[];
  next_steps: string[];
}

export interface ErrorResponse {
  status: 'error';
  error: string;
}

export type SetupResponse =
  | OverviewResponse
  | NeedsInputResponse
  | ReadyResponse
  | ErrorResponse;
