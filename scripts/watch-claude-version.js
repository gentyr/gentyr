#!/usr/bin/env node
/**
 * Watch Claude Version — detects Claude Code binary updates and auto-re-patches Clawd mascot.
 *
 * Note: credential patch is archived, replaced by rotation proxy.
 * Computes a SHA-256 hash of the resolved binary and compares it to the last
 * known hash. When a change is detected, runs the Clawd mascot patch only.
 *
 * Export: checkAndRepatch(log) — async function, returns early if unchanged.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { appendRotationAudit } from '../.claude/hooks/key-sync.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(os.homedir(), '.claude', 'state');
const HASH_STATE_PATH = path.join(STATE_DIR, 'claude-binary-hash.json');
const CLAWD_PATCH_SCRIPT = path.join(PROJECT_DIR, 'scripts', 'patch-clawd.py');

// ---------------------------------------------------------------------------
// Binary discovery — mirrors candidate list from patch scripts
// ---------------------------------------------------------------------------

function findClaudeBinary() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];

  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Candidate doesn't exist, try next
    }
  }

  throw new Error(
    'Could not find Claude Code binary. Checked:\n' +
    candidates.map(c => `  - ${c}`).join('\n')
  );
}

// ---------------------------------------------------------------------------
// Hash state persistence
// ---------------------------------------------------------------------------

function loadHashState() {
  try {
    return JSON.parse(fs.readFileSync(HASH_STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveHashState(state) {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  fs.writeFileSync(HASH_STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Binary hashing
// ---------------------------------------------------------------------------

function hashBinary(binaryPath) {
  const data = fs.readFileSync(binaryPath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Check the Claude Code binary for version changes and re-patch Clawd if needed.
 *
 * @param {Function} log - Logging function (message => void)
 * @returns {Promise<void>}
 */
export async function checkAndRepatch(log) {
  const binaryPath = findClaudeBinary();
  const currentHash = hashBinary(binaryPath);

  const savedState = loadHashState();

  if (savedState && savedState.hash === currentHash) {
    log(`[version-watch] Binary unchanged (${currentHash.slice(0, 12)}...)`);
    return;
  }

  // Hash changed or first run
  const previousHash = savedState?.hash || 'none';
  log(`[version-watch] Binary changed: ${previousHash.slice(0, 12)}... -> ${currentHash.slice(0, 12)}... (${binaryPath})`);

  // Apply Clawd mascot patch only
  let clawdPatchStatus = 'unknown';
  try {
    const clawdVerify = execFileSync('python3', [CLAWD_PATCH_SCRIPT, '--verify'], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: 'pipe',
    });
    log(`[version-watch] Clawd verify: ${clawdVerify.trim()}`);
    if (clawdVerify.includes('NOT_PATCHED')) {
      execFileSync('python3', [CLAWD_PATCH_SCRIPT], {
        encoding: 'utf8',
        timeout: 60000,
        stdio: 'pipe',
      });
      log('[version-watch] Clawd patch re-applied');
      appendRotationAudit('CLAWD_PATCH_REAPPLIED', { binary: binaryPath });
      clawdPatchStatus = 'patched';
    } else {
      log('[version-watch] Clawd patch already present');
      clawdPatchStatus = 'patched';
    }
  } catch (err) {
    log(`[version-watch] Clawd patch failed (non-fatal): ${err.message}`);
    clawdPatchStatus = 'failed';
  }

  // Re-hash after patch (Clawd may have changed bytes), save state
  const finalHash = hashBinary(binaryPath);
  saveHashState({
    hash: finalHash,
    patchedAt: new Date().toISOString(),
    clawdPatchStatus,
    previousUnpatchedHash: currentHash,
  });
}
