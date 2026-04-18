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
 *     → context.exposeFunction('__gentyrDemoInterrupt')
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

/** Returns true if the demo has been interrupted via Escape key. */
export function isInterrupted() { return interrupted; }

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

    // Remove cursor dot (element removal — mousemove listener becomes harmless)
    var cursor = document.getElementById('demo-cursor');
    if (cursor) cursor.remove();

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
    msg.textContent = 'Demo Interrupted \u2014 interact freely';
    overlay.appendChild(msg);

    // Suppress thinking bubbles / step progress if demo code re-creates them.
    // Disconnect on page unload to avoid leak.
    if (overlay.parentNode) {
      var obs = new MutationObserver(function(muts) {
        for (var i = 0; i < muts.length; i++) {
          for (var j = 0; j < muts[i].addedNodes.length; j++) {
            var n = muts[i].addedNodes[j];
            if (n.id === 'demo-thinking-bubble' || n.id === 'demo-step-progress') n.remove();
          }
        }
      });
      obs.observe(overlay.parentNode, { childList: true });
      window.addEventListener('unload', function() { obs.disconnect(); }, { once: true });
    }

    // Store interrupted state on window for navigation persistence
    window.__gentyrDemoInterrupted = true;
  }, { icon: INTERRUPTED_ICON });
}

// ─── Escape Keydown Listener Script ─────────────────────────────────────────

/**
 * Raw JS string injected via context.addInitScript().
 * Runs on every document load, on all pages in the context.
 * Deduplicates via window.__demoOverlayEscHandler flag.
 */
const ESCAPE_LISTENER_SCRIPT = `
  if (!window.__demoOverlayEscHandler) {
    var handler = function(e) {
      if (e.key === 'Escape' && !window.__gentyrDemoInterrupted) {
        window.__gentyrDemoInterrupted = true;
        var fn = window.__gentyrDemoInterrupt;
        if (fn) fn();
      }
    };
    window.__demoOverlayEscHandler = handler;
    document.addEventListener('keydown', handler);
  }
`;

// ─── Interrupt Handler (runs in Node context) ───────────────────────────────

/**
 * Called from the browser via exposeFunction when the user presses Escape.
 * Idempotent — safe to call multiple times.
 */
async function handleInterrupt() {
  if (interrupted) return;
  interrupted = true;

  // ── SYNC CRITICAL SECTION ──────────────────────────────────────────────
  // These MUST complete before the Locator cursor-highlight patch sees
  // isInterrupted()===true and throws DemoInterruptedError. That throw
  // propagates up the test stack and triggers Playwright cleanup which
  // calls context.close(). If we haven't patched close() yet, the browser
  // disappears before the user sees anything.

  // 1. Patch context.close() AND browser.close() to no-op
  for (const page of registeredPages) {
    try {
      const ctx = page.context();
      if (!ctx.__interruptPatched) {
        ctx.__interruptPatched = true;
        ctx.close = async () => {};
        try {
          const browser = ctx.browser();
          if (browser && !browser.__interruptPatched) {
            browser.__interruptPatched = true;
            browser.close = async () => {};
          }
        } catch {}
      }
    } catch {
      // Context may already be closing — ignore
    }
  }

  // 2. Keep the Node process alive so the browser stays open.
  //    - setInterval keeps the event loop running (prevents natural drain)
  //    - process.exit patch blocks Playwright's test runner from exiting
  //    NOTE: We do NOT patch SIGTERM/SIGINT. External signals (dashboard 's' key,
  //    stop_demo) must still be able to kill the process and release ports.
  const keepAlive = setInterval(() => {}, 5000);
  globalThis.__gentyrKeepAlive = keepAlive;
  const originalExit = process.exit;
  process.exit = function () {};

  // When the user manually closes the browser, un-patch process.exit so
  // normal cleanup proceeds (web server shutdown, test data cleanup, ports released).
  for (const page of registeredPages) {
    try {
      const browser = page.context().browser();
      if (browser && !browser.__disconnectWired) {
        browser.__disconnectWired = true;
        browser.on('disconnected', () => {
          clearInterval(keepAlive);
          process.exit = originalExit;
          // Kill our own process group to clean up web servers, workers, etc.
          // This ensures no orphaned child processes (e.g., Mintlify on port 3333).
          try { process.kill(-process.pid, 'SIGTERM'); } catch {}
          setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }, 1000);
        });
      }
    } catch {}
  }

  // 3. Write demo_interrupted event to progress JSONL (best-effort, sync)
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

  // ── ASYNC SECTION (best-effort) ────────────────────────────────────────
  // Overlay update uses page.evaluate() which is async. May not complete
  // before the Locator patch throws, but browser stays open either way.

  // 4. Update overlay to interrupted state on all registered pages
  for (const page of registeredPages) {
    try {
      await showInterruptedOverlay(page);
    } catch {
      // Page may have been closed — ignore
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Wire up the Escape key interrupt handler for all pages in a BrowserContext.
 *
 * Uses context-level APIs for reliability — no per-page async setup, no race
 * conditions with page navigation:
 *   - context.exposeFunction: makes __gentyrDemoInterrupt available on ALL
 *     pages (current and future), survives navigation automatically.
 *   - context.addInitScript: injects the Escape keydown listener on every
 *     document load across all pages — no manual re-injection needed.
 *
 * @param {import('@playwright/test').BrowserContext} context
 */
export async function setupDemoInterrupt(context) {
  // Skip entirely in headless mode — no user present
  if (process.env.DEMO_HEADLESS === '1') return;

  // 1. Expose interrupt handler on ALL pages (context-level, survives navigation)
  try {
    await context.exposeFunction('__gentyrDemoInterrupt', handleInterrupt);
  } catch {
    // Already exposed (e.g., by auto-setup or double-call) — fine
  }

  // 2. Inject Escape keydown listener on every document load (all pages, all navigations)
  await context.addInitScript({ content: ESCAPE_LISTENER_SCRIPT });

  // 3. Track pages for overlay updates when interrupt fires
  for (const page of context.pages()) {
    registeredPages.add(page);
    page.on('close', () => registeredPages.delete(page));
  }
  context.on('page', (page) => {
    registeredPages.add(page);
    page.on('close', () => registeredPages.delete(page));
  });
}
