#!/usr/bin/env node
/**
 * Chrome Bridge MCP Server
 *
 * Proxies MCP tool calls to the Claude Chrome Extension via its Unix domain
 * socket at /tmp/claude-mcp-browser-bridge-{username}/*.sock.
 *
 * Protocol: Length-prefixed JSON (4-byte LE uint32 length + UTF-8 JSON payload)
 * over Unix domain socket. The Chrome extension handles all browser automation;
 * this server is a pure proxy.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  JsonRpcRequestSchema,
  McpToolCallParamsSchema,
  JSON_RPC_ERRORS,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '../shared/types.js';
import type {
  ChromeBridgeRequest,
  ChromeBridgeResponse,
  ChromeToolDefinition,
  McpContent,
} from './types.js';
import { BrowserTipTracker } from './browser-tips.js';

// ============================================================================
// Chrome Bridge Socket Client
// ============================================================================

class ChromeBridgeClient {
  private connections = new Map<string, net.Socket>();
  private reconnectAttempts = new Map<string, number>();
  private requestQueues = new Map<string, Promise<void>>();
  private tabRoutes = new Map<number, string>(); // tabId -> socketPath
  private tabUrls = new Map<number, string>(); // tabId -> last known URL
  private tipTracker = new BrowserTipTracker();
  private readonly socketDir: string;

  get socketDirPath(): string { return this.socketDir; }

  private static readonly CLIENT_ID = 'gentyr';
  private static readonly MAX_RECONNECT_ATTEMPTS = 100;
  private static readonly BASE_RECONNECT_DELAY_MS = 100;
  private static readonly MAX_RECONNECT_DELAY_MS = 30_000;
  private static readonly TOOL_TIMEOUT_MS = 120_000;
  private static readonly TABS_CONTEXT_TIMEOUT_MS = 2_000;

  constructor() {
    const username = os.userInfo().username || 'default';
    this.socketDir = path.join('/tmp', `claude-mcp-browser-bridge-${username}`);
    this.discoverAndConnect();
  }

  // --- Socket Discovery ---

  private discoverSockets(): string[] {
    try {
      if (!fs.existsSync(this.socketDir)) {
        return [];
      }
      const entries = fs.readdirSync(this.socketDir);
      const sockets: string[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.sock')) continue;
        const fullPath = path.join(this.socketDir, entry);
        if (this.validateSocketOwnership(fullPath)) {
          sockets.push(fullPath);
        }
      }
      return sockets;
    } catch {
      return [];
    }
  }

  private validateSocketOwnership(socketPath: string): boolean {
    try {
      const getuid = process.getuid;
      if (!getuid) return false; // Not available on Windows
      const stats = fs.statSync(socketPath);
      return stats.uid === getuid();
    } catch {
      return false;
    }
  }

  // --- Connection Management ---

  private discoverAndConnect(): void {
    const sockets = this.discoverSockets();
    if (sockets.length === 0) {
      log('No Chrome extension sockets found. Is Chrome running with the Claude extension?');
      return;
    }
    for (const socketPath of sockets) {
      if (!this.connections.has(socketPath)) {
        this.connect(socketPath);
      }
    }
    log(`Found ${sockets.length} socket(s) in ${this.socketDir}`);
  }

  private connect(socketPath: string): void {
    const socket = net.createConnection(socketPath);

    socket.on('connect', () => {
      this.connections.set(socketPath, socket);
      this.reconnectAttempts.set(socketPath, 0);
      log(`Connected to ${path.basename(socketPath)}`);
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code && ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOENT'].includes(err.code)) {
        // Expected errors when browser closes - handled by close event
      } else {
        log(`Socket error (${path.basename(socketPath)}): ${err.message}`);
      }
    });

    socket.on('close', () => {
      this.connections.delete(socketPath);
      this.scheduleReconnect(socketPath);
    });
  }

  private scheduleReconnect(socketPath: string): void {
    const attempts = this.reconnectAttempts.get(socketPath) ?? 0;
    if (attempts >= ChromeBridgeClient.MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts.delete(socketPath);
      // Remove stale tab routes and cached URLs
      for (const [tabId, sp] of this.tabRoutes) {
        if (sp === socketPath) {
          this.tabRoutes.delete(tabId);
          this.tabUrls.delete(tabId);
        }
      }
      return;
    }

    const delay = Math.min(
      ChromeBridgeClient.BASE_RECONNECT_DELAY_MS * Math.pow(1.5, attempts),
      ChromeBridgeClient.MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts.set(socketPath, attempts + 1);

    setTimeout(() => {
      if (!fs.existsSync(socketPath)) {
        this.reconnectAttempts.delete(socketPath);
        return;
      }
      this.connect(socketPath);
    }, delay);
  }

  // --- Binary Framing Protocol ---

  private encodeMessage(payload: object): Buffer {
    const json = JSON.stringify(payload);
    const data = Buffer.from(json, 'utf-8');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(data.length, 0);
    return Buffer.concat([header, data]);
  }

  private readResponse(
    socket: net.Socket,
    timeoutMs: number,
  ): Promise<ChromeBridgeResponse> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let expectedLength: number | null = null;

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Response timeout'));
      }, timeoutMs);

      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        processBuffer();
      };

      const processBuffer = () => {
        while (buffer.length >= 4) {
          if (expectedLength === null) {
            expectedLength = buffer.readUInt32LE(0);
          }
          if (buffer.length < 4 + expectedLength) break;

          const jsonBuf = buffer.subarray(4, 4 + expectedLength);
          buffer = buffer.subarray(4 + expectedLength);
          expectedLength = null;

          try {
            const parsed = JSON.parse(jsonBuf.toString('utf-8'));
            // Skip notifications (have method but no result/error)
            if ('method' in parsed && !('result' in parsed) && !('error' in parsed)) {
              continue;
            }
            cleanup();
            resolve(parsed);
            return;
          } catch (err) {
            cleanup();
            reject(new Error(`Failed to parse response: ${err}`));
            return;
          }
        }
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const onClose = () => {
        cleanup();
        reject(new Error('Socket closed before response'));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
      };

      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
    });
  }

  // --- Tool Execution ---

  private async executeOnSocket(
    socketPath: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ChromeBridgeResponse> {
    const socket = this.connections.get(socketPath);
    if (!socket || socket.destroyed) {
      throw new Error(`Socket not connected: ${path.basename(socketPath)}`);
    }

    const request: ChromeBridgeRequest = {
      method: 'execute_tool',
      params: {
        client_id: ChromeBridgeClient.CLIENT_ID,
        tool: toolName,
        args,
      },
    };

    const timeoutMs = toolName === 'tabs_context_mcp'
      ? ChromeBridgeClient.TABS_CONTEXT_TIMEOUT_MS
      : ChromeBridgeClient.TOOL_TIMEOUT_MS;

    socket.write(this.encodeMessage(request));
    return this.readResponse(socket, timeoutMs);
  }

  /** Serialize requests per socket to prevent response interleaving */
  private async executeOnSocketSerialized(
    socketPath: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ChromeBridgeResponse> {
    const previous = this.requestQueues.get(socketPath) ?? Promise.resolve();
    let resolveQueue: () => void;
    const current = new Promise<void>((r) => { resolveQueue = r; });
    this.requestQueues.set(socketPath, current);

    await previous;
    try {
      return await this.executeOnSocket(socketPath, toolName, args);
    } finally {
      resolveQueue!();
    }
  }

  private isContentScriptError(result: { content: McpContent[]; isError?: boolean }): boolean {
    return result.isError === true && result.content.some(
      (c) => c.type === 'text' && (
        (c.text?.includes('Cannot access contents')) ||
        (c.text?.includes('must request permission'))
      ),
    );
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: McpContent[]; isError?: boolean }> {
    // Refresh connections if none available
    if (this.connections.size === 0) {
      this.discoverAndConnect();
      // Brief wait for connection
      if (this.connections.size === 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (this.connections.size === 0) {
      const diag = await runConnectionDiagnostics(this.socketDir);
      const failures = diag.checks
        .filter((c) => !c.ok)
        .map((c) => `  - ${c.name}: ${c.detail}`)
        .join('\n');
      const fixes = diag.remediation.map((r) => `  - ${r}`).join('\n');
      return {
        content: [{
          type: 'text',
          text: `Chrome extension not connected.\n\nDiagnostics:\n${failures || '  All checks passed but no active connection.'}\n\nRemediation:\n${fixes || '  Reload the Gentyr extension in Chrome or restart Chrome.'}`,
        }],
        isError: true,
      };
    }

    // tabs_context_mcp queries all sockets and merges
    if (toolName === 'tabs_context_mcp') {
      return this.executeTabsContext(args);
    }

    // Route by tabId if available
    const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;

    // Cache URL on navigate for tip hostname matching
    if (toolName === 'navigate' && tabId !== undefined && typeof args.url === 'string') {
      const url = args.url;
      if (url !== 'forward' && url !== 'back') {
        this.tabUrls.set(tabId, url.match(/^https?:\/\//) ? url : `https://${url}`);
      }
    }

    let targetSocket: string | undefined;

    if (tabId !== undefined) {
      targetSocket = this.tabRoutes.get(tabId);
      if (targetSocket && !this.connections.has(targetSocket)) {
        this.tabRoutes.delete(tabId);
        targetSocket = undefined;
      }
    }

    if (!targetSocket) {
      targetSocket = this.connections.keys().next().value;
    }

    if (!targetSocket) {
      return {
        content: [{ type: 'text', text: 'No connected sockets available' }],
        isError: true,
      };
    }

    // Inject a tabId for tools that don't require one but need tab context
    // (e.g., update_plan, switch_browser). The extension needs a tab to anchor its UI.
    if (tabId === undefined) {
      for (const [knownTabId, socketPath] of this.tabRoutes) {
        if (socketPath === targetSocket) {
          args = { ...args, tabId: knownTabId };
          break;
        }
      }
    }

    try {
      const response = await this.executeOnSocketSerialized(targetSocket, toolName, args);
      const result = this.normalizeResponse(response);

      // Content script injection retry: if the tab was loaded before the MCP
      // tab group was created, the accessibility tree content script won't be
      // injected yet. Reload the page to trigger injection, then retry once.
      if (this.isContentScriptError(result) && tabId !== undefined) {
        const cachedUrl = this.tabUrls.get(tabId);
        if (cachedUrl) {
          const urlHost = (() => { try { return new URL(cachedUrl).hostname; } catch { return '(unknown)'; } })();
          log(`Content script missing on tab ${tabId}, reloading ${urlHost} and retrying...`);
          try {
            await this.executeOnSocketSerialized(targetSocket, 'navigate', { url: cachedUrl, tabId });
            await new Promise((r) => setTimeout(r, 2000));
            const retryResponse = await this.executeOnSocketSerialized(targetSocket, toolName, args);
            const retryResult = this.normalizeResponse(retryResponse);
            this.appendTips(retryResult, toolName, tabId);
            return retryResult;
          } catch {
            // Retry failed, fall through to return the original error
          }
        }
      }

      this.appendTips(result, toolName, tabId);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Chrome bridge error: ${message}` }],
        isError: true,
      };
    }
  }

  private async executeTabsContext(
    args: Record<string, unknown>,
  ): Promise<{ content: McpContent[]; isError?: boolean }> {
    const socketPaths = Array.from(this.connections.keys());

    if (socketPaths.length === 1) {
      try {
        const response = await this.executeOnSocketSerialized(
          socketPaths[0], 'tabs_context_mcp', args,
        );
        const result = this.normalizeResponse(response);
        this.updateTabRoutes(result.content, socketPaths[0]);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Chrome bridge error: ${message}` }],
          isError: true,
        };
      }
    }

    // Multiple sockets: query all and merge
    const results = await Promise.allSettled(
      socketPaths.map(async (sp) => {
        const response = await this.executeOnSocketSerialized(sp, 'tabs_context_mcp', args);
        return { response, socketPath: sp };
      }),
    );

    const mergedContent: McpContent[] = [];
    this.tabRoutes.clear();
    this.tabUrls.clear();

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const normalized = this.normalizeResponse(result.value.response);
        this.updateTabRoutes(normalized.content, result.value.socketPath);
        mergedContent.push(...normalized.content);
      }
    }

    if (mergedContent.length === 0) {
      return {
        content: [{ type: 'text', text: 'No tabs found across connected browsers' }],
        isError: true,
      };
    }

    return { content: mergedContent };
  }

  private updateTabRoutes(content: McpContent[], socketPath: string): void {
    for (const item of content) {
      if (item.type !== 'text' || !item.text) continue;
      try {
        const parsed = JSON.parse(item.text);
        const tabs = Array.isArray(parsed) ? parsed : parsed?.availableTabs;
        if (Array.isArray(tabs)) {
          for (const tab of tabs) {
            if (typeof tab === 'object' && tab !== null && typeof tab.tabId === 'number') {
              this.tabRoutes.set(tab.tabId, socketPath);
              if (typeof tab.url === 'string' && tab.url) {
                this.tabUrls.set(tab.tabId, tab.url);
              }
            }
          }
        }
      } catch {
        // Not JSON or no tab data - skip
      }
    }
  }

  private normalizeResponse(
    response: ChromeBridgeResponse,
  ): { content: McpContent[]; isError?: boolean } {
    if ('error' in response && response.error) {
      const rawErrorContent = response.error.content;
      const content = Array.isArray(rawErrorContent) ? rawErrorContent : rawErrorContent != null ? [rawErrorContent] : [];
      return {
        content: content.map((c) =>
          typeof c === 'object' && c !== null && 'type' in c
            ? c
            : { type: 'text', text: String(c) },
        ),
        isError: true,
      };
    }

    if ('result' in response && response.result) {
      const rawContent = response.result.content;
      const content = Array.isArray(rawContent) ? rawContent : rawContent != null ? [rawContent] : [];
      return {
        content: content.map((c) => {
          if (typeof c === 'object' && c !== null && 'type' in c) {
            // Handle image content from screenshots
            if (c.type === 'image' && typeof c.source === 'object' && c.source !== null && 'data' in c.source) {
              return {
                type: 'image',
                data: c.source.data,
                mimeType: (c.source as { media_type?: string }).media_type ?? 'image/png',
              };
            }
            return c;
          }
          return { type: 'text', text: String(c) };
        }),
      };
    }

    return { content: [{ type: 'text', text: 'Empty response from Chrome extension' }] };
  }

  private appendTips(
    result: { content: McpContent[]; isError?: boolean },
    toolName: string,
    tabId: number | undefined,
  ): void {
    if (result.isError) return;
    const tabUrl = tabId !== undefined ? this.tabUrls.get(tabId) : undefined;
    const tipText = this.tipTracker.getRelevantTips(toolName, tabUrl);
    if (tipText) result.content.push({ type: 'text', text: tipText });
  }

  destroy(): void {
    for (const socket of this.connections.values()) {
      socket.removeAllListeners();
      socket.end();
      socket.destroy();
    }
    this.connections.clear();
    this.tabRoutes.clear();
    this.tabUrls.clear();
    this.requestQueues.clear();
    this.reconnectAttempts.clear();
  }
}

