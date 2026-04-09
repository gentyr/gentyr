/**
 * Chrome Actions -- High-Level Browser Automation API
 *
 * Wraps ChromeSocketClient with a clean typed API for direct use in test code.
 * All methods lazily initialize on first call (connect + tabsContext).
 */

import { ChromeSocketClient } from './client.js';
import {
  ChromeNotConnectedError,
  NavigationTimeoutError,
  ToolExecutionError,
} from './errors.js';
import type {
  ChromeActionsOptions,
  GifAction,
  GifExportOptions,
  McpContent,
  ScrollDirection,
  TabInfo,
  ToolResult,
} from './types.js';

export class ChromeActions {
  private readonly client: ChromeSocketClient;
  private activeTabId: number | null = null;
  private tabs: Map<number, TabInfo> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private readonly autoConnect: boolean;

  constructor(options: ChromeActionsOptions = {}) {
    const { autoConnect = true, ...clientOptions } = options;
    this.autoConnect = autoConnect;
    this.client = new ChromeSocketClient(clientOptions);
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Explicitly connect to the Chrome extension sockets.
   * Required when autoConnect is false.
   */
  async connect(): Promise<void> {
    await this.client.connect();
  }

  /**
   * Destroy the socket connection and clean up resources.
   */
  async destroy(): Promise<void> {
    this.client.destroy();
  }

  // ============================================================================
  // Lazy Initialization
  // ============================================================================

  private async ensureReady(): Promise<void> {
    if (this.initialized) return;

    // Deduplicate concurrent calls
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.initialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async initialize(): Promise<void> {
    if (this.autoConnect) {
      await this.client.connect();
    }

    const result = await this.client.executeTool('tabs_context_mcp', { createIfEmpty: true });
    if (result.isError) {
      throw new ToolExecutionError('tabs_context_mcp', result);
    }

    this.refreshTabsFromResult(result);

    // Set active tab to the first available tab
    if (this.activeTabId === null && this.tabs.size > 0) {
      this.activeTabId = Array.from(this.tabs.keys())[0]!;
    }

    this.initialized = true;
  }

  private refreshTabsFromResult(result: ToolResult): void {
    for (const item of result.content) {
      if (item.type !== 'text' || !item.text) continue;
      try {
        const parsed = JSON.parse(item.text) as unknown;
        const tabList = Array.isArray(parsed)
          ? parsed
          : (parsed !== null && typeof parsed === 'object' && 'availableTabs' in parsed)
            ? (parsed as { availableTabs: unknown }).availableTabs
            : undefined;

        if (Array.isArray(tabList)) {
          this.tabs.clear();
          for (const tab of tabList) {
            if (
              tab !== null &&
              typeof tab === 'object' &&
              'tabId' in tab &&
              typeof (tab as { tabId: unknown }).tabId === 'number'
            ) {
              const t = tab as { tabId: number; url?: string; title?: string };
              this.tabs.set(t.tabId, {
                tabId: t.tabId,
                url: t.url,
                title: t.title,
              });
            }
          }
        }
      } catch {
        // Not JSON or no tab data — skip
      }
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private resolveTabId(tabId?: number): number {
    const id = tabId ?? this.activeTabId;
    if (id === null) {
      throw new ChromeNotConnectedError('No active tab. Call tabsContext() first or provide an explicit tabId.');
    }
    return id;
  }

  private extractText(result: ToolResult, toolName: string): string {
    if (result.isError) {
      throw new ToolExecutionError(toolName, result);
    }
    return result.content
      .filter((c): c is McpContent & { text: string } => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }

  // ============================================================================
  // Tab Management
  // ============================================================================

  /**
   * Get context information about the current MCP tab group.
   */
  async tabsContext(opts?: { createIfEmpty?: boolean }): Promise<ToolResult> {
    await this.ensureReady();
    const result = await this.client.executeTool('tabs_context_mcp', {
      ...(opts?.createIfEmpty !== undefined ? { createIfEmpty: opts.createIfEmpty } : {}),
    });
    this.refreshTabsFromResult(result);
    return result;
  }

  /**
   * Create a new tab in the MCP tab group and make it the active tab.
   */
  async createTab(): Promise<number> {
    await this.ensureReady();
    const result = await this.client.executeTool('tabs_create_mcp', {});
    if (result.isError) {
      throw new ToolExecutionError('tabs_create_mcp', result);
    }

    // Refresh context to learn the new tab's ID
    const ctxResult = await this.client.executeTool('tabs_context_mcp', {});
    this.refreshTabsFromResult(ctxResult);

    // The new tab is the highest tabId we haven't seen before
    const newTabId = Array.from(this.tabs.keys()).reduce((max, id) => Math.max(max, id), -1);
    if (newTabId >= 0) {
      this.activeTabId = newTabId;
    }

    return this.activeTabId!;
  }

  /**
   * Switch the active tab to the given tabId.
   */
  useTab(tabId: number): void {
    this.activeTabId = tabId;
  }

  // ============================================================================
  // Navigation
  // ============================================================================

  /**
   * Navigate to a URL in the given (or active) tab.
   */
  async navigate(url: string, tabId?: number): Promise<string> {
    await this.ensureReady();
    const result = await this.client.executeTool('navigate', {
      url,
      tabId: this.resolveTabId(tabId),
    });
    return this.extractText(result, 'navigate');
  }

  /**
   * Go back in the browser history.
   */
  async goBack(tabId?: number): Promise<string> {
    return this.navigate('back', tabId);
  }

  /**
   * Go forward in the browser history.
   */
  async goForward(tabId?: number): Promise<string> {
    return this.navigate('forward', tabId);
  }

  // ============================================================================
  // Page Reading
  // ============================================================================

  /**
   * Get an accessibility tree representation of the page.
   */
  async readPage(opts?: {
    filter?: 'interactive' | 'all';
    depth?: number;
    refId?: string;
    maxChars?: number;
    tabId?: number;
  }): Promise<string> {
    await this.ensureReady();
    const args: Record<string, unknown> = {
      tabId: this.resolveTabId(opts?.tabId),
    };
    if (opts?.filter !== undefined) args['filter'] = opts.filter;
    if (opts?.depth !== undefined) args['depth'] = opts.depth;
    if (opts?.refId !== undefined) args['ref_id'] = opts.refId;
    if (opts?.maxChars !== undefined) args['max_chars'] = opts.maxChars;

    const result = await this.client.executeTool('read_page', args);
    return this.extractText(result, 'read_page');
  }

  /**
   * Extract raw text content from the page.
   */
  async getPageText(tabId?: number): Promise<string> {
    await this.ensureReady();
    const result = await this.client.executeTool('get_page_text', {
      tabId: this.resolveTabId(tabId),
    });
    return this.extractText(result, 'get_page_text');
  }

  /**
   * Set a value in a form element using its ref from read_page.
   */
  async formInput(ref: string, value: string | boolean | number, tabId?: number): Promise<string> {
    await this.ensureReady();
    const result = await this.client.executeTool('form_input', {
      ref,
      value,
      tabId: this.resolveTabId(tabId),
    });
    return this.extractText(result, 'form_input');
  }

  // ============================================================================
  // Computer Actions
  // ============================================================================

  /**
   * Click at the given coordinate or element ref.
   */
  async click(
    target: [number, number] | { ref: string },
    opts?: { modifiers?: string; tabId?: number },
  ): Promise<string> {
    await this.ensureReady();
    const args: Record<string, unknown> = {
      action: 'left_click',
      tabId: this.resolveTabId(opts?.tabId),
    };
    if (Array.isArray(target)) {
      args['coordinate'] = target;
    } else {
      args['ref'] = target.ref;
    }
    if (opts?.modifiers !== undefined) args['modifiers'] = opts.modifiers;
    const result = await this.client.executeTool('computer', args);
    return this.extractText(result, 'computer:left_click');
  }

  /**
   * Right-click at the given coordinate.
   */
  async rightClick(
    coordinate: [number, number],
    opts?: { modifiers?: string; tabId?: number },
  ): Promise<string> {
    await this.ensureReady();
    const args: Record<string, unknown> = {
      action: 'right_click',
      coordinate,
      tabId: this.resolveTabId(opts?.tabId),
    };
    if (opts?.modifiers !== undefined) args['modifiers'] = opts.modifiers;
    const result = await this.client.executeTool('computer', args);
    return this.extractText(result, 'computer:right_click');
  }

  /**
   * Double-click at the given coordinate.
   */
  async doubleClick(
    coordinate: [number, number],
    opts?: { modifiers?: string; tabId?: number },
  ): Promise<string> {
    await this.ensureReady();
    const args: Record<string, unknown> = {
      action: 'double_click',
      coordinate,
      tabId: this.resolveTabId(opts?.tabId),
    };
    if (opts?.modifiers !== undefined) args['modifiers'] = opts.modifiers;
    const result = await this.client.executeTool('computer', args);
    return this.extractText(result, 'computer:double_click');
  }

  /**
   * Triple-click at the given coordinate.
   */
  async tripleClick(
    coordinate: [number, number],
    opts?: { modifiers?: string; tabId?: number },
  ): Promise<string> {
    await this.ensureReady();
    const args: Record<string, unknown> = {
      action: 'triple_click',
      coordinate,
      tabId: this.resolveTabId(opts?.tabId),
    };
    if (opts?.modifiers !== undefined) args['modifiers'] = opts.modifiers;
    const result = await this.client.executeTool('computer', args);
    return this.extractText(result, 'computer:triple_click');
  }

  /**
   * Move the mouse to the given coordinate or element ref without clicking.
   */
  async hover(
    target: [number, number] | { ref: string },
    opts?: { tabId?: number },
  ): Promise<string> {
    await this.ensureReady();
    const args: Record<string, unknown> = {
      action: 'hover',
      tabId: this.resolveTabId(opts?.tabId),
    };
    if (Array.isArray(target)) {
      args['coordinate'] = target;
    } else {
      args['ref'] = target.ref;
    }
    const result = await this.client.executeTool('computer', args);
    return this.extractText(result, 'computer:hover');
  }

  /**
   * Type text at the current cursor position.
   */
  async type(text: string, opts?: { tabId?: number }): Promise<string> {
    await this.ensureReady();
    const result = await this.client.executeTool('computer', {
      action: 'type',
      text,
      tabId: this.resolveTabId(opts?.tabId),
    });
    return this.extractText(result, 'computer:type');
  }

  /**
   * Press a keyboard key or key combination.
   */
  async pressKey(
    key: string,
    opts?: { repeat?: number; modifiers?: string; tabId?: number },
  ): Promise<string> {
    await this.ensureReady();
    const args: Record<string, unknown> = {
      action: 'key',
      text: key,
      tabId: this.resolveTabId(opts?.tabId),
    };
    if (opts?.repeat !== undefined) args['repeat'] = opts.repeat;
    if (opts?.modifiers !== undefined) args['modifiers'] = opts.modifiers;
    const result = await this.client.executeTool('computer', args);
    return this.extractText(result, 'computer:key');
  }

  /**
   * Take a screenshot of the active tab and return the raw ToolResult
   * (contains image content).
   */
  async screenshot(tabId?: number): Promise<ToolResult> {
    await this.ensureReady();
    const result = await this.client.executeTool('computer', {
      action: 'screenshot',
      tabId: this.resolveTabId(tabId),
    });
    if (result.isError) {
      throw new ToolExecutionError('computer:screenshot', result);
    }
    return result;
  }

  /**
   * Scroll at the given coordinate in the given direction.
   */
  async scroll(
    coordinate: [number, number],
    direction: ScrollDirection,
    opts?: { amount?: number; tabId?: number },
  ): Promise<string> {
    await this.ensureReady();
    const args: Record<string, unknown> = {
      action: 'scroll',
      coordinate,
      scroll_direction: direction,
      tabId: this.resolveTabId(opts?.tabId),
    };
    if (opts?.amount !== undefined) args['scroll_amount'] = opts.amount;
    const result = await this.client.executeTool('computer', args);
    return this.extractText(result, 'computer:scroll');
  }

  /**
   * Scroll an element into view using its ref.
   */
  async scrollTo(
    target: [number, number] | { ref: string },
    tabId?: number,
  ): Promise<string> {
    await this.ensureReady();
    // scroll_to requires a ref — coordinates are not supported by this action
    if (Array.isArray(target)) {
      // Scroll to a coordinate by scrolling at that position (best effort)
      const result = await this.client.executeTool('computer', {
        action: 'scroll',
        coordinate: target,
        scroll_direction: 'down',
        scroll_amount: 0,
        tabId: this.resolveTabId(tabId),
      });
      return this.extractText(result, 'computer:scroll_to');
    }
    const result = await this.client.executeTool('computer', {
      action: 'scroll_to',
      ref: target.ref,
      tabId: this.resolveTabId(tabId),
    });
    return this.extractText(result, 'computer:scroll_to');
  }

  /**
   * Drag from one coordinate to another.
   */
  async drag(
    from: [number, number],
    to: [number, number],
    tabId?: number,
  ): Promise<string> {
    await this.ensureReady();
    const result = await this.client.executeTool('computer', {
      action: 'left_click_drag',
      start_coordinate: from,
      coordinate: to,
      tabId: this.resolveTabId(tabId),
    });
    return this.extractText(result, 'computer:left_click_drag');
  }

  /**
   * Zoom into a rectangular region of the page for closer inspection.
   */
  async zoom(
    region: [number, number, number, number],
    tabId?: number,
  ): Promise<ToolResult> {
    await this.ensureReady();
    const result = await this.client.executeTool('computer', {
      action: 'zoom',
      region,
      tabId: this.resolveTabId(tabId),
    });
    if (result.isError) {
      throw new ToolExecutionError('computer:zoom', result);
    }
    return result;
  }

  /**
   * Wait for the given number of seconds.
   */
  async wait(seconds: number, tabId?: number): Promise<string> {
    await this.ensureReady();
    const result = await this.client.executeTool('computer', {
      action: 'wait',
      duration: seconds,
      tabId: this.resolveTabId(tabId),
    });
    return this.extractText(result, 'computer:wait');
  }

  // ============================================================================
  // JavaScript
  // ============================================================================

  /**
   * Execute JavaScript code in the page context.
   */
  async executeJs(code: string, tabId?: number): Promise<string> {
    await this.ensureReady();
    const result = await this.client.executeTool('javascript_tool', {
      action: 'javascript_exec',
      text: code,
      tabId: this.resolveTabId(tabId),
    });
    return this.extractText(result, 'javascript_tool');
  }

  // ============================================================================
  // Console / Network
  // ============================================================================

  /**
   * Read browser console messages from a tab.
   */
  async readConsoleMessages(opts?: {
    tabId?: number;
    onlyErrors?: boolean;
    clear?: boolean;
    pattern?: string;
    limit?: number;
  }): Promise<string> {
    await this.ensureReady();
    const args: Record<string, unknown> = {
      tabId: this.resolveTabId(opts?.tabId),
    };
    if (opts?.onlyErrors !== undefined) args['onlyErrors'] = opts.onlyErrors;
    if (opts?.clear !== undefined) args['clear'] = opts.clear;
    if (opts?.pattern !== undefined) args['pattern'] = opts.pattern;
    if (opts?.limit !== undefined) args['limit'] = opts.limit;
    const result = await this.client.executeTool('read_console_messages', args);
    return this.extractText(result, 'read_console_messages');
  }

  /**
   * Read HTTP network requests from a tab.
   */
  async readNetworkRequests(opts?: {
    tabId?: number;
    urlPattern?: string;
    clear?: boolean;
    limit?: number;
  }): Promise<string> {
    await this.ensureReady();
    const args: Record<string, unknown> = {
      tabId: this.resolveTabId(opts?.tabId),
    };
    if (opts?.urlPattern !== undefined) args['urlPattern'] = opts.urlPattern;
    if (opts?.clear !== undefined) args['clear'] = opts.clear;
    if (opts?.limit !== undefined) args['limit'] = opts.limit;
    const result = await this.client.executeTool('read_network_requests', args);
    return this.extractText(result, 'read_network_requests');
  }

  // ============================================================================
  // Window
  // ============================================================================

  /**
   * Resize the browser window.
   */
  async resizeWindow(width: number, height: number, tabId?: number): Promise<string> {
    await this.ensureReady();
    const result = await this.client.executeTool('resize_window', {
      width,
      height,
      tabId: this.resolveTabId(tabId),
    });
    return this.extractText(result, 'resize_window');
  }

  // ============================================================================
  // GIF Recording
  // ============================================================================

  /**
   * Control GIF recording for the current tab group.
   */
  async gif(
    action: GifAction,
    opts?: {
      tabId?: number;
      download?: boolean;
      filename?: string;
      options?: GifExportOptions;
    },
  ): Promise<string> {
    await this.ensureReady();
    const args: Record<string, unknown> = {
      action,
      tabId: this.resolveTabId(opts?.tabId),
    };
    if (opts?.download !== undefined) args['download'] = opts.download;
    if (opts?.filename !== undefined) args['filename'] = opts.filename;
    if (opts?.options !== undefined) args['options'] = opts.options;
    const result = await this.client.executeTool('gif_creator', args);
    return this.extractText(result, 'gif_creator');
  }

  // ============================================================================
  // Image Upload
  // ============================================================================

  /**
   * Upload a previously captured screenshot or user-uploaded image.
   */
  async uploadImage(
    imageId: string,
    opts?: {
      tabId?: number;
      ref?: string;
      coordinate?: [number, number];
      filename?: string;
    },
  ): Promise<string> {
    await this.ensureReady();
    const args: Record<string, unknown> = {
      imageId,
      tabId: this.resolveTabId(opts?.tabId),
    };
    if (opts?.ref !== undefined) args['ref'] = opts.ref;
    if (opts?.coordinate !== undefined) args['coordinate'] = opts.coordinate;
    if (opts?.filename !== undefined) args['filename'] = opts.filename;
    const result = await this.client.executeTool('upload_image', args);
    return this.extractText(result, 'upload_image');
  }

  // ============================================================================
  // Shortcuts
  // ============================================================================

  /**
   * List all available shortcuts and workflows.
   */
  async listShortcuts(tabId?: number): Promise<string> {
    await this.ensureReady();
    const result = await this.client.executeTool('shortcuts_list', {
      tabId: this.resolveTabId(tabId),
    });
    return this.extractText(result, 'shortcuts_list');
  }

  /**
   * Execute a shortcut or workflow.
   */
  async executeShortcut(opts?: {
    tabId?: number;
    shortcutId?: string;
    command?: string;
  }): Promise<string> {
    await this.ensureReady();
    const args: Record<string, unknown> = {
      tabId: this.resolveTabId(opts?.tabId),
    };
    if (opts?.shortcutId !== undefined) args['shortcutId'] = opts.shortcutId;
    if (opts?.command !== undefined) args['command'] = opts.command;
    const result = await this.client.executeTool('shortcuts_execute', args);
    return this.extractText(result, 'shortcuts_execute');
  }

  // ============================================================================
  // Plan / Browser
  // ============================================================================

  /**
   * Present a plan to the user for domain approval before taking actions.
   */
  async updatePlan(domains: string[], approach: string[]): Promise<string> {
    await this.ensureReady();
    const result = await this.client.executeTool('update_plan', { domains, approach });
    return this.extractText(result, 'update_plan');
  }

  /**
   * Switch which Chrome browser is used for automation.
   */
  async switchBrowser(): Promise<string> {
    await this.ensureReady();
    const result = await this.client.executeTool('switch_browser', {});
    return this.extractText(result, 'switch_browser');
  }

  // ============================================================================
  // Convenience Methods
  // ============================================================================

  /**
   * Wait until the active tab's URL matches the given pattern.
   * Throws NavigationTimeoutError after timeoutMs.
   */
  async waitForUrl(
    pattern: string | RegExp,
    opts?: { timeoutMs?: number; pollIntervalMs?: number; tabId?: number },
  ): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const pollIntervalMs = opts?.pollIntervalMs ?? 1_000;
    const tabId = opts?.tabId ?? this.activeTabId;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const ctxResult = await this.tabsContext();

      // Check URL of the relevant tab
      if (tabId !== null) {
        const tab = this.tabs.get(tabId);
        if (tab?.url) {
          const matches = typeof pattern === 'string'
            ? tab.url.includes(pattern)
            : pattern.test(tab.url);
          if (matches) return;
        }
      } else {
        // No specific tab — check active tab from context
        for (const tab of this.tabs.values()) {
          if (tab.url) {
            const matches = typeof pattern === 'string'
              ? tab.url.includes(pattern)
              : pattern.test(tab.url);
            if (matches) return;
          }
        }
      }

      if (ctxResult.isError) {
        throw new ToolExecutionError('tabs_context_mcp', ctxResult);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
    }

    throw new NavigationTimeoutError(pattern, timeoutMs);
  }

  /**
   * Take a screenshot and return the base64 data and MIME type.
   */
  async getScreenshot(tabId?: number): Promise<{ data: string; mimeType: string }> {
    const result = await this.screenshot(tabId);
    const imageContent = result.content.find(
      (c): c is McpContent & { data: string; mimeType: string } =>
        c.type === 'image' && typeof c.data === 'string',
    );
    if (!imageContent) {
      throw new ToolExecutionError('computer:screenshot', result);
    }
    return {
      data: imageContent.data,
      mimeType: imageContent.mimeType ?? 'image/png',
    };
  }

  /**
   * Pause execution for the given number of milliseconds.
   */
  async settle(ms: number): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, ms));
  }

  // ============================================================================
  // Internal Helpers
}
