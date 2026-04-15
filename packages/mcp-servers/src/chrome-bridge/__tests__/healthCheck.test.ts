/**
 * Unit tests for chrome-bridge health check diagnostics:
 * - runConnectionDiagnostics()   filesystem-based connection checks (mocked fs)
 * - handleHealthCheck()          output structure (JSON text content, isError flag)
 * - SERVER_SIDE_TOOLS membership health_check appears in the dispatch set
 *
 * Strategy: runConnectionDiagnostics() is the most testable piece — it performs
 * pure filesystem checks that can be validated by structure without a live Chrome
 * connection. We mirror the function's internal logic into a testable harness that
 * accepts injected fs-operation callbacks, bypassing the real `fs` module.
 *
 * handleHealthCheck() depends on both runConnectionDiagnostics() AND the live
 * Chrome socket client. We test only the output-shaping logic: given a DiagnosticResult,
 * does it produce the correct JSON content structure and isError flag?
 *
 * Critical: These tests validate structure, not performance.
 * Graceful fallbacks are NOT allowed — errors must be surfaced via isError: true.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { McpContent } from '../types.js';

// ============================================================================
// Shared types (mirror server.ts)
// ============================================================================

interface DiagnosticCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

interface DiagnosticResult {
  healthy: boolean;
  checks: DiagnosticCheck[];
  remediation: string[];
}

type ToolResult = { content: McpContent[]; isError?: boolean };

// ============================================================================
// Testable harness for runConnectionDiagnostics()
//
// The real function calls fs.existsSync, fs.readFileSync, fs.readdirSync,
// fs.accessSync, fs.unlinkSync, and process.kill. We extract the same
// decision logic into a function that accepts injected callbacks so we can
// exercise every branch without touching the filesystem.
// ============================================================================

interface FsOps {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  readdirSync: (p: string) => string[];
  accessSync: (p: string) => void; // throws if not executable
  unlinkSync: (p: string) => void;
  kill: (pid: number, signal: number) => void; // throws if process dead
}

/**
 * Pure testable implementation of runConnectionDiagnostics().
 * Mirrors the exact branch structure from server.ts ~lines 1581–1671.
 * All filesystem/process calls are injected via `ops`.
 */
