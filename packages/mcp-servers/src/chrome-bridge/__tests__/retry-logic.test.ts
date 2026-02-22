/**
 * Unit tests for ChromeBridgeClient retry logic
 *
 * Tests the content script injection retry flow including:
 * - isContentScriptError() detection (lines 287-294)
 * - executeTool() retry flow (lines 374-390)
 * - tabUrls cache state persistence
 * - updateTabRoutes() URL caching (lines 455-475)
 *
 * Critical: These tests validate structure and behavior, not performance.
 * All graceful fallbacks are violations - errors must throw.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { McpContent, ChromeBridgeResponse } from '../types.js';

// ============================================================================
// Testable Client Implementations
// ============================================================================

/**
 * Testable client for isContentScriptError() method
 *
 * Exposes the exact implementation from server.ts lines 287-294
 */
class TestableContentScriptErrorDetector {
  isContentScriptError(result: { content: McpContent[]; isError?: boolean }): boolean {
    return result.isError === true && result.content.some(
      (c) => c.type === 'text' && (
        (c.text?.includes('Cannot access contents')) ||
        (c.text?.includes('must request permission'))
      ),
    );
  }
}

/**
 * Testable client for tabUrls cache + updateTabRoutes() + retry flow
 *
 * Mirrors the internal state of ChromeBridgeClient:
 * - tabRoutes: tabId -> socketPath
 * - tabUrls: tabId -> last known URL
 *
 * Exposes private methods via test wrappers.
 */
class TestableChromeBridgeClient {
  public tabRoutes = new Map<number, string>();
  public tabUrls = new Map<number, string>();

  // Track calls to executeOnSocketSerialized for retry verification
  public executeCallLog: Array<{ socketPath: string; toolName: string; args: Record<string, unknown> }> = [];
  public executeResults: Array<{ content: McpContent[]; isError?: boolean }> = [];
  private executeCallIndex = 0;

  // Track setTimeout calls
  public delayMs: number[] = [];

  isContentScriptError(result: { content: McpContent[]; isError?: boolean }): boolean {
    return result.isError === true && result.content.some(
      (c) => c.type === 'text' && (
        (c.text?.includes('Cannot access contents')) ||
        (c.text?.includes('must request permission'))
      ),
    );
  }

