/**
 * Tests for the Playwright trace parser module.
 *
 * Validates trace zip discovery, NDJSON parsing, action formatting,
 * noise filtering, and size capping without requiring real Playwright traces.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { findTraceZip, parseTraceZip, formatTrace, classifyAction, describeAction } from '../trace-parser.js';

let tempDir: string;

beforeEach(() => {
  tempDir = path.join(os.tmpdir(), `pw-trace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Helper: create a synthetic trace zip
// ============================================================================

function createTraceZip(dir: string, traceContent: string, subdir = 'test-result-0'): string {
  const resultDir = path.join(dir, subdir);
  fs.mkdirSync(resultDir, { recursive: true });

  // Write the trace NDJSON file
  const traceFile = path.join(resultDir, 'trace.trace');
  fs.writeFileSync(traceFile, traceContent);

  // Create the zip
  const zipPath = path.join(resultDir, 'trace.zip');
  execFileSync('zip', ['-j', zipPath, traceFile], {
    cwd: resultDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return zipPath;
}

function ndjson(...objects: Record<string, unknown>[]): string {
  return objects.map(o => JSON.stringify(o)).join('\n') + '\n';
}

// ============================================================================
// findTraceZip
// ============================================================================

describe('findTraceZip', () => {
  it('returns null for missing directory', () => {
    expect(findTraceZip('/tmp/nonexistent-dir-abc123')).toBeNull();
  });

  it('returns null for empty directory', () => {
    expect(findTraceZip(tempDir)).toBeNull();
  });

  it('returns null when no trace.zip exists', () => {
    const sub = path.join(tempDir, 'test-result-0');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'other.txt'), 'not a trace');
    expect(findTraceZip(tempDir)).toBeNull();
  });

  it('finds trace.zip in a subdirectory', () => {
    const sub = path.join(tempDir, 'test-result-0');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'trace.zip'), 'fake zip');
    expect(findTraceZip(tempDir)).toBe(path.join(sub, 'trace.zip'));
  });

  it('picks the most recently modified trace.zip', () => {
    // Create two trace zips with different mtimes
    const sub1 = path.join(tempDir, 'test-result-old');
    const sub2 = path.join(tempDir, 'test-result-new');
    fs.mkdirSync(sub1, { recursive: true });
    fs.mkdirSync(sub2, { recursive: true });

    fs.writeFileSync(path.join(sub1, 'trace.zip'), 'old');
    // Set old mtime
    const oldTime = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(sub1, 'trace.zip'), oldTime, oldTime);

    fs.writeFileSync(path.join(sub2, 'trace.zip'), 'new');

    expect(findTraceZip(tempDir)).toBe(path.join(sub2, 'trace.zip'));
  });

  it('finds trace.zip at depth 2', () => {
    const deep = path.join(tempDir, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'trace.zip'), 'deep zip');
    expect(findTraceZip(tempDir)).toBe(path.join(deep, 'trace.zip'));
  });
});

// ============================================================================
// parseTraceZip
// ============================================================================

describe('parseTraceZip', () => {
  it('returns null for missing file', () => {
    expect(parseTraceZip('/tmp/nonexistent-trace.zip')).toBeNull();
  });

  it('returns null for invalid zip', () => {
    const fakePath = path.join(tempDir, 'fake.zip');
    fs.writeFileSync(fakePath, 'not a zip file');
    expect(parseTraceZip(fakePath)).toBeNull();
  });

  it('returns null for zip without .trace files', () => {
    const otherFile = path.join(tempDir, 'other.txt');
    fs.writeFileSync(otherFile, 'not a trace');
    const zipPath = path.join(tempDir, 'empty.zip');
    execFileSync('zip', ['-j', zipPath, otherFile], { stdio: ['pipe', 'pipe', 'pipe'] });
    expect(parseTraceZip(zipPath)).toBeNull();
  });

  it('parses a trace zip with action events', () => {
    const content = ndjson(
      { type: 'before', callId: 'c1', method: 'goto', class: 'Page', params: { url: 'http://localhost:3000' }, wallTime: 1000 },
      { type: 'after', callId: 'c1', wallTime: 1200 },
      { type: 'before', callId: 'c2', method: 'click', class: 'Locator', selector: '[data-testid="login"]', wallTime: 1500 },
      { type: 'after', callId: 'c2', wallTime: 1700 },
    );

    const zipPath = createTraceZip(tempDir, content);
    const result = parseTraceZip(zipPath);

    expect(result).not.toBeNull();
    expect(result).toContain('DEMO PLAY-BY-PLAY TRACE');
    expect(result).toContain('Navigate to http://localhost:3000');
    expect(result).toContain('Click [data-testid="login"]');
    expect(result).toContain('END TRACE');
  });

  it('parses combined action events', () => {
    const content = ndjson(
      { type: 'action', method: 'fill', class: 'Locator', selector: '#name', params: { value: 'John Doe' }, wallTime: 2000 },
    );

    const zipPath = createTraceZip(tempDir, content);
    const result = parseTraceZip(zipPath);

    expect(result).not.toBeNull();
    expect(result).toContain('Fill #name');
    expect(result).toContain('John Doe');
  });

  it('captures console messages', () => {
    const content = ndjson(
      { type: 'console', params: { type: 'log', text: 'Dashboard loaded' }, wallTime: 3000 },
      { type: 'console', params: { type: 'error', text: 'Failed to fetch pricing' }, wallTime: 3500 },
    );

    const zipPath = createTraceZip(tempDir, content);
    const result = parseTraceZip(zipPath);

    expect(result).not.toBeNull();
    expect(result).toContain('Console log: Dashboard loaded');
    expect(result).toContain('Console error: Failed to fetch pricing');
  });

  it('captures errors', () => {
    const content = ndjson(
      { type: 'error', error: { message: 'TypeError: Cannot read properties of undefined' }, wallTime: 4000 },
    );

    const zipPath = createTraceZip(tempDir, content);
    const result = parseTraceZip(zipPath);

    expect(result).not.toBeNull();
    expect(result).toContain('Uncaught: TypeError: Cannot read properties of undefined');
  });

  it('respects size cap', () => {
    // Create many events to exceed cap
    const events: Record<string, unknown>[] = [];
    for (let i = 0; i < 500; i++) {
      events.push({
        type: 'before',
        callId: `c${i}`,
        method: 'click',
        class: 'Locator',
        selector: `[data-testid="button-${i}-with-a-very-long-selector-name-that-pads-out-the-line"]`,
        wallTime: 1000 + i * 100,
      });
    }

    const content = ndjson(...events);
    const zipPath = createTraceZip(tempDir, content);
    // Use small cap to force truncation
    const result = parseTraceZip(zipPath, 2000);

    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(2200); // Some slack for header/footer
    expect(result).toContain('more events truncated');
  });
});

// ============================================================================
// formatTrace
// ============================================================================

describe('formatTrace', () => {
  it('returns null for empty events', () => {
    expect(formatTrace([])).toBeNull();
  });

  it('filters out BrowserContext setup noise', () => {
    const events = [
      { type: 'before', callId: 'c1', method: 'newPage', class: 'BrowserContext', wallTime: 1000 },
      { type: 'before', callId: 'c2', method: 'click', class: 'Locator', selector: '#btn', wallTime: 2000 },
    ];
    const result = formatTrace(events as any);
    expect(result).not.toBeNull();
    expect(result).not.toContain('newPage');
    expect(result).toContain('Click #btn');
  });

  it('filters out waitForLoadState noise', () => {
    const events = [
      { type: 'before', callId: 'c1', method: 'waitForLoadState', class: 'Page', wallTime: 1000 },
      { type: 'before', callId: 'c2', method: 'hover', class: 'Locator', selector: 'nav', wallTime: 2000 },
    ];
    const result = formatTrace(events as any);
    expect(result).not.toBeNull();
    expect(result).not.toContain('waitForLoadState');
    expect(result).toContain('Hover nav');
  });

  it('filters out evaluate and screenshot actions', () => {
    const events = [
      { type: 'before', callId: 'c1', method: 'evaluate', class: 'Page', wallTime: 1000 },
      { type: 'before', callId: 'c2', method: 'screenshot', class: 'Page', wallTime: 1500 },
      { type: 'before', callId: 'c3', method: 'press', class: 'Locator', selector: '#input', params: { key: 'Enter' }, wallTime: 2000 },
    ];
    const result = formatTrace(events as any);
    expect(result).not.toBeNull();
    expect(result).not.toContain('evaluate');
    expect(result).not.toContain('screenshot');
    expect(result).toContain('Press Enter on #input');
  });

  it('handles navigation events', () => {
    const events = [
      { type: 'event', method: 'navigatedTo', params: { url: 'http://localhost:3000/dashboard' }, wallTime: 1500 },
    ];
    const result = formatTrace(events as any);
    expect(result).not.toBeNull();
    expect(result).toContain('NAV');
    expect(result).toContain('http://localhost:3000/dashboard');
  });

  it('sorts events by timestamp', () => {
    const events = [
      { type: 'before', callId: 'c2', method: 'click', class: 'Locator', selector: '#second', wallTime: 2000 },
      { type: 'before', callId: 'c1', method: 'goto', class: 'Page', params: { url: 'http://localhost:3000' }, wallTime: 1000 },
    ];
    const result = formatTrace(events as any);
    expect(result).not.toBeNull();
    const lines = result!.split('\n');
    const gotoIdx = lines.findIndex(l => l.includes('Navigate'));
    const clickIdx = lines.findIndex(l => l.includes('Click'));
    expect(gotoIdx).toBeLessThan(clickIdx);
  });

  it('shows total event count in header', () => {
    const events = [
      { type: 'before', callId: 'c1', method: 'click', class: 'Locator', selector: '#a', wallTime: 1000 },
      { type: 'before', callId: 'c2', method: 'click', class: 'Locator', selector: '#b', wallTime: 2000 },
      { type: 'before', callId: 'c3', method: 'click', class: 'Locator', selector: '#c', wallTime: 3000 },
    ];
    const result = formatTrace(events as any);
    expect(result).toContain('Total events: 3');
  });
});

// ============================================================================
// classifyAction
// ============================================================================

describe('classifyAction', () => {
  it('classifies goto as NAV', () => {
    expect(classifyAction('goto')).toBe('NAV');
  });

  it('classifies navigate as NAV', () => {
    expect(classifyAction('navigate')).toBe('NAV');
  });

  it('classifies fill as INPUT', () => {
    expect(classifyAction('fill')).toBe('INPUT');
  });

  it('classifies type as INPUT', () => {
    expect(classifyAction('type')).toBe('INPUT');
  });

  it('classifies selectOption as INPUT', () => {
    expect(classifyAction('selectOption')).toBe('INPUT');
  });

  it('classifies check/uncheck as INPUT', () => {
    expect(classifyAction('check')).toBe('INPUT');
    expect(classifyAction('uncheck')).toBe('INPUT');
  });

  it('classifies expect as ASSERT', () => {
    expect(classifyAction('expect')).toBe('ASSERT');
    expect(classifyAction('expect.toBeVisible')).toBe('ASSERT');
  });

  it('classifies click as ACTION', () => {
    expect(classifyAction('click')).toBe('ACTION');
  });

  it('classifies hover as ACTION', () => {
    expect(classifyAction('hover')).toBe('ACTION');
  });
});

// ============================================================================
// describeAction
// ============================================================================

describe('describeAction', () => {
  it('describes goto with URL', () => {
    const ev = { type: 'before', method: 'goto', params: { url: 'http://localhost:3000' } } as any;
    expect(describeAction(ev, 'goto')).toBe('Navigate to http://localhost:3000');
  });

  it('describes fill with selector and value', () => {
    const ev = { type: 'before', method: 'fill', selector: '#name', params: { value: 'Jane Doe' } } as any;
    expect(describeAction(ev, 'fill')).toBe('Fill #name with "Jane Doe"');
  });

  it('masks password-like values in fill', () => {
    const ev = { type: 'before', method: 'fill', selector: '#password', params: { value: 'P@ssw0rd!' } } as any;
    expect(describeAction(ev, 'fill')).toBe('Fill #password with "********"');
  });

  it('does not mask plain text values', () => {
    const ev = { type: 'before', method: 'fill', selector: '#name', params: { value: 'hello' } } as any;
    expect(describeAction(ev, 'fill')).toBe('Fill #name with "hello"');
  });

  it('masks values in password selectors regardless of value content', () => {
    const ev = { type: 'before', method: 'fill', selector: '[data-testid="password"]', params: { value: 'simple' } } as any;
    expect(describeAction(ev, 'fill')).toBe('Fill [data-testid="password"] with "********"');
  });

  it('masks values in token/secret/api-key selectors', () => {
    const ev1 = { type: 'before', method: 'fill', selector: '#api-key', params: { value: 'abc123' } } as any;
    expect(describeAction(ev1, 'fill')).toBe('Fill #api-key with "********"');
    const ev2 = { type: 'before', method: 'fill', selector: '#secret-field', params: { value: 'data' } } as any;
    expect(describeAction(ev2, 'fill')).toBe('Fill #secret-field with "********"');
  });

  it('describes click with selector', () => {
    const ev = { type: 'before', method: 'click', selector: '[data-testid="submit"]' } as any;
    expect(describeAction(ev, 'click')).toBe('Click [data-testid="submit"]');
  });

  it('describes hover', () => {
    const ev = { type: 'before', method: 'hover', selector: 'nav >> text=Settings' } as any;
    expect(describeAction(ev, 'hover')).toBe('Hover nav >> text=Settings');
  });

  it('describes press with key', () => {
    const ev = { type: 'before', method: 'press', selector: '#input', params: { key: 'Enter' } } as any;
    expect(describeAction(ev, 'press')).toBe('Press Enter on #input');
  });

  it('describes check/uncheck', () => {
    const ev1 = { type: 'before', method: 'check', selector: '#agree' } as any;
    expect(describeAction(ev1, 'check')).toBe('Check #agree');
    const ev2 = { type: 'before', method: 'uncheck', selector: '#agree' } as any;
    expect(describeAction(ev2, 'uncheck')).toBe('Uncheck #agree');
  });

  it('describes expect assertions', () => {
    const ev = { type: 'before', method: 'expect.toBeVisible', selector: '#header' } as any;
    expect(describeAction(ev, 'expect.toBeVisible')).toBe('Assert expect.toBeVisible on #header');
  });

  it('falls back to method name for unknown actions', () => {
    const ev = { type: 'before', method: 'customAction', selector: '#thing' } as any;
    expect(describeAction(ev, 'customAction')).toBe('customAction #thing');
  });
});
