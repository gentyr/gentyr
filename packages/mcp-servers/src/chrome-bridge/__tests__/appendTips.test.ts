/**
 * Unit tests for ChromeBridgeClient.appendTips()
 *
 * Tests contextual tip injection into tool responses:
 * - Tips appended to success responses only
 * - Tips NOT appended to error responses
 * - Correct tab URL resolution from tabUrls map
 * - Integration with BrowserTipTracker deduplication
 * - Edge cases (undefined tabId, missing URL, non-interactive tools)
 *
 * Critical: These tests validate structure and behavior, not performance.
 * All graceful fallbacks are violations - errors must throw.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BrowserTipTracker } from '../browser-tips.js';
import type { McpContent } from '../types.js';

/**
 * Mock ChromeBridgeClient to expose appendTips for testing
 *
 * We extract and test just the appendTips method since
 * ChromeBridgeClient is tightly coupled to Unix domain sockets.
 */
class TestableChromeBridgeClient {
  private tabUrls = new Map<number, string>();
  private tipTracker = new BrowserTipTracker();

  /**
   * Append contextual tips to tool response
   *
   * This is the exact implementation from server.ts lines 516-525
   */
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

  // Expose for testing
  public testAppendTips(
    result: { content: McpContent[]; isError?: boolean },
    toolName: string,
    tabId: number | undefined,
  ): void {
    this.appendTips(result, toolName, tabId);
  }

  // Allow test setup to populate tabUrls
  public setTabUrl(tabId: number, url: string): void {
    this.tabUrls.set(tabId, url);
  }
}