// ============================================================================
// Tool Definitions (exact schemas from Chrome extension)
// ============================================================================

const CHROME_TOOLS: ChromeToolDefinition[] = [
  {
    name: 'tabs_context_mcp',
    title: 'Tabs Context',
    description: 'Get context information about the current MCP tab group. Returns all tab IDs inside the group if it exists. CRITICAL: You must get the context at least once before using other browser automation tools so you know what tabs exist. Each new conversation should create its own new tab (using tabs_create_mcp) rather than reusing existing tabs, unless the user explicitly asks to use an existing tab.',
    inputSchema: {
      type: 'object',
      properties: {
        createIfEmpty: {
          type: 'boolean',
          description: 'Creates a new MCP tab group if none exists, creates a new Window with a new tab group containing an empty tab (which can be used for this conversation). If a MCP tab group already exists, this parameter has no effect.',
        },
      },
    },
  },
  {
    name: 'tabs_create_mcp',
    title: 'Tabs Create',
    description: 'Creates a new empty tab in the MCP tab group. CRITICAL: You must get the context using tabs_context_mcp at least once before using other browser automation tools so you know what tabs exist.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'navigate',
    description: 'Navigate to a URL, or go forward/back in browser history. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to navigate. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
        },
      },
      required: ['url', 'tabId'],
    },
  },
  {
    name: 'read_page',
    description: 'Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters by default. If the output exceeds this limit, you will receive an error asking you to specify a smaller depth or focus on a specific element using ref_id. Optionally filter for only interactive elements. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['interactive', 'all'],
          description: 'Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: all elements)',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to read from. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
        },
        depth: {
          type: 'number',
          description: 'Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large.',
        },
        ref_id: {
          type: 'string',
          description: 'Reference ID of a parent element to read. Will return the specified element and all its children. Use this to focus on a specific part of the page when output is too large.',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs.',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_page_text',
    description: 'Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab ID to extract text from. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'form_input',
    description: 'Set values in form elements using element reference ID from the read_page tool. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")',
        },
        value: {
          type: ['string', 'boolean', 'number'],
          description: 'The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to set form value in. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
        },
      },
      required: ['ref', 'value', 'tabId'],
    },
  },
  {
    name: 'computer',
    description: 'Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.\n* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don\'t click boxes on their edges unless asked.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'left_click', 'right_click', 'type', 'screenshot', 'wait',
            'scroll', 'key', 'left_click_drag', 'double_click',
            'triple_click', 'zoom', 'scroll_to', 'hover',
          ],
          description: 'The action to perform:\n* `left_click`: Click the left mouse button at the specified coordinates.\n* `right_click`: Click the right mouse button at the specified coordinates to open context menus.\n* `double_click`: Double-click the left mouse button at the specified coordinates.\n* `triple_click`: Triple-click the left mouse button at the specified coordinates.\n* `type`: Type a string of text.\n* `screenshot`: Take a screenshot of the screen.\n* `wait`: Wait for a specified number of seconds.\n* `scroll`: Scroll up, down, left, or right at the specified coordinates.\n* `key`: Press a specific keyboard key.\n* `left_click_drag`: Drag from start_coordinate to coordinate.\n* `zoom`: Take a screenshot of a specific region for closer inspection.\n* `scroll_to`: Scroll an element into view using its element reference ID from read_page or find tools.\n* `hover`: Move the mouse cursor to the specified coordinates or element without clicking.',
        },
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          description: '(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for left_click, right_click, double_click, triple_click, and scroll. For left_click_drag, this is the end position.',
        },
        text: {
          type: 'string',
          description: 'The text to type (for type action) or the key(s) to press (for key action). For key action: Provide space-separated keys (e.g., "Backspace Backspace Delete"). Supports keyboard shortcuts using the platform\'s modifier key (use "cmd" on Mac, "ctrl" on Windows/Linux, e.g., "cmd+a" or "ctrl+a" for select all).',
        },
        duration: {
          type: 'number',
          description: 'The number of seconds to wait. Required for wait. Maximum 30 seconds.',
        },
        scroll_direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'The direction to scroll. Required for scroll.',
        },
        scroll_amount: {
          type: 'number',
          description: 'The number of scroll wheel ticks. Optional for scroll, defaults to 3.',
        },
        start_coordinate: {
          type: 'array',
          items: { type: 'number' },
          description: '(x, y): The starting coordinates for left_click_drag.',
        },
        region: {
          type: 'array',
          items: { type: 'number' },
          description: '(x0, y0, x1, y1): The rectangular region to capture for zoom. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for zoom action.',
        },
        repeat: {
          type: 'number',
          description: 'Number of times to repeat the key sequence. Only applicable for key action. Must be between 1 and 100. Default is 1.',
        },
        ref: {
          type: 'string',
          description: 'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Required for scroll_to action. Can be used as alternative to coordinate for click actions.',
        },
        modifiers: {
          type: 'string',
          description: 'Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"), "win" (or "windows"). Can be combined with "+" (e.g., "ctrl+shift", "cmd+alt"). Optional.',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to execute the action on. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
        },
      },
      required: ['action', 'tabId'],
    },
  },
  {
    name: 'javascript_tool',
    description: 'Execute JavaScript code in the context of the current page. The code runs in the page\'s context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: "Must be set to 'javascript_exec'",
        },
        text: {
          type: 'string',
          description: 'The JavaScript code to execute. The code will be evaluated in the page context. The result of the last expression will be returned automatically. Do NOT use \'return\' statements - just write the expression you want to evaluate (e.g., \'window.myData.value\' not \'return window.myData.value\'). You can access and modify the DOM, call page functions, and interact with page variables.',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to execute the code in. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
        },
      },
      required: ['action', 'text', 'tabId'],
    },
  },
  {
    name: 'read_console_messages',
    description: 'Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab. Useful for debugging JavaScript errors, viewing application logs, or understanding what\'s happening in the browser console. Returns console messages from the current domain only. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs. IMPORTANT: Always provide a pattern to filter messages - without a pattern, you may get too many irrelevant messages.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab ID to read console messages from. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
        },
        onlyErrors: {
          type: 'boolean',
          description: 'If true, only return error and exception messages. Default is false.',
        },
        clear: {
          type: 'boolean',
          description: 'If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false.',
        },
        pattern: {
          type: 'string',
          description: 'Regex pattern to filter console messages. Only messages matching this pattern will be returned (e.g., \'error|warning\' to find errors and warnings, \'MyApp\' to filter app-specific logs). You should always provide a pattern to avoid getting too many irrelevant messages.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return. Defaults to 100. Increase only if you need more results.',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'read_network_requests',
    description: 'Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API calls, monitoring network activity, or understanding what requests a page is making. Returns all network requests made by the current page, including cross-origin requests. Requests are automatically cleared when the page navigates to a different domain. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab ID to read network requests from. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
        },
        urlPattern: {
          type: 'string',
          description: 'Optional URL pattern to filter requests. Only requests whose URL contains this string will be returned (e.g., \'/api/\' to filter API calls, \'example.com\' to filter by domain).',
        },
        clear: {
          type: 'boolean',
          description: 'If true, clear the network requests after reading to avoid duplicates on subsequent calls. Default is false.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of requests to return. Defaults to 100. Increase only if you need more results.',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'resize_window',
    description: 'Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting up specific screen sizes. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        width: {
          type: 'number',
          description: 'Target window width in pixels',
        },
        height: {
          type: 'number',
          description: 'Target window height in pixels',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to get the window for. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
        },
      },
      required: ['width', 'height', 'tabId'],
    },
  },
  {
    name: 'gif_creator',
    description: 'Manage GIF recording and export for browser automation sessions. Control when to start/stop recording browser actions (clicks, scrolls, navigation), then export as an animated GIF with visual overlays (click indicators, action labels, progress bar, watermark). All operations are scoped to the tab\'s group. When starting recording, take a screenshot immediately after to capture the initial state as the first frame. When stopping recording, take a screenshot immediately before to capture the final state as the last frame. For export, set download to true to download the GIF.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start_recording', 'stop_recording', 'export', 'clear'],
          description: "Action to perform: 'start_recording' (begin capturing), 'stop_recording' (stop capturing but keep frames), 'export' (generate and export GIF), 'clear' (discard frames)",
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to identify which tab group this operation applies to',
        },
        download: {
          type: 'boolean',
          description: "Always set this to true for the 'export' action only. This causes the gif to be downloaded in the browser.",
        },
        filename: {
          type: 'string',
          description: "Optional filename for exported GIF (default: 'recording-[timestamp].gif'). For 'export' action only.",
        },
        options: {
          type: 'object',
          description: "Optional GIF enhancement options for 'export' action.",
          properties: {
            showClickIndicators: { type: 'boolean', description: 'Show orange circles at click locations (default: true)' },
            showDragPaths: { type: 'boolean', description: 'Show red arrows for drag actions (default: true)' },
            showActionLabels: { type: 'boolean', description: 'Show black labels describing actions (default: true)' },
            showProgressBar: { type: 'boolean', description: 'Show orange progress bar at bottom (default: true)' },
            showWatermark: { type: 'boolean', description: 'Show Claude logo watermark (default: true)' },
            quality: { type: 'number', description: 'GIF compression quality, 1-30 (lower = better quality, slower encoding). Default: 10' },
          },
        },
      },
      required: ['action', 'tabId'],
    },
  },
  {
    name: 'upload_image',
    description: 'Upload a previously captured screenshot or user-uploaded image to a file input or drag & drop target. Supports two approaches: (1) ref - for targeting specific elements, especially hidden file inputs, (2) coordinate - for drag & drop to visible locations like Google Docs. Provide either ref or coordinate, not both.',
    inputSchema: {
      type: 'object',
      properties: {
        imageId: {
          type: 'string',
          description: "ID of a previously captured screenshot (from the computer tool's screenshot action) or a user-uploaded image",
        },
        ref: {
          type: 'string',
          description: 'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Use this for file inputs (especially hidden ones) or specific elements. Provide either ref or coordinate, not both.',
        },
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          description: 'Viewport coordinates [x, y] for drag & drop to a visible location. Use this for drag & drop targets like Google Docs. Provide either ref or coordinate, not both.',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID where the target element is located. This is where the image will be uploaded to.',
        },
        filename: {
          type: 'string',
          description: 'Optional filename for the uploaded file (default: "image.png")',
        },
      },
      required: ['imageId', 'tabId'],
    },
  },
  {
    name: 'shortcuts_list',
    description: 'List all available shortcuts and workflows (shortcuts and workflows are interchangeable). Returns shortcuts with their commands, descriptions, and whether they are workflows. Use shortcuts_execute to run a shortcut or workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab ID to list shortcuts from. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'shortcuts_execute',
    description: 'Execute a shortcut or workflow by running it in a new sidepanel window using the current tab (shortcuts and workflows are interchangeable). Use shortcuts_list first to see available shortcuts. This starts the execution and returns immediately - it does not wait for completion.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab ID to execute the shortcut on. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
        },
        shortcutId: {
          type: 'string',
          description: 'The ID of the shortcut to execute',
        },
        command: {
          type: 'string',
          description: "The command name of the shortcut to execute (e.g., 'debug', 'summarize'). Do not include the leading slash.",
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'update_plan',
    description: 'Present a plan to the user for approval before taking actions. The user will see the domains you intend to visit and your approach. Once approved, you can proceed with actions on the approved domains without additional permission prompts.',
    inputSchema: {
      type: 'object',
      properties: {
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: "List of domains you will visit (e.g., ['github.com', 'stackoverflow.com']). These domains will be approved for the session when the user accepts the plan.",
        },
        approach: {
          type: 'array',
          items: { type: 'string' },
          description: 'High-level description of what you will do. Focus on outcomes and key actions, not implementation details. Be concise - aim for 3-7 items.',
        },
      },
      required: ['domains', 'approach'],
    },
  },
  {
    name: 'switch_browser',
    description: "Switch which Chrome browser is used for browser automation. Call this when the user wants to connect to a different Chrome browser. Broadcasts a connection request to all Chrome browsers with the extension installed — the user clicks 'Connect' in the desired browser.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_chrome_extensions',
    description: 'List all installed Chrome extensions with their IDs, names, versions, enabled status, and type. macOS only — uses AppleScript to query chrome.developerPrivate API on the chrome://extensions page. Does not require a Chrome extension socket connection.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled_only: {
          type: 'boolean',
          description: 'If true, only return enabled extensions. Default: false (return all).',
        },
      },
    },
  },
  {
    name: 'reload_chrome_extension',
    description: 'Reload a Chrome extension by its extension ID or by name (case-insensitive substring match). macOS only — uses AppleScript to call chrome.developerPrivate.reload() on the chrome://extensions page. Does not require a Chrome extension socket connection. Use list_chrome_extensions first if you need to find the extension ID.',
    inputSchema: {
      type: 'object',
      properties: {
        extension_id: {
          type: 'string',
          description: 'The Chrome extension ID to reload (e.g., "dojoamdbiafnflmaknagfcakgpdkmpmn"). Provide either extension_id or name.',
        },
        name: {
          type: 'string',
          description: 'Substring of the extension name to match (case-insensitive). If multiple extensions match, returns an error listing the matches so you can use extension_id instead. Provide either extension_id or name.',
        },
      },
    },
  },
  // ==========================================================================
  // Convenience tools (server-side, compose existing socket tools)
  // ==========================================================================
  {
    name: 'find_elements',
    title: 'Find Elements',
    description: 'Find elements on the page by matching text, role, or attributes (case-insensitive substring match). Uses the accessibility tree from read_page — no JavaScript execution needed. Returns matching elements with their reference IDs, roles, text, and attributes. Use this instead of javascript_tool for finding elements on React/SPA pages.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to search for. Matches against element text, role name, or attributes (case-insensitive substring match).',
        },
        tabId: {
          type: 'number',
          description: "Tab ID to search in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
        filter: {
          type: 'string',
          enum: ['interactive', 'all'],
          description: 'Filter elements: "interactive" for buttons/links/inputs only (default), "all" for all elements.',
        },
      },
      required: ['query', 'tabId'],
    },
  },
  {
    name: 'click_by_text',
    title: 'Click By Text',
    description: 'Find an element by text, scroll it into view, and click it. Uses the accessibility tree — no coordinate guessing or JavaScript needed. Works reliably with React/SPA pages because it clicks via element references (MAIN world). Clicks the first matching element. Returns an error if no element matches the text.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to search for (case-insensitive substring match against element text, role, or attributes).',
        },
        tabId: {
          type: 'number',
          description: "Tab ID to click in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
      },
      required: ['text', 'tabId'],
    },
  },
  {
    name: 'fill_input',
    title: 'Fill Input',
    description: 'Find an input element by its label or placeholder text and fill it with a value. Searches the accessibility tree for elements with input roles (textbox, combobox, searchbox, spinbutton, slider). Works reliably with React/SPA pages because it uses form_input via element references (MAIN world). No coordinate guessing or JavaScript needed. Returns an error if no matching input is found.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Label or placeholder text to search for (case-insensitive substring match).',
        },
        value: {
          type: ['string', 'boolean', 'number'],
          description: 'The value to set. For checkboxes use boolean, for other inputs use string or number.',
        },
        tabId: {
          type: 'number',
          description: "Tab ID to fill input in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
      },
      required: ['label', 'value', 'tabId'],
    },
  },
  {
    name: 'wait_for_element',
    title: 'Wait For Element',
    description: 'Wait until an element matching the query appears on the page. Polls the accessibility tree until a match is found or timeout. Useful for waiting after navigation, form submissions, or dynamic content loading. Default timeout is 30 seconds with 1 second polling interval.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to search for (case-insensitive substring match against element text, role, or attributes).',
        },
        tabId: {
          type: 'number',
          description: "Tab ID to wait in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum time to wait in milliseconds (default: 30000).',
        },
        pollIntervalMs: {
          type: 'number',
          description: 'How often to check for the element in milliseconds (default: 1000).',
        },
      },
      required: ['query', 'tabId'],
    },
  },
  // ==========================================================================
  // Diagnostics
  // ==========================================================================
  {
    name: 'health_check',
    title: 'Health Check',
    description: 'Check if the chrome-bridge connection chain is healthy. Diagnoses: native messaging manifest, host launch script, socket directory, live sockets, and end-to-end connectivity. Returns structured diagnostics with remediation steps when unhealthy. Call this FIRST if other chrome-bridge tools fail with connection errors.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wake_extension',
    title: 'Wake Extension Service Worker',
    description: 'Wake a dormant MV3 extension service worker via native messaging. Used to wake proxy-chrome (or any other extension) before a demo or test run, without requiring Chrome to be launched with --remote-debugging-port=9222. The target extension MUST declare `externally_connectable.ids` containing the Gentyr extension ID ("dojoamdbiafnflmaknagfcakgpdkmpmn") in its manifest.json — otherwise Chrome will reject the wake message.',
    inputSchema: {
      type: 'object',
      properties: {
        extension_id: {
          type: 'string',
          description: 'Target extension ID to wake (32-character Chrome extension ID)',
        },
      },
      required: ['extension_id'],
    },
  },
  // ==========================================================================
  // React-aware automation tools (server-side, MAIN world JS execution)
  // ==========================================================================
  {
    name: 'react_fill_input',
    title: 'React Fill Input',
    description: 'Fill a React controlled input using the native-setter + _valueTracker reset + direct onChange call pattern. Bypasses React\'s synthetic event system to reliably update controlled components. Use this instead of fill_input when a form rejects values filled by standard methods (the form submits empty values despite the DOM showing the correct text). Requires a CSS selector — use page_diagnostic or read_page to discover selectors.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the input element (e.g. "#email", "input[name=username]", "input[type=password]").',
        },
        value: {
          type: 'string',
          description: 'Value to fill into the input.',
        },
        tabId: {
          type: 'number',
          description: "Tab ID to fill input in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
        verify: {
          type: 'boolean',
          description: 'If true (default), performs a readback verification 500ms after fill to confirm the value stuck in both DOM and React state.',
        },
      },
      required: ['selector', 'value', 'tabId'],
    },
  },
  {
    name: 'click_and_wait',
    title: 'Click And Wait',
    description: 'Click an element and wait for a page transition (URL change, text appear/disappear, element appear/disappear). Collapses the 3-step pattern (click → sleep → check) into one atomic call. Provide exactly one of: text (AX tree match), selector (CSS selector click), or submit (find and click form submit button). Provide at least one waitFor* condition to poll after the click.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to find and click via accessibility tree (case-insensitive substring match). Provide exactly one of text/selector/submit.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector to click directly via JavaScript .click(). Provide exactly one of text/selector/submit.',
        },
        submit: {
          type: 'boolean',
          description: 'If true, find and click the form\'s submit button using cascading fallback (form [type=submit] → form button → document [type=submit]). Provide exactly one of text/selector/submit.',
        },
        tabId: {
          type: 'number',
          description: "Tab ID to operate in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
        waitForUrl: {
          type: 'string',
          description: 'Wait until window.location.href contains this string.',
        },
        waitForUrlGone: {
          type: 'string',
          description: 'Wait until window.location.href no longer contains this string.',
        },
        waitForText: {
          type: 'string',
          description: 'Wait until page text contains this string.',
        },
        waitForTextGone: {
          type: 'string',
          description: 'Wait until page text no longer contains this string.',
        },
        waitForElement: {
          type: 'string',
          description: 'Wait until an element matching this query appears in the accessibility tree.',
        },
        waitForElementGone: {
          type: 'string',
          description: 'Wait until an element matching this query disappears from the accessibility tree.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum wait time in milliseconds (default: 30000).',
        },
        settleMs: {
          type: 'number',
          description: 'Initial settle time in milliseconds before polling begins (default: 1000).',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'page_diagnostic',
    title: 'Page Diagnostic',
    description: 'Comprehensive page state dump for debugging React form automation. Returns all inputs/forms/buttons with their DOM state, React controlled-input indicators (_valueTracker, __reactProps), and an accessibility tree summary. Use this to discover CSS selectors for react_fill_input and to understand why a form is not accepting values. IMPORTANT: Password values are never included — only value.length.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: "Tab ID to diagnose. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
        focus: {
          type: 'string',
          enum: ['inputs', 'forms', 'buttons', 'all'],
          description: 'Which elements to focus on: "inputs" (default), "forms", "buttons", or "all".',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'inspect_input',
    title: 'Inspect Input',
    description: 'Deep inspection of a single input element — DOM value, React internal value, _valueTracker state, and available React event handlers. Use this as the "why didn\'t my fill work?" diagnostic after a failed react_fill_input or fill_input attempt. Returns structured JSON with all findings. IMPORTANT: Password values are never included — only value.length.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the input element to inspect (e.g. "#email", "input[type=password]").',
        },
        tabId: {
          type: 'number',
          description: "Tab ID containing the input. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
      },
      required: ['selector', 'tabId'],
    },
  },
];

