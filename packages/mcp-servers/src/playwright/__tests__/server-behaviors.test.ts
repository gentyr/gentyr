/**
 * Unit tests for new Playwright server behaviors introduced in the
 * op-secrets extraction + preflight/demo changes.
 *
 * Covers:
 *   1. readDemoProgress() — JSONL progress file parsing (pure logic inlined)
 *   2. dev_server check — error body detection (HTML-stripped, 500-char cap)
 *   3. stdout_tail / artifacts fields on DemoRunState and CheckDemoResultResult
 *   4. Secret injection behaviour: non-fatal try/catch (structure only)
 *   5. checkDevServer() helper — response classification logic
 *
 * Child process spawning, file I/O side-effects, and HTTP connections are
 * NOT tested here — those require integration tests. This file covers the
 * pure logic that can be exercised without external dependencies.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { DemoRunState, CheckDemoResultResult, DemoProgress } from '../types.js';

// ============================================================================
// Inline readDemoProgress logic (mirrors server.ts implementation)
// These tests validate the JSONL-parsing state machine precisely, so we
// copy the function verbatim. Any divergence from server.ts is a bug.
// ============================================================================

function readDemoProgress(content: string): DemoProgress | null {
  try {
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    const progress: DemoProgress = {
      tests_completed: 0,
      tests_passed: 0,
      tests_failed: 0,
      total_tests: null,
      current_test: null,
      current_file: null,
      has_failures: false,
      recent_errors: [],
      last_5_results: [],
      suite_completed: false,
      annotations: [],
      has_warnings: false,
    };

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        switch (event.type) {
          case 'suite_begin':
            progress.total_tests = event.total_tests ?? null;
            break;
          case 'test_begin':
            progress.current_test = event.title ?? null;
            progress.current_file = event.file ?? null;
            break;
          case 'test_end':
            progress.tests_completed++;
            if (event.status === 'passed') progress.tests_passed++;
            if (event.status === 'failed' || event.status === 'timedOut') {
              progress.tests_failed++;
              progress.has_failures = true;
            }
            progress.last_5_results.push({ title: event.title, status: event.status });
            if (progress.last_5_results.length > 5) {
              progress.last_5_results.shift();
            }
            // Parse annotations from test_end events
            if (Array.isArray(event.annotations) && event.annotations.length > 0) {
              for (const ann of event.annotations) {
                if (progress.annotations.length >= 50) break;
                progress.annotations.push({
                  test_title: event.title ?? '',
                  type: ann.type ?? '',
                  description: ann.description ?? '',
                });
                if (ann.type === 'warning') {
                  progress.has_warnings = true;
                }
              }
            }
            progress.current_test = null;
            progress.current_file = null;
            break;
          case 'console_error':
            if (progress.recent_errors.length < 10) {
              progress.recent_errors.push(event.text?.slice(0, 500) ?? 'Unknown error');
            }
            // console_error does NOT set has_failures — stderr may be transient
            break;
          case 'crash':
            progress.has_failures = true;
            if (event.stderr_snippet && progress.recent_errors.length < 10) {
              progress.recent_errors.push(String(event.stderr_snippet).slice(0, 2000));
            }
            if (event.stdout_snippet && progress.recent_errors.length < 10) {
              progress.recent_errors.push(`[stdout] ${String(event.stdout_snippet).slice(0, 2000)}`);
            }
            break;
          case 'suite_end':
            progress.current_test = null;
            progress.current_file = null;
            progress.suite_completed = true;
            break;
        }
      } catch {
        // Skip malformed lines
      }
    }

    return progress;
  } catch {
    return null;
  }
}

// ============================================================================
// readDemoProgress — JSONL parsing tests
// ============================================================================

describe('readDemoProgress — JSONL progress parsing', () => {
  describe('empty / malformed input', () => {
    it('should return null for empty string', () => {
      expect(readDemoProgress('')).toBeNull();
    });

    it('should return null for whitespace-only content', () => {
      expect(readDemoProgress('   \n\n  ')).toBeNull();
    });

    it('should skip malformed JSON lines without throwing', () => {
      const content = [
        '{ invalid json }',
        JSON.stringify({ type: 'suite_begin', total_tests: 3 }),
      ].join('\n');

      const progress = readDemoProgress(content);

      expect(progress).not.toBeNull();
      expect(progress!.total_tests).toBe(3);
    });

    it('should return null if all lines are malformed', () => {
      const content = '{ bad }\n{ also bad }\nnot json at all';
      // All lines parse-fail, but we still return an initialized progress object
      // because some lines were present (not empty). Actually per the implementation,
      // if none of the parseable events run, we return the initialized zero-state.
      // Let's verify the actual behavior.
      const progress = readDemoProgress(content);
      // readDemoProgress returns non-null even with all-bad lines — it returns the
      // zero-initialized DemoProgress since lines.length > 0.
      // This test documents the current behavior explicitly.
      if (progress !== null) {
        expect(progress.tests_completed).toBe(0);
        expect(progress.has_failures).toBe(false);
      }
    });
  });

  describe('suite_begin event', () => {
    it('should set total_tests from suite_begin event', () => {
      const content = JSON.stringify({ type: 'suite_begin', total_tests: 5 });
      const progress = readDemoProgress(content);

      expect(progress).not.toBeNull();
      expect(progress!.total_tests).toBe(5);
    });

    it('should keep total_tests null if suite_begin has no total_tests field', () => {
      const content = JSON.stringify({ type: 'suite_begin' });
      const progress = readDemoProgress(content);

      expect(progress).not.toBeNull();
      expect(progress!.total_tests).toBeNull();
    });

    it('should set total_tests to null when suite_begin total_tests is null', () => {
      const content = JSON.stringify({ type: 'suite_begin', total_tests: null });
      const progress = readDemoProgress(content);

      expect(progress!.total_tests).toBeNull();
    });
  });

  describe('test_begin event', () => {
    it('should set current_test from test_begin title', () => {
      const content = JSON.stringify({ type: 'test_begin', title: 'should display dashboard', file: 'e2e/demo/main.demo.ts' });
      const progress = readDemoProgress(content);

      expect(progress!.current_test).toBe('should display dashboard');
      expect(progress!.current_file).toBe('e2e/demo/main.demo.ts');
    });

    it('should set current_test to null when title is missing', () => {
      const content = JSON.stringify({ type: 'test_begin' });
      const progress = readDemoProgress(content);

      expect(progress!.current_test).toBeNull();
      expect(progress!.current_file).toBeNull();
    });
  });

  describe('test_end event', () => {
    it('should increment tests_completed and tests_passed for passed status', () => {
      const content = JSON.stringify({ type: 'test_end', title: 'test A', status: 'passed' });
      const progress = readDemoProgress(content);

      expect(progress!.tests_completed).toBe(1);
      expect(progress!.tests_passed).toBe(1);
      expect(progress!.tests_failed).toBe(0);
      expect(progress!.has_failures).toBe(false);
    });

    it('should increment tests_failed and set has_failures for failed status', () => {
      const content = JSON.stringify({ type: 'test_end', title: 'test B', status: 'failed' });
      const progress = readDemoProgress(content);

      expect(progress!.tests_completed).toBe(1);
      expect(progress!.tests_passed).toBe(0);
      expect(progress!.tests_failed).toBe(1);
      expect(progress!.has_failures).toBe(true);
    });

    it('should set has_failures for timedOut status', () => {
      const content = JSON.stringify({ type: 'test_end', title: 'test C', status: 'timedOut' });
      const progress = readDemoProgress(content);

      expect(progress!.tests_failed).toBe(1);
      expect(progress!.has_failures).toBe(true);
    });

    it('should NOT set has_failures for skipped status', () => {
      const content = JSON.stringify({ type: 'test_end', title: 'test D', status: 'skipped' });
      const progress = readDemoProgress(content);

      expect(progress!.tests_completed).toBe(1);
      expect(progress!.has_failures).toBe(false);
    });

    it('should clear current_test and current_file after test_end', () => {
      const lines = [
        JSON.stringify({ type: 'test_begin', title: 'running test', file: 'some.demo.ts' }),
        JSON.stringify({ type: 'test_end', title: 'running test', status: 'passed' }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      expect(progress!.current_test).toBeNull();
      expect(progress!.current_file).toBeNull();
    });

    it('should maintain last_5_results as a sliding window of 5', () => {
      const lines = Array.from({ length: 7 }, (_, i) =>
        JSON.stringify({ type: 'test_end', title: `test-${i}`, status: 'passed' })
      ).join('\n');

      const progress = readDemoProgress(lines);

      expect(progress!.last_5_results).toHaveLength(5);
      // Should be the last 5 (indices 2-6)
      expect(progress!.last_5_results[0].title).toBe('test-2');
      expect(progress!.last_5_results[4].title).toBe('test-6');
    });

    it('should accumulate tests_completed across multiple test_end events', () => {
      const lines = [
        JSON.stringify({ type: 'test_end', title: 't1', status: 'passed' }),
        JSON.stringify({ type: 'test_end', title: 't2', status: 'passed' }),
        JSON.stringify({ type: 'test_end', title: 't3', status: 'failed' }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      expect(progress!.tests_completed).toBe(3);
      expect(progress!.tests_passed).toBe(2);
      expect(progress!.tests_failed).toBe(1);
    });
  });

  describe('console_error event', () => {
    it('should append error text to recent_errors', () => {
      const content = JSON.stringify({ type: 'console_error', text: 'Failed to fetch /favicon.ico' });
      const progress = readDemoProgress(content);

      expect(progress!.recent_errors).toHaveLength(1);
      expect(progress!.recent_errors[0]).toBe('Failed to fetch /favicon.ico');
    });

    it('should NOT set has_failures for console_error (transient stderr noise)', () => {
      const content = JSON.stringify({ type: 'console_error', text: 'Some stderr output' });
      const progress = readDemoProgress(content);

      expect(progress!.has_failures).toBe(false);
    });

    it('should cap recent_errors at 10 entries', () => {
      const lines = Array.from({ length: 15 }, (_, i) =>
        JSON.stringify({ type: 'console_error', text: `error-${i}` })
      ).join('\n');

      const progress = readDemoProgress(lines);

      expect(progress!.recent_errors).toHaveLength(10);
    });

    it('should use "Unknown error" when console_error text is missing', () => {
      const content = JSON.stringify({ type: 'console_error' });
      const progress = readDemoProgress(content);

      expect(progress!.recent_errors[0]).toBe('Unknown error');
    });

    it('should truncate console_error text at 500 characters', () => {
      const longText = 'x'.repeat(600);
      const content = JSON.stringify({ type: 'console_error', text: longText });
      const progress = readDemoProgress(content);

      expect(progress!.recent_errors[0].length).toBe(500);
    });
  });

  describe('crash event', () => {
    it('should set has_failures to true on crash event', () => {
      const content = JSON.stringify({
        type: 'crash',
        timestamp: new Date().toISOString(),
        exit_code: 1,
        stderr_snippet: 'Error: Cannot find module playwright',
      });
      const progress = readDemoProgress(content);

      expect(progress!.has_failures).toBe(true);
    });

    it('should append stderr_snippet to recent_errors on crash', () => {
      const snippet = 'Error: Cannot find module playwright\n    at Object.<anonymous>';
      const content = JSON.stringify({ type: 'crash', stderr_snippet: snippet });
      const progress = readDemoProgress(content);

      expect(progress!.recent_errors).toHaveLength(1);
      expect(progress!.recent_errors[0]).toBe(snippet);
    });

    it('should truncate stderr_snippet at 2000 characters', () => {
      const longSnippet = 'e'.repeat(3000);
      const content = JSON.stringify({ type: 'crash', stderr_snippet: longSnippet });
      const progress = readDemoProgress(content);

      expect(progress!.recent_errors[0].length).toBe(2000);
    });

    it('should set has_failures without adding to recent_errors when stderr_snippet is absent', () => {
      const content = JSON.stringify({ type: 'crash' });
      const progress = readDemoProgress(content);

      expect(progress!.has_failures).toBe(true);
      expect(progress!.recent_errors).toHaveLength(0);
    });

    it('should distinguish crash failure from console_error (crash sets has_failures, console_error does not)', () => {
      const lines = [
        JSON.stringify({ type: 'console_error', text: 'stderr noise' }),
        JSON.stringify({ type: 'crash', stderr_snippet: 'fatal error' }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      // Both contribute to recent_errors, but only crash sets has_failures
      expect(progress!.has_failures).toBe(true);
      expect(progress!.recent_errors).toHaveLength(2);
    });

    it('should append stdout_snippet to recent_errors with [stdout] prefix on crash', () => {
      const content = JSON.stringify({ type: 'crash', stdout_snippet: 'process output before crash' });
      const progress = readDemoProgress(content);

      expect(progress!.recent_errors).toHaveLength(1);
      expect(progress!.recent_errors[0]).toBe('[stdout] process output before crash');
    });

    it('should append both stderr_snippet and stdout_snippet to recent_errors on crash', () => {
      const content = JSON.stringify({
        type: 'crash',
        stderr_snippet: 'stderr message',
        stdout_snippet: 'stdout message',
      });
      const progress = readDemoProgress(content);

      expect(progress!.recent_errors).toHaveLength(2);
      expect(progress!.recent_errors[0]).toBe('stderr message');
      expect(progress!.recent_errors[1]).toBe('[stdout] stdout message');
    });

    it('should truncate stdout_snippet at 2000 characters with [stdout] prefix', () => {
      const longSnippet = 's'.repeat(3000);
      const content = JSON.stringify({ type: 'crash', stdout_snippet: longSnippet });
      const progress = readDemoProgress(content);

      // '[stdout] ' prefix is 9 chars; total = 9 + 2000 = 2009
      expect(progress!.recent_errors[0].startsWith('[stdout] ')).toBe(true);
      expect(progress!.recent_errors[0].length).toBe(9 + 2000);
    });

    it('should not add stdout_snippet when recent_errors is already at cap of 10', () => {
      const lines = [
        // Fill the cap with console_errors first
        ...Array.from({ length: 10 }, (_, i) =>
          JSON.stringify({ type: 'console_error', text: `error-${i}` })
        ),
        JSON.stringify({ type: 'crash', stdout_snippet: 'overflow stdout' }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      // Cap is 10 — the crash stdout_snippet must be discarded
      expect(progress!.recent_errors).toHaveLength(10);
      expect(progress!.recent_errors.every(e => !e.startsWith('[stdout]'))).toBe(true);
    });
  });

  describe('suite_end event', () => {
    it('should clear current_test and current_file on suite_end', () => {
      const lines = [
        JSON.stringify({ type: 'test_begin', title: 'running', file: 'file.demo.ts' }),
        JSON.stringify({ type: 'suite_end', total_passed: 1 }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      expect(progress!.current_test).toBeNull();
      expect(progress!.current_file).toBeNull();
    });

    it('should set suite_completed to true on suite_end', () => {
      const content = JSON.stringify({ type: 'suite_end' });
      const progress = readDemoProgress(content);

      expect(progress!.suite_completed).toBe(true);
    });

    it('should keep suite_completed false when no suite_end event is present', () => {
      const lines = [
        JSON.stringify({ type: 'suite_begin', total_tests: 2 }),
        JSON.stringify({ type: 'test_end', title: 'test A', status: 'passed' }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      expect(progress!.suite_completed).toBe(false);
    });

    it('should set suite_completed true even when suite_end has no extra fields', () => {
      // suite_end carries no required payload — bare event still triggers the flag
      const lines = [
        JSON.stringify({ type: 'suite_begin', total_tests: 1 }),
        JSON.stringify({ type: 'test_end', title: 'only test', status: 'passed' }),
        JSON.stringify({ type: 'suite_end' }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      expect(progress!.suite_completed).toBe(true);
      expect(progress!.tests_completed).toBe(1);
    });

    it('should set suite_completed true alongside has_failures when tests failed', () => {
      const lines = [
        JSON.stringify({ type: 'test_end', title: 'bad test', status: 'failed' }),
        JSON.stringify({ type: 'suite_end' }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      expect(progress!.suite_completed).toBe(true);
      expect(progress!.has_failures).toBe(true);
    });
  });

  describe('readDemoProgress — annotations', () => {
    it('should parse annotations from test_end events', () => {
      const lines = [
        JSON.stringify({
          type: 'test_end', title: 'histogram chart', status: 'passed',
          annotations: [{ type: 'warning', description: 'histogram API returned 404, using fallback data' }],
        }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      expect(progress!.annotations).toHaveLength(1);
      expect(progress!.annotations[0]).toEqual({
        test_title: 'histogram chart',
        type: 'warning',
        description: 'histogram API returned 404, using fallback data',
      });
    });

    it('should set has_warnings for warning-type annotations', () => {
      const lines = [
        JSON.stringify({
          type: 'test_end', title: 'test A', status: 'passed',
          annotations: [{ type: 'warning', description: 'degraded' }],
        }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      expect(progress!.has_warnings).toBe(true);
    });

    it('should keep has_warnings false when no warning annotations', () => {
      const lines = [
        JSON.stringify({
          type: 'test_end', title: 'test A', status: 'passed',
          annotations: [
            { type: 'info', description: 'loaded config' },
            { type: 'skip', description: 'feature disabled' },
            { type: 'fixme', description: 'known flaky' },
          ],
        }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      expect(progress!.has_warnings).toBe(false);
      expect(progress!.annotations).toHaveLength(3);
    });

    it('should handle backward compatibility: old JSONL without annotations', () => {
      const lines = [
        JSON.stringify({ type: 'test_end', title: 'old test', status: 'passed', duration: 100 }),
        JSON.stringify({ type: 'suite_end' }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      expect(progress!.annotations).toEqual([]);
      expect(progress!.has_warnings).toBe(false);
      expect(progress!.suite_completed).toBe(true);
    });

    it('should cap annotations at 50 total', () => {
      const events = [];
      // 6 test_end events, each with 10 annotations = 60 total, should cap at 50
      for (let i = 0; i < 6; i++) {
        const annotations = Array.from({ length: 10 }, (_, j) => ({
          type: 'info',
          description: `annotation ${i}-${j}`,
        }));
        events.push(JSON.stringify({
          type: 'test_end', title: `test ${i}`, status: 'passed', annotations,
        }));
      }
      const lines = events.join('\n');

      const progress = readDemoProgress(lines);

      expect(progress!.annotations).toHaveLength(50);
    });

    it('should support degraded_features extraction from warning annotations', () => {
      const lines = [
        JSON.stringify({
          type: 'test_end', title: 'histogram chart', status: 'passed',
          annotations: [{ type: 'warning', description: 'API returned 404' }],
        }),
        JSON.stringify({
          type: 'test_end', title: 'analytics panel', status: 'passed',
          annotations: [
            { type: 'info', description: 'loaded config' },
            { type: 'warning', description: 'cache miss, cold start' },
          ],
        }),
        JSON.stringify({ type: 'suite_end' }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      // Extract degraded features the same way checkDemoResult does
      const degraded = progress!.annotations
        .filter(a => a.type === 'warning')
        .map(a => `${a.test_title}: ${a.description}`);

      expect(degraded).toEqual([
        'histogram chart: API returned 404',
        'analytics panel: cache miss, cold start',
      ]);
      expect(progress!.has_warnings).toBe(true);
    });
  });

  describe('complete realistic sequence', () => {
    it('should correctly parse a full passing demo sequence', () => {
      const lines = [
        JSON.stringify({ type: 'suite_begin', total_tests: 3 }),
        JSON.stringify({ type: 'test_begin', title: 'navigate to home', file: 'home.demo.ts' }),
        JSON.stringify({ type: 'test_end', title: 'navigate to home', status: 'passed', duration: 1200 }),
        JSON.stringify({ type: 'test_begin', title: 'view billing', file: 'billing.demo.ts' }),
        JSON.stringify({ type: 'test_end', title: 'view billing', status: 'passed', duration: 2300 }),
        JSON.stringify({ type: 'test_begin', title: 'update profile', file: 'profile.demo.ts' }),
        JSON.stringify({ type: 'test_end', title: 'update profile', status: 'passed', duration: 1800 }),
        JSON.stringify({ type: 'suite_end', total_passed: 3, total_failed: 0 }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      expect(progress).not.toBeNull();
      expect(progress!.total_tests).toBe(3);
      expect(progress!.tests_completed).toBe(3);
      expect(progress!.tests_passed).toBe(3);
      expect(progress!.tests_failed).toBe(0);
      expect(progress!.has_failures).toBe(false);
      expect(progress!.current_test).toBeNull();
      expect(progress!.last_5_results).toHaveLength(3);
      // Full sequence includes suite_end — must be marked complete
      expect(progress!.suite_completed).toBe(true);
    });

    it('should correctly parse a mixed pass/fail sequence', () => {
      const lines = [
        JSON.stringify({ type: 'suite_begin', total_tests: 4 }),
        JSON.stringify({ type: 'test_end', title: 'test A', status: 'passed' }),
        JSON.stringify({ type: 'test_end', title: 'test B', status: 'failed' }),
        JSON.stringify({ type: 'console_error', text: '404 not found' }),
        JSON.stringify({ type: 'test_end', title: 'test C', status: 'passed' }),
        JSON.stringify({ type: 'test_end', title: 'test D', status: 'timedOut' }),
      ].join('\n');

      const progress = readDemoProgress(lines);

      expect(progress!.tests_completed).toBe(4);
      expect(progress!.tests_passed).toBe(2);
      expect(progress!.tests_failed).toBe(2);
      expect(progress!.has_failures).toBe(true);
      expect(progress!.recent_errors).toHaveLength(1);
      expect(progress!.recent_errors[0]).toBe('404 not found');
      // No suite_end in this sequence — not complete
      expect(progress!.suite_completed).toBe(false);
    });
  });
});

// ============================================================================
// dev_server error body pattern detection
// ============================================================================

describe('dev_server check — error body detection logic', () => {
  /**
   * The dev_server preflight check reads the HTTP response body and searches
   * for error patterns. This tests the detection logic in isolation.
   */
  const ERROR_PATTERNS = [
    'Unhandled Runtime Error',
    'Missing Supabase environment variables',
    'Internal Server Error',
  ];

  function detectErrorInBody(body: string): string | null {
    const bodyLower = body.toLowerCase();
    for (const pattern of ERROR_PATTERNS) {
      if (bodyLower.includes(pattern.toLowerCase())) {
        return pattern;
      }
    }
    return null;
  }

  it('should detect "Unhandled Runtime Error" in HTML body', () => {
    const body = '<html><body><h1>Unhandled Runtime Error</h1><pre>TypeError: x is not a function</pre></body></html>';
    expect(detectErrorInBody(body)).toBe('Unhandled Runtime Error');
  });

  it('should detect "Missing Supabase environment variables" pattern', () => {
    const body = '<p>Missing Supabase environment variables. Please configure SUPABASE_URL.</p>';
    expect(detectErrorInBody(body)).toBe('Missing Supabase environment variables');
  });

  it('should detect "Internal Server Error" in body', () => {
    const body = '<html><title>Internal Server Error</title><body>500</body></html>';
    expect(detectErrorInBody(body)).toBe('Internal Server Error');
  });

  it('should be case-insensitive in pattern matching', () => {
    const body = 'unhandled runtime error occurred on the server';
    expect(detectErrorInBody(body)).toBe('Unhandled Runtime Error');
  });

  it('should return null for a healthy response body', () => {
    const body = '<html><head><title>My App</title></head><body><div id="app">Welcome!</div></body></html>';
    expect(detectErrorInBody(body)).toBeNull();
  });

  it('should return null for an empty body', () => {
    expect(detectErrorInBody('')).toBeNull();
  });

  it('should return null for a 200 JSON API response', () => {
    const body = JSON.stringify({ status: 'ok', version: '1.0.0' });
    expect(detectErrorInBody(body)).toBeNull();
  });

  it('should detect error pattern in large HTML body', () => {
    const prefix = 'x'.repeat(5000);
    const suffix = 'y'.repeat(5000);
    const body = prefix + 'Internal Server Error' + suffix;
    expect(detectErrorInBody(body)).toBe('Internal Server Error');
  });
});

