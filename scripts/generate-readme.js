#!/usr/bin/env node

/**
 * Regenerate CTO Dashboard sections in both README.md and docs/CTO-DASHBOARD.md.
 *
 * Reads `scripts/readme-chrome.template` for the terminal session chrome,
 * runs `node packages/cto-dashboard/dist/index.js --mock` with COLUMNS=80,
 * substitutes the dashboard output into the template's {{DASHBOARD_OUTPUT}}
 * placeholder (with Bash-tool indentation), and replaces everything between
 * marker comments in both target files.
 *
 * README.md gets a trimmed teaser (quota, system status, deputy CTO, agent activity).
 * docs/CTO-DASHBOARD.md gets the full dashboard output.
 *
 * Usage:
 *   node scripts/generate-readme.js
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const START_MARKER = '<!-- CTO_DASHBOARD_START -->';
const END_MARKER = '<!-- CTO_DASHBOARD_END -->';
const FULL_START_MARKER = '<!-- FULL_CTO_DASHBOARD_START -->';
const FULL_END_MARKER = '<!-- FULL_CTO_DASHBOARD_END -->';
const DASHBOARD_PLACEHOLDER = '{{DASHBOARD_OUTPUT}}';

// Sections to keep in README teaser (matched against section header text)
const TEASER_SECTIONS = [
  'GENTYR CTO DASHBOARD',
  'QUOTA & CAPACITY',
  'SYSTEM STATUS',
  'DEPUTY CTO',
  'AUTOMATED INSTANCES',
  'METRICS SUMMARY',
];

/**
 * Extract specific sections from dashboard output for the README teaser.
 *
 * Sections are delimited by box-drawing characters:
 *   Top:    ╭─ TITLE ───╮
 *   Bottom: ╰───────────╯
 *
 * The algorithm tracks nesting depth so nested boxes (like metric grids
 * inside METRICS SUMMARY) are captured as part of their parent section.
 */
function extractTeaserSections(fullOutput) {
  const lines = fullOutput.split('\n');
  const kept = [];
  let inKeptSection = false;
  let depth = 0;
  let blankBuffer = [];

  for (const line of lines) {
    const headerMatch = line.match(/╭─\s*(.+?)\s*─+╮/);

    if (headerMatch && depth === 0) {
      const title = headerMatch[1].trim();
      // Check if this section title matches any teaser section (prefix match
      // to handle titles like "QUOTA & CAPACITY (2 keys)" or "TIMELINE (24h)")
      inKeptSection = TEASER_SECTIONS.some(s => title.startsWith(s));

      if (inKeptSection) {
        // Flush any buffered blank lines between kept sections
        if (kept.length > 0 && blankBuffer.length > 0) {
          kept.push('');
        }
        blankBuffer = [];
        depth = 1;
        kept.push(line);
        continue;
      }
    }

    if (inKeptSection) {
      // Track nesting depth for boxes within the section
      const opens = (line.match(/╭/g) || []).length;
      const closes = (line.match(/╰/g) || []).length;
      depth += opens;
      depth -= closes;

      kept.push(line);

      if (depth <= 0) {
        inKeptSection = false;
        depth = 0;
      }
    } else {
      // Buffer blank lines between sections
      if (line.trim() === '') {
        blankBuffer.push(line);
      } else {
        blankBuffer = [];
      }
    }
  }

  return kept.join('\n');
}

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
const fullChrome = template.replace(DASHBOARD_PLACEHOLDER, indentedDashboard)
  .replaceAll('\u23BF', ' ')
  .trimEnd();

// 5. Extract teaser for README (specific sections only)
const teaserOutput = extractTeaserSections(dashboardOutput);
const teaserLines = teaserOutput.split('\n');
const indentedTeaser = teaserLines
  .map((line, i) => (i === 0 ? `  \u23BF  ${line}` : `     ${line}`))
  .join('\n');
const teaserChrome = template.replace(DASHBOARD_PLACEHOLDER, indentedTeaser)
  .replaceAll('\u23BF', ' ')
  .trimEnd();

// 6. Update README.md with teaser
const readmePath = resolve(ROOT, 'README.md');
const readme = readFileSync(readmePath, 'utf-8');

const startIdx = readme.indexOf(START_MARKER);
const endIdx = readme.indexOf(END_MARKER);

if (startIdx === -1 || endIdx === -1) {
  console.error('ERROR: Could not find dashboard markers in README.md');
  console.error(`  Expected: ${START_MARKER}`);
  console.error(`  Expected: ${END_MARKER}`);
  process.exit(1);
}

const beforeReadme = readme.slice(0, startIdx + START_MARKER.length);
const afterReadme = readme.slice(endIdx);
const readmeReplacement = `\n\`\`\`\n${teaserChrome}\n\`\`\`\n`;
const updatedReadme = beforeReadme + readmeReplacement + afterReadme;
writeFileSync(readmePath, updatedReadme);
console.log('README.md updated with dashboard teaser.');

// 7. Update docs/CTO-DASHBOARD.md with full dashboard
const ctoDashPath = resolve(ROOT, 'docs/CTO-DASHBOARD.md');

if (!existsSync(ctoDashPath)) {
  console.error('ERROR: docs/CTO-DASHBOARD.md does not exist');
  console.error('  Create it with FULL_CTO_DASHBOARD_START/END markers first.');
  process.exit(1);
}

const ctoDash = readFileSync(ctoDashPath, 'utf-8');
const fullStartIdx = ctoDash.indexOf(FULL_START_MARKER);
const fullEndIdx = ctoDash.indexOf(FULL_END_MARKER);

if (fullStartIdx === -1 || fullEndIdx === -1) {
  console.error('ERROR: Could not find dashboard markers in docs/CTO-DASHBOARD.md');
  console.error(`  Expected: ${FULL_START_MARKER}`);
  console.error(`  Expected: ${FULL_END_MARKER}`);
  process.exit(1);
}

const beforeFull = ctoDash.slice(0, fullStartIdx + FULL_START_MARKER.length);
const afterFull = ctoDash.slice(fullEndIdx);
const fullReplacement = `\n\`\`\`\n${fullChrome}\n\`\`\`\n`;
const updatedCtoDash = beforeFull + fullReplacement + afterFull;
writeFileSync(ctoDashPath, updatedCtoDash);
console.log('docs/CTO-DASHBOARD.md updated with full dashboard output.');
