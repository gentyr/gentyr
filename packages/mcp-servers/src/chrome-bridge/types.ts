/**
 * Chrome Bridge MCP Server -- Protocol Types
 *
 * Types for communicating with the Claude Chrome Extension
 * via its Unix domain socket bridge.
 */

// ============================================================================
// Socket Protocol Types
// ============================================================================

export interface ChromeBridgeRequest {
  method: 'execute_tool';
  params: {
    client_id: string;
    tool: string;
    args: Record<string, unknown>;
  };
}

export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  source?: { type: string; media_type?: string; data?: string };
}

export interface ChromeBridgeSuccessResponse {
  result: {
    content: McpContent[];
  };
}

export interface ChromeBridgeErrorResponse {
  error: {
    content: McpContent[];
  };
}

export type ChromeBridgeResponse =
  | ChromeBridgeSuccessResponse
  | ChromeBridgeErrorResponse;

// ============================================================================
// MCP Tool Definition (extends shared type with optional title)
// ============================================================================

import type { McpToolDefinition } from '../shared/types.js';

export type ChromeToolDefinition = McpToolDefinition & { title?: string };
