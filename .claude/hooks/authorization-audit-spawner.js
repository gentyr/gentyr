#!/usr/bin/env node
/**
 * PostToolUse Hook: Authorization Audit Spawner
 *
 * Fires after mcp__agent-tracker__record_cto_decision. When the response contains
 * a successfully verified decision (status === 'verified'), transitions it to
 * 'audit_pending' and spawns an independent authorization-auditor to verify
 * the CTO was presented accurate context before the decision takes effect.
 *
 * Skips spawning when decision_type is 'audit_override' (override skips auditing —
 * the decision goes directly to 'audit_passed' in the server).
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { enqueueSession } from './lib/session-queue.js';
import { buildAuthorizationAuditorSessionSpec } from './lib/auditor-prompt.js';

let auditEvent;
try {
  const auditMod = await import('./lib/session-audit.js');
  auditEvent = auditMod.auditEvent;
} catch { auditEvent = () => {}; }

let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch { /* SQLite unavailable */ }

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'authorization-audit-spawner.log');
const BYPASS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [authorization-audit-spawner] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Non-fatal
  }
}

/**
 * Parse the tool response to extract decision fields.
 * Handles three response shapes: plain object, JSON string, and MCP content array.
 * @param {any} response
 * @returns {{ status: string|null, id: string|null, decisionType: string|null, decisionId: string|null }}
 */
