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
 * - FEEDBACK_MODE: Optional. Persona consumption mode (gui/cli/sdk/adk)
 * - FEEDBACK_PERSONA_DESCRIPTION: Optional. Persona description for overlay
 * - FEEDBACK_PERSONA_COLOR: Optional. Hex color for overlay border
 * - FEEDBACK_FEATURE_NAME: Optional. Feature name for overlay
 * - FEEDBACK_FEATURE_DESCRIPTION: Optional. Feature description for overlay
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 2.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Page, Locator } from 'playwright';
import Database from 'better-sqlite3';
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
  ShowThoughtArgsSchema,
  HideThoughtArgsSchema,
  OpenTabArgsSchema,
  SwitchTabArgsSchema,
  ListTabsArgsSchema,
  CloseTabArgsSchema,
  TypeTerminalCommandArgsSchema,
  WaitForTerminalOutputArgsSchema,
  TypeCodeArgsSchema,
  RunCodeArgsSchema,
  GetCodeOutputArgsSchema,
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
  type ShowThoughtArgs,
  type HideThoughtArgs,
  type OpenTabArgs,
  type SwitchTabArgs,
  type ListTabsArgs,
  type CloseTabArgs,
  type TypeTerminalCommandArgs,
  type WaitForTerminalOutputArgs,
  type TypeCodeArgs,
  type RunCodeArgs,
  type GetCodeOutputArgs,
  type ErrorResult,
  type NavigationResult,
  type ScreenshotResult,
  type TextResult,
  type UrlResult,
  type SuccessResult,
  type TabListResult,
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
  recordVideo?: boolean;
  projectDir?: string;
  // Overlay and mode config
  feedbackMode?: string;
  personaDescription?: string;
  personaColor?: string;
  featureName?: string;
  featureDescription?: string;
}

// ============================================================================
// Factory Function
// ============================================================================

