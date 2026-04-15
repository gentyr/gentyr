import type { Page } from '@playwright/test';
import { enableDemoInterrupt, injectEscapeListener } from './interrupt.js';

export interface PersonaColors {
  bg: string;
  text: string;
}

export interface OverlayConfigBase {
  perspectiveName?: string;
  status?: 'pending' | 'pass' | 'fail';
}

export interface DemoOverlayConfig extends OverlayConfigBase {
  mode: 'demo';
  scenarioName?: string;
  scenarioDescription?: string;
  totalSteps?: number;
  currentStep?: number;
  stepLabel?: string;
}

export interface FeedbackOverlayConfig extends OverlayConfigBase {
  mode: 'feedback';
  personaDescription?: string;
  featureName?: string;
  featureDescription?: string;
}

export type OverlayConfig = DemoOverlayConfig | FeedbackOverlayConfig;

interface OverlayState {
  persona: string;
  config: OverlayConfig;
  listenerRegistered: boolean;
  colorMap?: Record<string, PersonaColors>;
}

const overlayStates = new WeakMap<Page, OverlayState>();

/** Exposed for testing — do not use in production demo code */
export const _overlayStatesForTesting = overlayStates;

const DEFAULT_PALETTE: PersonaColors[] = [
  { bg: 'hsl(222, 47%, 11%)', text: 'hsl(210, 40%, 98%)' },
  { bg: 'hsl(142, 76%, 36%)', text: 'hsl(0, 0%, 100%)' },
  { bg: 'hsl(217, 91%, 60%)', text: 'hsl(0, 0%, 100%)' },
  { bg: 'hsl(262, 83%, 58%)', text: 'hsl(0, 0%, 100%)' },
  { bg: 'hsl(25, 95%, 53%)', text: 'hsl(0, 0%, 100%)' },
  { bg: 'hsl(346, 77%, 50%)', text: 'hsl(0, 0%, 100%)' },
  { bg: 'hsl(48, 96%, 53%)', text: 'hsl(0, 0%, 10%)' },
  { bg: 'hsl(173, 80%, 40%)', text: 'hsl(0, 0%, 100%)' },
];

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function getDefaultColor(persona: string): PersonaColors {
  return DEFAULT_PALETTE[hashString(persona) % DEFAULT_PALETTE.length];
}

