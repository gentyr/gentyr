/**
 * Configuration generation for GENTYR installation.
 *
 * Handles .mcp.json generation from template and settings.json merging.
 *
 * @module config-gen
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

  // Inject OP token
  const token = opts.opToken || existingOpToken;
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

  const section = fs.readFileSync(sectionPath, 'utf8');

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
    '.claude/api-key-rotation.json',
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