function runDiagnostics(socketDir: string, manifestPath: string, ops: FsOps): DiagnosticResult {
  const checks: DiagnosticCheck[] = [];
  const remediation: string[] = [];
  const installHint = 'Run: tools/chrome-extension/native-host/install.sh';
  const loadExtHint =
    'Load the Gentyr extension in Chrome: chrome://extensions -> Developer Mode -> Load Unpacked -> <path-to-gentyr>/tools/chrome-extension/extension/';

  // Check 1: Native messaging manifest
  if (!ops.existsSync(manifestPath)) {
    checks.push({ name: 'Native manifest', ok: false, detail: `Not found: ${manifestPath}` });
    remediation.push(installHint);
    return { healthy: false, checks, remediation };
  }
  checks.push({ name: 'Native manifest', ok: true, detail: manifestPath });

  // Check 2: Host launch script from manifest
  let launchScriptPath: string | undefined;
  try {
    const manifest = JSON.parse(ops.readFileSync(manifestPath));
    launchScriptPath = manifest.path;
    if (!launchScriptPath || !ops.existsSync(launchScriptPath)) {
      checks.push({
        name: 'Host launch script',
        ok: false,
        detail: `Not found: ${launchScriptPath || '(empty path in manifest)'}`,
      });
      remediation.push(installHint);
      return { healthy: false, checks, remediation };
    }
    try {
      ops.accessSync(launchScriptPath);
    } catch {
      checks.push({
        name: 'Host launch script',
        ok: false,
        detail: `Not executable: ${launchScriptPath}`,
      });
      remediation.push(`Run: chmod +x ${launchScriptPath}`);
      return { healthy: false, checks, remediation };
    }
    checks.push({ name: 'Host launch script', ok: true, detail: launchScriptPath });
  } catch (err) {
    checks.push({
      name: 'Host launch script',
      ok: false,
      detail: `Failed to parse manifest: ${err instanceof Error ? err.message : String(err)}`,
    });
    remediation.push(installHint);
    return { healthy: false, checks, remediation };
  }

  // Check 3: Socket directory
  if (!ops.existsSync(socketDir)) {
    checks.push({ name: 'Socket directory', ok: false, detail: `Not found: ${socketDir}` });
    remediation.push(
      `Native host has never started successfully. ${loadExtHint}, then reload any tab.`,
    );
    return { healthy: false, checks, remediation };
  }
  checks.push({ name: 'Socket directory', ok: true, detail: socketDir });

  // Check 4: Live sockets with valid PIDs
  let socketFiles: string[];
  try {
    socketFiles = ops.readdirSync(socketDir).filter((f) => f.endsWith('.sock'));
  } catch {
    socketFiles = [];
  }

  if (socketFiles.length === 0) {
    checks.push({ name: 'Live sockets', ok: false, detail: 'No socket files in directory' });
    remediation.push(
      `No native host sockets found. ${loadExtHint}, then reload any tab to trigger native host connection.`,
    );
    return { healthy: false, checks, remediation };
  }

  const livePids: number[] = [];
  const staleSockets: string[] = [];
  for (const file of socketFiles) {
    const pidMatch = file.match(/^(\d+)\.sock$/);
    if (!pidMatch) continue;
    const pid = parseInt(pidMatch[1], 10);
    try {
      ops.kill(pid, 0);
      livePids.push(pid);
    } catch {
      staleSockets.push(file);
      try {
        ops.unlinkSync(`${socketDir}/${file}`);
      } catch { /* ignore */ }
    }
  }

  if (livePids.length === 0) {
    const cleanedNote =
      staleSockets.length > 0 ? ` (${staleSockets.length} stale socket(s) cleaned)` : '';
    checks.push({
      name: 'Live sockets',
      ok: false,
      detail: `No live native host processes${cleanedNote}`,
    });
    remediation.push(
      `Native host processes have exited. Reload the Gentyr extension in Chrome (chrome://extensions -> click reload icon) or reload any tab.`,
    );
    return { healthy: false, checks, remediation };
  }

  checks.push({
    name: 'Live sockets',
    ok: true,
    detail: `${livePids.length} live (PID: ${livePids.join(', ')})${staleSockets.length > 0 ? `, ${staleSockets.length} stale cleaned` : ''}`,
  });

  return { healthy: true, checks, remediation };
}

// ============================================================================
// handleHealthCheck output shaping
//
// The real handleHealthCheck() calls client.executeTool() which requires a live
// socket. We test only the pure output-shaping logic: given a DiagnosticResult,
// does the function produce the correct JSON content and isError flag?
// ============================================================================

/**
 * Mirrors the output-shaping block of handleHealthCheck() (server.ts ~lines 1697–1706).
 * This portion is pure — no I/O — and can be tested directly.
 */
function shapeHealthCheckOutput(diag: DiagnosticResult): ToolResult {
  const output = {
    healthy: diag.healthy,
    checks: Object.fromEntries(
      diag.checks.map((c) => [c.name, { ok: c.ok, ...(c.detail ? { detail: c.detail } : {}) }]),
    ),
    ...(diag.remediation.length > 0 ? { remediation: diag.remediation } : {}),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    isError: !diag.healthy,
  };
}

// ============================================================================
// Fixtures
// ============================================================================

const SOCKET_DIR = '/tmp/claude-mcp-browser-bridge-testuser';
const MANIFEST_PATH =
  '/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.gentyr.chrome_browser_extension.json';
const LAUNCH_SCRIPT = '/usr/local/bin/gentyr-native-host.sh';

/** Builds a minimal passing FsOps where all checks succeed */
function passingOps(livePidSockets: string[] = ['12345.sock']): FsOps {
  return {
    existsSync: (p) => {
      if (p === MANIFEST_PATH) return true;
      if (p === LAUNCH_SCRIPT) return true;
      if (p === SOCKET_DIR) return true;
      return false;
    },
    readFileSync: (_p) => JSON.stringify({ path: LAUNCH_SCRIPT }),
    readdirSync: (_p) => livePidSockets,
    accessSync: (_p) => { /* executable — no throw */ },
    unlinkSync: (_p) => { /* no-op */ },
    kill: (_pid, _sig) => { /* alive — no throw */ },
  };
}

// ============================================================================
// Tests: DiagnosticResult structure
// ============================================================================

