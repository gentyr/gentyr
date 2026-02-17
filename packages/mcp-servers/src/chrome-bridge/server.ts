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

// ============================================================================
// Chrome Bridge Socket Client
// ============================================================================

class ChromeBridgeClient {
  private connections = new Map<string, net.Socket>();
  private reconnectAttempts = new Map<string, number>();
  private requestQueues = new Map<string, Promise<void>>();
  private tabRoutes = new Map<number, string>(); // tabId -> socketPath
  private tabUrls = new Map<number, string>(); // tabId -> last known URL
  private readonly socketDir: string;

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
      // Remove stale tab routes
      for (const [tabId, sp] of this.tabRoutes) {
        if (sp === socketPath) this.tabRoutes.delete(tabId);
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
      return {
        content: [{
          type: 'text',
          text: 'Chrome extension not connected. Make sure Chrome is running with the Claude extension installed.',
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
          log(`Content script missing on tab ${tabId}, reloading ${cachedUrl} and retrying...`);
          try {
            await this.executeOnSocketSerialized(targetSocket, 'navigate', { url: cachedUrl, tabId });
            await new Promise((r) => setTimeout(r, 2000));
            const retryResponse = await this.executeOnSocketSerialized(targetSocket, toolName, args);
            return this.normalizeResponse(retryResponse);
          } catch {
            // Retry failed, fall through to return the original error
          }
        }
      }

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
    name: 'find',
    description: 'Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content (e.g., "organic mango product"). Returns up to 20 matching elements with references that can be used with other tools. If more than 20 matches exist, you\'ll be notified to use a more specific query. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to search in. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
        },
      },
      required: ['query', 'tabId'],
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
];

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

      const result = await client.executeTool(name, args ?? {});
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