// ============================================================================
// Server-Side Tools (no direct socket passthrough — handled in executeServerSideTool)
// ============================================================================

const SERVER_SIDE_TOOLS = new Set([
  'list_chrome_extensions',
  'reload_chrome_extension',
  'find_elements',
  'click_by_text',
  'fill_input',
  'wait_for_element',
  'health_check',
  'react_fill_input',
  'click_and_wait',
  'page_diagnostic',
  'inspect_input',
]);

/**
 * Detect which Chrome application is running.
 * Tries "Google Chrome" first, then "Google Chrome for Testing".
 */
async function detectChromeApp(): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('Chrome extension management tools require macOS (AppleScript). Current platform: ' + process.platform);
  }

  for (const appName of ['Google Chrome', 'Google Chrome for Testing']) {
    try {
      const { stdout } = await execFileAsync('osascript', ['-e',
        `tell application "System Events" to return (name of processes) contains "${appName}"`,
      ], { timeout: 5000, encoding: 'utf8' });
      if (stdout.trim() === 'true') return appName;
    } catch { /* try next */ }
  }

  throw new Error('Chrome is not running. Start Google Chrome and try again.');
}

/**
 * Execute JavaScript on a chrome://extensions page via AppleScript.
 * Finds an existing extensions tab or creates one temporarily.
 * Returns the JS result string (the JS should return JSON.stringify(...)).
 */
