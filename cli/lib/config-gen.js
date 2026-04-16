/**
 * Configuration generation for GENTYR installation.
 *
 * Handles .mcp.json generation from template and settings.json merging.
 *
 * @module config-gen
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Single source of truth for shared MCP daemon config
import { TIER1_SERVERS as TIER1_SHARED_SERVERS, MCP_DAEMON_PORT as DEFAULT_MCP_DAEMON_PORT, REMOTE_SERVERS, isLocalModeEnabled } from '../../lib/shared-mcp-config.js';
import { readOpTokenFromPlist } from '../../lib/op-token-resolver.js';

/**
 * Generate .mcp.json from template, substituting the framework path.
 *
 * Preserves existing OP_SERVICE_ACCOUNT_TOKEN if present.
 *
 * @param {string} projectDir - Absolute path to the target project
 * @param {string} frameworkDir - Absolute path to the framework directory
 * @param {string} frameworkRel - Relative framework path for template substitution
 * @param {object} [opts]
 * @param {string} [opts.opToken] - 1Password service account token to inject
 */
export function generateMcpJson(projectDir, frameworkDir, frameworkRel, opts = {}) {
  const templatePath = path.join(frameworkDir, '.mcp.json.template');
  const outputPath = path.join(projectDir, '.mcp.json');

  if (!fs.existsSync(templatePath)) {
    console.log('  Skipped .mcp.json (template not found)');
    return;
  }

  // Preserve existing OP token before regenerating
  let existingOpToken = '';
  if (!opts.opToken && fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      for (const server of Object.values(existing.mcpServers || {})) {
        if (server.env && server.env.OP_SERVICE_ACCOUNT_TOKEN) {
          existingOpToken = server.env.OP_SERVICE_ACCOUNT_TOKEN;
          break;
        }
      }
    } catch {}
  }

  // Check if output is writable
  try {
    if (fs.existsSync(outputPath)) {
      fs.accessSync(outputPath, fs.constants.W_OK);
    }
  } catch {
    console.log('  Skipped .mcp.json (file is root-owned, will update on next sudo install)');
    return;
  }

  // Generate from template
  const template = fs.readFileSync(templatePath, 'utf8');
  const content = template.replace(/\$\{FRAMEWORK_PATH\}/g, frameworkRel);

  try {
    fs.writeFileSync(outputPath, content);
    console.log('  Generated .mcp.json');
  } catch {
    console.log('  Skipped .mcp.json (not writable)');
    return;
  }

  // --- Local Prototyping Mode: exclude remote servers ---
  const localMode = isLocalModeEnabled(projectDir);
  if (localMode) {
    try {
      const config = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      let removed = 0;
      for (const name of REMOTE_SERVERS) {
        if (config.mcpServers && Object.prototype.hasOwnProperty.call(config.mcpServers, name)) {
          delete config.mcpServers[name];
          removed++;
        }
      }
      // Rewrite playwright entry to direct invocation (strip mcp-launcher.js wrapper)
      if (config.mcpServers && config.mcpServers['playwright']) {
        const pw = config.mcpServers['playwright'];
        if (Array.isArray(pw.args) && pw.args.some(a => typeof a === 'string' && a.includes('mcp-launcher.js'))) {
          // args format: ["scripts/mcp-launcher.js", "playwright", "path/to/server.js"]
          // keep only the last arg (the server.js path)
          pw.args = [pw.args[pw.args.length - 1]];
        }
      }
      fs.writeFileSync(outputPath, JSON.stringify(config, null, 2) + '\n');
      console.log(`  Local mode: excluded ${removed} remote servers`);
    } catch (err) {
      console.log(`  Warning: could not apply local mode exclusions: ${err.message}`);
    }
  }

  // When generating for the gentyr repo itself, add plugin-manager + installed plugins
  const isGentyrRepo = path.resolve(projectDir) === path.resolve(frameworkDir);
  if (isGentyrRepo) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      mcpConfig.mcpServers = mcpConfig.mcpServers || {};

      mcpConfig.mcpServers['plugin-manager'] = {
        command: 'node',
        args: [`${frameworkDir}/packages/mcp-servers/dist/plugin-manager/server.js`],
        env: { GENTYR_DIR: frameworkDir },
      };

      // Discover installed plugins by checking for dist/server.js
      const pluginsDir = path.join(frameworkDir, 'plugins');
      if (fs.existsSync(pluginsDir)) {
        for (const pluginName of fs.readdirSync(pluginsDir)) {
          const serverPath = path.join(pluginsDir, pluginName, 'dist', 'server.js');
          if (fs.existsSync(serverPath)) {
            mcpConfig.mcpServers[`plugin-${pluginName}`] = {
              command: 'node',
              args: [serverPath],
              env: { GENTYR_DIR: frameworkDir },
            };
          }
        }
      }

      fs.writeFileSync(outputPath, JSON.stringify(mcpConfig, null, 2) + '\n');
      console.log('  Added plugin-manager and discovered plugins to .mcp.json');
    } catch (err) {
      console.log(`  Warning: could not add plugin-manager to .mcp.json: ${err.message}`);
    }
  }

  // Inject OP token — prefer explicit arg, then preserve existing, then read from launchd plist
  // Skipped in local mode: no remote servers remain to receive the token
  const token = !localMode && (opts.opToken || existingOpToken || readOpTokenFromPlist());
  if (token) {
    try {
      const config = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      for (const server of Object.values(config.mcpServers || {})) {
        if (server.args && server.args.some(a => a.includes('mcp-launcher.js'))) {
          server.env = server.env || {};
          server.env.OP_SERVICE_ACCOUNT_TOKEN = token;
        }
      }
      fs.writeFileSync(outputPath, JSON.stringify(config, null, 2) + '\n');
      console.log('  Injected OP_SERVICE_ACCOUNT_TOKEN into launcher-based MCP servers');
    } catch {}
  }

  // --- Shared MCP Daemon (Tier 1 HTTP entries) ---
  // When the daemon plist exists (indicating it has been installed via
  // setup-automation-service.sh), replace Tier 1 stdio entries with HTTP
  // entries pointing at the shared daemon.
  const daemonPlistFile = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.local.gentyr-mcp-daemon.plist');
  const daemonSystemdFile = path.join(os.homedir(), '.config', 'systemd', 'user', 'gentyr-mcp-daemon.service');
  const daemonStateFile = path.join(projectDir, '.claude', 'state', 'shared-mcp-daemon.json');
  const daemonInstalled = fs.existsSync(daemonPlistFile) || fs.existsSync(daemonSystemdFile) || fs.existsSync(daemonStateFile);

  if (daemonInstalled) {
    try {
      const config = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      let daemonPort = DEFAULT_MCP_DAEMON_PORT;
      try {
        const state = JSON.parse(fs.readFileSync(daemonStateFile, 'utf8'));
        if (typeof state.port === 'number') { daemonPort = state.port; }
      } catch { /* use default port */ }

      let converted = 0;
      for (const serverName of TIER1_SHARED_SERVERS) {
        if (config.mcpServers && config.mcpServers[serverName]) {
          config.mcpServers[serverName] = {
            type: 'http',
            url: `http://127.0.0.1:${daemonPort}/mcp/${serverName}`,
          };
          converted++;
        }
      }

      if (converted > 0) {
        fs.writeFileSync(outputPath, JSON.stringify(config, null, 2) + '\n');
        console.log(`  Converted ${converted} Tier 1 servers to shared HTTP transport (port ${daemonPort})`);
      }
    } catch (err) {
      console.log(`  Warning: could not convert Tier 1 servers to HTTP transport: ${err.message}`);
    }
  }
}

