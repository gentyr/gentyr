/**
 * Playwright trace zip parser for demo play-by-play summaries.
 *
 * Extracts human-readable action logs from Playwright's built-in trace format
 * (produced by `--trace on`). Trace zips contain NDJSON `.trace` files with
 * structured event records for every Playwright API call, navigation, console
 * message, and error.
 *
 * @see https://playwright.dev/docs/trace-viewer
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

// ============================================================================
// Constants
// ============================================================================

const MAX_SUMMARY_BYTES = 50 * 1024; // 50KB cap on output
const MAX_TRACE_FILE_BYTES = 20 * 1024 * 1024; // 20MB cap on input trace files

/** Actions that are internal noise — not useful in a play-by-play */
const SKIPPED_METHODS = new Set([
  'waitForEvent',
  'waitForLoadState',
  'waitForTimeout',
  'waitForSelector',
  'waitForFunction',
  'waitForURL',
  'evaluate',
  'evaluateHandle',
  'screenshot',
  'close',
  'addInitScript',
  'exposeFunction',
  'exposeBinding',
  'setExtraHTTPHeaders',
  'setViewportSize',
  'setDefaultTimeout',
  'setDefaultNavigationTimeout',
]);

/** Class-level actions that are setup noise */
const SKIPPED_CLASSES = new Set([
  'BrowserContext',
  'Browser',
  'BrowserType',
  'Tracing',
  'APIRequestContext',
]);

// ============================================================================
// Public API
// ============================================================================

/**
 * Find the most recent trace.zip in a Playwright test-results directory.
 * Scans subdirectories (Playwright creates per-test subdirs in test-results/).
 */
export function findTraceZip(testResultsDir: string): string | null {
  if (!fs.existsSync(testResultsDir)) return null;

  let newest: { path: string; mtime: number } | null = null;

  try {
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return; // Don't recurse too deep
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.name === 'trace.zip') {
          const stat = fs.statSync(full);
          if (!newest || stat.mtimeMs > newest.mtime) {
            newest = { path: full, mtime: stat.mtimeMs };
          }
        }
      }
    };
    walk(testResultsDir, 0);
  } catch {
    return null;
  }

  return newest ? (newest as { path: string; mtime: number }).path : null;
}

/**
 * Parse a Playwright trace zip and produce a human-readable play-by-play summary.
 *
 * Extracts `.trace` NDJSON files from the zip, parses events, and formats
 * them as timestamped action lines.
 *
 * Returns null on any failure (graceful degradation).
 */