async function executeOnExtensionsPage(chromeApp: string, javascript: string): Promise<string> {
  // Escape backslashes and double-quotes for embedding JS inside AppleScript string
  const escapedJs = javascript.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const script = `
tell application "${chromeApp}"
  set foundTab to missing value
  set foundWinIdx to -1
  set foundTabIdx to -1
  set createdTab to false

  repeat with w from 1 to count of windows
    repeat with t from 1 to count of tabs of window w
      if URL of tab t of window w starts with "chrome://extensions" then
        set foundTab to tab t of window w
        set foundWinIdx to w
        set foundTabIdx to t
        exit repeat
      end if
    end repeat
    if foundTab is not missing value then exit repeat
  end repeat

  if foundTab is missing value then
    if (count of windows) is 0 then
      make new window
    end if
    tell window 1
      set foundTab to make new tab with properties {URL:"chrome://extensions"}
    end tell
    set createdTab to true
    delay 1.5
  end if

  set jsResult to execute foundTab javascript "${escapedJs}"

  if createdTab then
    close foundTab
  end if

  return jsResult
end tell`;

  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    timeout: 15000,
    encoding: 'utf8',
  });
  return stdout.trim();
}

async function handleListExtensions(args: Record<string, unknown>): Promise<{ content: McpContent[]; isError?: boolean }> {
  try {
    const chromeApp = await detectChromeApp();
    const enabledOnly = args.enabled_only === true;

    const js = `(async () => {
  const exts = await chrome.developerPrivate.getExtensionsInfo();
  const mapped = exts.map(e => ({
    id: e.id,
    name: e.name,
    version: e.version,
    enabled: e.state === 'ENABLED',
    type: e.type,
    description: (e.description || '').slice(0, 120)
  }));
  return JSON.stringify(mapped);
})()`;

    const raw = await executeOnExtensionsPage(chromeApp, js);
    let extensions: Array<{
      id: string; name: string; version: string;
      enabled: boolean; type: string; description: string;
    }>;
    try { extensions = JSON.parse(raw); } catch {
      return { content: [{ type: 'text', text: `Unexpected response from Chrome: ${raw.slice(0, 200)}` }], isError: true };
    }

    if (enabledOnly) {
      extensions = extensions.filter((e) => e.enabled);
    }

    const lines = extensions.map((e) =>
      `${e.enabled ? '[ON] ' : '[OFF]'} ${e.name} (${e.id}) v${e.version} [${e.type}]${e.description ? ' — ' + e.description : ''}`,
    );

    return {
      content: [{
        type: 'text',
        text: `Found ${extensions.length} extension${extensions.length !== 1 ? 's' : ''}:\n\n${lines.join('\n')}`,
      }],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
}

// Chrome extension IDs are 32 lowercase a-p characters
const CHROME_EXTENSION_ID_RE = /^[a-p]{32}$/;

async function handleReloadExtension(args: Record<string, unknown>): Promise<{ content: McpContent[]; isError?: boolean }> {
  const extensionId = typeof args.extension_id === 'string' ? args.extension_id.trim() : '';
  const extensionName = typeof args.name === 'string' ? args.name.trim() : '';

  if (!extensionId && !extensionName) {
    return {
      content: [{ type: 'text', text: 'Provide either extension_id or name to identify the extension to reload.' }],
      isError: true,
    };
  }

  if (extensionId && extensionName) {
    return {
      content: [{ type: 'text', text: 'Provide either extension_id or name, not both.' }],
      isError: true,
    };
  }

  if (extensionId && !CHROME_EXTENSION_ID_RE.test(extensionId)) {
    return {
      content: [{ type: 'text', text: `Invalid extension_id "${extensionId}". Chrome extension IDs are 32 lowercase a-p characters.` }],
      isError: true,
    };
  }

  try {
    const chromeApp = await detectChromeApp();

    if (extensionId) {
      // Direct reload by ID (format-validated above, safe to interpolate)
      const js = `(async () => {
  try {
    await chrome.developerPrivate.reload('${extensionId}', {failQuietly: true});
    return JSON.stringify({success: true, id: '${extensionId}'});
  } catch (e) {
    return JSON.stringify({success: false, error: e.message});
  }
})()`;

      const raw = await executeOnExtensionsPage(chromeApp, js);
      let result: { success: boolean; id?: string; error?: string };
      try { result = JSON.parse(raw); } catch { result = { success: false, error: `Unexpected response from Chrome: ${raw.slice(0, 200)}` }; }
      if (!result.success) {
        return { content: [{ type: 'text', text: `Failed to reload extension ${extensionId}: ${result.error}` }], isError: true };
      }
      return { content: [{ type: 'text', text: `Extension ${extensionId} reloaded successfully.` }] };
    }

    // Name-based lookup + reload
    const safeNeedle = extensionName.replace(/'/g, "\\'");
    const js = `(async () => {
  const exts = await chrome.developerPrivate.getExtensionsInfo();
  const needle = '${safeNeedle}'.toLowerCase();
  const matches = exts.filter(e => e.name.toLowerCase().includes(needle));
  if (matches.length === 0) {
    const all = exts.map(e => e.name + ' (' + e.id + ')').join(', ');
    return JSON.stringify({success: false, error: 'no_match', available: all});
  }
  if (matches.length > 1) {
    const list = matches.map(e => ({id: e.id, name: e.name}));
    return JSON.stringify({success: false, error: 'ambiguous', matches: list});
  }
  try {
    await chrome.developerPrivate.reload(matches[0].id, {failQuietly: true});
    return JSON.stringify({success: true, id: matches[0].id, name: matches[0].name});
  } catch (e) {
    return JSON.stringify({success: false, error: 'reload_failed', message: e.message});
  }
})()`;

    const raw = await executeOnExtensionsPage(chromeApp, js);
    let result: {
      success: boolean; id?: string; name?: string;
      error?: string; message?: string; available?: string;
      matches?: Array<{ id: string; name: string }>;
    };
    try { result = JSON.parse(raw); } catch { result = { success: false, error: `Unexpected response from Chrome: ${raw.slice(0, 200)}` }; }

    if (result.error === 'no_match') {
      return {
        content: [{ type: 'text', text: `No extension found matching "${extensionName}". Available extensions: ${result.available}` }],
        isError: true,
      };
    }
    if (result.error === 'ambiguous') {
      const list = (result.matches || []).map((m) => `  - ${m.name} (${m.id})`).join('\n');
      return {
        content: [{ type: 'text', text: `Multiple extensions match "${extensionName}":\n${list}\n\nUse extension_id for an exact match.` }],
        isError: true,
      };
    }
    if (!result.success) {
      return { content: [{ type: 'text', text: `Failed to reload: ${result.message || result.error}` }], isError: true };
    }

    return { content: [{ type: 'text', text: `Extension "${result.name}" (${result.id}) reloaded successfully.` }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
}

// ============================================================================
// Convenience tool helpers (accessibility tree parsing, element interaction)
// ============================================================================

interface TreeElement {
  role: string;
  text: string;
  ref: string;
  attributes: string;
  line: string;
}

function parseAccessibilityTree(tree: string): TreeElement[] {
  const elements: TreeElement[] = [];
  const lineRegex = /^\s*(\w+)\s+"([^"]*)"\s+\[ref_(\d+)\](.*)$/;
  for (const line of tree.split('\n')) {
    const m = line.match(lineRegex);
    if (m) {
      elements.push({
        role: m[1],
        text: m[2],
        ref: `ref_${m[3]}`,
        attributes: m[4].trim(),
        line: line.trim(),
      });
    }
  }
  return elements;
}

function extractTextFromResult(
  result: { content: McpContent[]; isError?: boolean },
): string {
  return result.content
    .filter((c): c is McpContent & { text: string } => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

function findMatchingElements(parsed: TreeElement[], query: string): TreeElement[] {
  const q = query.toLowerCase();
  return parsed.filter(
    (el) =>
      el.text.toLowerCase().includes(q) ||
      el.role.toLowerCase().includes(q) ||
      el.attributes.toLowerCase().includes(q),
  );
}

async function handleFindElements(
  args: Record<string, unknown>,
): Promise<{ content: McpContent[]; isError?: boolean }> {
  const query = typeof args.query === 'string' ? args.query : '';
  const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
  const filter = args.filter === 'all' ? 'all' : 'interactive';

  if (!query) {
    return { content: [{ type: 'text', text: 'Missing required parameter: query' }], isError: true };
  }
  if (tabId === undefined) {
    return { content: [{ type: 'text', text: 'Missing required parameter: tabId' }], isError: true };
  }

  const readResult = await client.executeTool('read_page', { tabId, filter });
  if (readResult.isError) return readResult;

  const treeText = extractTextFromResult(readResult);
  const matches = findMatchingElements(parseAccessibilityTree(treeText), query);

  if (matches.length === 0) {
    return { content: [{ type: 'text', text: `No elements found matching "${query}"` }] };
  }

  const summary = matches
    .map((el) => `${el.role} "${el.text}" [${el.ref}]${el.attributes ? ' ' + el.attributes : ''}`)
    .join('\n');
  return {
    content: [{ type: 'text', text: `Found ${matches.length} element(s) matching "${query}":\n\n${summary}` }],
  };
}

async function handleClickByText(
  args: Record<string, unknown>,
): Promise<{ content: McpContent[]; isError?: boolean }> {
  const text = typeof args.text === 'string' ? args.text : '';
  const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;

  if (!text) {
    return { content: [{ type: 'text', text: 'Missing required parameter: text' }], isError: true };
  }
  if (tabId === undefined) {
    return { content: [{ type: 'text', text: 'Missing required parameter: tabId' }], isError: true };
  }

  const readResult = await client.executeTool('read_page', { tabId, filter: 'interactive' });
  if (readResult.isError) return readResult;

  const matches = findMatchingElements(parseAccessibilityTree(extractTextFromResult(readResult)), text);
  if (matches.length === 0) {
    return { content: [{ type: 'text', text: `Element not found: "${text}"` }], isError: true };
  }

  const { ref } = matches[0];
  await client.executeTool('computer', { action: 'scroll_to', ref, tabId });
  const clickResult = await client.executeTool('computer', { action: 'left_click', ref, tabId });

  return {
    content: [{ type: 'text', text: `Clicked ${matches[0].role} "${matches[0].text}" [${ref}]` }],
    isError: clickResult.isError,
  };
}

async function handleFillInput(
  args: Record<string, unknown>,
): Promise<{ content: McpContent[]; isError?: boolean }> {
  const label = typeof args.label === 'string' ? args.label : '';
  const value = args.value;
  const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;

  if (!label) {
    return { content: [{ type: 'text', text: 'Missing required parameter: label' }], isError: true };
  }
  if (value === undefined || value === null) {
    return { content: [{ type: 'text', text: 'Missing required parameter: value' }], isError: true };
  }
  if (tabId === undefined) {
    return { content: [{ type: 'text', text: 'Missing required parameter: tabId' }], isError: true };
  }

  const INPUT_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton', 'slider']);

  const readResult = await client.executeTool('read_page', { tabId, filter: 'interactive' });
  if (readResult.isError) return readResult;

  const matches = findMatchingElements(parseAccessibilityTree(extractTextFromResult(readResult)), label);
  const input = matches.find((el) => INPUT_ROLES.has(el.role));
  if (!input) {
    return {
      content: [{ type: 'text', text: `No input element found matching "${label}". Looked for roles: ${[...INPUT_ROLES].join(', ')}` }],
      isError: true,
    };
  }

  const fillResult = await client.executeTool('form_input', { ref: input.ref, value, tabId });
  if (fillResult.isError) return fillResult;

  // React controlled input detection: after a successful fill, check if any filled
  // inputs on the page have React props. If detected, advise using react_fill_input.
  let reactWarning = '';
  try {
    const reactCheckResult = await client.executeTool('javascript_tool', {
      action: 'javascript_exec',
      text: `(function() {
  var inputs = document.querySelectorAll('input, textarea');
  var hasReact = false;
  for (var i = 0; i < inputs.length; i++) {
    var el = inputs[i];
    if (el._valueTracker) { hasReact = true; break; }
    var keys = Object.keys(el);
    for (var j = 0; j < keys.length; j++) {
      if (keys[j].indexOf('__reactProps') === 0 || keys[j].indexOf('__reactEventHandlers') === 0) {
        hasReact = true; break;
      }
    }
    if (hasReact) break;
  }
  return JSON.stringify({ hasReact: hasReact });
})()`,
      tabId,
    });
    if (!reactCheckResult.isError) {
      const checkText = reactCheckResult.content
        .filter((c): c is McpContent & { text: string } => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('');
      try {
        const parsed = JSON.parse(checkText) as { hasReact?: boolean };
        if (parsed.hasReact === true) {
          reactWarning = '\nNote: This input appears to be a React controlled component. If the form rejects the value, use `react_fill_input` with the CSS selector instead.';
        }
      } catch { /* ignore parse errors */ }
    }
  } catch { /* best-effort, non-fatal */ }

  return {
    content: [{ type: 'text', text: `Filled ${input.role} "${input.text}" [${input.ref}] with value: ${JSON.stringify(value)}${reactWarning}` }],
  };
}

async function handleWaitForElement(
  args: Record<string, unknown>,
): Promise<{ content: McpContent[]; isError?: boolean }> {
  const query = typeof args.query === 'string' ? args.query : '';
  const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 30_000;
  const pollIntervalMs = typeof args.pollIntervalMs === 'number' ? args.pollIntervalMs : 1_000;

  if (!query) {
    return { content: [{ type: 'text', text: 'Missing required parameter: query' }], isError: true };
  }
  if (tabId === undefined) {
    return { content: [{ type: 'text', text: 'Missing required parameter: tabId' }], isError: true };
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const readResult = await client.executeTool('read_page', { tabId, filter: 'interactive' });
      if (!readResult.isError) {
        const matches = findMatchingElements(
          parseAccessibilityTree(extractTextFromResult(readResult)),
          query,
        );
        if (matches.length > 0) {
          return {
            content: [{ type: 'text', text: `Element found: ${matches[0].role} "${matches[0].text}" [${matches[0].ref}]` }],
          };
        }
      }
    } catch {
      // Swallow errors during polling (page may be loading)
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
  }

  return {
    content: [{ type: 'text', text: `Timeout after ${timeoutMs}ms waiting for element matching "${query}"` }],
    isError: true,
  };
}

async function handleReactFillInput(
  args: Record<string, unknown>,
): Promise<{ content: McpContent[]; isError?: boolean }> {
  const selector = typeof args.selector === 'string' ? args.selector : '';
  const value = typeof args.value === 'string' ? args.value : '';
  const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
  const verify = args.verify !== false; // default true

  if (!selector) {
    return { content: [{ type: 'text', text: 'Missing required parameter: selector' }], isError: true };
  }
  if (args.value === undefined || args.value === null) {
    return { content: [{ type: 'text', text: 'Missing required parameter: value' }], isError: true };
  }
  if (tabId === undefined) {
    return { content: [{ type: 'text', text: 'Missing required parameter: tabId' }], isError: true };
  }

  const fillCode = `(function(sel, v) {
  var el = document.querySelector(sel);
  if (!el) return JSON.stringify({ success: false, error: 'no-element', selector: sel });
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    return JSON.stringify({ success: false, error: 'wrong-type', tagName: el.tagName });
  }
  el.focus();
  var proto = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  var nativeSet = Object.getOwnPropertyDescriptor(proto, 'value').set;
  nativeSet.call(el, v);
  var tracker = el._valueTracker;
  var trackerReset = false;
  if (tracker) { tracker.setValue(''); trackerReset = true; }
  var handlerKey = Object.keys(el).find(function(k) {
    return k.indexOf('__reactEventHandlers') === 0 || k.indexOf('__reactProps') === 0;
  });
  var onChangeCalled = false;
  if (handlerKey) {
    var handlers = el[handlerKey];
    if (handlers && typeof handlers.onChange === 'function') {
      try {
        handlers.onChange({ target: el, currentTarget: el, type: 'change',
          nativeEvent: { data: v }, bubbles: true });
        onChangeCalled = true;
      } catch (e) { /* ignore */ }
    }
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: v, inputType: 'insertText' }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({
    success: true, domValue: el.value, domValueLength: el.value.length,
    trackerReset: trackerReset, onChangeCalled: onChangeCalled,
    hasReactProps: !!handlerKey
  });
})(${JSON.stringify(selector)}, ${JSON.stringify(value)})`;

  const fillResult = await client.executeTool('javascript_tool', {
    action: 'javascript_exec',
    text: fillCode,
    tabId,
  });

  if (fillResult.isError) return fillResult;

  const fillText = fillResult.content
    .filter((c): c is McpContent & { text: string } => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');

  let fillParsed: {
    success: boolean;
    error?: string;
    selector?: string;
    tagName?: string;
    domValue?: string;
    domValueLength?: number;
    trackerReset?: boolean;
    onChangeCalled?: boolean;
    hasReactProps?: boolean;
  };
  try {
    fillParsed = JSON.parse(fillText);
  } catch {
    return { content: [{ type: 'text', text: `react_fill_input: unexpected response from javascript_tool: ${fillText.slice(0, 200)}` }], isError: true };
  }

  if (!fillParsed.success) {
    const reason = fillParsed.error === 'no-element'
      ? `No element found matching selector "${fillParsed.selector ?? selector}"`
      : fillParsed.error === 'wrong-type'
        ? `Element found but is not an input/textarea (tagName: ${fillParsed.tagName ?? 'unknown'})`
        : `Fill failed: ${fillParsed.error ?? 'unknown error'}`;
    return { content: [{ type: 'text', text: reason }], isError: true };
  }

  let verifyResult: Record<string, unknown> | null = null;
  if (verify) {
    await new Promise((r) => setTimeout(r, 500));
    const verifyCode = `(function(sel, expected) {
  var el = document.querySelector(sel);
  if (!el) return JSON.stringify({ found: false });
  var tracker = el._valueTracker;
  var trackerValue = tracker ? tracker.getValue() : null;
  var handlerKey = Object.keys(el).find(function(k) {
    return k.indexOf('__reactEventHandlers') === 0 || k.indexOf('__reactProps') === 0;
  });
  var reactValue = null;
  if (handlerKey && el[handlerKey]) {
    var v = el[handlerKey].value;
    reactValue = (v !== undefined && v !== null) ? String(v) : null;
  }
  return JSON.stringify({
    found: true,
    domValue: el.value,
    domValueLength: el.value.length,
    domMatchesExpected: el.value === expected,
    trackerValue: trackerValue,
    reactValue: reactValue,
    reactMatchesExpected: reactValue !== null ? reactValue === expected : null
  });
})(${JSON.stringify(selector)}, ${JSON.stringify(value)})`;

    const verifyRes = await client.executeTool('javascript_tool', {
      action: 'javascript_exec',
      text: verifyCode,
      tabId,
    });
    if (!verifyRes.isError) {
      const vText = verifyRes.content
        .filter((c): c is McpContent & { text: string } => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('');
      try { verifyResult = JSON.parse(vText); } catch { /* ignore */ }
    }
  }

  const summary = {
    success: true,
    selector,
    domValueLength: fillParsed.domValueLength,
    trackerReset: fillParsed.trackerReset,
    onChangeCalled: fillParsed.onChangeCalled,
    hasReactProps: fillParsed.hasReactProps,
    ...(verifyResult ? { verify: verifyResult } : {}),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
  };
}

async function handleClickAndWait(
  args: Record<string, unknown>,
): Promise<{ content: McpContent[]; isError?: boolean }> {
  const text = typeof args.text === 'string' ? args.text : undefined;
  const selector = typeof args.selector === 'string' ? args.selector : undefined;
  const submit = args.submit === true;
  const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
  const waitForUrl = typeof args.waitForUrl === 'string' ? args.waitForUrl : undefined;
  const waitForUrlGone = typeof args.waitForUrlGone === 'string' ? args.waitForUrlGone : undefined;
  const waitForText = typeof args.waitForText === 'string' ? args.waitForText : undefined;
  const waitForTextGone = typeof args.waitForTextGone === 'string' ? args.waitForTextGone : undefined;
  const waitForElement = typeof args.waitForElement === 'string' ? args.waitForElement : undefined;
  const waitForElementGone = typeof args.waitForElementGone === 'string' ? args.waitForElementGone : undefined;
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 30_000;
  const settleMs = typeof args.settleMs === 'number' ? args.settleMs : 1_000;

  if (tabId === undefined) {
    return { content: [{ type: 'text', text: 'Missing required parameter: tabId' }], isError: true };
  }

  // Exactly one click target must be specified
  const clickTargets = [text !== undefined, selector !== undefined, submit].filter(Boolean).length;
  if (clickTargets === 0) {
    return {
      content: [{ type: 'text', text: 'Provide exactly one of: text, selector, or submit: true' }],
      isError: true,
    };
  }
  if (clickTargets > 1) {
    return {
      content: [{ type: 'text', text: 'Provide exactly one of: text, selector, or submit: true — not multiple' }],
      isError: true,
    };
  }

  const startMs = Date.now();
  let clickTarget = '';

  // --- Click phase ---

  if (text !== undefined) {
    // Use handleClickByText logic: AX tree → scroll_to → left_click
    const readResult = await client.executeTool('read_page', { tabId, filter: 'interactive' });
    if (readResult.isError) return readResult;
    const matches = findMatchingElements(parseAccessibilityTree(extractTextFromResult(readResult)), text);
    if (matches.length === 0) {
      return { content: [{ type: 'text', text: `Element not found: "${text}"` }], isError: true };
    }
    const { ref } = matches[0];
    clickTarget = `${matches[0].role} "${matches[0].text}" [${ref}]`;
    await client.executeTool('computer', { action: 'scroll_to', ref, tabId });
    const clickResult = await client.executeTool('computer', { action: 'left_click', ref, tabId });
    if (clickResult.isError) return clickResult;

  } else if (selector !== undefined) {
    // JS .click() on the CSS selector
    const clickCode = `(function(sel) {
  var el = document.querySelector(sel);
  if (!el) return JSON.stringify({ success: false, error: 'no-element' });
  el.click();
  return JSON.stringify({ success: true, tagName: el.tagName, text: (el.textContent || '').slice(0, 80) });
})(${JSON.stringify(selector)})`;
    const jsResult = await client.executeTool('javascript_tool', {
      action: 'javascript_exec',
      text: clickCode,
      tabId,
    });
    if (jsResult.isError) return jsResult;
    const jsText = jsResult.content
      .filter((c): c is McpContent & { text: string } => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
    let jsParsed: { success: boolean; error?: string; tagName?: string; text?: string };
    try { jsParsed = JSON.parse(jsText); } catch {
      return { content: [{ type: 'text', text: `click_and_wait: unexpected JS response: ${jsText.slice(0, 200)}` }], isError: true };
    }
    if (!jsParsed.success) {
      return { content: [{ type: 'text', text: `No element found matching selector "${selector}"` }], isError: true };
    }
    clickTarget = `${jsParsed.tagName ?? 'element'} "${(jsParsed.text ?? '').slice(0, 50)}" (selector: ${selector})`;

  } else {
    // submit: true — cascading submit button finder
    const submitCode = `(function() {
  var btn = document.querySelector('form [type="submit"]')
         || document.querySelector('form button:not([type])')
         || document.querySelector('[type="submit"]')
         || Array.from(document.querySelectorAll('form button')).find(function(b) {
              var t = (b.textContent || '').toLowerCase().trim();
              return t === 'submit' || t === 'sign in' || t === 'log in' || t === 'login' || t === 'next' || t === 'continue';
            })
         || document.querySelector('button[type="submit"]');
  if (!btn) return JSON.stringify({ success: false, error: 'no-submit-button' });
  btn.click();
  return JSON.stringify({ success: true, tagName: btn.tagName, text: (btn.textContent || '').slice(0, 80) });
})()`;
    const submitResult = await client.executeTool('javascript_tool', {
      action: 'javascript_exec',
      text: submitCode,
      tabId,
    });
    if (submitResult.isError) return submitResult;
    const submitText = submitResult.content
      .filter((c): c is McpContent & { text: string } => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
    let submitParsed: { success: boolean; error?: string; tagName?: string; text?: string };
    try { submitParsed = JSON.parse(submitText); } catch {
      return { content: [{ type: 'text', text: `click_and_wait: unexpected JS response: ${submitText.slice(0, 200)}` }], isError: true };
    }
    if (!submitParsed.success) {
      return { content: [{ type: 'text', text: 'No submit button found on page (tried form [type=submit], form button, document [type=submit])' }], isError: true };
    }
    clickTarget = `${submitParsed.tagName ?? 'button'} "${(submitParsed.text ?? '').trim().slice(0, 50)}" (submit)`;
  }

  // --- Wait phase ---

  const hasWaitCondition = waitForUrl !== undefined
    || waitForUrlGone !== undefined
    || waitForText !== undefined
    || waitForTextGone !== undefined
    || waitForElement !== undefined
    || waitForElementGone !== undefined;

  if (!hasWaitCondition) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ clicked: true, clickTarget, transitioned: false, elapsedMs: Date.now() - startMs }, null, 2),
      }],
    };
  }

  // Initial settle delay before polling
  await new Promise((r) => setTimeout(r, settleMs));

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      // Check URL conditions
      if (waitForUrl !== undefined || waitForUrlGone !== undefined) {
        const urlResult = await client.executeTool('javascript_tool', {
          action: 'javascript_exec',
          text: 'window.location.href',
          tabId,
        });
        if (!urlResult.isError) {
          const currentUrl = urlResult.content
            .filter((c): c is McpContent & { text: string } => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text)
            .join('');
          if (waitForUrl !== undefined && currentUrl.includes(waitForUrl)) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ clicked: true, clickTarget, transitioned: true, condition: 'waitForUrl', finalUrl: currentUrl, elapsedMs: Date.now() - startMs }, null, 2),
              }],
            };
          }
          if (waitForUrlGone !== undefined && !currentUrl.includes(waitForUrlGone)) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ clicked: true, clickTarget, transitioned: true, condition: 'waitForUrlGone', finalUrl: currentUrl, elapsedMs: Date.now() - startMs }, null, 2),
              }],
            };
          }
        }
      }

      // Check text conditions
      if (waitForText !== undefined || waitForTextGone !== undefined) {
        const textResult = await client.executeTool('get_page_text', { tabId });
        if (!textResult.isError) {
          const pageText = extractTextFromResult(textResult);
          if (waitForText !== undefined && pageText.includes(waitForText)) {
            const urlRes = await client.executeTool('javascript_tool', { action: 'javascript_exec', text: 'window.location.href', tabId });
            const finalUrl = extractTextFromResult(urlRes);
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ clicked: true, clickTarget, transitioned: true, condition: 'waitForText', finalUrl, elapsedMs: Date.now() - startMs }, null, 2),
              }],
            };
          }
          if (waitForTextGone !== undefined && !pageText.includes(waitForTextGone)) {
            const urlRes = await client.executeTool('javascript_tool', { action: 'javascript_exec', text: 'window.location.href', tabId });
            const finalUrl = extractTextFromResult(urlRes);
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ clicked: true, clickTarget, transitioned: true, condition: 'waitForTextGone', finalUrl, elapsedMs: Date.now() - startMs }, null, 2),
              }],
            };
          }
        }
      }

      // Check element conditions
      if (waitForElement !== undefined || waitForElementGone !== undefined) {
        const readResult = await client.executeTool('read_page', { tabId, filter: 'interactive' });
        if (!readResult.isError) {
          const parsed = parseAccessibilityTree(extractTextFromResult(readResult));
          if (waitForElement !== undefined) {
            const matches = findMatchingElements(parsed, waitForElement);
            if (matches.length > 0) {
              const urlRes = await client.executeTool('javascript_tool', { action: 'javascript_exec', text: 'window.location.href', tabId });
              const finalUrl = extractTextFromResult(urlRes);
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({ clicked: true, clickTarget, transitioned: true, condition: 'waitForElement', matchedElement: matches[0].line, finalUrl, elapsedMs: Date.now() - startMs }, null, 2),
                }],
              };
            }
          }
          if (waitForElementGone !== undefined) {
            const matches = findMatchingElements(parsed, waitForElementGone);
            if (matches.length === 0) {
              const urlRes = await client.executeTool('javascript_tool', { action: 'javascript_exec', text: 'window.location.href', tabId });
              const finalUrl = extractTextFromResult(urlRes);
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({ clicked: true, clickTarget, transitioned: true, condition: 'waitForElementGone', finalUrl, elapsedMs: Date.now() - startMs }, null, 2),
                }],
              };
            }
          }
        }
      }
    } catch {
      // Swallow polling errors (page may be loading/navigating)
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(1000, remaining)));
  }

  // Timeout — get final URL for diagnostics
  let finalUrl = '';
  try {
    const urlRes = await client.executeTool('javascript_tool', { action: 'javascript_exec', text: 'window.location.href', tabId });
    finalUrl = extractTextFromResult(urlRes);
  } catch { /* ignore */ }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ clicked: true, clickTarget, transitioned: false, timedOut: true, finalUrl, elapsedMs: Date.now() - startMs }, null, 2),
    }],
    isError: true,
  };
}

