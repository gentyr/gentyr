import type { Page, BrowserContext } from '@playwright/test';
import { injectPersonaOverlay, type PersonaColors, type OverlayConfig } from './persona-overlay.js';
import { throwIfInterrupted } from './interrupt.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default standalone LiveCodes URL */
export const DEFAULT_EDITOR_URL = 'http://localhost:7682';

/** CodeMirror selectors — directly on page (no iframe) */
export const EDITOR_SELECTORS = {
  /** CodeMirror editor container */
  editor: '.cm-editor',
  /** CodeMirror editable content area */
  content: '.cm-editor .cm-content',
  /** LiveCodes Run button */
  runButton: '[data-hint="Run"]',
  /** LiveCodes console output panel */
  consoleOutput: '.open-in-new-page ~ div, [class*="console"]',
} as const;

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

/** Returns the select-all keyboard shortcut for the current platform. */
export function selectAllShortcut(): string {
  return process.platform === 'darwin' ? 'Meta+a' : 'Control+a';
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

export interface EditorConfig {
  /** Programming language (default: 'typescript') */
  language?: string;
  /** Page title */
  title?: string;
  /** Initial code to pre-load */
  initialCode?: string;
  /** Editor theme (default: 'dark') */
  theme?: string;
  /** Overlay configuration */
  overlayConfig?: OverlayConfig;
}

/**
 * Build the standalone LiveCodes URL with config query parameter.
 */
export function buildEditorUrl(config?: EditorConfig): string {
  const base = process.env.EDITOR_URL || DEFAULT_EDITOR_URL;
  if (!config) {return base;}

  const params: Record<string, string> = {};
  if (config.language) {params.language = config.language;}
  if (config.title) {params.title = config.title;}
  if (config.initialCode) {params.code = config.initialCode;}
  if (config.theme) {params.theme = config.theme;}

  // Only add ?config= if there are params to pass
  if (Object.keys(params).length === 0) {return base;}

  const encoded = encodeURIComponent(JSON.stringify(params));
  return `${base}?config=${encoded}`;
}

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------

/**
 * Open a new browser tab with a standalone LiveCodes editor.
 *
 * Unlike the docs portal pattern (which uses frameLocator('iframe')), this
 * opens LiveCodes as the full page — CodeMirror selectors are accessed
 * directly on the page without iframe traversal.
 *
 * @param context  - Playwright browser context (to open new page)
 * @param persona  - Persona name for overlay injection
 * @param config   - Editor configuration (language, initial code, etc.)
 * @param colorMap - Optional map of persona names to colors
 * @returns The new Page targeting the standalone editor
 */
export async function openEditorTab(
  context: BrowserContext,
  persona: string,
  config?: EditorConfig,
  colorMap?: Record<string, PersonaColors>,
): Promise<Page> {
  const url = buildEditorUrl(config);
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector(EDITOR_SELECTORS.content, { timeout: 30_000 });
  await injectPersonaOverlay(page, persona, config?.overlayConfig, colorMap);
  return page;
}

// ---------------------------------------------------------------------------
// Editor interaction
// ---------------------------------------------------------------------------

export interface TypeCodeOptions {
  /** Delay between keystrokes in ms (default: 30) */
  delay?: number;
  /** Clear existing content before typing (default: true) */
  clearFirst?: boolean;
}

/**
 * Type code into the standalone LiveCodes editor.
 *
 * Key difference from the docs portal pattern: accesses `.cm-editor .cm-content`
 * directly on the page — no `frameLocator('iframe')` needed.
 */
export async function typeCode(
  page: Page,
  code: string,
  options?: TypeCodeOptions,
): Promise<void> {
  throwIfInterrupted();
  const delay = options?.delay ?? 30;
  const clearFirst = options?.clearFirst ?? true;

  const editor = page.locator(EDITOR_SELECTORS.content).first();
  await editor.waitFor({ timeout: 10_000 });
  await editor.click();

  if (clearFirst) {
    await page.keyboard.press(selectAllShortcut());
    await page.keyboard.press('Delete');
  }

  await editor.pressSequentially(code, { delay });
}

/**
 * Read the current editor content.
 */
export async function getEditorContent(page: Page): Promise<string> {
  throwIfInterrupted();
  const editor = page.locator(EDITOR_SELECTORS.content).first();
  await editor.waitFor({ timeout: 10_000 });
  return editor.innerText();
}

/**
 * Click the Run button in LiveCodes.
 */
export async function runCode(page: Page): Promise<void> {
  throwIfInterrupted();
  const runBtn = page.locator(EDITOR_SELECTORS.runButton);
  await runBtn.waitFor({ timeout: 10_000 });
  await runBtn.click();
}

/**
 * Read the console output from LiveCodes console panel.
 */
export async function getConsoleOutput(page: Page): Promise<string> {
  throwIfInterrupted();
  const consolePanel = page.locator(EDITOR_SELECTORS.consoleOutput).first();
  await consolePanel.waitFor({ timeout: 10_000 });
  return consolePanel.innerText();
}