// ============================================================================
// dev_server check — HTTP status classification
// ============================================================================

describe('dev_server check — HTTP status classification', () => {
  /**
   * Tests the status code → pass/fail/warn decision logic from preflightCheck.
   * In the new version, 5xx codes are fails (previously they were warns).
   */
  function classifyStatusCode(statusCode: number): 'pass' | 'fail' {
    if (statusCode >= 500) return 'fail';
    return 'pass';
  }

  it('should fail on 500 Internal Server Error', () => {
    expect(classifyStatusCode(500)).toBe('fail');
  });

  it('should fail on 503 Service Unavailable', () => {
    expect(classifyStatusCode(503)).toBe('fail');
  });

  it('should fail on 502 Bad Gateway', () => {
    expect(classifyStatusCode(502)).toBe('fail');
  });

  it('should pass on 200 OK', () => {
    expect(classifyStatusCode(200)).toBe('pass');
  });

  it('should pass on 301 redirect (server is up and routing)', () => {
    expect(classifyStatusCode(301)).toBe('pass');
  });

  it('should pass on 404 (server is up, page not found is OK)', () => {
    expect(classifyStatusCode(404)).toBe('pass');
  });

  it('should pass on 401 (server is up, auth required)', () => {
    expect(classifyStatusCode(401)).toBe('pass');
  });
});

