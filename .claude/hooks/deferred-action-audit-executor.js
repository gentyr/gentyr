#!/usr/bin/env node
/**
 * PostToolUse Hook: Deferred Action Audit Executor
 *
 * Fires after mcp__agent-tracker__cto_decision_audit_pass. When an authorization
 * audit passes, this hook auto-executes the linked deferred action — the CTO's
 * approved tool call fires without requiring the original agent to retry.
 *
 * Handles four decision types:
 * 1. Default (deferred_action / protected_action_gate / command_bypass / demo_local / lockdown_toggle):
 *    - Load deferred action by decision_id
 *    - Compute approved_hmac, mark approved, execute via MCP daemon (Tier 1) or Bash
 * 2. bypass_request:
 *    - CTO-approved bypass request resolution; reuses executeDeputyBypassResolution
 *      from deputy-resolution-executor.js (reads decision_context for request details)
 * 3. deputy_bypass_resolution:
 *    - Import and call executeDeputyBypassResolution from deputy-resolution-executor.js
 * 4. deputy_deferred_approval:
 *    - Import and call executeDeputyDeferredApproval from deputy-resolution-executor.js
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'deferred-action-audit-executor.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [deferred-action-audit-executor] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Non-fatal
  }
}

/**
 * Parse the tool response to extract decision_id and decision_type.
 * Handles three response shapes: plain object, JSON string, and MCP content array.
 * @param {any} response
 * @returns {{ decisionId: string|null, decisionType: string|null }}
 */
function parseResponse(response) {
  const result = { decisionId: null, decisionType: null };

  function extractFields(parsed) {
    if (!parsed || typeof parsed !== 'object') return;
    result.decisionId = parsed.decision_id || null;
    result.decisionType = parsed.decision_type || null;
  }

  // Attempt 0: response is a bare content array (Claude Code's primary PostToolUse format)
  if (Array.isArray(response)) {
    for (const block of response) {
      if (block && block.type === 'text' && block.text) {
        try {
          extractFields(JSON.parse(block.text));
          if (result.decisionId) return result;
        } catch {
          // Not JSON text block
        }
      }
    }
    return result;
  }

  // Attempt 1: response is already an object
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    if (response.content && Array.isArray(response.content)) {
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          try {
            extractFields(JSON.parse(block.text));
            if (result.decisionId) return result;
          } catch {
            // Not JSON text block
          }
        }
      }
    }
    extractFields(response);
    if (result.decisionId) return result;
  }

  // Attempt 2: response is a JSON string
  if (typeof response === 'string') {
    try {
      extractFields(JSON.parse(response));
    } catch {
      // Not valid JSON
    }
  }

  return result;
}

/**
 * Execute a Bash command from a deferred action.
 * Used for hooks like block-no-verify.js and staging-lock-guard.js
 * that capture Bash tool calls.
 * @param {object} args - The args object with { command, cwd? }
 * @returns {Promise<{success: boolean, result?: string, error?: string}>}
 */
function executeBashCommand(args) {
  return new Promise((resolve) => {
    const command = args.command;
    const cwd = args.cwd || PROJECT_DIR;

    if (!command || typeof command !== 'string') {
      resolve({ success: false, error: 'Missing or invalid command in deferred action args' });
      return;
    }

    execFile('bash', ['-c', command], { cwd, timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          success: false,
          error: `Bash command failed: ${error.message}${stderr ? ` (stderr: ${stderr.substring(0, 500)})` : ''}`,
        });
      } else {
        resolve({
          success: true,
          result: stdout.substring(0, 2000),
        });
      }
    });
  });
}

/**
 * Execute the default deferred action flow.
 * Loads the deferred action, computes approved_hmac, marks approved, and executes.
 * @param {string} decisionId - The cto_decisions row PK (e.g., "ctod-xxx"). The actual
 *   deferred action ID is resolved via cto_decisions.decision_id lookup.
 */