async function handlePageDiagnostic(
  args: Record<string, unknown>,
): Promise<{ content: McpContent[]; isError?: boolean }> {
  const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
  const focus = (args.focus === 'forms' || args.focus === 'buttons' || args.focus === 'all') ? args.focus : 'inputs';

  if (tabId === undefined) {
    return { content: [{ type: 'text', text: 'Missing required parameter: tabId' }], isError: true };
  }

  const includeInputs = focus === 'inputs' || focus === 'all';
  const includeForms = focus === 'forms' || focus === 'all';
  const includeButtons = focus === 'buttons' || focus === 'all';

  const diagCode = `(function(opts) {
  var result = {
    url: window.location.href,
    title: document.title
  };

  if (opts.inputs) {
    var inputEls = document.querySelectorAll('input, textarea, select');
    result.inputs = Array.from(inputEls).map(function(el) {
      var handlerKey = Object.keys(el).find(function(k) {
        return k.indexOf('__reactEventHandlers') === 0 || k.indexOf('__reactProps') === 0;
      });
      var isPassword = el.type === 'password';
      return {
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        name: el.name || null,
        id: el.id || null,
        placeholder: el.placeholder || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        disabled: el.disabled,
        readOnly: el.readOnly || false,
        valueLength: el.value ? el.value.length : 0,
        isPassword: isPassword,
        hasValueTracker: !!el._valueTracker,
        trackerValue: el._valueTracker ? el._valueTracker.getValue() : null,
        hasReactProps: !!handlerKey,
        reactPropsKey: handlerKey || null,
        hasOnChange: handlerKey && el[handlerKey] && typeof el[handlerKey].onChange === 'function' ? true : false,
        cssSelector: el.id ? '#' + el.id : (el.name ? el.tagName.toLowerCase() + '[name="' + el.name + '"]' : null)
      };
    });
  }

  if (opts.forms) {
    result.forms = Array.from(document.querySelectorAll('form')).map(function(form) {
      return {
        id: form.id || null,
        action: form.action || null,
        method: form.method || null,
        inputCount: form.querySelectorAll('input, textarea, select').length,
        submitButtonCount: form.querySelectorAll('[type="submit"], button:not([type])').length
      };
    });
  }

  if (opts.buttons) {
    result.buttons = Array.from(document.querySelectorAll('button, [type="submit"], [role="button"]')).map(function(el) {
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        text: (el.textContent || '').trim().slice(0, 50),
        disabled: el.disabled || false,
        formId: el.form ? (el.form.id || '(no id)') : null,
        id: el.id || null
      };
    });
  }

  return JSON.stringify(result);
})({ inputs: ${includeInputs}, forms: ${includeForms}, buttons: ${includeButtons} })`;

  const jsResult = await client.executeTool('javascript_tool', {
    action: 'javascript_exec',
    text: diagCode,
    tabId,
  });

  if (jsResult.isError) return jsResult;

  const jsText = jsResult.content
    .filter((c): c is McpContent & { text: string } => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');

  // Also get accessibility tree summary for interactive elements
  const axResult = await client.executeTool('read_page', { tabId, filter: 'interactive' });
  const axSummary = axResult.isError ? null : extractTextFromResult(axResult);

  let diagData: Record<string, unknown>;
  try {
    diagData = JSON.parse(jsText);
  } catch {
    return { content: [{ type: 'text', text: `page_diagnostic: unexpected JS response: ${jsText.slice(0, 200)}` }], isError: true };
  }

  if (axSummary) {
    diagData.axTreeSummary = axSummary.slice(0, 3000); // cap to avoid huge output
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(diagData, null, 2) }],
  };
}

