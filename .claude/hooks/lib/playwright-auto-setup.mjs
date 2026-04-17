/**
 * Playwright Auto-Setup — Framework-level feature injection
 *
 * Loaded automatically via NODE_OPTIONS="--import <this-file>" when GENTYR
 * launches Playwright demos. Monkey-patches chromium.launchPersistentContext
 * to auto-wire framework features on every BrowserContext:
 *
 *   1. Escape key interrupt (headed demos) — instant overlay + MCP server signal
 *   2. Cursor highlight (when DEMO_SHOW_CURSOR=1) — animated red dot follows actions
 *
 * No target project code changes needed. Deduplication guards prevent conflicts
 * if the project's fixtures also call setupDemoInterrupt or addMouseAnimation.
 */

import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve modules from the PROJECT directory, not from gentyr's directory.
// .claude/hooks/ is a symlink into gentyr, so bare imports like '@playwright/test'
// would resolve from gentyr's node_modules (where it doesn't exist).
// createRequire from the project dir finds the project's installed packages.
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const projectRequire = createRequire(join(projectDir, 'package.json'));

// ─── Cursor Highlight Init Script (injected via context.addInitScript) ────────

const CURSOR_HIGHLIGHT_SCRIPT = `
  (function __initCursorDot() {
    if (document.getElementById('demo-cursor')) return;
    function inject() {
      if (document.getElementById('demo-cursor')) return;
      var dot = document.createElement('div');
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
      document.addEventListener('mousemove', function(e) {
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

// ─── Cursor Animation (patches Locator prototype + CDP mouse events) ─────────

const cursorStates = new WeakMap();

async function animateMouseTo(cdp, fromX, fromY, toX, toY, steps = 15) {
  for (let i = 1; i <= steps; i++) {
    const x = fromX + (toX - fromX) * (i / steps);
    const y = fromY + (toY - fromY) * (i / steps);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await new Promise(r => setTimeout(r, 8));
  }
}

async function addMouseAnimation(page, isInterruptedFn) {
  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch {
    return; // CDP not available (non-Chromium) — skip
  }

  const state = { lastX: 0, lastY: 0, cdp };
  cursorStates.set(page, state);

  // Re-create CDP session on cross-origin navigation
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame()) {
      try { state.cdp = await page.context().newCDPSession(page); } catch {}
    }
  });

  // Patch Locator prototype ONCE (shared across all pages)
  const locatorProto = Object.getPrototypeOf(page.locator('body'));
  if (!locatorProto.__cursorPatched) {
    locatorProto.__cursorPatched = true;

    const methods = ['click', 'dblclick', 'hover', 'fill', 'check', 'uncheck',
                     'selectOption', 'type', 'press'];

    for (const method of methods) {
      const orig = locatorProto[method];
      locatorProto[method] = async function (...args) {
        if (isInterruptedFn && isInterruptedFn()) {
          throw new Error('Demo interrupted');
        }
        try {
          const locatorPage = this.page();
          const s = locatorPage ? cursorStates.get(locatorPage) : undefined;
          if (s) {
            const box = await this.boundingBox({ timeout: 2000 });
            if (box) {
              const vp = locatorPage.viewportSize();
              if (vp) {
                const centerX = box.x + box.width / 2;
                const centerY = box.y + box.height / 2;
                if (centerY < 0 || centerY > vp.height || centerX < 0 || centerX > vp.width) {
                  throw new Error(
                    `Demo realism violation: Element center at (${Math.round(centerX)}, ${Math.round(centerY)}) ` +
                    `is outside viewport (${vp.width}x${vp.height}). Call scrollIntoViewIfNeeded() before .${method}().`
                  );
                }
              }
              const targetX = box.x + box.width / 2;
              const targetY = box.y + box.height / 2;
              await animateMouseTo(s.cdp, s.lastX, s.lastY, targetX, targetY);
              s.lastX = targetX;
              s.lastY = targetY;
              if (method === 'click' || method === 'dblclick') {
                await locatorPage.evaluate(() => window.__pulseCursor?.());
                await new Promise(r => setTimeout(r, 150));
              }
            }
          }
        } catch (err) {
          if (err.message?.includes('Demo realism violation')) throw err;
          // Element not found/visible — skip animation, action proceeds
        }
        return orig.call(this, ...args);
      };
    }
  }

  // Patch page.mouse.move for explicit mouse usage
  const origMove = page.mouse.move.bind(page.mouse);
  page.mouse.move = async (x, y, options) => {
    await animateMouseTo(state.cdp, state.lastX, state.lastY, x, y);
    state.lastX = x;
    state.lastY = y;
    return origMove(x, y, options);
  };
}

// ─── Playwright Monkey-Patch ──────────────────────────────────────────────────

try {
  // Resolve from project's node_modules (not gentyr's) via createRequire
  const pw = projectRequire('@playwright/test');
  const chromium = pw.chromium;

  if (chromium && typeof chromium.launchPersistentContext === 'function') {
    // Patch the PROTOTYPE, not the instance — ensures the patch applies even
    // when the test file gets a different chromium object (CJS/ESM interop).
    const proto = Object.getPrototypeOf(chromium);
    const originalLaunch = proto.launchPersistentContext;

    proto.launchPersistentContext = async function (userDataDir, options) {
      const context = await originalLaunch.call(this, userDataDir, options);

      // 1. Auto-wire Escape key interrupt for headed demos
      if (process.env.DEMO_HEADLESS !== '1') {
        try {
          _dbg('wiring interrupt setup...');
          const interruptModule = await import(join(__dirname, 'demo-interrupt-setup.js'));
          await interruptModule.setupDemoInterrupt(context);

          // 2. Auto-wire cursor highlight when DEMO_SHOW_CURSOR=1
          if (process.env.DEMO_SHOW_CURSOR === '1') {
            await context.addInitScript({ content: CURSOR_HIGHLIGHT_SCRIPT });
            const isInterruptedFn = interruptModule.isInterrupted;
            for (const p of context.pages()) {
              await addMouseAnimation(p, isInterruptedFn);
            }
            context.on('page', (p) => {
              addMouseAnimation(p, isInterruptedFn).catch(() => {});
            });
          }
        } catch {
          // Non-fatal — features degrade gracefully
        }
      }

      return context;
    };
  }
} catch {
  // @playwright/test not available — skip (non-Playwright project or wrong context)
}