describe('ChromeBridgeClient.appendTips()', () => {
  let client: TestableChromeBridgeClient;

  beforeEach(() => {
    client = new TestableChromeBridgeClient();
  });

  // ========================================================================
  // Success Responses
  // ========================================================================

  describe('Success responses', () => {
    it('should append tips to success response with no error flag', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'Navigate complete' }],
      };

      client.testAppendTips(result, 'navigate', undefined);

      // Tips should be appended (general tips on first interactive call)
      expect(result.content.length).toBeGreaterThan(1);
      const lastItem = result.content[result.content.length - 1];
      expect(lastItem.type).toBe('text');
      expect(lastItem.text).toContain('Browser Automation Tips');
    });

    it('should append tips to response with isError: false', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'Form submitted' }],
        isError: false,
      };

      client.testAppendTips(result, 'form_input', undefined);

      expect(result.content.length).toBeGreaterThan(1);
      const lastItem = result.content[result.content.length - 1];
      expect(lastItem.text).toContain('Browser Automation Tips');
    });

    it('should append tips to empty content array', () => {
      const result = {
        content: [] as McpContent[],
      };

      client.testAppendTips(result, 'navigate', undefined);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Browser Automation Tips');
    });

    it('should preserve existing content when appending tips', () => {
      const result = {
        content: [
          { type: 'text' as const, text: 'Line 1' },
          { type: 'text' as const, text: 'Line 2' },
        ],
      };

      client.testAppendTips(result, 'navigate', undefined);

      // Original content should be preserved
      expect(result.content[0].text).toBe('Line 1');
      expect(result.content[1].text).toBe('Line 2');
      // Tips appended at the end
      expect(result.content.length).toBe(3);
      expect(result.content[2].text).toContain('Browser Automation Tips');
    });
  });

  // ========================================================================
  // Error Responses
  // ========================================================================

  describe('Error responses', () => {
    it('should NOT append tips when isError is true', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'Navigation failed' }],
        isError: true,
      };

      client.testAppendTips(result, 'navigate', undefined);

      // Content should remain unchanged
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toBe('Navigation failed');
    });

    it('should NOT append tips to error with empty content', () => {
      const result = {
        content: [] as McpContent[],
        isError: true,
      };

      client.testAppendTips(result, 'navigate', undefined);

      expect(result.content).toHaveLength(0);
    });

    it('should NOT append tips to content script error', () => {
      const result = {
        content: [{
          type: 'text' as const,
          text: 'Cannot access contents of the page',
        }],
        isError: true,
      };

      client.testAppendTips(result, 'read_page', 123);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain('Cannot access');
    });
  });

  // ========================================================================
  // Tab URL Resolution
  // ========================================================================

  describe('Tab URL resolution', () => {
    it('should use URL from tabUrls map when tabId provided', () => {
      client.setTabUrl(42, 'https://github.com/settings');

      // Exhaust general tips first
      const warmup = {
        content: [{ type: 'text' as const, text: 'warmup' }],
      };
      client.testAppendTips(warmup, 'navigate', undefined);

      const result = {
        content: [{ type: 'text' as const, text: 'Token created' }],
      };

      client.testAppendTips(result, 'navigate', 42);

      // Should see GitHub-specific tip
      const tipText = result.content[result.content.length - 1].text;
      expect(tipText).toContain('github.com');
      expect(tipText).toContain('form_input');
    });

    it('should handle undefined tabId (general tips only)', () => {
      client.setTabUrl(99, 'https://github.com');

      const result = {
        content: [{ type: 'text' as const, text: 'Done' }],
      };

      client.testAppendTips(result, 'navigate', undefined);

      // Should get general tips, not GitHub tips
      const tipText = result.content[result.content.length - 1].text;
      expect(tipText).toContain('Browser Automation Tips (General)');
      expect(tipText).not.toContain('github.com');
    });

    it('should handle tabId with no cached URL', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'Done' }],
      };

      // tabId 999 has no URL in cache
      client.testAppendTips(result, 'navigate', 999);

      // Should still get general tips
      const tipText = result.content[result.content.length - 1].text;
      expect(tipText).toContain('Browser Automation Tips (General)');
    });

    it('should handle multiple tabs with different URLs', () => {
      client.setTabUrl(1, 'https://github.com');
      client.setTabUrl(2, 'https://vercel.com');

      // Exhaust general tips
      const warmup = {
        content: [{ type: 'text' as const, text: 'warmup' }],
      };
      client.testAppendTips(warmup, 'navigate', undefined);

      const githubResult = {
        content: [{ type: 'text' as const, text: 'GitHub action' }],
      };
      client.testAppendTips(githubResult, 'navigate', 1);
      expect(githubResult.content[githubResult.content.length - 1].text).toContain('github.com');

      const vercelResult = {
        content: [{ type: 'text' as const, text: 'Vercel action' }],
      };
      client.testAppendTips(vercelResult, 'navigate', 2);
      expect(vercelResult.content[vercelResult.content.length - 1].text).toContain('vercel.com');
    });
  });

  // ========================================================================
  // Tool Filtering
  // ========================================================================

  describe('Tool filtering', () => {
    it('should append tips for interactive tools', () => {
      const interactiveTools = ['navigate', 'computer', 'form_input', 'find', 'read_page'];

      for (const tool of interactiveTools) {
        const freshClient = new TestableChromeBridgeClient();
        const result = {
          content: [{ type: 'text' as const, text: 'done' }],
        };

        freshClient.testAppendTips(result, tool, undefined);

        expect(result.content.length).toBeGreaterThan(1);
      }
    });

    it('should NOT append tips for non-interactive tools', () => {
      const nonInteractive = [
        'tabs_context_mcp',
        'tabs_create_mcp',
        'get_page_text',
        'javascript_tool',
        'read_console_messages',
      ];

      for (const tool of nonInteractive) {
        const result = {
          content: [{ type: 'text' as const, text: 'done' }],
        };

        client.testAppendTips(result, tool, undefined);

        // Content unchanged for non-interactive tools
        expect(result.content).toHaveLength(1);
        expect(result.content[0].text).toBe('done');
      }
    });
  });

  // ========================================================================
  // Deduplication
  // ========================================================================

  describe('Deduplication', () => {
    it('should not append tips twice for same tool', () => {
      const result1 = {
        content: [{ type: 'text' as const, text: 'First call' }],
      };
      client.testAppendTips(result1, 'navigate', undefined);
      expect(result1.content.length).toBe(2); // content + tips

      const result2 = {
        content: [{ type: 'text' as const, text: 'Second call' }],
      };
      client.testAppendTips(result2, 'navigate', undefined);
      expect(result2.content.length).toBe(1); // no tips appended
    });

    it('should track shown tips per client instance', () => {
      // First client - show tips
      const result1 = {
        content: [{ type: 'text' as const, text: 'Client 1' }],
      };
      client.testAppendTips(result1, 'navigate', undefined);
      expect(result1.content.length).toBeGreaterThan(1);

      // Same client - no tips
      const result2 = {
        content: [{ type: 'text' as const, text: 'Client 1 again' }],
      };
      client.testAppendTips(result2, 'navigate', undefined);
      expect(result2.content).toHaveLength(1);

      // New client - show tips again
      const freshClient = new TestableChromeBridgeClient();
      const result3 = {
        content: [{ type: 'text' as const, text: 'Client 2' }],
      };
      freshClient.testAppendTips(result3, 'navigate', undefined);
      expect(result3.content.length).toBeGreaterThan(1);
    });
  });

  // ========================================================================
  // Edge Cases
  // ========================================================================

  describe('Edge cases', () => {
    it('should handle malformed URL in tabUrls map', () => {
      client.setTabUrl(42, 'not-a-valid-url');

      const result = {
        content: [{ type: 'text' as const, text: 'Done' }],
      };

      // Should not throw, should return general tips only
      expect(() => {
        client.testAppendTips(result, 'navigate', 42);
      }).not.toThrow();

      expect(result.content.length).toBeGreaterThan(1);
    });

    it('should handle empty string URL in tabUrls map', () => {
      client.setTabUrl(42, '');

      const result = {
        content: [{ type: 'text' as const, text: 'Done' }],
      };

      client.testAppendTips(result, 'navigate', 42);

      // Should get general tips
      expect(result.content.length).toBeGreaterThan(1);
    });

    it('should mutate the result object in place', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'Original' }],
      };

      const originalRef = result;
      client.testAppendTips(result, 'navigate', undefined);

      // Should be same object reference (mutated in place)
      expect(result).toBe(originalRef);
      expect(result.content.length).toBeGreaterThan(1);
    });

    it('should handle content with mixed types', () => {
      const result = {
        content: [
          { type: 'text' as const, text: 'Text' },
          { type: 'image' as const, data: 'base64', mimeType: 'image/png' },
        ],
      };

      client.testAppendTips(result, 'navigate', undefined);

      // Original mixed content preserved
      expect(result.content[0].type).toBe('text');
      expect(result.content[1].type).toBe('image');
      // Tips appended at end
      expect(result.content[2].type).toBe('text');
      expect(result.content[2].text).toContain('Browser Automation Tips');
    });
  });

  // ========================================================================
  // Structure Validation - NOT Performance
  // ========================================================================

  describe('Structure validation', () => {
    it('should validate tip structure is properly typed', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'Done' }],
      };

      client.testAppendTips(result, 'navigate', undefined);

      // All content items must be properly typed McpContent
      result.content.forEach((item) => {
        expect(typeof item).toBe('object');
        expect(item).not.toBeNull();
        expect(typeof item.type).toBe('string');
        expect(item.type.length).toBeGreaterThan(0);
      });
    });

    it('should return text type for appended tips', () => {
      const result = {
        content: [] as McpContent[],
      };

      client.testAppendTips(result, 'navigate', undefined);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
      expect((result.content[0].text ?? '').length).toBeGreaterThan(0);
    });
  });

  // ========================================================================
  // Integration with BrowserTipTracker
  // ========================================================================

  describe('Integration with BrowserTipTracker', () => {
    it('should respect BrowserTipTracker tool filtering', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'Done' }],
      };

      // tabs_context_mcp is not interactive - no tips
      client.testAppendTips(result, 'tabs_context_mcp', undefined);
      expect(result.content).toHaveLength(1);
    });

    it('should use site-specific tips when URL matches', () => {
      client.setTabUrl(1, 'https://my.1password.com/vaults');

      // Exhaust general tips first
      const warmup = {
        content: [{ type: 'text' as const, text: 'warmup' }],
      };
      client.testAppendTips(warmup, 'navigate', undefined);

      const result = {
        content: [{ type: 'text' as const, text: 'Creating field' }],
      };
      client.testAppendTips(result, 'navigate', 1);

      const tipText = result.content[result.content.length - 1].text;
      expect(tipText).toContain('1password.com');
      expect(tipText).toContain('add another field');
    });

    it('should handle subdomain matching', () => {
      client.setTabUrl(1, 'https://dashboard.render.com/account/keys');

      // Exhaust general
      const warmup = {
        content: [{ type: 'text' as const, text: 'warmup' }],
      };
      client.testAppendTips(warmup, 'navigate', undefined);

      const result = {
        content: [{ type: 'text' as const, text: 'API key page' }],
      };
      client.testAppendTips(result, 'navigate', 1);

      const tipText = result.content[result.content.length - 1].text;
      expect(tipText).toContain('dashboard.render.com');
    });
  });
});