async function handleInspectInput(
  args: Record<string, unknown>,
): Promise<{ content: McpContent[]; isError?: boolean }> {
  const selector = typeof args.selector === 'string' ? args.selector : '';
  const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;

  if (!selector) {
    return { content: [{ type: 'text', text: 'Missing required parameter: selector' }], isError: true };
  }
  if (tabId === undefined) {
    return { content: [{ type: 'text', text: 'Missing required parameter: tabId' }], isError: true };
  }

  const inspectCode = `(function(sel) {
  var el = document.querySelector(sel);
  if (!el) return JSON.stringify({ found: false, selector: sel });

  var isPassword = el.type === 'password';
  var tracker = el._valueTracker;
  var trackerValue = tracker ? tracker.getValue() : null;

  var reactKeys = Object.keys(el).filter(function(k) {
    return k.indexOf('__react') === 0;
  });

  var handlerKey = reactKeys.find(function(k) {
    return k.indexOf('__reactEventHandlers') === 0 || k.indexOf('__reactProps') === 0;
  });

  var hasOnChange = false;
  var reactControlledValue = null;
  if (handlerKey && el[handlerKey]) {
    hasOnChange = typeof el[handlerKey].onChange === 'function';
    var rv = el[handlerKey].value;
    reactControlledValue = (rv !== undefined && rv !== null) ? String(rv) : null;
  }

  var proto = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  var hasNativeSetter = !!(Object.getOwnPropertyDescriptor(proto, 'value') || {}).set;

  var inForm = !!el.closest('form');

  return JSON.stringify({
    found: true,
    selector: sel,
    tag: el.tagName.toLowerCase(),
    type: el.type || null,
    name: el.name || null,
    id: el.id || null,
    disabled: el.disabled,
    readOnly: el.readOnly || false,
    isPassword: isPassword,
    domValueLength: el.value ? el.value.length : 0,
    hasValueTracker: !!tracker,
    trackerValue: trackerValue,
    reactKeys: reactKeys,
    handlerKey: handlerKey || null,
    hasOnChange: hasOnChange,
    reactControlledValue: reactControlledValue,
    isControlled: reactControlledValue !== null,
    hasNativeSetter: hasNativeSetter,
    inForm: inForm
  });
})(${JSON.stringify(selector)})`;

  const jsResult = await client.executeTool('javascript_tool', {
    action: 'javascript_exec',
    text: inspectCode,
    tabId,
  });

  if (jsResult.isError) return jsResult;

  const jsText = jsResult.content
    .filter((c): c is McpContent & { text: string } => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');

  let inspectData: Record<string, unknown>;
  try {
    inspectData = JSON.parse(jsText);
  } catch {
    return { content: [{ type: 'text', text: `inspect_input: unexpected JS response: ${jsText.slice(0, 200)}` }], isError: true };
  }

  if (!inspectData.found) {
    return { content: [{ type: 'text', text: `No element found matching selector "${selector}"` }], isError: true };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(inspectData, null, 2) }],
  };
}

