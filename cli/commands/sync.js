/**
 * gentyr sync - Force sync (rebuild MCP servers + re-merge configs)
 *
 * @module commands/sync
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveFrameworkDir, resolveFrameworkRelative, detectInstallModel } from '../lib/resolve-framework.js';
import { generateMcpJson, mergeSettings, updateClaudeMd, updateGitignore } from '../lib/config-gen.js';
import { createDirectorySymlinks, createAgentSymlinks, createReporterSymlinks } from '../lib/symlinks.js';
import { buildState, writeState, getFrameworkAgents } from '../lib/state.js';
import { restoreVaultMappings } from '../../lib/vault-mappings.js';
import { isLocalModeEnabled } from '../../lib/shared-mcp-config.js';
import { safeReadJson, safeWriteJson } from '../../lib/safe-json-io.js';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

/**
 * Check if the project is currently protected.
 *
 * Belt-and-suspenders: returns true when the state file says protected OR when
 * services.json on-disk is root-owned. The on-disk check catches state-drift
 * cases (interrupted unprotect, manual chown, restore from backup) where the
 * state file says unprotected but the file is actually root-owned — without it,
 * sync would skip auto-unprotect and step 1.5/1.6 would EACCES silently.
 *
 * @param {string} projectDir
 * @returns {boolean}
 */
function isProtected(projectDir) {
  try {
    const stateFile = path.join(projectDir, '.claude', 'protection-state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.protected === true) return true;
  } catch { /* fall through */ }
  try {
    const svcPath = path.join(projectDir, '.claude', 'config', 'services.json');
    const st = fs.statSync(svcPath);
    if (st.uid === 0) return true;
  } catch { /* file missing → not protected */ }
  return false;
}

/**
 * Run `npx gentyr unprotect` as a subprocess (reuses the full unprotect logic).
 * @param {string} projectDir
 */
function runUnprotect(projectDir) {
  console.log(`\n${YELLOW}Temporarily disabling protection for sync...${NC}`);
  const cliEntry = path.resolve(import.meta.dirname, '..', 'index.js');
  execFileSync(process.execPath, [cliEntry, 'unprotect'], {
    cwd: projectDir, stdio: 'inherit', timeout: 60000,
  });
}

/**
 * Run `npx gentyr protect` as a subprocess (reuses the full protect logic).
 * @param {string} projectDir
 */
function runProtect(projectDir) {
  console.log(`\n${YELLOW}Re-enabling protection...${NC}`);
  const cliEntry = path.resolve(import.meta.dirname, '..', 'index.js');
  execFileSync(process.execPath, [cliEntry, 'protect'], {
    cwd: projectDir, stdio: 'inherit', timeout: 60000,
  });
}

/**
 * Remove all remnants of the deleted rotation proxy system from existing installs.
 * Idempotent — silently skips anything that is already gone.
 * MUST NOT throw: every destructive operation is wrapped in try/catch.
 * @param {string} projectDir
 */
function cleanupRotationProxy(projectDir) {
  const home = os.homedir();

  // ── 1. Stop and remove launchd service (macOS) ─────────────────────────────
  if (process.platform === 'darwin') {
    const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.local.gentyr-rotation-proxy.plist');
    if (fs.existsSync(plistPath)) {
      console.log(`\n${YELLOW}Removing rotation proxy launchd service...${NC}`);
      try {
        execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe', timeout: 10000 });
      } catch {
        // Service may already be unloaded — not an error
      }
      try {
        fs.unlinkSync(plistPath);
        console.log('  Removed com.local.gentyr-rotation-proxy.plist');
      } catch (err) {
        console.log(`  ${YELLOW}Warning: could not remove proxy plist: ${err.message}${NC}`);
      }
    }
  }

  // ── 2. Stop and disable systemd service (Linux) ────────────────────────────
  if (process.platform === 'linux') {
    try {
      execFileSync('systemctl', ['--user', 'stop', 'gentyr-rotation-proxy.service'],
        { stdio: 'pipe', timeout: 10000 });
    } catch {
      // Not running or not found — not an error
    }
    try {
      execFileSync('systemctl', ['--user', 'disable', 'gentyr-rotation-proxy.service'],
        { stdio: 'pipe', timeout: 10000 });
    } catch {
      // Not enabled or not found — not an error
    }
  }

  // ── 3. Strip GENTYR PROXY blocks from shell profiles ───────────────────────
  const proxyBlockPattern = /\n?# BEGIN GENTYR PROXY\b[\s\S]*?# END GENTYR PROXY[^\n]*(\n|$)/g;
  for (const profileName of ['.zshrc', '.bashrc']) {
    const profilePath = path.join(home, profileName);
    if (!fs.existsSync(profilePath)) continue;
    try {
      const original = fs.readFileSync(profilePath, 'utf8');
      const cleaned = original.replace(proxyBlockPattern, '\n').replace(/\n{3,}/g, '\n\n');
      if (cleaned !== original) {
        fs.writeFileSync(profilePath, cleaned, 'utf8');
        console.log(`  Stripped GENTYR PROXY block from ~/${profileName}`);
      }
    } catch (err) {
      console.log(`  ${YELLOW}Warning: could not clean ~/${profileName}: ${err.message}${NC}`);
    }
  }

  // ── 4. Kill any lingering process on port 18080 ────────────────────────────
  try {
    const pids = execFileSync('lsof', ['-ti', ':18080'], { stdio: 'pipe', timeout: 5000, encoding: 'utf8' }).trim();
    if (pids) {
      for (const pid of pids.split('\n').filter(Boolean)) {
        try {
          process.kill(Number(pid));
        } catch {
          // Process may have already exited
        }
      }
      console.log(`  Killed rotation proxy process(es) on port 18080`);
    }
  } catch {
    // lsof exits non-zero when nothing is found — not an error
  }

  // ── 5. Delete TLS certificate directory ────────────────────────────────────
  const certDir = path.join(home, '.claude', 'proxy-certs');
  if (fs.existsSync(certDir)) {
    try {
      fs.rmSync(certDir, { recursive: true, force: true });
      console.log(`  Deleted ~/.claude/proxy-certs/`);
    } catch (err) {
      console.log(`  ${YELLOW}Warning: could not delete proxy-certs/: ${err.message}${NC}`);
    }
  }

  // ── 6. Delete user-level state files ───────────────────────────────────────
  const userStateFiles = [
    path.join(home, '.claude', 'api-key-rotation.json'),
    path.join(home, '.claude', 'proxy-disabled.json'),
    path.join(home, '.claude', 'rotation-proxy.log'),
  ];
  for (const filePath of userStateFiles) {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`  Deleted ${filePath.replace(home, '~')}`);
      } catch (err) {
        console.log(`  ${YELLOW}Warning: could not delete ${path.basename(filePath)}: ${err.message}${NC}`);
      }
    }
  }

  // ── 7. Delete project-level state files ────────────────────────────────────
  const projectStateFiles = [
    path.join(projectDir, '.claude', 'api-key-rotation.log'),
    path.join(projectDir, '.claude', 'state', 'quota-interrupted-sessions.json'),
    path.join(projectDir, '.claude', 'state', 'paused-sessions.json'),
    path.join(projectDir, '.claude', 'state', 'quota-monitor-state.json'),
    path.join(projectDir, '.claude', 'state', 'rotation-audit.log'),
    path.join(projectDir, '.claude', 'state', 'token-swap-monitor.log'),
  ];
  for (const filePath of projectStateFiles) {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`  Deleted ${path.relative(projectDir, filePath)}`);
      } catch (err) {
        console.log(`  ${YELLOW}Warning: could not delete ${path.basename(filePath)}: ${err.message}${NC}`);
      }
    }
  }

  // ── 8. Remove stale hook references from ~/.claude/settings.json ──────────
  // Generic: removes any hook whose referenced file no longer exists on disk.
  const globalSettingsPath = path.join(home, '.claude', 'settings.json');
  try {
    if (fs.existsSync(globalSettingsPath)) {
      const raw = fs.readFileSync(globalSettingsPath, 'utf8');
      const settings = JSON.parse(raw);
      if (settings.hooks && typeof settings.hooks === 'object') {
        let changed = false;
        for (const hookType of Object.keys(settings.hooks)) {
          const matchers = settings.hooks[hookType];
          if (!Array.isArray(matchers)) continue;
          for (const matcher of matchers) {
            if (!Array.isArray(matcher.hooks)) continue;
            const before = matcher.hooks.length;
            matcher.hooks = matcher.hooks.filter(entry => {
              const cmd = typeof entry === 'string' ? entry : entry.command;
              if (!cmd) return true;
              const match = cmd.match(/^node\s+(\S+)/);
              if (!match) return true;
              const filePath = match[1].replace(/\$\{CLAUDE_PROJECT_DIR\}/g, projectDir);
              return fs.existsSync(filePath);
            });
            if (matcher.hooks.length !== before) changed = true;
          }
          // Remove matchers with no hooks remaining
          const before = matchers.length;
          settings.hooks[hookType] = matchers.filter(m => Array.isArray(m.hooks) ? m.hooks.length > 0 : true);
          if (settings.hooks[hookType].length !== before) changed = true;
          // Remove hook type key if array is now empty
          if (settings.hooks[hookType].length === 0) {
            delete settings.hooks[hookType];
            changed = true;
          }
        }
        // Remove hooks key entirely if all types were removed
        if (changed && Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }
        if (changed) {
          fs.writeFileSync(globalSettingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
          console.log('  Removed stale hook references from ~/.claude/settings.json');
        }
      }
    }
  } catch (err) {
    console.log(`  ${YELLOW}Warning: could not clean stale hooks from ~/.claude/settings.json: ${err.message}${NC}`);
  }
}

/**
 * Check daemon health. Returns 'ok', 'starting', or false.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<'ok'|'starting'|false>}
 */
