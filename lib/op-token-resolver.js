/**
 * Fallback OP_SERVICE_ACCOUNT_TOKEN resolver.
 * Reads the token from launchd plists (macOS) or systemd units (Linux)
 * when it's missing from .mcp.json.
 *
 * @module lib/op-token-resolver
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Read OP_SERVICE_ACCOUNT_TOKEN from launchd plists (macOS) or systemd units (Linux).
 * Fallback source when .mcp.json doesn't have the token.
 * @returns {string} The token, or empty string if not found
 */
export function readOpTokenFromPlist() {
  const homeDir = os.homedir();

  if (process.platform === 'darwin') {
    const plists = [
      path.join(homeDir, 'Library', 'LaunchAgents', 'com.local.gentyr-mcp-daemon.plist'),
      path.join(homeDir, 'Library', 'LaunchAgents', 'com.local.plan-executor.plist'),
    ];

    for (const plistPath of plists) {
      try {
        const result = execFileSync('/usr/libexec/PlistBuddy', [
          '-c', 'Print :EnvironmentVariables:OP_SERVICE_ACCOUNT_TOKEN',
          plistPath,
        ], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        if (result) return result;
      } catch {}
    }
  }

  if (process.platform === 'linux') {
    const units = [
      path.join(homeDir, '.config', 'systemd', 'user', 'gentyr-mcp-daemon.service'),
    ];
    for (const unitPath of units) {
      try {
        const content = fs.readFileSync(unitPath, 'utf-8');
        const match = content.match(/OP_SERVICE_ACCOUNT_TOKEN=(\S+)/);
        if (match) return match[1].trim();
      } catch {}
    }
  }

  return '';
}
