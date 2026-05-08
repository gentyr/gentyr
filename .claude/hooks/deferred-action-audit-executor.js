#!/usr/bin/env node
/**
 * PostToolUse Hook: Deferred Action Audit Executor
 *
 * Fires after mcp__agent-tracker__cto_decision_audit_pass. When a CTO decision
 * passes audit verification, this hook:
 *
 * 1. Loads the linked deferred action from bypass-requests.db
 * 2. For MCP tools: computes approved_hmac, marks approved, executes via MCP daemon
 * 3. For Bash commands: executes via child_process.execFile in the deferred action's CWD
 * 4. Stores the execution result on the deferred action record
 * 5. Attempts to signal the original agent (if alive) with the result
 *
 * This is the key change: the agent that was blocked does NOT retry. The system
 * fires the tool call autonomously after the full approval chain completes.
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch { /* SQLite unavailable */ }

let auditEvent;
try {
  const auditMod = await import('./lib/session-audit.js');
  auditEvent = auditMod.auditEvent;
} catch { auditEvent = () => {}; }

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'deferred-action-audit-executor.log');
const BYPASS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');

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
 * Parse the tool response to extract audit pass fields.
 * @param {any} response
 * @returns {{ decisionId: string|null, status: string|null }}
 */
function parseResponse(response) {
  const result = { decisionId: null, status: null };

  function extractFields(parsed) {
    if (!parsed || typeof parsed !== 'object') return;
    result.decisionId = parsed.decision_id || null;
    result.status = parsed.status || null;
  }

  if (Array.isArray(response)) {
    for (const block of response) {
      if (block && block.type === 'text' && block.text) {
        try {
          extractFields(JSON.parse(block.text));
          if (result.status) return result;
        } catch { /* Not JSON */ }
      }
    }
    return result;
  }

  if (response && typeof response === 'object' && !Array.isArray(response)) {
    if (response.content && Array.isArray(response.content)) {
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          try {
            extractFields(JSON.parse(block.text));
            if (result.status) return result;
          } catch { /* Not JSON */ }
        }
      }
    }
    extractFields(response);
    if (result.status) return result;
  }

  if (typeof response === 'string') {
    try { extractFields(JSON.parse(response)); } catch { /* Not JSON */ }
  }

  return result;
}

/**
 * Execute a Bash command in the specified CWD.
 * @param {string} command - Shell command to execute
 * @param {string} cwd - Working directory
 * @returns {Promise<{success: boolean, result?: string, error?: string}>}
 */