function checkDaemonHealth(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return resolve(false);
        try {
          const data = JSON.parse(body);
          resolve(data.status === 'starting' ? 'starting' : 'ok');
        } catch {
          resolve('ok'); // unparseable but 2xx = treat as ok
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Ensure the MCP shared daemon is healthy, restarting it if needed.
 * Called as Phase 2b — after sessions are killed but before they are re-enqueued,
 * so revived sessions inherit fresh Tier-1 MCP connections.
 * Non-fatal — always resolves (never throws).
 * @param {string} projectDir
 */
/**
 * Worker launchd labels that run gentyr framework code in-memory and therefore
 * must be force-restarted on `npx gentyr sync` so they pick up new code on disk.
 *
 * The MCP daemon is intentionally NOT in this list — Phase 2b
 * (`ensureMcpDaemonHealthy`) handles it with bespoke kill-by-PID + port-cleanup
 * + bootstrap + health-poll logic that this generic kickstart pass cannot replace.
 *
 * Must stay in sync with the labels declared in
 * `scripts/setup-automation-service.sh` lines 490–497. The mismatch is checked
 * by the test at `cli/commands/__tests__/sync-worker-daemons.test.js`.
 */
const WORKER_DAEMON_LABELS = Object.freeze([
  'com.local.gentyr-revival-daemon',
  'com.local.gentyr-quota-recovery-daemon',
  'com.local.gentyr-preview-watcher',
  'com.local.gentyr-session-activity-broadcaster',
  'com.local.gentyr-live-feed-daemon',
  'com.local.gentyr-synthetic-monitor',
  'com.local.gentyr-token-usage-collector',
]);

/**
 * Phase 0 — auto-pull `~/git/gentyr` from origin/main when the framework
 * checkout is clean.
 *
 * Background: target projects symlink `node_modules/gentyr` to the framework
 * checkout, so a stale local checkout silently runs old code even after the
 * latest fix is merged on GitHub. Without this step the user would have to
 * remember to `cd ~/git/gentyr && git pull` before every `npx gentyr sync`,
 * and the SessionStart staleness warning (`gentyr-sync.js`) currently only
 * warns — it never acts.
 *
 * Behavior:
 *  - skipped silently when frameworkDir is not a git checkout (npm-published
 *    install, or symlink already broken — outer sync logic handles those).
 *  - skipped when the checkout is dirty (uncommitted changes, unmerged files,
 *    HEAD not on a tracking branch, local commits ahead of upstream) with a
 *    yellow warning. Active gentyr development must never have its in-progress
 *    work disturbed by a consumer project's sync.
 *  - otherwise runs `git fetch` + `git pull --ff-only` against the tracked
 *    upstream. Failure is non-fatal — sync continues with whatever is on disk.
 *
 * Non-fatal throughout: every git call is wrapped in try/catch and logs a
 * yellow warning rather than aborting sync.
 *
 * @param {string} frameworkDir Absolute path to the resolved gentyr framework checkout.
 */

/**
 * Run `node --check` against critical framework files. Aborts sync (throws)
 * when any file fails to parse, with the offending file path + Node's error
 * surfaced so the operator can fix the regression before sync touches the
 * project.
 *
 * Targets:
 *   - Every critical hook from cli/commands/protect.js criticalHooks list
 *     (loaded via dynamic import so the list stays single-sourced)
 *   - lib/session-queue.js (drainQueue + enqueueSession — single point of
 *     failure for every spawn path)
 *   - Tier-2 MCP server dist outputs (todo-db, persistent-task,
 *     plan-orchestrator, agent-tracker) — TypeScript can compile to a
 *     parse-broken .js if a dev edits dist/ directly or a build is partial
 *
 * Synchronous: uses `node --check <file>` per file. ~25ms per file, ~700ms
 * total worst-case. Cheap insurance.
 *
 * @param {string} frameworkDir Absolute path to the resolved framework checkout.
 * @throws {Error} when any file fails to parse; message names the file.
 */
function runSyntaxGate(frameworkDir) {
  console.log(`\n${YELLOW}Phase 0.5 — Node syntax check...${NC}`);

  const targets = [];

  // Hooks that absolutely must parse for the framework to function. Mirrors
  // the lib/-prefixed entries that compose the per-spawn hot path.
  const hookHotPath = [
    '.claude/hooks/lib/session-queue.js',
    '.claude/hooks/lib/session-reaper.js',
    '.claude/hooks/lib/auditor-prompt.js',
    '.claude/hooks/lib/persistent-monitor-revival-prompt.js',
    '.claude/hooks/lib/audit-escalation.js',
    '.claude/hooks/lib/bypass-guard.js',
    '.claude/hooks/lib/resource-lock.js',
    '.claude/hooks/lib/cross-dep-satisfier.js',
    '.claude/hooks/persistent-task-spawner.js',
    '.claude/hooks/universal-audit-spawner.js',
    '.claude/hooks/authorization-audit-spawner.js',
    '.claude/hooks/deferred-action-audit-executor.js',
    '.claude/hooks/main-tree-commit-guard.js',
    '.claude/hooks/staging-lock-guard.js',
    '.claude/hooks/interactive-lockdown-guard.js',
  ];
  for (const rel of hookHotPath) {
    targets.push({ path: path.join(frameworkDir, rel), label: rel });
  }

  // Tier-2 MCP server dist outputs (the ones with stateful per-session stdio
  // that can't fall back to a daemon). A parse error in any of these breaks
  // their tool surfaces for every session that tries to invoke them.
  const tier2McpServers = ['todo-db', 'persistent-task', 'plan-orchestrator', 'agent-tracker'];
  for (const name of tier2McpServers) {
    const distPath = path.join(frameworkDir, 'packages', 'mcp-servers', 'dist', name, 'server.js');
    if (fs.existsSync(distPath)) {
      // Only check when dist exists — first-run sync builds it later.
      targets.push({ path: distPath, label: `packages/mcp-servers/dist/${name}/server.js` });
    }
  }

  const failures = [];
  for (const t of targets) {
    if (!fs.existsSync(t.path)) continue; // Missing file is not a parse error.
    try {
      execFileSync('node', ['--check', t.path], { stdio: 'pipe', timeout: 10000 });
    } catch (err) {
      // execFileSync surfaces stderr in err.stderr (Buffer) for non-zero exits.
      const stderr = err?.stderr ? err.stderr.toString() : '';
      const msg = stderr.split('\n').slice(0, 6).join('\n').trim() || err?.message || 'unknown parse error';
      failures.push({ label: t.label, msg });
      console.log(`  ${RED}✗${NC} ${t.label}`);
      for (const line of msg.split('\n').slice(0, 4)) {
        console.log(`      ${line}`);
      }
    }
  }

  const checked = targets.filter(t => fs.existsSync(t.path)).length;
  if (failures.length === 0) {
    console.log(`  ${GREEN}✓ Parsed ${checked} file(s)${NC}`);
    return;
  }

  throw new Error(
    `Parse error in ${failures.length} of ${checked} file(s): ${failures.map(f => f.label).join(', ')}`
  );
}

/**
 * Auto-pull origin/main into the framework checkout when its working tree is
 * clean and the current branch matches the upstream tracking branch.
 *
 * @param {string} frameworkDir Absolute path to the resolved gentyr framework checkout.
 */
function autoPullFrameworkRepo(frameworkDir) {
  // Confirm the framework dir is a git checkout. npm-published installs are
  // not git repos (no .git directory) — bail silently in that case.
  const gitDir = path.join(frameworkDir, '.git');
  let gitDirExists = false;
  try {
    const st = fs.statSync(gitDir);
    gitDirExists = st.isDirectory() || st.isFile(); // worktree .git is a file
  } catch { /* missing — not a git repo */ }
  if (!gitDirExists) return;

  const gitArgs = (...rest) => ['-C', frameworkDir, ...rest];
  const run = (args, opts = {}) => execFileSync('git', args, {
    stdio: 'pipe', encoding: 'utf8', timeout: 15000, ...opts,
  }).trim();

  // Check dirty state — porcelain returns empty when fully clean
  let dirty = '';
  try {
    dirty = run(gitArgs('status', '--porcelain'));
  } catch (err) {
    console.log(`  ${YELLOW}Auto-pull skipped: git status failed in ${frameworkDir} (${err.message})${NC}`);
    return;
  }
  if (dirty) {
    console.log(`  ${YELLOW}Auto-pull skipped: ${frameworkDir} has uncommitted changes — pull manually after committing${NC}`);
    return;
  }

  // Confirm current branch has a tracking upstream — detached HEAD or
  // disconnected branch should not silently move
  let upstream = '';
  try {
    upstream = run(gitArgs('rev-parse', '--abbrev-ref', '@{upstream}'));
  } catch {
    console.log(`  ${YELLOW}Auto-pull skipped: ${frameworkDir} has no tracking upstream${NC}`);
    return;
  }

  // Fetch first so ahead/behind counts are accurate against the latest remote
  try {
    run(gitArgs('fetch', '--quiet', 'origin'), { timeout: 30000 });
  } catch (err) {
    console.log(`  ${YELLOW}Auto-pull skipped: git fetch failed (${err.message})${NC}`);
    return;
  }

  // If local has commits the upstream doesn't, the user is mid-development.
  // Fast-forward pull is impossible anyway — bail.
  let aheadBehind = '0\t0';
  try {
    aheadBehind = run(gitArgs('rev-list', '--left-right', '--count', `${upstream}...HEAD`));
  } catch { /* fall through with 0/0 — pull will no-op or fail safely */ }
  const [behind, ahead] = aheadBehind.split(/\s+/).map((n) => parseInt(n, 10) || 0);
  if (ahead > 0) {
    console.log(`  ${YELLOW}Auto-pull skipped: ${frameworkDir} is ${ahead} commit(s) ahead of ${upstream} (active development)${NC}`);
    return;
  }
  if (behind === 0) {
    // Already up to date — silent
    return;
  }

  // Fast-forward pull
  try {
    run(gitArgs('pull', '--ff-only', '--quiet'), { timeout: 30000 });
    console.log(`  ${GREEN}Pulled ${behind} commit(s) from ${upstream} into ${frameworkDir}${NC}`);
  } catch (err) {
    console.log(`  ${YELLOW}Auto-pull failed (non-fatal): ${err.message}${NC}`);
  }
}

/**
 * Phase 2c — force-restart every worker launchd/systemd-user service so each
 * daemon picks up the framework code that was just pulled (Phase 0) and/or
 * rebuilt in this sync. KeepAlive=true means launchd re-launches the process
 * on its own after the kill.
 *
 * Without this, the MCP daemon is the only daemon `npx gentyr sync` actually
 * restarts; every other daemon keeps the previous process image in memory and
 * silently runs stale code — exactly the failure mode that left PR #718's
 * `work_category_backfill_v2` marker bump dormant across the user's sync until
 * the token-usage-collector daemon was manually kicked.
 *
 * Non-fatal: per-daemon failures (service not installed, launchctl missing)
 * print a yellow warning and continue. Linux uses `systemctl --user restart`
 * which is both idempotent and handles the kill + restart in one shot.
 *
 * @param {string} _projectDir Reserved for future per-daemon health-polling.
 */
async function restartWorkerDaemons(_projectDir) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return; // Other platforms have no automation services to restart.
  }

  console.log(`  Restarting ${WORKER_DAEMON_LABELS.length} worker daemon(s) so they pick up fresh code...`);
  const restarted = [];
  const bootstrapped = [];
  const failed = [];

  for (const label of WORKER_DAEMON_LABELS) {
    if (process.platform === 'darwin') {
      const domain = `gui/${process.getuid()}`;
      try {
        execFileSync('launchctl', ['kickstart', '-k', `${domain}/${label}`], {
          stdio: 'pipe', timeout: 10000,
        });
        restarted.push(label);
      } catch (err) {
        // launchctl's "service not loaded" error has varied across macOS
        // versions: "Could not find service ... in domain for user gui: 501"
        // (Sequoia), "Could not find specified service" (older), and
        // "3: No such process" (very old). Match all three.
        const msg = String(err.stderr || err.message || '');
        const notLoaded = /Could not find( specified)? service|No such process|3: No such process/i.test(msg);
        if (notLoaded) {
          // Plist on disk but never bootstrapped (or booted out and not reloaded)
          // is the failure mode that motivated this fix: setup-automation-service.sh
          // wrote the plists but `launchctl bootstrap` failed silently, so the
          // user runs `npx gentyr sync` for months with these daemons offline.
          // Auto-recover by bootstrapping the plist if it exists.
          const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
          if (fs.existsSync(plistPath)) {
            try {
              execFileSync('launchctl', ['bootstrap', domain, plistPath], {
                stdio: 'pipe', timeout: 10000,
              });
              bootstrapped.push(label);
            } catch (bootErr) {
              const bootMsg = String(bootErr.stderr || bootErr.message || '').trim().split('\n')[0] || 'unknown';
              failed.push({ label, error: `bootstrap failed: ${bootMsg}` });
            }
          }
          // No plist on disk → user hasn't run setup-automation-service.sh for
          // this daemon. Silent skip (legitimate "not installed" case).
        } else {
          failed.push({ label, error: msg.trim().split('\n')[0] || 'unknown' });
        }
      }
    } else if (process.platform === 'linux') {
      // Translate label to systemd unit name (drop com.local.gentyr- prefix,
      // append .service). e.g. com.local.gentyr-token-usage-collector →
      // gentyr-token-usage-collector.service
      const unit = `${label.replace(/^com\.local\./, '')}.service`;
      try {
        execFileSync('systemctl', ['--user', 'restart', unit], { stdio: 'pipe', timeout: 15000 });
        restarted.push(label);
      } catch (err) {
        const msg = String(err.stderr || err.message || '');
        if (/Unit .* could not be found|not loaded/i.test(msg)) {
          // Not loaded — silent skip
        } else {
          failed.push({ label, error: msg.trim().split('\n')[0] || 'unknown' });
        }
      }
    }
  }

  if (restarted.length > 0) {
    console.log(`  ${GREEN}Worker daemons restarted: ${restarted.length}${NC}`);
  }
  if (bootstrapped.length > 0) {
    console.log(`  ${GREEN}Worker daemons bootstrapped (were not loaded): ${bootstrapped.length}${NC}`);
    for (const label of bootstrapped) {
      console.log(`    + ${label}`);
    }
  }
  for (const { label, error } of failed) {
    console.log(`  ${YELLOW}Worker daemon restart failed: ${label} (${error})${NC}`);
  }
}

