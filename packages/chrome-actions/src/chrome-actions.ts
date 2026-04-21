/**
 * Chrome Actions -- High-Level Browser Automation API
 *
 * Wraps ChromeSocketClient with a clean typed API for direct use in test code.
 * All methods lazily initialize on first call (connect + tabsContext).
 */

import { ChromeSocketClient } from './client.js';
import {
  ChromeNotConnectedError,
  ElementNotFoundError,
  NavigationTimeoutError,
  ToolExecutionError,
} from './errors.js';
import type {
  ChromeActionsOptions,
  ClickAndWaitResult,
  InspectInputResult,
  PageDiagnosticResult,
  ReactFillResult,
  TreeElement,
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
  // Deterministic Element Finding (accessibility tree parsing, no LLM)
  // ============================================================================

  /**
   * Parse the accessibility tree text from readPage() into structured elements.
   */
  private parseAccessibilityTree(tree: string): TreeElement[] {
    const elements: TreeElement[] = [];
    // Each line: optional indent, role, "text label", [ref_N], optional attributes
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

  /**
   * Find elements on the page by matching text, role, or attributes (case-insensitive substring).
   * Deterministic — uses readPage() accessibility tree, no LLM.
   */
  async findElements(
    query: string,
    opts?: { filter?: 'interactive' | 'all'; tabId?: number },
  ): Promise<TreeElement[]> {
    await this.ensureReady();
    const tree = await this.readPage({
      filter: opts?.filter ?? 'interactive',
      tabId: opts?.tabId,
    });
    const parsed = this.parseAccessibilityTree(tree);
    const q = query.toLowerCase();
    return parsed.filter(
      (el) =>
        el.text.toLowerCase().includes(q) ||
        el.role.toLowerCase().includes(q) ||
        el.attributes.toLowerCase().includes(q),
    );
  }

  /**
   * Find an element by text, scroll it into view, and click it.
   * Deterministic — uses readPage() accessibility tree, no LLM.
   * Throws ElementNotFoundError if no match is found.
   */
  async clickByText(text: string, opts?: { tabId?: number }): Promise<void> {
    const matches = await this.findElements(text, { tabId: opts?.tabId });
    if (matches.length === 0) {
      throw new ElementNotFoundError(text);
    }
    const ref = matches[0].ref;
    const tabId = this.resolveTabId(opts?.tabId);
    await this.scrollTo({ ref }, tabId);
    await this.click({ ref }, { tabId });
  }

  /**
   * Find an input element by label/placeholder and fill it with a value.
   * Deterministic — uses readPage() accessibility tree, no LLM.
   * Throws ElementNotFoundError if no matching input is found.
   */
  async fillInput(
    labelOrPlaceholder: string,
    value: string | boolean | number,
    opts?: { tabId?: number },
  ): Promise<void> {
    const INPUT_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton', 'slider']);
    const matches = await this.findElements(labelOrPlaceholder, { tabId: opts?.tabId });
    const input = matches.find((el) => INPUT_ROLES.has(el.role));
    if (!input) {
      throw new ElementNotFoundError(labelOrPlaceholder);
    }
    await this.formInput(input.ref, value, this.resolveTabId(opts?.tabId));
  }

  /**
   * Wait until an element matching the query appears on the page.
   * Deterministic — polls readPage() accessibility tree, no LLM.
   * Throws NavigationTimeoutError after timeoutMs.
   */
  async waitForElement(
    query: string,
    opts?: { timeoutMs?: number; pollIntervalMs?: number; tabId?: number },
  ): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const pollIntervalMs = opts?.pollIntervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const matches = await this.findElements(query, { tabId: opts?.tabId });
        if (matches.length > 0) return;
      } catch (err) {
        if (!(err instanceof ElementNotFoundError) && !(err instanceof ToolExecutionError)) {
          throw err;
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
    }

    throw new NavigationTimeoutError(query, timeoutMs);
  }

  // ============================================================================
  // React Automation Tools
  // ============================================================================

  /**
   * Fill a React controlled input using the native setter + _valueTracker reset
   * + direct onChange call pattern. Works with React 15+ controlled components
   * where form_input / fillInput fail silently because React's _valueTracker
   * doesn't detect the value change.
   *
   * Includes optional readback verification (default: on) that confirms the
   * value landed in both DOM and React state.
   *
   * @param selector - CSS selector for the input element
   * @param value - Value to fill
   * @param opts - Options: verify (default true), tabId
   */
  async reactFillInput(
    selector: string,
    value: string,
    opts?: { verify?: boolean; tabId?: number },
  ): Promise<ReactFillResult> {
    await this.ensureReady();
    const verify = opts?.verify !== false;

    // Execute the React-aware fill JS directly via javascript_tool (MAIN world).
    // Uses the native setter + _valueTracker reset + direct onChange call + event dispatch
    // pattern to reliably update React controlled inputs.
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
      } catch (e) {}
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

    const fillText = await this.executeJs(fillCode, opts?.tabId);
    const fillParsed = JSON.parse(fillText);

    if (!fillParsed.success) {
      return { success: false, selector, ...fillParsed };
    }

    let verifyResult: ReactFillResult['verify'] | undefined;
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

      try {
        const verifyText = await this.executeJs(verifyCode, opts?.tabId);
        verifyResult = JSON.parse(verifyText);
      } catch {
        // Verification is best-effort — fill already succeeded
      }
    }

    return {
      success: true,
      selector,
      domValueLength: fillParsed.domValueLength,
      trackerReset: fillParsed.trackerReset,
      onChangeCalled: fillParsed.onChangeCalled,
      hasReactProps: fillParsed.hasReactProps,
      ...(verifyResult ? { verify: verifyResult } : {}),
    };
  }

  /**
   * Click an element and wait for a page transition (URL change, content change,
   * element appear/disappear). Collapses the common 3-step pattern
   * (click → sleep → check) into one atomic call.
   *
   * Exactly one of text/selector/submit must be provided for the click target.
   * At least one waitFor* condition should be provided for the wait phase.
   *
   * @param opts - Click target + wait conditions
   */
  async clickAndWait(opts: {
    text?: string;
    selector?: string;
    submit?: boolean;
    tabId?: number;
    waitForUrl?: string;
    waitForUrlGone?: string;
    waitForText?: string;
    waitForTextGone?: string;
    waitForElement?: string;
    waitForElementGone?: string;
    timeoutMs?: number;
    settleMs?: number;
  }): Promise<ClickAndWaitResult> {
    await this.ensureReady();
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const settleMs = opts.settleMs ?? 1_000;
    let clickTarget = '';
    let clickMethod: 'text' | 'selector' | 'submit' = 'text';

    // --- Click phase ---
    if (opts.text) {
      clickMethod = 'text';
      clickTarget = opts.text;
      await this.clickByText(opts.text, { tabId: opts.tabId });
    } else if (opts.selector) {
      clickMethod = 'selector';
      clickTarget = opts.selector;
      // Use javascript_tool for native .click() — handles React synthetic events
      await this.executeJs(
        `(function(sel) {
  var el = document.querySelector(sel);
  if (!el) throw new Error('No element for selector: ' + sel);
  el.click();
  return 'clicked';
})(${JSON.stringify(opts.selector)})`,
        opts.tabId,
      );
    } else if (opts.submit) {
      clickMethod = 'submit';
      // Cascading submit button finder — form first, then document-wide fallback
      const submitResult = await this.executeJs(
        `(function() {
  var form = document.querySelector('form');
  var btn = null;
  if (form) {
    btn = form.querySelector('[type="submit"]')
      || form.querySelector('button:not([type])')
      || form.querySelector('button');
  }
  if (!btn) btn = document.querySelector('[type="submit"]');
  if (!btn) btn = document.querySelector('button:not([type="reset"]):not([type="button"])');
  if (!btn) return JSON.stringify({ clicked: false, error: 'no-submit-button' });
  var text = (btn.textContent || '').trim().slice(0, 50);
  btn.click();
  return JSON.stringify({ clicked: true, text: text });
})()`,
        opts.tabId,
      );
      const parsed = JSON.parse(submitResult);
      if (!parsed.clicked) {
        return { clicked: false, clickTarget: '', clickMethod: 'submit' };
      }
      clickTarget = parsed.text || '[submit]';
    } else {
      return { clicked: false, clickTarget: '', clickMethod: 'text' };
    }

    // --- Wait phase ---
    const hasWaitCondition = opts.waitForUrl || opts.waitForUrlGone ||
      opts.waitForText || opts.waitForTextGone ||
      opts.waitForElement || opts.waitForElementGone;

    if (!hasWaitCondition) {
      return { clicked: true, clickTarget, clickMethod };
    }

    await new Promise((r) => setTimeout(r, settleMs));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let allMet = true;

      if (opts.waitForUrl || opts.waitForUrlGone) {
        const url = await this.executeJs('window.location.href', opts.tabId);
        if (opts.waitForUrl && !url.includes(opts.waitForUrl)) allMet = false;
        if (opts.waitForUrlGone && url.includes(opts.waitForUrlGone)) allMet = false;
      }

      if (allMet && (opts.waitForText || opts.waitForTextGone)) {
        try {
          const pageText = await this.getPageText(opts.tabId);
          if (opts.waitForText && !pageText.includes(opts.waitForText)) allMet = false;
          if (opts.waitForTextGone && pageText.includes(opts.waitForTextGone)) allMet = false;
        } catch {
          allMet = false; // Page may be loading
        }
      }

      if (allMet && (opts.waitForElement || opts.waitForElementGone)) {
        try {
          const matches = opts.waitForElement
            ? await this.findElements(opts.waitForElement, { tabId: opts.tabId })
            : [];
          const goneMatches = opts.waitForElementGone
            ? await this.findElements(opts.waitForElementGone, { tabId: opts.tabId })
            : [];
          if (opts.waitForElement && matches.length === 0) allMet = false;
          if (opts.waitForElementGone && goneMatches.length > 0) allMet = false;
        } catch {
          allMet = false;
        }
      }

      if (allMet) {
        const finalUrl = await this.executeJs('window.location.href', opts.tabId);
        return {
          clicked: true,
          clickTarget,
          clickMethod,
          transitioned: true,
          finalUrl,
          elapsedMs: Date.now() + timeoutMs - deadline + settleMs,
        };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(1_000, remaining)));
    }

    const finalUrl = await this.executeJs('window.location.href', opts.tabId);
    return {
      clicked: true,
      clickTarget,
      clickMethod,
      transitioned: false,
      finalUrl,
      elapsedMs: timeoutMs + settleMs,
    };
  }

  /**
   * Comprehensive page state dump for debugging automation failures.
   * Returns all inputs, forms, and buttons with their React state indicators
   * (_valueTracker, __reactProps, onChange handlers) in one call.
   *
   * Never returns raw password values — only value.length.
   *
   * @param opts - Focus area: "inputs" (default), "forms", "buttons", "all"
   */
  async pageDiagnostic(opts?: {
    focus?: 'inputs' | 'forms' | 'buttons' | 'all';
    tabId?: number;
  }): Promise<PageDiagnosticResult> {
    await this.ensureReady();
    const focus = opts?.focus ?? 'inputs';
    const includeInputs = focus === 'inputs' || focus === 'all';
    const includeForms = focus === 'forms' || focus === 'all';
    const includeButtons = focus === 'buttons' || focus === 'all';

    const diagCode = `(function(opts) {
  var result = { url: window.location.href, title: document.title };
  if (opts.inputs) {
    result.inputs = Array.from(document.querySelectorAll('input, textarea, select')).map(function(el) {
      var isPassword = el.type === 'password';
      var handlerKey = Object.keys(el).find(function(k) {
        return k.indexOf('__reactEventHandlers') === 0 || k.indexOf('__reactProps') === 0;
      });
      return {
        tag: el.tagName.toLowerCase(), type: el.type || null,
        name: el.name || null, id: el.id || null,
        placeholder: el.placeholder || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        disabled: el.disabled, readOnly: el.readOnly || false,
        valueLength: el.value ? el.value.length : 0,
        isPassword: isPassword,
        hasValueTracker: !!el._valueTracker,
        trackerValue: isPassword ? '[redacted]' : (el._valueTracker ? el._valueTracker.getValue() : null),
        hasReactProps: !!handlerKey,
        hasOnChange: handlerKey && el[handlerKey] && typeof el[handlerKey].onChange === 'function' ? true : false,
        cssSelector: el.id ? '#' + el.id : (el.name ? el.tagName.toLowerCase() + '[name="' + el.name + '"]' : null)
      };
    });
  }
  if (opts.forms) {
    result.forms = Array.from(document.querySelectorAll('form')).map(function(form) {
      return {
        id: form.id || null, action: form.action || null, method: form.method || null,
        inputCount: form.querySelectorAll('input, textarea, select').length,
        submitButtonCount: form.querySelectorAll('[type="submit"], button:not([type])').length
      };
    });
  }
  if (opts.buttons) {
    result.buttons = Array.from(document.querySelectorAll('button, [type="submit"], [role="button"]')).map(function(el) {
      return {
        tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || null,
        text: (el.textContent || '').trim().slice(0, 50),
        disabled: el.disabled || false,
        id: el.id || null
      };
    });
  }
  return JSON.stringify(result);
})({ inputs: ${includeInputs}, forms: ${includeForms}, buttons: ${includeButtons} })`;

    const text = await this.executeJs(diagCode, opts?.tabId);
    return JSON.parse(text) as PageDiagnosticResult;
  }

  /**
   * Deep inspection of a single input element — DOM value, React internal value,
   * _valueTracker state, available handlers. The "why didn't my fill work?" tool.
   *
   * @param selector - CSS selector for the input
   * @param opts - tabId
   */
  async inspectInput(
    selector: string,
    opts?: { tabId?: number },
  ): Promise<InspectInputResult> {
    await this.ensureReady();

    const inspectCode = `(function(sel) {
  var el = document.querySelector(sel);
  if (!el) return JSON.stringify({ found: false, selector: sel });
  var isPassword = el.type === 'password';
  var tracker = el._valueTracker;
  var trackerValue = tracker ? tracker.getValue() : null;
  var reactKeys = Object.keys(el).filter(function(k) { return k.indexOf('__react') === 0; });
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
  return JSON.stringify({
    found: true, selector: sel,
    tag: el.tagName.toLowerCase(), type: el.type || null,
    name: el.name || null, id: el.id || null,
    disabled: el.disabled, readOnly: el.readOnly || false,
    isPassword: isPassword,
    domValue: isPassword ? undefined : el.value,
    domValueLength: el.value ? el.value.length : 0,
    hasValueTracker: !!tracker,
    trackerValue: isPassword ? '[redacted]' : trackerValue,
    reactKeys: reactKeys, handlerKey: handlerKey || null,
    hasOnChange: hasOnChange,
    reactControlledValue: isPassword ? '[redacted]' : reactControlledValue,
    isControlled: reactControlledValue !== null,
    hasNativeSetter: hasNativeSetter,
    inForm: !!el.closest('form')
  });
})(${JSON.stringify(selector)})`;

    const text = await this.executeJs(inspectCode, opts?.tabId);
    const parsed = JSON.parse(text) as InspectInputResult;

    if (!parsed.found) {
      throw new ElementNotFoundError(selector);
    }

    return parsed;
  }

  // ============================================================================
  // Internal Helpers
}