function executeBashCommand(command, cwd) {
  return new Promise((resolve) => {
    const effectiveCwd = cwd && fs.existsSync(cwd) ? cwd : PROJECT_DIR;
    execFile('/bin/bash', ['-c', command], {
      cwd: effectiveCwd,
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          success: false,
          error: `Command failed (exit ${error.code}): ${stderr || error.message}`,
          result: stdout || undefined,
        });
      } else {
        resolve({
          success: true,
          result: stdout || '(no output)',
        });
      }
    });
  });
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

    // Only process cto_decision_audit_pass responses
    const toolName = hookInput.tool_name;
    if (toolName !== 'mcp__agent-tracker__cto_decision_audit_pass' && toolName !== 'cto_decision_audit_pass') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const { decisionId, status } = parseResponse(hookInput.tool_response);

    // Fast-exit if not audit_passed
    if (status !== 'audit_passed') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    if (!decisionId) {
      log('audit_passed detected but could not extract decision_id');
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    if (!Database) {
      log('ERROR: better-sqlite3 not available — cannot execute deferred action');
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    log(`Decision ${decisionId} passed audit — checking for linked deferred action`);

    // Step 1: Load the decision record to find the linked deferred action
    let linkedDecisionId = null;
    try {
      const db = new Database(BYPASS_DB_PATH, { readonly: true });
      db.pragma('busy_timeout = 3000');
      try {
        const decision = db.prepare('SELECT decision_id, decision_type, decision_context FROM cto_decisions WHERE id = ?').get(decisionId);
        if (decision) {
          linkedDecisionId = decision.decision_id;
        }
      } finally {
        try { db.close(); } catch { /* best-effort */ }
      }
    } catch (err) {
      log(`ERROR: Failed to read decision record: ${err.message}`);
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    if (!linkedDecisionId) {
      log(`No decision_id found on decision ${decisionId} — nothing to execute`);
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Step 2: Load the linked deferred action
    let action = null;
    try {
      const { getDeferredAction } = await import('./lib/deferred-action-db.js');
      const db = new Database(BYPASS_DB_PATH);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 3000');
      try {
        action = getDeferredAction(db, linkedDecisionId);
      } finally {
        try { db.close(); } catch { /* best-effort */ }
      }
    } catch (err) {
      log(`Warning: Could not load deferred action ${linkedDecisionId}: ${err.message}`);
    }

    if (!action) {
      log(`No deferred action found for ID ${linkedDecisionId} — decision may not have a linked deferred action (e.g., bypass requests)`);
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    if (action.status !== 'pending') {
      log(`Deferred action ${action.id} is in status "${action.status}", not "pending" — skipping execution`);
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    log(`Found linked deferred action ${action.id} (server: ${action.server}, tool: ${action.tool}) — executing`);

    // Step 3: Execute based on server type
    let execResult;

    if (action.server === 'Bash') {
      // Bash command execution
      const args = typeof action.args === 'string' ? JSON.parse(action.args) : action.args;
      const command = args.command || args;
      const cwd = args.cwd || PROJECT_DIR;

      log(`Executing Bash command in ${cwd}: ${typeof command === 'string' ? command.slice(0, 200) : JSON.stringify(command).slice(0, 200)}`);

      // Mark as executing first (prevents double-execution)
      const { markExecuting, markCompleted, markFailed } = await import('./lib/deferred-action-db.js');
      const db = new Database(BYPASS_DB_PATH);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 3000');

      try {
        if (!markExecuting(db, action.id)) {
          log(`Could not transition deferred action ${action.id} to executing — may already be in progress`);
          process.stdout.write(JSON.stringify({ continue: true }));
          process.exit(0);
        }

        execResult = await executeBashCommand(typeof command === 'string' ? command : JSON.stringify(command), cwd);

        if (execResult.success) {
          markCompleted(db, action.id, execResult.result || '');
          log(`Bash command executed successfully for action ${action.id}`);
        } else {
          markFailed(db, action.id, execResult.error || 'Unknown Bash execution error');
          log(`Bash command failed for action ${action.id}: ${execResult.error}`);
        }
      } finally {
        try { db.close(); } catch { /* best-effort */ }
      }
    } else {
      // MCP tool execution via shared daemon
      try {
        const { executeAction, computeApprovedHmac } = await import('./lib/deferred-action-executor.js');
        const { markApproved } = await import('./lib/deferred-action-db.js');

        const db = new Database(BYPASS_DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 3000');

        try {
          // Compute approved HMAC
          const approvedHmac = computeApprovedHmac(action.code, action.server, action.tool, action.args_hash);
          if (!approvedHmac) {
            log(`ERROR: Could not compute approved HMAC for action ${action.id} — protection key missing`);
            const { markFailed } = await import('./lib/deferred-action-db.js');
            markFailed(db, action.id, 'G001 FAIL-CLOSED: Protection key missing — cannot compute approved HMAC');
            process.stdout.write(JSON.stringify({ continue: true }));
            process.exit(0);
          }

          // Mark as approved (sets approved_hmac)
          if (!markApproved(db, action.id, approvedHmac)) {
            log(`Could not mark deferred action ${action.id} as approved — may already be approved`);
            process.stdout.write(JSON.stringify({ continue: true }));
            process.exit(0);
          }

          // Re-read to get updated action with approved_hmac
          const { getDeferredAction } = await import('./lib/deferred-action-db.js');
          const updatedAction = getDeferredAction(db, action.id);

          if (!updatedAction) {
            log(`ERROR: Could not re-read deferred action ${action.id} after approval`);
            process.stdout.write(JSON.stringify({ continue: true }));
            process.exit(0);
          }

          // Execute the action (verifies HMACs, transitions to executing, calls MCP tool)
          execResult = await executeAction(db, updatedAction);

          if (execResult.success) {
            log(`MCP tool ${action.server}:${action.tool} executed successfully for action ${action.id}`);
          } else {
            log(`MCP tool ${action.server}:${action.tool} failed for action ${action.id}: ${execResult.error}`);
          }
        } finally {
          try { db.close(); } catch { /* best-effort */ }
        }
      } catch (err) {
        log(`ERROR: MCP execution failed for action ${action.id}: ${err.message}`);
        // Attempt to mark as failed
        try {
          const { markFailed } = await import('./lib/deferred-action-db.js');
          const db = new Database(BYPASS_DB_PATH);
          db.pragma('journal_mode = WAL');
          db.pragma('busy_timeout = 3000');
          try {
            markFailed(db, action.id, `Execution error: ${err.message}`);
          } finally {
            try { db.close(); } catch { /* best-effort */ }
          }
        } catch { /* non-fatal */ }
      }
    }

    // Step 4: Try to signal the original agent with the result
    if (action.requester_agent_id && execResult) {
      try {
        const { sendSignal } = await import('./lib/session-signals.js');
        const resultPreview = execResult.success
          ? (typeof execResult.result === 'string' ? execResult.result.slice(0, 500) : JSON.stringify(execResult.result).slice(0, 500))
          : (execResult.error || 'Unknown error').slice(0, 500);
        sendSignal({
          fromAgentId: 'deferred-action-audit-executor',
          fromAgentType: 'system',
          fromTaskTitle: 'Deferred Action Execution',
          toAgentId: action.requester_agent_id,
          tier: 'note',
          type: 'deferred_action_executed',
          message: `Deferred action ${action.id} (${action.server}:${action.tool}) ${execResult.success ? 'executed successfully' : 'failed'}: ${resultPreview}`,
          projectDir: PROJECT_DIR,
          metadata: {
            action_id: action.id,
            server: action.server,
            tool: action.tool,
            success: execResult.success,
          },
        });
        log(`Signaled agent ${action.requester_agent_id} with execution result`);
      } catch (err) {
        log(`Warning: Could not signal original agent: ${err.message}`);
        // Non-fatal — the action still executed
      }
    }

    auditEvent('deferred_action_executed_after_audit', {
      decision_id: decisionId,
      action_id: action.id,
      server: action.server,
      tool: action.tool,
      success: execResult ? execResult.success : false,
    });

    log(`Completed execution pipeline for decision ${decisionId}, action ${action.id}`);
  } catch (err) {
    log(`Error: ${err.message}\n${err.stack}`);
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