const STATUS_ICONS: Record<'pending' | 'pass' | 'fail', string> = {
  pass: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;vertical-align:middle">
    <circle cx="8" cy="8" r="8" fill="#22c55e"/>
    <path d="M4.5 8.5L6.5 10.5L11.5 5.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  fail: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;vertical-align:middle">
    <circle cx="8" cy="8" r="8" fill="#ef4444"/>
    <path d="M5.5 5.5L10.5 10.5M10.5 5.5L5.5 10.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`,
  pending: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;vertical-align:middle">
    <circle cx="8" cy="8" r="7" stroke="#9ca3af" stroke-width="1.5"/>
  </svg>`,
};

const STATUS_BORDER_COLORS: Record<'pending' | 'pass' | 'fail', string> = {
  pass: '#22c55e',
  fail: '#ef4444',
  pending: '#9ca3af',
};

/**
 * Internal: injects the overlay DOM into the page.
 * Extracted so it can be called both on initial injection and after navigation.
 */
async function _injectOverlayDOM(
  page: Page,
  persona: string,
  config?: OverlayConfig,
  colorMap?: Record<string, PersonaColors>,
): Promise<void> {
  const colors = colorMap?.[persona] ?? getDefaultColor(persona);
  const status = config?.status ?? 'pending';
  const borderColor = STATUS_BORDER_COLORS[status];
  const statusIcon = STATUS_ICONS[status];

  // Determine mode — default to 'demo' if not set
  const mode = config?.mode ?? 'demo';

  if (mode === 'feedback') {
    const feedbackConfig = config as FeedbackOverlayConfig | undefined;
    await page.evaluate(
      ({
        persona: p,
        accentColor,
        borderColor: bc,
        statusIcon: icon,
        status: st,
        perspectiveName,
        personaDescription,
        featureName,
        featureDescription,
      }) => {
        // Remove any existing overlay
        const existing = document.getElementById('demo-persona-overlay');
        if (existing) { existing.remove(); }

        const overlay = document.createElement('div');
        overlay.id = 'demo-persona-overlay';

        // Build header row: status icon + perspective name (or persona name fallback)
        const headerText = perspectiveName ?? p;
        const headerRow = `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span id="demo-overlay-status-icon">${icon}</span>
            <span style="font-weight:600;font-size:13px;line-height:1.3;">${headerText}</span>
          </div>
        `;

        // Persona name row (only shown when perspectiveName is provided, to distinguish from header)
        const personaRow = perspectiveName
          ? `<div style="font-size:12px;color:rgba(255,255,255,0.65);margin-bottom:8px;">${p}</div>`
          : '';

        // Persona description text
        const descriptionSection = personaDescription
          ? `<div style="font-size:11px;color:rgba(255,255,255,0.6);line-height:1.5;margin-bottom:${featureName ? '8px' : '0'};">${personaDescription}</div>`
          : '';

        // Feature review section
        const featureSection = featureName
          ? `
            <div style="border-top:1px solid rgba(255,255,255,0.15);margin-top:${perspectiveName ? '0' : '6px'};padding-top:8px;">
              <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px;">Reviewing</div>
              <div style="font-size:12px;font-weight:500;margin-bottom:${featureDescription ? '4px' : '0'};">${featureName}</div>
              ${featureDescription ? `<div style="font-size:11px;color:rgba(255,255,255,0.65);line-height:1.5;">${featureDescription}</div>` : ''}
            </div>
          `
          : '';

        overlay.innerHTML = headerRow + personaRow + descriptionSection + featureSection;

        overlay.style.cssText = `
          position: fixed;
          bottom: 24px;
          right: 24px;
          z-index: 999999;
          background: rgba(0, 0, 0, 0.85);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          color: #ffffff;
          padding: 12px 14px;
          border-radius: 8px;
          border-left: 3px solid ${bc};
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 13px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.4), 0 1px 4px rgba(0,0,0,0.3);
          pointer-events: none;
          user-select: none;
          max-width: 280px;
          min-width: 180px;
          opacity: 1;
          transition: opacity 200ms ease, border-color 200ms ease;
        `;

        // Store accent color for status updates
        overlay.dataset.accentColor = accentColor;
        overlay.dataset.status = st;

        document.body.appendChild(overlay);

        // Proximity fade: fade when cursor within 100px of overlay center.
        // Remove any previous listener to prevent stacking on repeated calls.
        const prevHandler = (window as unknown as Record<string, unknown>).__demoOverlayMouseHandler as ((e: MouseEvent) => void) | undefined;
        if (prevHandler) {
          document.removeEventListener('mousemove', prevHandler);
        }
        const handler = (e: MouseEvent) => {
          const ids = ['demo-persona-overlay', 'demo-thinking-bubble'];
          const pad = 60;
          for (const id of ids) {
            const el = document.getElementById(id);
            if (!el) { continue; }
            const rect = el.getBoundingClientRect();
            const isNear = (
              e.clientX >= rect.left - pad &&
              e.clientX <= rect.right + pad &&
              e.clientY >= rect.top - pad &&
              e.clientY <= rect.bottom + pad
            );
            el.style.opacity = isNear ? '0.15' : '1';
          }
        };
        (window as unknown as Record<string, unknown>).__demoOverlayMouseHandler = handler;
        document.addEventListener('mousemove', handler);
      },
      {
        persona,
        accentColor: colors.bg,
        borderColor,
        statusIcon,
        status,
        perspectiveName: config?.perspectiveName ?? null,
        personaDescription: feedbackConfig?.personaDescription ?? null,
        featureName: feedbackConfig?.featureName ?? null,
        featureDescription: feedbackConfig?.featureDescription ?? null,
      },
    );
  } else {
    const demoConfig = config as DemoOverlayConfig | undefined;
    await page.evaluate(
      ({
        persona: p,
        accentColor,
        borderColor: bc,
        statusIcon: icon,
        status: st,
        perspectiveName,
        scenarioName,
        scenarioDescription,
        totalSteps,
        currentStep,
        stepLabel,
      }) => {
        // Remove any existing overlay
        const existing = document.getElementById('demo-persona-overlay');
        if (existing) { existing.remove(); }

        const overlay = document.createElement('div');
        overlay.id = 'demo-persona-overlay';

        // Step progress row (shown when totalSteps is provided)
        const stepProgressRow = totalSteps
          ? `
            <div id="demo-step-progress" style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.15);">
              <div id="demo-step-text" style="font-size:11px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">
                Step ${currentStep} / ${totalSteps}${stepLabel ? ` — <span style="text-transform:none;letter-spacing:normal">${stepLabel}</span>` : ''}
              </div>
              <div style="height:2px;background:rgba(255,255,255,0.15);border-radius:1px;overflow:hidden;">
                <div id="demo-step-bar" style="height:100%;background:hsl(220,70%,55%);border-radius:1px;width:${Math.round((currentStep / totalSteps) * 100)}%;transition:width 300ms ease;"></div>
              </div>
            </div>
          `
          : '';

        // Build header row: status icon + perspective name (or persona name fallback)
        const headerText = perspectiveName ?? p;
        const headerRow = `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span id="demo-overlay-status-icon">${icon}</span>
            <span style="font-weight:600;font-size:13px;line-height:1.3;">${headerText}</span>
          </div>
        `;

        // Persona name row (only shown when perspectiveName is provided, to distinguish from header)
        const personaRow = perspectiveName
          ? `<div style="font-size:12px;color:rgba(255,255,255,0.65);margin-bottom:8px;">${p}</div>`
          : '';

        // Divider + scenario section
        const scenarioSection = scenarioName
          ? `
            <div style="border-top:1px solid rgba(255,255,255,0.15);margin-top:${perspectiveName ? '0' : '6px'};padding-top:8px;">
              <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px;">Scenario</div>
              <div style="font-size:12px;font-weight:500;margin-bottom:${scenarioDescription ? '4px' : '0'};">${scenarioName}</div>
              ${scenarioDescription ? `<div style="font-size:11px;color:rgba(255,255,255,0.65);line-height:1.5;">${scenarioDescription}</div>` : ''}
            </div>
          `
          : '';

        overlay.innerHTML = stepProgressRow + headerRow + personaRow + scenarioSection;

        overlay.style.cssText = `
          position: fixed;
          bottom: 24px;
          right: 24px;
          z-index: 999999;
          background: rgba(0, 0, 0, 0.85);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          color: #ffffff;
          padding: 12px 14px;
          border-radius: 8px;
          border-left: 3px solid ${bc};
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 13px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.4), 0 1px 4px rgba(0,0,0,0.3);
          pointer-events: none;
          user-select: none;
          max-width: 280px;
          min-width: 180px;
          opacity: 1;
          transition: opacity 200ms ease, border-color 200ms ease;
        `;

        // Store accent color for status updates
        overlay.dataset.accentColor = accentColor;
        overlay.dataset.status = st;

        document.body.appendChild(overlay);

        // Proximity fade: fade when cursor within 100px of overlay center.
        // Remove any previous listener to prevent stacking on repeated calls.
        const prevHandler = (window as unknown as Record<string, unknown>).__demoOverlayMouseHandler as ((e: MouseEvent) => void) | undefined;
        if (prevHandler) {
          document.removeEventListener('mousemove', prevHandler);
        }
        const handler = (e: MouseEvent) => {
          const ids = ['demo-persona-overlay', 'demo-thinking-bubble'];
          const pad = 60;
          for (const id of ids) {
            const el = document.getElementById(id);
            if (!el) { continue; }
            const rect = el.getBoundingClientRect();
            const isNear = (
              e.clientX >= rect.left - pad &&
              e.clientX <= rect.right + pad &&
              e.clientY >= rect.top - pad &&
              e.clientY <= rect.bottom + pad
            );
            el.style.opacity = isNear ? '0.15' : '1';
          }
        };
        (window as unknown as Record<string, unknown>).__demoOverlayMouseHandler = handler;
        document.addEventListener('mousemove', handler);

        // Escape key listener for demo interrupt (deduplicates via window flag)
        if (!(window as unknown as Record<string, unknown>).__demoOverlayEscHandler) {
          const escHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !(window as unknown as Record<string, boolean>).__gentyrDemoInterrupted) {
              (window as unknown as Record<string, boolean>).__gentyrDemoInterrupted = true;
              const fn = (window as unknown as Record<string, (() => void) | undefined>).__gentyrDemoInterrupt;
              if (fn) fn();
            }
          };
          (window as unknown as Record<string, unknown>).__demoOverlayEscHandler = escHandler;
          document.addEventListener('keydown', escHandler);
        }
      },
      {
        persona,
        accentColor: colors.bg,
        borderColor,
        statusIcon,
        status,
        perspectiveName: config?.perspectiveName ?? null,
        scenarioName: demoConfig?.scenarioName ?? null,
        scenarioDescription: demoConfig?.scenarioDescription ?? null,
        totalSteps: demoConfig?.totalSteps ?? 0,
        currentStep: demoConfig?.currentStep ?? 1,
        stepLabel: demoConfig?.stepLabel ?? null,
      },
    );
  }
}

/**
 * Injects a rich persona overlay card into the page, fixed to the bottom-right corner.
 * Uses colorMap or a default palette for the left accent border.
 * Supports scenario info (demo mode) or feature review info (feedback mode) and status icons.
 * Fades when the cursor is within 100px of the overlay.
 *
 * Automatically re-injects the overlay after page navigations (link clicks, form submits, etc.)
 * via a `load` event listener registered once per page.
 */
export async function injectPersonaOverlay(
  page: Page,
  persona: string,
  config?: OverlayConfig,
  colorMap?: Record<string, PersonaColors>,
): Promise<void> {
  // Store/update state in WeakMap
  const existing = overlayStates.get(page);
  const state: OverlayState = {
    persona,
    config: config ?? { mode: 'demo' },
    listenerRegistered: existing?.listenerRegistered ?? false,
    colorMap,
  };
  overlayStates.set(page, state);

  // Register navigation listener once per page
  if (!state.listenerRegistered) {
    state.listenerRegistered = true;
    page.on('load', async () => {
      const current = overlayStates.get(page);
      if (current) {
        try {
          await _injectOverlayDOM(page, current.persona, current.config, current.colorMap);
          // Re-inject Escape keydown listener (DOM listeners don't survive navigation,
          // but page.exposeFunction does). Only for demo mode.
          if (current.config.mode !== 'feedback') {
            await injectEscapeListener(page);
          }
        } catch {
          // Page may have been closed or navigated away — ignore
        }
      }
    });
  }

  // Initial injection
  await _injectOverlayDOM(page, persona, config, colorMap);

  // Wire up Escape key interrupt handler (demo mode only, non-fatal)
  if ((config?.mode ?? 'demo') !== 'feedback') {
    try {
      await enableDemoInterrupt(page);
    } catch {
      // Non-fatal — interrupt feature is best-effort
    }
  }
}

/**
 * Waits for the overlay element to appear on the page.
 * The `load` listener registered by `injectPersonaOverlay` automatically re-injects
 * the overlay after navigations, so this just waits for that to complete.
 */
async function _waitForOverlay(page: Page, timeoutMs = 5000): Promise<void> {
  await page.waitForFunction(
    () => document.getElementById('demo-persona-overlay') !== null,
    { timeout: timeoutMs },
  );
}

/**
 * Updates the status icon and left border color of an existing overlay.
 * Waits for the overlay to appear (it may be re-injected after a navigation).
 */
export async function updateOverlayStatus(
  page: Page,
  status: 'pending' | 'pass' | 'fail',
): Promise<void> {
  const icon = STATUS_ICONS[status];
  const borderColor = STATUS_BORDER_COLORS[status];

  await _waitForOverlay(page);

  await page.evaluate(
    ({ icon: newIcon, borderColor: bc, status: st }) => {
      const overlay = document.getElementById('demo-persona-overlay');
      if (!overlay) {
        throw new Error('No demo-persona-overlay found on page');
      }
      const iconEl = document.getElementById('demo-overlay-status-icon');
      if (!iconEl) {
        throw new Error('No demo-overlay-status-icon found inside overlay');
      }
      iconEl.innerHTML = newIcon;
      overlay.style.borderLeftColor = bc;
      overlay.dataset.status = st;
    },
    { icon, borderColor, status },
  );

  // Sync status back to stored config for navigation persistence
  const state = overlayStates.get(page);
  if (state) {
    state.config = { ...state.config, status };
  }
}

/**
 * Sets up persona overlays on multiple pages. Standard for all demo flows.
 */
export async function setupDemoOverlays(
  pages: Array<{ page: Page; persona: string; config?: OverlayConfig; colorMap?: Record<string, PersonaColors> }>,
): Promise<void> {
  await Promise.all(
    pages.map(({ page, persona, config, colorMap }) => injectPersonaOverlay(page, persona, config, colorMap)),
  );
}

/**
 * Updates the step counter in an existing overlay without re-injecting.
 * If `total` is omitted, reuses the previously set total.
 * Waits for the overlay to appear (it may be re-injected after a navigation).
 */
export async function updateOverlayStep(
  page: Page,
  current: number,
  total?: number,
  label?: string,
): Promise<void> {
  await _waitForOverlay(page);

  await page.evaluate(
    ({ current: c, total: t, label: l }) => {
      const overlay = document.getElementById('demo-persona-overlay');
      if (!overlay) {
        throw new Error('No demo-persona-overlay found on page');
      }

      let progressEl = document.getElementById('demo-step-progress');

      // If no step progress exists yet, create it as the first child
      if (!progressEl) {
        progressEl = document.createElement('div');
        progressEl.id = 'demo-step-progress';
        progressEl.style.cssText = 'margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.15);';
        progressEl.innerHTML = `
          <div id="demo-step-text" style="font-size:11px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;"></div>
          <div style="height:2px;background:rgba(255,255,255,0.15);border-radius:1px;overflow:hidden;">
            <div id="demo-step-bar" style="height:100%;background:hsl(220,70%,55%);border-radius:1px;width:0%;transition:width 300ms ease;"></div>
          </div>
        `;
        overlay.insertBefore(progressEl, overlay.firstChild);
      }

      // Resolve total: use provided value, or fall back to stored value, minimum 1 to avoid division by zero
      const resolvedTotal = Math.max(t ?? Number(progressEl.dataset.total ?? '1'), 1);
      progressEl.dataset.total = String(resolvedTotal);

      // Update text
      const textEl = document.getElementById('demo-step-text');
      if (textEl) {
        const labelHtml = l ? ` — <span style="text-transform:none;letter-spacing:normal">${l}</span>` : '';
        textEl.innerHTML = `Step ${c} / ${resolvedTotal}${labelHtml}`;
      }

      // Update progress bar
      const barEl = document.getElementById('demo-step-bar');
      if (barEl) {
        barEl.style.width = `${Math.round((c / resolvedTotal) * 100)}%`;
      }
    },
    { current, total: total ?? null, label: label ?? null },
  );

  // Sync step state back to stored config for navigation persistence
  const state = overlayStates.get(page);
  if (state && state.config.mode !== 'feedback') {
    const demoConf = state.config as DemoOverlayConfig;
    state.config = {
      ...demoConf,
      mode: 'demo',
      currentStep: current,
      ...(total !== undefined ? { totalSteps: total } : {}),
      ...(label !== undefined ? { stepLabel: label } : {}),
    };
  }
}

/** CSS for the thinking bubble element, shared between showThinking and showThinkingLoader. */
const THINKING_BUBBLE_CSS = `
  position: fixed;
  bottom: 0;
  right: 24px;
  z-index: 999998;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: rgba(255, 255, 255, 0.85);
  padding: 10px 12px;
  border-radius: 8px;
  border-left: 3px solid hsl(220, 70%, 55%);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 12px;
  line-height: 1.5;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4), 0 1px 4px rgba(0,0,0,0.3);
  pointer-events: none;
  user-select: none;
  max-width: 320px;
  max-height: 200px;
  overflow-y: auto;
  opacity: 0;
  transition: opacity 200ms ease, bottom 200ms ease;
  word-wrap: break-word;