/**
 * Merge GENTYR hooks into the project's settings.json.
 *
 * @param {string} projectDir - Absolute path to the target project
 * @param {string} frameworkDir - Absolute path to the framework directory
 */
export function mergeSettings(projectDir, frameworkDir) {
  const settingsPath = path.join(projectDir, '.claude', 'settings.json');
  const templatePath = path.join(frameworkDir, '.claude', 'settings.json.template');
  const mergeScript = path.join(frameworkDir, 'scripts', 'merge-settings.cjs');

  if (!fs.existsSync(mergeScript)) {
    console.log('  Skipped settings.json (merge script not found)');
    return;
  }

  // Check if writable
  try {
    if (fs.existsSync(settingsPath)) {
      fs.accessSync(settingsPath, fs.constants.W_OK);
    }
  } catch {
    console.log('  Skipped settings.json (not writable, will merge on next sudo install)');
    return;
  }

  try {
    execFileSync('node', [mergeScript, 'install', settingsPath, templatePath], {
      stdio: 'pipe',
      timeout: 10000,
    });
    console.log('  Merged settings.json');
  } catch (err) {
    console.log(`  Error merging settings.json: ${err.message}`);
  }
}

/**
 * Apply local mode transformations to the GENTYR framework section content.
 *
 * Strips remote-service-specific content and prepends a [LOCAL MODE ACTIVE]
 * header so agents know which tools and workflows are unavailable.
 *
 * Conservative approach: only removes clearly remote-dependent content.
 * All local tooling (task system, agent orchestration, playwright, plans,
 * persistent tasks, worktrees, etc.) is preserved verbatim.
 *
 * @param {string} sectionContent - Raw content of CLAUDE.md.gentyr-section
 * @returns {string} Transformed content with local mode header and remote sections stripped
 */
