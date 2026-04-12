#!/usr/bin/env node
/**
 * PostToolUse Hook: Long-Command Warning
 *
 * Fires after mcp__secret-sync__secret_run_command. Detects two failure modes
 * caused by the Claude Code MCP transport's ~60-second timeout:
 *
 *   1. Auto-backgrounded: command was silently promoted to background because
 *      its timeout exceeded 55s. Guides the agent to poll for results.
 *
 *   2. Foreground returned empty output (no explicit timeout): likely means the
 *      MCP transport killed the call mid-run. Warns and suggests background mode.
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran; blocking is meaningless).
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin });
let data = '';
rl.on('line', l => { data += l; });
rl.on('close', () => {
  try {
    const hookInput = JSON.parse(data);
    const toolName = hookInput.tool_name ?? '';

    // Only fire on secret_run_command
    if (toolName !== 'mcp__secret-sync__secret_run_command') {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const input = hookInput.tool_input ?? {};
    const response = (() => {
      const r = hookInput.tool_response;
      if (!r) return null;
      if (typeof r === 'string') {
        // tool_response may arrive as a JSON string
        try { return JSON.parse(r); } catch { return null; }
      }
      return r;
    })();

    if (!response) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Case 1: auto-backgrounded — guide agent to poll for results
    if (response.mode === 'auto_background') {
      const label = response.label ?? '(unknown)';
      const progressFile = response.progressFile ?? null;
      const timeoutMs = input.timeout ?? '?';
      let ctx = `[LONG COMMAND AUTO-BACKGROUNDED] This command was automatically run in background mode because its timeout (${timeoutMs}ms) exceeds the MCP transport limit (~60s). The command is still running.\n\n`;
      ctx += `To check results:\n  mcp__secret-sync__secret_run_command_poll({ label: "${label}" })\n\n`;
      if (progressFile) {
        ctx += `Or read the raw progress file (JSONL events):\n  Read({ file_path: "${progressFile}" })\n\n`;
      }
      ctx += `Poll every 15–30 seconds until running: false appears in the response.`;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: ctx,
        },
      }));
      process.exit(0);
    }

    // Case 2: foreground returned zero output without a timeout flag
    // This is the signature of an MCP transport kill — the process ran past ~60s
    // and the transport dropped the connection, leaving the child orphaned.
    if (
      response.mode === 'foreground' &&
      Array.isArray(response.output) &&
      response.output.length === 0 &&
      !response.timedOut
    ) {
      const label = input.label || (Array.isArray(input.command) ? input.command[0] : '(unknown)');
      const timeoutMs = input.timeout ?? '?';
      const ctx = [
        `[WARNING: EMPTY OUTPUT — PROBABLE MCP TRANSPORT TIMEOUT]`,
        `secret_run_command returned zero output lines but did NOT report a timeout.`,
        `This likely means the MCP transport (~60s limit) killed the call while the command was still running.`,
        `The child process may still be alive.`,
        ``,
        `For commands taking >55 seconds, use background mode to avoid this:`,
        `  secret_run_command({ ..., background: true, label: "${label}" })`,
        ``,
        `Then poll:`,
        `  secret_run_command_poll({ label: "${label}" })`,
        ``,
        `Current timeout was ${timeoutMs}ms. If you need foreground mode, ensure the command completes in under 55s.`,
      ].join('\n');
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: ctx,
        },
      }));
      process.exit(0);
    }

    // No issue detected — emit empty response
    process.stdout.write(JSON.stringify({}));
  } catch {
    // Never fail loudly in a PostToolUse hook
    process.stdout.write(JSON.stringify({}));
  }
  process.exit(0);
});

// Safety timeout in case stdin never closes
setTimeout(() => {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}, 4000);