// ============================================================================
// Connection Diagnostics
// ============================================================================

interface DiagnosticCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

interface DiagnosticResult {
  healthy: boolean;
  checks: DiagnosticCheck[];
  remediation: string[];
}

const NMH_NAME = 'com.gentyr.chrome_browser_extension';

function getNativeManifestDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  }
  return path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts');
}

function resolveExtensionDir(): string | null {
  // Resolve from compiled dist/ back to tools/chrome-extension/extension/
  // From dist/chrome-bridge/ -> dist/ -> packages/mcp-servers/ -> packages/ -> framework root
  const candidate = path.resolve(__dirname, '..', '..', '..', '..', 'tools', 'chrome-extension', 'extension');
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch { /* ignore */ }
  return null;
}

async function runConnectionDiagnostics(socketDir: string): Promise<DiagnosticResult> {
  const checks: DiagnosticCheck[] = [];
  const remediation: string[] = [];
  const extensionDir = resolveExtensionDir();
  const installHint = 'Run: tools/chrome-extension/native-host/install.sh';
  const loadExtHint = extensionDir
    ? `Load the Gentyr extension in Chrome: chrome://extensions -> Developer Mode -> Load Unpacked -> ${extensionDir}`
    : 'Load the Gentyr extension in Chrome: chrome://extensions -> Developer Mode -> Load Unpacked -> <path-to-gentyr>/tools/chrome-extension/extension/';

  // Check 1: Native messaging manifest
  const manifestPath = path.join(getNativeManifestDir(), `${NMH_NAME}.json`);
  if (!fs.existsSync(manifestPath)) {
    checks.push({ name: 'Native manifest', ok: false, detail: `Not found: ${manifestPath}` });
    remediation.push(installHint);
    return { healthy: false, checks, remediation };
  }
  checks.push({ name: 'Native manifest', ok: true, detail: manifestPath });

  // Check 2: Host launch script from manifest + extract expected extension ID
  let launchScriptPath: string | undefined;
  let expectedExtId: string | undefined;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    launchScriptPath = manifest.path;
    // Extract extension ID from allowed_origins (e.g. "chrome-extension://ID/")
    const origins: string[] = manifest.allowed_origins || [];
    const originMatch = origins[0]?.match(/chrome-extension:\/\/([a-z]+)\//);
    if (originMatch) expectedExtId = originMatch[1];

    if (!launchScriptPath || !fs.existsSync(launchScriptPath)) {
      checks.push({ name: 'Host launch script', ok: false, detail: `Not found: ${launchScriptPath || '(empty path in manifest)'}` });
      remediation.push(installHint);
      return { healthy: false, checks, remediation };
    }
    try {
      fs.accessSync(launchScriptPath, fs.constants.X_OK);
    } catch {
      checks.push({ name: 'Host launch script', ok: false, detail: `Not executable: ${launchScriptPath}` });
      remediation.push(`Run: chmod +x ${launchScriptPath}`);
      return { healthy: false, checks, remediation };
    }
    checks.push({ name: 'Host launch script', ok: true, detail: launchScriptPath });
  } catch (err) {
    checks.push({ name: 'Host launch script', ok: false, detail: `Failed to parse manifest: ${err instanceof Error ? err.message : String(err)}` });
    remediation.push(installHint);
    return { healthy: false, checks, remediation };
  }

  // Check 3: Socket directory
  const idMismatchHint = expectedExtId
    ? `If the extension IS loaded but the native host still exits immediately, check for extension ID mismatch: the NMH manifest expects ID "${expectedExtId}" in allowed_origins. Unpacked extensions may get a different ID — verify at chrome://extensions. If mismatched, update ${manifestPath} allowed_origins or re-run install.sh.`
    : '';
  if (!fs.existsSync(socketDir)) {
    checks.push({ name: 'Socket directory', ok: false, detail: `Not found: ${socketDir}` });
    remediation.push(`Native host has never started successfully. ${loadExtHint}, then reload any tab.`);
    if (idMismatchHint) remediation.push(idMismatchHint);
    return { healthy: false, checks, remediation };
  }
  checks.push({ name: 'Socket directory', ok: true, detail: socketDir });

  // Check 4: Live sockets with valid PIDs
  let socketFiles: string[];
  try {
    socketFiles = fs.readdirSync(socketDir).filter((f) => f.endsWith('.sock'));
  } catch {
    socketFiles = [];
  }

  if (socketFiles.length === 0) {
    checks.push({ name: 'Live sockets', ok: false, detail: 'No socket files in directory' });
    remediation.push(`No native host sockets found. ${loadExtHint}, then reload any tab to trigger native host connection.`);
    return { healthy: false, checks, remediation };
  }

  const livePids: number[] = [];
  const staleSockets: string[] = [];
  for (const file of socketFiles) {
    const pidMatch = file.match(/^(\d+)\.sock$/);
    if (!pidMatch) continue;
    const pid = parseInt(pidMatch[1], 10);
    try {
      process.kill(pid, 0); // Check if alive (throws if dead)
      livePids.push(pid);
    } catch {
      staleSockets.push(file);
      // Clean up stale socket
      try { fs.unlinkSync(path.join(socketDir, file)); } catch { /* ignore */ }
    }
  }

  if (livePids.length === 0) {
    const cleanedNote = staleSockets.length > 0 ? ` (${staleSockets.length} stale socket(s) cleaned)` : '';
    checks.push({ name: 'Live sockets', ok: false, detail: `No live native host processes${cleanedNote}` });
    remediation.push(`Native host processes have exited. Reload the Gentyr extension in Chrome (chrome://extensions -> click reload icon) or reload any tab.`);
    if (idMismatchHint) remediation.push(idMismatchHint);
    return { healthy: false, checks, remediation };
  }

  checks.push({ name: 'Live sockets', ok: true, detail: `${livePids.length} live (PID: ${livePids.join(', ')})${staleSockets.length > 0 ? `, ${staleSockets.length} stale cleaned` : ''}` });

  return { healthy: true, checks, remediation };
}

