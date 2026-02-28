#!/usr/bin/env node
/**
 * Playwright Feedback MCP Server
 *
 * Provides Playwright-based browser interaction tools that let AI feedback
 * agents test web applications from a real user's perspective.
 *
 * Key Constraints:
 * - Element identification uses visible text and ARIA roles ONLY
 * - NO developer tools (no CSS selectors, no evaluate_javascript)
 * - This is what a REAL USER can do - nothing more
 *
 * Environment Variables (F001 Compliance):
 * - FEEDBACK_BASE_URL: Required. Base URL for navigation validation
 * - FEEDBACK_BROWSER_HEADLESS: Optional. Default "true"
 * - FEEDBACK_BROWSER_VIEWPORT_WIDTH: Optional. Default 1280
 * - FEEDBACK_BROWSER_VIEWPORT_HEIGHT: Optional. Default 720
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Page, Locator } from 'playwright';
import { type AnyToolHandler } from '../shared/server.js';
import { AuditedMcpServer } from '../shared/audited-server.js';
import { BrowserManager } from './browser-manager.js';
import {
  NavigateArgsSchema,
  GoBackArgsSchema,
  GoForwardArgsSchema,
  RefreshArgsSchema,
  GetCurrentUrlArgsSchema,
  ScreenshotArgsSchema,
  ReadVisibleTextArgsSchema,
  GetPageTitleArgsSchema,
  ClickArgsSchema,
  TypeTextArgsSchema,
  SelectOptionArgsSchema,
  CheckArgsSchema,
  HoverArgsSchema,
  PressKeyArgsSchema,
  UploadFileArgsSchema,
  DragAndDropArgsSchema,
  ScrollArgsSchema,
  ScrollToTextArgsSchema,
  WaitForTextArgsSchema,
  WaitForIdleArgsSchema,
  type NavigateArgs,
  type GoBackArgs,
  type GoForwardArgs,
  type RefreshArgs,
  type GetCurrentUrlArgs,
  type ScreenshotArgs,
  type ReadVisibleTextArgs,
  type GetPageTitleArgs,
  type ClickArgs,
  type TypeTextArgs,
  type SelectOptionArgs,
  type CheckArgs,
  type HoverArgs,
  type PressKeyArgs,
  type UploadFileArgs,
  type DragAndDropArgs,
  type ScrollArgs,
  type ScrollToTextArgs,
  type WaitForTextArgs,
  type WaitForIdleArgs,
  type ErrorResult,
  type NavigationResult,
  type ScreenshotResult,
  type TextResult,
  type UrlResult,
  type SuccessResult,
} from './types.js';

// ============================================================================
// Configuration Interface
// ============================================================================

export interface PlaywrightFeedbackConfig {
  baseUrl: string;
  headless?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
  auditSessionId: string;
  auditPersonaName?: string;
  auditDbPath?: string;
}

// ============================================================================
// Factory Function
// ============================================================================

export function createPlaywrightFeedbackServer(config: PlaywrightFeedbackConfig): AuditedMcpServer {
  // Initialize browser manager with config
  const browserManager = new BrowserManager({
    baseUrl: config.baseUrl,
    headless: config.headless ?? true,
    viewportWidth: config.viewportWidth ?? 1280,
    viewportHeight: config.viewportHeight ?? 720,
  });

  // ============================================================================
  // Helper Functions
  // ============================================================================

  /**
   * Get element locator using visible text or ARIA role
   * NO CSS selectors allowed - real users can't see those!
   */
  function getLocator(
    page: Page,
    args: { text?: string; role?: string; name?: string; index?: number }
  ): Locator {
    if (args.role) {
      const options: { name?: string | RegExp } = {};
      if (args.name) {
        options.name = args.name;
      }
      let locator = page.getByRole(args.role as any, options);
      if (args.text) {
        locator = locator.filter({ hasText: args.text });
      }
      if (args.index !== undefined) {
        locator = locator.nth(args.index);
      }
      return locator;
    }
    if (args.text) {
      let locator = page.getByText(args.text);
      if (args.index !== undefined) {
        locator = locator.nth(args.index);
      }
      return locator;
    }
    throw new Error('Must specify either text or role to identify an element');
  }

  /**
   * Validate URL is within allowed base URL
   */
  function validateUrl(url: string, baseUrl: string): void {
    if (!url.startsWith(baseUrl)) {
      throw new Error(`URL "${url}" is not within allowed base URL "${baseUrl}"`);
    }
  }

  // ============================================================================
  // Navigation Tools
  // ============================================================================

  async function navigate(args: NavigateArgs): Promise<NavigationResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const baseUrl = browserManager.getBaseUrl();
      validateUrl(args.url, baseUrl);

      await page.goto(args.url, { waitUntil: 'load' });
      const title = await page.title();

      return {
        url: page.url(),
        title,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Navigation failed: ${message}` };
    }
  }

  async function goBack(_args: GoBackArgs): Promise<NavigationResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      await page.goBack({ waitUntil: 'load' });
      const title = await page.title();

      return {
        url: page.url(),
        title,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Go back failed: ${message}` };
    }
  }

  async function goForward(_args: GoForwardArgs): Promise<NavigationResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      await page.goForward({ waitUntil: 'load' });
      const title = await page.title();

      return {
        url: page.url(),
        title,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Go forward failed: ${message}` };
    }
  }

  async function refresh(_args: RefreshArgs): Promise<NavigationResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      await page.reload({ waitUntil: 'load' });
      const title = await page.title();

      return {
        url: page.url(),
        title,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Refresh failed: ${message}` };
    }
  }

  async function getCurrentUrl(_args: GetCurrentUrlArgs): Promise<UrlResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      return { url: page.url() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Get current URL failed: ${message}` };
    }
  }

  // ============================================================================
  // Observation Tools
  // ============================================================================

  async function screenshot(args: ScreenshotArgs): Promise<ScreenshotResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const buffer = await page.screenshot({ fullPage: args.full_page ?? false });

      return {
        image: buffer.toString('base64'),
        format: 'png',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Screenshot failed: ${message}` };
    }
  }

  async function readVisibleText(_args: ReadVisibleTextArgs): Promise<TextResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const text = await page.innerText('body');

      return { text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Read visible text failed: ${message}` };
    }
  }

  async function getPageTitle(_args: GetPageTitleArgs): Promise<TextResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const text = await page.title();

      return { text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Get page title failed: ${message}` };
    }
  }

  // ============================================================================
  // Interaction Tools
  // ============================================================================

  async function click(args: ClickArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const locator = getLocator(page, args);
      await locator.click();

      return { success: true, message: 'Element clicked' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Click failed: ${message}` };
    }
  }

  async function typeText(args: TypeTextArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const locator = getLocator(page, args);

      if (args.clear) {
        await locator.clear();
      }
      await locator.fill(args.value);

      return { success: true, message: 'Text typed' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Type text failed: ${message}` };
    }
  }

  async function selectOption(args: SelectOptionArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const locator = getLocator(page, args);
      await locator.selectOption(args.value);

      return { success: true, message: 'Option selected' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Select option failed: ${message}` };
    }
  }

  async function check(args: CheckArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const locator = getLocator(page, args);

      if (args.checked) {
        await locator.check();
      } else {
        await locator.uncheck();
      }

      return { success: true, message: args.checked ? 'Checkbox checked' : 'Checkbox unchecked' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Check/uncheck failed: ${message}` };
    }
  }

  async function hover(args: HoverArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const locator = getLocator(page, args);
      await locator.hover();

      return { success: true, message: 'Element hovered' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Hover failed: ${message}` };
    }
  }

  async function pressKey(args: PressKeyArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      await page.keyboard.press(args.key);

      return { success: true, message: `Key "${args.key}" pressed` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Press key failed: ${message}` };
    }
  }

  async function uploadFile(args: UploadFileArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const locator = getLocator(page, args);
      await locator.setInputFiles(args.file_path);

      return { success: true, message: 'File uploaded' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Upload file failed: ${message}` };
    }
  }

  async function dragAndDrop(args: DragAndDropArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const source = page.getByText(args.source_text);
      const target = page.getByText(args.target_text);
      await source.dragTo(target);

      return { success: true, message: 'Drag and drop completed' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Drag and drop failed: ${message}` };
    }
  }

  // ============================================================================
  // Scrolling Tools
  // ============================================================================

  async function scroll(args: ScrollArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const amount = args.amount ?? 300;

      let deltaX = 0;
      let deltaY = 0;

      switch (args.direction) {
        case 'down':
          deltaY = amount;
          break;
        case 'up':
          deltaY = -amount;
          break;
        case 'right':
          deltaX = amount;
          break;
        case 'left':
          deltaX = -amount;
          break;
      }

      await page.mouse.wheel(deltaX, deltaY);

      return { success: true, message: `Scrolled ${args.direction} by ${amount}px` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Scroll failed: ${message}` };
    }
  }

  async function scrollToText(args: ScrollToTextArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const locator = page.getByText(args.text);
      await locator.scrollIntoViewIfNeeded();

      return { success: true, message: 'Scrolled to text' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Scroll to text failed: ${message}` };
    }
  }

  // ============================================================================
  // Waiting Tools
  // ============================================================================

  async function waitForText(args: WaitForTextArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const locator = page.getByText(args.text);
      await locator.waitFor({ timeout: args.timeout ?? 5000 });

      return { success: true, message: 'Text appeared' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Wait for text failed: ${message}` };
    }
  }

  async function waitForIdle(args: WaitForIdleArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      await page.waitForLoadState('networkidle', { timeout: args.timeout ?? 5000 });

      return { success: true, message: 'Network idle' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Wait for idle failed: ${message}` };
    }
  }

  // ============================================================================
  // Tool Definitions
  // ============================================================================

  const tools: AnyToolHandler[] = [
    // Navigation
    {
      name: 'navigate',
      description: 'Navigate to a URL (must be within allowed base URL). Waits for page load.',
      schema: NavigateArgsSchema,
      handler: navigate,
    },
    {
      name: 'go_back',
      description: 'Navigate back in browser history (browser back button).',
      schema: GoBackArgsSchema,
      handler: goBack,
    },
    {
      name: 'go_forward',
      description: 'Navigate forward in browser history (browser forward button).',
      schema: GoForwardArgsSchema,
      handler: goForward,
    },
    {
      name: 'refresh',
      description: 'Refresh the current page.',
      schema: RefreshArgsSchema,
      handler: refresh,
    },
    {
      name: 'get_current_url',
      description: 'Get the current page URL.',
      schema: GetCurrentUrlArgsSchema,
      handler: getCurrentUrl,
    },
    // Observation
    {
      name: 'screenshot',
      description: 'Take a screenshot of the current page. Returns base64-encoded PNG image.',
      schema: ScreenshotArgsSchema,
      handler: screenshot,
    },
    {
      name: 'read_visible_text',
      description: 'Get all visible text content on the page.',
      schema: ReadVisibleTextArgsSchema,
      handler: readVisibleText,
    },
    {
      name: 'get_page_title',
      description: 'Get the page title.',
      schema: GetPageTitleArgsSchema,
      handler: getPageTitle,
    },
    // Interaction
    {
      name: 'click',
      description: 'Click an element identified by visible text or ARIA role. Use index if multiple matches exist.',
      schema: ClickArgsSchema,
      handler: click,
    },
    {
      name: 'type_text',
      description: 'Type text into a field identified by visible text or ARIA role. Optionally clear existing text first.',
      schema: TypeTextArgsSchema,
      handler: typeText,
    },
    {
      name: 'select_option',
      description: 'Select an option from a dropdown by value or label.',
      schema: SelectOptionArgsSchema,
      handler: selectOption,
    },
    {
      name: 'check',
      description: 'Check or uncheck a checkbox identified by visible text or ARIA role.',
      schema: CheckArgsSchema,
      handler: check,
    },
    {
      name: 'hover',
      description: 'Hover the mouse over an element identified by visible text or ARIA role.',
      schema: HoverArgsSchema,
      handler: hover,
    },
    {
      name: 'press_key',
      description: 'Press a keyboard key (e.g., "Enter", "Tab", "Escape", "ArrowDown").',
      schema: PressKeyArgsSchema,
      handler: pressKey,
    },
    {
      name: 'upload_file',
      description: 'Upload a file to a file input element identified by visible text or ARIA role.',
      schema: UploadFileArgsSchema,
      handler: uploadFile,
    },
    {
      name: 'drag_and_drop',
      description: 'Drag an element to another element, both identified by visible text.',
      schema: DragAndDropArgsSchema,
      handler: dragAndDrop,
    },
    // Scrolling
    {
      name: 'scroll',
      description: 'Scroll the page in a direction by a specified number of pixels.',
      schema: ScrollArgsSchema,
      handler: scroll,
    },
    {
      name: 'scroll_to_text',
      description: 'Scroll until text is visible in the viewport.',
      schema: ScrollToTextArgsSchema,
      handler: scrollToText,
    },
    // Waiting
    {
      name: 'wait_for_text',
      description: 'Wait for text to appear on the page. Throws error on timeout.',
      schema: WaitForTextArgsSchema,
      handler: waitForText,
    },
    {
      name: 'wait_for_idle',
      description: 'Wait for network activity to be idle. Throws error on timeout.',
      schema: WaitForIdleArgsSchema,
      handler: waitForIdle,
    },
  ];

  // ============================================================================
  // Server Setup
  // ============================================================================

  const server = new AuditedMcpServer({
    name: 'playwright-feedback',
    version: '1.0.0',
    tools,
    auditSessionId: config.auditSessionId,
    auditPersonaName: config.auditPersonaName,
    auditDbPath: config.auditDbPath,
  });

  // Clean up browser on process exit (sync-only — best effort)
  process.on('exit', () => {
    browserManager.close().catch(() => { /* best-effort */ });
  });

  return server;
}

// ============================================================================
// Auto-start when run directly
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const config: PlaywrightFeedbackConfig = {
    baseUrl: process.env['FEEDBACK_BASE_URL'] || '',
    headless: process.env['FEEDBACK_BROWSER_HEADLESS'] !== 'false',
    viewportWidth: parseInt(process.env['FEEDBACK_BROWSER_VIEWPORT_WIDTH'] || '1280', 10),
    viewportHeight: parseInt(process.env['FEEDBACK_BROWSER_VIEWPORT_HEIGHT'] || '720', 10),
    auditSessionId: process.env['FEEDBACK_SESSION_ID'] || '',
    auditPersonaName: process.env['FEEDBACK_PERSONA_NAME'],
    auditDbPath: process.env['FEEDBACK_AUDIT_DB_PATH'],
  };

  const server = createPlaywrightFeedbackServer(config);

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  server.start();
}
