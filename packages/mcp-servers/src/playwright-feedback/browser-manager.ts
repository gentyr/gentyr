/**
 * Browser Manager for Playwright Feedback MCP Server
 *
 * Manages Playwright browser instance lifecycle:
 * - Launches headless Chromium on first use
 * - Creates fresh context per session
 * - Configures viewport from env vars
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
  sessionId?: string; // retained for potential future use (e.g. named video files)
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private baseUrl: string;
  private headless: boolean;
  private viewportWidth: number;
  private viewportHeight: number;
  private recordVideo: boolean;

  constructor(config: BrowserManagerConfig) {
    this.baseUrl = config.baseUrl;
    this.headless = config.headless;
    this.viewportWidth = config.viewportWidth;
    this.viewportHeight = config.viewportHeight;
    this.recordVideo = config.recordVideo ?? false;
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

    if (!this.page) {
      this.page = await this.context.newPage();
    }

    return this.page;
  }

  /**
   * Get the path to the recorded video file for the current page.
   * Returns null if recording was not enabled or no video was captured.
   */
  async getVideoPath(): Promise<string | null> {
    if (!this.page) return null;
    const video = this.page.video();
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
