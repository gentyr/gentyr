/**
 * Settings template hook file validation
 *
 * Verifies that every hook file referenced in settings.json.template actually
 * exists on disk. Catches renamed or deleted hook files before they ship and
 * break target projects (especially those with root-owned settings.json that
 * can't auto-update).
 *
 * Run with: node --test .claude/hooks/__tests__/settings-template-hook-files.test.js
 *
 * @version 1.0.0
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT_DIR = path.resolve(process.cwd());
const HOOKS_DIR = path.join(ROOT_DIR, '.claude', 'hooks');
const TEMPLATE_PATH = path.join(ROOT_DIR, '.claude', 'settings.json.template');

// Extract all hook filenames from the template
function extractHookFiles() {
  const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  const files = new Set();

  for (const [_event, entries] of Object.entries(template.hooks || {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks || []) {
        const match = hook.command && hook.command.match(/\.claude\/hooks\/([a-zA-Z0-9_.-]+\.js)/);
        if (match) {
          files.add(match[1]);
        }
      }
    }
  }

  return [...files].sort();
}

// ---------------------------------------------------------------------------
// Template validity
// ---------------------------------------------------------------------------

describe('settings.json.template — validity', () => {
  it('must be valid JSON', () => {
    const raw = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'settings.json.template is not valid JSON');
  });
});

// ---------------------------------------------------------------------------
// Hook file existence
// ---------------------------------------------------------------------------

describe('settings.json.template — hook file existence', () => {
  const hookFiles = extractHookFiles();

  assert.ok(hookFiles.length > 0, 'Expected at least one hook file in the template');

  for (const hookFile of hookFiles) {
    it(`${hookFile} must exist in .claude/hooks/`, () => {
      const hookPath = path.join(HOOKS_DIR, hookFile);
      assert.ok(
        fs.existsSync(hookPath),
        `Hook file ${hookFile} referenced in settings.json.template does not exist in .claude/hooks/. Was it renamed or deleted?`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Hook file syntax
// ---------------------------------------------------------------------------

describe('settings.json.template — hook file syntax', () => {
  const hookFiles = extractHookFiles();

  for (const hookFile of hookFiles) {
    it(`${hookFile} must pass syntax check`, () => {
      const hookPath = path.join(HOOKS_DIR, hookFile);
      if (!fs.existsSync(hookPath)) return; // existence test covers this

      const result = spawnSync('node', ['--check', hookPath], {
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.strictEqual(
        result.status,
        0,
        `${hookFile} has syntax errors:\n${result.stderr}`,
      );
    });
  }
});