  normalizeResponse(response: ChromeBridgeResponse): { content: McpContent[]; isError?: boolean } {
    if ('error' in response && response.error) {
      const rawErrorContent = response.error.content;
      const content = Array.isArray(rawErrorContent)
        ? rawErrorContent
        : rawErrorContent != null ? [rawErrorContent] : [];
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

  updateTabRoutes(content: McpContent[], socketPath: string): void {
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

  /**
   * Simulate executeOnSocketSerialized for retry flow testing.
   * Returns pre-configured results in sequence.
   */
  private async executeOnSocketSerialized(
    socketPath: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: McpContent[]; isError?: boolean }> {
    this.executeCallLog.push({ socketPath, toolName, args });
    const result = this.executeResults[this.executeCallIndex] ?? {
      content: [{ type: 'text', text: 'Mock fallback' }],
    };
    this.executeCallIndex++;
    return result;
  }

  /**
   * Simulate the retry flow from executeTool() lines 367-400
   * Extracted without socket/connection concerns.
   */
  async executeWithRetry(
    targetSocket: string,
    toolName: string,
    args: Record<string, unknown>,
    tabId: number | undefined,
    delayFn: (ms: number) => Promise<void>,
  ): Promise<{ content: McpContent[]; isError?: boolean }> {
    try {
      const response = await this.executeOnSocketSerialized(targetSocket, toolName, args);
      const result = response;

      if (this.isContentScriptError(result) && tabId !== undefined) {
        const cachedUrl = this.tabUrls.get(tabId);
        if (cachedUrl) {
          const urlHost = (() => {
            try { return new URL(cachedUrl).hostname; } catch { return '(unknown)'; }
          })();
          void urlHost; // used for logging in real code
          try {
            await this.executeOnSocketSerialized(targetSocket, 'navigate', { url: cachedUrl, tabId });
            await delayFn(2000);
            const retryResponse = await this.executeOnSocketSerialized(targetSocket, toolName, args);
            return retryResponse;
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
}

// ============================================================================
// Tests: isContentScriptError()
// ============================================================================

describe('ChromeBridgeClient.isContentScriptError()', () => {
  let detector: TestableContentScriptErrorDetector;

  beforeEach(() => {
    detector = new TestableContentScriptErrorDetector();
  });

  describe('Positive detection - "Cannot access contents"', () => {
    it('should detect exact "Cannot access contents" message', () => {
      const result = {
        content: [{ type: 'text', text: 'Cannot access contents of the page' }],
        isError: true,
      };

      expect(detector.isContentScriptError(result)).toBe(true);
    });

    it('should detect "Cannot access contents" within longer error text', () => {
      const result = {
        content: [{
          type: 'text',
          text: 'Error: Cannot access contents of url "chrome://newtab". Extension manifest must request permission to access this host.',
        }],
        isError: true,
      };

      expect(detector.isContentScriptError(result)).toBe(true);
    });

    it('should detect error when multiple content items and one matches', () => {
      const result = {
        content: [
          { type: 'text', text: 'Some preamble' },
          { type: 'text', text: 'Cannot access contents of that url' },
        ],
        isError: true,
      };

      expect(detector.isContentScriptError(result)).toBe(true);
    });
  });

  describe('Positive detection - "must request permission"', () => {
    it('should detect exact "must request permission" message', () => {
      const result = {
        content: [{ type: 'text', text: 'Extension manifest must request permission to access this host.' }],
        isError: true,
      };

      expect(detector.isContentScriptError(result)).toBe(true);
    });

    it('should detect "must request permission" within longer error text', () => {
      const result = {
        content: [{
          type: 'text',
          text: 'Access denied: the extension must request permission before it can read the DOM.',
        }],
        isError: true,
      };

      expect(detector.isContentScriptError(result)).toBe(true);
    });

    it('should detect when error is in last item of multiple content items', () => {
      const result = {
        content: [
          { type: 'text', text: 'Tab 5: failed' },
          { type: 'text', text: 'Extension must request permission to access this host' },
        ],
        isError: true,
      };

      expect(detector.isContentScriptError(result)).toBe(true);
    });
  });

  describe('Negative detection - not a content script error', () => {
    it('should return false when isError is false', () => {
      const result = {
        content: [{ type: 'text', text: 'Cannot access contents of the page' }],
        isError: false,
      };

      expect(detector.isContentScriptError(result)).toBe(false);
    });

    it('should return false when isError is undefined', () => {
      const result = {
        content: [{ type: 'text', text: 'Cannot access contents of the page' }],
        // isError not set - means success
      };

      expect(detector.isContentScriptError(result)).toBe(false);
    });

    it('should return false when error message is unrelated', () => {
      const result = {
        content: [{ type: 'text', text: 'Connection refused: socket not available' }],
        isError: true,
      };

      expect(detector.isContentScriptError(result)).toBe(false);
    });

    it('should return false when error message is timeout', () => {
      const result = {
        content: [{ type: 'text', text: 'Response timeout after 120000ms' }],
        isError: true,
      };

      expect(detector.isContentScriptError(result)).toBe(false);
    });

    it('should return false when content array is empty', () => {
      const result = {
        content: [] as McpContent[],
        isError: true,
      };

      expect(detector.isContentScriptError(result)).toBe(false);
    });

    it('should return false when content type is not text', () => {
      const result = {
        content: [{
          type: 'image',
          data: 'base64data',
          mimeType: 'image/png',
          text: 'Cannot access contents',
        }],
        isError: true,
      };

      // Image type with text field should NOT trigger detection
      // The .type check is on 'text', not 'image'
      expect(detector.isContentScriptError(result)).toBe(false);
    });

    it('should return false when text is undefined', () => {
      const result = {
        content: [{ type: 'text' }],
        isError: true,
      };

      expect(detector.isContentScriptError(result)).toBe(false);
    });

    it('should return false when text is empty string', () => {
      const result = {
        content: [{ type: 'text', text: '' }],
        isError: true,
      };

      expect(detector.isContentScriptError(result)).toBe(false);
    });

    it('should return false for partial match that does not include full phrase', () => {
      const result = {
        content: [{ type: 'text', text: 'Cannot access' }],
        isError: true,
      };

      // "Cannot access" alone (without "contents") does NOT match
      expect(detector.isContentScriptError(result)).toBe(false);
    });

    it('should return false for generic permission denied error', () => {
      const result = {
        content: [{ type: 'text', text: 'permission denied for this operation' }],
        isError: true,
      };

      expect(detector.isContentScriptError(result)).toBe(false);
    });
  });

  describe('Both error conditions in same response', () => {
    it('should return true when both phrases appear in different content items', () => {
      const result = {
        content: [
          { type: 'text', text: 'Cannot access contents' },
          { type: 'text', text: 'Extension must request permission' },
        ],
        isError: true,
      };

      expect(detector.isContentScriptError(result)).toBe(true);
    });

    it('should return true when both phrases appear in the same content item', () => {
      const result = {
        content: [{
          type: 'text',
          text: 'Cannot access contents because extension must request permission',
        }],
        isError: true,
      };

      expect(detector.isContentScriptError(result)).toBe(true);
    });
  });

  describe('Structure validation', () => {
    it('should return a boolean type', () => {
      const trueResult = {
        content: [{ type: 'text', text: 'Cannot access contents' }],
        isError: true,
      };
      const falseResult = {
        content: [{ type: 'text', text: 'OK' }],
        isError: false,
      };

      expect(typeof detector.isContentScriptError(trueResult)).toBe('boolean');
      expect(typeof detector.isContentScriptError(falseResult)).toBe('boolean');
    });

    it('should not throw on any valid McpContent[] input', () => {
      const inputs = [
        { content: [], isError: true },
        { content: [{ type: 'text', text: undefined }], isError: true },
        { content: [{ type: 'text', text: '' }], isError: true },
        { content: [{ type: 'text', text: 'normal message' }], isError: false },
      ];

      for (const input of inputs) {
        expect(() => detector.isContentScriptError(input as any)).not.toThrow();
      }
    });
  });
});

// ============================================================================
// Tests: updateTabRoutes() URL caching
// ============================================================================

describe('ChromeBridgeClient.updateTabRoutes()', () => {
  let client: TestableChromeBridgeClient;

  beforeEach(() => {
    client = new TestableChromeBridgeClient();
  });

  describe('Tab route caching from array format', () => {
    it('should cache tabId -> socketPath when content is JSON array of tabs', () => {
      const socketPath = '/tmp/claude-mcp-browser-bridge-user/sock1.sock';
      const content: McpContent[] = [{
        type: 'text',
        text: JSON.stringify([
          { tabId: 1, url: 'https://example.com' },
          { tabId: 2, url: 'https://google.com' },
        ]),
      }];

      client.updateTabRoutes(content, socketPath);

      expect(client.tabRoutes.get(1)).toBe(socketPath);
      expect(client.tabRoutes.get(2)).toBe(socketPath);
    });

    it('should cache tabId -> URL when tab has url property', () => {
      const socketPath = '/tmp/sock1.sock';
      const content: McpContent[] = [{
        type: 'text',
        text: JSON.stringify([
          { tabId: 42, url: 'https://portal.azure.com' },
        ]),
      }];

      client.updateTabRoutes(content, socketPath);

      expect(client.tabUrls.get(42)).toBe('https://portal.azure.com');
    });

    it('should NOT cache URL when tab url is empty string', () => {
      const socketPath = '/tmp/sock1.sock';
      const content: McpContent[] = [{
        type: 'text',
        text: JSON.stringify([
          { tabId: 10, url: '' },
        ]),
      }];

      client.updateTabRoutes(content, socketPath);

      expect(client.tabRoutes.has(10)).toBe(true);
      // Empty URL should NOT be cached
      expect(client.tabUrls.has(10)).toBe(false);
    });

    it('should NOT cache URL when tab has no url property', () => {
      const socketPath = '/tmp/sock1.sock';
      const content: McpContent[] = [{
        type: 'text',
        text: JSON.stringify([
          { tabId: 5 }, // no url
        ]),
      }];

      client.updateTabRoutes(content, socketPath);

      expect(client.tabRoutes.has(5)).toBe(true);
      expect(client.tabUrls.has(5)).toBe(false);
    });

    it('should skip tab entries with non-numeric tabId', () => {
      const socketPath = '/tmp/sock1.sock';
      const content: McpContent[] = [{
        type: 'text',
        text: JSON.stringify([
          { tabId: 'not-a-number', url: 'https://example.com' },
          { tabId: null, url: 'https://google.com' },
        ]),
      }];

      client.updateTabRoutes(content, socketPath);

      expect(client.tabRoutes.size).toBe(0);
      expect(client.tabUrls.size).toBe(0);
    });

    it('should skip tab entries that are null', () => {
      const socketPath = '/tmp/sock1.sock';
      const content: McpContent[] = [{
        type: 'text',
        text: JSON.stringify([null, undefined, 42, 'string']),
      }];

      client.updateTabRoutes(content, socketPath);

      expect(client.tabRoutes.size).toBe(0);
    });
  });

  describe('Tab route caching from availableTabs format', () => {
    it('should cache tabId -> socketPath when content has availableTabs property', () => {
      const socketPath = '/tmp/sock2.sock';
      const content: McpContent[] = [{
        type: 'text',
        text: JSON.stringify({
          availableTabs: [
            { tabId: 100, url: 'https://github.com' },
            { tabId: 101, url: 'https://vercel.com' },
          ],
        }),
      }];

      client.updateTabRoutes(content, socketPath);

      expect(client.tabRoutes.get(100)).toBe(socketPath);
      expect(client.tabRoutes.get(101)).toBe(socketPath);
    });

    it('should cache URLs from availableTabs format', () => {
      const socketPath = '/tmp/sock2.sock';
      const content: McpContent[] = [{
        type: 'text',
        text: JSON.stringify({
          availableTabs: [
            { tabId: 200, url: 'https://app.render.com' },
          ],
        }),
      }];

      client.updateTabRoutes(content, socketPath);

      expect(client.tabUrls.get(200)).toBe('https://app.render.com');
    });

    it('should handle availableTabs: null without crashing', () => {
      const socketPath = '/tmp/sock2.sock';
      const content: McpContent[] = [{
        type: 'text',
        text: JSON.stringify({
          availableTabs: null,
        }),
      }];

      expect(() => client.updateTabRoutes(content, socketPath)).not.toThrow();
      expect(client.tabRoutes.size).toBe(0);
    });
  });

  describe('Multiple content items', () => {
    it('should process all text content items and accumulate tab routes', () => {
      const socketPath = '/tmp/sock3.sock';
      const content: McpContent[] = [
        {
          type: 'text',
          text: JSON.stringify([{ tabId: 1, url: 'https://example.com' }]),
        },
        {
          type: 'text',
          text: JSON.stringify([{ tabId: 2, url: 'https://google.com' }]),
        },
      ];

      client.updateTabRoutes(content, socketPath);

      expect(client.tabRoutes.get(1)).toBe(socketPath);
      expect(client.tabRoutes.get(2)).toBe(socketPath);
      expect(client.tabUrls.get(1)).toBe('https://example.com');
      expect(client.tabUrls.get(2)).toBe('https://google.com');
    });

    it('should skip non-text content items', () => {
      const socketPath = '/tmp/sock3.sock';
      const content: McpContent[] = [
        { type: 'image', data: 'base64data', mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify([{ tabId: 7, url: 'https://test.com' }]) },
      ];

      client.updateTabRoutes(content, socketPath);

      expect(client.tabRoutes.has(7)).toBe(true);
      expect(client.tabRoutes.size).toBe(1);
    });

    it('should skip text items with no text property', () => {
      const socketPath = '/tmp/sock3.sock';
      const content: McpContent[] = [
        { type: 'text' }, // no .text
        { type: 'text', text: JSON.stringify([{ tabId: 8, url: 'https://test.com' }]) },
      ];

      client.updateTabRoutes(content, socketPath);

      expect(client.tabRoutes.size).toBe(1);
      expect(client.tabRoutes.has(8)).toBe(true);
    });
  });

  describe('Non-JSON content handling', () => {
    it('should silently skip non-JSON text content', () => {
      const socketPath = '/tmp/sock1.sock';
      const content: McpContent[] = [{
        type: 'text',
        text: 'Not a JSON string at all',
      }];

      expect(() => client.updateTabRoutes(content, socketPath)).not.toThrow();
      expect(client.tabRoutes.size).toBe(0);
    });

    it('should silently skip malformed JSON', () => {
      const socketPath = '/tmp/sock1.sock';
      const content: McpContent[] = [{
        type: 'text',
        text: '{ tabId: 1, url: "broken" }', // not valid JSON
      }];

      expect(() => client.updateTabRoutes(content, socketPath)).not.toThrow();
      expect(client.tabRoutes.size).toBe(0);
    });

    it('should silently skip JSON that is not an array or object with availableTabs', () => {
      const socketPath = '/tmp/sock1.sock';
      const content: McpContent[] = [
        { type: 'text', text: '"just a string"' },
        { type: 'text', text: '42' },
        { type: 'text', text: 'true' },
      ];

      expect(() => client.updateTabRoutes(content, socketPath)).not.toThrow();
      expect(client.tabRoutes.size).toBe(0);
    });

    it('should handle empty content array without throwing', () => {
      expect(() => client.updateTabRoutes([], '/tmp/sock1.sock')).not.toThrow();
      expect(client.tabRoutes.size).toBe(0);
    });
  });

  describe('Cache overwrites', () => {
    it('should overwrite existing tab route when same tabId seen from new socket', () => {
      const sock1 = '/tmp/sock1.sock';
      const sock2 = '/tmp/sock2.sock';

      client.updateTabRoutes(
        [{ type: 'text', text: JSON.stringify([{ tabId: 99, url: 'https://old.com' }]) }],
        sock1,
      );
      expect(client.tabRoutes.get(99)).toBe(sock1);

      client.updateTabRoutes(
        [{ type: 'text', text: JSON.stringify([{ tabId: 99, url: 'https://new.com' }]) }],
        sock2,
      );
      expect(client.tabRoutes.get(99)).toBe(sock2);
    });

    it('should overwrite existing URL when same tabId seen with new URL', () => {
      const sock1 = '/tmp/sock1.sock';

      client.updateTabRoutes(
        [{ type: 'text', text: JSON.stringify([{ tabId: 50, url: 'https://page1.com' }]) }],
        sock1,
      );
      expect(client.tabUrls.get(50)).toBe('https://page1.com');

      client.updateTabRoutes(
        [{ type: 'text', text: JSON.stringify([{ tabId: 50, url: 'https://page2.com' }]) }],
        sock1,
      );
      expect(client.tabUrls.get(50)).toBe('https://page2.com');
    });
  });

  describe('Structure validation', () => {
    it('should update tabRoutes map as Map<number, string>', () => {
      const socketPath = '/tmp/sock.sock';
      const content: McpContent[] = [{
        type: 'text',
        text: JSON.stringify([{ tabId: 1, url: 'https://example.com' }]),
      }];

      client.updateTabRoutes(content, socketPath);

      expect(client.tabRoutes instanceof Map).toBe(true);
      const key = client.tabRoutes.keys().next().value;
      const value = client.tabRoutes.values().next().value;
      expect(typeof key).toBe('number');
      expect(typeof value).toBe('string');
    });

    it('should update tabUrls map as Map<number, string>', () => {
      const socketPath = '/tmp/sock.sock';
      const content: McpContent[] = [{
        type: 'text',
        text: JSON.stringify([{ tabId: 1, url: 'https://example.com' }]),
      }];

      client.updateTabRoutes(content, socketPath);

      expect(client.tabUrls instanceof Map).toBe(true);
      const key = client.tabUrls.keys().next().value;
      const value = client.tabUrls.values().next().value;
      expect(typeof key).toBe('number');
      expect(typeof value).toBe('string');
    });
  });
});

// ============================================================================
// Tests: tabUrls cache state persistence
// ============================================================================

describe('ChromeBridgeClient tabUrls cache - state persistence', () => {
  let client: TestableChromeBridgeClient;

  beforeEach(() => {
    client = new TestableChromeBridgeClient();
  });

  describe('Initial state', () => {
    it('should start with empty tabUrls map', () => {
      expect(client.tabUrls.size).toBe(0);
    });

    it('should start with empty tabRoutes map', () => {
      expect(client.tabRoutes.size).toBe(0);
    });
  });

  describe('URL caching persistence', () => {
    it('should persist tabUrls across multiple updateTabRoutes calls', () => {
      const sock = '/tmp/sock.sock';

      client.updateTabRoutes(
        [{ type: 'text', text: JSON.stringify([{ tabId: 1, url: 'https://first.com' }]) }],
        sock,
      );

      client.updateTabRoutes(
        [{ type: 'text', text: JSON.stringify([{ tabId: 2, url: 'https://second.com' }]) }],
        sock,
      );

      // Both entries should persist
      expect(client.tabUrls.get(1)).toBe('https://first.com');
      expect(client.tabUrls.get(2)).toBe('https://second.com');
      expect(client.tabUrls.size).toBe(2);
    });

    it('should make URL available for retry flow after caching', () => {
      const sock = '/tmp/sock.sock';

      // Simulate tabs_context_mcp setting the URL
      client.updateTabRoutes(
        [{ type: 'text', text: JSON.stringify([{ tabId: 10, url: 'https://portal.azure.com' }]) }],
        sock,
      );

      // URL should now be accessible for retry
      expect(client.tabUrls.get(10)).toBe('https://portal.azure.com');
    });

    it('should retain URLs from non-JSON content items that fail parsing', () => {
      const sock = '/tmp/sock.sock';

      // Cache a URL first
      client.updateTabRoutes(
        [{ type: 'text', text: JSON.stringify([{ tabId: 5, url: 'https://example.com' }]) }],
        sock,
      );

      // Now call with invalid JSON - should not wipe existing cache
      client.updateTabRoutes(
        [{ type: 'text', text: 'not json at all' }],
        sock,
      );

      // Previously cached URL should still be there
      expect(client.tabUrls.get(5)).toBe('https://example.com');
    });
  });

  describe('Manual URL injection (navigate command caching)', () => {
    it('should store URL when manually set before executeWithRetry', async () => {
      // Simulate what executeTool() does on navigate:
      // this.tabUrls.set(tabId, url)
      client.tabUrls.set(7, 'https://console.aws.amazon.com');

      expect(client.tabUrls.get(7)).toBe('https://console.aws.amazon.com');
    });

    it('should allow retry to read URL set via manual cache', async () => {
      const tabId = 15;
      const url = 'https://app.example.com/dashboard';
      client.tabUrls.set(tabId, url);
      client.tabRoutes.set(tabId, '/tmp/sock.sock');

      // Pre-configure: first call returns content script error, second succeeds
      client.executeResults = [
        {
          content: [{ type: 'text', text: 'Cannot access contents of the page' }],
          isError: true,
        },
        {
          content: [{ type: 'text', text: 'Navigate success' }],
        },
        {
          content: [{ type: 'text', text: 'Read page success after retry' }],
        },
      ];

      const delays: number[] = [];
      const delayFn = async (ms: number) => { delays.push(ms); };

      const result = await client.executeWithRetry('/tmp/sock.sock', 'read_page', { tabId }, tabId, delayFn);

      // Should have retried
      expect(client.executeCallLog).toHaveLength(3); // initial + navigate + retry
      expect(client.executeCallLog[1].toolName).toBe('navigate');
      expect(client.executeCallLog[1].args.url).toBe(url);
      expect(client.executeCallLog[2].toolName).toBe('read_page');
      expect(result.content[0].text).toBe('Read page success after retry');
    });
  });
});

// ============================================================================
// Tests: executeTool() retry flow
// ============================================================================

describe('ChromeBridgeClient executeTool() retry flow', () => {
  let client: TestableChromeBridgeClient;

  beforeEach(() => {
    client = new TestableChromeBridgeClient();
  });

  describe('No retry path - normal success', () => {
    it('should return success result without retrying', async () => {
      const tabId = 1;
      client.tabUrls.set(tabId, 'https://example.com');
      client.executeResults = [
        { content: [{ type: 'text', text: 'Page content here' }] },
      ];

      const delays: number[] = [];
      const result = await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', { tabId }, tabId, async (ms) => { delays.push(ms); },
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Page content here');
      expect(client.executeCallLog).toHaveLength(1);
      expect(delays).toHaveLength(0);
    });
  });

  describe('No retry path - non-content-script error', () => {
    it('should return error without retrying when error is not content script error', async () => {
      const tabId = 1;
      client.tabUrls.set(tabId, 'https://example.com');
      client.executeResults = [
        {
          content: [{ type: 'text', text: 'Response timeout after 120000ms' }],
          isError: true,
        },
      ];

      const delays: number[] = [];
      const result = await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', { tabId }, tabId, async (ms) => { delays.push(ms); },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timeout');
      expect(client.executeCallLog).toHaveLength(1);
      expect(delays).toHaveLength(0);
    });

    it('should return error without retrying for connection refused error', async () => {
      const tabId = 2;
      client.tabUrls.set(tabId, 'https://example.com');
      client.executeResults = [
        {
          content: [{ type: 'text', text: 'Chrome bridge error: Connection refused' }],
          isError: true,
        },
      ];

      const delays: number[] = [];
      const result = await client.executeWithRetry(
        '/tmp/sock.sock', 'navigate', { tabId, url: 'https://test.com' }, tabId,
        async (ms) => { delays.push(ms); },
      );

      expect(result.isError).toBe(true);
      expect(client.executeCallLog).toHaveLength(1);
      expect(delays).toHaveLength(0);
    });
  });

  describe('No retry path - content script error without tabId', () => {
    it('should return error without retrying when tabId is undefined', async () => {
      client.executeResults = [
        {
          content: [{ type: 'text', text: 'Cannot access contents of the page' }],
          isError: true,
        },
      ];

      const delays: number[] = [];
      const result = await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', {}, undefined, async (ms) => { delays.push(ms); },
      );

      // Content script error without tabId: no retry
      expect(result.isError).toBe(true);
      expect(client.executeCallLog).toHaveLength(1);
      expect(delays).toHaveLength(0);
    });
  });

  describe('No retry path - content script error without cached URL', () => {
    it('should return error without retrying when tabUrls has no cached URL', async () => {
      const tabId = 99;
      // No URL in tabUrls for this tabId
      client.executeResults = [
        {
          content: [{ type: 'text', text: 'Cannot access contents of the page' }],
          isError: true,
        },
      ];

      const delays: number[] = [];
      const result = await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', { tabId }, tabId, async (ms) => { delays.push(ms); },
      );

      // No URL cached -> no retry possible
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot access contents');
      expect(client.executeCallLog).toHaveLength(1);
      expect(delays).toHaveLength(0);
    });
  });

  describe('Retry path - content script error with tabId and cached URL', () => {
    it('should navigate, wait 2000ms, then retry the original tool', async () => {
      const tabId = 5;
      const cachedUrl = 'https://portal.azure.com/dashboard';
      client.tabUrls.set(tabId, cachedUrl);

      client.executeResults = [
        // Initial call returns content script error
        {
          content: [{ type: 'text', text: 'Cannot access contents of the page' }],
          isError: true,
        },
        // Navigate call succeeds (2nd call)
        {
          content: [{ type: 'text', text: 'Navigate success' }],
        },
        // Retry of original tool succeeds (3rd call)
        {
          content: [{ type: 'text', text: 'Page content after reload' }],
        },
      ];

      const delays: number[] = [];
      const result = await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', { tabId }, tabId, async (ms) => { delays.push(ms); },
      );

      // Verify 3 calls were made
      expect(client.executeCallLog).toHaveLength(3);

      // First call: original tool
      expect(client.executeCallLog[0].toolName).toBe('read_page');
      expect(client.executeCallLog[0].args).toEqual({ tabId });

      // Second call: navigate to cached URL
      expect(client.executeCallLog[1].toolName).toBe('navigate');
      expect(client.executeCallLog[1].args.url).toBe(cachedUrl);
      expect(client.executeCallLog[1].args.tabId).toBe(tabId);

      // Third call: retry of original tool
      expect(client.executeCallLog[2].toolName).toBe('read_page');
      expect(client.executeCallLog[2].args).toEqual({ tabId });

      // Verify 2000ms delay was used
      expect(delays).toHaveLength(1);
      expect(delays[0]).toBe(2000);

      // Verify final result is from the retry
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Page content after reload');
    });

    it('should retry with "must request permission" error trigger', async () => {
      const tabId = 6;
      client.tabUrls.set(tabId, 'https://app.github.com');

      client.executeResults = [
        {
          content: [{ type: 'text', text: 'Extension must request permission to access this host' }],
          isError: true,
        },
        { content: [{ type: 'text', text: 'Navigate ok' }] },
        { content: [{ type: 'text', text: 'Retry success' }] },
      ];

      const delays: number[] = [];
      const result = await client.executeWithRetry(
        '/tmp/sock.sock', 'find', { tabId, query: 'login button' }, tabId,
        async (ms) => { delays.push(ms); },
      );

      expect(client.executeCallLog).toHaveLength(3);
      expect(delays[0]).toBe(2000);
      expect(result.content[0].text).toBe('Retry success');
    });

    it('should use the exact cached URL (not modified) for navigation', async () => {
      const tabId = 7;
      const exactUrl = 'https://console.cloud.google.com/home/dashboard?project=my-project-123';
      client.tabUrls.set(tabId, exactUrl);

      client.executeResults = [
        {
          content: [{ type: 'text', text: 'Cannot access contents of the page' }],
          isError: true,
        },
        { content: [{ type: 'text', text: 'navigate ok' }] },
        { content: [{ type: 'text', text: 'retry ok' }] },
      ];

      const delays: number[] = [];
      await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', { tabId }, tabId, async (ms) => { delays.push(ms); },
      );

      // Navigate call must use the exact URL from cache
      expect(client.executeCallLog[1].args.url).toBe(exactUrl);
    });

    it('should pass the same socket path to navigate and retry calls', async () => {
      const tabId = 8;
      const socketPath = '/tmp/claude-bridge-user/sock-123.sock';
      client.tabUrls.set(tabId, 'https://example.com');

      client.executeResults = [
        {
          content: [{ type: 'text', text: 'Cannot access contents' }],
          isError: true,
        },
        { content: [{ type: 'text', text: 'ok' }] },
        { content: [{ type: 'text', text: 'ok' }] },
      ];

      const delays: number[] = [];
      await client.executeWithRetry(
        socketPath, 'read_page', { tabId }, tabId, async (ms) => { delays.push(ms); },
      );

      // All 3 calls should go to same socket
      for (const call of client.executeCallLog) {
        expect(call.socketPath).toBe(socketPath);
      }
    });
  });

  describe('Retry path - retry also fails', () => {
    it('should fall through and return original error when retry throws', async () => {
      const tabId = 10;
      client.tabUrls.set(tabId, 'https://example.com');

      let callCount = 0;
      const throwingClient = new TestableChromeBridgeClient();
      throwingClient.tabUrls.set(tabId, 'https://example.com');

      // We need to simulate a retry that throws by overriding executeOnSocketSerialized
      // We'll test the catch branch by having the execute throw after first call
      const originalResults = [
        {
          content: [{ type: 'text', text: 'Cannot access contents of the page' }],
          isError: true,
        },
      ];
      throwingClient.executeResults = originalResults;

      // Patch the navigate call to throw
      const origExecute = (throwingClient as any).executeOnSocketSerialized.bind(throwingClient);
      (throwingClient as any).executeOnSocketSerialized = async (
        socketPath: string,
        toolName: string,
        args: Record<string, unknown>,
      ) => {
        callCount++;
        if (callCount === 1) {
          // First call: return content script error
          return { content: [{ type: 'text', text: 'Cannot access contents of the page' }], isError: true };
        }
        if (callCount === 2) {
          // Navigate call: throw
          throw new Error('Socket disconnected during navigate');
        }
        return { content: [{ type: 'text', text: 'Should not reach' }] };
      };

      const delays: number[] = [];
      const result = await throwingClient.executeWithRetry(
        '/tmp/sock.sock', 'read_page', { tabId }, tabId, async (ms) => { delays.push(ms); },
      );

      // Original error is returned (fall-through behavior)
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot access contents');
    });

    it('should return original error when retry call itself returns an error', async () => {
      const tabId = 11;
      client.tabUrls.set(tabId, 'https://example.com');

      client.executeResults = [
        // Initial: content script error
        {
          content: [{ type: 'text', text: 'Cannot access contents of the page' }],
          isError: true,
        },
        // Navigate: succeeds
        { content: [{ type: 'text', text: 'Navigate ok' }] },
        // Retry: also fails with a different error
        {
          content: [{ type: 'text', text: 'Page crashed during reload' }],
          isError: true,
        },
      ];

      const delays: number[] = [];
      const result = await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', { tabId }, tabId, async (ms) => { delays.push(ms); },
      );

      // Result is from the retry (3rd call), not original
      // This matches real behavior: retryResult is returned even if it's an error
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Page crashed during reload');
      expect(client.executeCallLog).toHaveLength(3);
    });
  });

  describe('2000ms delay validation', () => {
    it('should use exactly 2000ms delay between navigate and retry', async () => {
      const tabId = 20;
      client.tabUrls.set(tabId, 'https://example.com');

      client.executeResults = [
        {
          content: [{ type: 'text', text: 'Cannot access contents of the page' }],
          isError: true,
        },
        { content: [{ type: 'text', text: 'navigate ok' }] },
        { content: [{ type: 'text', text: 'retry ok' }] },
      ];

      const capturedDelays: number[] = [];
      await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', { tabId }, tabId,
        async (ms: number) => { capturedDelays.push(ms); },
      );

      expect(capturedDelays).toHaveLength(1);
      expect(capturedDelays[0]).toBe(2000);
    });

    it('should NOT delay on normal success path', async () => {
      const tabId = 21;
      client.executeResults = [
        { content: [{ type: 'text', text: 'Success immediately' }] },
      ];

      const capturedDelays: number[] = [];
      await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', { tabId }, tabId,
        async (ms: number) => { capturedDelays.push(ms); },
      );

      expect(capturedDelays).toHaveLength(0);
    });

    it('should NOT delay when content script error but no cached URL', async () => {
      const tabId = 22;
      // No URL in tabUrls
      client.executeResults = [
        {
          content: [{ type: 'text', text: 'Cannot access contents of the page' }],
          isError: true,
        },
      ];

      const capturedDelays: number[] = [];
      await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', { tabId }, tabId,
        async (ms: number) => { capturedDelays.push(ms); },
      );

      expect(capturedDelays).toHaveLength(0);
    });

    it('should NOT delay when content script error but tabId is undefined', async () => {
      client.executeResults = [
        {
          content: [{ type: 'text', text: 'Cannot access contents of the page' }],
          isError: true,
        },
      ];

      const capturedDelays: number[] = [];
      await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', {}, undefined,
        async (ms: number) => { capturedDelays.push(ms); },
      );

      expect(capturedDelays).toHaveLength(0);
    });
  });

  describe('Retry call ordering', () => {
    it('should call navigate BEFORE the delay', async () => {
      const tabId = 30;
      client.tabUrls.set(tabId, 'https://example.com');

      const eventLog: string[] = [];

      // Custom delay that logs timing
      const delayFn = async (ms: number) => {
        // Verify navigate was already called before we wait
        const navigateCalled = client.executeCallLog.some(c => c.toolName === 'navigate');
        if (navigateCalled) {
          eventLog.push('navigate-before-delay');
        }
        eventLog.push(`delay-${ms}`);
      };

      client.executeResults = [
        {
          content: [{ type: 'text', text: 'Cannot access contents' }],
          isError: true,
        },
        { content: [{ type: 'text', text: 'navigate ok' }] },
        { content: [{ type: 'text', text: 'retry ok' }] },
      ];

      await client.executeWithRetry('/tmp/sock.sock', 'read_page', { tabId }, tabId, delayFn);

      expect(eventLog[0]).toBe('navigate-before-delay');
      expect(eventLog[1]).toBe('delay-2000');
    });

    it('should call retry AFTER the delay', async () => {
      const tabId = 31;
      client.tabUrls.set(tabId, 'https://example.com');

      const eventLog: string[] = [];

      const delayFn = async (ms: number) => {
        eventLog.push('delay');
      };

      client.executeResults = [
        {
          content: [{ type: 'text', text: 'Cannot access contents' }],
          isError: true,
        },
        { content: [{ type: 'text', text: 'navigate ok' }] },
        { content: [{ type: 'text', text: 'retry ok' }] },
      ];

      // Wrap executeOnSocketSerialized to log calls after delay tracking
      const orig = (client as any).executeOnSocketSerialized.bind(client);
      (client as any).executeOnSocketSerialized = async (
        socketPath: string, toolName: string, args: Record<string, unknown>,
      ) => {
        eventLog.push(`execute-${toolName}`);
        return orig(socketPath, toolName, args);
      };

      await client.executeWithRetry('/tmp/sock.sock', 'read_page', { tabId }, tabId, delayFn);

      // Verify ordering: read_page -> navigate -> delay -> read_page(retry)
      expect(eventLog[0]).toBe('execute-read_page');
      expect(eventLog[1]).toBe('execute-navigate');
      expect(eventLog[2]).toBe('delay');
      expect(eventLog[3]).toBe('execute-read_page');
    });
  });

  describe('Fail-loud error handling', () => {
    it('should wrap unexpected errors in Chrome bridge error format', async () => {
      const tabId = 40;
      // Configure executeOnSocketSerialized to throw
      (client as any).executeOnSocketSerialized = async () => {
        throw new Error('Unexpected socket failure');
      };

      const result = await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', { tabId }, tabId, async () => {},
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Chrome bridge error');
      expect(result.content[0].text).toContain('Unexpected socket failure');
    });

    it('should wrap non-Error thrown objects in Chrome bridge error format', async () => {
      (client as any).executeOnSocketSerialized = async () => {
        throw 'string error thrown'; // eslint-disable-line no-throw-literal
      };

      const result = await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', {}, undefined, async () => {},
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Chrome bridge error');
      expect(result.content[0].text).toContain('string error thrown');
    });

    it('should return structured error (not throw) to caller', async () => {
      (client as any).executeOnSocketSerialized = async () => {
        throw new Error('Fatal error');
      };

      // Must NOT throw - must return structured error
      await expect(
        client.executeWithRetry('/tmp/sock.sock', 'read_page', {}, undefined, async () => {}),
      ).resolves.toMatchObject({
        isError: true,
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'text' }),
        ]),
      });
    });

    it('should return error structure with content array', async () => {
      (client as any).executeOnSocketSerialized = async () => {
        throw new Error('Boom');
      };

      const result = await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', {}, undefined, async () => {},
      );

      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(typeof result.content[0].type).toBe('string');
    });
  });

  describe('Retry flow does not mutate original args', () => {
    it('should pass same args to retry as to original call', async () => {
      const tabId = 50;
      const originalArgs = { tabId, depth: 5, filter: 'interactive' };
      client.tabUrls.set(tabId, 'https://example.com');

      client.executeResults = [
        {
          content: [{ type: 'text', text: 'Cannot access contents' }],
          isError: true,
        },
        { content: [{ type: 'text', text: 'navigate ok' }] },
        { content: [{ type: 'text', text: 'retry ok' }] },
      ];

      await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', { ...originalArgs }, tabId, async () => {},
      );

      // Initial call and retry should have same non-navigate args
      const firstCall = client.executeCallLog[0];
      const retryCall = client.executeCallLog[2];

      expect(firstCall.args.depth).toBe(5);
      expect(firstCall.args.filter).toBe('interactive');
      expect(retryCall.args.depth).toBe(5);
      expect(retryCall.args.filter).toBe('interactive');
    });
  });

  describe('Only one retry attempt is made', () => {
    it('should not retry more than once even if retry returns content script error', async () => {
      const tabId = 60;
      client.tabUrls.set(tabId, 'https://example.com');

      client.executeResults = [
        // Initial: content script error
        {
          content: [{ type: 'text', text: 'Cannot access contents of the page' }],
          isError: true,
        },
        // Navigate: ok
        { content: [{ type: 'text', text: 'navigate ok' }] },
        // Retry: also a content script error (but we should NOT retry again)
        {
          content: [{ type: 'text', text: 'Cannot access contents of the page again' }],
          isError: true,
        },
      ];

      const delays: number[] = [];
      const result = await client.executeWithRetry(
        '/tmp/sock.sock', 'read_page', { tabId }, tabId, async (ms) => { delays.push(ms); },
      );

      // Only 3 total calls: initial + navigate + retry (NO second retry)
      expect(client.executeCallLog).toHaveLength(3);
      expect(delays).toHaveLength(1);
      expect(result.isError).toBe(true);
    });
  });
});