export function createPlaywrightFeedbackServer(config: PlaywrightFeedbackConfig): AuditedMcpServer {
  const viewportWidth = config.viewportWidth ?? 1280;
  const viewportHeight = config.viewportHeight ?? 720;

  // Initialize browser manager with config
  const browserManager = new BrowserManager({
    baseUrl: config.baseUrl,
    headless: config.headless ?? true,
    viewportWidth,
    viewportHeight,
    recordVideo: config.recordVideo ?? false,
    sessionId: config.auditSessionId,
    // Overlay config
    personaName: config.auditPersonaName,
    personaDescription: config.personaDescription,
    personaColor: config.personaColor,
    featureName: config.featureName,
    featureDescription: config.featureDescription,
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
  // Thought Bubble Tools
  // ============================================================================

  const THINKING_BUBBLE_CSS = `position:fixed;bottom:0;right:24px;z-index:999998;background:rgba(0,0,0,0.85);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);color:rgba(255,255,255,0.85);padding:10px 12px;border-radius:8px;border-left:3px solid hsl(220,70%,55%);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,0.4),0 1px 4px rgba(0,0,0,0.3);pointer-events:none;user-select:none;max-width:320px;max-height:200px;overflow-y:auto;opacity:0;transition:opacity 200ms ease,bottom 200ms ease;word-wrap:break-word;`;

  async function showThought(args: ShowThoughtArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      await page.evaluate(({ text, css }: { text: string; css: string }) => {
        const win = window as unknown as Record<string, unknown>;
        if (win['__demoThinkingHideTimer']) {
          clearTimeout(win['__demoThinkingHideTimer'] as number);
          delete win['__demoThinkingHideTimer'];
        }
        let bubble = document.getElementById('demo-thinking-bubble');
        if (!bubble) {
          bubble = document.createElement('div');
          bubble.id = 'demo-thinking-bubble';
          bubble.style.cssText = css;
          document.body.appendChild(bubble);
        }
        const overlay = document.getElementById('demo-persona-overlay');
        if (overlay) {
          const rect = overlay.getBoundingClientRect();
          bubble.style.bottom = `${window.innerHeight - rect.top + 8}px`;
        } else {
          bubble.style.bottom = '120px';
        }
        bubble.textContent = text;
        requestAnimationFrame(() => { bubble!.style.opacity = '1'; });
      }, { text: args.text, css: THINKING_BUBBLE_CSS });
      return { success: true, message: 'Thought displayed' };
    } catch (err) {
      return { error: `Show thought failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function hideThought(_args: HideThoughtArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      await page.evaluate(() => {
        const bubble = document.getElementById('demo-thinking-bubble');
        if (!bubble) return;
        bubble.style.opacity = '0';
        const win = window as unknown as Record<string, unknown>;
        win['__demoThinkingHideTimer'] = setTimeout(() => { bubble.remove(); delete win['__demoThinkingHideTimer']; }, 200);
      });
      return { success: true, message: 'Thought hidden' };
    } catch (err) {
      return { error: `Hide thought failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ============================================================================
  // Tab Management Tools
  // ============================================================================

  async function openTab(args: OpenTabArgs): Promise<SuccessResult | ErrorResult> {
    try {
      // Tab URLs must be within the allowed base URL (same as navigate)
      const baseUrl = browserManager.getBaseUrl();
      validateUrl(args.url, baseUrl);
      await browserManager.openTab(args.name, args.url);
      return { success: true, message: `Opened tab "${args.name}" at ${args.url}` };
    } catch (err) {
      return { error: `Open tab failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function switchTab(args: SwitchTabArgs): Promise<SuccessResult | ErrorResult> {
    try {
      browserManager.switchTab(args.name);
      return { success: true, message: `Switched to tab "${args.name}"` };
    } catch (err) {
      return { error: `Switch tab failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function listTabs(_args: ListTabsArgs): Promise<TabListResult | ErrorResult> {
    try {
      return { tabs: browserManager.listTabs() };
    } catch (err) {
      return { error: `List tabs failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function closeTab(args: CloseTabArgs): Promise<SuccessResult | ErrorResult> {
    try {
      await browserManager.closeTab(args.name);
      return { success: true, message: `Closed tab "${args.name}"` };
    } catch (err) {
      return { error: `Close tab failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ============================================================================
  // Terminal Tools
  // ============================================================================

  const XTERM_SELECTORS = { container: '.xterm', rows: '.xterm-rows', input: '.xterm-helper-textarea' };

  async function typeTerminalCommand(args: TypeTerminalCommandArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const input = page.locator(XTERM_SELECTORS.input);
      await input.focus();
      await input.pressSequentially(args.command, { delay: args.delay });
      if (args.press_enter) { await page.keyboard.press('Enter'); }
      return { success: true, message: `Typed command: ${args.command}` };
    } catch (err) {
      return { error: `Type terminal command failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function waitForTerminalOutput(args: WaitForTerminalOutputArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const escaped = args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await page.waitForFunction(
        ({ selector, pattern }: { selector: string; pattern: string }) => {
          const rows = document.querySelector(selector);
          if (!rows) return false;
          return new RegExp(pattern, 'i').test(rows.textContent || '');
        },
        { selector: XTERM_SELECTORS.rows, pattern: escaped },
        { timeout: args.timeout },
      );
      return { success: true, message: `Found output matching "${args.pattern}"` };
    } catch (err) {
      return { error: `Wait for terminal output failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ============================================================================
  // Editor Tools
  // ============================================================================

  const EDITOR_SELECTORS = { editor: '.cm-editor', content: '.cm-editor .cm-content', runButton: '[data-hint="Run"]', consoleOutput: '.open-in-new-page ~ div, [class*="console"]' };

  async function typeCode(args: TypeCodeArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const editor = page.locator(EDITOR_SELECTORS.content).first();
      await editor.waitFor({ timeout: 10_000 });
      await editor.click();
      if (args.clear_first) {
        const selectAll = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';
        await page.keyboard.press(selectAll);
        await page.keyboard.press('Delete');
      }
      await editor.pressSequentially(args.code, { delay: args.delay });
      return { success: true, message: 'Code typed' };
    } catch (err) {
      return { error: `Type code failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function runCode(_args: RunCodeArgs): Promise<SuccessResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const runBtn = page.locator(EDITOR_SELECTORS.runButton);
      await runBtn.waitFor({ timeout: 10_000 });
      await runBtn.click();
      return { success: true, message: 'Code executed' };
    } catch (err) {
      return { error: `Run code failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function getCodeOutput(_args: GetCodeOutputArgs): Promise<TextResult | ErrorResult> {
    try {
      const page = await browserManager.getPage();
      const consolePanel = page.locator(EDITOR_SELECTORS.consoleOutput).first();
      await consolePanel.waitFor({ timeout: 10_000 });
      return { text: await consolePanel.innerText() };
    } catch (err) {
      return { error: `Get code output failed: ${err instanceof Error ? err.message : String(err)}` };
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

  // Thought bubble tools — always available
  tools.push(
    { name: 'show_thought', description: 'Show a thought bubble in the browser overlay. Use every 2-3 actions to narrate your experience.', schema: ShowThoughtArgsSchema, handler: showThought },
    { name: 'hide_thought', description: 'Hide the current thought bubble.', schema: HideThoughtArgsSchema, handler: hideThought },
  );

  // Tab management tools — available for modes that use multiple tabs
  const feedbackMode = config.feedbackMode;
  if (feedbackMode === 'sdk' || feedbackMode === 'adk' || feedbackMode === 'cli') {
    tools.push(
      { name: 'open_tab', description: 'Open a new named browser tab at a URL.', schema: OpenTabArgsSchema, handler: openTab },
      { name: 'switch_tab', description: 'Switch to a named browser tab for subsequent interactions.', schema: SwitchTabArgsSchema, handler: switchTab },
      { name: 'list_tabs', description: 'List all open browser tabs.', schema: ListTabsArgsSchema, handler: listTabs },
      { name: 'close_tab', description: 'Close a named browser tab.', schema: CloseTabArgsSchema, handler: closeTab },
    );
  }

  // Terminal tools — available for CLI, SDK, ADK modes
  if (feedbackMode === 'cli' || feedbackMode === 'sdk' || feedbackMode === 'adk') {
    tools.push(
      { name: 'type_terminal_command', description: 'Type a command in the terminal tab character by character.', schema: TypeTerminalCommandArgsSchema, handler: typeTerminalCommand },
      { name: 'wait_for_terminal_output', description: 'Wait for a text pattern to appear in terminal output.', schema: WaitForTerminalOutputArgsSchema, handler: waitForTerminalOutput },
    );
  }

  // Editor tools — available for SDK, ADK modes
  if (feedbackMode === 'sdk' || feedbackMode === 'adk') {
    tools.push(
      { name: 'type_code', description: 'Type code in the LiveCodes editor tab.', schema: TypeCodeArgsSchema, handler: typeCode },
      { name: 'run_code', description: 'Click the Run button in the LiveCodes editor.', schema: RunCodeArgsSchema, handler: runCode },
      { name: 'get_code_output', description: 'Get console output from the LiveCodes editor.', schema: GetCodeOutputArgsSchema, handler: getCodeOutput },
    );
  }

  // ============================================================================
  // Server Setup
  // ============================================================================

  const server = new AuditedMcpServer({
    name: 'playwright-feedback',
    version: '2.0.0',
    tools,
    auditSessionId: config.auditSessionId,
    auditPersonaName: config.auditPersonaName,
    auditDbPath: config.auditDbPath,
  });

  // Persist video recording and clean up browser before process exits.
  // Video must be saved BEFORE closing the browser context — Playwright finalizes
  // the webm file when the context closes, and video.path() only works before that.
  async function persistVideoAndClose(): Promise<void> {
    if (config.recordVideo && config.auditSessionId && config.projectDir) {
      try {
        const videoSrc = await browserManager.getVideoPath();
        if (videoSrc) {
          const recordingsDir = path.join(config.projectDir, '.claude', 'recordings', 'feedback');
          fs.mkdirSync(recordingsDir, { recursive: true });
          const dest = path.join(recordingsDir, `${config.auditSessionId}.webm`);
          fs.copyFileSync(videoSrc, dest);

          // Update recording_path in user-feedback.db
          try {
            const dbPath = path.join(config.projectDir, '.claude', 'user-feedback.db');
            if (fs.existsSync(dbPath)) {
              const db = new Database(dbPath);
              db.pragma('journal_mode = WAL');
              // The recording_path column is added by the user-feedback server migration.
              // We do a best-effort update — if the column doesn't exist yet, we skip silently.
              try {
                db.prepare(
                  'UPDATE feedback_sessions SET recording_path = ? WHERE id = ?'
                ).run(dest, config.auditSessionId);
              } catch {
                // Column may not exist yet — non-fatal
              }
              db.close();
            }
          } catch {
            // Non-fatal: DB update failure should not prevent process exit
          }
        }
      } catch {
        // Non-fatal: video persistence failure should not prevent process exit
      }
    }
    await browserManager.close();
  }

  // SIGINT/SIGTERM: persist video then exit cleanly
  const handleSignal = (): void => {
    persistVideoAndClose().finally(() => process.exit(0));
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  // Clean up browser on process exit (best-effort sync fallback for unhandled exits)
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
    recordVideo: process.env['FEEDBACK_RECORD_VIDEO'] === '1',
    projectDir: process.env['CLAUDE_PROJECT_DIR'] || process.cwd(),
    // Overlay and mode config
    feedbackMode: process.env['FEEDBACK_MODE'],
    personaDescription: process.env['FEEDBACK_PERSONA_DESCRIPTION'],
    personaColor: process.env['FEEDBACK_PERSONA_COLOR'],
    featureName: process.env['FEEDBACK_FEATURE_NAME'],
    featureDescription: process.env['FEEDBACK_FEATURE_DESCRIPTION'],
  };

  const server = createPlaywrightFeedbackServer(config);
  // SIGINT/SIGTERM are registered inside createPlaywrightFeedbackServer
  // so that video persistence runs before exit.

  server.start();
}
