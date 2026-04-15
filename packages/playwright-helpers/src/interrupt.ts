/**
 * Demo Interrupt Module
 *
 * Provides an Escape key interrupt mechanism for headed Playwright demos.
 * When the user presses Escape during a demo, automation stops, the overlay
 * shows "Demo Interrupted", and the browser stays alive for manual interaction.
 *
 * Communication chain:
 *   Browser DOM (Escape keydown)
 *     → page.exposeFunction('__gentyrDemoInterrupt')
 *     → Node callback (sets flag, writes JSONL progress event, updates overlay)
 *     → MCP server reads progress file → pauses task, discards recording
 */

import type { Page, BrowserContext } from '@playwright/test';
import fs from 'fs';

// ─── Error Class ────────────────────────────────────────────────────────────

export class DemoInterruptedError extends Error {
  constructor(message = 'Demo interrupted by user') {
    super(message);
    this.name = 'DemoInterruptedError';
  }
}

// ─── Module-Level State ─────────────────────────────────────────────────────
//
// INVARIANT: Each demo runs in a separate Playwright child process, so this
// module is loaded fresh each time. The interrupt state is NOT resettable —
// once set, all helpers in this process will throw DemoInterruptedError.
// Do not attempt to run multiple sequential demos in the same process.

let interrupted = false;
let interruptResolve: (() => void) | null = null;
const interruptPromise = new Promise<void>((resolve) => {
  interruptResolve = resolve;
});
const registeredPages = new Set<Page>();
const exposedPages = new WeakSet<Page>();

// ─── Public API ─────────────────────────────────────────────────────────────

/** Returns true if the demo has been interrupted via Escape key. */
export function isInterrupted(): boolean {
  return interrupted;
}

/** Throws DemoInterruptedError if the demo has been interrupted. */
export function throwIfInterrupted(): void {
  if (interrupted) {
    throw new DemoInterruptedError();
  }
}

/**
 * Returns a promise that resolves when the demo is interrupted.
 * Useful for racing against long-running waits:
 *   await Promise.race([page.waitForFunction(...), getInterruptPromise()])
 */
export function getInterruptPromise(): Promise<void> {
  return interruptPromise;
}

// ─── Overlay Update (Interrupted State) ─────────────────────────────────────

const INTERRUPTED_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;vertical-align:middle">
  <rect x="1" y="1" width="14" height="14" rx="3" fill="#f59e0b"/>
  <rect x="5" y="4.5" width="2.5" height="7" rx="0.5" fill="white"/>
  <rect x="8.5" y="4.5" width="2.5" height="7" rx="0.5" fill="white"/>
</svg>`;

async function showInterruptedOverlay(page: Page): Promise<void> {
  await page.evaluate(
    ({ icon }) => {
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
      (window as unknown as Record<string, boolean>).__gentyrDemoInterrupted = true;
    },
    { icon: INTERRUPTED_ICON },
  );
}

// ─── Escape Keydown Listener Injection ──────────────────────────────────────

/**
 * Injects the Escape keydown listener into the page DOM.
 * Safe to call multiple times (deduplicates via window flag).
 * Called from enableDemoInterrupt and from the overlay's load handler.
 */
export async function injectEscapeListener(page: Page): Promise<void> {
  await page.evaluate(() => {
    if ((window as unknown as Record<string, unknown>).__demoOverlayEscHandler) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(window as unknown as Record<string, boolean>).__gentyrDemoInterrupted) {
        (window as unknown as Record<string, boolean>).__gentyrDemoInterrupted = true;
        const fn = (window as unknown as Record<string, (() => void) | undefined>).__gentyrDemoInterrupt;
        if (fn) fn();
      }
    };
    (window as unknown as Record<string, unknown>).__demoOverlayEscHandler = handler;
    document.addEventListener('keydown', handler);
  });
}

// ─── Interrupt Handler (runs in Node context) ───────────────────────────────

async function handleInterrupt(): Promise<void> {
  if (interrupted) return; // idempotent
  interrupted = true;

  // Resolve the interrupt promise (unblocks any racing waits)
  if (interruptResolve) {
    interruptResolve();
    interruptResolve = null;
  }

  // Write demo_interrupted event to progress JSONL
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
      // Best-effort — progress tracking is not critical
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

  // Keep the Node process alive (prevents Playwright from exiting)
  const keepAlive = setInterval(() => {}, 5000);
  (globalThis as unknown as Record<string, unknown>).__gentyrKeepAlive = keepAlive;

  // Patch BrowserContext.close to no-op on all registered pages
  // This prevents Playwright's teardown from closing the browser
  for (const page of registeredPages) {
    try {
      const ctx: BrowserContext & { __interruptPatched?: boolean } =
        page.context() as BrowserContext & { __interruptPatched?: boolean };
      if (!ctx.__interruptPatched) {
        ctx.__interruptPatched = true;
        ctx.close = async () => {};
      }
    } catch {
      // Ignore — context may already be closing
    }
  }
}

// ─── Setup ──────────────────────────────────────────────────────────────────

/**
 * Wire up the Escape key interrupt handler for a page.
 * Called automatically by injectPersonaOverlay for demo-mode overlays.
 *
 * - Exposes a Node function via page.exposeFunction (once per page)
 * - Injects a keydown listener that calls it on Escape
 * - Skips entirely in headless mode (no user to press Escape)
 */
export async function enableDemoInterrupt(page: Page): Promise<void> {
  // Skip in headless mode
  if (process.env.DEMO_HEADLESS === '1') return;

  // Register page for overlay updates
  registeredPages.add(page);
  page.on('close', () => registeredPages.delete(page));

  // Expose the interrupt callback (once per page)
  if (!exposedPages.has(page)) {
    try {
      await page.exposeFunction('__gentyrDemoInterrupt', handleInterrupt);
      exposedPages.add(page);
    } catch {
      // May fail if function already exposed (e.g., context-level exposure).
      // Log a warning to the browser console so users know Escape won't work.
      try {
        await page.evaluate(() => {
          console.warn('[GENTYR] Escape key interrupt unavailable on this page — exposeFunction failed');
        });
      } catch { /* page may be closing */ }
    }
  }

  // Inject the keydown listener into the page DOM
  await injectEscapeListener(page);
}