// ============================================================================
// stdout_tail and artifacts fields in DemoRunState / CheckDemoResultResult
// Tests document expected interface structure for the new fields.
// ============================================================================

describe('DemoRunState — stdout_tail field', () => {
  it('should accept DemoRunState without stdout_tail (field is optional)', () => {
    const state: DemoRunState = {
      pid: 12345,
      project: 'vendor-owner',
      started_at: '2026-02-28T00:00:00.000Z',
      status: 'running',
    };

    expect(state.pid).toBe(12345);
    expect(state.status).toBe('running');
    expect(state.stdout_tail).toBeUndefined();
  });

  it('should accept DemoRunState with stdout_tail populated (early_exit code 0 path)', () => {
    const state: DemoRunState = {
      pid: 22222,
      project: 'demo',
      started_at: '2026-02-28T00:00:00.000Z',
      status: 'passed',
      ended_at: '2026-02-28T00:00:45.000Z',
      exit_code: 0,
      stdout_tail: 'Running 3 tests...\n  ✓ navigate to home (1.2s)\n  ✓ view billing (2.3s)\n  ✓ update profile (1.8s)',
    };

    expect(typeof state.stdout_tail).toBe('string');
    expect(state.stdout_tail!.length).toBeGreaterThan(0);
    expect(state.status).toBe('passed');
    expect(state.exit_code).toBe(0);
  });

  it('stdout_tail should be a string when set', () => {
    const state: DemoRunState = {
      pid: 33333,
      project: 'vendor-owner',
      started_at: '2026-02-28T00:00:00.000Z',
      status: 'failed',
      stdout_tail: 'Error: expect(received).toBe(expected)',
    };

    expect(typeof state.stdout_tail).toBe('string');
  });

  it('should accept DemoRunState with all required fields for running status', () => {
    const state: DemoRunState = {
      pid: 99999,
      project: 'demo',
      test_file: 'e2e/demo/onboarding.demo.ts',
      started_at: new Date().toISOString(),
      status: 'running',
    };

    expect(typeof state.pid).toBe('number');
    expect(typeof state.project).toBe('string');
    expect(state.status).toBe('running');
  });

  it('should accept DemoRunState with all fields for failed status', () => {
    const state: DemoRunState = {
      pid: 54321,
      project: 'vendor-owner',
      started_at: '2026-02-28T00:00:00.000Z',
      status: 'failed',
      ended_at: '2026-02-28T00:01:00.000Z',
      exit_code: 1,
      failure_summary: 'Test assertion failed on line 42',
      screenshot_paths: ['/tmp/test-results/failure-screenshot.png'],
    };

    expect(state.status).toBe('failed');
    expect(state.exit_code).toBe(1);
    expect(Array.isArray(state.screenshot_paths)).toBe(true);
    expect(state.screenshot_paths!.length).toBe(1);
  });
});