describe('runConnectionDiagnostics() — DiagnosticResult structure', () => {
  it('should return an object with healthy boolean, checks array, and remediation array', () => {
    const ops = passingOps();
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);

    expect(typeof result.healthy).toBe('boolean');
    expect(Array.isArray(result.checks)).toBe(true);
    expect(Array.isArray(result.remediation)).toBe(true);
  });

  it('should return healthy: true when all checks pass', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, passingOps());
    expect(result.healthy).toBe(true);
  });

  it('should return an empty remediation array when healthy', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, passingOps());
    expect(result.remediation).toHaveLength(0);
  });

  it('should return all 4 checks when healthy', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, passingOps());
    expect(result.checks).toHaveLength(4);
  });

  it('should mark all checks ok: true when healthy', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, passingOps());
    for (const check of result.checks) {
      expect(check.ok).toBe(true);
    }
  });

  it('should include name, ok, and detail on each check', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, passingOps());
    for (const check of result.checks) {
      expect(typeof check.name).toBe('string');
      expect(check.name.length).toBeGreaterThan(0);
      expect(typeof check.ok).toBe('boolean');
      // detail is optional but present on all passing checks
      if (check.detail !== undefined) {
        expect(typeof check.detail).toBe('string');
      }
    }
  });
});

// ============================================================================
// Tests: Check ordering
// ============================================================================

describe('runConnectionDiagnostics() — check ordering', () => {
  it('should put Native manifest first', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, passingOps());
    expect(result.checks[0].name).toBe('Native manifest');
  });

  it('should put Host launch script second', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, passingOps());
    expect(result.checks[1].name).toBe('Host launch script');
  });

  it('should put Socket directory third', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, passingOps());
    expect(result.checks[2].name).toBe('Socket directory');
  });

  it('should put Live sockets fourth', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, passingOps());
    expect(result.checks[3].name).toBe('Live sockets');
  });
});

// ============================================================================
// Tests: Short-circuit behavior — native manifest missing
// ============================================================================

describe('runConnectionDiagnostics() — short-circuit: native manifest missing', () => {
  let ops: FsOps;

  beforeEach(() => {
    ops = passingOps();
    ops.existsSync = (p) => p !== MANIFEST_PATH; // manifest absent; everything else present
  });

  it('should return healthy: false', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(false);
  });

  it('should return exactly 1 check', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.checks).toHaveLength(1);
  });

  it('should mark the manifest check as not ok', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.checks[0].ok).toBe(false);
  });

  it('should include the manifest path in the detail', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.checks[0].detail).toContain(MANIFEST_PATH);
  });

  it('should include at least one remediation step', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.remediation.length).toBeGreaterThan(0);
  });

  it('should recommend running install.sh', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.remediation.some((r) => r.includes('install.sh'))).toBe(true);
  });

  it('should NOT include downstream checks (host script, socket dir, live sockets)', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    const names = result.checks.map((c) => c.name);
    expect(names).not.toContain('Host launch script');
    expect(names).not.toContain('Socket directory');
    expect(names).not.toContain('Live sockets');
  });
});

// ============================================================================
// Tests: Short-circuit behavior — launch script missing
// ============================================================================

describe('runConnectionDiagnostics() — short-circuit: launch script not found', () => {
  let ops: FsOps;

  beforeEach(() => {
    ops = passingOps();
    // manifest exists; launch script does NOT exist; everything else present
    const originalExistsSync = ops.existsSync;
    ops.existsSync = (p) => p !== LAUNCH_SCRIPT && originalExistsSync(p);
  });

  it('should return healthy: false', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(false);
  });

  it('should return exactly 2 checks (manifest pass + script fail)', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.checks).toHaveLength(2);
  });

  it('should mark Native manifest ok: true', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.checks[0].ok).toBe(true);
  });

  it('should mark Host launch script ok: false', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.checks[1].ok).toBe(false);
  });

  it('should include the launch script path in the detail', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.checks[1].detail).toContain(LAUNCH_SCRIPT);
  });

  it('should recommend running install.sh', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.remediation.some((r) => r.includes('install.sh'))).toBe(true);
  });

  it('should NOT include socket directory or live socket checks', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    const names = result.checks.map((c) => c.name);
    expect(names).not.toContain('Socket directory');
    expect(names).not.toContain('Live sockets');
  });
});

// ============================================================================
// Tests: Short-circuit behavior — launch script not executable
// ============================================================================

