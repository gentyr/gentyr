/**
 * Demo Interrupt Setup — Standalone module for target projects
 *
 * Provides Escape key interrupt for headed Playwright demos.
 * Auto-available in target projects via the .claude/hooks directory symlink.
 *
 * Usage in target project fixtures.ts:
 *   import { setupDemoInterrupt } from '../../.claude/hooks/lib/demo-interrupt-setup.js';
 *   await setupDemoInterrupt(context);
 *
 * Communication chain:
 *   Browser DOM (Escape keydown)
 *     → page.exposeFunction('__gentyrDemoInterrupt')
 *     → Node callback (sets flag, writes JSONL progress event, updates overlay)
 *     → MCP server reads progress file → pauses task, discards recording
 */

import fs from 'fs';

// ─── Constants ───────────────────────────────────────────────────────────────

const INTERRUPTED_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;vertical-align:middle">
  <rect x="1" y="1" width="14" height="14" rx="3" fill="#f59e0b"/>
  <rect x="5" y="4.5" width="2.5" height="7" rx="0.5" fill="white"/>
  <rect x="8.5" y="4.5" width="2.5" height="7" rx="0.5" fill="white"/>
</svg>`;

// ─── Module-Level State ─────────────────────────────────────────────────────
//
// INVARIANT: Each demo runs in a separate Playwright child process, so this
// module is loaded fresh each time. The interrupt state is NOT resettable —
// once set, all helpers in this process will see interrupted === true.
// Do not attempt to run multiple sequential demos in the same process.

let interrupted = false;
const registeredPages = new Set();
const exposedPages = new WeakSet();

// ─── Overlay Update (Interrupted State) ─────────────────────────────────────

/**
 * Updates the persona overlay on a single page to show the interrupted state.
 * No-ops silently if the page has no overlay element.
 */
async function showInterruptedOverlay(page) {
  await page.evaluate(({ icon }) => {
    const overlay = document.getElementById('demo-persona-overlay');
    if (!overlay) return;

    // Remove step progress bar
    const stepProgress = document.getElementById('demo-step-progress');
    if (stepProgress) stepProgress.remove();

    // Remove thinking bubble
    const bubble = document.getElementById('demo-thinking-bubble');
    if (bubble) bubble.remove();

    // Update status icon
    const iconEl = document.getElementById('demo-overlay-status-icon');
    if (iconEl) iconEl.innerHTML = icon;

    // Update border color to amber
    overlay.style.borderLeftColor = '#f59e0b';

    // Replace overlay content after icon row with interrupted message
    const children = Array.from(overlay.children);
    // Keep the first child (header row with icon), remove the rest
    for (let i = 1; i < children.length; i++) {
      children[i].remove();
    }

    // Add interrupted message
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.7);margin-top:4px;line-height:1.4;';
    msg.textContent = 'Demo Interrupted — interact freely';
    overlay.appendChild(msg);

    // Store interrupted state on window for navigation persistence
    window.__gentyrDemoInterrupted = true;
  }, { icon: INTERRUPTED_ICON });
}

// ─── Escape Keydown Listener Injection ──────────────────────────────────────

/**
 * Injects the Escape keydown listener into the page DOM.
 * Safe to call multiple times — deduplicates via window.__demoOverlayEscHandler flag.
 * exposeFunction survives navigation but DOM listeners do not, so this is
 * re-called from the page 'load' event handler.
 */
async function injectEscapeListener(page) {
  await page.evaluate(() => {
    if (window.__demoOverlayEscHandler) return;
    const handler = (e) => {
      if (e.key === 'Escape' && !window.__gentyrDemoInterrupted) {
        window.__gentyrDemoInterrupted = true;
        const fn = window.__gentyrDemoInterrupt;
        if (fn) fn();
      }
    };
    window.__demoOverlayEscHandler = handler;
    document.addEventListener('keydown', handler);
  });
}

// ─── Interrupt Handler (runs in Node context) ───────────────────────────────

/**
 * Called from the browser via exposeFunction when the user presses Escape.
 * Idempotent — safe to call multiple times.
 */
async function handleInterrupt() {
  if (interrupted) return;
  interrupted = true;

  // Write demo_interrupted event to progress JSONL (best-effort)
  const progressFile = process.env.DEMO_PROGRESS_FILE;
  if (progressFile) {
    try {
      const event = JSON.stringify({
        type: 'demo_interrupted',
        timestamp: new Date().toISOString(),
        source: 'escape_key',
      });
      fs.appendFileSync(progressFile, event + '\n');
    } catch {
      // Progress tracking is not critical — never throw from here
    }
  }

  // Update overlay to interrupted state on all registered pages
  for (const page of registeredPages) {
    try {
      await showInterruptedOverlay(page);
    } catch {
      // Page may have been closed — ignore
    }
  }

  // Patch context.close() to no-op so Playwright teardown doesn't close the browser.
  // Iterate over registered pages to reach their contexts.
  for (const page of registeredPages) {
    try {
      const ctx = page.context();
      if (!ctx.__interruptPatched) {
        ctx.__interruptPatched = true;
        ctx.close = async () => {};
      }
    } catch {
      // Context may already be closing — ignore
    }
  }

  // Keep the Node process alive so the user can interact with the browser freely
  const keepAlive = setInterval(() => {}, 5000);
  // Store reference globally so it is never GC'd
  globalThis.__gentyrKeepAlive = keepAlive;
}

// ─── Per-Page Setup ──────────────────────────────────────────────────────────

/**
 * Wires up the Escape key interrupt handler for a single Playwright page.
 * Called once per page, including pages opened after setupDemoInterrupt().
 */
async function setupPage(page) {
  // Register page for overlay updates and de-register on close
  registeredPages.add(page);
  page.on('close', () => registeredPages.delete(page));

  // Expose the Node-side interrupt callback into the browser (once per page).
  // exposeFunction survives navigation, so we only need to do this once.
  if (!exposedPages.has(page)) {
    try {
      await page.exposeFunction('__gentyrDemoInterrupt', handleInterrupt);
      exposedPages.add(page);
    } catch {
      // May fail if the function was already exposed at the context level.
      // Warn in the browser console so the user knows Escape won't work.
      try {
        await page.evaluate(() => {
          console.warn('[GENTYR] Escape key interrupt unavailable on this page — exposeFunction failed');
        });
      } catch {
        // Page may be closing — ignore
      }
    }
  }

  // Inject the DOM keydown listener now ...
  await injectEscapeListener(page);

  // ... and re-inject after every navigation (DOM listeners don't survive navigation).
  page.on('load', () => {
    injectEscapeListener(page).catch(() => {
      // Page may be closing mid-navigation — ignore
    });
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Wire up the Escape key interrupt handler for all pages in a BrowserContext.
 *
 * Call once from your Playwright fixture after creating the context:
 *
 *   import { setupDemoInterrupt } from '../../.claude/hooks/lib/demo-interrupt-setup.js';
 *   await setupDemoInterrupt(context);
 *
 * The function is a no-op in headless mode (DEMO_HEADLESS=1) because there is
 * no user present to press Escape.
 *
 * @param {import('@playwright/test').BrowserContext} context
 */
export async function setupDemoInterrupt(context) {
  // Skip entirely in headless mode — no user present
  if (process.env.DEMO_HEADLESS === '1') return;

  // Wire up any pages that already exist in this context
  for (const page of context.pages()) {
    await setupPage(page);
  }

  // Auto-wire future pages opened within this context
  context.on('page', (page) => {
    setupPage(page).catch(() => {
      // New page may close before setup completes — ignore
    });
  });
}