function applyLocalModeToClaudeMdSection(sectionContent) {
  let content = sectionContent;

  // ------------------------------------------------------------------
  // Strip the "Deployment Flow" section.
  // This section references mcp__vercel__*, mcp__render__*, mcp__supabase__*,
  // mcp__github__*, mcp__elastic-logs__*, and Render/Vercel/Elasticsearch
  // health monitoring — none of which are available in local mode.
  //
  // The section starts at "### Deployment Flow" and ends just before the
  // next "### " heading. We use a regex that captures the entire block.
  // ------------------------------------------------------------------
  content = content.replace(
    /^### Deployment Flow\n[\s\S]*?(?=^### |\n<!-- GENTYR-FRAMEWORK-END -->)/m,
    '',
  );

  // ------------------------------------------------------------------
  // In the Playwright section, strip the note about 1Password credential
  // injection, since 1Password is not required in local mode.
  // The specific line is:
  //   "- CLI bypasses 1Password credential injection — tests fail silently"
  // ------------------------------------------------------------------
  content = content.replace(
    /^- CLI bypasses 1Password credential injection[^\n]*\n/m,
    '',
  );

  // ------------------------------------------------------------------
  // Clean up any runs of 3+ blank lines that may have been introduced
  // by the removals above.
  // ------------------------------------------------------------------
  content = content.replace(/\n{3,}/g, '\n\n');

  // ------------------------------------------------------------------
  // Prepend the [LOCAL MODE ACTIVE] header block immediately after the
  // opening HTML marker so it's the first thing agents see.
  // ------------------------------------------------------------------
  const markerStart = '<!-- GENTYR-FRAMEWORK-START -->';
  const localModeHeader = [
    markerStart,
    '## [LOCAL MODE ACTIVE]',
    '',
    '> **Local Prototyping Mode is enabled for this project.**',
    '> The following remote services and tools are NOT available:',
    '>',
    '> **Unavailable MCP servers:** `github`, `cloudflare`, `supabase`, `vercel`, `render`,',
    '> `codecov`, `resend`, `elastic-logs`, `onepassword`, `secret-sync`',
    '>',
    '> **Unavailable slash commands:** `/push-secrets`, `/push-migrations`, `/hotfix`',
    '>',
    '> **Unavailable agent type:** `secret-manager`',
    '>',
    '> **1Password is NOT required.** Do not reference `op://` vault paths.',
    '>',
    '> **Dev server management:** Use Bash directly (e.g. `pnpm dev`) instead of',
    '> `secret_dev_server_start` or `secret_run_command`. Register background prerequisites',
    '> via `register_prerequisite` if you need automated dev server startup for demos.',
    '>',
    '> **All local tooling works normally:** todo-db, agent-tracker, playwright, plans,',
    '> persistent tasks, worktrees, session queue, specs-browser, product-manager, etc.',
    '',
  ].join('\n');

  content = content.replace(markerStart, localModeHeader);

  return content;
}

/**
 * Update the CLAUDE.md file with the GENTYR framework section.
 *
 * @param {string} projectDir - Absolute path to the target project
 * @param {string} frameworkDir - Absolute path to the framework directory
 */
export function updateClaudeMd(projectDir, frameworkDir) {
  const sectionPath = path.join(frameworkDir, 'CLAUDE.md.gentyr-section');
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  const markerStart = '<!-- GENTYR-FRAMEWORK-START -->';
  const markerEnd = '<!-- GENTYR-FRAMEWORK-END -->';

  if (!fs.existsSync(sectionPath)) {
    console.log('  Skipped CLAUDE.md (template not found)');
    return;
  }

  // Check if writable
  try {
    if (fs.existsSync(claudeMdPath)) {
      fs.accessSync(claudeMdPath, fs.constants.W_OK);
    }
  } catch {
    console.log('  Skipped CLAUDE.md (not writable, may be protected)');
    return;
  }

  let section = fs.readFileSync(sectionPath, 'utf8');

  // Apply local mode transformations if local prototyping mode is active.
  // This strips remote-service content and prepends a [LOCAL MODE ACTIVE] header.
  if (isLocalModeEnabled(projectDir)) {
    section = applyLocalModeToClaudeMdSection(section);
    console.log('  Local mode: applied CLAUDE.md transformations (remote sections stripped)');
  }

  if (fs.existsSync(claudeMdPath)) {
    let content = fs.readFileSync(claudeMdPath, 'utf8');

    // Remove existing section if present
    const startIdx = content.indexOf(markerStart);
    const endIdx = content.indexOf(markerEnd);
    if (startIdx !== -1 && endIdx !== -1) {
      content = content.substring(0, startIdx) + content.substring(endIdx + markerEnd.length);
      // Clean up extra newlines
      content = content.replace(/\n{3,}/g, '\n\n');
    }

    // Append section
    if (content.length > 0 && !content.endsWith('\n')) {
      content += '\n';
    }
    content += section;
    fs.writeFileSync(claudeMdPath, content);
    console.log('  Updated CLAUDE.md with GENTYR section');
  } else {
    fs.writeFileSync(claudeMdPath, section);
    console.log('  Created CLAUDE.md with GENTYR section');
  }
}