async function ensureMcpDaemonHealthy(projectDir) {
  const stateFile = path.join(projectDir, '.claude', 'state', 'shared-mcp-daemon.json');

  // If no state file exists the daemon was never installed — skip silently
  if (!fs.existsSync(stateFile)) return;

  let daemonState;
  try {
    daemonState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return; // Unreadable state file — daemon may be mid-restart
  }

  const port = daemonState.port || 18090;
  const statePid = daemonState.pid;

  // ── Always restart during sync to pick up new code/credentials ─────────────
  {
    console.log(`  Restarting MCP daemon to pick up changes...`);

    // ── Kill zombie process ──────────────────────────────────────────────────
    // Kill by state-file PID
    if (statePid) {
      try {
        process.kill(statePid, 'SIGTERM');
      } catch { /* ESRCH = already dead */ }
    }

    // Kill any process still holding the port
    try {
      const pids = execFileSync('lsof', ['-ti', `:${port}`], { stdio: 'pipe', timeout: 5000, encoding: 'utf8' }).trim();
      for (const pid of pids.split('\n').filter(Boolean)) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch { /* ESRCH */ }
      }
    } catch { /* lsof exits non-zero when nothing is found */ }

    // ── Restart via service manager ─────────────────────────────────────────
    let restarted = false;

    if (process.platform === 'darwin') {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.local.gentyr-mcp-daemon.plist');
      if (fs.existsSync(plistPath)) {
        try {
          execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, plistPath], { stdio: 'pipe', timeout: 10000 });
        } catch { /* may already be unloaded */ }

        // Allow launchd to fully deregister before re-bootstrap
        await new Promise(r => setTimeout(r, 1000));

        try {
          execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath], { stdio: 'pipe', timeout: 10000 });
          restarted = true;
        } catch (err) {
          // Fallback to legacy launchctl load
          try {
            execFileSync('launchctl', ['load', plistPath], { stdio: 'pipe', timeout: 10000 });
            restarted = true;
          } catch {
            console.log(`  ${YELLOW}Warning: launchctl bootstrap and load both failed: ${err.message}${NC}`);
          }
        }
      }
    } else if (process.platform === 'linux') {
      try {
        execFileSync('systemctl', ['--user', 'restart', 'gentyr-mcp-daemon.service'], { stdio: 'pipe', timeout: 15000 });
        restarted = true;
      } catch (err) {
        console.log(`  ${YELLOW}Warning: systemctl restart failed: ${err.message}${NC}`);
      }
    }

    if (!restarted) {
      console.log(`  ${YELLOW}MCP daemon restart skipped (no service manager available)${NC}`);
      return;
    }
  }

  // ── Poll for health (up to 30 seconds) ────────────────────────────────────
  const deadline = Date.now() + 30000;
  const pollInterval = 1000;
  let finalStatus = false;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval));
    const status = await checkDaemonHealth(port);
    if (status === 'ok') { finalStatus = true; break; }
    // 'starting' means alive but not ready — keep polling
  }

  if (finalStatus) {
    console.log(`  ${GREEN}MCP daemon restarted successfully (port ${port})${NC}`);
  } else {
    console.log(`  ${RED}MCP daemon did not recover within 30 seconds — sessions may lack Tier-1 tools${NC}`);
  }
}

/**
 * Recycle all running automated sessions so they pick up new MCP servers/configs.
 * Reuses the kill/re-enqueue pattern from the agent-tracker restart_session MCP tool.
 * Non-fatal — sync succeeds even if recycling fails.
 * @param {string} projectDir
 */
/**
 * Compute a content hash over the `dist/` outputs of every MCP server. Used to
 * detect whether a sync's MCP rebuild actually changed any bytes — if not,
 * fresh-heartbeat persistent monitors can be left alone because the new code
 * and tool schemas are identical to what they're already running against.
 *
 * Hashes every `.js` file recursively under `<mcpDir>/dist/`. Stable: same set
 * of files in the same order produce the same digest. Missing `dist/` returns
 * the empty-string sentinel so first-run sync forces a recycle (safe default).
 *
 * @param {string} mcpDir Absolute path to `packages/mcp-servers`.
 * @returns {string} hex SHA-256 of the dist tree, or '' when dist is absent.
 */
function hashMcpServerDist(mcpDir) {
  const distDir = path.join(mcpDir, 'dist');
  if (!fs.existsSync(distDir)) return '';
  const h = createHash('sha256');
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile() && ent.name.endsWith('.js')) {
        try {
          h.update(`${path.relative(distDir, p)}\n`);
          h.update(fs.readFileSync(p));
        } catch { /* skip unreadable */ }
      }
    }
  }
  walk(distDir);
  return h.digest('hex');
}

/**
 * Read a persistent task's last_heartbeat (ISO timestamp) directly from
 * persistent-tasks.db. Used by the session recycler to decide whether a
 * persistent monitor is fresh enough to skip recycling. Returns null on any
 * read error or when the task row is missing — the caller treats null as
 * "recycle" (fail-closed).
 *
 * @param {string} projectDir
 * @param {object} BetterSqlite Database constructor (already loaded by caller)
 * @param {string} persistentTaskId
 * @returns {string|null} ISO timestamp or null
 */