export function parseTraceZip(traceZipPath: string, maxBytes: number = MAX_SUMMARY_BYTES): string | null {
  let tmpDir: string | null = null;

  try {
    // Create temp directory for extraction
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-trace-'));

    // Extract *.trace files from the zip
    try {
      execFileSync('unzip', ['-o', '-j', traceZipPath, '*.trace', '-d', tmpDir], {
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return null;
    }

    // Find extracted trace files
    const traceFiles = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.trace'))
      .map(f => path.join(tmpDir!, f));

    if (traceFiles.length === 0) return null;

    // Parse all trace events
    const events: TraceEvent[] = [];
    for (const traceFile of traceFiles) {
      // Size check before reading to prevent OOM from zip bombs or huge traces
      const fileSize = fs.statSync(traceFile).size;
      if (fileSize > MAX_TRACE_FILE_BYTES) continue;

      const content = fs.readFileSync(traceFile, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object' && parsed.type) {
            events.push(parsed as TraceEvent);
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    if (events.length === 0) return null;

    return formatTrace(events, maxBytes);
  } catch {
    return null;
  } finally {
    // Clean up temp directory
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Non-fatal cleanup failure
      }
    }
  }
}

// ============================================================================
// Internal Types
// ============================================================================

interface TraceEvent {
  type: string;
  callId?: string;
  method?: string;
  class?: string;
  params?: Record<string, unknown>;
  time?: number;
  startTime?: number;
  endTime?: number;
  wallTime?: number;
  point?: { x?: number; y?: number };
  selector?: string;
  url?: string;
  value?: string;
  text?: string;
  message?: string;
  error?: { message?: string; name?: string };
  apiName?: string;
  log?: string[];
}

interface FormattedLine {
  timeMs: number;
  category: string;
  text: string;
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format parsed trace events into a timestamped play-by-play summary.
 */
export function formatTrace(events: TraceEvent[], maxBytes: number = MAX_SUMMARY_BYTES): string | null {
  // Find the earliest timestamp to compute relative times
  let baseTime = Infinity;
  for (const ev of events) {
    const t = ev.wallTime || ev.startTime || ev.time || 0;
    if (t > 0 && t < baseTime) baseTime = t;
  }
  if (baseTime === Infinity) baseTime = 0;

  // Correlate before/after events by callId
  const callMap = new Map<string, { before?: TraceEvent; after?: TraceEvent }>();

  const lines: FormattedLine[] = [];

  for (const ev of events) {
    // Handle split format: before/after events keyed by callId
    if ((ev.type === 'before' || ev.type === 'after') && ev.callId) {
      let entry = callMap.get(ev.callId);
      if (!entry) {
        entry = {};
        callMap.set(ev.callId, entry);
      }
      if (ev.type === 'before') {
        entry.before = ev;
        // Format from the 'before' event (action start)
        const line = formatActionEvent(ev, baseTime);
        if (line) lines.push(line);
      } else {
        entry.after = ev;
      }
      continue;
    }

    // Handle combined 'action' events
    if (ev.type === 'action') {
      const line = formatActionEvent(ev, baseTime);
      if (line) lines.push(line);
      continue;
    }

    // Handle navigation events
    if (ev.type === 'event' && ev.method === 'navigatedTo') {
      const timeMs = getRelativeTime(ev, baseTime);
      const url = ev.params?.url || ev.url || '';
      if (url) {
        lines.push({ timeMs, category: 'NAV', text: `Navigation: ${url}` });
      }
      continue;
    }

    // Handle console messages
    if (ev.type === 'console') {
      const timeMs = getRelativeTime(ev, baseTime);
      const msgType = (ev.params?.type as string) || 'log';
      const msgText = truncateText(
        String(ev.params?.text || ev.text || ev.message || ''),
        200
      );
      if (msgText) {
        const cat = msgType === 'error' ? 'ERROR' : 'LOG';
        lines.push({ timeMs, category: cat, text: `Console ${msgType}: ${msgText}` });
      }
      continue;
    }

    // Handle page errors
    if (ev.type === 'error' || (ev.type === 'event' && ev.method === 'pageerror')) {
      const timeMs = getRelativeTime(ev, baseTime);
      const paramsError = ev.params?.error as Record<string, unknown> | undefined;
      const errMsg = truncateText(
        String(ev.error?.message || paramsError?.message || ev.message || 'Unknown error'),
        300
      );
      lines.push({ timeMs, category: 'ERROR', text: `Uncaught: ${errMsg}` });
      continue;
    }
  }

  if (lines.length === 0) return null;

  // Sort by timestamp
  lines.sort((a, b) => a.timeMs - b.timeMs);

  // Build output with size cap
  const header = `=== DEMO PLAY-BY-PLAY TRACE ===\nTotal events: ${lines.length}\n\n`;
  const footer = '\n=== END TRACE ===';
  const budget = maxBytes - header.length - footer.length;

  let output = '';
  let truncated = false;
  for (const line of lines) {
    const formatted = formatLine(line);
    if (output.length + formatted.length + 1 > budget) {
      truncated = true;
      break;
    }
    output += formatted + '\n';
  }

  if (truncated) {
    output += `... (${lines.length - output.split('\n').length + 1} more events truncated)\n`;
  }

  return header + output + footer;
}

// ============================================================================
// Helpers
// ============================================================================

function formatActionEvent(ev: TraceEvent, baseTime: number): FormattedLine | null {
  const className = ev.class || '';
  const method = ev.method || ev.apiName || '';

  // Skip noise
  if (SKIPPED_CLASSES.has(className)) return null;
  if (SKIPPED_METHODS.has(method)) return null;

  const timeMs = getRelativeTime(ev, baseTime);

  // Determine category
  const category = classifyAction(method);

  // Build description
  const text = describeAction(ev, method);
  if (!text) return null;

  return { timeMs, category, text };
}

/**
 * Classify an action method into a display category.
 */
export function classifyAction(method: string): string {
  if (method === 'goto' || method === 'navigate') return 'NAV';
  if (method === 'fill' || method === 'type' || method === 'selectOption' || method === 'check' || method === 'uncheck' || method === 'setInputFiles') return 'INPUT';
  if (method === 'expect' || method.startsWith('expect.')) return 'ASSERT';
  return 'ACTION';
}

/**
 * Build a human-readable description of an action event.
 */
export function describeAction(ev: TraceEvent, method: string): string {
  const selector = ev.selector || ev.params?.selector as string || '';

  switch (method) {
    case 'goto':
      return `Navigate to ${ev.params?.url || ev.url || 'unknown'}`;
    case 'fill':
      return `Fill ${selector} with "${maskSensitive(String(ev.params?.value || ev.value || ''), selector)}"`;
    case 'type':
      return `Type "${maskSensitive(String(ev.params?.text || ev.text || ''), selector)}" into ${selector}`;
    case 'click':
    case 'dblclick':
      return `${capitalize(method)} ${selector}`;
    case 'hover':
      return `Hover ${selector}`;
    case 'press':
      return `Press ${ev.params?.key || ''} on ${selector}`;
    case 'check':
      return `Check ${selector}`;
    case 'uncheck':
      return `Uncheck ${selector}`;
    case 'selectOption':
      return `Select option in ${selector}`;
    case 'setInputFiles':
      return `Upload file(s) to ${selector}`;
    case 'focus':
      return `Focus ${selector}`;
    case 'tap':
      return `Tap ${selector}`;
    case 'dispatchEvent':
      return `Dispatch ${ev.params?.type || 'event'} on ${selector}`;
    default:
      if (method.startsWith('expect')) {
        return `Assert ${method} on ${selector || 'page'}`;
      }
      return selector ? `${method} ${selector}` : method;
  }
}

function getRelativeTime(ev: TraceEvent, baseTime: number): number {
  const t = ev.wallTime || ev.startTime || ev.time || baseTime;
  return t - baseTime;
}

function formatLine(line: FormattedLine): string {
  const secs = (line.timeMs / 1000).toFixed(1);
  const pad = secs.length < 6 ? ' '.repeat(6 - secs.length) : '';
  return `[${pad}${secs}s] ${line.category.padEnd(6)} ${line.text}`;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

/** Selector substrings that indicate a sensitive field */
const SENSITIVE_SELECTOR_PATTERNS = /password|passwd|secret|token|api.?key|credential|auth|ssn|credit.?card/i;

/**
 * Mask potentially sensitive input values (passwords, tokens).
 * Uses both selector-based heuristic and value-based heuristic.
 */
function maskSensitive(value: string, selector?: string): string {
  // Selector-based: if the selector references a sensitive field, always mask
  if (selector && SENSITIVE_SELECTOR_PATTERNS.test(selector)) {
    return '********';
  }
  // Value-based: if value has mixed alphanumeric + special chars without spaces, mask it
  if (value.length > 4 && !value.includes(' ') && /[a-zA-Z]/.test(value) && /\d|[!@#$%^&*]/.test(value)) {
    return '********';
  }
  return value;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