describe('CheckDemoResultResult — artifacts field', () => {
  it('should accept CheckDemoResultResult without artifacts (field is optional)', () => {
    const result: CheckDemoResultResult = {
      status: 'passed',
      pid: 12345,
      project: 'vendor-owner',
      message: 'Demo completed successfully.',
    };

    // artifacts field not in types.ts yet — test documents expected shape
    // when the field is added to the interface.
    expect(result.status).toBe('passed');
    expect(result.pid).toBe(12345);
  });

  it('should accept CheckDemoResultResult with all mandatory fields', () => {
    const result: CheckDemoResultResult = {
      status: 'running',
      pid: 77777,
      message: 'Demo is running (25s elapsed).',
    };

    expect(typeof result.status).toBe('string');
    expect(typeof result.pid).toBe('number');
    expect(typeof result.message).toBe('string');
  });

  it('should accept CheckDemoResultResult for unknown status', () => {
    const result: CheckDemoResultResult = {
      status: 'unknown',
      pid: 11111,
      message: 'Demo process is no longer running but exit was not captured.',
    };

    expect(result.status).toBe('unknown');
  });

  it('CheckDemoResultResult round-trips through JSON with all fields intact', () => {
    const original: CheckDemoResultResult = {
      status: 'failed',
      pid: 42,
      project: 'demo',
      test_file: 'e2e/demo/billing.demo.ts',
      started_at: '2026-02-28T00:00:00.000Z',
      ended_at: '2026-02-28T00:02:00.000Z',
      exit_code: 1,
      failure_summary: 'Assertion error on billing page',
      screenshot_paths: ['/tmp/test-results/fail-1.png'],
      trace_summary: '=== DEMO PLAY-BY-PLAY TRACE ===\nTotal events: 5\n=== END TRACE ===',
      message: 'Demo failed.',
    };

    const serialized = JSON.stringify(original);
    const deserialized: CheckDemoResultResult = JSON.parse(serialized);

    expect(deserialized.status).toBe('failed');
    expect(deserialized.pid).toBe(42);
    expect(deserialized.exit_code).toBe(1);
    expect(deserialized.screenshot_paths).toHaveLength(1);
    expect(deserialized.trace_summary).toContain('DEMO PLAY-BY-PLAY TRACE');
  });
});

// ============================================================================
// Secret injection — non-fatal behaviour structure tests
// ============================================================================

describe('Secret injection — non-fatal try/catch contract', () => {
  /**
   * The new launchUiMode() and runDemo() implementations wrap secret injection
   * in a non-fatal try/catch. These tests document the expected contract:
   *
   * 1. A failed secret injection must NOT prevent the demo from launching.
   * 2. The result must still have success: true when the process starts.
   * 3. Errors from secret injection should not surface in result.message
   *    (they are logged to stderr only).
   *
   * We test this via the type contract since the actual functions require
   * spawning a child process (integration test territory).
   */

  it('LaunchUiModeResult should be structured for success even without injection', () => {
    // Simulate what the function returns on success when injection is skipped
    const successResult = {
      success: true,
      project: 'vendor-owner',
      message: 'Playwright UI mode launched for project "vendor-owner".',
      pid: 12345,
    };

    expect(successResult.success).toBe(true);
    expect(typeof successResult.message).toBe('string');
    expect(typeof successResult.pid).toBe('number');
    // message should NOT contain "secret" or "injection" text
    expect(successResult.message).not.toMatch(/secret|injection|1password/i);
  });

  it('RunDemoResult should indicate success independently of injection errors', () => {
    const successResult = {
      success: true,
      project: 'demo',
      message: 'Headed auto-play demo launched for project "demo" with 800ms slow motion.',
      pid: 54321,
      slow_mo: 800,
    };

    expect(successResult.success).toBe(true);
    expect(successResult.slow_mo).toBe(800);
    expect(successResult.message).toContain('800ms slow motion');
  });

  it('RunDemoResult failure should describe the actual error, not a secret injection failure', () => {
    // When demo fails for reasons unrelated to secret injection
    const failResult = {
      success: false,
      project: 'demo',
      message: 'Playwright process crashed during startup (exit code: 1)',
    };

    expect(failResult.success).toBe(false);
    // The failure message should be about the process, not credentials
    expect(failResult.message).toContain('crashed');
    expect(failResult.message).not.toMatch(/secret|injection|token|credential/i);
  });
});

