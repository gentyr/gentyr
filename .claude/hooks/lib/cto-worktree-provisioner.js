#!/usr/bin/env node
/**
 * CTO Worktree Provisioner
 *
 * Detached background process that provisions the `cto-interactive` worktree
 * after lockdown has been disabled. Runs out-of-band from the 15s PostToolUse
 * hook timeout so cold pnpm installs (which can take minutes) do not leave the
 * lockdown_toggle deferred_action stuck in 'executing' status.
 *
 * Flow:
 *   1. authorization-audit-spawner.js writes interactiveLockdownDisabled=true to
 *      automation-config.json and marks the deferred_action 'completed' SYNCHRONOUSLY.
 *      Lockdown is off the moment that file is written.
 *   2. authorization-audit-spawner.js spawns THIS script detached.
 *   3. This script calls createWorktree() (which can take minutes) and on success
 *      writes ctoWorktreePath back into automation-config.json so the lockdown-off
 *      Edit guard can suggest "cd <path>".
 *
 * Failure mode: if provisioning fails, the worktree path stays unset. The
 * lockdown-off Edit guard already handles that — it suggests provisioning
 * recovery rather than dereferencing a missing path.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'cto-worktree-provisioner.log');
const CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [cto-worktree-provisioner] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* non-fatal */ }
}

async function main() {
  log('Starting CTO worktree provisioning');

  let worktreeResult;
  try {
    const wtMod = await import('./worktree-manager.js');
    worktreeResult = wtMod.createWorktree('cto-interactive');
    log(`Worktree ready at ${worktreeResult.path} (branch: ${worktreeResult.branch}, created: ${worktreeResult.created})`);
  } catch (err) {
    log(`ERROR: createWorktree failed: ${err.message}`);
    return;
  }

  // Write ctoWorktreePath back into automation-config.json. Read-modify-write because
  // another writer (the hook that wrote interactiveLockdownDisabled) finished first.
  try {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* fresh */ }
    // Only set ctoWorktreePath if lockdown is still disabled — if the CTO re-enabled
    // lockdown while we were provisioning, do not stamp a worktree path onto a now-active
    // lockdown config (it would mislead the lockdown-off Edit guard if disabled again).
    if (config.interactiveLockdownDisabled === true) {
      config.ctoWorktreePath = worktreeResult.path;
      const tmpPath = CONFIG_PATH + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n');
      fs.renameSync(tmpPath, CONFIG_PATH);
      log(`Wrote ctoWorktreePath=${worktreeResult.path} to automation-config.json`);
    } else {
      log('Lockdown was re-enabled during provisioning, not stamping ctoWorktreePath');
    }
  } catch (err) {
    log(`ERROR: failed to update automation-config.json: ${err.message}`);
  }
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
