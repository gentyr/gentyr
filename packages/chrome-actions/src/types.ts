/**
 * Chrome Actions -- Protocol Types
 *
 * All types needed for communicating with the Claude Chrome Extension
 * via its Unix domain socket bridge. Independent of packages/mcp-servers.
 */

// ============================================================================
// Socket Protocol Types
// ============================================================================

export interface ChromeRequest {
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

export interface ChromeSuccessResponse {
  result: {
    content: McpContent[] | McpContent | string;
  };
}

export interface ChromeErrorResponse {
  error: {
    content: McpContent[] | McpContent | string;
  };
}

export type ChromeResponse = ChromeSuccessResponse | ChromeErrorResponse;

// ============================================================================
// High-Level Result Types
// ============================================================================

export interface ToolResult {
  content: McpContent[];
  isError?: boolean;
}

export interface TabInfo {
  tabId: number;
  url?: string;
  title?: string;
}

// ============================================================================
// ComputerAction Union
// ============================================================================

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export type GifAction = 'start_recording' | 'stop_recording' | 'export' | 'clear';

export interface LeftClickAction {
  action: 'left_click';
  coordinate?: [number, number];
  ref?: string;
  modifiers?: string;
  tabId: number;
}

export interface RightClickAction {
  action: 'right_click';
  coordinate: [number, number];
  modifiers?: string;
  tabId: number;
}

export interface DoubleClickAction {
  action: 'double_click';
  coordinate: [number, number];
  modifiers?: string;
  tabId: number;
}

export interface TripleClickAction {
  action: 'triple_click';
  coordinate: [number, number];
  modifiers?: string;
  tabId: number;
}

export interface HoverAction {
  action: 'hover';
  coordinate?: [number, number];
  ref?: string;
  tabId: number;
}

export interface TypeAction {
  action: 'type';
  text: string;
  tabId: number;
}

export interface KeyAction {
  action: 'key';
  text: string;
  repeat?: number;
  modifiers?: string;
  tabId: number;
}

export interface ScreenshotAction {
  action: 'screenshot';
  tabId: number;
}

export interface WaitAction {
  action: 'wait';
  duration: number;
  tabId: number;
}

export interface ScrollAction {
  action: 'scroll';
  coordinate: [number, number];
  scroll_direction: ScrollDirection;
  scroll_amount?: number;
  tabId: number;
}

export interface LeftClickDragAction {
  action: 'left_click_drag';
  start_coordinate: [number, number];
  coordinate: [number, number];
  tabId: number;
}

export interface ZoomAction {
  action: 'zoom';
  region: [number, number, number, number];
  tabId: number;
}

export interface ScrollToAction {
  action: 'scroll_to';
  ref: string;
  tabId: number;
}

export type ComputerAction =
  | LeftClickAction
  | RightClickAction
  | DoubleClickAction
  | TripleClickAction
  | HoverAction
  | TypeAction
  | KeyAction
  | ScreenshotAction
  | WaitAction
  | ScrollAction
  | LeftClickDragAction
  | ZoomAction
  | ScrollToAction;

// ============================================================================
// Per-Tool Argument Interfaces
// ============================================================================

export interface TabsContextArgs {
  createIfEmpty?: boolean;
}

export interface NavigateArgs {
  url: string;
  tabId: number;
}

export interface ReadPageArgs {
  tabId: number;
  filter?: 'interactive' | 'all';
  depth?: number;
  ref_id?: string;
  max_chars?: number;
}

export interface GetPageTextArgs {
  tabId: number;
}

export interface FindArgs {
  query: string;
  tabId: number;
}

export interface FormInputArgs {
  ref: string;
  value: string | boolean | number;
  tabId: number;
}

export interface JavascriptToolArgs {
  action: 'javascript_exec';
  text: string;
  tabId: number;
}

export interface ReadConsoleMessagesArgs {
  tabId: number;
  onlyErrors?: boolean;
  clear?: boolean;
  pattern?: string;
  limit?: number;
}

export interface ReadNetworkRequestsArgs {
  tabId: number;
  urlPattern?: string;
  clear?: boolean;
  limit?: number;
}

export interface ResizeWindowArgs {
  width: number;
  height: number;
  tabId: number;
}

export interface GifExportOptions {
  showClickIndicators?: boolean;
  showDragPaths?: boolean;
  showActionLabels?: boolean;
  showProgressBar?: boolean;
  showWatermark?: boolean;
  quality?: number;
}

export interface GifCreatorArgs {
  action: GifAction;
  tabId: number;
  download?: boolean;
  filename?: string;
  options?: GifExportOptions;
}

export interface UploadImageArgs {
  imageId: string;
  tabId: number;
  ref?: string;
  coordinate?: [number, number];
  filename?: string;
}

export interface ShortcutsListArgs {
  tabId: number;
}

export interface ShortcutsExecuteArgs {
  tabId: number;
  shortcutId?: string;
  command?: string;
}

export interface UpdatePlanArgs {
  domains: string[];
  approach: string[];
}

// ============================================================================
// Client Options
// ============================================================================

export interface ChromeSocketClientOptions {
  /** Client identifier sent in every request (default: 'gentyr-chrome-actions') */
  clientId?: string;
  /** Timeout for regular tool calls in ms (default: 120000) */
  toolTimeoutMs?: number;
  /** Timeout for tabs_context_mcp calls in ms (default: 2000) */
  tabsContextTimeoutMs?: number;
  /** Maximum reconnect attempts per socket (default: 100) */
  maxReconnectAttempts?: number;
  /** Base reconnect delay in ms (default: 100) */
  baseReconnectDelayMs?: number;
  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelayMs?: number;
}

export interface ChromeActionsOptions extends ChromeSocketClientOptions {
  /** If false, you must call connect() manually before using any method (default: true) */
  autoConnect?: boolean;
}
