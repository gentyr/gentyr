/**
 * Chrome Actions -- Low-Level Socket Client
 *
 * Clean rewrite of ChromeBridgeClient from packages/mcp-servers/src/chrome-bridge/server.ts.
 * Communicates with the Claude Chrome Extension via its Unix domain socket bridge.
 *
 * Protocol: Length-prefixed JSON (4-byte LE uint32 length + UTF-8 JSON payload)
 */

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  ChromeRequest,
  ChromeResponse,
  McpContent,
  ToolResult,
  ChromeSocketClientOptions,
} from './types.js';
import { ChromeNotConnectedError } from './errors.js';

export class ChromeSocketClient {
  private connections = new Map<string, net.Socket>();
  private reconnectAttempts = new Map<string, number>();
  private requestQueues = new Map<string, Promise<void>>();
  private tabRoutes = new Map<number, string>(); // tabId -> socketPath
  private readonly socketDir: string;
  private readonly clientId: string;
  private readonly toolTimeoutMs: number;
  private readonly tabsContextTimeoutMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;

  constructor(options: ChromeSocketClientOptions = {}) {
    this.clientId = options.clientId ?? 'gentyr-chrome-actions';
    this.toolTimeoutMs = options.toolTimeoutMs ?? 120_000;
    this.tabsContextTimeoutMs = options.tabsContextTimeoutMs ?? 2_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 100;
    this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? 100;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;

    const username = os.userInfo().username || 'default';
    this.socketDir = path.join('/tmp', `claude-mcp-browser-bridge-${username}`);
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

  /**
   * Discover and connect to all available Chrome extension sockets.
   * Must be called before any tool execution.
   */
  async connect(): Promise<void> {
    const sockets = this.discoverSockets();
    if (sockets.length === 0) {
      throw new ChromeNotConnectedError(
        `No Chrome extension sockets found in ${this.socketDir}. Make sure Chrome is running with the Claude extension installed.`,
      );
    }
    const connectPromises: Promise<void>[] = [];
    for (const socketPath of sockets) {
      if (!this.connections.has(socketPath)) {
        connectPromises.push(this.connectSocket(socketPath));
      }
    }
    await Promise.all(connectPromises);
  }

  private connectSocket(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);

      const onConnect = () => {
        socket.removeListener('error', onConnectError);
        this.connections.set(socketPath, socket);
        this.reconnectAttempts.set(socketPath, 0);

        // Set up persistent error and close handlers after connect
        socket.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code && ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOENT'].includes(err.code)) {
            // Expected — handled by close event
          }
          // Other errors are silently ignored to prevent unhandled error events
        });

        socket.on('close', () => {
          this.connections.delete(socketPath);
          this.scheduleReconnect(socketPath);
        });

        resolve();
      };

      const onConnectError = (err: Error) => {
        socket.removeListener('connect', onConnect);
        reject(err);
      };

      socket.once('connect', onConnect);
      socket.once('error', onConnectError);
    });
  }

  private scheduleReconnect(socketPath: string): void {
    const attempts = this.reconnectAttempts.get(socketPath) ?? 0;
    if (attempts >= this.maxReconnectAttempts) {
      this.reconnectAttempts.delete(socketPath);
      // Remove stale tab routes for this socket
      for (const [tabId, sp] of this.tabRoutes) {
        if (sp === socketPath) {
          this.tabRoutes.delete(tabId);
        }
      }
      return;
    }

    const delay = Math.min(
      this.baseReconnectDelayMs * Math.pow(1.5, attempts),
      this.maxReconnectDelayMs,
    );
    this.reconnectAttempts.set(socketPath, attempts + 1);

    setTimeout(() => {
      if (!fs.existsSync(socketPath)) {
        this.reconnectAttempts.delete(socketPath);
        return;
      }
      // Reconnect silently (best-effort background reconnect)
      this.connectSocket(socketPath).catch(() => {
        // If reconnect fails, scheduleReconnect will be called again from the close handler
        // once the socket is finally connected (or after max attempts)
      });
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

  private readResponse(socket: net.Socket, timeoutMs: number): Promise<ChromeResponse> {
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
            const parsed = JSON.parse(jsonBuf.toString('utf-8')) as Record<string, unknown>;
            // Skip notifications (have method but no result/error)
            if ('method' in parsed && !('result' in parsed) && !('error' in parsed)) {
              continue;
            }
            cleanup();
            resolve(parsed as unknown as ChromeResponse);
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
  ): Promise<ChromeResponse> {
    const socket = this.connections.get(socketPath);
    if (!socket || socket.destroyed) {
      throw new ChromeNotConnectedError(`Socket not connected: ${path.basename(socketPath)}`);
    }

    const request: ChromeRequest = {
      method: 'execute_tool',
      params: {
        client_id: this.clientId,
        tool: toolName,
        args,
      },
    };

    const timeoutMs = toolName === 'tabs_context_mcp'
      ? this.tabsContextTimeoutMs
      : this.toolTimeoutMs;

    socket.write(this.encodeMessage(request));
    return this.readResponse(socket, timeoutMs);
  }

  /** Serialize requests per socket to prevent response interleaving */
  private async executeOnSocketSerialized(
    socketPath: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ChromeResponse> {
    const previous = this.requestQueues.get(socketPath) ?? Promise.resolve();
    let resolveQueue!: () => void;
    const current = new Promise<void>((r) => { resolveQueue = r; });
    this.requestQueues.set(socketPath, current);

    await previous;
    try {
      return await this.executeOnSocket(socketPath, toolName, args);
    } finally {
      resolveQueue();
    }
  }

  private async executeTabsContext(args: Record<string, unknown>): Promise<ToolResult> {
    const socketPaths = Array.from(this.connections.keys());

    if (socketPaths.length === 1) {
      const response = await this.executeOnSocketSerialized(socketPaths[0]!, 'tabs_context_mcp', args);
      const result = this.normalizeResponse(response);
      this.updateTabRoutes(result.content, socketPaths[0]!);
      return result;
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

  /**
   * Execute a named tool with the given arguments.
   * Throws ChromeNotConnectedError if not connected.
   */
  async executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.connections.size === 0) {
      // Attempt lazy rediscovery
      const sockets = this.discoverSockets();
      if (sockets.length === 0) {
        throw new ChromeNotConnectedError();
      }
      // Try to connect newly found sockets
      await Promise.allSettled(
        sockets
          .filter((sp) => !this.connections.has(sp))
          .map((sp) => this.connectSocket(sp)),
      );

      if (this.connections.size === 0) {
        throw new ChromeNotConnectedError();
      }
    }

    if (toolName === 'tabs_context_mcp') {
      return this.executeTabsContext(args);
    }

    const tabId = typeof args['tabId'] === 'number' ? args['tabId'] : undefined;

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
      throw new ChromeNotConnectedError('No connected sockets available');
    }

    // Inject a tabId for tools that lack one so the extension can anchor its UI
    let effectiveArgs = args;
    if (tabId === undefined) {
      for (const [knownTabId, socketPath] of this.tabRoutes) {
        if (socketPath === targetSocket) {
          effectiveArgs = { ...args, tabId: knownTabId };
          break;
        }
      }
    }

    const response = await this.executeOnSocketSerialized(targetSocket, toolName, effectiveArgs);
    return this.normalizeResponse(response);
  }

  private updateTabRoutes(content: McpContent[], socketPath: string): void {
    for (const item of content) {
      if (item.type !== 'text' || !item.text) continue;
      try {
        const parsed = JSON.parse(item.text) as unknown;
        const tabs = Array.isArray(parsed)
          ? parsed
          : (parsed !== null && typeof parsed === 'object' && 'availableTabs' in parsed)
            ? (parsed as { availableTabs: unknown }).availableTabs
            : undefined;
        if (Array.isArray(tabs)) {
          for (const tab of tabs) {
            if (
              tab !== null &&
              typeof tab === 'object' &&
              'tabId' in tab &&
              typeof (tab as { tabId: unknown }).tabId === 'number'
            ) {
              const t = tab as { tabId: number; url?: unknown };
              this.tabRoutes.set(t.tabId, socketPath);
            }
          }
        }
      } catch {
        // Not JSON or no tab data - skip
      }
    }
  }

  private normalizeResponse(response: ChromeResponse): ToolResult {
    if ('error' in response && response.error) {
      const rawErrorContent = response.error.content;
      const content = Array.isArray(rawErrorContent)
        ? rawErrorContent
        : rawErrorContent != null
          ? [rawErrorContent]
          : [];
      return {
        content: content.map((c) =>
          typeof c === 'object' && c !== null && 'type' in c
            ? (c as McpContent)
            : { type: 'text', text: String(c) },
        ),
        isError: true,
      };
    }

    if ('result' in response && response.result) {
      const rawContent = response.result.content;
      const content = Array.isArray(rawContent)
        ? rawContent
        : rawContent != null
          ? [rawContent]
          : [];
      return {
        content: content.map((c) => {
          if (typeof c === 'object' && c !== null && 'type' in c) {
            const item = c as McpContent;
            // Flatten image source into top-level data/mimeType fields
            if (
              item.type === 'image' &&
              typeof item.source === 'object' &&
              item.source !== null &&
              'data' in item.source
            ) {
              return {
                type: 'image',
                data: item.source.data,
                mimeType: item.source.media_type ?? 'image/png',
              };
            }
            return item;
          }
          return { type: 'text', text: String(c) };
        }),
      };
    }

    return { content: [{ type: 'text', text: 'Empty response from Chrome extension' }] };
  }

  /**
   * Close all socket connections and clean up all state.
   */
  destroy(): void {
    for (const socket of this.connections.values()) {
      socket.removeAllListeners();
      socket.end();
      socket.destroy();
    }
    this.connections.clear();
    this.tabRoutes.clear();
    this.requestQueues.clear();
    this.reconnectAttempts.clear();
  }
}