function readPersistentTaskHeartbeat(projectDir, BetterSqlite, persistentTaskId) {
  const ptDbPath = path.join(projectDir, '.claude', 'state', 'persistent-tasks.db');
  if (!fs.existsSync(ptDbPath)) return null;
  let db;
  try {
    db = new BetterSqlite(ptDbPath, { readonly: true });
    db.pragma('busy_timeout = 2000');
    const row = db.prepare('SELECT last_heartbeat FROM persistent_tasks WHERE id = ?').get(persistentTaskId);
    return row?.last_heartbeat ?? null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}

async function recycleAutomatedSessions(projectDir, opts = {}) {
  const { mcpServersChanged = true } = opts;
  const queueDbPath = path.join(projectDir, '.claude', 'state', 'session-queue.db');
  if (!fs.existsSync(queueDbPath)) return; // No queue — nothing to recycle

  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    console.log(`  ${YELLOW}Warning: better-sqlite3 not available, skipping session recycling${NC}`);
    return;
  }

  // ── Phase 1: Enumerate running sessions ───────────────────────────────────
  let items;
  try {
    const db = new Database(queueDbPath, { readonly: true });
    db.pragma('busy_timeout = 3000');
    items = db.prepare(
      "SELECT * FROM queue_items WHERE status IN ('running', 'spawning') AND lane NOT IN ('gate', 'audit')"
    ).all();
    db.close();
  } catch (err) {
    console.log(`  ${YELLOW}Warning: Could not read session queue: ${err.message}${NC}`);
    return;
  }

  // ── Phase 1.5: Skip fresh-heartbeat persistent monitors on no-op syncs ────
  // When MCP server dist content is unchanged, in-flight persistent-task
  // monitors with a recent heartbeat (<5 min) are running against code that
  // matches what's now on disk. Killing them just to re-spawn from the same
  // session JSONL wastes 30-60s per pipeline and risks orphaning child
  // agents that were mid-work. Preserve them.
  //
  // Fresh-heartbeat persistent monitors with mcpServersChanged=true still
  // recycle (they need the new tool schemas). Stale-heartbeat monitors
  // always recycle (the recycler is the right hammer for stuck sessions).
  // All other lanes (task-runner, preview-promoter, etc.) always recycle.
  const FRESH_HEARTBEAT_MS = 5 * 60 * 1000;
  const preserved = [];
  if (!mcpServersChanged) {
    const filtered = [];
    for (const item of items) {
      if (item.agent_type !== 'persistent-task-monitor') {
        filtered.push(item);
        continue;
      }
      let meta;
      try { meta = item.metadata ? JSON.parse(item.metadata) : null; } catch { meta = null; }
      const persistentTaskId = meta?.persistentTaskId;
      if (!persistentTaskId) {
        filtered.push(item);
        continue;
      }
      const hb = readPersistentTaskHeartbeat(projectDir, Database, persistentTaskId);
      if (!hb) {
        filtered.push(item);
        continue;
      }
      const ageMs = Date.now() - new Date(hb).getTime();
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < FRESH_HEARTBEAT_MS) {
        preserved.push({ item, hbAgeSec: Math.round(ageMs / 1000) });
      } else {
        filtered.push(item);
      }
    }
    items = filtered;
  }

  if (preserved.length > 0) {
    console.log(`  ${GREEN}Preserved ${preserved.length} fresh-heartbeat persistent monitor(s) (MCP unchanged):${NC}`);
    for (const { item, hbAgeSec } of preserved) {
      console.log(`    • ${item.title || item.id} (heartbeat ${hbAgeSec}s ago)`);
    }
  }

  if (items.length === 0) {
    console.log('  No active automated sessions to recycle');
    return;
  }

  console.log(`\n${YELLOW}Recycling ${items.length} automated session(s)...${NC}`);

  // ── Phase 2: Kill all sessions (free capacity first) ──────────────────────
  // Single write connection for all status updates
  let queueDb;
  try {
    queueDb = new Database(queueDbPath);
    queueDb.pragma('busy_timeout = 3000');
  } catch (err) {
    console.log(`  ${YELLOW}Warning: Could not open session queue for writing: ${err.message}${NC}`);
    return;
  }

  // Pre-load resource-lock and audit modules once
  let resourceModule, auditModule;
  try {
    const resourceLockPath = path.join(projectDir, '.claude', 'hooks', 'lib', 'resource-lock.js');
    if (fs.existsSync(resourceLockPath)) resourceModule = await import(resourceLockPath);
  } catch (err) {
    console.log(`  ${YELLOW}Warning: Could not load resource-lock.js: ${err.message}${NC}`);
  }
  try {
    const auditPath = path.join(projectDir, '.claude', 'hooks', 'lib', 'session-audit.js');
    if (fs.existsSync(auditPath)) auditModule = await import(auditPath);
  } catch (err) {
    console.log(`  ${YELLOW}Warning: Could not load session-audit.js: ${err.message}${NC}`);
  }

  const killFailed = new Set(); // Track items where mark-failed failed — skip re-enqueue

  for (const item of items) {
    const title = item.title || item.id;
    console.log(`  Killing: ${title} (pid=${item.pid})`);

    // Kill process — same SIGTERM->SIGKILL pattern as restartSession
    if (item.pid) {
      try {
        process.kill(item.pid, 'SIGTERM');
        let dead = false;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          try { process.kill(item.pid, 0); } catch { dead = true; break; }
        }
        if (!dead) {
          try { process.kill(item.pid, 'SIGKILL'); } catch { /* ESRCH = already dead */ }
        }
      } catch { /* ESRCH = already dead */ }
    }

    // Mark old item failed — CRITICAL: if this fails, dedup guard will block re-enqueue
    try {
      queueDb.prepare(
        "UPDATE queue_items SET status = 'failed', error = 'recycled_by_sync', completed_at = datetime('now') WHERE id = ?"
      ).run(item.id);
    } catch (err) {
      console.log(`  ${RED}Error marking ${title} as failed: ${err.message} — skipping re-enqueue${NC}`);
      killFailed.add(item.id);
      continue;
    }

    // Reset linked TODO task to pending
    try {
      const metadata = item.metadata ? JSON.parse(item.metadata) : {};
      if (metadata.taskId) {
        for (const rel of ['.claude/todo.db', '.claude/state/todo.db']) {
          const todoPath = path.join(projectDir, rel);
          if (fs.existsSync(todoPath)) {
            const todoDb = new Database(todoPath);
            todoDb.pragma('busy_timeout = 3000');
            todoDb.prepare("UPDATE tasks SET status = 'pending' WHERE id = ? AND status = 'in_progress'").run(metadata.taskId);
            todoDb.close();
            break;
          }
        }
      }
    } catch (err) {
      console.log(`  ${YELLOW}Warning: Could not reset TODO task for ${title}: ${err.message}${NC}`);
    }

    // Release shared resources
    try {
      if (typeof resourceModule?.releaseAllResources === 'function') {
        resourceModule.releaseAllResources(item.agent_id || item.id);
      }
      if (typeof resourceModule?.removeFromAllQueues === 'function') {
        resourceModule.removeFromAllQueues(item.agent_id || item.id);
      }
    } catch (err) {
      console.log(`  ${YELLOW}Warning: Could not release resources for ${title}: ${err.message}${NC}`);
    }

    // Audit
    try {
      if (typeof auditModule?.auditEvent === 'function') {
        auditModule.auditEvent('session_sync_recycled', {
          queue_id: item.id, agent_id: item.agent_id, pid: item.pid, title,
        });
      }
    } catch (err) {
      console.log(`  ${YELLOW}Warning: Audit event failed for ${title}: ${err.message}${NC}`);
    }

    console.log(`  Killed: ${title}`);
  }

  try { queueDb.close(); } catch { /* best-effort */ }

  // ── Phase 2b: Ensure MCP daemon is healthy before reviving sessions ────────
  // Killed sessions will reconnect to Tier-1 MCP servers on spawn.  If the
  // daemon is in a zombie state (process alive but port not listening) they
  // would silently lose access to all Tier-1 tools.  Restart it now while the
  // session slots are free so every revived session gets a fresh connection.
  try {
    await ensureMcpDaemonHealthy(projectDir);
  } catch (err) {
    console.log(`  ${YELLOW}Warning: MCP daemon health check threw: ${err.message}${NC}`);
  }

  // ── Phase 2c: Force-restart worker daemons so they pick up new code ───────
  // Every long-running daemon (token-usage-collector, revival-daemon,
  // session-activity-broadcaster, etc.) holds the gentyr framework source in
  // memory. Without an explicit kickstart, a `npx gentyr sync` after a
  // framework update leaves the previous process image running stale code —
  // exactly how PR #718's `work_category_backfill_v2` marker bump went
  // dormant. Phase 2b already restarts the MCP daemon with its own bespoke
  // logic; this pass covers everything else.
  try {
    await restartWorkerDaemons(projectDir);
  } catch (err) {
    console.log(`  ${YELLOW}Warning: worker daemon restart pass threw: ${err.message}${NC}`);
  }

  // ── Phase 3: Re-enqueue all with resume ───────────────────────────────────
  // Ensure PROJECT_DIR resolves correctly when session-queue.js is loaded
  process.env.CLAUDE_PROJECT_DIR = projectDir;

  let enqueueSession, drainQueue, findSessionFile, getSessionDirFn, getSessionDirForCwdFn, extractSessionId;
  try {
    const queueModulePath = path.join(projectDir, '.claude', 'hooks', 'lib', 'session-queue.js');
    const queueModule = await import(queueModulePath);
    enqueueSession = queueModule.enqueueSession;
    drainQueue = queueModule.drainQueue;
    findSessionFile = queueModule.findSessionFileByAgentId;
    getSessionDirFn = queueModule.getSessionDir;
    getSessionDirForCwdFn = queueModule.getSessionDirForCwd;
    extractSessionId = queueModule.extractSessionIdFromPath;
  } catch (err) {
    console.log(`  ${YELLOW}Warning: Could not load session-queue.js: ${err.message}${NC}`);
    return;
  }

  const revived = []; // { title, oldQueueId, newQueueId }

  for (const item of items) {
    if (killFailed.has(item.id)) continue; // mark-failed failed — skip re-enqueue

    const title = item.title || item.id;

    // Resolve session ID for --resume. Priority:
    // 1. resume_session_id already stored on queue item (backfilled by drain cycle)
    // 2. Targeted file scan — CWD-specific dir first, then main project dir
    // 3. Skip with warning — never spawn fresh (progress would be lost)
    let spawnType = 'fresh';
    let resumeSessionId = item.resume_session_id || null;
    if (resumeSessionId) {
      spawnType = 'resume';
    } else if (findSessionFile && item.agent_id) {
      // Try CWD-specific directory first (fast — targets the exact worktree dir)
      const cwdPath = item.cwd || item.worktree_path;
      if (cwdPath && getSessionDirForCwdFn) {
        const cwdDir = getSessionDirForCwdFn(cwdPath);
        if (cwdDir) {
          const sessionFile = findSessionFile(cwdDir, item.agent_id);
          if (sessionFile) {
            const sid = extractSessionId?.(sessionFile);
            if (sid) { spawnType = 'resume'; resumeSessionId = sid; }
          }
        }
      }
      // Fall back to main project session directory
      if (spawnType === 'fresh' && getSessionDirFn) {
        const mainDir = getSessionDirFn(projectDir);
        if (mainDir) {
          const sessionFile = findSessionFile(mainDir, item.agent_id);
          if (sessionFile) {
            const sid = extractSessionId?.(sessionFile);
            if (sid) { spawnType = 'resume'; resumeSessionId = sid; }
          }
        }
      }
    }
    if (spawnType === 'fresh') {
      console.log(`  ${YELLOW}Warning: Cannot find session file for "${title}" (agent_id: ${item.agent_id || 'null'}) — skipping to avoid progress loss${NC}`);
      continue;
    }

    try {
      // Validate worktree still exists — skip stale paths from cleaned-up worktrees
      let worktreePath = item.worktree_path || undefined;
      if (worktreePath && !fs.existsSync(worktreePath)) {
        console.log(`  ${YELLOW}Warning: Worktree ${worktreePath} no longer exists — spawning without worktree${NC}`);
        worktreePath = undefined;
      }

      const result = enqueueSession({
        title: item.title || 'Recycled session',
        agentType: item.agent_type,
        hookType: item.hook_type,
        tagContext: item.tag_context || undefined,
        source: 'sync-recycle',
        priority: 'urgent',
        lane: item.lane || 'standard',
        prompt: item.prompt,
        model: item.model || undefined,
        projectDir: item.project_dir || projectDir,
        extraEnv: item.extra_env ? JSON.parse(item.extra_env) : undefined,
        metadata: item.metadata ? JSON.parse(item.metadata) : undefined,
        worktreePath,
        agent: item.agent || undefined,
        spawnType,
        resumeSessionId,
      });

      const newQueueId = result?.queueId;
      revived.push({ title, oldQueueId: item.id, newQueueId });

      if (auditModule?.auditEvent) {
        auditModule.auditEvent('session_sync_revived', {
          old_queue_id: item.id, new_queue_id: newQueueId, title, spawn_type: spawnType,
        });
      }

      console.log(`  Revived: ${title} -> ${newQueueId || '(queued)'}${spawnType === 'resume' ? ' (resumed)' : ' (fresh)'}`);
    } catch (err) {
      console.log(`  ${RED}Error re-enqueuing ${title}: ${err.message}${NC}`);
    }
  }

  // ── Phase 4: Final drain ──────────────────────────────────────────────────
  try {
    drainQueue();
  } catch (err) {
    console.log(`  ${YELLOW}Warning: drainQueue failed: ${err.message}${NC}`);
  }

  // ── Phase 5: Verify revival ───────────────────────────────────────────────
  if (revived.length === 0) return;

  console.log('  Verifying revival...');
  await new Promise(r => setTimeout(r, 5000)); // Initial startup delay

  const maxPollMs = 30000;
  const pollInterval = 2000;
  const deadline = Date.now() + maxPollMs;
  const verified = new Set();

  while (Date.now() < deadline && verified.size < revived.length) {
    let db;
    try {
      db = new Database(queueDbPath, { readonly: true });
      db.pragma('busy_timeout = 3000');
      for (const entry of revived) {
        if (verified.has(entry.newQueueId)) continue;
        if (!entry.newQueueId) continue;
        const row = db.prepare('SELECT status, pid FROM queue_items WHERE id = ?').get(entry.newQueueId);
        if (row && row.status === 'running' && row.pid) {
          try {
            process.kill(row.pid, 0); // Signal 0 = existence check
            verified.add(entry.newQueueId);
          } catch { /* not alive yet */ }
        }
      }
      db.close();
    } catch {
      try { db?.close(); } catch { /* best-effort */ }
    }

    if (verified.size < revived.length) {
      await new Promise(r => setTimeout(r, pollInterval));
    }
  }

  // Log verification results
  for (const entry of revived) {
    if (verified.has(entry.newQueueId)) {
      console.log(`  ${GREEN}Verified: ${entry.title} (active)${NC}`);
    } else {
      console.log(`  ${YELLOW}Unverified: ${entry.title} (still starting?)${NC}`);
    }
  }
}

