/**
 * Structural tests for the worker-daemon restart pass and auto-pull added to
 * `cli/commands/sync.js` Phase 0 + Phase 2c.
 *
 * Source-level tests only — running sync.js end-to-end requires a full project
 * fixture (worktree, MCP daemon, launchd permissions, sudo prompt). These
 * invariants are what would silently regress: dropped daemon labels, dropped
 * Phase 2c wiring, dropped auto-pull guards. Each catches the exact failure
 * mode that motivated PR #718's dormant backfill marker.
 *
 * Cross-check: WORKER_DAEMON_LABELS in sync.js must stay in sync with the
 * `*_PLIST_FILE` variables declared in scripts/setup-automation-service.sh.
 *
 * Run with: node --test cli/commands/__tests__/sync-worker-daemons.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SYNC_PATH = path.resolve(__dirname, '..', 'sync.js');
const SETUP_SH_PATH = path.resolve(__dirname, '..', '..', '..', 'scripts', 'setup-automation-service.sh');

describe('sync.js — WORKER_DAEMON_LABELS list', () => {
  const syncCode = fs.readFileSync(SYNC_PATH, 'utf8');

  it('defines WORKER_DAEMON_LABELS as a frozen array', () => {
    assert.match(syncCode, /const WORKER_DAEMON_LABELS = Object\.freeze\(\[/);
  });

  it('excludes the MCP daemon (Phase 2b owns it)', () => {
    const match = syncCode.match(/const WORKER_DAEMON_LABELS = Object\.freeze\(\[([\s\S]*?)\]\)/);
    assert.ok(match, 'WORKER_DAEMON_LABELS array must exist');
    assert.doesNotMatch(match[1], /gentyr-mcp-daemon/, 'MCP daemon must NOT be in worker list — Phase 2b handles it with bespoke kill+port+health logic');
  });

  it('includes every long-running worker daemon that runs gentyr framework code', () => {
    const match = syncCode.match(/const WORKER_DAEMON_LABELS = Object\.freeze\(\[([\s\S]*?)\]\)/);
    const body = match[1];
    const expected = [
      'com.local.gentyr-revival-daemon',
      'com.local.gentyr-quota-recovery-daemon',
      'com.local.gentyr-preview-watcher',
      'com.local.gentyr-session-activity-broadcaster',
      'com.local.gentyr-live-feed-daemon',
      'com.local.gentyr-synthetic-monitor',
      'com.local.gentyr-token-usage-collector',
    ];
    for (const label of expected) {
      assert.match(body, new RegExp(`['"]${label.replace(/[.\-]/g, '\\$&')}['"]`),
        `WORKER_DAEMON_LABELS must include ${label} — without it, code changes to its daemon never propagate`);
    }
  });

  it('stays in sync with setup-automation-service.sh plist declarations', () => {
    // The shell script is the source of truth for which daemons get plists
    // installed. If sync.js drops one, that daemon silently runs stale code
    // across every future `npx gentyr sync`. If the shell script adds one,
    // sync.js needs the matching entry or the new daemon hits the same bug.
    const sh = fs.readFileSync(SETUP_SH_PATH, 'utf8');
    const plistLabels = new Set();
    const plistRe = /PLIST_FILE="\$LAUNCHD_DIR\/(com\.local\.gentyr-[a-z0-9-]+)\.plist"/g;
    let m;
    while ((m = plistRe.exec(sh)) !== null) {
      plistLabels.add(m[1]);
    }
    // MCP daemon is intentionally excluded from sync.js's worker list
    plistLabels.delete('com.local.gentyr-mcp-daemon');

    const match = syncCode.match(/const WORKER_DAEMON_LABELS = Object\.freeze\(\[([\s\S]*?)\]\)/);
    const syncLabels = new Set();
    const syncRe = /['"](com\.local\.gentyr-[a-z0-9-]+)['"]/g;
    while ((m = syncRe.exec(match[1])) !== null) {
      syncLabels.add(m[1]);
    }

    const missingFromSync = [...plistLabels].filter((l) => !syncLabels.has(l));
    const missingFromSh = [...syncLabels].filter((l) => !plistLabels.has(l));
    assert.deepEqual(missingFromSync, [],
      `setup-automation-service.sh declares daemons that sync.js does not restart: ${missingFromSync.join(', ')}. Add them to WORKER_DAEMON_LABELS in sync.js.`);
    assert.deepEqual(missingFromSh, [],
      `sync.js restarts daemons that have no plist in setup-automation-service.sh: ${missingFromSh.join(', ')}. Remove or add a plist.`);
  });
});

describe('sync.js — restartWorkerDaemons function', () => {
  const code = fs.readFileSync(SYNC_PATH, 'utf8');

  it('defines restartWorkerDaemons as async', () => {
    assert.match(code, /async function restartWorkerDaemons\(/);
  });

  it('uses launchctl kickstart -k on darwin', () => {
    const fn = extractFunction(code, 'restartWorkerDaemons');
    assert.match(fn, /launchctl/);
    assert.match(fn, /kickstart/);
    assert.match(fn, /['"]-k['"]/);
    // Must address launchd via `gui/<uid>/<label>` — accept either inline form
    // or the refactored variant that hoists `gui/${process.getuid()}` into a
    // `domain` local and uses `${domain}/${label}` thereafter.
    const inlineForm = /gui\/\$\{process\.getuid\(\)\}\/\$\{label\}/;
    const domainVarForm = /domain\s*=\s*`gui\/\$\{process\.getuid\(\)\}`[\s\S]*?\$\{domain\}\/\$\{label\}/;
    assert.ok(
      inlineForm.test(fn) || domainVarForm.test(fn),
      'restartWorkerDaemons must address launchd via gui/<uid>/<label> (inline or via a `domain` local)',
    );
  });

  it('uses systemctl --user restart on linux', () => {
    const fn = extractFunction(code, 'restartWorkerDaemons');
    assert.match(fn, /systemctl/);
    assert.match(fn, /['"]--user['"]/);
    assert.match(fn, /['"]restart['"]/);
  });

  it('tolerates per-daemon failure (does not throw)', () => {
    const fn = extractFunction(code, 'restartWorkerDaemons');
    // Each platform branch must wrap execFileSync in try/catch
    const tryCount = (fn.match(/try \{/g) || []).length;
    assert.ok(tryCount >= 2, `restartWorkerDaemons must wrap each platform call in try/catch — found ${tryCount} try blocks`);
  });

  it('iterates WORKER_DAEMON_LABELS', () => {
    const fn = extractFunction(code, 'restartWorkerDaemons');
    assert.match(fn, /for \(const label of WORKER_DAEMON_LABELS\)/);
  });

  it('skips on non-darwin/linux platforms without throwing', () => {
    const fn = extractFunction(code, 'restartWorkerDaemons');
    assert.match(fn, /process\.platform !== 'darwin' && process\.platform !== 'linux'/);
  });

  it('matches launchctl "not loaded" error across macOS versions', () => {
    const fn = extractFunction(code, 'restartWorkerDaemons');
    // The macOS Sequoia message is `Could not find service "..." in domain
    // for user gui: 501` — note the missing word "specified". An older
    // variant is `Could not find specified service`. Both must be detected
    // so the path can fall through to bootstrap-on-not-loaded recovery.
    //
    // Strip JS comments first so block comments containing the buggy phrase
    // (used to document the historical regression) don't trigger a false
    // positive against this assertion.
    const fnNoComments = fn
      .replace(/\/\*[\s\S]*?\*\//g, '')      // /* ... */
      .replace(/(^|[^:])\/\/.*$/gm, '$1');   // //  ... (preserve `https://`)
    // The corrected detection regex makes the word `specified` optional:
    //   /Could not find( specified)? service.../
    const correctedForm = /Could not find\(\s*specified\)\?\s*service/;
    assert.match(
      fnNoComments,
      correctedForm,
      'restartWorkerDaemons must accept BOTH "Could not find service" (Sequoia) and "Could not find specified service" (older) by making `specified` optional: `Could not find( specified)? service`',
    );
  });

  it('auto-bootstraps daemons whose plist exists but is not loaded', () => {
    const fn = extractFunction(code, 'restartWorkerDaemons');
    // Recovery path: when kickstart reports the service is not loaded but the
    // plist is on disk, sync.js should auto-bootstrap rather than silently
    // skipping. Otherwise daemons that fall out of launchd stay offline
    // indefinitely across every `npx gentyr sync`.
    assert.match(fn, /LaunchAgents/, 'must reference ~/Library/LaunchAgents to locate plist on disk');
    assert.match(fn, /['"]bootstrap['"]/, 'must call launchctl bootstrap as the recovery action');
    assert.match(fn, /fs\.existsSync/, 'must check plist existence before bootstrap (silent-skip when plist absent)');
  });
});

