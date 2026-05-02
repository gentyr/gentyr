#!/usr/bin/env node
/**
 * PostToolUse Hook: Release Completion
 *
 * Fires after mcp__persistent-task__complete_persistent_task. When the
 * completed persistent task has a releaseId in its metadata, this hook:
 *   1. Unlocks staging
 *   2. Generates the structured release report
 *   3. Emits a release_completed audit event
 *   4. Broadcasts a signal to all interactive sessions
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran).
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const NOOP = JSON.stringify({});

const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'session-queue.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [release-completion-hook] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {
    // Non-fatal
  }
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => { data += line; });
    rl.on('close', () => { resolve(data); });
    setTimeout(() => { rl.close(); resolve(data); }, 200);
  });
}

/**
 * Parse the completed persistent task ID from the tool input/response.
 *
 * PostToolUse hooks receive both tool_input (what was sent) and tool_response
 * (what came back). The persistent task ID is in tool_input.
 *
 * @param {object} input - Hook input
 * @returns {string|null}
 */
function extractPersistentTaskId(input) {
  try {
    // Try tool_input first
    const toolInput = typeof input.tool_input === 'string'
      ? JSON.parse(input.tool_input)
      : input.tool_input;
    if (toolInput?.id) return toolInput.id;
  } catch (_) {
    // Fall through
  }

  try {
    // Try extracting from tool_response
    const response = input?.tool_response;
    if (response && typeof response === 'object' && Array.isArray(response.content)) {
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          const parsed = JSON.parse(block.text);
          if (parsed.id) return parsed.id;
        }
      }
    } else if (response && typeof response === 'object') {
      if (response.id) return response.id;
    } else if (typeof response === 'string') {
      const parsed = JSON.parse(response);
      if (parsed.id) return parsed.id;
    }
  } catch (_) {
    // Fall through
  }

  return null;
}

