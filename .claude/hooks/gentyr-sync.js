#!/usr/bin/env node
/**
 * SessionStart Hook: GENTYR Auto-Sync
 *
 * Runs on every Claude Code session start. Detects when the framework version
 * or config templates have changed and syncs the project automatically.
 *
 * Fast path: <5ms when no changes (reads two small JSON files, compares version + hash).
 * Fallback: If no gentyr-state.json exists, falls back to settings.json hook diff check.
 *
 * Location: .claude/hooks/gentyr-sync.js
 * Auto-propagates to target projects via directory symlink (npm link model).
 *
 * @version 3.0.0
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readOpTokenFromPlist } from '../../lib/op-token-resolver.js';
import { isLocalModeEnabled } from '../../lib/shared-mcp-config.js';

// ============================================================================
// Output helpers
// ============================================================================

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

function warn(message) {
  console.log(JSON.stringify({
    continue: true,
    suppressOutput: false,
    systemMessage: message,
  }));
  process.exit(0);
}

// Debug logging — writes to file since stdout is used for hook response and
// stderr must never be written to from SessionStart hooks.
const DEBUG_LOG_PATH = path.join(process.cwd(), '.claude', 'hooks', 'gentyr-sync-debug.log');

function debugLog(message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n---\n`;
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, logLine);
  } catch (_) {
    // Ignore write errors — never block session start
  }
}

// ============================================================================
// Fast-path: skip spawned sessions
// ============================================================================

if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
  silent();
}

// ============================================================================
// Framework resolution (supports npm and legacy symlink models)
// ============================================================================

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function resolveFrameworkDir(dir) {
  // 1. node_modules/gentyr (npm model)
  const npmPath = path.join(dir, 'node_modules', 'gentyr');
  try {
    const stat = fs.lstatSync(npmPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      return fs.realpathSync(npmPath);
    }
  } catch (_) {
  }

  // 2. .claude-framework (legacy symlink model)
  const legacyPath = path.join(dir, '.claude-framework');
  try {
    const stat = fs.lstatSync(legacyPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      return fs.realpathSync(legacyPath);
    }
  } catch (_) {
  }

  // 3. Follow .claude/hooks symlink (resilient to node_modules pruning)
  const hooksPath = path.join(dir, '.claude', 'hooks');
  try {
    const stat = fs.lstatSync(hooksPath);
    if (stat.isSymbolicLink()) {
      const realHooks = fs.realpathSync(hooksPath);
      // hooks dir is at <framework>/.claude/hooks
      const candidate = path.resolve(realHooks, '..', '..');
      if (fs.existsSync(path.join(candidate, 'version.json'))) {
        return candidate;
      }
    }
  } catch (_) {
  }

  return null;
}

function resolveFrameworkRel(dir) {
  const resolved = resolveFrameworkDir(dir);
  if (resolved) {
    const rel = path.relative(dir, resolved);
    return rel || '.';
  }
  return '.claude-framework';
}

function computeConfigHash(frameworkDir) {
  const files = [
    path.join(frameworkDir, '.claude', 'settings.json.template'),
    path.join(frameworkDir, '.mcp.json.template'),
  ];
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    try { hash.update(fs.readFileSync(f, 'utf8')); } catch (_) {
      hash.update('');
    }
  }
  return hash.digest('hex');
}

function computeClaudeMdHash(frameworkDir) {
  try {
    return crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(frameworkDir, 'CLAUDE.md.gentyr-section'), 'utf8'))
      .digest('hex');
  } catch (_) {
    return '';
  }
}

function getNewestMtime(dir) {
  let newest = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        newest = Math.max(newest, getNewestMtime(full));
      } else {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      }
    }
  } catch (_) {
  }
  return newest;
}

/**
 * Extract tool names and descriptions from MCP server source files.
 * Scans for { name: '...', description: '...' } patterns in server.ts files.
 * Returns an array of { name, description, server } objects.
 */