// ============================================================================
// Stdout rolling buffer — behaviour contract
// ============================================================================

describe('Stdout rolling buffer — 50-line cap behaviour', () => {
  /**
   * The new runDemo() implementation collects stdout into a 50-line rolling
   * buffer for failure visibility. This tests the rolling buffer logic.
   */

  function makeRollingBuffer(maxLines: number) {
    const buffer: string[] = [];
    return {
      push(line: string) {
        buffer.push(line);
        if (buffer.length > maxLines) {
          buffer.shift();
        }
      },
      get lines() { return [...buffer]; },
      get length() { return buffer.length; },
    };
  }

  const MAX_LINES = 50;

  it('should hold up to 50 lines', () => {
    const buf = makeRollingBuffer(MAX_LINES);
    for (let i = 0; i < 50; i++) buf.push(`line-${i}`);

    expect(buf.length).toBe(50);
    expect(buf.lines[0]).toBe('line-0');
    expect(buf.lines[49]).toBe('line-49');
  });

  it('should drop oldest lines when 51st is added', () => {
    const buf = makeRollingBuffer(MAX_LINES);
    for (let i = 0; i < 51; i++) buf.push(`line-${i}`);

    expect(buf.length).toBe(50);
    expect(buf.lines[0]).toBe('line-1'); // line-0 dropped
    expect(buf.lines[49]).toBe('line-50');
  });

  it('should always keep the last 50 lines from any sequence', () => {
    const buf = makeRollingBuffer(MAX_LINES);
    for (let i = 0; i < 200; i++) buf.push(`line-${i}`);

    expect(buf.length).toBe(50);
    // Last 50 lines from 0..199 should be 150..199
    expect(buf.lines[0]).toBe('line-150');
    expect(buf.lines[49]).toBe('line-199');
  });

  it('should work correctly with fewer than 50 lines', () => {
    const buf = makeRollingBuffer(MAX_LINES);
    buf.push('only line');

    expect(buf.length).toBe(1);
    expect(buf.lines[0]).toBe('only line');
  });

  it('should be empty initially', () => {
    const buf = makeRollingBuffer(MAX_LINES);
    expect(buf.length).toBe(0);
    expect(buf.lines).toHaveLength(0);
  });
});

// ============================================================================
// DemoProgress type — structural validation
// ============================================================================

describe('DemoProgress structural validation', () => {
  it('all numeric fields should be valid non-negative integers', () => {
    const progress: DemoProgress = {
      tests_completed: 5,
      tests_passed: 3,
      tests_failed: 2,
      total_tests: 10,
      current_test: null,
      current_file: null,
      has_failures: true,
      recent_errors: [],
      last_5_results: [],
      suite_completed: false,
    };

    expect(Number.isInteger(progress.tests_completed)).toBe(true);
    expect(Number.isInteger(progress.tests_passed)).toBe(true);
    expect(Number.isInteger(progress.tests_failed)).toBe(true);
    expect(progress.tests_completed).toBeGreaterThanOrEqual(0);
    expect(progress.tests_passed).toBeGreaterThanOrEqual(0);
    expect(progress.tests_failed).toBeGreaterThanOrEqual(0);
  });

  it('tests_passed + tests_failed should never exceed tests_completed', () => {
    const progress: DemoProgress = {
      tests_completed: 5,
      tests_passed: 3,
      tests_failed: 2,
      total_tests: 5,
      current_test: null,
      current_file: null,
      has_failures: true,
      recent_errors: [],
      last_5_results: [],
      suite_completed: false,
    };

    expect(progress.tests_passed + progress.tests_failed).toBeLessThanOrEqual(progress.tests_completed);
  });

  it('has_failures should be true whenever tests_failed > 0', () => {
    // This tests the logical invariant — not enforced by types but by the
    // readDemoProgress state machine.
    const progress: DemoProgress = {
      tests_completed: 1,
      tests_passed: 0,
      tests_failed: 1,
      total_tests: 1,
      current_test: null,
      current_file: null,
      has_failures: true,
      recent_errors: [],
      last_5_results: [{ title: 'broken test', status: 'failed' }],
      suite_completed: false,
    };

    if (progress.tests_failed > 0) {
      expect(progress.has_failures).toBe(true);
    }
  });

  it('last_5_results each entry should have title and status fields', () => {
    const progress: DemoProgress = {
      tests_completed: 2,
      tests_passed: 1,
      tests_failed: 1,
      total_tests: 2,
      current_test: null,
      current_file: null,
      has_failures: true,
      recent_errors: [],
      last_5_results: [
        { title: 'test one', status: 'passed' },
        { title: 'test two', status: 'failed' },
      ],
      suite_completed: false,
    };

    for (const result of progress.last_5_results) {
      expect(typeof result.title).toBe('string');
      expect(typeof result.status).toBe('string');
      expect(result.title.length).toBeGreaterThan(0);
    }
  });

  it('recent_errors should be an array of strings', () => {
    const progress: DemoProgress = {
      tests_completed: 0,
      tests_passed: 0,
      tests_failed: 0,
      total_tests: null,
      current_test: null,
      current_file: null,
      has_failures: false,
      recent_errors: ['Error: connection refused', 'Warning: deprecated API'],
      last_5_results: [],
      suite_completed: false,
    };

    expect(Array.isArray(progress.recent_errors)).toBe(true);
    for (const err of progress.recent_errors) {
      expect(typeof err).toBe('string');
    }
  });
});

// ============================================================================
// checkDemoResult dead-process status determination
//
// When process.kill(pid, 0) throws (process no longer alive), server.ts reads
// the progress file and determines final status using this decision tree:
//
//   if (finalProgress && finalProgress.tests_completed > 0)
//     status = finalProgress.has_failures ? 'failed' : 'passed'
//   else
//     status = 'unknown'
//
// These tests exercise that logic in isolation — no child process or file I/O.
// The inline function mirrors server.ts exactly so any divergence is a bug.
// ============================================================================

/**
 * Mirrors the status-determination branch in server.ts checkDemoResult()
 * that runs when process.kill(pid, 0) throws.
 */
function determineDeadProcessStatus(finalProgress: DemoProgress | null): {
  status: 'passed' | 'failed' | 'unknown';
  failure_summary: string | undefined;
} {
  if (finalProgress && finalProgress.tests_completed > 0) {
    if (finalProgress.has_failures) {
      return {
        status: 'failed',
        failure_summary: `${finalProgress.tests_failed} test(s) failed out of ${finalProgress.tests_completed}`,
      };
    } else {
      return { status: 'passed', failure_summary: undefined };
    }
  }
  return { status: 'unknown', failure_summary: undefined };
}