export default async function sync(args) {
  const projectDir = process.cwd();

  const model = detectInstallModel(projectDir);
  if (!model) {
    console.error(`${RED}Error: GENTYR not found in this project.${NC}`);
    console.error('Run `npx gentyr init` first.');
    process.exit(1);
  }

  let frameworkDir = resolveFrameworkDir(projectDir);

  // Health check: repair broken node_modules/gentyr symlink
  if (model === 'npm') {
    const npmPath = path.join(projectDir, 'node_modules', 'gentyr');
    let npmBroken = false;
    try {
      fs.realpathSync(npmPath);
    } catch {
      npmBroken = true;
    }
    if (npmBroken && frameworkDir) {
      // Symlink exists (lstat passed) but target doesn't (realpath failed)
      // Repair by pointing to the framework dir we resolved via fallback
      console.log(`\n${YELLOW}Repairing broken node_modules/gentyr symlink...${NC}`);
      try {
        fs.unlinkSync(npmPath);
        fs.symlinkSync(frameworkDir, npmPath);
        console.log(`  Repaired: node_modules/gentyr -> ${frameworkDir}`);
        // Re-resolve now that the symlink is fixed
        frameworkDir = resolveFrameworkDir(projectDir);
      } catch (err) {
        console.log(`  ${YELLOW}Warning: could not repair symlink: ${err.message}${NC}`);
      }
    } else if (npmBroken && !frameworkDir) {
      console.error(`${RED}Error: node_modules/gentyr symlink is broken and no fallback found.${NC}`);
      console.error('Run `pnpm link ~/git/gentyr` to repair.');
      process.exit(1);
    }
  }

  if (!frameworkDir) {
    console.error(`${RED}Error: Could not resolve GENTYR framework directory.${NC}`);
    console.error('Run `npx gentyr init` or `pnpm link ~/git/gentyr`.');
    process.exit(1);
  }

  const frameworkRel = resolveFrameworkRelative(projectDir);
  const agents = getFrameworkAgents(frameworkDir);

  // ── Phase 0: auto-pull the framework checkout from origin/main when clean ──
  // Target projects symlink node_modules/gentyr to the framework checkout, so a
  // stale local checkout silently runs old code even after the latest fix has
  // landed on GitHub. Running pull BEFORE the rest of sync (build, MCP daemon
  // restart, worker daemon restart, session recycle) is what makes the new
  // code actually take effect in this run.
  try {
    autoPullFrameworkRepo(frameworkDir);
  } catch (err) {
    console.log(`  ${YELLOW}Auto-pull threw (non-fatal): ${err.message}${NC}`);
  }

  // ── Phase 0.5: Node syntax gate ────────────────────────────────────────────
  // Run `node --check` against every critical hook file plus the session-queue
  // and persistent-task helper libraries. A parse error in any of these blows
  // up every spawn path at runtime — force_spawn_tasks, monitor revival,
  // drainQueue, the lot — and the failures surface miles away from the cause.
  // Closes the regression where commit 22bd8af added `await import()` inside
  // a synchronous drainQueue() and broke the entire framework silently.
  //
  // Errors here abort sync (fail-closed). The check is fast (< 1s for ~25
  // files) and reading every file from disk on every sync is the right
  // trade-off — sync is rare, and a broken framework install is worse.
  try {
    runSyntaxGate(frameworkDir);
  } catch (err) {
    console.error('');
    console.error(`${RED}═══════════════════════════════════════════════════════════════${NC}`);
    console.error(`${RED}  SYNTAX CHECK FAILED — sync aborted${NC}`);
    console.error(`${RED}  ${err.message}${NC}`);
    console.error(`${RED}  Fix the parse error above and re-run sync.${NC}`);
    console.error(`${RED}═══════════════════════════════════════════════════════════════${NC}`);
    process.exit(1);
  }

  // Auto-unprotect if needed so sync can write to root-owned files.
  // Wrap in try/catch and verify the file is actually writable afterward. If unprotect
  // throws (sudo prompt timeout, terminal stdin contention, partial chown failure) or
  // leaves services.json root-owned, abort sync with a loud message instead of silently
  // letting steps 1.5/1.6 EACCES and lose staged entries.
  const wasProtected = isProtected(projectDir);
  if (wasProtected) {
    try {
      runUnprotect(projectDir);
    } catch (err) {
      console.error('');
      console.error(`${RED}═══════════════════════════════════════════════════════════════${NC}`);
      console.error(`${RED}  AUTO-UNPROTECT FAILED — sync aborted to prevent silent data loss${NC}`);
      console.error(`${RED}  ${err.message}${NC}`);
      console.error(`${RED}  Pending files (if any) preserved at .claude/state/*-pending.json${NC}`);
      console.error(`${RED}  Recovery: 'sudo true && npx gentyr sync' (primes sudo cache)${NC}`);
      console.error(`${RED}═══════════════════════════════════════════════════════════════${NC}`);
      process.exit(1);
    }
    // Verify-after-unprotect: services.json must not be root-owned. Belt-and-suspenders
    // catches the case where unprotect "succeeded" (exit 0) but missed a file.
    const svcConfigPathEarly = path.join(projectDir, '.claude', 'config', 'services.json');
    try {
      const st = fs.statSync(svcConfigPathEarly);
      if (st.uid === 0) {
        console.error('');
        console.error(`${RED}═══════════════════════════════════════════════════════════════${NC}`);
        console.error(`${RED}  AUTO-UNPROTECT INCOMPLETE — services.json still root-owned${NC}`);
        console.error(`${RED}  ${svcConfigPathEarly}${NC}`);
        console.error(`${RED}  Sync aborted before pending steps to prevent EACCES data loss.${NC}`);
        console.error(`${RED}  Manual recovery: sudo chown $USER:$(id -gn) ${svcConfigPathEarly}${NC}`);
        console.error(`${RED}═══════════════════════════════════════════════════════════════${NC}`);
        process.exit(1);
      }
    } catch (statErr) {
      if (statErr.code !== 'ENOENT') {
        console.error(`${RED}Cannot stat services.json after unprotect: ${statErr.message}${NC}`);
        process.exit(1);
      }
      // ENOENT is fine — services.json will be created by step 1.4
    }
  }

  // Hoisted before try/finally so step 10 (after re-protect, outside the try)
  // can read it. Default `true` keeps the recycler in safe "needs recycle" mode
  // if the MCP build never runs or throws.
  let mcpServersChanged = true;

  // Wrap sync body in try/finally to guarantee re-protect on any failure
  try {

  console.log(`${GREEN}Syncing GENTYR...${NC}`);
  if (isLocalModeEnabled(projectDir)) {
    console.log(`  Local mode: active (remote servers will be excluded from .mcp.json)`);
  }

  // 0. One-time migration: remove rotation proxy remnants from existing installs
  cleanupRotationProxy(projectDir);

  // 1. Re-merge settings.json
  console.log(`\n${YELLOW}Merging settings.json...${NC}`);
  mergeSettings(projectDir, frameworkDir);

  // 1.4. Ensure services.json exists (create scaffold if missing)
  const svcConfigDir = path.join(projectDir, '.claude', 'config');
  const svcConfigPath = path.join(svcConfigDir, 'services.json');
  const svcBackupPath = path.join(projectDir, '.claude', 'state', 'services.json.backup');
  const hasSecretsLocal = (d) => {
    const secrets = d?.secrets;
    const local = secrets?.local;
    return !!local && typeof local === 'object' && Object.keys(local).length > 0;
  };
  if (!fs.existsSync(svcConfigPath)) {
    console.log(`\n${YELLOW}Creating services.json scaffold...${NC}`);
    fs.mkdirSync(svcConfigDir, { recursive: true });
    fs.writeFileSync(svcConfigPath, JSON.stringify({ secrets: {} }, null, 2) + '\n');
    console.log(`  Created ${svcConfigPath}`);
  } else {
    // 1.4b. Auto-repair services.json shape. The schema makes `secrets` optional, but every
    // secret-sync MCP tool expects the key to exist. A config missing `secrets` causes
    // populate_secrets_local / register_secret_profile to fail and pending files to pile up
    // unnoticed across multiple sync runs. Repair the file in place before the pending steps
    // run so they can land cleanly.
    try {
      const raw = fs.readFileSync(svcConfigPath, 'utf8');
      let parsed;
      let parseFailed = false;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parseFailed = true;
      }

      if (parseFailed) {
        // File is corrupt. Try the backup before giving up.
        let restored = false;
        if (fs.existsSync(svcBackupPath)) {
          try {
            const backupRaw = fs.readFileSync(svcBackupPath, 'utf8');
            const backupParsed = JSON.parse(backupRaw);
            if (backupParsed && typeof backupParsed === 'object') {
              if (!backupParsed.secrets) backupParsed.secrets = {};
              fs.writeFileSync(svcConfigPath, JSON.stringify(backupParsed, null, 2) + '\n');
              console.log(`\n${YELLOW}Repaired corrupt services.json from backup${NC}`);
              restored = true;
            }
          } catch { /* fall through */ }
        }
        if (!restored) {
          // Last resort: stash the unparseable file and write a fresh scaffold.
          const stashPath = `${svcConfigPath}.corrupt.${Date.now()}`;
          fs.renameSync(svcConfigPath, stashPath);
          fs.writeFileSync(svcConfigPath, JSON.stringify({ secrets: {} }, null, 2) + '\n');
          console.log(`\n${RED}services.json was unparseable. Stashed to ${stashPath} and wrote fresh scaffold.${NC}`);
        }
      } else if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        // Parseable but not an object — stash and reset.
        const stashPath = `${svcConfigPath}.invalid.${Date.now()}`;
        fs.renameSync(svcConfigPath, stashPath);
        fs.writeFileSync(svcConfigPath, JSON.stringify({ secrets: {} }, null, 2) + '\n');
        console.log(`\n${RED}services.json was not an object. Stashed to ${stashPath} and wrote fresh scaffold.${NC}`);
      } else if (!('secrets' in parsed) || parsed.secrets === null) {
        // Most common repair case: file exists, parses fine, but the `secrets` key is
        // missing or null. Add it without touching any other field.
        parsed.secrets = {};
        fs.writeFileSync(svcConfigPath, JSON.stringify(parsed, null, 2) + '\n');
        console.log(`\n${YELLOW}Repaired services.json: added missing 'secrets' key${NC}`);
      }
    } catch (err) {
      // Repair is best-effort. If EACCES, auto-unprotect should have chowned the file but
      // didn't — attempt a one-shot sudo chown and retry. If still failing, fall through
      // and let the pending-application steps surface the issue via the end-of-sync banner.
      if (err.code === 'EACCES') {
        try {
          const user = process.env.USER || 'unknown';
          const groupOut = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
          execFileSync('sudo', ['chown', `${user}:${groupOut}`, svcConfigPath], { stdio: 'inherit' });
          // Retry repair after taking ownership
          const raw = fs.readFileSync(svcConfigPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (!('secrets' in parsed) || parsed.secrets === null)) {
            parsed.secrets = {};
            fs.writeFileSync(svcConfigPath, JSON.stringify(parsed, null, 2) + '\n');
            console.log(`\n${YELLOW}Repaired services.json: added missing 'secrets' key (after sudo chown)${NC}`);
          }
        } catch { /* fall through — pending steps will report any remaining EACCES */ }
      } else {
        console.log(`\n${YELLOW}services.json repair check failed: ${err.message} (non-fatal)${NC}`);
      }
    }
  }

  // Track pending-application outcomes for end-of-run summary.
  // Each entry: { kind, applied: number, error?: string }
  const pendingSummary = { applied: [], failed: [] };

  // 1.5. Apply pending services.json config updates (staged by update_services_config MCP tool)
  const pendingConfigPath = path.join(projectDir, '.claude', 'state', 'services-config-pending.json');
  if (fs.existsSync(pendingConfigPath)) {
    console.log(`\n${YELLOW}Applying pending services.json config...${NC}`);
    try {
      const pending = JSON.parse(fs.readFileSync(pendingConfigPath, 'utf8'));
      // Defense-in-depth: strip secrets key even though the MCP tool blocks it
      delete pending.secrets;
      const current = safeReadJson(svcConfigPath, { backupPath: svcBackupPath }) ?? {};
      const merged = { ...current, ...pending };
      // Validate merged config against ServicesConfigSchema (imported dynamically to avoid TS dependency in JS CLI)
      // Lightweight check: ensure no unknown top-level types that would corrupt the file
      if (typeof merged !== 'object' || merged === null) {
        throw new Error('Merged config is not a valid object');
      }
      // Backfill `secrets` if absent — schema makes it optional but every secret tool expects
      // it to exist. Writing a config without `secrets` is how a config can end up in a state
      // where loadServicesConfig succeeds but populate_secrets_local has no parent to merge into.
      if (!merged.secrets) merged.secrets = current.secrets || {};
      safeWriteJson(svcConfigPath, merged, { backupPath: svcBackupPath, backupValidator: hasSecretsLocal });
      fs.unlinkSync(pendingConfigPath);
      console.log(`  Applied ${Object.keys(pending).length} pending config update(s)`);
      pendingSummary.applied.push({ kind: 'services.json config', count: Object.keys(pending).length });
    } catch (err) {
      console.log(`  ${RED}Warning: Failed to apply pending config: ${err.message}${NC}`);
      pendingSummary.failed.push({ kind: 'services.json config', error: err.message, code: err.code });
      // Preserve pending file for inspection on failure
    }
  }

  // 1.6. Apply pending secrets.local entries (staged by populate_secrets_local MCP tool)
  const pendingSecretsPath = path.join(projectDir, '.claude', 'state', 'secrets-local-pending.json');
  if (fs.existsSync(pendingSecretsPath)) {
    console.log(`\n${YELLOW}Applying pending secrets.local entries...${NC}`);
    try {
      const pending = JSON.parse(fs.readFileSync(pendingSecretsPath, 'utf8'));
      const rawEntries = pending.entries || {};
      // Validate all values are op:// references (format check only)
      for (const [key, val] of Object.entries(rawEntries)) {
        if (typeof val !== 'string' || !val.startsWith('op://')) {
          throw new Error(`Invalid entry: ${key} is not an op:// reference`);
        }
      }

      // Idempotency pre-filter: drop pending entries that are already in
      // services.json with the same value. These are leftovers from the
      // pre-fix re-stage loop (revived agents called populate_secrets_local
      // with keys that were already applied). Removing them now both skips
      // the op CLI validation cost and cleans up the pending file.
      let preFilterStaleSkipped = 0;
      const entries = {};
      try {
        const currentBefore = safeReadJson(svcConfigPath, { backupPath: svcBackupPath }) ?? {};
        const currentLocal = (currentBefore.secrets && currentBefore.secrets.local) || {};
        for (const [key, val] of Object.entries(rawEntries)) {
          if (currentLocal[key] === val) preFilterStaleSkipped++;
          else entries[key] = val;
        }
      } catch {
        // Cannot read services.json — apply everything (preserve old behavior)
        Object.assign(entries, rawEntries);
      }
      if (preFilterStaleSkipped > 0) {
        console.log(`  ${YELLOW}Skipped ${preFilterStaleSkipped} stale pending entr${preFilterStaleSkipped === 1 ? 'y' : 'ies'} (already in services.json)${NC}`);
      }

      // Per-entry op:// resolution check. Catches ambiguous titles, missing
      // fields, wrong section paths — failure modes that the old code silently
      // wrote into services.json where they'd only fail at runtime.
      const opToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
      let opAvailable = false;
      if (opToken) {
        try {
          execFileSync('op', ['--version'], { stdio: 'pipe', timeout: 5000 });
          opAvailable = true;
        } catch { /* op CLI missing — fall through to skip-validation path */ }
      }

      const validationResults = {};
      if (opAvailable) {
        const opEnv = { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: opToken };
        for (const [key, ref] of Object.entries(entries)) {
          try {
            execFileSync('op', ['read', '--no-newline', ref], {
              stdio: 'pipe', timeout: 15000, env: opEnv,
            });
            validationResults[key] = { ok: true };
          } catch (opErr) {
            const stderr = (opErr.stderr && opErr.stderr.toString()) || '';
            const stdout = (opErr.stdout && opErr.stdout.toString()) || '';
            const combined = (stderr + stdout).trim();
            // Pull the most informative line (op typically prints "[ERROR] ...")
            const errLine = combined.split('\n').reverse().find(l => /\S/.test(l)) || opErr.message;
            let suggestion = '';
            if (/more than one item matches/i.test(combined)) {
              suggestion = ' (ambiguous title — re-stage using item-ID form: op://Vault/<item-id>/field)';
            } else if (/isn't an item|isn't a field|couldn't find|no field/i.test(combined)) {
              suggestion = ' (check vault, item ID, section path, and field name)';
            }
            validationResults[key] = { ok: false, error: errLine.trim() + suggestion };
          }
        }
      } else {
        const reason = opToken ? 'op CLI not available' : 'OP_SERVICE_ACCOUNT_TOKEN not set';
        console.log(`  ${YELLOW}Skipping op:// validation (${reason}) — entries will be written unverified${NC}`);
        for (const key of Object.keys(entries)) validationResults[key] = { ok: true, unvalidated: true };
      }

      // Partition into valid and failed
      const validEntries = {};
      const failedEntries = {};
      for (const [key, val] of Object.entries(entries)) {
        if (validationResults[key].ok) validEntries[key] = val;
        else failedEntries[key] = val;
      }

      // Apply valid entries to services.json
      if (Object.keys(validEntries).length > 0) {
        const current = safeReadJson(svcConfigPath, { backupPath: svcBackupPath }) ?? {};
        if (!current.secrets) current.secrets = {};
        if (!current.secrets.local) current.secrets.local = {};
        Object.assign(current.secrets.local, validEntries);
        safeWriteJson(svcConfigPath, current, { backupPath: svcBackupPath, backupValidator: hasSecretsLocal });
        // Verify post-write: confirm valid keys actually landed in services.json.
        // Catches the case where safeWriteJson "succeeded" but the file is
        // stale (e.g., shadow copy, FUSE oddity).
        const verify = safeReadJson(svcConfigPath, { backupPath: svcBackupPath }) ?? {};
        const verifyLocal = (verify.secrets && verify.secrets.local) || {};
        const missing = Object.keys(validEntries).filter(k => !(k in verifyLocal));
        if (missing.length > 0) {
          throw new Error(`Post-write verification failed: ${missing.length} key(s) missing from services.json (${missing.join(', ')})`);
        }
      }

      // Print per-entry status
      for (const [key, val] of Object.entries(entries)) {
        const r = validationResults[key];
        if (r.unvalidated) {
          console.log(`  ${GREEN}~${NC} ${key} (applied, not validated)`);
        } else if (r.ok) {
          console.log(`  ${GREEN}✓${NC} ${key}`);
        } else {
          console.log(`  ${RED}✗${NC} ${key} ← ${val}`);
          console.log(`      ${RED}${r.error}${NC}`);
        }
      }

      // Rewrite or delete pending file based on what survived
      if (Object.keys(failedEntries).length === 0) {
        fs.unlinkSync(pendingSecretsPath);
      } else {
        fs.writeFileSync(pendingSecretsPath, JSON.stringify({
          entries: failedEntries,
          timestamp: new Date().toISOString(),
        }, null, 2) + '\n');
      }

      const applied = Object.keys(validEntries).length;
      const failed = Object.keys(failedEntries).length;
      if (failed === 0) {
        console.log(`  ${GREEN}Applied ${applied} secrets.local entry/entries${NC}`);
        pendingSummary.applied.push({ kind: 'secrets.local', count: applied });
      } else {
        console.log(`  ${YELLOW}Applied ${applied}, failed ${failed} — failed entries kept in secrets-local-pending.json${NC}`);
        pendingSummary.applied.push({ kind: 'secrets.local', count: applied });
        pendingSummary.failed.push({
          kind: 'secrets.local',
          error: `${failed} entr${failed === 1 ? 'y' : 'ies'} failed op:// validation`,
          code: 'OP_RESOLVE_FAIL',
        });
      }
    } catch (err) {
      console.log(`  ${RED}Warning: Failed to apply pending secrets.local: ${err.message}${NC}`);
      pendingSummary.failed.push({ kind: 'secrets.local', error: err.message, code: err.code });
    }
  }

  // 1.6b. Apply pending secrets.fly entries (staged by populate_secrets_fly MCP tool)
  const pendingFlyPath = path.join(projectDir, '.claude', 'state', 'secrets-fly-pending.json');
  if (fs.existsSync(pendingFlyPath)) {
    console.log(`\n${YELLOW}Applying pending secrets.fly entries...${NC}`);
    try {
      const pending = JSON.parse(fs.readFileSync(pendingFlyPath, 'utf8'));
      const flyEntries = pending.entries || {};
      // Validate shape: { appName: { ENV_VAR: "op://..." } }
      for (const [appName, appSecrets] of Object.entries(flyEntries)) {
        if (typeof appSecrets !== 'object' || appSecrets === null) {
          throw new Error(`Invalid entry for app '${appName}': expected object`);
        }
        for (const [key, val] of Object.entries(appSecrets)) {
          if (typeof val !== 'string' || !val.startsWith('op://')) {
            throw new Error(`Invalid entry: ${appName}.${key} is not an op:// reference`);
          }
        }
      }
      const current = safeReadJson(svcConfigPath, { backupPath: svcBackupPath }) ?? {};
      if (!current.secrets) current.secrets = {};
      if (!current.secrets.fly) current.secrets.fly = {};
      let totalEntries = 0;
      for (const [appName, appSecrets] of Object.entries(flyEntries)) {
        if (!current.secrets.fly[appName]) current.secrets.fly[appName] = {};
        Object.assign(current.secrets.fly[appName], appSecrets);
        totalEntries += Object.keys(appSecrets).length;
      }
      safeWriteJson(svcConfigPath, current, { backupPath: svcBackupPath });
      fs.unlinkSync(pendingFlyPath);
      console.log(`  Applied ${totalEntries} secrets.fly entry/entries across ${Object.keys(flyEntries).length} app(s)`);
      pendingSummary.applied.push({ kind: 'secrets.fly', count: totalEntries });
    } catch (err) {
      console.log(`  ${RED}Warning: Failed to apply pending secrets.fly: ${err.message}${NC}`);
      pendingSummary.failed.push({ kind: 'secrets.fly', error: err.message, code: err.code });
    }
  }

  // 1.7. Apply pending MCP server additions (staged by stage_mcp_server MCP tool)
  const pendingMcpPath = path.join(projectDir, '.claude', 'state', 'mcp-servers-pending.json');
  if (fs.existsSync(pendingMcpPath)) {
    console.log(`\n${YELLOW}Applying staged MCP servers...${NC}`);
    try {
      const pending = JSON.parse(fs.readFileSync(pendingMcpPath, 'utf8'));
      const servers = pending.servers || {};
      const serverNames = Object.keys(servers);
      if (serverNames.length > 0) {
        const mcpJsonPath = path.join(projectDir, '.mcp.json');
        let mcpConfig = { mcpServers: {} };
        if (fs.existsSync(mcpJsonPath)) {
          mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
          mcpConfig.mcpServers = mcpConfig.mcpServers || {};
        }
        // Derive gentyr server names from template to prevent collisions
        const templatePath = path.join(frameworkDir, '.mcp.json.template');
        let gentyrNames = new Set();
        try {
          const tpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
          gentyrNames = new Set(Object.keys(tpl.mcpServers || {}));
        } catch {}
        let applied = 0;
        let skipped = 0;
        for (const [name, config] of Object.entries(servers)) {
          if (gentyrNames.has(name) || name === 'plugin-manager' || name.startsWith('plugin-')) {
            console.log(`  Skipped "${name}" (collides with GENTYR server)`);
            skipped++;
          } else {
            mcpConfig.mcpServers[name] = config;
            applied++;
          }
        }
        if (applied > 0) {
          fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n');
        }
        fs.unlinkSync(pendingMcpPath);
        console.log(`  Applied ${applied} staged MCP server(s)${skipped > 0 ? `, skipped ${skipped} collision(s)` : ''}`);
        pendingSummary.applied.push({ kind: 'MCP servers', count: applied });
      } else {
        fs.unlinkSync(pendingMcpPath);
        console.log('  No servers in pending file (cleaned up)');
      }
    } catch (err) {
      console.log(`  ${RED}Warning: Failed to apply staged MCP servers: ${err.message}${NC}`);
      pendingSummary.failed.push({ kind: 'MCP servers', error: err.message, code: err.code });
      // Preserve pending file for inspection on failure
    }
  }

  // 2. Regenerate .mcp.json
  console.log(`\n${YELLOW}Regenerating .mcp.json...${NC}`);
  generateMcpJson(projectDir, frameworkDir, frameworkRel);

  // 3. Update CLAUDE.md
  console.log(`\n${YELLOW}Updating CLAUDE.md...${NC}`);
  updateClaudeMd(projectDir, frameworkDir);

  // 4. Repair directory symlinks
  console.log(`\n${YELLOW}Repairing directory symlinks...${NC}`);
  createDirectorySymlinks(projectDir, frameworkRel);
  createReporterSymlinks(projectDir, frameworkRel);

  // 5. Sync agent symlinks
  console.log(`\n${YELLOW}Syncing agent symlinks...${NC}`);
  createAgentSymlinks(projectDir, frameworkRel, agents);

  // 5a. Migration: restore user ownership of .claude/ if root-owned
  const claudeDir = path.join(projectDir, '.claude');
  try {
    const stat = fs.statSync(claudeDir);
    if (stat.uid === 0) {
      console.log(`\n${YELLOW}Migrating .claude/ directory ownership...${NC}`);
      const user = process.env.USER || 'unknown';
      let group;
      try {
        group = execFileSync('id', ['-gn', user], { encoding: 'utf8', stdio: 'pipe' }).trim();
      } catch {
        group = process.platform === 'darwin' ? 'staff' : user;
      }
      try {
        execFileSync('sudo', ['chown', `${user}:${group}`, claudeDir], { stdio: 'inherit' });
        execFileSync('sudo', ['chmod', '755', claudeDir], { stdio: 'inherit' });
        console.log('  Restored user ownership of .claude/ (was root-owned)');
      } catch {
        console.log(`  ${YELLOW}Warning: could not restore .claude/ ownership (sudo may be needed)${NC}`);
      }
    }
  } catch {}

  // 5b. Update .gitignore
  console.log(`\n${YELLOW}Updating .gitignore...${NC}`);
  updateGitignore(projectDir);

  // 5c. Auto-untrack files that are now gitignored
  try {
    const tracked = execFileSync('git', ['ls-files', '--cached', '--ignored', '--exclude-standard', '.claude/'], {
      cwd: projectDir, encoding: 'utf8', stdio: 'pipe', timeout: 10000,
    }).trim();
    if (tracked) {
      const files = tracked.split('\n').filter(Boolean);
      console.log(`  Untracking ${files.length} now-gitignored file(s)...`);
      execFileSync('git', ['rm', '--cached', '--quiet', ...files], {
        cwd: projectDir, encoding: 'utf8', stdio: 'pipe', timeout: 10000,
      });
      console.log(`  Untracked: ${files.join(', ')}`);
    }
  } catch {
    // Non-fatal — may not be a git repo or no tracked files match
  }

  // 5d. Recreate vault-mappings.json if missing (try backup restore first)
  const vaultMappingsPath = path.join(claudeDir, 'vault-mappings.json');
  if (!fs.existsSync(vaultMappingsPath)) {
    console.log(`\n${YELLOW}Recreating vault-mappings.json...${NC}`);
    const restored = restoreVaultMappings(projectDir);
    if (restored) {
      console.log('  Restored vault-mappings.json from backup');
    } else {
      fs.writeFileSync(vaultMappingsPath, JSON.stringify({ provider: '1password', mappings: {} }, null, 2), 'utf8');
      console.log('  Created empty vault-mappings.json scaffold');
    }
  }

  // 6. Sync husky hooks
  console.log(`\n${YELLOW}Syncing husky hooks...${NC}`);
  const huskyDir = path.join(frameworkDir, 'husky');
  const projectHuskyDir = path.join(projectDir, '.husky');
  if (fs.existsSync(huskyDir) && fs.existsSync(projectHuskyDir)) {
    for (const hook of fs.readdirSync(huskyDir)) {
      const src = path.join(huskyDir, hook);
      const dst = path.join(projectHuskyDir, hook);
      try {
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, 0o755);
        console.log(`  Synced: .husky/${hook}`);
      } catch {
        console.log(`  ${YELLOW}Skipped .husky/${hook} (not writable)${NC}`);
      }
    }
  }

  // 6b. Sync GitHub Actions workflows
  console.log(`\n${YELLOW}Syncing GitHub Actions workflows...${NC}`);
  const workflowTemplateDir = path.join(frameworkDir, 'templates', 'github', 'workflows');
  if (fs.existsSync(workflowTemplateDir)) {
    const projectWorkflowDir = path.join(projectDir, '.github', 'workflows');
    fs.mkdirSync(projectWorkflowDir, { recursive: true });
    const templateFiles = fs.readdirSync(workflowTemplateDir).filter(f => f.endsWith('.template'));
    for (const file of templateFiles) {
      const src = path.join(workflowTemplateDir, file);
      const dstName = file.replace(/\.template$/, '');
      const dst = path.join(projectWorkflowDir, dstName);
      try {
        fs.copyFileSync(src, dst);
        console.log(`  Synced: .github/workflows/${dstName}`);
      } catch {
        console.log(`  ${YELLOW}Skipped .github/workflows/${dstName} (not writable)${NC}`);
      }
    }
    console.log(`  ${templateFiles.length} workflow(s) synced.`);
  } else {
    console.log(`  No workflow templates found, skipping.`);
  }

  // 6c. Check GitHub branch protection
  console.log(`\n${YELLOW}Checking GitHub branch protection...${NC}`);
  try {
    const branches = ['preview', 'staging', 'main'];
    const missingProtection = [];
    for (const branch of branches) {
      try {
        execFileSync('gh', ['api', `repos/:owner/:repo/branches/${branch}/protection`], {
          cwd: projectDir, stdio: 'pipe', timeout: 10000,
        });
      } catch {
        missingProtection.push(branch);
      }
    }
    if (missingProtection.length > 0) {
      console.log(`  ${YELLOW}WARNING: No branch protection on: ${missingProtection.join(', ')}${NC}`);
      console.log(`  ${YELLOW}CI workflows exist but results aren't enforced. Run:${NC}`);
      console.log(`  ${YELLOW}  node ${path.join(frameworkDir, 'scripts', 'setup-branch-protection.js')} --path ${projectDir}${NC}`);
    } else {
      console.log(`  Branch protection verified on all branches.`);
    }
  } catch {
    // Non-fatal — gh CLI might not be available
  }

  // 7. Rebuild MCP servers
  console.log(`\n${YELLOW}Rebuilding MCP servers...${NC}`);
  const mcpDir = path.join(frameworkDir, 'packages', 'mcp-servers');
  // Snapshot dist/ content hash BEFORE rebuild so we can detect whether the
  // build actually changed anything. Used downstream by the session recycler
  // to skip-recycle fresh-heartbeat persistent monitors when MCP code didn't
  // change — preserves in-flight pipelines from collateral damage on no-op
  // syncs (e.g., SessionStart-triggered sync after pulling a docs-only commit).
  const mcpDistHashBefore = hashMcpServerDist(mcpDir);
  // `mcpServersChanged` is hoisted above the try/finally — reassign, don't redeclare.
  mcpServersChanged = true; // Default to "changed" (safe) on build failure or first-run
  try {
    const mcpNodeModules = path.join(mcpDir, 'node_modules');
    const hasDeps = fs.existsSync(mcpNodeModules) &&
      fs.existsSync(path.join(mcpNodeModules, '@types', 'node')) &&
      fs.existsSync(path.join(mcpNodeModules, '@types', 'better-sqlite3'));
    if (!hasDeps) {
      execFileSync('npm', ['install', '--no-fund', '--no-audit'], { cwd: mcpDir, stdio: 'pipe', timeout: 120000 });
      console.log('  Dependencies installed');
    } else {
      console.log('  Dependencies already present, skipping npm install');
    }
    execFileSync('npm', ['run', 'build'], { cwd: mcpDir, stdio: 'pipe', timeout: 120000 });
    console.log('  TypeScript built');
    const mcpDistHashAfter = hashMcpServerDist(mcpDir);
    mcpServersChanged = mcpDistHashBefore !== mcpDistHashAfter;
    if (mcpServersChanged) {
      console.log('  MCP server dist content changed since last sync.');
    } else {
      console.log('  MCP server dist content unchanged — no-op build.');
    }
  } catch (err) {
    console.log(`  ${RED}MCP server build FAILED: ${err.message}${NC}`);
    console.log(`  ${RED}Repair: cd ${mcpDir} && npm install && npm run build${NC}`);
    // mcpServersChanged stays true — failsafe, treat as "needs recycle".
  }

  // 7a-verify. Verify dist/ exists after build
  if (!fs.existsSync(path.join(mcpDir, 'dist'))) {
    console.log(`\n  ${RED}WARNING: packages/mcp-servers/dist/ is MISSING after build.${NC}`);
    console.log(`  ${RED}MCP servers will not work. Run: cd ${mcpDir} && npm install && npm run build${NC}`);
  }

  // 7b. Build window recorder (macOS only)
  // Skip rebuild when source is unchanged to preserve the binary's CDHash —
  // macOS TCC ties Screen Recording permission to the CDHash, so rebuilding
  // (even with a stable codesign identifier) invalidates the grant.
  if (process.platform === 'darwin') {
    const windowRecorderDir = path.join(frameworkDir, 'tools', 'window-recorder');
    if (fs.existsSync(path.join(windowRecorderDir, 'Package.swift'))) {
      const binaryPath = path.join(windowRecorderDir, '.build', 'release', 'WindowRecorder');
      const hashFilePath = path.join(windowRecorderDir, '.build', '.source-hash');

      // Hash all Swift source files to detect changes.
      // Fail-open: if hashing fails (missing dir, corrupt files), fall through to rebuild.
      let currentHash = null;
      try {
        const sourceFiles = [
          path.join(windowRecorderDir, 'Package.swift'),
          ...fs.readdirSync(path.join(windowRecorderDir, 'Sources', 'WindowRecorder'), { recursive: true })
            .filter(f => f.endsWith('.swift'))
            .map(f => path.join(windowRecorderDir, 'Sources', 'WindowRecorder', f))
        ].sort();
        const hash = createHash('sha256');
        for (const file of sourceFiles) {
          hash.update(fs.readFileSync(file));
        }
        currentHash = hash.digest('hex');
      } catch {}

      let existingHash = '';
      try { existingHash = fs.readFileSync(hashFilePath, 'utf8').trim(); } catch {}

      if (currentHash && fs.existsSync(binaryPath) && currentHash === existingHash) {
        console.log(`\n${YELLOW}Window recorder up to date (source unchanged, skipping rebuild)${NC}`);
      } else {
        console.log(`\n${YELLOW}Building window recorder...${NC}`);
        try {
          execFileSync('swift', ['build', '-c', 'release'], { cwd: windowRecorderDir, stdio: 'pipe', timeout: 120000 });
          // Codesign with stable CFBundleIdentifier so macOS TCC grants persist across rebuilds.
          if (fs.existsSync(binaryPath)) {
            try {
              execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'com.gentyr.window-recorder', binaryPath], { stdio: 'pipe', timeout: 10000 });
              console.log('  Swift binary built + signed (com.gentyr.window-recorder)');
            } catch {
              console.log('  Swift binary built (codesign failed — TCC grants may not persist across rebuilds)');
            }
          } else {
            console.log('  Swift binary built');
          }
          // Persist source hash so subsequent syncs skip the rebuild
          try {
            if (currentHash) {
              fs.mkdirSync(path.dirname(hashFilePath), { recursive: true });
              fs.writeFileSync(hashFilePath, currentHash);
            }
          } catch {}
        } catch (err) {
          console.log(`  ${YELLOW}Warning: Window recorder build failed: ${err.message}${NC}`);
        }
      }
    }
  }

  // 7c. Install Chrome extension native messaging host
  const chromeExtInstall = path.join(frameworkDir, 'tools', 'chrome-extension', 'native-host', 'install.sh');
  if (fs.existsSync(chromeExtInstall)) {
    console.log(`\n${YELLOW}Installing Chrome extension native host...${NC}`);
    try {
      execFileSync(chromeExtInstall, [], { cwd: path.dirname(chromeExtInstall), stdio: 'pipe', timeout: 30000 });
      console.log('  Native messaging host registered');
    } catch (err) {
      console.log(`  ${YELLOW}Warning: Chrome extension native host install failed: ${err.message}${NC}`);
    }
  }

  // 7d. Build CTO dashboard live TUI
  const ctoDashboardDir = path.join(frameworkDir, 'packages', 'cto-dashboard-live');
  if (fs.existsSync(path.join(ctoDashboardDir, 'tsconfig.json'))) {
    console.log(`\n${YELLOW}Building CTO dashboard live TUI...${NC}`);
    try {
      const hasTypesNode = fs.existsSync(path.join(ctoDashboardDir, 'node_modules', '@types', 'node'));
      if (!hasTypesNode) {
        execFileSync('npm', ['install', '--no-fund', '--no-audit'], { cwd: ctoDashboardDir, stdio: 'pipe', timeout: 120000 });
        console.log('  Dependencies installed');
      }
      execFileSync('npm', ['run', 'build'], { cwd: ctoDashboardDir, stdio: 'pipe', timeout: 120000 });
      console.log('  TypeScript built');
    } catch (err) {
      console.log(`  ${YELLOW}Warning: CTO dashboard build failed: ${err.message}${NC}`);
    }
  }

  // 8. Regenerate launchd plists (macOS only)
  if (process.platform === 'darwin') {
    // 8a. Detect and unload stale daemon plist (e.g., clobbered by E2E test)
    const daemonPlistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.local.gentyr-mcp-daemon.plist');
    if (fs.existsSync(daemonPlistPath)) {
      try {
        const plistContent = fs.readFileSync(daemonPlistPath, 'utf8');
        const wdMatch = plistContent.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/);
        const workDir = wdMatch ? wdMatch[1] : '';
        const isStale = workDir && (
          workDir.includes('gentyr-e2e-install') ||
          (workDir.startsWith('/tmp/') || workDir.startsWith('/private/tmp/') || workDir.includes('/var/folders/')) ||
          !fs.existsSync(workDir)
        );
        if (isStale) {
          console.log(`  ${YELLOW}Detected stale MCP daemon plist (WorkingDirectory: ${workDir})${NC}`);
          try {
            execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, daemonPlistPath], { stdio: 'pipe', timeout: 10000 });
            console.log(`  Unloaded stale daemon`);
          } catch { /* may already be unloaded */ }
        }
      } catch { /* plist parsing failure -- regeneration in step 8b will fix it */ }
    }

    // 8b. Regenerate and reload plists
    const script = path.join(frameworkDir, 'scripts', 'setup-automation-service.sh');
    if (fs.existsSync(script)) {
      console.log(`\n${YELLOW}Updating automation services...${NC}`);
      try {
        execFileSync(script, ['setup', '--path', projectDir], { stdio: 'inherit', timeout: 60000 });
      } catch {
        console.log(`  ${YELLOW}Automation service update failed (non-fatal)${NC}`);
      }
    }
  }

  // 9. Write state
  const state = buildState(frameworkDir, model);
  writeState(projectDir, state);

  // 9a. Pending-application summary — make EACCES failures impossible to miss.
  // Without this block, a single inline yellow warning in 100+ lines of sync
  // output is easy to skim past, which is how staged secrets sit unapplied
  // across multiple sync attempts.
  if (pendingSummary.applied.length > 0 || pendingSummary.failed.length > 0) {
    console.log('');
    console.log(`${YELLOW}Pending changes summary:${NC}`);
    for (const a of pendingSummary.applied) {
      console.log(`  ${GREEN}✓${NC} ${a.kind}: applied ${a.count}`);
    }
    for (const f of pendingSummary.failed) {
      console.log(`  ${RED}✗${NC} ${f.kind}: FAILED — ${f.error}`);
    }
    if (pendingSummary.failed.length > 0) {
      const anyEacces = pendingSummary.failed.some(f => f.code === 'EACCES' || /EACCES|permission denied/i.test(f.error));
      console.log('');
      console.log(`${RED}═══════════════════════════════════════════════════════════════${NC}`);
      console.log(`${RED}  ${pendingSummary.failed.length} pending change(s) FAILED to apply${NC}`);
      console.log(`${RED}  Pending files were preserved for retry${NC}`);
      if (anyEacces) {
        console.log(`${RED}  Cause: services.json is root-owned but auto-unprotect did not run.${NC}`);
        console.log(`${RED}  Recovery: run 'sudo true && npx gentyr sync' to refresh the sudo${NC}`);
        console.log(`${RED}  credential cache before sync attempts the auto-unprotect.${NC}`);
      }
      console.log(`${RED}═══════════════════════════════════════════════════════════════${NC}`);
    }
  }

  console.log('');
  console.log(`${GREEN}Sync complete (v${state.version})${NC}`);

  } finally {
    // Re-protect BEFORE session recycling — recycling spawns processes that take
    // 30-60s, which causes the sudo credential cache to expire. Re-protecting first
    // ensures the sudo prompt happens while the terminal stdin is still clean.
    if (wasProtected) {
      runProtect(projectDir);
    }
  }

  // 10. Recycle running automated sessions AFTER re-protect.
  // Session recycling doesn't need unprotected files — it only kills/re-enqueues
  // processes. Running it after re-protect avoids sudo timeout/ETIMEDOUT errors.
  // Pass mcpServersChanged so the recycler can preserve in-flight persistent
  // monitor pipelines when sync was a no-op build.
  await recycleAutomatedSessions(projectDir, { mcpServersChanged });
}
