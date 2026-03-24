#!/usr/bin/env node
/**
 * Centralized Debug Audit Trail
 *
 * Structured JSON-lines debug log for all GENTYR task spawning,
 * session management, and lifecycle systems.
 *
 * Log: .claude/state/gentyr-debug.log
 * Format: JSON lines, one event per line
 * Max entries: 5,000 (trimmed to 2,500 on overflow)
 * Cleanup: checked every 100 writes or when file > 500KB
 *
 * @module lib/debug-log
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'gentyr-debug.log');
const MAX_ENTRIES = 5000;
const TRIM_TO = 2500;
const MAX_FILE_SIZE = 512 * 1024; // 500KB
const CHECK_INTERVAL = 100;

let _writeCount = 0;

/**
 * Log a structured debug event.
 * @param {string} system - Subsystem (e.g., 'session-queue', 'memory-pressure')
 * @param {string} event - Event name (e.g., 'drain_cycle', 'spawn_blocked')
 * @param {object} [details={}] - Structured details
 * @param {string} [level='debug'] - 'debug' | 'info' | 'warn' | 'error'
 */
export function debugLog(system, event, details = {}, level = 'debug') {
  try {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      system,
      event,
      level,
      project: path.basename(PROJECT_DIR),
      details,
    });
    fs.appendFileSync(LOG_PATH, entry + '\n');
    _writeCount++;
    if (_writeCount % CHECK_INTERVAL === 0) {
      maybeCleanup();
    }
  } catch (_) {
    // Non-fatal — never block hook execution for logging
  }
}

/**
 * Check file size and trim if needed.
 */
function maybeCleanup() {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > MAX_FILE_SIZE) {
      trimLog();
    }
  } catch (_) {
    // File doesn't exist or stat failed — no-op
  }
}

/**
 * Trim log to TRIM_TO newest entries via atomic tmp+rename.
 */
function trimLog() {
  try {
    const content = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length <= MAX_ENTRIES) return;
    const kept = lines.slice(-TRIM_TO);
    const tmpPath = LOG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, kept.join('\n') + '\n');
    fs.renameSync(tmpPath, LOG_PATH);
  } catch (_) {
    // Non-fatal
  }
}

/**
 * Force cleanup — called by hourly-automation alongside cleanupAuditLog.
 */
export function cleanupDebugLog() {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > MAX_FILE_SIZE) {
      trimLog();
    }
  } catch (_) {
    // Non-fatal
  }
}