/**
 * Update .gitignore with GENTYR runtime entries.
 *
 * Uses BEGIN/END markers so the block is replaced on every run (not append-only).
 * Also removes legacy `# GENTYR runtime` blocks from older installs.
 *
 * @param {string} projectDir - Absolute path to the target project
 */
export function updateGitignore(projectDir) {
  const gitignorePath = path.join(projectDir, '.gitignore');
  const BEGIN = '# BEGIN GENTYR GITIGNORE';
  const END = '# END GENTYR GITIGNORE';
  const LEGACY_MARKER = '# GENTYR runtime';

  const patterns = [
    '# Runtime databases and WAL files',
    '.claude/*.db',
    '.claude/*.db-shm',
    '.claude/*.db-wal',
    '',
    '# State and config files',
    '.claude/*-state.json',
    '.claude/*.log',
    '.claude/commit-approval-token.json',
    '.claude/autonomous-mode.json',
    '.claude/vault-mappings.json',
    '.claude/credential-provider.json',
    '.claude/settings.local.json',
    '.claude/settings.json',
    '.claude/protection-key',
    '.claude/protected-action-approvals.json',
    '.claude/protection-state.json',
    '.claude/specs-config.json',
    '.claude/playwright-health.json',
    '',
    '# Generated directories',
    '.claude/config/',
    '.claude/state/',
    '.claude/worktrees/',
    '.claude/hooks-protected/',
    '',
    '# GENTYR-managed husky hooks (regenerated by npx gentyr sync)',
    '.husky/',
    '.husky',
    '',
    '# Generated root-level files',
    '.mcp.json',
    'op-secrets.conf',
  ];

  const block = `${BEGIN}\n${patterns.join('\n')}\n${END}\n`;

  let content = '';
  try {
    content = fs.readFileSync(gitignorePath, 'utf8');
  } catch {}

  // Remove existing BEGIN/END block if present
  const beginIdx = content.indexOf(BEGIN);
  const endIdx = content.indexOf(END);
  if (beginIdx !== -1 && endIdx !== -1) {
    content = content.substring(0, beginIdx) + content.substring(endIdx + END.length);
    // Clean up extra newlines left behind
    content = content.replace(/\n{3,}/g, '\n\n');
    if (content.endsWith('\n\n')) content = content.slice(0, -1);
  }

  // Remove legacy `# GENTYR runtime` block (everything from marker to next blank line or EOF)
  if (content.includes(LEGACY_MARKER)) {
    const lines = content.split('\n');
    const out = [];
    let inLegacy = false;
    for (const line of lines) {
      if (line.trim() === LEGACY_MARKER) {
        inLegacy = true;
        continue;
      }
      if (inLegacy) {
        // Legacy block ends at a blank line or a line that doesn't start with .claude/ or a known pattern
        if (line.trim() === '') {
          inLegacy = false;
          out.push(line);
        } else if (!line.startsWith('.claude/') && !line.startsWith('op-secrets') && !line.startsWith('.mcp.json')) {
          inLegacy = false;
          out.push(line); // This line is NOT part of the legacy block
        }
        continue;
      }
      out.push(line);
    }
    content = out.join('\n');
    // Clean up extra newlines
    content = content.replace(/\n{3,}/g, '\n\n');
  }

  // Append the new block
  if (content.length > 0 && !content.endsWith('\n')) {
    content += '\n';
  }
  if (content.length > 0 && !content.endsWith('\n\n')) {
    content += '\n';
  }
  content += block;

  fs.writeFileSync(gitignorePath, content);
  console.log('  Updated .gitignore with GENTYR patterns');
}