`;

/**
 * Shows (or updates) a floating "thinking bubble" above the persona overlay.
 */
export async function showThinking(page: Page, text: string): Promise<void> {
  await page.evaluate(
    ({ text: t, css }) => {
      // Cancel any pending hide timer to prevent race conditions
      const win = window as unknown as Record<string, unknown>;
      const pendingTimer = win.__demoThinkingHideTimer as number | undefined;
      if (pendingTimer) { clearTimeout(pendingTimer); delete win.__demoThinkingHideTimer; }

      let bubble = document.getElementById('demo-thinking-bubble');
      if (!bubble) {
        bubble = document.createElement('div');
        bubble.id = 'demo-thinking-bubble';
        bubble.style.cssText = css;
        document.body.appendChild(bubble);
      }

      // Position above the persona overlay
      const overlay = document.getElementById('demo-persona-overlay');
      if (overlay) {
        const overlayRect = overlay.getBoundingClientRect();
        bubble.style.bottom = `${window.innerHeight - overlayRect.top + 8}px`;
      } else {
        bubble.style.bottom = '120px';
      }

      bubble.textContent = t;
      const ref = bubble;
      requestAnimationFrame(() => { ref.style.opacity = '1'; });
    },
    { text, css: THINKING_BUBBLE_CSS },
  );
}

/**
 * Removes the thinking bubble with a fade-out.
 */
export async function hideThinking(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bubble = document.getElementById('demo-thinking-bubble');
    if (!bubble) { return; }
    bubble.style.opacity = '0';
    const win = window as unknown as Record<string, unknown>;
    const timer = setTimeout(() => {
      bubble.remove();
      delete win.__demoThinkingHideTimer;
    }, 200);
    win.__demoThinkingHideTimer = timer;
  });
}

/**
 * Shows the thinking bubble in "loading" state with a spinner and "Thinking..." text.
 */
export async function showThinkingLoader(page: Page): Promise<void> {
  await page.evaluate(
    ({ css }) => {
      // Cancel any pending hide timer to prevent race conditions
      const win = window as unknown as Record<string, unknown>;
      const pendingTimer = win.__demoThinkingHideTimer as number | undefined;
      if (pendingTimer) { clearTimeout(pendingTimer); delete win.__demoThinkingHideTimer; }

      let bubble = document.getElementById('demo-thinking-bubble');
      if (!bubble) {
        bubble = document.createElement('div');
        bubble.id = 'demo-thinking-bubble';
        bubble.style.cssText = css;
        document.body.appendChild(bubble);
      }

      // Position above the persona overlay
      const overlay = document.getElementById('demo-persona-overlay');
      if (overlay) {
        const overlayRect = overlay.getBoundingClientRect();
        bubble.style.bottom = `${window.innerHeight - overlayRect.top + 8}px`;
      } else {
        bubble.style.bottom = '120px';
      }

      // Inject spinner keyframes if not already present
      if (!document.getElementById('demo-thinking-spinner-style')) {
        const style = document.createElement('style');
        style.id = 'demo-thinking-spinner-style';
        style.textContent = `
          @keyframes demo-thinking-spin {
            to { transform: rotate(360deg); }
          }
        `;
        document.head.appendChild(style);
      }

      bubble.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="
            width: 14px;
            height: 14px;
            border: 2px solid rgba(255,255,255,0.3);
            border-top-color: hsl(220,70%,55%);
            border-radius: 50%;
            animation: demo-thinking-spin 0.8s linear infinite;
            flex-shrink: 0;
          "></div>
          <span style="font-style:italic;color:rgba(255,255,255,0.6);">Thinking...</span>
        </div>
      `;

      const ref = bubble;
      requestAnimationFrame(() => { ref.style.opacity = '1'; });
    },
    { css: THINKING_BUBBLE_CSS },
  );
}
