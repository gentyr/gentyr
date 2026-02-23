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
  } catch {}

  // 2. .claude-framework (legacy symlink model)
  const legacyPath = path.join(dir, '.claude-framework');
  try {
    const stat = fs.lstatSync(legacyPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      return fs.realpathSync(legacyPath);
    }
  } catch {}

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
  } catch {}

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
    try { hash.update(fs.readFileSync(f, 'utf8')); } catch { hash.update(''); }
  }
  return hash.digest('hex');
}

function computeClaudeMdHash(frameworkDir) {
  try {
    return crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(frameworkDir, 'CLAUDE.md.gentyr-section'), 'utf8'))
      .digest('hex');
  } catch { return ''; }
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
  } catch {}
  return newest;
}

// ============================================================================
// State-based sync (preferred path when gentyr-state.json exists)
// ============================================================================

function statBasedSync(frameworkDir) {
  const statePath = path.join(projectDir, '.claude', 'gentyr-state.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return false; // No state file — fall through to legacy check
  }

  // Read current framework version
  let currentVersion;
  try {
    currentVersion = JSON.parse(fs.readFileSync(path.join(frameworkDir, 'version.json'), 'utf8')).version;
  } catch {
    currentVersion = '0.0.0';
  }

  // Fast check: version + config hash match → nothing to do
  const currentConfigHash = computeConfigHash(frameworkDir);
  if (state.version === currentVersion && state.configHash === currentConfigHash) {
    return true; // Handled: no sync needed
  }

  // Sync needed
  const changes = [];
  const frameworkRel = resolveFrameworkRel(projectDir);

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
    } catch {}
  }

  // b. Regenerate .mcp.json
  if (state.configHash !== currentConfigHash) {
    const templatePath = path.join(frameworkDir, '.mcp.json.template');
    const outputPath = path.join(projectDir, '.mcp.json');
    try {
      fs.accessSync(outputPath, fs.constants.W_OK);
      const template = fs.readFileSync(templatePath, 'utf8');
      const content = template.replace(/\$\{FRAMEWORK_PATH\}/g, frameworkRel);

      // Preserve OP token
      let opToken = '';
      try {
        const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        for (const server of Object.values(existing.mcpServers || {})) {
          if (server.env && server.env.OP_SERVICE_ACCOUNT_TOKEN) {
            opToken = server.env.OP_SERVICE_ACCOUNT_TOKEN;
            break;
          }
        }
      } catch {}

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
    } catch {}
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
    } catch {}
  }

  // d. Symlink new agent definitions
  const agentsDir = path.join(projectDir, '.claude', 'agents');
  try {
    const frameworkAgents = fs.readdirSync(path.join(frameworkDir, '.claude', 'agents'))
      .filter(f => f.endsWith('.md'));
    const existingAgents = new Set(state.agentList || []);
    for (const agent of frameworkAgents) {
      if (!existingAgents.has(agent)) {
        const target = `../../${frameworkRel}/.claude/agents/${agent}`;
        const linkPath = path.join(agentsDir, agent);
        try { fs.symlinkSync(target, linkPath); changes.push(`agent:${agent}`); } catch {}
      }
    }
  } catch {}

  // e. Auto-rebuild MCP servers if stale
  let mcpStale = false;
  const distDir = path.join(frameworkDir, 'packages', 'mcp-servers', 'dist');
  const srcDir = path.join(frameworkDir, 'packages', 'mcp-servers', 'src');
  if (fs.existsSync(distDir) && fs.existsSync(srcDir)) {
    try { mcpStale = getNewestMtime(srcDir) > getNewestMtime(distDir); } catch {}
  } else if (!fs.existsSync(distDir)) {
    mcpStale = true;
  }

  if (mcpStale) {
    const mcpDir = path.join(frameworkDir, 'packages', 'mcp-servers');
    try {
      execFileSync('npm', ['run', 'build'], { cwd: mcpDir, stdio: 'pipe', timeout: 30000 });
      changes.push('MCP servers rebuilt');
    } catch (err) {
      // Log to stderr only — target project agent must never see gentyr internal commands
      process.stderr.write(`[gentyr-sync] MCP build failed: ${err.message || err}\n`);
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
      } catch {}
    }
  }

  // g. Write updated state
  try {
    const newState = {
      version: currentVersion,
      configHash: currentConfigHash,
      claudeMdHash: currentMdHash,
      agentList: (() => {
        try {
          return fs.readdirSync(path.join(frameworkDir, '.claude', 'agents'))
            .filter(f => f.endsWith('.md')).sort();
        } catch { return state.agentList || []; }
      })(),
      stateFilesVersion: state.stateFilesVersion || 1,
      lastSync: new Date().toISOString(),
      installModel: (() => {
        try {
          const npmPath = path.join(projectDir, 'node_modules', 'gentyr');
          const stat = fs.lstatSync(npmPath);
          if (stat.isSymbolicLink() || stat.isDirectory()) return 'npm';
        } catch {}
        try {
          const legacyPath = path.join(projectDir, '.claude-framework');
          const stat = fs.lstatSync(legacyPath);
          if (stat.isSymbolicLink() || stat.isDirectory()) return 'legacy';
        } catch {}
        return 'npm';
      })(),
    };
    fs.writeFileSync(statePath, JSON.stringify(newState, null, 2) + '\n');
  } catch {}

  // Emit sync message — only report successful syncs, never ask agent to run commands
  const parts = [`GENTYR synced to v${currentVersion}`];
  if (changes.length > 0) parts.push(`(updated: ${changes.join(', ')})`);
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
  } catch { silent(); }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
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
  } catch {
    // hooks path doesn't exist — will be caught by other checks
  }

  // Check 2: Critical hook file ownership (existing check)
  const statePath = path.join(projectDir, '.claude', 'protection-state.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
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
    } catch {}

    const tampered = [];
    for (const hook of state.criticalHooks) {
      const filePath = path.join(hooksDir, hook);
      try {
        const stat = fs.statSync(filePath);
        if (stat.uid !== 0) {
          tampered.push(hook);
        }
      } catch {
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

try {
  const frameworkDir = resolveFrameworkDir(projectDir);
  if (!frameworkDir) silent();

  // Check for hook tampering before sync (may exit via warn())
  tamperCheck();

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
  } catch {
    // Non-fatal — don't block session start
  }

  // No sync was needed.
  silent();
} catch (err) {
  // Never block the session
  process.stderr.write(`[gentyr-sync] Unexpected error: ${err.message || err}\n`);
  silent();
}