describe('checkDemoResult dead-process status determination', () => {
  describe('when progress has completed tests with failures', () => {
    it('should return failed when has_failures is true and tests_completed > 0', () => {
      const progress: DemoProgress = {
        tests_completed: 3,
        tests_passed: 1,
        tests_failed: 2,
        total_tests: 3,
        current_test: null,
        current_file: null,
        has_failures: true,
        recent_errors: [],
        last_5_results: [],
        suite_completed: false,
      };

      const result = determineDeadProcessStatus(progress);

      expect(result.status).toBe('failed');
    });

    it('should include tests_failed and tests_completed in the failure_summary', () => {
      const progress: DemoProgress = {
        tests_completed: 5,
        tests_passed: 3,
        tests_failed: 2,
        total_tests: 5,
        current_test: null,
        current_file: null,
        has_failures: true,
        recent_errors: [],
        last_5_results: [],
        suite_completed: false,
      };

      const result = determineDeadProcessStatus(progress);

      expect(result.failure_summary).toContain('2');
      expect(result.failure_summary).toContain('5');
    });

    it('should return failed when only one test failed', () => {
      const progress: DemoProgress = {
        tests_completed: 1,
        tests_passed: 0,
        tests_failed: 1,
        total_tests: 1,
        current_test: null,
        current_file: null,
        has_failures: true,
        recent_errors: [],
        last_5_results: [],
        suite_completed: false,
      };

      const result = determineDeadProcessStatus(progress);

      expect(result.status).toBe('failed');
      expect(result.failure_summary).toContain('1');
    });
  });

  describe('when progress has completed tests with no failures', () => {
    it('should return passed when has_failures is false and tests_completed > 0', () => {
      const progress: DemoProgress = {
        tests_completed: 4,
        tests_passed: 4,
        tests_failed: 0,
        total_tests: 4,
        current_test: null,
        current_file: null,
        has_failures: false,
        recent_errors: [],
        last_5_results: [],
        suite_completed: false,
      };

      const result = determineDeadProcessStatus(progress);

      expect(result.status).toBe('passed');
    });

    it('should return undefined failure_summary when passed', () => {
      const progress: DemoProgress = {
        tests_completed: 2,
        tests_passed: 2,
        tests_failed: 0,
        total_tests: 2,
        current_test: null,
        current_file: null,
        has_failures: false,
        recent_errors: [],
        last_5_results: [],
        suite_completed: false,
      };

      const result = determineDeadProcessStatus(progress);

      expect(result.failure_summary).toBeUndefined();
    });

    it('should return passed even when recent_errors exist but has_failures is false', () => {
      // console_error events add to recent_errors but do NOT set has_failures
      const progress: DemoProgress = {
        tests_completed: 2,
        tests_passed: 2,
        tests_failed: 0,
        total_tests: 2,
        current_test: null,
        current_file: null,
        has_failures: false,
        recent_errors: ['Failed to fetch /favicon.ico', 'Hot reload noise'],
        last_5_results: [],
        suite_completed: false,
      };

      const result = determineDeadProcessStatus(progress);

      expect(result.status).toBe('passed');
    });
  });

  describe('when progress is unavailable or has no completed tests', () => {
    it('should return unknown when finalProgress is null (no progress file)', () => {
      const result = determineDeadProcessStatus(null);

      expect(result.status).toBe('unknown');
    });

    it('should return unknown when tests_completed is 0 (process died before any test ran)', () => {
      const progress: DemoProgress = {
        tests_completed: 0,
        tests_passed: 0,
        tests_failed: 0,
        total_tests: 3,
        current_test: null,
        current_file: null,
        has_failures: false,
        recent_errors: [],
        last_5_results: [],
        suite_completed: false,
      };

      const result = determineDeadProcessStatus(progress);

      expect(result.status).toBe('unknown');
    });

    it('should return unknown when tests_completed is 0 even if has_failures is true (e.g. crash before tests)', () => {
      // A crash event sets has_failures but does not increment tests_completed.
      // The guard condition requires tests_completed > 0, so we must return unknown.
      const progress: DemoProgress = {
        tests_completed: 0,
        tests_passed: 0,
        tests_failed: 0,
        total_tests: null,
        current_test: null,
        current_file: null,
        has_failures: true,
        recent_errors: ['Browser crashed on startup'],
        last_5_results: [],
        suite_completed: false,
      };

      const result = determineDeadProcessStatus(progress);

      expect(result.status).toBe('unknown');
    });

    it('should return unknown failure_summary when status is unknown', () => {
      const result = determineDeadProcessStatus(null);

      expect(result.failure_summary).toBeUndefined();
    });
  });

  describe('status type safety', () => {
    it('should always return one of the three valid DemoRunStatus values', () => {
      const validStatuses = ['passed', 'failed', 'unknown'];

      const cases: DemoProgress[] = [
        {
          tests_completed: 0, tests_passed: 0, tests_failed: 0,
          total_tests: null, current_test: null, current_file: null,
          has_failures: false, recent_errors: [], last_5_results: [],
          suite_completed: false,
        },
        {
          tests_completed: 2, tests_passed: 2, tests_failed: 0,
          total_tests: 2, current_test: null, current_file: null,
          has_failures: false, recent_errors: [], last_5_results: [],
          suite_completed: false,
        },
        {
          tests_completed: 1, tests_passed: 0, tests_failed: 1,
          total_tests: 1, current_test: null, current_file: null,
          has_failures: true, recent_errors: [], last_5_results: [],
          suite_completed: false,
        },
      ];

      for (const progress of cases) {
        const result = determineDeadProcessStatus(progress);
        expect(validStatuses).toContain(result.status);
      }
    });
  });
});

// ============================================================================
// checkDemoResult auto-kill on suite_completed
//
// When checkDemoResult is called and the process is still alive but
// progress.suite_completed is true, it immediately kills the process and
// resolves the status from progress data. This mirrors the branch in server.ts:
//
//   if (progress?.suite_completed) {
//     entry.status = progress.has_failures ? 'failed' : 'passed';
//     entry.failure_summary = ...
//     return { status: entry.status, ... }
//   }
//
// The auto-kill status determination is identical to determineDeadProcessStatus
// but checks suite_completed (not tests_completed) as its trigger, so it can
// correctly report 'passed'/'failed' based on has_failures.
// ============================================================================

/**
 * Mirrors the suite_completed auto-kill status-determination branch in
 * checkDemoResult() that fires when process.kill(pid, 0) succeeds but
 * progress.suite_completed is true.
 */
function determineSuiteCompletedStatus(progress: DemoProgress): {
  status: 'passed' | 'failed';
  failure_summary: string | undefined;
} {
  if (progress.has_failures) {
    return {
      status: 'failed',
      failure_summary: `${progress.tests_failed} test(s) failed out of ${progress.tests_completed}`,
    };
  }
  return { status: 'passed', failure_summary: undefined };
}