async function handleHealthCheck(): Promise<{ content: McpContent[]; isError?: boolean }> {
  const diag = await runConnectionDiagnostics(client.socketDirPath);

  // If all filesystem checks pass, attempt end-to-end connectivity
  if (diag.healthy) {
    try {
      const result = await Promise.race([
        client.executeTool('tabs_context_mcp', {}),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      if (result && typeof result === 'object' && 'isError' in result && result.isError) {
        diag.checks.push({ name: 'End-to-end connectivity', ok: false, detail: 'tabs_context_mcp returned error' });
        diag.healthy = false;
        diag.remediation.push('Socket is live but extension is not responding. Reload the Gentyr extension in Chrome.');
      } else {
        diag.checks.push({ name: 'End-to-end connectivity', ok: true, detail: 'tabs_context_mcp responded' });
      }
    } catch {
      diag.checks.push({ name: 'End-to-end connectivity', ok: false, detail: 'Connection timed out (3s)' });
      diag.healthy = false;
      diag.remediation.push('Socket exists but native host is unresponsive. Reload the Gentyr extension in Chrome.');
    }
  }

  const output = {
    healthy: diag.healthy,
    checks: Object.fromEntries(diag.checks.map((c) => [c.name, { ok: c.ok, ...(c.detail ? { detail: c.detail } : {}) }])),
    ...(diag.remediation.length > 0 ? { remediation: diag.remediation } : {}),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    isError: !diag.healthy,
  };
}

async function executeServerSideTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: McpContent[]; isError?: boolean }> {
  switch (toolName) {
    case 'list_chrome_extensions':
      return handleListExtensions(args);
    case 'reload_chrome_extension':
      return handleReloadExtension(args);
    case 'find_elements':
      return handleFindElements(args);
    case 'click_by_text':
      return handleClickByText(args);
    case 'fill_input':
      return handleFillInput(args);
    case 'wait_for_element':
      return handleWaitForElement(args);
    case 'health_check':
      return handleHealthCheck();
    case 'react_fill_input':
      return handleReactFillInput(args);
    case 'click_and_wait':
      return handleClickAndWait(args);
    case 'page_diagnostic':
      return handlePageDiagnostic(args);
    case 'inspect_input':
      return handleInspectInput(args);
    default:
      return { content: [{ type: 'text', text: `Unknown server-side tool: ${toolName}` }], isError: true };
  }
}

// ============================================================================
// JSON-RPC Server
// ============================================================================

function log(message: string): void {
  process.stderr.write(`[chrome-bridge] ${message}\n`);
}

const client = new ChromeBridgeClient();

function createResponse(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function createError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      return createResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'chrome-bridge', version: '1.0.0' },
      });

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return createResponse(id, { tools: CHROME_TOOLS });

    case 'tools/call': {
      const parseResult = McpToolCallParamsSchema.safeParse(params);
      if (!parseResult.success) {
        return createError(id, JSON_RPC_ERRORS.INVALID_PARAMS, `Invalid params: ${parseResult.error.message}`);
      }

      const { name, arguments: args } = parseResult.data;
      const toolDef = CHROME_TOOLS.find((t) => t.name === name);
      if (!toolDef) {
        return createError(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      }

      // Server-side tools (AppleScript-based, no socket needed)
      if (SERVER_SIDE_TOOLS.has(name)) {
        const result = await executeServerSideTool(name, args ?? {});
        return createResponse(id, result);
      }

      // Soft warning: check if another agent holds the display lock.
      // Chrome-bridge tools often require exclusive display access for demo recordings.
      // This is a best-effort check — failure to load the module is silently ignored.
      let displayLockWarning: string | undefined;
      try {
        const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        const displayLockPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'display-lock.js');
        if (fs.existsSync(displayLockPath)) {
          const displayLockMod = await import(displayLockPath) as {
            getDisplayLockStatus: () => { locked: boolean; holder: Record<string, unknown> | null };
          };
          const lockStatus = displayLockMod.getDisplayLockStatus();
          if (lockStatus.locked && lockStatus.holder) {
            const holderAgentId = lockStatus.holder['agent_id'] as string | undefined;
            const callerAgentId = process.env.CLAUDE_AGENT_ID || 'unknown';
            if (holderAgentId && holderAgentId !== callerAgentId) {
              displayLockWarning = `Warning: Display lock held by agent "${holderAgentId}". Consider calling acquire_display_lock first for exclusive access. Proceeding may cause recording conflicts.`;
            }
          }
        }
      } catch {
        // Best-effort — display lock check is non-fatal
      }

      const result = await client.executeTool(name, args ?? {});

      // Prepend warning to result content if present
      if (displayLockWarning) {
        const warningContent: McpContent = { type: 'text', text: displayLockWarning };
        return createResponse(id, {
          content: [warningContent, ...result.content],
          isError: result.isError,
        });
      }

      return createResponse(id, result);
    }

    default:
      return createError(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

// --- Startup ---

log('chrome-bridge MCP Server v1.0.0 running');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', async (line) => {
  if (!line.trim()) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify(
      createError(null, JSON_RPC_ERRORS.PARSE_ERROR, 'Parse error'),
    ) + '\n');
    return;
  }

  const validateResult = JsonRpcRequestSchema.safeParse(parsed);
  if (!validateResult.success) {
    const partial = parsed as { id?: unknown };
    const id = partial?.id != null ? (partial.id as string | number | null) : null;
    process.stdout.write(JSON.stringify(
      createError(id, JSON_RPC_ERRORS.PARSE_ERROR, `Invalid request: ${validateResult.error.message}`),
    ) + '\n');
    return;
  }

  const response = await handleRequest(validateResult.data);
  if (response) {
    process.stdout.write(JSON.stringify(response) + '\n');
  }
});

rl.on('close', () => process.exit(0));

process.on('SIGINT', () => { client.destroy(); process.exit(0); });
process.on('SIGTERM', () => { client.destroy(); process.exit(0); });
