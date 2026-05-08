#!/usr/bin/env node
/**
 * PreToolUse Hook: Demo Local Execution Guard
 *
 * Blocks spawned agents from running demos locally. Local demo execution
 * requires physical Chrome/display access that automated agents cannot
 * reliably provide.
 *
 * Matched tools: run_demo, run_demo_batch, run_tests, launch_ui_mode
 *
 * Exemptions:
 *   - CTO interactive sessions (CLAUDE_SPAWNED_SESSION !== 'true')
 *   - CTO Dashboard GUI (launches via process-runner.ts, not MCP)
 *   - run_demo/run_demo_batch with remote=true (default — remote is allowed)
 *
 * On block, creates a deferred action via the Unified CTO Authorization System.
 * The agent does NOT retry — the deferred action auto-executes after CTO approval + audit pass.
 *
 * SECURITY: This file should be root-owned via npx gentyr protect
 *
 * @version 2.0.0
 */

import { createInterface } from 'readline';
import crypto from 'node:crypto';
import { createDeferredAction, openDb, findDuplicatePending } from './lib/deferred-action-db.js';
import { computePendingHmac } from './lib/deferred-action-executor.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const IS_SPAWNED = process.env.CLAUDE_SPAWNED_SESSION === 'true';

// Fast exit: CTO interactive sessions are always exempt
if (!IS_SPAWNED) {
  process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
  process.exit(0);
}

// Read stdin
let input = '';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => { input += line; });
rl.on('close', () => {
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || '';
    const toolInput = hookInput.tool_input || {};

    // Extract the MCP tool name (strip mcp__playwright__ prefix)
    const shortName = toolName.replace('mcp__playwright__', '');

    // --- Determine if this call would execute locally ---
    let wouldRunLocally = false;
    let reason = '';

    switch (shortName) {
      case 'run_tests':
        wouldRunLocally = true;
        reason = 'run_tests always executes locally';
        break;

      case 'launch_ui_mode':
        wouldRunLocally = true;
        reason = 'launch_ui_mode always executes locally (interactive Playwright UI)';
        break;

      case 'run_demo': {
        // remote defaults to true. Only block if explicitly false or headed without explicit remote
        const remoteArg = toolInput.remote;
        const headlessArg = toolInput.headless;

        if (remoteArg === false) {
          wouldRunLocally = true;
          reason = 'run_demo called with remote: false (explicit local execution)';
        } else if (headlessArg === false && remoteArg !== true) {
          wouldRunLocally = true;
          reason = 'run_demo called with headless: false without remote: true (headed mode defaults to local)';
        }
        // remote=true or remote=undefined (defaults to true) → allowed
        break;
      }

      case 'run_demo_batch': {
        const batchRemoteArg = toolInput.remote;
        if (batchRemoteArg === false) {
          wouldRunLocally = true;
          reason = 'run_demo_batch called with remote: false (explicit local execution)';
        }
        // remote=true or remote=undefined (defaults to true) → allowed
        break;
      }

      default:
        // Unknown tool — allow (fail-open for non-demo tools)
        break;
    }

    // If remote execution — allow immediately
    if (!wouldRunLocally) {
      process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
      process.exit(0);
    }

    // --- Would run locally. Create deferred action and deny unconditionally ---
    let deferredInfo = '';
    try {
      const db = openDb();
      if (db) {
        try {
          const argsJson = JSON.stringify(toolInput);
          const argsHash = crypto.createHash('sha256').update(argsJson).digest('hex');
          const mcpServer = 'playwright';
          const existing = findDuplicatePending(db, mcpServer, shortName, argsHash);

          if (existing) {
            deferredInfo = ` Deferred action already pending: ${existing.id}.`;
          } else {
            const code = crypto.randomBytes(3).toString('hex').toUpperCase();
            const pendingHmac = computePendingHmac(code, mcpServer, shortName, argsHash);
            if (pendingHmac) {
              const result = createDeferredAction(db, {
                server: mcpServer,
                tool: shortName,
                args: toolInput,
                argsHash,
                code,
                phrase: 'UNIFIED',
                pendingHmac,
                sourceHook: 'demo-local-guard',
              });
              deferredInfo = ` Deferred action created: ${result.id}. Present this to the CTO, then call record_cto_decision({ decision_type: "demo_local", decision_id: "${result.id}", verbatim_text: "<CTO exact words>" }). The demo will auto-execute after CTO approval + audit pass. Do NOT retry.`;
            }
          }
        } finally {
          try { db.close(); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      // Non-fatal — proceed with deny even if deferred action creation fails
    }

    const denyMessage =
      `LOCAL DEMO BLOCKED: ${reason}. ` +
      `Spawned agents must use remote execution (Fly.io).` +
      (deferredInfo || ` If local execution is genuinely required, file a bypass request: ` +
      `submit_bypass_request({ task_type: 'todo', task_id: YOUR_TASK_ID, ` +
      `category: 'demo_local', summary: '${reason}' }) ` +
      `then call summarize_work and exit.`);

    process.stdout.write(JSON.stringify({
      permissionDecision: 'deny',
      permissionDecisionReason: denyMessage,
    }));
    process.exit(0);

  } catch (err) {
    // G001 fail-closed: parse error → deny
    process.stdout.write(JSON.stringify({
      permissionDecision: 'deny',
      permissionDecisionReason: `Demo local guard: internal error (G001 fail-closed) — ${err instanceof Error ? err.message : String(err)}`,
    }));
    process.exit(0);
  }
});
