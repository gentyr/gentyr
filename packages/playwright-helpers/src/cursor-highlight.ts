/**
 * Cursor Highlight Script for Demo Visualization
 *
 * Injects a visible cursor dot into the page during headed demos.
 * Activated via DEMO_SHOW_CURSOR=1 environment variable.
 *
 * Two parts:
 *   1. CURSOR_HIGHLIGHT_SCRIPT — init script that renders a dot following mousemove events
 *   2. addMouseAnimation() — patches Locator prototype methods (click, fill, etc.) to animate
 *      the cursor dot to each target element before the action executes
 */

import type { Page } from '@playwright/test';

/**
 * Raw JS string for context.addInitScript().
 * Creates a fixed-position red dot that follows mouse movements.
 */
export const CURSOR_HIGHLIGHT_SCRIPT = `
  (function __initCursorDot() {
    if (document.getElementById('demo-cursor')) return;
    function inject() {
      if (document.getElementById('demo-cursor')) return;
      const dot = document.createElement('div');
      dot.id = 'demo-cursor';
      dot.style.cssText = [
        'width: 20px',
        'height: 20px',
        'border-radius: 50%',
        'background: rgba(239, 68, 68, 0.7)',
        'position: fixed',
        'z-index: 999998',
        'pointer-events: none',
        'box-shadow: 0 0 8px rgba(239, 68, 68, 0.4)',
        'display: none',
      ].join('; ');
      document.body.appendChild(dot);
      document.addEventListener('mousemove', (e) => {
        dot.style.left = (e.clientX - 10) + 'px';
        dot.style.top = (e.clientY - 10) + 'px';
        dot.style.display = 'block';
      });
      var style = document.createElement('style');
      style.textContent = '@keyframes demo-cursor-pulse{0%{transform:scale(1);opacity:.7}50%{transform:scale(2);opacity:.3}100%{transform:scale(1);opacity:.7}}';
      document.head.appendChild(style);
      window.__pulseCursor = function() {
        dot.style.animation = 'none';
        dot.offsetHeight;
        dot.style.animation = 'demo-cursor-pulse 300ms ease-out';
      };
    }
    if (document.body) { inject(); }
    else { document.addEventListener('DOMContentLoaded', inject); }
  })();
`;

/**
 * Per-page cursor state for animation coordination.
 * Stored in a WeakMap so multiple pages can have independent cursor tracking.
 */
interface CursorState {
  lastX: number;
  lastY: number;
  cdp: { send: (method: string, params: Record<string, unknown>) => Promise<unknown> };
}

const cursorStates = new WeakMap<Page, CursorState>();

/**
 * Animate the cursor to a target position using CDP Input.dispatchMouseEvent.
 * Fires intermediate mouseMoved events that the init script's listener sees,
 * making the cursor dot visibly travel across the page.
 */
async function animateMouseTo(
  cdp: CursorState['cdp'],
  fromX: number, fromY: number,
  toX: number, toY: number,
  steps = 15,
): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    const x = fromX + (toX - fromX) * (i / steps);
    const y = fromY + (toY - fromY) * (i / steps);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    });
    // Small delay between steps for visible animation
    await new Promise(r => setTimeout(r, 8));
  }
}

/**
 * Enable mouse animation on a Page via CDP + Locator prototype patching.
 *
 * Patches Locator prototype methods (click, fill, hover, etc.) to animate
 * the cursor dot to each target element before the action executes.
 * The prototype is patched once globally; per-page state is tracked via WeakMap.
 */
export async function addMouseAnimation(page: Page): Promise<void> {
  let cdp: CursorState['cdp'];

  try {
    cdp = await (page.context() as unknown as { newCDPSession: (page: Page) => Promise<CursorState['cdp']> }).newCDPSession(page);
  } catch {
    // CDP not available (e.g., non-Chromium) — skip animation
    return;
  }

  const state: CursorState = { lastX: 0, lastY: 0, cdp };
  cursorStates.set(page, state);

  // Re-create CDP session on cross-origin navigation
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame()) {
      try {
        state.cdp = await (page.context() as unknown as { newCDPSession: (page: Page) => Promise<CursorState['cdp']> }).newCDPSession(page);
      } catch { /* ignore */ }
    }
  });

  // Patch Locator prototype ONCE (shared across all pages)
  const locatorProto = Object.getPrototypeOf(page.locator('body'));
  if (!(locatorProto as Record<string, unknown>).__cursorPatched) {
    (locatorProto as Record<string, unknown>).__cursorPatched = true;

    const methods = ['click', 'dblclick', 'hover', 'fill', 'check', 'uncheck',
                     'selectOption', 'type', 'press'] as const;

    for (const method of methods) {
      const orig = locatorProto[method] as (...args: unknown[]) => Promise<unknown>;
      locatorProto[method] = async function (this: unknown, ...args: unknown[]) {
        try {
          const locatorPage = (this as { page: () => Page }).page();
          const s = locatorPage ? cursorStates.get(locatorPage) : undefined;
          if (s) {
            // boundingBox() is a public Locator method — works on any locator shape
            const box = await (this as { boundingBox: (opts: { timeout: number }) => Promise<{ x: number; y: number; width: number; height: number } | null> })
              .boundingBox({ timeout: 2000 });
            if (box) {
              // Enforce: cursor target (element center) must be in viewport for demo realism
              const vp = locatorPage.viewportSize();
              if (vp) {
                const centerX = box.x + box.width / 2;
                const centerY = box.y + box.height / 2;
                const inViewport = centerY >= 0 && centerY <= vp.height
                                && centerX >= 0 && centerX <= vp.width;
                if (!inViewport) {
                  throw new Error(
                    `Demo realism violation: Element center at (${Math.round(centerX)}, ${Math.round(centerY)}) is outside viewport (${vp.width}x${vp.height}). ` +
                    `Call scrollIntoViewIfNeeded() before .${method}() to scroll naturally.`
                  );
                }
              }
              const targetX = box.x + box.width / 2;
              const targetY = box.y + box.height / 2;
              await animateMouseTo(s.cdp, s.lastX, s.lastY, targetX, targetY);
              s.lastX = targetX;
              s.lastY = targetY;
              // Pulse on click/dblclick for visual feedback
              if (method === 'click' || method === 'dblclick') {
                await locatorPage.evaluate(() => (window as unknown as Record<string, () => void>).__pulseCursor?.());
                await new Promise(r => setTimeout(r, 150));
              }
            }
          }
        } catch (err) {
          // Re-throw viewport violations — these are intentional enforcement errors
          if (err instanceof Error && err.message.includes('Demo realism violation')) {
            throw err;
          }
          // Element not found/visible yet — skip animation, action proceeds normally
        }
        return orig.call(this, ...args);
      };
    }
  }

  // Keep page.mouse.move patch for explicit mouse usage
  const origMove = page.mouse.move.bind(page.mouse);
  page.mouse.move = async (x: number, y: number, options?: { steps?: number }) => {
    await animateMouseTo(state.cdp, state.lastX, state.lastY, x, y);
    state.lastX = x;
    state.lastY = y;
    return origMove(x, y, options);
  };
}