function parseResponse(response) {
  const result = { status: null, id: null, decisionType: null, decisionId: null };

  function extractFields(parsed) {
    if (!parsed || typeof parsed !== 'object') return;
    result.status = parsed.status || null;
    result.id = parsed.id || null;
    result.decisionType = parsed.decision_type || null;
    result.decisionId = parsed.decision_id || null;
  }

  // Attempt 0: response is a bare content array (Claude Code's primary PostToolUse format)
  if (Array.isArray(response)) {
    for (const block of response) {
      if (block && block.type === 'text' && block.text) {
        try {
          extractFields(JSON.parse(block.text));
          if (result.status) return result;
        } catch {
          // Not JSON text block, continue
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
            if (result.status) return result;
          } catch {
            // Not JSON text block, continue
          }
        }
      }
    }
    extractFields(response);
    if (result.status) return result;
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

    // Only process record_cto_decision responses
    const toolName = hookInput.tool_name;
    if (toolName !== 'mcp__agent-tracker__record_cto_decision' && toolName !== 'record_cto_decision') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Parse the response
    const { status, id, decisionType, decisionId } = parseResponse(hookInput.tool_response);

    // Fast-exit if not a verified decision
    if (status !== 'verified') {
      // audit_override goes to 'audit_passed' directly — nothing to do
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Skip audit_override (already handled server-side as audit_passed)
    if (decisionType === 'audit_override') {
      log(`Skipping audit for audit_override decision ${id}`);
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    if (!id) {
      log('Verified decision detected but could not extract decision ID');
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // For lockdown_toggle and local_mode_toggle: skip the auditor and execute inline.
    // These are called from interactive sessions where peek_session cannot find the
    // CTO's JSONL (interactive sessions have no agent_id/queue_id). The JSONL quote
    // verification in recordCtoDecision already proves the CTO typed the approval.
    const INLINE_EXECUTE_TYPES = ['lockdown_toggle', 'local_mode_toggle'];
    if (INLINE_EXECUTE_TYPES.includes(decisionType) && decisionId) {
      log(`Inline execution for ${decisionType} decision ${id} (deferred action: ${decisionId})`);

      if (!Database) {
        log('ERROR: better-sqlite3 not available — cannot execute inline');
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      try {
        const db = new Database(BYPASS_DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 3000');

        try {
          // Transition CTO decision directly to audit_passed (skip auditor)
          db.prepare(
            "UPDATE cto_decisions SET status = 'audit_passed', audit_verdict = 'pass', audit_evidence = 'Inline execution — interactive session toggle', audit_completed_at = datetime('now') WHERE id = ? AND status = 'verified'"
          ).run(id);

          // Load and execute the deferred action
          const action = db.prepare('SELECT id, server, tool, args, args_hash, code, pending_hmac, status FROM deferred_actions WHERE id = ?').get(decisionId);
          if (!action) {
            log(`No deferred action found for ${decisionId}`);
            process.stdout.write(JSON.stringify({ continue: true }));
            process.exit(0);
          }

          if (action.status !== 'pending') {
            log(`Deferred action ${decisionId} already in status ${action.status}, skipping`);
            process.stdout.write(JSON.stringify({ continue: true }));
            process.exit(0);
          }

          // Compute approved HMAC and mark approved
          let executorMod;
          try {
            executorMod = await import('./lib/deferred-action-executor.js');
          } catch (err) {
            log(`Failed to import deferred-action-executor: ${err.message}`);
            process.stdout.write(JSON.stringify({ continue: true }));
            process.exit(0);
          }

          const approvedHmac = executorMod.computeApprovedHmac(action.code, action.server, action.tool, action.args_hash);
          if (!approvedHmac) {
            log(`Failed to compute approved HMAC — protection key missing`);
            process.stdout.write(JSON.stringify({ continue: true }));
            process.exit(0);
          }

          // Mark approved
          db.prepare("UPDATE deferred_actions SET status = 'approved', approved_hmac = ?, approved_at = datetime('now') WHERE id = ? AND status = 'pending'").run(approvedHmac, action.id);

          // Mark executing
          const execResult = db.prepare("UPDATE deferred_actions SET status = 'executing' WHERE id = ? AND status = 'approved'").run(action.id);
          if (execResult.changes === 0) {
            log(`Could not transition ${decisionId} to executing`);
            process.stdout.write(JSON.stringify({ continue: true }));
            process.exit(0);
          }

          // Execute the toggle
          let actionArgs = action.args;
          if (typeof actionArgs === 'string') {
            try { actionArgs = JSON.parse(actionArgs); } catch { actionArgs = {}; }
          }

          if (action.tool === 'set_lockdown_mode') {
            const configPath = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');
            let config = {};
            try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* empty */ }
            if (actionArgs.enabled === false) {
              config.interactiveLockdownDisabled = true;
            } else {
              delete config.interactiveLockdownDisabled;
            }
            const dir = path.dirname(configPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
            db.prepare("UPDATE deferred_actions SET status = 'completed', execution_result = ?, completed_at = datetime('now') WHERE id = ?").run(
              JSON.stringify({ success: true, lockdown_enabled: !!actionArgs.enabled }), action.id
            );
            log(`Lockdown ${actionArgs.enabled ? 'enabled' : 'disabled'} via inline execution`);
          } else if (action.tool === 'set_local_mode') {
            const localStateDir = path.join(PROJECT_DIR, '.claude', 'state');
            if (!fs.existsSync(localStateDir)) fs.mkdirSync(localStateDir, { recursive: true });
            const localState = { enabled: !!actionArgs.enabled, enabledAt: new Date().toISOString(), enabledBy: 'inline-executor' };
            fs.writeFileSync(path.join(localStateDir, 'local-mode.json'), JSON.stringify(localState, null, 2));
            db.prepare("UPDATE deferred_actions SET status = 'completed', execution_result = ?, completed_at = datetime('now') WHERE id = ?").run(
              JSON.stringify({ success: true, local_mode_enabled: !!actionArgs.enabled }), action.id
            );
            log(`Local mode ${actionArgs.enabled ? 'enabled' : 'disabled'} via inline execution`);
          }

          auditEvent(actionArgs.enabled === false ? `${decisionType.replace('_toggle', '')}_disabled` : `${decisionType.replace('_toggle', '')}_enabled`, {
            enabled: actionArgs.enabled, via: 'authorization-audit-spawner-inline',
          });
        } finally {
          try { db.close(); } catch { /* best-effort */ }
        }
      } catch (err) {
        log(`Inline execution failed for ${decisionType}: ${err.message}`);
      }

      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    log(`Verified decision ${id} (type: ${decisionType}, target: ${decisionId}) — transitioning to audit_pending and spawning auditor`);

    // Step 1: Transition the cto_decision to audit_pending
    if (!Database) {
      log('ERROR: better-sqlite3 not available — cannot transition decision to audit_pending');
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let verbatimText = '';
    let decisionContext = '';
    let sessionId = '';

    try {
      const db = new Database(BYPASS_DB_PATH);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 3000');

      try {
        // Atomic transition: only verified -> audit_pending
        const result = db.prepare(
          "UPDATE cto_decisions SET status = 'audit_pending' WHERE id = ? AND status = 'verified'"
        ).run(id);

        if (result.changes === 0) {
          log(`Could not transition decision ${id} to audit_pending — may already be transitioned`);
          process.stdout.write(JSON.stringify({ continue: true }));
          process.exit(0);
        }

        // Read the decision record for auditor context
        const row = db.prepare('SELECT verbatim_text, decision_context, session_id FROM cto_decisions WHERE id = ?').get(id);
        if (row) {
          verbatimText = row.verbatim_text || '';
          decisionContext = row.decision_context || '';
          sessionId = row.session_id || '';
        }
      } finally {
        try { db.close(); } catch { /* best-effort */ }
      }
    } catch (err) {
      log(`ERROR: Failed to transition decision to audit_pending: ${err.message}`);
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Step 2: Load linked deferred action context (if any)
    let deferredContext = '';
    if (decisionId) {
      try {
        const db = new Database(BYPASS_DB_PATH, { readonly: true });
        db.pragma('busy_timeout = 3000');
        try {
          // Try to find a deferred action linked by the decision_id
          const action = db.prepare('SELECT server, tool, args, source_hook FROM deferred_actions WHERE id = ?').get(decisionId);
          if (action) {
            let argsDisplay = action.args;
            try { argsDisplay = JSON.stringify(JSON.parse(action.args), null, 2); } catch { /* leave as-is */ }
            deferredContext = JSON.stringify({
              server: action.server,
              tool: action.tool,
              args: action.args ? JSON.parse(action.args) : {},
              source_hook: action.source_hook || 'unknown',
            });
            // Update decision_context on the cto_decisions row if not already set
            if (!decisionContext) {
              try {
                const writeDb = new Database(BYPASS_DB_PATH);
                writeDb.pragma('journal_mode = WAL');
                writeDb.pragma('busy_timeout = 3000');
                writeDb.prepare('UPDATE cto_decisions SET decision_context = ? WHERE id = ?').run(deferredContext, id);
                writeDb.close();
                decisionContext = deferredContext;
              } catch { /* non-fatal */ }
            }
          }
        } finally {
          try { db.close(); } catch { /* best-effort */ }
        }
      } catch (err) {
        log(`Warning: Could not load deferred action context for ${decisionId}: ${err.message}`);
      }
    }

    // Step 3: Dedup — check for existing auditor for this decision
    try {
      const queueDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
      if (fs.existsSync(queueDbPath)) {
        const qDb = new Database(queueDbPath, { readonly: true });
        qDb.pragma('busy_timeout = 3000');
        try {
          const existing = qDb.prepare(
            "SELECT id FROM queue_items WHERE lane = 'audit' AND status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.taskId') = ?"
          ).get(id);
          if (existing) {
            log(`Auditor already queued/running for decision ${id} — skipping duplicate spawn`);
            process.stdout.write(JSON.stringify({ continue: true }));
            process.exit(0);
          }
        } finally {
          try { qDb.close(); } catch { /* best-effort */ }
        }
      }
    } catch (err) {
      log(`Warning: Dedup check failed: ${err.message} — proceeding with spawn`);
    }

    // Step 4: Build and enqueue the authorization auditor
    const spec = buildAuthorizationAuditorSessionSpec(
      {
        decisionId: id,
        decisionType: decisionType || 'unknown',
        verbatimText,
        decisionContext: decisionContext || deferredContext,
        sessionId,
      },
      PROJECT_DIR,
    );

    enqueueSession({
      ...spec,
      title: `Authorization audit: ${decisionType} decision ${id}`,
      source: 'authorization-audit-spawner',
    });

    auditEvent('authorization_audit_spawned', {
      decision_id: id,
      decision_type: decisionType,
      target_id: decisionId,
    });

    log(`Enqueued authorization auditor for decision ${id} (type: ${decisionType})`);
  } catch (err) {
    log(`Error: ${err.message}\n${err.stack}`);
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
