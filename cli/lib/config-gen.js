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
 * @param {string} projectDir - Absolute path to the target project
 */
export function updateGitignore(projectDir) {
  const gitignorePath = path.join(projectDir, '.gitignore');
  const marker = '# GENTYR runtime';

  const entries = `
${marker}
.claude/*.db
.claude/*.db-shm
.claude/*.db-wal
.claude/*-state.json
.claude/*.log
.claude/api-key-rotation.json
.claude/commit-approval-token.json
.claude/autonomous-mode.json
.claude/vault-mappings.json
.claude/credential-provider.json
.claude/state/
.claude/settings.local.json
`;

  let content = '';
  try {
    content = fs.readFileSync(gitignorePath, 'utf8');
  } catch {}

  if (content.includes(marker)) {
    console.log('  .gitignore already configured');
    return;
  }

  fs.writeFileSync(gitignorePath, content + entries);
  console.log('  Added runtime exclusions to .gitignore');
}