describe('runConnectionDiagnostics() — short-circuit: launch script not executable', () => {
  let ops: FsOps;

  beforeEach(() => {
    ops = passingOps();
    ops.accessSync = (_p) => {
      throw new Error('EACCES');
    };
  });

  it('should return healthy: false', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(false);
  });

  it('should mark Host launch script ok: false', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    const scriptCheck = result.checks.find((c) => c.name === 'Host launch script');
    expect(scriptCheck?.ok).toBe(false);
  });

  it('should include "Not executable" in the detail', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    const scriptCheck = result.checks.find((c) => c.name === 'Host launch script');
    expect(scriptCheck?.detail).toContain('Not executable');
  });

  it('should recommend chmod +x in remediation', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.remediation.some((r) => r.includes('chmod +x'))).toBe(true);
  });

  it('should include the script path in the chmod remediation', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    const chmodStep = result.remediation.find((r) => r.includes('chmod +x'));
    expect(chmodStep).toContain(LAUNCH_SCRIPT);
  });
});

// ============================================================================
// Tests: Short-circuit behavior — malformed manifest JSON
// ============================================================================

describe('runConnectionDiagnostics() — short-circuit: malformed manifest JSON', () => {
  let ops: FsOps;

  beforeEach(() => {
    ops = passingOps();
    ops.readFileSync = (_p) => 'THIS IS NOT JSON {{{';
  });

  it('should return healthy: false', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(false);
  });

  it('should include "Failed to parse manifest" in the Host launch script detail', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    const scriptCheck = result.checks.find((c) => c.name === 'Host launch script');
    expect(scriptCheck?.detail).toContain('Failed to parse manifest');
  });

  it('should recommend running install.sh', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.remediation.some((r) => r.includes('install.sh'))).toBe(true);
  });
});

// ============================================================================
// Tests: Short-circuit behavior — manifest with empty path field
// ============================================================================

describe('runConnectionDiagnostics() — short-circuit: manifest missing path field', () => {
  let ops: FsOps;

  beforeEach(() => {
    ops = passingOps();
    ops.readFileSync = (_p) => JSON.stringify({ name: 'com.gentyr.chrome_browser_extension' }); // no path
  });

  it('should return healthy: false', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(false);
  });

  it('should include "(empty path in manifest)" in the detail', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    const scriptCheck = result.checks.find((c) => c.name === 'Host launch script');
    expect(scriptCheck?.detail).toContain('(empty path in manifest)');
  });
});

// ============================================================================
// Tests: Short-circuit behavior — socket directory missing
// ============================================================================

describe('runConnectionDiagnostics() — short-circuit: socket directory missing', () => {
  let ops: FsOps;

  beforeEach(() => {
    ops = passingOps();
    const original = ops.existsSync;
    ops.existsSync = (p) => p !== SOCKET_DIR && original(p);
  });

  it('should return healthy: false', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(false);
  });

  it('should return exactly 3 checks (manifest, script, dir)', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.checks).toHaveLength(3);
  });

  it('should mark Socket directory ok: false', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    const dirCheck = result.checks.find((c) => c.name === 'Socket directory');
    expect(dirCheck?.ok).toBe(false);
  });

  it('should include the socket dir path in the detail', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    const dirCheck = result.checks.find((c) => c.name === 'Socket directory');
    expect(dirCheck?.detail).toContain(SOCKET_DIR);
  });

  it('should include a hint to load the extension in remediation', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(
      result.remediation.some((r) => r.toLowerCase().includes('extension')),
    ).toBe(true);
  });

  it('should NOT include the Live sockets check', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.checks.map((c) => c.name)).not.toContain('Live sockets');
  });
});

// ============================================================================
// Tests: Short-circuit behavior — socket directory empty (no .sock files)
// ============================================================================

describe('runConnectionDiagnostics() — short-circuit: no socket files', () => {
  let ops: FsOps;

  beforeEach(() => {
    ops = passingOps([/* empty — no .sock files */]);
  });

  it('should return healthy: false', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(false);
  });

  it('should mark Live sockets ok: false', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    const sockCheck = result.checks.find((c) => c.name === 'Live sockets');
    expect(sockCheck?.ok).toBe(false);
  });

  it('should say "No socket files in directory" in the detail', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    const sockCheck = result.checks.find((c) => c.name === 'Live sockets');
    expect(sockCheck?.detail).toContain('No socket files in directory');
  });

  it('should include a hint to reload the extension or a tab', () => {
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(
      result.remediation.some((r) => r.toLowerCase().includes('reload')),
    ).toBe(true);
  });
});

