/**
 * Chrome Actions -- Custom Error Classes
 */

import type { ToolResult } from './types.js';

/**
 * Thrown when a method is called but the Chrome extension socket is not connected.
 */
export class ChromeNotConnectedError extends Error {
  override name = 'ChromeNotConnectedError' as const;

  constructor(message = 'Chrome extension not connected. Make sure Chrome is running with the Claude extension installed.') {
    super(message);
  }
}

/**
 * Thrown when an element cannot be found on the page by the given query.
 */
export class ElementNotFoundError extends Error {
  override name = 'ElementNotFoundError' as const;
  readonly query: string;

  constructor(query: string) {
    super(`Element not found: "${query}"`);
    this.query = query;
  }
}

/**
 * Thrown when a Chrome tool call returns an error result.
 */
export class ToolExecutionError extends Error {
  override name = 'ToolExecutionError' as const;
  readonly result: ToolResult;
  readonly toolName: string;

  constructor(toolName: string, result: ToolResult) {
    const text = result.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join(' ');
    super(`Tool "${toolName}" failed: ${text || '(no error message)'}`);
    this.toolName = toolName;
    this.result = result;
  }
}

/**
 * Thrown when a navigation wait times out before the URL pattern matches.
 */
export class NavigationTimeoutError extends Error {
  override name = 'NavigationTimeoutError' as const;
  readonly pattern: string | RegExp;
  readonly timeoutMs: number;

  constructor(pattern: string | RegExp, timeoutMs: number) {
    super(`Navigation timeout after ${timeoutMs}ms waiting for URL pattern: ${pattern}`);
    this.pattern = pattern;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when a specified tab ID does not exist in the active tab context.
 */
export class TabNotFoundError extends Error {
  override name = 'TabNotFoundError' as const;
  readonly tabId: number;

  constructor(tabId: number) {
    super(`Tab not found: ${tabId}`);
    this.tabId = tabId;
  }
}
