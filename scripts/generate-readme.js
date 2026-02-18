#!/usr/bin/env node

/**
 * Regenerate the CTO Dashboard section in README.md from mock data.
 *
 * Reads `scripts/readme-chrome.template` for the terminal session chrome,
 * runs `node packages/cto-dashboard/dist/index.js --mock` with COLUMNS=80,
 * substitutes the dashboard output into the template's {{DASHBOARD_OUTPUT}}
 * placeholder (with Bash-tool indentation), and replaces everything between
 * the marker comments in README.md.
 *
 * Usage:
 *   node scripts/generate-readme.js
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const START_MARKER = '<!-- CTO_DASHBOARD_START -->';
const END_MARKER = '<!-- CTO_DASHBOARD_END -->';
const DASHBOARD_PLACEHOLDER = '{{DASHBOARD_OUTPUT}}';

// 1. Run mock dashboard
const dashboardScript = resolve(ROOT, 'packages/cto-dashboard/dist/index.js');
const dashboardOutput = execFileSync('node', [dashboardScript, '--mock'], {
  encoding: 'utf-8',
  env: { ...process.env, COLUMNS: '80' },
  cwd: ROOT,
}).trimEnd();

// 2. Indent dashboard output to simulate Claude Code Bash tool rendering
//    First line: "  ⎿  " prefix, subsequent lines: 5-space indent
const dashboardLines = dashboardOutput.split('\n');
const indentedDashboard = dashboardLines
  .map((line, i) => (i === 0 ? `  \u23BF  ${line}` : `     ${line}`))
  .join('\n');

// 3. Read chrome template and substitute dashboard output
const templatePath = resolve(__dirname, 'readme-chrome.template');
const template = readFileSync(templatePath, 'utf-8');

if (!template.includes(DASHBOARD_PLACEHOLDER)) {
  console.error(`ERROR: Template missing ${DASHBOARD_PLACEHOLDER} placeholder`);
  process.exit(1);
}

// 4. Swap ⎿ (U+23BF) for a space — the character renders at a different
//    width in many fonts and throws off alignment in the README.
const chrome = template.replace(DASHBOARD_PLACEHOLDER, indentedDashboard)
  .replaceAll('\u23BF', ' ')
  .trimEnd();

// 4. Read README.md
const readmePath = resolve(ROOT, 'README.md');
const readme = readFileSync(readmePath, 'utf-8');

// 5. Find markers
const startIdx = readme.indexOf(START_MARKER);
const endIdx = readme.indexOf(END_MARKER);

if (startIdx === -1 || endIdx === -1) {
  console.error('ERROR: Could not find dashboard markers in README.md');
  console.error(`  Expected: ${START_MARKER}`);
  console.error(`  Expected: ${END_MARKER}`);
  process.exit(1);
}

// 6. Replace content between markers
const before = readme.slice(0, startIdx + START_MARKER.length);
const after = readme.slice(endIdx);
const replacement = `\n\`\`\`\n${chrome}\n\`\`\`\n`;

const updated = before + replacement + after;

// 7. Write back
writeFileSync(readmePath, updated);
console.log('README.md updated with current dashboard output.');
