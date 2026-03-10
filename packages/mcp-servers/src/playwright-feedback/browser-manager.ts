/**
 * Browser Manager for Playwright Feedback MCP Server
 *
 * Manages Playwright browser instance lifecycle:
 * - Launches headless Chromium on first use
 * - Creates fresh context per session
 * - Configures viewport from env vars
 * - Supports multiple named tabs
 * - Injects feedback overlay on first page creation
 * - Handles cleanup
 */

import * as os from 'os';
import * as path from 'path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export interface BrowserManagerConfig {
  baseUrl: string;
  headless: boolean;
  viewportWidth: number;
  viewportHeight: number;
  recordVideo?: boolean;
  sessionId?: string;
  // Overlay config
  personaName?: string;
  personaDescription?: string;
  personaColor?: string;
  featureName?: string;
  featureDescription?: string;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Map<string, Page> = new Map();
  private overlayListenerPages: WeakSet<Page> = new WeakSet();
  private activeTab: string = 'browser';
  private baseUrl: string;
  private headless: boolean;
  private viewportWidth: number;
  private viewportHeight: number;
  private recordVideo: boolean;
  private personaName?: string;
  private personaDescription?: string;
  private personaColor?: string;
  private featureName?: string;
  private featureDescription?: string;

  constructor(config: BrowserManagerConfig) {
    this.baseUrl = config.baseUrl;
    this.headless = config.headless;
    this.viewportWidth = config.viewportWidth;
    this.viewportHeight = config.viewportHeight;
    this.recordVideo = config.recordVideo ?? false;
    this.personaName = config.personaName;
    this.personaDescription = config.personaDescription;
    this.personaColor = config.personaColor;
    this.featureName = config.featureName;
    this.featureDescription = config.featureDescription;
  }

  /**
   * Ensure browser and context are initialized
   */
  private async ensureBrowser(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.headless,
      });
    }

    if (!this.context) {
      const contextOptions: Parameters<Browser['newContext']>[0] = {
        viewport: {
          width: this.viewportWidth,
          height: this.viewportHeight,
        },
      };

      if (this.recordVideo) {
        contextOptions.recordVideo = {
          dir: path.join(os.tmpdir(), 'gentyr-feedback-recordings'),
          size: { width: this.viewportWidth, height: this.viewportHeight },
        };
      }

      this.context = await this.browser.newContext(contextOptions);
    }
  }

  /**
   * Inject the persona/feature overlay into a page via page.evaluate.
   * The evaluate callback runs in the browser context where DOM APIs are available.
   */
  /** Escape HTML entities to prevent injection in overlay innerHTML */
  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private async injectFeedbackOverlay(page: Page): Promise<void> {
    if (!this.personaName) return;

    const borderColor = this.personaColor || '#9ca3af';

    const safeDesc = this.personaDescription ? this.escapeHtml(this.personaDescription) : '';
    const safeFeatureName = this.featureName ? this.escapeHtml(this.featureName) : '';
    const safeFeatureDesc = this.featureDescription ? this.escapeHtml(this.featureDescription) : '';

    const personaDescSection = safeDesc
      ? `<div style="font-size:11px;color:rgba(255,255,255,0.75);line-height:1.5;margin-bottom:8px;">${safeDesc}</div>`
      : '';

    const featureSection = safeFeatureName
      ? `<div style="border-top:1px solid rgba(255,255,255,0.15);margin-top:6px;padding-top:8px;">
          <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px;">Reviewing</div>
          <div style="font-size:12px;font-weight:500;${safeFeatureDesc ? 'margin-bottom:4px;' : ''}">${safeFeatureName}</div>
          ${safeFeatureDesc ? `<div style="font-size:11px;color:rgba(255,255,255,0.65);line-height:1.5;">${safeFeatureDesc}</div>` : ''}
        </div>`
      : '';

    await page.evaluate(({ name, bc, descSection, featSection }: { name: string; bc: string; descSection: string; featSection: string }) => {
      const existing = document.getElementById('demo-persona-overlay');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'demo-persona-overlay';

      const pendingIcon = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;vertical-align:middle"><circle cx="8" cy="8" r="7" stroke="#9ca3af" stroke-width="1.5"/></svg>`;

      overlay.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <span id="demo-overlay-status-icon">${pendingIcon}</span>
          <span style="font-weight:600;font-size:13px;line-height:1.3;">${name}</span>
        </div>
        ${descSection}
        ${featSection}
      `;

      overlay.style.cssText = `
        position:fixed;bottom:24px;right:24px;z-index:999999;
        background:rgba(0,0,0,0.85);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
        color:#ffffff;padding:12px 14px;border-radius:8px;
        border-left:3px solid ${bc};
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
        font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,0.4),0 1px 4px rgba(0,0,0,0.3);
        pointer-events:none;user-select:none;max-width:280px;min-width:180px;
        opacity:1;transition:opacity 200ms ease;
      `;

      overlay.dataset['status'] = 'pending';
      document.body.appendChild(overlay);

      // Proximity fade
      const handler = (e: MouseEvent) => {
        const ids = ['demo-persona-overlay', 'demo-thinking-bubble'];
        const pad = 60;
        for (const id of ids) {
          const el = document.getElementById(id);
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          const isNear =
            e.clientX >= rect.left - pad &&
            e.clientX <= rect.right + pad &&
            e.clientY >= rect.top - pad &&
            e.clientY <= rect.bottom + pad;
          el.style.opacity = isNear ? '0.15' : '1';
        }
      };
      const win = window as unknown as Record<string, unknown>;
      if (win['__demoOverlayMouseHandler']) {
        document.removeEventListener('mousemove', win['__demoOverlayMouseHandler'] as unknown as EventListener);
      }
      win['__demoOverlayMouseHandler'] = handler;
      document.addEventListener('mousemove', handler as unknown as EventListener);
    }, {
      name: this.escapeHtml(this.personaName),
      bc: borderColor,
      descSection: personaDescSection,
      featSection: featureSection,
    });

    // Re-inject on navigation (register listener once per page)
    if (!this.overlayListenerPages.has(page)) {
      this.overlayListenerPages.add(page);
      page.on('load', async () => {
        try { await this.injectFeedbackOverlay(page); } catch { /* page may be closed */ }
      });
    }
  }

  /**
   * Get the current page, launching browser if needed.
   * If tabName is provided, returns that tab's page.
   * If not provided, returns the active tab's page.
   */
  async getPage(tabName?: string): Promise<Page> {
    await this.ensureBrowser();

    // Create default 'browser' tab if it doesn't exist yet
    if (!this.pages.has('browser')) {
      const page = await this.context!.newPage();
      this.pages.set('browser', page);
      await this.injectFeedbackOverlay(page);
    }

    if (tabName !== undefined) {
      const page = this.pages.get(tabName);
      if (!page) throw new Error(`Tab "${tabName}" not found`);
      return page;
    }

    const activePage = this.pages.get(this.activeTab);
    if (!activePage) throw new Error(`Active tab "${this.activeTab}" not found`);
    return activePage;
  }

  /**
   * Open a new named tab at the given URL and switch to it.
   */
  async openTab(name: string, url: string): Promise<Page> {
    if (name === 'browser') throw new Error('Cannot overwrite the default "browser" tab. Use navigate instead.');
    await this.ensureBrowser();
    const page = await this.context!.newPage();
    await page.goto(url, { waitUntil: 'load' });
    this.pages.set(name, page);
    this.activeTab = name;
    await this.injectFeedbackOverlay(page);
    return page;
  }

  /**
   * Close a named tab. The default 'browser' tab cannot be closed.
   */
  async closeTab(name: string): Promise<void> {
    if (name === 'browser') throw new Error('Cannot close the default browser tab');
    const page = this.pages.get(name);
    if (!page) throw new Error(`Tab "${name}" not found`);
    await page.close();
    this.pages.delete(name);
    if (this.activeTab === name) {
      this.activeTab = 'browser';
    }
  }

  /**
   * List all open tabs with their current URLs and active status.
   */
  listTabs(): { name: string; url: string; active: boolean }[] {
    return Array.from(this.pages.entries()).map(([name, page]) => ({
      name,
      url: page.url(),
      active: name === this.activeTab,
    }));
  }

  /**
   * Switch the active tab to the named tab.
   */
  switchTab(name: string): void {
    if (!this.pages.has(name)) throw new Error(`Tab "${name}" not found`);
    this.activeTab = name;
  }

  /**
   * Get the path to the recorded video file.
   * Prefers the 'browser' tab; falls back to any available page.
   */
  async getVideoPath(): Promise<string | null> {
    const browserPage = this.pages.get('browser');
    const page = browserPage ?? (this.pages.size > 0 ? this.pages.values().next().value as Page : null);
    if (!page) return null;
    const video = page.video();
    if (!video) return null;
    try {
      return await video.path();
    } catch {
      return null;
    }
  }

  /**
   * Get the base URL for navigation validation
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Close browser and cleanup
   */
  async close(): Promise<void> {
    for (const page of this.pages.values()) {
      await page.close().catch(() => { /* best-effort */ });
    }
    this.pages.clear();

    if (this.context) {
      await this.context.close();
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
