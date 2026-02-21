/**
 * Unit tests for generate-readme.js
 *
 * Tests the script that regenerates the CTO Dashboard section in both
 * README.md (teaser) and docs/CTO-DASHBOARD.md (full output) by:
 * - Running the dashboard with --mock flag
 * - Replacing content between HTML comment markers in both files
 *
 * Uses Node's built-in test runner (node:test) for standalone script testing.
 * Run with: node --test scripts/__tests__/generate-readme.test.js
 *
 * @version 2.0.0
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCRIPT_PATH = path.join(__dirname, '..', 'generate-readme.js');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const START_MARKER = '<!-- CTO_DASHBOARD_START -->';
const END_MARKER = '<!-- CTO_DASHBOARD_END -->';
const FULL_START_MARKER = '<!-- FULL_CTO_DASHBOARD_START -->';
const FULL_END_MARKER = '<!-- FULL_CTO_DASHBOARD_END -->';

// ============================================================================
// Code Structure Tests
// ============================================================================

describe('generate-readme.js - Code Structure', () => {
  it('should be a valid ES module with shebang', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /^#!\/usr\/bin\/env node/, 'Must have node shebang');
    assert.match(code, /import .* from ['"]node:child_process['"]/, 'Must import child_process');
    assert.match(code, /import .* from ['"]node:fs['"]/, 'Must import fs');
    assert.match(code, /import .* from ['"]node:path['"]/, 'Must import path');
    assert.match(code, /import .* from ['"]node:url['"]/, 'Must import url');
  });

  it('should define the correct marker constants', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(
      code,
      /START_MARKER\s*=\s*['"]<!-- CTO_DASHBOARD_START -->['"]/,
      'Must define START_MARKER with correct value'
    );
    assert.match(
      code,
      /END_MARKER\s*=\s*['"]<!-- CTO_DASHBOARD_END -->['"]/,
      'Must define END_MARKER with correct value'
    );
  });

  it('should define full dashboard marker constants', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(
      code,
      /FULL_START_MARKER\s*=\s*['"]<!-- FULL_CTO_DASHBOARD_START -->['"]/,
      'Must define FULL_START_MARKER with correct value'
    );
    assert.match(
      code,
      /FULL_END_MARKER\s*=\s*['"]<!-- FULL_CTO_DASHBOARD_END -->['"]/,
      'Must define FULL_END_MARKER with correct value'
    );
  });

  it('should run dashboard with --mock flag', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /--mock/, 'Must pass --mock flag to dashboard');
  });

  it('should set COLUMNS environment variable for consistent width', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /COLUMNS.*['"]?80['"]?/, 'Must set COLUMNS=80 for consistent output width');
  });

  it('should use execFileSync to run the dashboard', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /execFileSync/, 'Must use execFileSync to run dashboard');
  });

  it('should read the chrome template and substitute dashboard output', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /readme-chrome\.template/, 'Must reference chrome template file');
    assert.match(code, /DASHBOARD_PLACEHOLDER|DASHBOARD_OUTPUT/, 'Must define a dashboard output placeholder');
    assert.match(code, /\.replace\(/, 'Must use replace to substitute placeholder');
  });

  it('should exit with code 1 when markers are missing', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /process\.exit\(1\)/, 'Must exit with code 1 on missing markers');
    assert.match(code, /startIdx.*-1|endIdx.*-1/, 'Must check for -1 (marker not found)');
  });

  it('should wrap replacement content in a markdown code block', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // The script uses a template literal with escaped backticks: `\`\`\``
    // so we search for the escape sequence rather than literal backticks
    assert.match(code, /\\`\\`\\`/, 'Must contain escaped backticks forming a code fence in the template literal');
    assert.match(code, /trimEnd\(\)/, 'Must trim trailing whitespace from dashboard output');
  });

  it('should write back to README.md using writeFileSync', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /writeFileSync/, 'Must use writeFileSync to persist changes');
    assert.match(code, /README\.md/, 'Must target README.md');
  });

  it('should write to docs/CTO-DASHBOARD.md', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /CTO-DASHBOARD\.md/, 'Must target docs/CTO-DASHBOARD.md');
  });

  it('should resolve paths relative to script directory (not cwd)', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /fileURLToPath\(import\.meta\.url\)/, 'Must use import.meta.url for path resolution');
    assert.match(code, /__dirname/, 'Must use __dirname for path resolution');
    assert.match(code, /resolve\(__dirname,\s*['"]\.\.['"]/, 'Must resolve ROOT as parent of __dirname');
  });

  it('should log success message for both files', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /console\.log/, 'Must log success message to console');
    assert.match(code, /README\.md updated/, 'Success message must reference README.md being updated');
    assert.match(code, /CTO-DASHBOARD\.md updated/, 'Success message must reference CTO-DASHBOARD.md being updated');
  });

  it('should log helpful error context when markers are missing', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /console\.error/, 'Must log errors to stderr via console.error');
    // The error messages use template literals: `  Expected: ${START_MARKER}`
    // so the source contains the variable reference, not the literal marker string
    assert.match(
      code,
      /Expected:.*\$\{START_MARKER\}|Expected:.*\$\{END_MARKER\}/,
      'Error message must interpolate START_MARKER or END_MARKER variable'
    );
  });

  it('should define teaser section extraction logic', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /TEASER_SECTIONS/, 'Must define TEASER_SECTIONS list');
    assert.match(code, /extractTeaserSections/, 'Must define extractTeaserSections function');
  });
});

// ============================================================================
// Marker Logic Tests (pure string manipulation)
// ============================================================================

describe('generate-readme.js - Marker Logic', () => {
  it('should preserve content before START_MARKER', () => {
    // Reproduce the slicing logic from the script
    const startMarker = START_MARKER;
    const endMarker = END_MARKER;
    const readme = `# Preamble\n\n${startMarker}\n\`\`\`\nold content\n\`\`\`\n${endMarker}\n\n# Postamble`;
    const mockOutput = 'new dashboard output';

    const startIdx = readme.indexOf(startMarker);
    const endIdx = readme.indexOf(endMarker);

    assert.ok(startIdx !== -1, 'START_MARKER must be found');
    assert.ok(endIdx !== -1, 'END_MARKER must be found');
    assert.ok(startIdx < endIdx, 'START_MARKER must precede END_MARKER');

    const before = readme.slice(0, startIdx + startMarker.length);
    const after = readme.slice(endIdx);
    const replacement = `\n\`\`\`\n${mockOutput.trimEnd()}\n\`\`\`\n`;
    const updated = before + replacement + after;

    assert.ok(
      updated.startsWith('# Preamble'),
      'Content before START_MARKER must be preserved'
    );
    assert.ok(
      updated.includes(startMarker),
      'START_MARKER must remain in output'
    );
    assert.ok(
      updated.includes(endMarker),
      'END_MARKER must remain in output'
    );
    assert.ok(
      updated.includes('# Postamble'),
      'Content after END_MARKER must be preserved'
    );
  });

  it('should replace old content between markers with new code block', () => {
    const startMarker = START_MARKER;
    const endMarker = END_MARKER;
    const readme = `${startMarker}\n\`\`\`\nOLD CONTENT\n\`\`\`\n${endMarker}`;
    const mockOutput = 'NEW CONTENT';

    const startIdx = readme.indexOf(startMarker);
    const endIdx = readme.indexOf(endMarker);
    const before = readme.slice(0, startIdx + startMarker.length);
    const after = readme.slice(endIdx);
    const replacement = `\n\`\`\`\n${mockOutput.trimEnd()}\n\`\`\`\n`;
    const updated = before + replacement + after;

    assert.ok(!updated.includes('OLD CONTENT'), 'Old content must be removed');
    assert.ok(updated.includes('NEW CONTENT'), 'New content must be present');
    assert.ok(updated.includes('```'), 'Replacement must be in a code block');
  });

  it('should trim trailing whitespace from dashboard output', () => {
    const mockOutput = 'dashboard output   \n  \n';
    const trimmed = mockOutput.trimEnd();

    assert.strictEqual(
      trimmed,
      'dashboard output',
      'trimEnd() must strip trailing whitespace and newlines'
    );
  });

  it('should detect missing START_MARKER via indexOf returning -1', () => {
    const readme = `Only END_MARKER here\n${END_MARKER}`;
    const startIdx = readme.indexOf(START_MARKER);

    assert.strictEqual(startIdx, -1, 'indexOf must return -1 for missing START_MARKER');
    assert.ok(startIdx === -1 || readme.indexOf(END_MARKER) === -1, 'Missing marker should be detected');
  });

  it('should detect missing END_MARKER via indexOf returning -1', () => {
    const readme = `${START_MARKER}\nsome content`;
    const endIdx = readme.indexOf(END_MARKER);

    assert.strictEqual(endIdx, -1, 'indexOf must return -1 for missing END_MARKER');
  });

  it('should produce valid structure: START_MARKER, code block, END_MARKER', () => {
    const startMarker = START_MARKER;
    const endMarker = END_MARKER;
    const readme = `${startMarker}\n\`\`\`\nold\n\`\`\`\n${endMarker}`;
    const mockOutput = 'dashboard line 1\ndashboard line 2';

    const startIdx = readme.indexOf(startMarker);
    const endIdx = readme.indexOf(endMarker);
    const before = readme.slice(0, startIdx + startMarker.length);
    const after = readme.slice(endIdx);
    const replacement = `\n\`\`\`\n${mockOutput.trimEnd()}\n\`\`\`\n`;
    const updated = before + replacement + after;

    const markerStart = updated.indexOf(startMarker);
    const codeBlockStart = updated.indexOf('```', markerStart);
    const codeBlockEnd = updated.indexOf('```', codeBlockStart + 3);
    const markerEnd = updated.indexOf(endMarker);

    assert.ok(markerStart < codeBlockStart, 'START_MARKER must precede code block');
    assert.ok(codeBlockStart < codeBlockEnd, 'Code block must open before it closes');
    assert.ok(codeBlockEnd < markerEnd, 'Code block must close before END_MARKER');
  });

  it('should work with FULL markers for CTO-DASHBOARD.md', () => {
    const doc = `# Dashboard\n\n${FULL_START_MARKER}\n\`\`\`\nold\n\`\`\`\n${FULL_END_MARKER}\n\nFooter`;
    const mockOutput = 'full dashboard output';

    const startIdx = doc.indexOf(FULL_START_MARKER);
    const endIdx = doc.indexOf(FULL_END_MARKER);

    assert.ok(startIdx !== -1, 'FULL_START_MARKER must be found');
    assert.ok(endIdx !== -1, 'FULL_END_MARKER must be found');

    const before = doc.slice(0, startIdx + FULL_START_MARKER.length);
    const after = doc.slice(endIdx);
    const replacement = `\n\`\`\`\n${mockOutput.trimEnd()}\n\`\`\`\n`;
    const updated = before + replacement + after;

    assert.ok(updated.includes('full dashboard output'), 'New content must be present');
    assert.ok(updated.includes('Footer'), 'Content after marker must be preserved');
    assert.ok(!updated.includes('old'), 'Old content must be removed');
  });
});

// ============================================================================
// Behavior Tests (run against real repo - idempotent)
// ============================================================================

describe('generate-readme.js - Behavior', () => {
  let readmeBefore;
  let ctoDashBefore;
  const readmePath = path.join(REPO_ROOT, 'README.md');
  const ctoDashPath = path.join(REPO_ROOT, 'docs', 'CTO-DASHBOARD.md');

  beforeEach(() => {
    // Snapshot files before each test so we can detect changes
    readmeBefore = fs.readFileSync(readmePath, 'utf8');
    ctoDashBefore = fs.readFileSync(ctoDashPath, 'utf8');
  });

  afterEach(() => {
    // Restore originals after each test to keep the run idempotent
    fs.writeFileSync(readmePath, readmeBefore);
    fs.writeFileSync(ctoDashPath, ctoDashBefore);
  });

  it('should exit with code 0 on success', async () => {
    const { stdout, stderr } = await execAsync(`node "${SCRIPT_PATH}"`, {
      cwd: REPO_ROOT,
      env: { ...process.env, COLUMNS: '80' },
    });

    // stdout should contain success messages for both files
    assert.match(stdout, /README\.md updated/, 'Should print README success message');
    assert.match(stdout, /CTO-DASHBOARD\.md updated/, 'Should print CTO-DASHBOARD success message');
  });

  it('should preserve markers in the updated README', async () => {
    await execAsync(`node "${SCRIPT_PATH}"`, {
      cwd: REPO_ROOT,
      env: { ...process.env, COLUMNS: '80' },
    });

    const readmeAfter = fs.readFileSync(readmePath, 'utf8');

    assert.ok(readmeAfter.includes(START_MARKER), 'START_MARKER must remain in README after update');
    assert.ok(readmeAfter.includes(END_MARKER), 'END_MARKER must remain in README after update');
  });

  it('should preserve markers in the updated CTO-DASHBOARD.md', async () => {
    await execAsync(`node "${SCRIPT_PATH}"`, {
      cwd: REPO_ROOT,
      env: { ...process.env, COLUMNS: '80' },
    });

    const ctoDashAfter = fs.readFileSync(ctoDashPath, 'utf8');

    assert.ok(ctoDashAfter.includes(FULL_START_MARKER), 'FULL_START_MARKER must remain in CTO-DASHBOARD.md');
    assert.ok(ctoDashAfter.includes(FULL_END_MARKER), 'FULL_END_MARKER must remain in CTO-DASHBOARD.md');
  });

  it('should place a markdown code block between the markers', async () => {
    await execAsync(`node "${SCRIPT_PATH}"`, {
      cwd: REPO_ROOT,
      env: { ...process.env, COLUMNS: '80' },
    });

    const readmeAfter = fs.readFileSync(readmePath, 'utf8');

    const startIdx = readmeAfter.indexOf(START_MARKER);
    const endIdx = readmeAfter.indexOf(END_MARKER);
    const between = readmeAfter.slice(startIdx + START_MARKER.length, endIdx);

    assert.match(between, /```/, 'Must contain opening code fence between markers');
    assert.ok(
      between.indexOf('```') < between.lastIndexOf('```'),
      'Must contain both opening and closing code fences between markers'
    );
  });

  it('should preserve all content outside the markers', async () => {
    await execAsync(`node "${SCRIPT_PATH}"`, {
      cwd: REPO_ROOT,
      env: { ...process.env, COLUMNS: '80' },
    });

    const readmeAfter = fs.readFileSync(readmePath, 'utf8');

    const beforeStart = (text) => text.slice(0, text.indexOf(START_MARKER));
    const afterEnd = (text) => text.slice(text.indexOf(END_MARKER));

    assert.strictEqual(
      beforeStart(readmeAfter),
      beforeStart(readmeBefore),
      'Content before START_MARKER must be unchanged'
    );
    assert.strictEqual(
      afterEnd(readmeAfter),
      afterEnd(readmeBefore),
      'Content from END_MARKER onward must be unchanged'
    );
  });

  it('should include dashboard output (non-empty) between the markers', async () => {
    await execAsync(`node "${SCRIPT_PATH}"`, {
      cwd: REPO_ROOT,
      env: { ...process.env, COLUMNS: '80' },
    });

    const readmeAfter = fs.readFileSync(readmePath, 'utf8');

    const startIdx = readmeAfter.indexOf(START_MARKER);
    const endIdx = readmeAfter.indexOf(END_MARKER);
    const between = readmeAfter.slice(startIdx + START_MARKER.length, endIdx);

    // The dashboard output should be non-trivial (at least a few lines)
    const lines = between.split('\n').filter(l => l.trim().length > 0);
    assert.ok(lines.length >= 3, `Dashboard output must be non-trivial; got ${lines.length} non-empty line(s)`);
  });

  it('should include full dashboard in CTO-DASHBOARD.md', async () => {
    await execAsync(`node "${SCRIPT_PATH}"`, {
      cwd: REPO_ROOT,
      env: { ...process.env, COLUMNS: '80' },
    });

    const ctoDashAfter = fs.readFileSync(ctoDashPath, 'utf8');

    const startIdx = ctoDashAfter.indexOf(FULL_START_MARKER);
    const endIdx = ctoDashAfter.indexOf(FULL_END_MARKER);
    const between = ctoDashAfter.slice(startIdx + FULL_START_MARKER.length, endIdx);

    const lines = between.split('\n').filter(l => l.trim().length > 0);
    assert.ok(lines.length >= 10, `Full dashboard must have substantial content; got ${lines.length} non-empty line(s)`);
  });

  it('should produce a README teaser shorter than the full dashboard', async () => {
    await execAsync(`node "${SCRIPT_PATH}"`, {
      cwd: REPO_ROOT,
      env: { ...process.env, COLUMNS: '80' },
    });

    const readmeAfter = fs.readFileSync(readmePath, 'utf8');
    const ctoDashAfter = fs.readFileSync(ctoDashPath, 'utf8');

    const readmeStart = readmeAfter.indexOf(START_MARKER);
    const readmeEnd = readmeAfter.indexOf(END_MARKER);
    const readmeBetween = readmeAfter.slice(readmeStart + START_MARKER.length, readmeEnd);

    const fullStart = ctoDashAfter.indexOf(FULL_START_MARKER);
    const fullEnd = ctoDashAfter.indexOf(FULL_END_MARKER);
    const fullBetween = ctoDashAfter.slice(fullStart + FULL_START_MARKER.length, fullEnd);

    assert.ok(
      readmeBetween.length < fullBetween.length,
      `README teaser (${readmeBetween.length} chars) must be shorter than full dashboard (${fullBetween.length} chars)`
    );
  });

  it('should exit with code 1 when README has no markers', async () => {
    // Write a README without markers to the repo root temporarily
    const stripped = readmeBefore
      .replace(START_MARKER, '')
      .replace(END_MARKER, '');
    fs.writeFileSync(readmePath, stripped);

    try {
      await execAsync(`node "${SCRIPT_PATH}"`, {
        cwd: REPO_ROOT,
        env: { ...process.env, COLUMNS: '80' },
      });
      assert.fail('Script should have exited with non-zero code');
    } catch (err) {
      assert.ok(
        err.code !== 0,
        `Expected non-zero exit code, got ${err.code}`
      );
      assert.match(
        err.stderr || '',
        /ERROR|marker|CTO_DASHBOARD/i,
        'stderr must describe the missing-marker error'
      );
    }
  });

  it('should exit with code 1 when CTO-DASHBOARD.md has no markers', async () => {
    // Write a CTO-DASHBOARD.md without markers temporarily
    const stripped = ctoDashBefore
      .replace(FULL_START_MARKER, '')
      .replace(FULL_END_MARKER, '');
    fs.writeFileSync(ctoDashPath, stripped);

    try {
      await execAsync(`node "${SCRIPT_PATH}"`, {
        cwd: REPO_ROOT,
        env: { ...process.env, COLUMNS: '80' },
      });
      assert.fail('Script should have exited with non-zero code');
    } catch (err) {
      assert.ok(
        err.code !== 0,
        `Expected non-zero exit code, got ${err.code}`
      );
      assert.match(
        err.stderr || '',
        /ERROR|marker|CTO_DASHBOARD/i,
        'stderr must describe the missing-marker error'
      );
    }
  });
});