function extractToolManifest(srcDir) {
  const manifest = [];
  try {
    const serverDirs = fs.readdirSync(srcDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('__') && d.name !== 'shared');
    for (const dir of serverDirs) {
      const serverFile = path.join(srcDir, dir.name, 'server.ts');
      if (!fs.existsSync(serverFile)) continue;
      try {
        const content = fs.readFileSync(serverFile, 'utf-8');
        // Match tool name definitions: name: 'tool_name' or name: "tool_name"
        const nameRegex = /name:\s*['"]([a-z_]+)['"]/g;
        const descRegex = /description:\s*['"](.*?)['"]/g;
        const names = [...content.matchAll(nameRegex)].map(m => m[1]);
        const descs = [...content.matchAll(descRegex)].map(m => m[1]);
        for (let i = 0; i < names.length; i++) {
          manifest.push({
            name: names[i],
            description: (descs[i] || '').slice(0, 120),
            server: dir.name,
          });
        }
      } catch (_) { /* non-fatal — skip unreadable server files */ }
    }
  } catch (_) { /* non-fatal */ }
  return manifest;
}

// ============================================================================
// State-based sync (preferred path when gentyr-state.json exists)
// ============================================================================

function statBasedSync(frameworkDir) {
  const statePath = path.join(projectDir, '.claude', 'gentyr-state.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (_) {
    return false; // No state file — fall through to legacy check
  }

  // Read current framework version
  let currentVersion;
  try {
    currentVersion = JSON.parse(fs.readFileSync(path.join(frameworkDir, 'version.json'), 'utf8')).version;
  } catch (_) {
    currentVersion = '0.0.0';
  }

  // Fast check: version + config hash match → nothing to do
  const currentConfigHash = computeConfigHash(frameworkDir);
  const settingsExists = fs.existsSync(path.join(projectDir, '.claude', 'settings.json'));
  const mcpJsonExists = fs.existsSync(path.join(projectDir, '.mcp.json'));
  if (state.version === currentVersion && state.configHash === currentConfigHash && settingsExists && mcpJsonExists) {
    return true; // Handled: no sync needed
  }

  // Sync needed
  const changes = [];
  const frameworkRel = resolveFrameworkRel(projectDir);
  let settingsMergeFailed = false;

  // a. Re-merge settings.json
  if (state.configHash !== currentConfigHash) {
    const mergeScript = path.join(frameworkDir, 'scripts', 'merge-settings.cjs');
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    const templatePath = path.join(frameworkDir, '.claude', 'settings.json.template');
    try {
      const fileExists = fs.existsSync(settingsPath);
      if (fileExists) {
        fs.accessSync(settingsPath, fs.constants.W_OK);
      } else {
        fs.accessSync(path.dirname(settingsPath), fs.constants.W_OK);
      }
      execFileSync('node', [mergeScript, 'install', settingsPath, templatePath], {
        stdio: 'pipe', timeout: 10000,
      });
      changes.push('settings.json');
    } catch (_) {
      // settings.json not writable (likely root-owned from protection).
      // Mark as failed so we do NOT update configHash — next sync will retry.
      settingsMergeFailed = true;
    }
  }

  // b. Regenerate .mcp.json
  if (state.configHash !== currentConfigHash) {
    const templatePath = path.join(frameworkDir, '.mcp.json.template');
    const outputPath = path.join(projectDir, '.mcp.json');
    try {
      fs.accessSync(outputPath, fs.constants.W_OK);
      const template = fs.readFileSync(templatePath, 'utf8');
      const content = template.replace(/\$\{FRAMEWORK_PATH\}/g, frameworkRel);

      // Preserve OP token (skip in local mode — no remote servers need it)
      let opToken = '';
      if (!isLocalModeEnabled(projectDir)) {
        try {
          const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
          for (const server of Object.values(existing.mcpServers || {})) {
            if (server.env && server.env.OP_SERVICE_ACCOUNT_TOKEN) {
              opToken = server.env.OP_SERVICE_ACCOUNT_TOKEN;
              break;
            }
          }
        } catch (_) {
        }

        // Fallback: read from launchd plist if not in .mcp.json
        if (!opToken) {
          opToken = readOpTokenFromPlist();
          if (opToken) {
            debugLog('[gentyr-sync] Recovered OP_SERVICE_ACCOUNT_TOKEN from launchd plist');
          }
        }
      }

      fs.writeFileSync(outputPath, content);

      if (opToken) {
        const config = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        for (const server of Object.values(config.mcpServers || {})) {
          if (server.args && server.args.some(a => a.includes('mcp-launcher.js'))) {
            server.env = server.env || {};
            server.env.OP_SERVICE_ACCOUNT_TOKEN = opToken;
          }
        }
        fs.writeFileSync(outputPath, JSON.stringify(config, null, 2) + '\n');
      }

      changes.push('.mcp.json');
    } catch (_) {
      // Non-fatal — .mcp.json re-merge failure handled by continuing execution
    }
  }

  // c. Update CLAUDE.md section
  const currentMdHash = computeClaudeMdHash(frameworkDir);
  if (state.claudeMdHash !== currentMdHash) {
    const sectionPath = path.join(frameworkDir, 'CLAUDE.md.gentyr-section');
    const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    const markerStart = '<!-- GENTYR-FRAMEWORK-START -->';
    const markerEnd = '<!-- GENTYR-FRAMEWORK-END -->';

    try {
      if (fs.existsSync(sectionPath)) {
        fs.accessSync(claudeMdPath, fs.constants.W_OK);
        const section = fs.readFileSync(sectionPath, 'utf8');
        let content = fs.readFileSync(claudeMdPath, 'utf8');

        const startIdx = content.indexOf(markerStart);
        const endIdx = content.indexOf(markerEnd);
        if (startIdx !== -1 && endIdx !== -1) {
          content = content.substring(0, startIdx) + content.substring(endIdx + markerEnd.length);
          content = content.replace(/\n{3,}/g, '\n\n');
        }
        if (content.length > 0 && !content.endsWith('\n')) content += '\n';
        content += section;
        fs.writeFileSync(claudeMdPath, content);
        changes.push('CLAUDE.md');
      }
    } catch (_) {
    }
  }

  // d. Symlink new agent definitions
  const agentsDir = path.join(projectDir, '.claude', 'agents');
  try {
    const frameworkAgents = fs.readdirSync(path.join(frameworkDir, 'agents'))
      .filter(f => f.endsWith('.md'));
    const existingAgents = new Set(state.agentList || []);
    for (const agent of frameworkAgents) {
      if (!existingAgents.has(agent)) {
        const target = `../../${frameworkRel}/agents/${agent}`;
        const linkPath = path.join(agentsDir, agent);
        try { fs.symlinkSync(target, linkPath); changes.push(`agent:${agent}`); } catch (_) {
        }
      }
    }
  } catch (_) {
  }

  // e. Auto-rebuild MCP servers if stale
  let mcpStale = false;
  const distDir = path.join(frameworkDir, 'packages', 'mcp-servers', 'dist');
  const srcDir = path.join(frameworkDir, 'packages', 'mcp-servers', 'src');
  if (fs.existsSync(distDir) && fs.existsSync(srcDir)) {
    try { mcpStale = getNewestMtime(srcDir) > getNewestMtime(distDir); } catch (_) {
    }
  } else if (!fs.existsSync(distDir)) {
    mcpStale = true;
  }

  if (mcpStale) {
    const mcpDir = path.join(frameworkDir, 'packages', 'mcp-servers');
    try {
      // Install deps if node_modules is missing or incomplete (e.g. after git clean).
      // Check multiple @types packages — @types/better-sqlite3 is needed alongside @types/node.
      const mcpNodeModules = path.join(mcpDir, 'node_modules');
      const hasDeps = fs.existsSync(mcpNodeModules) &&
        fs.existsSync(path.join(mcpNodeModules, '@types', 'node')) &&
        fs.existsSync(path.join(mcpNodeModules, '@types', 'better-sqlite3'));
      if (!hasDeps) {
        execFileSync('npm', ['install', '--no-fund', '--no-audit'], { cwd: mcpDir, stdio: 'pipe', timeout: 120000 });
      }
      execFileSync('npm', ['run', 'build'], { cwd: mcpDir, stdio: 'pipe', timeout: 30000 });
      changes.push('MCP servers rebuilt');

      // Generate tool changelog after successful rebuild
      try {
        const manifestPath = path.join(projectDir, '.claude', 'state', 'mcp-tool-manifest.json');
        const changelogPath = path.join(projectDir, '.claude', 'state', 'mcp-tool-changelog.json');
        const newManifest = extractToolManifest(path.join(mcpDir, 'src'));

        let newTools = [];
        let changedTools = [];
        if (fs.existsSync(manifestPath)) {
          const prevManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          const prevNames = new Set(prevManifest.map(t => t.name));
          newTools = newManifest.filter(t => !prevNames.has(t.name));
          changedTools = newManifest.filter(t => {
            const prev = prevManifest.find(p => p.name === t.name);
            return prev && prev.description !== t.description;
          });
        }

        fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2));
        if (newTools.length > 0 || changedTools.length > 0) {
          fs.writeFileSync(changelogPath, JSON.stringify({ newTools, changedTools, timestamp: new Date().toISOString() }, null, 2));
          if (newTools.length > 0) changes.push(`${newTools.length} new MCP tools detected`);
        }
      } catch (_) {
        // Non-fatal — tool manifest generation is best-effort
      }
    } catch (buildErr) {
      changes.push(`MCP server build FAILED: ${buildErr.message}. Run: cd ${mcpDir} && npm install && npm run build`);
    }
  }

  // f. Sync husky hooks
  const huskyDir = path.join(frameworkDir, 'husky');
  const projectHuskyDir = path.join(projectDir, '.husky');
  if (fs.existsSync(huskyDir) && fs.existsSync(projectHuskyDir)) {
    for (const hook of fs.readdirSync(huskyDir)) {
      const src = path.join(huskyDir, hook);
      const dst = path.join(projectHuskyDir, hook);
      try {
        const srcContent = fs.readFileSync(src);
        const dstContent = fs.existsSync(dst) ? fs.readFileSync(dst) : Buffer.alloc(0);
        if (!srcContent.equals(dstContent)) {
          fs.copyFileSync(src, dst);
          fs.chmodSync(dst, 0o755);
          changes.push(`.husky/${hook}`);
        }
      } catch (_) {
      }
    }
  }

  // f2. Migration: untrack .husky/ files if they're tracked (target projects only)
  // In the gentyr repo itself, .husky/ files are source-of-truth and MUST stay tracked.
  const isFrameworkItself = fs.existsSync(path.join(projectDir, 'version.json'));
  if (!isFrameworkItself) {
    const huskyFilesToUntrack = ['pre-commit', 'post-commit', 'pre-push'];
    for (const file of huskyFilesToUntrack) {
      try {
        // Check if the file is tracked by git
        execFileSync('git', ['ls-files', '--error-unmatch', `.husky/${file}`], {
          cwd: projectDir, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
        });
        // If we get here, the file is tracked — untrack it
        execFileSync('git', ['rm', '--cached', `.husky/${file}`], {
          cwd: projectDir, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
        });
        changes.push(`untracked:.husky/${file}`);
      } catch (_) {
        // Not tracked or git error — no-op
      }
    }
  }

  // g. Write updated state
  // If settings.json merge failed (root-owned), preserve old configHash so next sync retries.
  try {
    const newState = {
      version: currentVersion,
      configHash: settingsMergeFailed ? state.configHash : currentConfigHash,
      claudeMdHash: currentMdHash,
      agentList: (() => {
        try {
          return fs.readdirSync(path.join(frameworkDir, 'agents'))
            .filter(f => f.endsWith('.md')).sort();
        } catch (_) {
          return state.agentList || [];
        }
      })(),
      stateFilesVersion: state.stateFilesVersion || 1,
      lastSync: new Date().toISOString(),
      installModel: (() => {
        try {
          const npmPath = path.join(projectDir, 'node_modules', 'gentyr');
          const stat = fs.lstatSync(npmPath);
          if (stat.isSymbolicLink() || stat.isDirectory()) return 'npm';
        } catch (_) {
        }
        try {
          const legacyPath = path.join(projectDir, '.claude-framework');
          const stat = fs.lstatSync(legacyPath);
          if (stat.isSymbolicLink() || stat.isDirectory()) return 'legacy';
        } catch (_) {
        }
        return 'npm';
      })(),
    };
    fs.writeFileSync(statePath, JSON.stringify(newState, null, 2) + '\n');
  } catch (_) {
  }

  // Emit sync message — only report successful syncs, never ask agent to run commands
  const parts = [`GENTYR synced to v${currentVersion}`];
  if (changes.length > 0) parts.push(`(updated: ${changes.join(', ')})`);
  if (settingsMergeFailed) parts.push('(settings.json not writable — run `npx gentyr sync` to fix)');
  warn(parts.join(' '));

  return true; // Handled
}

