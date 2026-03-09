/**
 * Playwright Custom Reporter - Real-Time Progress Tracking
 *
 * Writes JSONL events to a file specified by DEMO_PROGRESS_FILE env var.
 * Events are consumed by the check_demo_result MCP tool for real-time
 * visibility into demo test execution.
 *
 * When DEMO_PROGRESS_FILE is not set, the reporter is a no-op — safe to
 * register globally in playwright.config.ts without affecting non-demo runs.
 *
 * Event types:
 *   suite_begin  - Test run starts, total test count
 *   test_begin   - Individual test starts
 *   step         - pw:api or expect step (filtered for noise reduction)
 *   test_end     - Individual test finishes with status and duration
 *   console_error - Error pattern detected in stderr
 *   suite_end    - All tests finish with aggregates
 *
 * @author GENTYR Framework
 * @version 1.0.0
 */

import fs from 'fs';

// Max progress file size (1MB) — stop writing events after limit
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Playwright Progress Reporter
 *
 * Implements Playwright's Reporter interface.
 * Writes structured JSONL events for real-time progress tracking.
 *
 * @see https://playwright.dev/docs/api/class-reporter
 */
class PlaywrightProgressReporter {
  constructor() {
    /** @type {string|null} */
    this._progressFile = process.env.DEMO_PROGRESS_FILE || null;
    /** @type {number} */
    this._bytesWritten = 0;
    /** @type {boolean} */
    this._limitReached = false;
    /** @type {number} */
    this._totalTests = 0;
    /** @type {number} */
    this._testIndex = 0;
    /** @type {number} */
    this._passed = 0;
    /** @type {number} */
    this._failed = 0;
    /** @type {number} */
    this._skipped = 0;
    /** @type {Map<string, number>} */
    this._annotationCounts = new Map();
  }

  /**
   * Write a JSONL event to the progress file.
   * @param {object} event
   * @param {boolean} force - Write even if limit reached (for suite_end)
   */
  _writeEvent(event, force = false) {
    if (!this._progressFile) return;
    if (this._limitReached && !force) return;

    try {
      const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + '\n';
      fs.appendFileSync(this._progressFile, line);
      this._bytesWritten += line.length;

      if (this._bytesWritten >= MAX_FILE_SIZE) {
        this._limitReached = true;
      }
    } catch {
      // Non-fatal — progress tracking is best-effort
    }
  }

  /**
   * Called when the test run starts.
   * @param {import('@playwright/test').FullConfig} config
   * @param {import('@playwright/test').Suite} suite
   */
  onBegin(config, suite) {
    if (!this._progressFile) return;

    // Truncate/create progress file
    try {
      const dir = this._progressFile.substring(0, this._progressFile.lastIndexOf('/'));
      if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this._progressFile, '');
    } catch {
      this._progressFile = null;
      return;
    }

    this._totalTests = suite.allTests().length;
    this._writeEvent({
      type: 'suite_begin',
      total_tests: this._totalTests,
      project: config.projects?.[0]?.name || 'unknown',
    });
  }

  /**
   * Called when an individual test starts.
   * @param {import('@playwright/test').TestCase} test
   */
  onTestBegin(test) {
    if (!this._progressFile) return;

    this._testIndex++;
    this._writeEvent({
      type: 'test_begin',
      title: test.title,
      file: test.location?.file ? test.location.file.split('/').pop() : undefined,
      index: this._testIndex,
      total: this._totalTests,
    });
  }

  /**
   * Called when a test step begins.
   * Only emits events for pw:api and expect categories (noise filter).
   * @param {import('@playwright/test').TestCase} test
   * @param {import('@playwright/test').TestResult} result
   * @param {import('@playwright/test').TestStep} step
   */
  onStepBegin(test, result, step) {
    if (!this._progressFile) return;

    // Only emit pw:api and expect steps (filter noise)
    if (step.category !== 'pw:api' && step.category !== 'expect') return;

    this._writeEvent({
      type: 'step',
      title: step.title?.slice(0, 200),
      category: step.category,
      test: test.title,
    });
  }

  /**
   * Called when an individual test finishes.
   * @param {import('@playwright/test').TestCase} test
   * @param {import('@playwright/test').TestResult} result
   */
  onTestEnd(test, result) {
    if (!this._progressFile) return;

    if (result.status === 'passed') this._passed++;
    else if (result.status === 'failed' || result.status === 'timedOut') this._failed++;
    else if (result.status === 'skipped') this._skipped++;

    const event = {
      type: 'test_end',
      title: test.title,
      file: test.location?.file ? test.location.file.split('/').pop() : undefined,
      status: result.status,
      duration_ms: result.duration,
      index: this._testIndex,
      total: this._totalTests,
    };

    if (result.status === 'failed' || result.status === 'timedOut') {
      const errors = (result.errors || [])
        .map(e => e.message || e.stack || String(e))
        .join('\n')
        .slice(0, 500);
      event.error = errors || undefined;
    }

    // Surface test annotations (info, warning, skip, fixme)
    const allowedTypes = new Set(['info', 'warning', 'skip', 'fixme']);
    const annotations = (result.annotations || [])
      .filter(a => allowedTypes.has(a.type))
      .slice(0, 10)
      .map(a => ({ type: a.type, description: (a.description || '').slice(0, 300) }));

    if (annotations.length > 0) {
      event.annotations = annotations;
      for (const ann of annotations) {
        this._annotationCounts.set(ann.type, (this._annotationCounts.get(ann.type) || 0) + 1);
      }
    }

    this._writeEvent(event);
  }

  /**
   * Called when stderr output is received.
   * Scans for error patterns and emits console_error events.
   * @param {string|Buffer} chunk
   * @param {import('@playwright/test').TestCase} test
   * @param {import('@playwright/test').TestResult} result
   */
  onStdErr(chunk, test, result) {
    if (!this._progressFile) return;

    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    // Scan for error patterns
    const errorPatterns = [
      /Error:/i,
      /\b404\b/,
      /Unhandled Runtime Error/i,
      /Missing Supabase/i,
      /ECONNREFUSED/i,
      /TypeError:/i,
      /ReferenceError:/i,
    ];

    for (const pattern of errorPatterns) {
      if (pattern.test(text)) {
        this._writeEvent({
          type: 'console_error',
          text: text.trim().slice(0, 500),
          test: test?.title || null,
        });
        break; // One event per chunk
      }
    }
  }

  /**
   * Called when all tests finish.
   * @param {import('@playwright/test').FullResult} result
   */
  onEnd(result) {
    if (!this._progressFile) return;

    // Build suite_end event
    const suiteEnd = {
      type: 'suite_end',
      status: result.status,
      passed: this._passed,
      failed: this._failed,
      skipped: this._skipped,
      duration_ms: result.duration,
    };

    // Include annotation counts if any annotations were recorded
    if (this._annotationCounts.size > 0) {
      suiteEnd.annotation_counts = Object.fromEntries(this._annotationCounts);
    }

    // Always write suite_end even if limit reached
    this._writeEvent(suiteEnd, true);
  }

  /**
   * Playwright calls this to determine if this reporter prints to stdio.
   * Return false so it doesn't interfere with other reporters.
   * @returns {boolean}
   */
  printsToStdio() {
    return false;
  }
}

export default PlaywrightProgressReporter;
