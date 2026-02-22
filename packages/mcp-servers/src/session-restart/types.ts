/**
 * Types for the Session Restart MCP Server
 */

import { z } from 'zod';

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const SessionRestartArgsSchema = z.object({
  confirm: z.boolean()
    .describe('Safety guard: must be true to proceed with restart'),
  session_id: z.string()
    .uuid()
    .optional()
    .describe('Override auto-discovered session ID (UUID format)'),
});

// ============================================================================
// Type Definitions
// ============================================================================

export type SessionRestartArgs = z.infer<typeof SessionRestartArgsSchema>;

export interface SessionRestartResult {
  /** True when the restart script has been spawned. The restart itself is asynchronous. */
  initiated: boolean;
  session_id: string;
  project_dir: string;
  claude_pid: number;
  method: 'applescript_terminal' | 'applescript_iterm' | 'manual';
  message: string;
  resume_command: string;
}