// ============================================================================
// Tests: PID extraction from socket filenames
// ============================================================================

describe('runConnectionDiagnostics() — PID extraction from socket filenames', () => {
  it('should extract a single PID from a matching socket filename', () => {
    const ops = passingOps(['99999.sock']);
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(true);
    expect(result.checks[3].detail).toContain('PID: 99999');
  });

  it('should extract multiple PIDs from multiple socket files', () => {
    const ops = passingOps(['11111.sock', '22222.sock', '33333.sock']);
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(true);
    expect(result.checks[3].detail).toContain('11111');
    expect(result.checks[3].detail).toContain('22222');
    expect(result.checks[3].detail).toContain('33333');
  });

  it('should skip files that do not match the <digits>.sock pattern', () => {
    // Files like "lock.sock" or "tmp.sock" should be silently ignored
    const ops = passingOps(['lock.sock', 'tmp.sock', '55555.sock']);
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(true);
    expect(result.checks[3].detail).toContain('PID: 55555');
    expect(result.checks[3].detail).not.toContain('lock');
    expect(result.checks[3].detail).not.toContain('tmp');
  });

  it('should report healthy: false when ALL socket files have non-matching names', () => {
    // None match <digits>.sock pattern so livePids stays empty
    const ops = passingOps(['lock.sock', 'control.sock']);
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(false);
  });

  it('should include the live pid count in the detail', () => {
    const ops = passingOps(['10001.sock', '10002.sock']);
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.checks[3].detail).toContain('2 live');
  });
});

// ============================================================================
// Tests: Stale socket handling
// ============================================================================

describe('runConnectionDiagnostics() — stale socket handling', () => {
  it('should treat a socket whose process is dead as stale', () => {
    const ops = passingOps(['9999.sock']);
    ops.kill = (_pid, _sig) => {
      throw new Error('ESRCH');
    };
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(false);
    const sockCheck = result.checks.find((c) => c.name === 'Live sockets');
    expect(sockCheck?.ok).toBe(false);
  });

  it('should call unlinkSync to clean up stale socket files', () => {
    const unlinkCalls: string[] = [];
    const ops = passingOps(['9999.sock']);
    ops.kill = (_pid, _sig) => {
      throw new Error('ESRCH');
    };
    ops.unlinkSync = (p) => {
      unlinkCalls.push(p);
    };
    runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(unlinkCalls.length).toBeGreaterThan(0);
    expect(unlinkCalls[0]).toContain('9999.sock');
  });

  it('should mention the stale socket count in the detail when reporting failure', () => {
    const ops = passingOps(['9999.sock']);
    ops.kill = (_pid, _sig) => {
      throw new Error('ESRCH');
    };
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    const sockCheck = result.checks.find((c) => c.name === 'Live sockets');
    expect(sockCheck?.detail).toContain('stale socket');
  });

  it('should be healthy when at least one live socket exists among stale ones', () => {
    let callIndex = 0;
    const ops = passingOps(['dead-pid.sock', '12345.sock']);
    // First kill call (dead-pid.sock) — non-numeric, will be skipped by pidMatch
    // Second: 12345 is alive
    // Actually dead-pid.sock won't match /^(\d+)\.sock$/ so only 12345 is processed
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(true);
    expect(result.checks[3].ok).toBe(true);
  });

  it('should include stale count in success detail when some sockets are stale', () => {
    let killCallCount = 0;
    const ops = passingOps(['11111.sock', '22222.sock']);
    ops.kill = (pid, _sig) => {
      killCallCount++;
      if (pid === 22222) throw new Error('ESRCH'); // 22222 is dead
      // 11111 is alive — no throw
    };
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(true);
    expect(result.checks[3].detail).toContain('stale cleaned');
  });

  it('should not include stale note in success detail when all sockets are live', () => {
    const ops = passingOps(['11111.sock', '22222.sock']);
    const result = runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops);
    expect(result.healthy).toBe(true);
    expect(result.checks[3].detail).not.toContain('stale');
  });

  it('should be tolerant when unlinkSync throws for stale sockets', () => {
    const ops = passingOps(['9999.sock', '12345.sock']);
    ops.kill = (pid, _sig) => {
      if (pid === 9999) throw new Error('ESRCH');
    };
    ops.unlinkSync = (_p) => {
      throw new Error('EPERM');
    };
    // Should not propagate the unlinkSync error
    expect(() => runDiagnostics(SOCKET_DIR, MANIFEST_PATH, ops)).not.toThrow();
  });
});

