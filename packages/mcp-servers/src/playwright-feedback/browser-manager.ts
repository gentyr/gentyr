/**
 * Browser Manager for Playwright Feedback MCP Server
 *
 * Manages Playwright browser instance lifecycle:
 * - Launches headless Chromium on first use
 * - Creates fresh context per session
 * - Configures viewport from env vars
 * - Handles cleanup
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private baseUrl: string;
  private headless: boolean;
  private viewportWidth: number;
  private viewportHeight: number;

  constructor() {
    // F001 Compliance: Environment variable configuration
    const baseUrl = process.env['FEEDBACK_BASE_URL'];
    if (!baseUrl) {
      throw new Error('FEEDBACK_BASE_URL environment variable is required');
    }
    this.baseUrl = baseUrl;

    this.headless = process.env['FEEDBACK_BROWSER_HEADLESS'] !== 'false';
    this.viewportWidth = parseInt(process.env['FEEDBACK_BROWSER_VIEWPORT_WIDTH'] || '1280', 10);
    this.viewportHeight = parseInt(process.env['FEEDBACK_BROWSER_VIEWPORT_HEIGHT'] || '720', 10);
  }

  /**
   * Get the current page, launching browser if needed
   */
  async getPage(): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.headless,
      });
    }

    if (!this.context) {
      this.context = await this.browser.newContext({
        viewport: {
          width: this.viewportWidth,
          height: this.viewportHeight,
        },
      });
    }

    if (!this.page) {
      this.page = await this.context.newPage();
    }

    return this.page;
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
    if (this.page) {
      await this.page.close();
      this.page = null;
    }

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