async function executeDefaultDeferredAction(decisionId) {
  let dbMod, executorMod;

  try {
    dbMod = await import('./lib/deferred-action-db.js');
  } catch (err) {
    log(`Failed to import deferred-action-db: ${err.message}`);
    return;
  }

  try {
    executorMod = await import('./lib/deferred-action-executor.js');
  } catch (err) {
    log(`Failed to import deferred-action-executor: ${err.message}`);
    return;
  }

  const db = dbMod.openDb();
  if (!db) {
    log('Could not open bypass-requests.db');
    return;
  }

  try {
    // Step 0: Resolve the actual deferred action ID from cto_decisions.
    // The decisionId parameter is the cto_decisions row PK (e.g., "ctod-xxx").
    // The deferred action ID is in cto_decisions.decision_id (e.g., "deferred-xxx").
    let actualDeferredActionId = decisionId;
    try {
      const decisionRow = db.prepare(
        'SELECT decision_id FROM cto_decisions WHERE id = ?'
      ).get(decisionId);
      if (decisionRow && decisionRow.decision_id) {
        actualDeferredActionId = decisionRow.decision_id;
        log(`Resolved cto_decisions.id=${decisionId} -> deferred action id=${actualDeferredActionId}`);
      }
    } catch (err) {
      log(`Warning: Could not resolve cto_decisions row for ${decisionId}: ${err.message} — falling back to direct lookup`);
    }

    // Load the deferred action by the resolved ID
    const action = dbMod.getDeferredAction(db, actualDeferredActionId);
    if (!action) {
      log(`No deferred action found for decision_id=${decisionId} — may be a bypass_request decision without a deferred action, skipping`);
      return;
    }

    if (action.status === 'completed') {
      log(`Deferred action ${decisionId} already completed, skipping`);
      return;
    }

    if (action.status === 'executing') {
      log(`Deferred action ${decisionId} already executing, skipping`);
      return;
    }

    if (action.status === 'failed') {
      log(`Deferred action ${decisionId} previously failed, skipping`);
      return;
    }

    // Compute the approved_hmac and mark approved
    const approvedHmac = executorMod.computeApprovedHmac(action.code, action.server, action.tool, action.args_hash);
    if (!approvedHmac) {
      log(`Failed to compute approved HMAC for action ${decisionId} — protection key may be missing`);
      dbMod.markFailed(db, action.id, 'Failed to compute approved HMAC — protection key missing');
      return;
    }

    dbMod.markApproved(db, action.id, approvedHmac);

    // Re-fetch the action with updated approved_hmac
    const approvedAction = dbMod.getDeferredAction(db, actualDeferredActionId);
    if (!approvedAction) {
      log(`Failed to re-fetch approved action ${decisionId}`);
      return;
    }

    // Route execution based on server type
    let execResult;
    if (approvedAction.server === 'Bash') {
      // Bash commands are executed directly, not via MCP daemon
      let args = approvedAction.args;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch {
          dbMod.markFailed(db, approvedAction.id, 'Failed to parse Bash command args');
          log(`Failed to parse Bash args for action ${decisionId}`);
          return;
        }
      }

      // Verify HMAC before execution
      const hmacCheck = executorMod.verifyActionHmac(approvedAction);
      if (!hmacCheck.valid) {
        dbMod.markFailed(db, approvedAction.id, `HMAC verification failed: ${hmacCheck.reason}`);
        log(`HMAC verification failed for Bash action ${decisionId}: ${hmacCheck.reason}`);
        return;
      }

      // Atomically transition to executing
      if (!dbMod.markExecuting(db, approvedAction.id)) {
        log(`Could not transition action ${decisionId} to executing — may already be in progress`);
        return;
      }

      execResult = await executeBashCommand(args);

      // Store result
      if (execResult.success) {
        dbMod.markCompleted(db, approvedAction.id, execResult.result || '');
      } else {
        dbMod.markFailed(db, approvedAction.id, execResult.error || 'Bash execution failed');
      }
    } else {
      // MCP tool calls — use the standard executeAction pipeline
      execResult = await executorMod.executeAction(db, approvedAction);
    }

    log(`Deferred action ${decisionId} execution result: success=${execResult.success}${execResult.error ? ` error=${execResult.error}` : ''}`);

    // Try to signal the original agent session (if still alive)
    try {
      const signalMod = await import('./lib/session-signals.js');
      if (approvedAction.requester_agent_id && signalMod.sendSignal) {
        signalMod.sendSignal(approvedAction.requester_agent_id, {
          type: 'deferred_action_executed',
          action_id: approvedAction.id,
          success: execResult.success,
          result_preview: execResult.success
            ? (typeof execResult.result === 'string' ? execResult.result.substring(0, 200) : 'completed')
            : (execResult.error || 'failed').substring(0, 200),
        });
        log(`Sent execution result signal to agent ${approvedAction.requester_agent_id}`);
      }
    } catch {
      // Non-fatal — the agent may be dead
    }
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * Execute a deputy bypass resolution after audit pass.
 * @param {string} decisionId
 */
async function executeDeputyBypassResolution(decisionId) {
  try {
    const mod = await import('./lib/deputy-resolution-executor.js');
    if (mod.executeDeputyBypassResolution) {
      await mod.executeDeputyBypassResolution(decisionId, PROJECT_DIR);
      log(`Deputy bypass resolution executed for decision ${decisionId}`);
    } else {
      log(`deputy-resolution-executor.js does not export executeDeputyBypassResolution — module may not be available yet`);
    }
  } catch (err) {
    log(`Failed to execute deputy bypass resolution for ${decisionId}: ${err.message}`);
  }
}

/**
 * Execute a CTO bypass request resolution after audit pass.
 *
 * Reads the cto_decisions record, extracts the bypass request context from
 * decision_context, then resolves the bypass request (same logic as
 * resolve_bypass_request in the agent-tracker server).
 *
 * @param {string} decisionId - The cto_decisions.id
 */
async function executeBypassRequestResolution(decisionId) {
  try {
    const mod = await import('./lib/deputy-resolution-executor.js');
    if (mod.executeDeputyBypassResolution) {
      // Reuse the deputy bypass resolution executor — it reads cto_decisions.decision_context
      // (which contains bypass_request_id, deputy_decision, task_type, task_id, etc.)
      // and resolves the bypass request.
      // The logic is identical: read context, update bypass_requests, resume task, enqueue monitor.
      await mod.executeDeputyBypassResolution(decisionId, PROJECT_DIR);
      log(`Bypass request resolution executed for decision ${decisionId}`);
    } else {
      log(`deputy-resolution-executor.js does not export executeDeputyBypassResolution — module may not be available yet`);
    }
  } catch (err) {
    log(`Failed to execute bypass request resolution for ${decisionId}: ${err.message}`);
  }
}

/**
 * Execute a deputy deferred action approval after audit pass.
 * @param {string} decisionId
 */
async function executeDeputyDeferredApproval(decisionId) {
  try {
    const mod = await import('./lib/deputy-resolution-executor.js');
    if (mod.executeDeputyDeferredApproval) {
      await mod.executeDeputyDeferredApproval(decisionId, PROJECT_DIR);
      log(`Deputy deferred approval executed for decision ${decisionId}`);
    } else {
      log(`deputy-resolution-executor.js does not export executeDeputyDeferredApproval — module may not be available yet`);
    }
  } catch (err) {
    log(`Failed to execute deputy deferred approval for ${decisionId}: ${err.message}`);
  }
}

// ============================================================================
// Main: Read PostToolUse stdin and process
// ============================================================================

let input = '';

process.stdin.on('data', (chunk) => {
  input += chunk.toString();
});

process.stdin.on('end', async () => {
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name;

    // Fast-exit: only handle cto_decision_audit_pass
    if (toolName !== 'mcp__agent-tracker__cto_decision_audit_pass' && toolName !== 'cto_decision_audit_pass') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Parse the response to extract decision_id and decision_type
    const { decisionId, decisionType } = parseResponse(hookInput.tool_response);

    if (!decisionId) {
      log('cto_decision_audit_pass fired but could not extract decision_id from response');
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    log(`Audit passed for decision ${decisionId}, type=${decisionType || 'default'}`);

    // Route based on decision_type
    switch (decisionType) {
      case 'bypass_request':
        await executeBypassRequestResolution(decisionId);
        break;

      case 'deputy_bypass_resolution':
        await executeDeputyBypassResolution(decisionId);
        break;

      case 'deputy_deferred_approval':
        await executeDeputyDeferredApproval(decisionId);
        break;

      default:
        // Default path: deferred_action, protected_action_gate, command_bypass,
        // demo_local, lockdown_toggle, or any other type
        await executeDefaultDeferredAction(decisionId);
        break;
    }

    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  } catch (err) {
    // PostToolUse hooks must never crash — log and continue
    log(`Unhandled error: ${err.message}`);
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
});
