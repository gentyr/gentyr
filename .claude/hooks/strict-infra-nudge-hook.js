#!/usr/bin/env node
/**
 * Strict-infra Nudge Hook
 *
 * PostToolUse on Bash. Redirects infrastructure Bash commands to their MCP
 * equivalents when GENTYR_STRICT_INFRA_GUIDANCE=true is set.
 * Fast-exits for non-strict-infra sessions (< 1ms overhead).
 */
import { createInterface } from 'readline';
import { isLocalModeEnabled } from '../../lib/shared-mcp-config.js';

// Fast exit: not a strict-infra session
if (process.env.GENTYR_STRICT_INFRA_GUIDANCE !== 'true') {
  process.stdout.write(JSON.stringify({ }));
  process.exit(0);
}

// Fast exit: local mode active — Bash is allowed for infrastructure, no nudge needed
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
if (isLocalModeEnabled(projectDir)) {
  process.stdout.write(JSON.stringify({ }));
  process.exit(0);
}

const rl = createInterface({ input: process.stdin });
let data = '';
rl.on('line', l => { data += l; });
rl.on('close', () => {
  try {
    const input = JSON.parse(data);
    const command = input.tool_input?.command || '';

    // Pattern → MCP tool redirect map
    const REDIRECTS = [
      { pattern: /\b(npm|pnpm)\s+run\s+(dev|start)\b/, tool: 'mcp__secret-sync__secret_dev_server_start',
        msg: 'Use mcp__secret-sync__secret_dev_server_start({}) to start dev servers with secrets injected.' },
      { pattern: /\b(npm|pnpm)\s+run\s+build\b/, tool: 'mcp__secret-sync__secret_run_command',
        msg: 'Use mcp__secret-sync__secret_run_command({ command: ["pnpm", "build"], cwd: "<your-worktree-path>" }) for builds with secrets.' },
      { pattern: /\bnpx\s+playwright\b/, tool: 'mcp__playwright__run_demo',
        msg: 'Use mcp__playwright__run_demo or mcp__playwright__run_tests for Playwright operations.' },
      { pattern: /\bop\s+(read|run|inject)\b/, tool: 'mcp__onepassword__readSecret',
        msg: 'NEVER use the op CLI. Use mcp__onepassword__readSecret or mcp__secret-sync__secret_run_command for secret access.' },
      { pattern: /\b(npm|pnpm)\s+(install|i|add)\b/, tool: 'mcp__secret-sync__secret_run_command',
        msg: 'Use mcp__secret-sync__secret_run_command({ command: ["pnpm", "install"], cwd: "<path>" }) for package installation.' },
    ];

    const match = REDIRECTS.find(r => r.pattern.test(command));
    if (match) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `STRICT INFRA VIOLATION: You ran "${command.substring(0, 80)}" via Bash. ` +
            `This is PROHIBITED in strict-infra mode. ${match.msg} ` +
            `Review the "Infrastructure Access" section in your prompt for the correct MCP tools.`
        }
      }));
    } else {
      process.stdout.write(JSON.stringify({ }));
    }
  } catch {
    process.stdout.write(JSON.stringify({ }));
  }
  process.exit(0);
});
setTimeout(() => { rl.close(); }, 200);