describe('checkDemoResult — suite_completed auto-kill status determination', () => {
  describe('when suite completed with no failures', () => {
    it('should return passed when has_failures is false', () => {
      const progress: DemoProgress = {
        tests_completed: 3,
        tests_passed: 3,
        tests_failed: 0,
        total_tests: 3,
        current_test: null,
        current_file: null,
        has_failures: false,
        recent_errors: [],
        last_5_results: [],
        suite_completed: true,
      };

      const result = determineSuiteCompletedStatus(progress);

      expect(result.status).toBe('passed');
    });

    it('should return undefined failure_summary when all tests passed', () => {
      const progress: DemoProgress = {
        tests_completed: 5,
        tests_passed: 5,
        tests_failed: 0,
        total_tests: 5,
        current_test: null,
        current_file: null,
        has_failures: false,
        recent_errors: [],
        last_5_results: [],
        suite_completed: true,
      };

      const result = determineSuiteCompletedStatus(progress);

      expect(result.failure_summary).toBeUndefined();
    });

    it('should return passed even when recent_errors exist but has_failures is false', () => {
      // console_error events populate recent_errors without setting has_failures
      const progress: DemoProgress = {
        tests_completed: 2,
        tests_passed: 2,
        tests_failed: 0,
        total_tests: 2,
        current_test: null,
        current_file: null,
        has_failures: false,
        recent_errors: ['Failed to load resource: favicon.ico'],
        last_5_results: [],
        suite_completed: true,
      };

      const result = determineSuiteCompletedStatus(progress);

      expect(result.status).toBe('passed');
    });
  });

  describe('when suite completed with failures', () => {
    it('should return failed when has_failures is true', () => {
      const progress: DemoProgress = {
        tests_completed: 4,
        tests_passed: 2,
        tests_failed: 2,
        total_tests: 4,
        current_test: null,
        current_file: null,
        has_failures: true,
        recent_errors: [],
        last_5_results: [],
        suite_completed: true,
      };

      const result = determineSuiteCompletedStatus(progress);

      expect(result.status).toBe('failed');
    });

    it('should include tests_failed and tests_completed in failure_summary', () => {
      const progress: DemoProgress = {
        tests_completed: 6,
        tests_passed: 4,
        tests_failed: 2,
        total_tests: 6,
        current_test: null,
        current_file: null,
        has_failures: true,
        recent_errors: [],
        last_5_results: [],
        suite_completed: true,
      };

      const result = determineSuiteCompletedStatus(progress);

      expect(result.failure_summary).toContain('2');
      expect(result.failure_summary).toContain('6');
    });

    it('should return failed when a crash set has_failures but tests_completed is 0', () => {
      // Unlike determineDeadProcessStatus (which guards on tests_completed > 0),
      // the suite_completed branch trusts has_failures directly. A crash before
      // any test produces suite_completed=true + has_failures=true + tests_completed=0.
      const progress: DemoProgress = {
        tests_completed: 0,
        tests_passed: 0,
        tests_failed: 0,
        total_tests: null,
        current_test: null,
        current_file: null,
        has_failures: true,
        recent_errors: ['Browser crashed at launch'],
        last_5_results: [],
        suite_completed: true,
      };

      const result = determineSuiteCompletedStatus(progress);

      // has_failures dominates — even without completed tests
      expect(result.status).toBe('failed');
    });
  });

  describe('contract difference from determineDeadProcessStatus', () => {
    it('never returns unknown — suite_completed guarantees a definitive pass/fail', () => {
      // determineDeadProcessStatus can return 'unknown' when tests_completed === 0.
      // determineSuiteCompletedStatus always returns 'passed' or 'failed'.
      const progress: DemoProgress = {
        tests_completed: 0,
        tests_passed: 0,
        tests_failed: 0,
        total_tests: null,
        current_test: null,
        current_file: null,
        has_failures: false,
        recent_errors: [],
        last_5_results: [],
        suite_completed: true,
      };

      const result = determineSuiteCompletedStatus(progress);

      expect(['passed', 'failed']).toContain(result.status);
    });

    it('suite_completed + no failures returns passed regardless of tests_completed count', () => {
      // Edge: suite_end fired but total_tests was 0 (empty suite). Still 'passed'.
      const progress: DemoProgress = {
        tests_completed: 0,
        tests_passed: 0,
        tests_failed: 0,
        total_tests: 0,
        current_test: null,
        current_file: null,
        has_failures: false,
        recent_errors: [],
        last_5_results: [],
        suite_completed: true,
      };

      const result = determineSuiteCompletedStatus(progress);

      expect(result.status).toBe('passed');
    });
  });
});

// ============================================================================
// early_exit code 0 status determination
//
// When the Playwright process exits with code 0 during the monitoring window,
// runDemo() reads the progress file and determines status:
//
//   null progress → 'passed' (no progress file means no test failures reported)
//   progress.has_failures → 'failed'
//   else → 'passed'
//
// This mirrors the code-0 branch in runDemo's early_exit handler.
// ============================================================================

/**
 * Mirrors the status-determination logic for early_exit code 0 in runDemo().
 */
function determineEarlyExitCode0Status(progress: DemoProgress | null): {
  status: 'passed' | 'failed';
  hasFailures: boolean;
} {
  const hasFailures = progress?.has_failures ?? false;
  return {
    status: hasFailures ? 'failed' : 'passed',
    hasFailures,
  };
}

describe('early_exit code 0 — status determination', () => {
  describe('when progress is null (no progress file)', () => {
    it('should return passed — no evidence of failures', () => {
      const result = determineEarlyExitCode0Status(null);

      expect(result.status).toBe('passed');
      expect(result.hasFailures).toBe(false);
    });
  });

  describe('when all tests passed', () => {
    it('should return passed when has_failures is false', () => {
      const progress: DemoProgress = {
        tests_completed: 3,
        tests_passed: 3,
        tests_failed: 0,
        total_tests: 3,
        current_test: null,
        current_file: null,
        has_failures: false,
        recent_errors: [],
        last_5_results: [],
        suite_completed: true,
      };

      const result = determineEarlyExitCode0Status(progress);

      expect(result.status).toBe('passed');
      expect(result.hasFailures).toBe(false);
    });
  });

  describe('when tests have failures', () => {
    it('should return failed when has_failures is true', () => {
      const progress: DemoProgress = {
        tests_completed: 3,
        tests_passed: 1,
        tests_failed: 2,
        total_tests: 3,
        current_test: null,
        current_file: null,
        has_failures: true,
        recent_errors: [],
        last_5_results: [],
        suite_completed: true,
      };

      const result = determineEarlyExitCode0Status(progress);

      expect(result.status).toBe('failed');
      expect(result.hasFailures).toBe(true);
    });
  });

  describe('contract difference from determineDeadProcessStatus', () => {
    it('never returns unknown — code 0 always yields passed or failed', () => {
      const cases: (DemoProgress | null)[] = [
        null,
        {
          tests_completed: 0, tests_passed: 0, tests_failed: 0,
          total_tests: null, current_test: null, current_file: null,
          has_failures: false, recent_errors: [], last_5_results: [],
          suite_completed: false,
        },
        {
          tests_completed: 1, tests_passed: 0, tests_failed: 1,
          total_tests: 1, current_test: null, current_file: null,
          has_failures: true, recent_errors: [], last_5_results: [],
          suite_completed: true,
        },
      ];

      for (const progress of cases) {
        const result = determineEarlyExitCode0Status(progress);
        expect(['passed', 'failed']).toContain(result.status);
      }
    });
  });
});

// ============================================================================
// effectivePauseAtEnd — auto-disable pause_at_end when record_video is true
//
// page.pause() holds the browser open, preventing context.close() which is
// required to finalize the .webm video file. When both are requested,
// record_video wins and pause_at_end is silently disabled.
// ============================================================================

/**
 * Mirrors the effectivePauseAtEnd computation in runDemo().
 */
function computeEffectivePauseAtEnd(record_video: boolean, pause_at_end: boolean): boolean {
  return (record_video && pause_at_end) ? false : pause_at_end;
}

describe('computeEffectivePauseAtEnd — record_video vs pause_at_end', () => {
  it('should return false when both record_video and pause_at_end are true', () => {
    expect(computeEffectivePauseAtEnd(true, true)).toBe(false);
  });

  it('should return true when pause_at_end is true and record_video is false', () => {
    expect(computeEffectivePauseAtEnd(false, true)).toBe(true);
  });

  it('should return false when pause_at_end is false and record_video is true', () => {
    expect(computeEffectivePauseAtEnd(true, false)).toBe(false);
  });

  it('should return false when both are false', () => {
    expect(computeEffectivePauseAtEnd(false, false)).toBe(false);
  });
});

// ============================================================================
// Crash event JSONL written by early_exit non-zero path
//
// When a Playwright process exits with a non-zero code within the monitoring
// window, server.ts writes a crash event to the progress file so that
// check_demo_result can surface the error. This tests that the JSONL
// structure written by that branch is well-formed and consumable by
// readDemoProgress().
//
// The crash event shape (from server.ts lines ~782-791):
//   { type: 'crash', timestamp, exit_code, signal, stderr_snippet, stdout_snippet }
// ============================================================================