// ============================================================================
// Tests: handleHealthCheck output shaping
// ============================================================================

describe('handleHealthCheck() — output shaping', () => {
  describe('when diagnostics are healthy', () => {
    let result: ToolResult;

    beforeEach(() => {
      const diag: DiagnosticResult = {
        healthy: true,
        checks: [
          { name: 'Native manifest', ok: true, detail: '/path/to/manifest.json' },
          { name: 'Host launch script', ok: true, detail: '/path/to/host.sh' },
          { name: 'Socket directory', ok: true, detail: '/tmp/socket-dir' },
          { name: 'Live sockets', ok: true, detail: '1 live (PID: 12345)' },
        ],
        remediation: [],
      };
      result = shapeHealthCheckOutput(diag);
    });

    it('should return a single text content item', () => {
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
    });

    it('should NOT set isError when healthy', () => {
      expect(result.isError).toBe(false);
    });

    it('should return valid JSON in the text field', () => {
      expect(() => JSON.parse(result.content[0].text!)).not.toThrow();
    });

    it('should include healthy: true in the JSON', () => {
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.healthy).toBe(true);
    });

    it('should include a checks object in the JSON', () => {
      const parsed = JSON.parse(result.content[0].text!);
      expect(typeof parsed.checks).toBe('object');
      expect(parsed.checks).not.toBeNull();
    });

    it('should key each check by its name', () => {
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.checks).toHaveProperty('Native manifest');
      expect(parsed.checks).toHaveProperty('Host launch script');
      expect(parsed.checks).toHaveProperty('Socket directory');
      expect(parsed.checks).toHaveProperty('Live sockets');
    });

    it('should include ok and detail on each check entry', () => {
      const parsed = JSON.parse(result.content[0].text!);
      const manifest = parsed.checks['Native manifest'];
      expect(manifest.ok).toBe(true);
      expect(manifest.detail).toBe('/path/to/manifest.json');
    });

    it('should omit the remediation key when the array is empty', () => {
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed).not.toHaveProperty('remediation');
    });

    it('should pretty-print the JSON with 2-space indentation', () => {
      const text = result.content[0].text!;
      // Pretty-printed JSON will have newlines and leading spaces
      expect(text).toContain('\n');
      expect(text).toContain('  ');
    });
  });

  describe('when diagnostics are unhealthy', () => {
    let result: ToolResult;

    beforeEach(() => {
      const diag: DiagnosticResult = {
        healthy: false,
        checks: [
          { name: 'Native manifest', ok: false, detail: 'Not found: /path/to/manifest.json' },
        ],
        remediation: ['Run: tools/chrome-extension/native-host/install.sh'],
      };
      result = shapeHealthCheckOutput(diag);
    });

    it('should set isError: true when not healthy', () => {
      expect(result.isError).toBe(true);
    });

    it('should include healthy: false in the JSON', () => {
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.healthy).toBe(false);
    });

    it('should include the remediation array in the JSON', () => {
      const parsed = JSON.parse(result.content[0].text!);
      expect(Array.isArray(parsed.remediation)).toBe(true);
      expect(parsed.remediation.length).toBeGreaterThan(0);
    });

    it('should include the install.sh hint in remediation', () => {
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.remediation.some((r: string) => r.includes('install.sh'))).toBe(true);
    });

    it('should mark the failing check as ok: false in the JSON', () => {
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.checks['Native manifest'].ok).toBe(false);
    });
  });

  describe('check entries without detail', () => {
    it('should omit the detail key when check.detail is absent', () => {
      const diag: DiagnosticResult = {
        healthy: false,
        checks: [{ name: 'Native manifest', ok: false }], // no detail
        remediation: ['fix it'],
      };
      const result = shapeHealthCheckOutput(diag);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.checks['Native manifest']).not.toHaveProperty('detail');
    });

    it('should include the detail key when check.detail is present', () => {
      const diag: DiagnosticResult = {
        healthy: false,
        checks: [{ name: 'Native manifest', ok: false, detail: 'some detail' }],
        remediation: ['fix it'],
      };
      const result = shapeHealthCheckOutput(diag);
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.checks['Native manifest'].detail).toBe('some detail');
    });
  });

  describe('End-to-end connectivity check injection', () => {
    it('should correctly shape a result with the e2e check added', () => {
      // Simulate what handleHealthCheck() does when diag.healthy is initially true
      // but the e2e connectivity check fails: healthy is set to false and an extra
      // check is pushed.
      const diag: DiagnosticResult = {
        healthy: false,
        checks: [
          { name: 'Native manifest', ok: true, detail: '/path/to/manifest.json' },
          { name: 'Host launch script', ok: true, detail: '/path/to/host.sh' },
          { name: 'Socket directory', ok: true, detail: '/tmp/socket-dir' },
          { name: 'Live sockets', ok: true, detail: '1 live (PID: 12345)' },
          { name: 'End-to-end connectivity', ok: false, detail: 'Connection timed out (3s)' },
        ],
        remediation: ['Socket exists but native host is unresponsive. Reload the Gentyr extension in Chrome.'],
      };
      const result = shapeHealthCheckOutput(diag);
      const parsed = JSON.parse(result.content[0].text!);

      expect(result.isError).toBe(true);
      expect(parsed.healthy).toBe(false);
      expect(parsed.checks['End-to-end connectivity'].ok).toBe(false);
      expect(parsed.checks['End-to-end connectivity'].detail).toContain('timed out');
      expect(parsed.remediation).toBeDefined();
    });

    it('should correctly shape a fully passing result with e2e check', () => {
      const diag: DiagnosticResult = {
        healthy: true,
        checks: [
          { name: 'Native manifest', ok: true },
          { name: 'Host launch script', ok: true },
          { name: 'Socket directory', ok: true },
          { name: 'Live sockets', ok: true },
          { name: 'End-to-end connectivity', ok: true, detail: 'tabs_context_mcp responded' },
        ],
        remediation: [],
      };
      const result = shapeHealthCheckOutput(diag);
      const parsed = JSON.parse(result.content[0].text!);

      expect(result.isError).toBe(false);
      expect(parsed.healthy).toBe(true);
      expect(parsed.checks['End-to-end connectivity'].ok).toBe(true);
      expect(parsed).not.toHaveProperty('remediation');
    });
  });
});

