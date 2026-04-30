/**
 * Playwright Telemetry Setup — Browser-level telemetry capture
 *
 * Loaded automatically via NODE_OPTIONS="--import <this-file>" when GENTYR
 * launches Playwright demos with DEMO_TELEMETRY=1. Monkey-patches
 * chromium.launchPersistentContext to capture comprehensive browser telemetry:
 *
 *   1. Console logs from ALL open tabs (log, warn, error, info, debug)
 *   2. Network requests and responses (method, URL, status, timing, headers)
 *   3. JavaScript errors and unhandled exceptions
 *   4. Performance metrics (Web Vitals: LCP, FCP, CLS, TTFB, navigation timing)
 *
 * All telemetry is written as JSONL files to DEMO_TELEMETRY_DIR.
 * Each line includes timestamp, run_id, page_url, and tab_index for correlation.
 *
 * No target project code changes needed. Only activates when DEMO_TELEMETRY=1.
 * Must be imported AFTER playwright-auto-setup.mjs (appended to NODE_OPTIONS).
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

// Only activate when telemetry is enabled
if (process.env.DEMO_TELEMETRY === '1' && process.env.DEMO_TELEMETRY_DIR) {
  const telemetryDir = process.env.DEMO_TELEMETRY_DIR;
  const runId = process.env.DEMO_RUN_ID || 'unknown';

  // Ensure telemetry directory exists
  fs.mkdirSync(telemetryDir, { recursive: true });

  // Open JSONL file streams (append mode, non-blocking)
  const consoleStream = fs.createWriteStream(path.join(telemetryDir, 'console-logs.jsonl'), { flags: 'a' });
  const networkStream = fs.createWriteStream(path.join(telemetryDir, 'network-log.jsonl'), { flags: 'a' });
  const errorStream = fs.createWriteStream(path.join(telemetryDir, 'js-errors.jsonl'), { flags: 'a' });
  const perfStream = fs.createWriteStream(path.join(telemetryDir, 'performance-metrics.jsonl'), { flags: 'a' });

  // Web Vitals collection script injected into every page via addInitScript
  const WEB_VITALS_SCRIPT = `
    (function __gentyrWebVitals() {
      if (window.__gentyrWebVitalsInitialized) return;
      window.__gentyrWebVitalsInitialized = true;
      window.__gentyrWebVitals = {};

      // Collect paint timing
      try {
        const paintEntries = performance.getEntriesByType('paint');
        for (const entry of paintEntries) {
          if (entry.name === 'first-contentful-paint') {
            window.__gentyrWebVitals.fcp = entry.startTime;
          }
        }
      } catch {}

      // Observe LCP
      try {
        const lcpObserver = new PerformanceObserver(function(list) {
          const entries = list.getEntries();
          if (entries.length > 0) {
            window.__gentyrWebVitals.lcp = entries[entries.length - 1].startTime;
          }
        });
        lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {}

      // Observe CLS
      try {
        var clsValue = 0;
        var clsEntries = [];
        var sessionValue = 0;
        var sessionEntries = [];
        const clsObserver = new PerformanceObserver(function(list) {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) {
              var firstSessionEntry = sessionEntries[0];
              var lastSessionEntry = sessionEntries[sessionEntries.length - 1];
              if (sessionValue && entry.startTime - lastSessionEntry.startTime < 1000 && entry.startTime - firstSessionEntry.startTime < 5000) {
                sessionValue += entry.value;
                sessionEntries.push(entry);
              } else {
                sessionValue = entry.value;
                sessionEntries = [entry];
              }
              if (sessionValue > clsValue) {
                clsValue = sessionValue;
                clsEntries = sessionEntries.slice();
                window.__gentyrWebVitals.cls = clsValue;
              }
            }
          }
        });
        clsObserver.observe({ type: 'layout-shift', buffered: true });
      } catch {}

      // Collect TTFB from navigation timing
      try {
        var navEntries = performance.getEntriesByType('navigation');
        if (navEntries.length > 0) {
          window.__gentyrWebVitals.ttfb = navEntries[0].responseStart;
          window.__gentyrWebVitals.dom_interactive = navEntries[0].domInteractive;
          window.__gentyrWebVitals.dom_complete = navEntries[0].domComplete;
          window.__gentyrWebVitals.load_event = navEntries[0].loadEventEnd;
        }
      } catch {}
    })();
  `;

  let tabCounter = 0;

  /**
   * Set up telemetry capture for a single page.
   */
  function setupPageTelemetry(page, tabIndex) {
    const pageUrl = () => {
      try { return page.url(); } catch { return 'unknown'; }
    };

    // 1. Console logs
    page.on('console', (msg) => {
      try {
        const location = msg.location();
        const entry = {
          timestamp: new Date().toISOString(),
          run_id: runId,
          type: 'console',
          level: msg.type(), // log, warn, error, info, debug, etc.
          text: msg.text().slice(0, 4000), // Cap to prevent huge entries
          page_url: pageUrl(),
          tab_index: tabIndex,
          ...(location.url ? { location: { url: location.url, line: location.lineNumber, column: location.columnNumber } } : {}),
        };
        consoleStream.write(JSON.stringify(entry) + '\n');
      } catch { /* non-fatal */ }
    });

    // 2. Network requests
    page.on('request', (request) => {
      try {
        const entry = {
          timestamp: new Date().toISOString(),
          run_id: runId,
          type: 'network_request',
          method: request.method(),
          url: request.url().slice(0, 2000),
          resource_type: request.resourceType(),
          page_url: pageUrl(),
          tab_index: tabIndex,
          headers: Object.fromEntries(
            Object.entries(request.headers()).filter(([k]) =>
              ['content-type', 'accept', 'authorization', 'cookie', 'referer', 'user-agent'].includes(k.toLowerCase())
            ).map(([k, v]) => [k, k.toLowerCase() === 'authorization' ? '[REDACTED]' : (typeof v === 'string' ? v.slice(0, 500) : v)])
          ),
          post_data: request.postData()?.slice(0, 1024) || null,
        };
        networkStream.write(JSON.stringify(entry) + '\n');
      } catch { /* non-fatal */ }
    });

    page.on('response', (response) => {
      try {
        const entry = {
          timestamp: new Date().toISOString(),
          run_id: runId,
          type: 'network_response',
          url: response.url().slice(0, 2000),
          status: response.status(),
          status_text: response.statusText(),
          page_url: pageUrl(),
          tab_index: tabIndex,
          headers: Object.fromEntries(
            Object.entries(response.headers()).filter(([k]) =>
              ['content-type', 'content-length', 'cache-control', 'set-cookie', 'x-request-id'].includes(k.toLowerCase())
            ).map(([k, v]) => [k, k.toLowerCase() === 'set-cookie' ? '[REDACTED]' : (typeof v === 'string' ? v.slice(0, 500) : v)])
          ),
        };
        networkStream.write(JSON.stringify(entry) + '\n');
      } catch { /* non-fatal */ }
    });

    // 3. JavaScript errors
    page.on('pageerror', (error) => {
      try {
        const entry = {
          timestamp: new Date().toISOString(),
          run_id: runId,
          type: 'js_error',
          name: error.name || 'Error',
          message: error.message?.slice(0, 2000) || String(error).slice(0, 2000),
          stack: error.stack?.slice(0, 4000) || null,
          page_url: pageUrl(),
          tab_index: tabIndex,
        };
        errorStream.write(JSON.stringify(entry) + '\n');
      } catch { /* non-fatal */ }
    });

    // 4. Performance metrics — collect on load and before page close
    page.on('load', async () => {
      try {
        // Wait briefly for Web Vitals observers to fire
        await new Promise(r => setTimeout(r, 1000));

        const metrics = await page.evaluate(() => {
          const vitals = window.__gentyrWebVitals || {};
          const navEntries = performance.getEntriesByType('navigation');
          const paintEntries = performance.getEntriesByType('paint');
          const resourceEntries = performance.getEntriesByType('resource');

          return {
            vitals,
            navigation: navEntries.length > 0 ? {
              duration: navEntries[0].duration,
              dom_interactive: navEntries[0].domInteractive,
              dom_complete: navEntries[0].domComplete,
              load_event_end: navEntries[0].loadEventEnd,
              response_start: navEntries[0].responseStart,
              transfer_size: navEntries[0].transferSize,
            } : null,
            paint: paintEntries.map(e => ({ name: e.name, start_time: e.startTime })),
            resource_count: resourceEntries.length,
            resource_total_size: resourceEntries.reduce((sum, e) => sum + (e.transferSize || 0), 0),
          };
        }).catch(() => null);

        if (metrics) {
          const entry = {
            timestamp: new Date().toISOString(),
            run_id: runId,
            type: 'performance',
            event: 'page_load',
            page_url: pageUrl(),
            tab_index: tabIndex,
            ...metrics,
          };
          perfStream.write(JSON.stringify(entry) + '\n');
        }
      } catch { /* non-fatal */ }
    });
  }

  // ── Playwright Monkey-Patch ──────────────────────────────────────────────────

  try {
    const projectDir = process.cwd();
    const projectRequire = createRequire(path.join(projectDir, 'package.json'));
    const pw = projectRequire('@playwright/test');
    const chromium = pw.chromium;

    if (chromium && typeof chromium.launchPersistentContext === 'function') {
      const proto = Object.getPrototypeOf(chromium);
      const originalLaunch = proto.launchPersistentContext;

      // Guard: don't double-patch if this module is imported twice
      if (!proto.__telemetryPatched) {
        proto.__telemetryPatched = true;

        proto.launchPersistentContext = async function (userDataDir, options) {
          const context = await originalLaunch.call(this, userDataDir, options);

          try {
            // Inject Web Vitals collection script into every page
            await context.addInitScript({ content: WEB_VITALS_SCRIPT });

            // Set up telemetry for existing pages
            for (const p of context.pages()) {
              setupPageTelemetry(p, tabCounter++);
            }

            // Capture all new pages/tabs
            context.on('page', (p) => {
              setupPageTelemetry(p, tabCounter++);
            });
          } catch (err) {
            console.error('[playwright-telemetry-setup] Context hook failed:', err);
          }

          return context;
        };
      }
    }
  } catch (err) {
    console.error('[playwright-telemetry-setup] @playwright/test patch failed:', err);
  }

  // Graceful cleanup on process exit
  process.on('exit', () => {
    try { consoleStream.end(); } catch {}
    try { networkStream.end(); } catch {}
    try { errorStream.end(); } catch {}
    try { perfStream.end(); } catch {}
  });
}