// ============================================================================
// Legacy fallback: settings.json hook diff check
// ============================================================================

function legacySettingsCheck(frameworkDir) {
  const templatePath = path.join(frameworkDir, '.claude', 'settings.json.template');
  const settingsPath = path.join(projectDir, '.claude', 'settings.json');

  let template;
  try {
    template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  } catch (_) {
    silent();
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (_) {
    warn('GENTYR: .claude/settings.json is missing or unreadable. Framework configuration may be incomplete.');
  }

  // Collect installed hook commands
  const installedCommands = new Set();
  for (const entries of Object.values(settings.hooks || {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks || []) {
        if (hook.command) installedCommands.add(hook.command);
      }
    }
  }

  // Check template hook commands are present
  const missingCommands = [];
  for (const entries of Object.values(template.hooks || {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks || []) {
        if (hook.command && !installedCommands.has(hook.command)) {
          missingCommands.push(hook.command);
        }
      }
    }
  }

  if (missingCommands.length > 0) {
    const names = missingCommands
      .map(c => path.basename(c.split(' ')[0].replace('${CLAUDE_PROJECT_DIR}', '')))
      .filter(Boolean)
      .join(', ');
    warn(
      `GENTYR: settings.json is out of sync (${missingCommands.length} hook(s) missing: ${names}). ` +
      'Framework hooks may not function correctly.'
    );
  }

  silent();
}

// ============================================================================
// Main
// ============================================================================

// ============================================================================
// Protection tamper check (runs when protection-state.json says protected: true)
// ============================================================================

function tamperCheck() {
  const warnings = [];

  // Check 1: Symlink target verification
  // Verifies .claude/hooks points to a real GENTYR framework directory.
  const hooksPath = path.join(projectDir, '.claude', 'hooks');
  try {
    const lstat = fs.lstatSync(hooksPath);
    if (lstat.isSymbolicLink()) {
      const realHooksDir = fs.realpathSync(hooksPath);
      const candidate = path.resolve(realHooksDir, '..', '..');
      if (!fs.existsSync(path.join(candidate, 'version.json'))) {
        warnings.push('.claude/hooks symlink does not point to a GENTYR framework');
      }
    } else if (lstat.isDirectory()) {
      // Regular directory is only valid in the framework repo itself
      if (!fs.existsSync(path.join(projectDir, 'version.json'))) {
        warnings.push('.claude/hooks is a regular directory (expected symlink to framework)');
      }
    }
  } catch (_) {
    // hooks path doesn't exist — will be caught by other checks
  }

  // Check 1.5: core.hooksPath worktree check
  // If core.hooksPath points into .claude/worktrees/, it's stale from a Claude Code
  // sub-agent worktree. Auto-repair to .husky.
  try {
    const hooksPathConfig = execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd: projectDir, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    }).trim();
    if (hooksPathConfig) {
      const resolved = path.isAbsolute(hooksPathConfig)
        ? hooksPathConfig
        : path.resolve(projectDir, hooksPathConfig);
      const worktreesDir = path.join(projectDir, '.claude', 'worktrees');
      if (resolved.startsWith(worktreesDir)) {
        // Auto-repair: reset to .husky
        try {
          execFileSync('git', ['config', '--local', 'core.hooksPath', '.husky'], {
            cwd: projectDir, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
          });
          warnings.push(`core.hooksPath was pointing into a worktree (${hooksPathConfig}) — auto-repaired to .husky`);
        } catch (_) {
          warnings.push(`core.hooksPath points into a worktree (${hooksPathConfig}) — pre-commit hooks are BYPASSED. Fix: git config --local core.hooksPath .husky`);
        }
      }
    }
  } catch (_) {
    // No hooksPath set or git error — default behavior is fine
  }

  // Check 2: Critical hook file ownership (existing check)
  const statePath = path.join(projectDir, '.claude', 'protection-state.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (_) {
    // No state file — skip ownership check but still emit symlink warnings
    if (warnings.length > 0) {
      warn(`SECURITY WARNING: ${warnings.join('; ')}. Run "npx gentyr protect" to restore protection.`);
    }
    return;
  }

  if (state.protected && Array.isArray(state.criticalHooks)) {
    // Resolve hooks directory (follows symlinks, same as protect.js getHooksDir)
    let hooksDir = hooksPath;
    try {
      if (fs.lstatSync(hooksDir).isSymbolicLink()) {
        hooksDir = fs.realpathSync(hooksDir);
      }
    } catch (_) {
    }

    // Use copy-on-protect directory if present (linked projects)
    if (state.hooksProtectedDir) {
      const protectedDir = path.join(projectDir, state.hooksProtectedDir);
      if (fs.existsSync(protectedDir)) {
        hooksDir = protectedDir;
      } else {
        // Directory missing when state says it should exist — treat as tampering
        warnings.push('hooks-protected/ directory missing (expected by protection-state.json)');
      }
    }

    const tampered = [];
    for (const hook of state.criticalHooks) {
      const filePath = path.join(hooksDir, hook);
      try {
        const stat = fs.statSync(filePath);
        if (stat.uid !== 0) {
          tampered.push(hook);
        }
      } catch (_) {
        // File missing — not necessarily tampering (could be removed legitimately)
      }
    }

    if (tampered.length > 0) {
      warnings.push(`${tampered.length} critical hook(s) not root-owned: ${tampered.join(', ')}`);
    }
  }

  if (warnings.length > 0) {
    warn(
      `SECURITY WARNING: ${warnings.join('; ')}. ` +
      'Possible tampering detected. Run "npx gentyr protect" to restore protection.'
    );
  }
}