// ============================================================================
// Tests: SERVER_SIDE_TOOLS membership
// ============================================================================

describe('SERVER_SIDE_TOOLS set membership', () => {
  /**
   * Mirrors the dispatch set from server.ts ~lines 1112–1120.
   * Any tool in this set bypasses the socket proxy and is handled locally.
   */
  const SERVER_SIDE_TOOLS = new Set([
    'list_chrome_extensions',
    'reload_chrome_extension',
    'find_elements',
    'click_by_text',
    'fill_input',
    'wait_for_element',
    'health_check',
  ]);

  it('should include health_check', () => {
    expect(SERVER_SIDE_TOOLS.has('health_check')).toBe(true);
  });

  it('should include all 6 previously established server-side tools', () => {
    expect(SERVER_SIDE_TOOLS.has('list_chrome_extensions')).toBe(true);
    expect(SERVER_SIDE_TOOLS.has('reload_chrome_extension')).toBe(true);
    expect(SERVER_SIDE_TOOLS.has('find_elements')).toBe(true);
    expect(SERVER_SIDE_TOOLS.has('click_by_text')).toBe(true);
    expect(SERVER_SIDE_TOOLS.has('fill_input')).toBe(true);
    expect(SERVER_SIDE_TOOLS.has('wait_for_element')).toBe(true);
  });

  it('should contain exactly 7 members', () => {
    expect(SERVER_SIDE_TOOLS.size).toBe(7);
  });

  it('should NOT include socket-proxied tools', () => {
    const socketTools = ['navigate', 'read_page', 'tabs_context_mcp', 'computer', 'screenshot'];
    for (const name of socketTools) {
      expect(SERVER_SIDE_TOOLS.has(name)).toBe(false);
    }
  });

  it('dispatcher should route health_check without socket proxy', () => {
    // Validates that health_check is in the set — the dispatch gate in server.ts
    // uses SERVER_SIDE_TOOLS.has(name) to decide routing.
    const gatePredicate = (name: string) => SERVER_SIDE_TOOLS.has(name);
    expect(gatePredicate('health_check')).toBe(true);
  });
});