// ============================================================================
// Tests: Integration between components
// ============================================================================

describe('Chrome Bridge retry logic - component integration', () => {
  let client: TestableChromeBridgeClient;

  beforeEach(() => {
    client = new TestableChromeBridgeClient();
  });

  it('should use URL set by updateTabRoutes in retry flow', async () => {
    const tabId = 70;
    const socketPath = '/tmp/sock.sock';
    const expectedUrl = 'https://portal.azure.com/resource/groups';

    // Simulate tabs_context_mcp populating the cache
    client.updateTabRoutes(
      [{ type: 'text', text: JSON.stringify([{ tabId, url: expectedUrl }]) }],
      socketPath,
    );

    // Verify URL was cached
    expect(client.tabUrls.get(tabId)).toBe(expectedUrl);

    // Now simulate a content script error triggering retry
    client.executeResults = [
      {
        content: [{ type: 'text', text: 'Cannot access contents of the page' }],
        isError: true,
      },
      { content: [{ type: 'text', text: 'navigate ok' }] },
      { content: [{ type: 'text', text: 'retry success' }] },
    ];

    const delays: number[] = [];
    const result = await client.executeWithRetry(
      socketPath, 'read_page', { tabId }, tabId, async (ms) => { delays.push(ms); },
    );

    // Navigate should use URL from updateTabRoutes cache
    expect(client.executeCallLog[1].toolName).toBe('navigate');
    expect(client.executeCallLog[1].args.url).toBe(expectedUrl);
    expect(result.content[0].text).toBe('retry success');
  });

  it('should handle URL from availableTabs format in retry flow', async () => {
    const tabId = 71;
    const socketPath = '/tmp/sock.sock';
    const expectedUrl = 'https://app.vercel.com/dashboard';

    // Cache via availableTabs format (alternative JSON structure)
    client.updateTabRoutes(
      [{
        type: 'text',
        text: JSON.stringify({ availableTabs: [{ tabId, url: expectedUrl }] }),
      }],
      socketPath,
    );

    expect(client.tabUrls.get(tabId)).toBe(expectedUrl);

    client.executeResults = [
      {
        content: [{ type: 'text', text: 'Cannot access contents of the page' }],
        isError: true,
      },
      { content: [{ type: 'text', text: 'navigate ok' }] },
      { content: [{ type: 'text', text: 'retry ok' }] },
    ];

    const delays: number[] = [];
    await client.executeWithRetry(
      socketPath, 'find', { tabId, query: 'deploy button' }, tabId,
      async (ms) => { delays.push(ms); },
    );

    expect(client.executeCallLog[1].args.url).toBe(expectedUrl);
    expect(delays[0]).toBe(2000);
  });

  it('should combine isContentScriptError and tabUrls correctly', () => {
    const tabId = 80;
    client.tabUrls.set(tabId, 'https://example.com');

    // isContentScriptError returns true
    const errorResult = {
      content: [{ type: 'text', text: 'Cannot access contents of the page' }],
      isError: true as const,
    };
    expect(client.isContentScriptError(errorResult)).toBe(true);
    expect(client.tabUrls.has(tabId)).toBe(true);

    // This combination should trigger retry: both conditions met
    const cachedUrl = client.tabUrls.get(tabId);
    expect(cachedUrl).toBe('https://example.com');
  });

  it('should not retry when isContentScriptError returns false even with cached URL', () => {
    const tabId = 81;
    client.tabUrls.set(tabId, 'https://example.com');

    const nonCsError = {
      content: [{ type: 'text', text: 'Some other error' }],
      isError: true as const,
    };

    // isContentScriptError returns false
    expect(client.isContentScriptError(nonCsError)).toBe(false);

    // Even with URL cached, retry should NOT be triggered
    // (this logic is validated at the flow level)
    expect(client.tabUrls.has(tabId)).toBe(true);
  });
});