/**
 * Check for stale hook file references in ~/.claude/settings.json.
 * If any hook commands reference files that no longer exist on disk, emits
 * a warning instructing the user to run `npx gentyr sync` to clean them up.
 * Never throws — silently no-ops if the file is unreadable or has no hooks.
 */
function staleHookCheck() {
  try {
    const globalSettingsPath = path.join(process.env.HOME || '', '.claude', 'settings.json');
    if (!fs.existsSync(globalSettingsPath)) return;
    const raw = fs.readFileSync(globalSettingsPath, 'utf8');
    const settings = JSON.parse(raw);
    if (!settings.hooks || typeof settings.hooks !== 'object') return;

    const missingBasenames = [];
    for (const hookType of Object.keys(settings.hooks)) {
      const matchers = settings.hooks[hookType];
      if (!Array.isArray(matchers)) continue;
      for (const matcher of matchers) {
        if (!Array.isArray(matcher.hooks)) continue;
        for (const entry of matcher.hooks) {
          const cmd = typeof entry === 'string' ? entry : entry.command;
          if (!cmd) continue;
          const match = cmd.match(/^node\s+(\S+)/);
          if (!match) continue;
          const filePath = match[1].replace(/\$\{CLAUDE_PROJECT_DIR\}/g, projectDir);
          if (!fs.existsSync(filePath)) {
            const basename = path.basename(filePath);
            if (!missingBasenames.includes(basename)) {
              missingBasenames.push(basename);
            }
          }
        }
      }
    }

    if (missingBasenames.length > 0) {
      warn(
        `WARNING: ~/.claude/settings.json references hook file(s) that no longer exist on disk: ` +
        `${missingBasenames.join(', ')}. ` +
        `Run \`npx gentyr sync\` to remove stale hook references.`
      );
    }
  } catch (_) {
    // Unreadable settings or parse error — silently no-op
  }
}

