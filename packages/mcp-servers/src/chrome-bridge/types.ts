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
// MCP Tool Definition (raw JSON Schema, not Zod)
// ============================================================================

export interface ChromeToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}
