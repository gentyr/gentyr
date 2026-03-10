import type { Page, BrowserContext } from '@playwright/test';
import { injectPersonaOverlay, type PersonaColors, type OverlayConfig } from './persona-overlay.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default ttyd terminal URL */
export const DEFAULT_TERMINAL_URL = 'http://localhost:7681';

/** xterm.js CSS selectors used for interaction */
export const XTERM_SELECTORS = {
  /** Root container */
  container: '.xterm',
  /** Text content rows */
  rows: '.xterm-rows',
  /** Hidden textarea for keyboard input */
  input: '.xterm-helper-textarea',
} as const;

/** Default typing delay in ms per character */
const DEFAULT_CHAR_DELAY = 40;

/** Default shell prompt pattern */
const DEFAULT_PROMPT_PATTERN = /\$\s*$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the terminal URL, reading from TERMINAL_URL env var or using default.
 */
export function getTerminalUrl(): string {
  return process.env.TERMINAL_URL || DEFAULT_TERMINAL_URL;
}

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------

/**
 * Open a new browser tab pointing to the ttyd terminal.
 * Waits for the xterm container to render before returning.
 *
 * @param context  - Playwright browser context (to open new page)
 * @param persona  - Persona name for overlay injection
 * @param overlayConfig - Optional overlay configuration
 * @param colorMap - Optional map of persona names to colors
 * @returns The new Page targeting the terminal
 */
export async function openTerminalTab(
  context: BrowserContext,
  persona: string,
  overlayConfig?: OverlayConfig,
  colorMap?: Record<string, PersonaColors>,
): Promise<Page> {
  const url = getTerminalUrl();
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector(XTERM_SELECTORS.container, { timeout: 15_000 });
  await injectPersonaOverlay(page, persona, overlayConfig, colorMap);
  return page;
}

// ---------------------------------------------------------------------------
// Terminal interaction
// ---------------------------------------------------------------------------

export interface TypeCommandOptions {
  /** Delay between keystrokes in ms (default: 40) */
  delay?: number;
  /** Whether to press Enter after typing (default: true) */
  pressEnter?: boolean;
}

/**
 * Type a command into the terminal character by character.
 *
 * Uses the xterm hidden textarea for keyboard input, matching how a real
 * user would type. Each character is sent with a configurable delay for
 * a realistic typing effect.
 */
export async function typeCommand(
  page: Page,
  command: string,
  options?: TypeCommandOptions,
): Promise<void> {
  const delay = options?.delay ?? DEFAULT_CHAR_DELAY;
  const pressEnter = options?.pressEnter ?? true;

  const input = page.locator(XTERM_SELECTORS.input);
  await input.focus();
  await input.pressSequentially(command, { delay });

  if (pressEnter) {
    await page.keyboard.press('Enter');
  }
}

/**
 * Wait for specific output to appear in the terminal.
 *
 * Polls the text content of `.xterm-rows` until the pattern matches.
 */
export async function waitForOutput(
  page: Page,
  pattern: string | RegExp,
  options?: { timeout?: number },
): Promise<void> {
  const timeout = options?.timeout ?? 30_000;
  const regexSource = typeof pattern === 'string'
    ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : pattern.source;
  const regexFlags = typeof pattern === 'string' ? 'i' : pattern.flags;

  await page.waitForFunction(
    ({ selector, source, flags }) => {
      const rows = document.querySelector(selector);
      if (!rows) {return false;}
      const text = rows.textContent || '';
      const re = new RegExp(source, flags);
      return re.test(text);
    },
    { selector: XTERM_SELECTORS.rows, source: regexSource, flags: regexFlags },
    { timeout },
  );
}

/**
 * Wait for the shell prompt to appear, indicating the previous command completed.
 */
export async function waitForPrompt(
  page: Page,
  options?: { timeout?: number; promptPattern?: RegExp },
): Promise<void> {
  const pattern = options?.promptPattern ?? DEFAULT_PROMPT_PATTERN;
  await waitForOutput(page, pattern, { timeout: options?.timeout ?? 30_000 });
}

/**
 * Clear the terminal screen (sends Ctrl+L).
 */
export async function clearTerminal(page: Page): Promise<void> {
  const input = page.locator(XTERM_SELECTORS.input);
  await input.focus();
  await page.keyboard.press('Control+l');
}