try {
  const frameworkDir = resolveFrameworkDir(projectDir);
  if (!frameworkDir) silent();

  // Check for hook tampering before sync (may exit via warn())
  tamperCheck();

  // Check for stale hook file references in global settings
  staleHookCheck();

  // Try state-based sync first; fall back to legacy check.
  if (!statBasedSync(frameworkDir)) {
    legacySettingsCheck(frameworkDir);
  }

  // Reset CTO Activity Gate on interactive session start
  // This ensures automation stays active whenever the CTO is using Claude Code
  try {
    const autoConfigPath = path.join(projectDir, '.claude', 'autonomous-mode.json');
    if (fs.existsSync(autoConfigPath)) {
      const config = JSON.parse(fs.readFileSync(autoConfigPath, 'utf8'));
      config.lastCtoBriefing = new Date().toISOString();
      config.lastModified = new Date().toISOString();
      config.modifiedBy = 'session-start';
      fs.writeFileSync(autoConfigPath, JSON.stringify(config, null, 2));
    }
  } catch (_) {
    // Non-fatal — don't block session start
  }

  // ============================================================================
  // Branch protection: warn/auto-fix if on wrong branch
  // ============================================================================
  try {
    const gitDir = path.join(projectDir, '.git');
    if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
      let currentBranch = '';
      try {
        currentBranch = execFileSync('git', ['branch', '--show-current'], {
          cwd: projectDir, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
        }).trim();
      } catch (err) { debugLog('[gentyr-sync] Warning: failed to get current branch: ' + err.message); }

      if (currentBranch) {
        const PROTECTED = ['main', 'preview', 'staging'];
        let baseBranch = 'main';
        try {
          execFileSync('git', ['rev-parse', '--verify', 'origin/preview'], {
            cwd: projectDir, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
          });
          baseBranch = 'preview';
        } catch (err) { debugLog('[gentyr-sync] Warning: failed to detect base branch: ' + err.message); }

        if (PROTECTED.includes(currentBranch) && currentBranch !== baseBranch) {
          let hasChanges = false;
          try {
            const status = execFileSync('git', ['status', '--porcelain'], {
              cwd: projectDir, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
            }).trim();
            hasChanges = status.length > 0;
          } catch (err) { debugLog('[gentyr-sync] Warning: failed to check working tree status: ' + err.message); }

          if (!hasChanges) {
            try {
              execFileSync('git', ['checkout', baseBranch], {
                cwd: projectDir, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
              });
              warn(`BRANCH AUTO-FIX: Was on '${currentBranch}' (protected). Auto-switched to '${baseBranch}'. Direct work on '${currentBranch}' is not allowed.`);
            } catch (err) {
              debugLog('[gentyr-sync] Warning: failed to auto-checkout base branch: ' + err.message);
              warn(`WARNING: On '${currentBranch}' (protected). Switch to '${baseBranch}': git checkout ${baseBranch}`);
            }
          } else {
            warn(`WARNING: On '${currentBranch}' (protected) with uncommitted changes. Recovery: git stash && git checkout ${baseBranch} && git stash pop`);
          }
        }
      }
    }
  } catch (err) { debugLog('[gentyr-sync] Warning: branch protection check failed: ' + err.message); }

  // No sync was needed.
  silent();
} catch (err) {
  // Never block the session — route error to systemMessage (never stderr)
  warn(`[gentyr-sync] Unexpected error: ${err.message || err}`);
}