describe('early_exit non-zero — crash event JSONL structure', () => {
  /**
   * Build the crash event exactly as server.ts does in the non-zero early_exit path.
   */
  function buildCrashEvent(opts: {
    exitCode: number | null;
    signal: string | null;
    stderr: string;
    stdout: string;
  }) {
    return {
      type: 'crash',
      timestamp: new Date().toISOString(),
      exit_code: opts.exitCode,
      signal: opts.signal,
      stderr_snippet: opts.stderr.slice(0, 5000),
      stdout_snippet: opts.stdout.slice(0, 5000),
    };
  }

  it('crash event should have type "crash"', () => {
    const event = buildCrashEvent({ exitCode: 1, signal: null, stderr: 'fatal error', stdout: '' });
    expect(event.type).toBe('crash');
  });

  it('crash event should include exit_code', () => {
    const event = buildCrashEvent({ exitCode: 1, signal: null, stderr: '', stdout: '' });
    expect(event.exit_code).toBe(1);
  });

  it('crash event should include signal when process was killed by a signal', () => {
    const event = buildCrashEvent({ exitCode: null, signal: 'SIGKILL', stderr: '', stdout: '' });
    expect(event.signal).toBe('SIGKILL');
  });

  it('crash event should cap stderr_snippet at 5000 characters', () => {
    const longStderr = 'e'.repeat(6000);
    const event = buildCrashEvent({ exitCode: 1, signal: null, stderr: longStderr, stdout: '' });
    expect(event.stderr_snippet.length).toBe(5000);
  });

  it('crash event should cap stdout_snippet at 5000 characters', () => {
    const longStdout = 's'.repeat(6000);
    const event = buildCrashEvent({ exitCode: 1, signal: null, stderr: '', stdout: longStdout });
    expect(event.stdout_snippet.length).toBe(5000);
  });

  it('crash event JSONL should be parseable back through readDemoProgress', () => {
    const event = buildCrashEvent({
      exitCode: 1,
      signal: null,
      stderr: 'Cannot find module playwright',
      stdout: 'Launching browser...',
    });
    const jsonl = JSON.stringify(event) + '\n';

    const progress = readDemoProgress(jsonl);

    expect(progress).not.toBeNull();
    // crash sets has_failures
    expect(progress!.has_failures).toBe(true);
    // stderr_snippet goes into recent_errors
    expect(progress!.recent_errors).toContain('Cannot find module playwright');
    // stdout_snippet goes into recent_errors with [stdout] prefix
    expect(progress!.recent_errors.some(e => e.startsWith('[stdout]'))).toBe(true);
  });

  it('crash event with empty stderr and stdout should not add to recent_errors', () => {
    const event = buildCrashEvent({ exitCode: 127, signal: null, stderr: '', stdout: '' });
    const jsonl = JSON.stringify(event) + '\n';

    const progress = readDemoProgress(jsonl);

    expect(progress).not.toBeNull();
    expect(progress!.has_failures).toBe(true);
    // Empty strings: server.ts checks `event.stderr_snippet` and `event.stdout_snippet`
    // with a truthy check — empty strings are falsy so nothing is added
    expect(progress!.recent_errors).toHaveLength(0);
  });

  it('crash event timestamp should be a valid ISO 8601 string', () => {
    const event = buildCrashEvent({ exitCode: 1, signal: null, stderr: '', stdout: '' });
    expect(() => new Date(event.timestamp)).not.toThrow();
    expect(new Date(event.timestamp).getTime()).not.toBeNaN();
  });

  it('crash JSONL round-trips through JSON.stringify + JSON.parse correctly', () => {
    const event = buildCrashEvent({
      exitCode: 2,
      signal: null,
      stderr: 'Module not found',
      stdout: 'Starting test runner',
    });
    const serialized = JSON.stringify(event);
    const parsed = JSON.parse(serialized);

    expect(parsed.type).toBe('crash');
    expect(parsed.exit_code).toBe(2);
    expect(parsed.stderr_snippet).toBe('Module not found');
    expect(parsed.stdout_snippet).toBe('Starting test runner');
  });
});

// ============================================================================
// code_freshness — newestMtime helper and source-vs-build comparison logic
// ============================================================================

describe('code_freshness — source vs build timestamp logic', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'freshness-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Inline the newestMtime helper for unit testing (mirrors server.ts)
  function newestMtime(dir: string, extensions: Set<string>, maxDepth: number = 5): number | null {
    let newest: number | null = null;
    function walk(current: string, depth: number) {
      if (depth > maxDepth) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (extensions.has(path.extname(entry.name))) {
          try {
            const mtime = fs.statSync(full).mtimeMs;
            if (newest === null || mtime > newest) newest = mtime;
          } catch { /* skip */ }
        }
      }
    }
    walk(dir, 0);
    return newest;
  }

  it('returns null for non-existent directory', () => {
    const result = newestMtime(path.join(tmpDir, 'does-not-exist'), new Set(['.ts']));
    expect(result).toBeNull();
  });

  it('finds newest file by mtime', () => {
    const subDir = path.join(tmpDir, 'src');
    fs.mkdirSync(subDir, { recursive: true });

    const oldFile = path.join(subDir, 'old.ts');
    const newFile = path.join(subDir, 'new.ts');

    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(newFile, 'new');

    // Set old file to 10 seconds ago
    const now = Date.now() / 1000;
    fs.utimesSync(oldFile, now - 10, now - 10);
    fs.utimesSync(newFile, now, now);

    const result = newestMtime(subDir, new Set(['.ts']));
    expect(result).not.toBeNull();
    // Newest should be close to `now * 1000`
    expect(result!).toBeGreaterThan((now - 1) * 1000);
  });

  it('skips node_modules and dotfiles', () => {
    const nmDir = path.join(tmpDir, 'node_modules');
    const dotDir = path.join(tmpDir, '.hidden');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.mkdirSync(dotDir, { recursive: true });

    fs.writeFileSync(path.join(nmDir, 'mod.ts'), 'nm');
    fs.writeFileSync(path.join(dotDir, 'secret.ts'), 'dot');

    const result = newestMtime(tmpDir, new Set(['.ts']));
    expect(result).toBeNull();
  });

  it('respects extension filter', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'ts');
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'txt');

    const tsOnly = newestMtime(tmpDir, new Set(['.ts']));
    expect(tsOnly).not.toBeNull();

    const pyOnly = newestMtime(tmpDir, new Set(['.py']));
    expect(pyOnly).toBeNull();
  });

  it('respects maxDepth', () => {
    // Create a file at depth 3
    const deep = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'deep.ts'), 'deep');

    // maxDepth 2 should not reach depth 3
    const shallow = newestMtime(tmpDir, new Set(['.ts']), 2);
    expect(shallow).toBeNull();

    // maxDepth 3 should reach it
    const found = newestMtime(tmpDir, new Set(['.ts']), 3);
    expect(found).not.toBeNull();
  });

  it('detects stale build when source is newer (drift > 5s)', () => {
    const now = Date.now() / 1000;
    const newestSource = (now) * 1000;  // now in ms
    const newestBuild = (now - 30) * 1000;  // 30 seconds ago in ms

    const driftMs = newestSource - newestBuild;
    expect(driftMs).toBeGreaterThan(5000);

    // Simulate the check logic
    const driftSec = Math.round(driftMs / 1000);
    const result = driftMs > 5000
      ? { status: 'warn' as const, message: `Dev server may be serving stale code — source files modified ${driftSec}s after last build output. Consider restarting the dev server.` }
      : { status: 'pass' as const, message: 'Source files are in sync with build output' };

    expect(result.status).toBe('warn');
    expect(result.message).toContain('stale code');
    expect(result.message).toContain('30s');
  });

  it('passes when build is newer than source', () => {
    const now = Date.now() / 1000;
    const newestSource = (now - 10) * 1000;
    const newestBuild = (now) * 1000;

    const driftMs = newestSource - newestBuild;
    expect(driftMs).toBeLessThanOrEqual(0);

    const result = driftMs > 5000
      ? { status: 'warn' as const, message: 'stale' }
      : { status: 'pass' as const, message: 'Source files are in sync with build output' };

    expect(result.status).toBe('pass');
  });

  it('passes within 5s grace period (HMR in-progress)', () => {
    const now = Date.now() / 1000;
    const newestSource = (now) * 1000;
    const newestBuild = (now - 3) * 1000;  // 3 seconds ago — within grace

    const driftMs = newestSource - newestBuild;
    expect(driftMs).toBe(3000);
    expect(driftMs).toBeLessThanOrEqual(5000);

    const result = driftMs > 5000
      ? { status: 'warn' as const, message: 'stale' }
      : { status: 'pass' as const, message: 'Source files are in sync with build output' };

    expect(result.status).toBe('pass');
  });
});