async function main() {
  const stdinData = await readStdin();
  if (!stdinData) {
    process.stdout.write(NOOP);
    return;
  }

  let input;
  try {
    input = JSON.parse(stdinData);
  } catch (_) {
    process.stdout.write(NOOP);
    return;
  }

  // Only fire on complete_persistent_task
  const toolName = input.tool_name || '';
  if (!toolName.includes('complete_persistent_task')) {
    process.stdout.write(NOOP);
    return;
  }

  // Extract the persistent task ID
  const persistentTaskId = extractPersistentTaskId(input);
  if (!persistentTaskId) {
    log('Could not extract persistent task ID from tool input/response');
    process.stdout.write(NOOP);
    return;
  }

  // Check if this persistent task has a releaseId in its metadata
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch (_) {
    process.stdout.write(NOOP);
    return;
  }

  const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
  if (!fs.existsSync(ptDbPath)) {
    process.stdout.write(NOOP);
    return;
  }

  let releaseId = null;
  try {
    const db = new Database(ptDbPath, { readonly: true });
    const task = db.prepare('SELECT metadata FROM persistent_tasks WHERE id = ?').get(persistentTaskId);
    db.close();

    if (!task?.metadata) {
      process.stdout.write(NOOP);
      return;
    }

    const meta = JSON.parse(task.metadata);
    releaseId = meta.releaseId || null;
  } catch (err) {
    log(`Warning: failed to read persistent task metadata: ${err.message}`);
    process.stdout.write(NOOP);
    return;
  }

  if (!releaseId) {
    // Not a release-related persistent task — exit silently
    process.stdout.write(NOOP);
    return;
  }

  // Validate the release is actually in_progress before acting
  try {
    const Database = (await import('better-sqlite3')).default;
    const ledgerDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'release-ledger.db');
    if (fs.existsSync(ledgerDbPath)) {
      const db = new Database(ledgerDbPath, { readonly: true });
      db.pragma('busy_timeout = 3000');
      const release = db.prepare('SELECT status FROM releases WHERE id = ?').get(releaseId);
      db.close();
      if (release && release.status !== 'in_progress') {
        log(`Release ${releaseId} is ${release.status}, not in_progress — skipping completion`);
        process.stdout.write(NOOP);
        return;
      }
    }
  } catch (err) {
    log(`Warning: could not validate release status: ${err.message} — proceeding anyway`);
  }

  log(`Release completion detected for release ${releaseId} (persistent task ${persistentTaskId})`);

  // Step 1: Unlock staging
  try {
    const { unlockStaging } = await import('./lib/staging-lock.js');
    await unlockStaging(releaseId, { projectDir: PROJECT_DIR });
    log(`Staging unlocked for release ${releaseId}`);
  } catch (err) {
    log(`Warning: failed to unlock staging: ${err.message}`);
    // Continue — report generation is still valuable even if unlock fails
  }

  // Step 2: Generate the structured release report
  let reportPath = null;
  try {
    const { generateStructuredReport } = await import('./lib/release-report-generator.js');
    const result = await generateStructuredReport(releaseId, PROJECT_DIR);
    reportPath = result.mdPath;
    log(`Release report generated at ${reportPath}`);
  } catch (err) {
    log(`Warning: failed to generate release report: ${err.message}`);
    // Continue — audit event and signal are still valuable
  }

  // Step 2b: Create GitHub Release with git tag
  let githubReleaseResult = null;
  try {
    // Read the version from the release-ledger DB
    const ledgerDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'release-ledger.db');
    if (fs.existsSync(ledgerDbPath)) {
      const db = new Database(ledgerDbPath, { readonly: true });
      db.pragma('busy_timeout = 3000');
      const release = db.prepare('SELECT version FROM releases WHERE id = ?').get(releaseId);
      db.close();

      if (release && release.version) {
        const { createGitHubRelease } = await import('./lib/release-orchestrator.js');
        githubReleaseResult = createGitHubRelease(releaseId, release.version, reportPath, PROJECT_DIR);
        if (githubReleaseResult) {
          log(`GitHub Release created: tag=${githubReleaseResult.tag}, url=${githubReleaseResult.releaseUrl}`);
        } else {
          log(`GitHub Release creation returned null (non-fatal)`);
        }
      } else {
        log(`No version found for release ${releaseId} — skipping GitHub Release creation`);
      }
    }
  } catch (err) {
    log(`Warning: GitHub Release creation failed (non-fatal): ${err.message}`);
  }

  // Step 3: Update release record with report path
  if (reportPath) {
    try {
      const ledgerDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'release-ledger.db');
      if (fs.existsSync(ledgerDbPath)) {
        const db = new Database(ledgerDbPath);
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 3000');
        db.prepare('UPDATE releases SET report_path = ?, staging_unlock_at = ? WHERE id = ?')
          .run(reportPath, new Date().toISOString(), releaseId);
        db.close();
      }
    } catch (err) {
      log(`Warning: failed to update release record: ${err.message}`);
    }
  }

  // Step 4: Emit release_completed audit event
  try {
    const { auditEvent } = await import('./lib/session-audit.js');
    auditEvent('release_completed', {
      release_id: releaseId,
      persistent_task_id: persistentTaskId,
      report_path: reportPath || 'generation_failed',
    });
  } catch (err) {
    log(`Warning: failed to emit audit event: ${err.message}`);
  }

  // Step 5: Broadcast signal to all interactive sessions
  try {
    const { broadcastSignal } = await import('./lib/session-signals.js');
    const agentId = process.env.CLAUDE_AGENT_ID || 'release-completion-hook';

    const message = reportPath
      ? `Production release ${releaseId} complete. Report at ${reportPath}`
      : `Production release ${releaseId} complete. Report generation failed — check logs.`;

    broadcastSignal({
      fromAgentId: agentId,
      fromAgentType: 'release-completion-hook',
      fromTaskTitle: `Release ${releaseId} completion`,
      tier: 'instruction',
      message,
      projectDir: PROJECT_DIR,
    });

    log(`Broadcast release completion signal for ${releaseId}`);
  } catch (err) {
    log(`Warning: failed to broadcast completion signal: ${err.message}`);
  }

  // Return context to the agent
  const reportInfo = reportPath
    ? `Release report generated at: ${reportPath}`
    : 'Release report generation failed — check session-queue.log for details.';

  const ghInfo = githubReleaseResult
    ? ` GitHub Release: ${githubReleaseResult.releaseUrl} (tag: ${githubReleaseResult.tag}).`
    : '';

  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `[RELEASE COMPLETE] Release ${releaseId} finalized. Staging unlocked. ${reportInfo}${ghInfo}`,
    },
  }));
}

main().catch((err) => {
  // Non-fatal — PostToolUse hooks must always exit 0
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(
      path.join(PROJECT_DIR, '.claude', 'session-queue.log'),
      `[${timestamp}] [release-completion-hook] Unhandled error: ${err.message}\n`
    );
  } catch (_) {
    // Absolutely non-fatal
  }
  process.stdout.write(NOOP);
});