describe('sync.js — autoPullFrameworkRepo function', () => {
  const code = fs.readFileSync(SYNC_PATH, 'utf8');

  it('defines autoPullFrameworkRepo', () => {
    assert.match(code, /function autoPullFrameworkRepo\(/);
  });

  it('skips when the framework dir is not a git checkout', () => {
    const fn = extractFunction(code, 'autoPullFrameworkRepo');
    // Must check for .git existence and bail
    assert.match(fn, /\.git/);
    assert.match(fn, /gitDirExists/);
  });

  it('skips when the working tree is dirty', () => {
    const fn = extractFunction(code, 'autoPullFrameworkRepo');
    // Must call git status --porcelain and bail on non-empty output
    assert.match(fn, /status.*--porcelain|--porcelain.*status/);
    assert.match(fn, /if \(dirty\)/);
  });

  it('skips when local has commits ahead of upstream (active development)', () => {
    const fn = extractFunction(code, 'autoPullFrameworkRepo');
    assert.match(fn, /rev-list.*--left-right.*--count|--left-right.*--count.*rev-list/);
    assert.match(fn, /if \(ahead > 0\)/);
  });

  it('runs git fetch before computing ahead/behind so counts are accurate', () => {
    const fn = extractFunction(code, 'autoPullFrameworkRepo');
    const fetchIdx = fn.indexOf("'fetch'");
    const revListIdx = fn.indexOf('rev-list');
    assert.ok(fetchIdx > 0, 'must call git fetch');
    assert.ok(revListIdx > fetchIdx, 'git fetch must run before rev-list to get accurate behind count');
  });

  it('uses pull --ff-only — never a merge commit', () => {
    const fn = extractFunction(code, 'autoPullFrameworkRepo');
    assert.match(fn, /['"]pull['"]/);
    assert.match(fn, /['"]--ff-only['"]/);
    assert.doesNotMatch(fn, /pull.*--no-ff|pull.*--rebase/);
  });

  it('is non-fatal — every git call is wrapped in try/catch', () => {
    const fn = extractFunction(code, 'autoPullFrameworkRepo');
    const tryCount = (fn.match(/try \{/g) || []).length;
    // status, fetch, rev-parse upstream, rev-list, pull = at least 5 try blocks
    assert.ok(tryCount >= 5, `autoPullFrameworkRepo must wrap each git call in try/catch — found ${tryCount} try blocks`);
  });
});

describe('sync.js — Phase 0 and Phase 2c wiring', () => {
  const code = fs.readFileSync(SYNC_PATH, 'utf8');

  it('calls autoPullFrameworkRepo in the main sync function', () => {
    assert.match(code, /autoPullFrameworkRepo\(frameworkDir\)/);
  });

  it('calls Phase 0 BEFORE auto-unprotect so the pull never races sudo-cache expiry', () => {
    // indexOf the call site, not the function declaration. The first
    // 'runUnprotect(projectDir)' substring is the helper function body at the
    // top of the file; the second is the call site we care about. Anchor on
    // the unique "Auto-unprotect if needed" comment that only appears at the
    // call site.
    const phase0Idx = code.indexOf('autoPullFrameworkRepo(frameworkDir)');
    const unprotectCallSiteIdx = code.indexOf('// Auto-unprotect if needed');
    assert.ok(phase0Idx > 0, 'Phase 0 call missing');
    assert.ok(unprotectCallSiteIdx > 0, 'auto-unprotect call-site comment missing');
    assert.ok(phase0Idx < unprotectCallSiteIdx, 'Phase 0 (auto-pull) must run BEFORE auto-unprotect');
  });

  it('calls restartWorkerDaemons in the session recycle path', () => {
    assert.match(code, /await restartWorkerDaemons\(/);
  });

  it('runs Phase 2c AFTER Phase 2b (MCP daemon restart)', () => {
    const phase2bIdx = code.indexOf('await ensureMcpDaemonHealthy(projectDir)');
    const phase2cIdx = code.indexOf('await restartWorkerDaemons(');
    assert.ok(phase2bIdx > 0, 'Phase 2b call missing');
    assert.ok(phase2cIdx > 0, 'Phase 2c call missing');
    assert.ok(phase2cIdx > phase2bIdx, 'Phase 2c (worker restart) must run AFTER Phase 2b (MCP daemon)');
  });

  it('runs Phase 2c BEFORE session re-enqueue (Phase 3) so revived sessions inherit fresh daemons', () => {
    const phase2cIdx = code.indexOf('await restartWorkerDaemons(');
    const phase3Comment = code.indexOf('Phase 3: Re-enqueue');
    assert.ok(phase2cIdx > 0, 'Phase 2c call missing');
    assert.ok(phase3Comment > 0, 'Phase 3 marker missing');
    assert.ok(phase2cIdx < phase3Comment, 'Phase 2c must run before Phase 3 re-enqueue');
  });
});

/**
 * Extract the body of a top-level async/non-async function from sync.js by
 * counting balanced braces starting at the function declaration. Source-level
 * test helper — assumes the file's JS is well-formed.
 */
function extractFunction(code, name) {
  const declRe = new RegExp(`(?:async )?function ${name}\\b`);
  const declMatch = code.match(declRe);
  if (!declMatch) throw new Error(`function ${name} not found in source`);
  const start = code.indexOf('{', declMatch.index);
  if (start < 0) throw new Error(`function ${name}: opening brace not found`);
  let depth = 1;
  let i = start + 1;
  while (i < code.length && depth > 0) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return code.slice(start, i);
}
