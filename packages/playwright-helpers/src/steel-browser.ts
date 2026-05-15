/**
 * Steel.dev browser connection helpers for Playwright tests.
 *
 * The Steel-only execution path in GENTYR's playwright MCP server runs
 * Playwright on the host but the browser lives in Steel's cloud. The server
 * injects `STEEL_CDP_URL` (and `STEEL_SESSION_ID`) into the test process
 * environment. Target project tests must call `chromium.connectOverCDP(url)`
 * instead of the standard fixtures, or the test will launch a local Chrome
 * and silently ignore Steel.
 *
 * This module provides two ergonomic ways to honor that contract:
 *
 *   1. {@link connectToSteelOrLaunch} — drop-in helper for tests that already
 *      orchestrate their own browser/context. Returns a Steel-connected
 *      Browser when `STEEL_CDP_URL` is set, otherwise launches locally.
 *
 *   2. {@link steelAwareTest} — Playwright test fixture that overrides the
 *      built-in `browser` fixture. Tests just do
 *      `import { test } from '@gentyr/playwright-helpers/steel'` and the
 *      routing happens automatically.
 *
 * Both paths are no-ops when `STEEL_CDP_URL` is empty, so the same demo file
 * works for local, Fly.io, and Steel.dev execution targets.
 */

import {
  test as baseTest,
  chromium,
  type Browser,
  type BrowserType,
  type LaunchOptions,
} from '@playwright/test';

/**
 * Resolve the Steel CDP URL from process env. Returns `undefined` when not
 * present so callers can fall through to a local launch.
 */
export function getSteelCdpUrl(): string | undefined {
  const url = process.env.STEEL_CDP_URL;
  return url && url.length > 0 ? url : undefined;
}

/**
 * Connect to a Steel cloud browser if `STEEL_CDP_URL` is set, otherwise
 * launch a local browser via the supplied BrowserType.
 *
 * The Steel-backed browser's lifecycle is owned by GENTYR's playwright MCP
 * server (which releases the Steel session at demo completion), so this
 * helper deliberately does NOT close the browser on Steel. Closing it would
 * trigger Steel's session-release path twice and produce a noisy 404.
 *
 * @param browserType - usually `chromium` from `@playwright/test`. Steel only
 *   supports Chromium-compatible CDP, so passing `firefox`/`webkit` falls
 *   through to a local launch with a warning even when `STEEL_CDP_URL` is set.
 * @param launchOptions - applied only when launching locally; ignored for
 *   Steel connections.
 * @returns the resolved Browser plus a `target` discriminator so callers can
 *   branch behavior (e.g. skip storage-state persistence on Steel).
 */
export async function connectToSteelOrLaunch(
  browserType: BrowserType = chromium,
  launchOptions: LaunchOptions = {},
): Promise<{ browser: Browser; target: 'steel' | 'local' }> {
  const cdpUrl = getSteelCdpUrl();

  if (cdpUrl) {
    if (browserType.name() !== 'chromium') {
      process.stderr.write(
        `[playwright-helpers] STEEL_CDP_URL is set but browser is ${browserType.name()}; ` +
        'Steel only supports Chromium. Falling back to local launch.\n',
      );
    } else {
      const browser = await chromium.connectOverCDP(cdpUrl);
      return { browser, target: 'steel' };
    }
  }

  const browser = await browserType.launch(launchOptions);
  return { browser, target: 'local' };
}

/**
 * Playwright test extension that overrides the `browser` fixture to use
 * Steel.dev when `STEEL_CDP_URL` is set. Drop-in replacement for `test`:
 *
 * ```ts
 * import { test, expect } from '@gentyr/playwright-helpers/steel';
 *
 * test('logs in via Steel when stealth is requested', async ({ page }) => {
 *   await page.goto('https://claude.ai');
 *   await expect(page).toHaveTitle(/Claude/);
 * });
 * ```
 *
 * The `browserName` and `launchOptions` project config still apply when
 * Steel is not configured.
 */
export const steelAwareTest = baseTest.extend<object, { browser: Browser }>({
  browser: [
    async ({ playwright, browserName }, use) => {
      const cdpUrl = getSteelCdpUrl();
      if (cdpUrl && browserName === 'chromium') {
        const browser = await playwright.chromium.connectOverCDP(cdpUrl);
        try {
          await use(browser);
        } finally {
          // Do NOT close — GENTYR releases the Steel session at demo end.
        }
        return;
      }
      // Fall through to the project's configured launch.
      const browser = await playwright[browserName].launch();
      try {
        await use(browser);
      } finally {
        await browser.close().catch(() => {
          /* best-effort */
        });
      }
    },
    { scope: 'worker' },
  ],
});

/**
 * Re-export Playwright's `expect` so callers can do
 * `import { test, expect } from '@gentyr/playwright-helpers/steel'`.
 */
export { expect } from '@playwright/test';
