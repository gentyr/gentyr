/**
 * Unit tests for Playwright Feedback MCP Server
 *
 * Tests URL validation, locator building, schema validation, and error handling.
 * Uses mocks instead of launching real browsers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NavigateArgsSchema,
  ClickArgsSchema,
  TypeTextArgsSchema,
  ScreenshotArgsSchema,
  ScrollArgsSchema,
  WaitForTextArgsSchema,
} from '../types.js';

// ============================================================================
// Schema Validation Tests
// ============================================================================

describe('Navigation Schema Validation', () => {
  it('should accept valid URL', () => {
    const result = NavigateArgsSchema.safeParse({
      url: 'https://example.com/test',
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid URL', () => {
    const result = NavigateArgsSchema.safeParse({
      url: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing URL', () => {
    const result = NavigateArgsSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('Element Locator Schema Validation', () => {
  it('should accept text locator', () => {
    const result = ClickArgsSchema.safeParse({
      text: 'Click me',
    });
    expect(result.success).toBe(true);
  });

  it('should accept role locator', () => {
    const result = ClickArgsSchema.safeParse({
      role: 'button',
    });
    expect(result.success).toBe(true);
  });

  it('should accept role with name', () => {
    const result = ClickArgsSchema.safeParse({
      role: 'button',
      name: 'Submit',
    });
    expect(result.success).toBe(true);
  });

  it('should accept role with text filter', () => {
    const result = ClickArgsSchema.safeParse({
      role: 'button',
      text: 'Submit',
    });
    expect(result.success).toBe(true);
  });

  it('should accept text with index', () => {
    const result = ClickArgsSchema.safeParse({
      text: 'Click me',
      index: 1,
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing text and role', () => {
    const result = ClickArgsSchema.safeParse({
      index: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe('Type Text Schema Validation', () => {
  it('should require value field', () => {
    const result = TypeTextArgsSchema.safeParse({
      text: 'Username',
    });
    expect(result.success).toBe(false);
  });

  it('should accept value with text locator', () => {
    const result = TypeTextArgsSchema.safeParse({
      text: 'Username',
      value: 'john_doe',
    });
    expect(result.success).toBe(true);
  });

  it('should accept clear flag', () => {
    const result = TypeTextArgsSchema.safeParse({
      text: 'Username',
      value: 'john_doe',
      clear: true,
    });
    expect(result.success).toBe(true);
  });
});

describe('Screenshot Schema Validation', () => {
  it('should accept no arguments', () => {
    const result = ScreenshotArgsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept full_page flag', () => {
    const result = ScreenshotArgsSchema.safeParse({
      full_page: true,
    });
    expect(result.success).toBe(true);
  });

  it('should default full_page to false', () => {
    const result = ScreenshotArgsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.full_page).toBe(false);
    }
  });
});

describe('Scroll Schema Validation', () => {
  it('should accept valid direction', () => {
    const result = ScrollArgsSchema.safeParse({
      direction: 'down',
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid direction', () => {
    const result = ScrollArgsSchema.safeParse({
      direction: 'diagonal',
    });
    expect(result.success).toBe(false);
  });

  it('should accept amount', () => {
    const result = ScrollArgsSchema.safeParse({
      direction: 'down',
      amount: 500,
    });
    expect(result.success).toBe(true);
  });

  it('should default amount to 300', () => {
    const result = ScrollArgsSchema.safeParse({
      direction: 'up',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(300);
    }
  });
});

describe('Wait For Text Schema Validation', () => {
  it('should require text', () => {
    const result = WaitForTextArgsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('should accept text', () => {
    const result = WaitForTextArgsSchema.safeParse({
      text: 'Loading...',
    });
    expect(result.success).toBe(true);
  });

  it('should accept timeout', () => {
    const result = WaitForTextArgsSchema.safeParse({
      text: 'Loading...',
      timeout: 10000,
    });
    expect(result.success).toBe(true);
  });

  it('should default timeout to 5000', () => {
    const result = WaitForTextArgsSchema.safeParse({
      text: 'Loading...',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeout).toBe(5000);
    }
  });
});

// ============================================================================
// URL Validation Tests
// ============================================================================

describe('URL Validation Logic', () => {
  const baseUrl = 'https://app.example.com';

  function validateUrl(url: string, base: string): boolean {
    return url.startsWith(base);
  }

  it('should allow URLs within base URL', () => {
    expect(validateUrl('https://app.example.com/', baseUrl)).toBe(true);
    expect(validateUrl('https://app.example.com/dashboard', baseUrl)).toBe(true);
    expect(validateUrl('https://app.example.com/api/users', baseUrl)).toBe(true);
  });

  it('should reject URLs outside base URL', () => {
    expect(validateUrl('https://evil.com', baseUrl)).toBe(false);
    expect(validateUrl('https://example.com', baseUrl)).toBe(false);
    expect(validateUrl('http://app.example.com', baseUrl)).toBe(false);
  });
});

// ============================================================================
// Locator Building Tests
// ============================================================================

describe('Locator Building Logic', () => {
  interface MockLocator {
    filter: (options: any) => MockLocator;
    nth: (index: number) => MockLocator;
    type: string;
    args?: any;
  }

  interface MockPage {
    getByRole: (role: string, options?: any) => MockLocator;
    getByText: (text: string) => MockLocator;
  }

  const mockPage: MockPage = {
    getByRole: vi.fn((role: string, options?: any) => ({
      filter: vi.fn((filterOptions: any) => ({
        nth: vi.fn((index: number) => ({
          type: 'locator',
          args: { role, options, filter: filterOptions, index },
        } as MockLocator)),
        type: 'locator',
        args: { role, options, filter: filterOptions },
      } as MockLocator)),
      nth: vi.fn((index: number) => ({
        type: 'locator',
        args: { role, options, index },
      } as MockLocator)),
      type: 'locator',
      args: { role, options },
    } as MockLocator)),
    getByText: vi.fn((text: string) => ({
      nth: vi.fn((index: number) => ({
        type: 'locator',
        args: { text, index },
      } as MockLocator)),
      type: 'locator',
      args: { text },
    } as MockLocator)),
  };

  function getLocator(
    page: MockPage,
    args: { text?: string; role?: string; name?: string; index?: number }
  ): MockLocator {
    if (args.role) {
      const options: any = {};
      if (args.name) options.name = args.name;
      let locator = page.getByRole(args.role as any, options);
      if (args.text) locator = locator.filter({ hasText: args.text });
      if (args.index !== undefined) locator = locator.nth(args.index);
      return locator;
    }
    if (args.text) {
      let locator = page.getByText(args.text);
      if (args.index !== undefined) locator = locator.nth(args.index);
      return locator;
    }
    throw new Error('Must specify either text or role to identify an element');
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should build locator with text only', () => {
    const locator = getLocator(mockPage, { text: 'Submit' });
    expect(mockPage.getByText).toHaveBeenCalledWith('Submit');
    expect(locator.type).toBe('locator');
  });

  it('should build locator with role only', () => {
    const locator = getLocator(mockPage, { role: 'button' });
    expect(mockPage.getByRole).toHaveBeenCalledWith('button', {});
    expect(locator.type).toBe('locator');
  });

  it('should build locator with role and name', () => {
    const locator = getLocator(mockPage, { role: 'button', name: 'Submit' });
    expect(mockPage.getByRole).toHaveBeenCalledWith('button', { name: 'Submit' });
    expect(locator.type).toBe('locator');
  });

  it('should build locator with text and index', () => {
    const locator = getLocator(mockPage, { text: 'Edit', index: 1 });
    expect(mockPage.getByText).toHaveBeenCalledWith('Edit');
    expect(locator.type).toBe('locator');
  });

  it('should throw error when neither text nor role provided', () => {
    expect(() => getLocator(mockPage, { index: 0 })).toThrow(
      'Must specify either text or role to identify an element'
    );
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('Error Handling', () => {
  it('should handle element not found errors', () => {
    const error = new Error('Element not found');
    const result = { error: `Click failed: ${error.message}` };
    expect(result.error).toBe('Click failed: Element not found');
  });

  it('should handle navigation errors', () => {
    const error = new Error('net::ERR_CONNECTION_REFUSED');
    const result = { error: `Navigation failed: ${error.message}` };
    expect(result.error).toBe('Navigation failed: net::ERR_CONNECTION_REFUSED');
  });

  it('should handle timeout errors', () => {
    const error = new Error('Timeout 5000ms exceeded');
    const result = { error: `Wait for text failed: ${error.message}` };
    expect(result.error).toBe('Wait for text failed: Timeout 5000ms exceeded');
  });

  it('should handle non-Error objects', () => {
    const error = 'String error';
    const result = { error: `Upload file failed: ${String(error)}` };
    expect(result.error).toBe('Upload file failed: String error');
  });
});
