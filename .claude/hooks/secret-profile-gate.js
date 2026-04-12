#!/usr/bin/env node
/**
 * PreToolUse Hook: Secret Profile Gate
 *
 * Fires on mcp__secret-sync__secret_run_command. Blocks the call on first
 * attempt when a matching secret profile exists but the agent did not
 * specify the `profile` parameter. The agent must re-invoke with the
 * profile, or re-invoke without it a second time (proving intent).
 *
 * State tracking: Per-agent state files in .claude/state/ record
 * which command+profile combos have been blocked already.
 *
 * Input: JSON on stdin { tool_name, tool_input, cwd }
 * Output: JSON on stdout with permissionDecision deny (block) or empty (allow)
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NOOP = JSON.stringify({ continue: true });
const STATE_TTL_MS = 60 * 60 * 1000; // 1 hour

function allow() {
  process.stdout.write(NOOP);
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return allow();
  }

  // Only fire on secret_run_command
  if (event?.tool_name !== 'mcp__secret-sync__secret_run_command') {
    return allow();
  }

  const toolInput = event.tool_input || {};
  const command = toolInput.command || [];
  const cwd = toolInput.cwd || '';

  // If agent already specified a profile, allow — they're using the system
  if (toolInput.profile) {
    return allow();
  }

  // Load services.json to find profiles
  const projectDir = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const configPath = path.join(projectDir, '.claude', 'config', 'services.json');

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return allow(); // No config file — nothing to gate
  }

  const profiles = config.secretProfiles;
  if (!profiles || typeof profiles !== 'object') {
    return allow(); // No profiles configured
  }

  // Find matching profiles
  const commandStr = Array.isArray(command) ? command.join(' ') : String(command);
  const matchingProfiles = [];

  for (const [name, profile] of Object.entries(profiles)) {
    if (!profile || typeof profile !== 'object') continue;
    const match = profile.match;

    // Profiles with no match block never auto-match (require explicit profile param)
    if (!match) continue;

    let commandMatches = true;
    let cwdMatches = true;

    if (match.commandPattern) {
      try {
        commandMatches = new RegExp(match.commandPattern, 'i').test(commandStr);
      } catch {
        commandMatches = false; // Invalid regex — skip
      }
    } else {
      // No command pattern means don't match on command (need at least one pattern)
      if (!match.cwdPattern) continue;
    }

    if (match.cwdPattern) {
      // Strip leading */ for suffix matching
      const suffix = match.cwdPattern.replace(/^\*\//, '');
      cwdMatches = cwd.endsWith(suffix) || cwd.endsWith('/' + suffix);
    } else {
      // No cwd pattern — only need command to match
      if (!match.commandPattern) continue;
    }

    // AND logic: both specified patterns must match
    if (commandMatches && cwdMatches) {
      matchingProfiles.push([name, profile]);
    }
  }

  if (matchingProfiles.length === 0) {
    return allow(); // No profiles match this command
  }

  // Check "already blocked" state
  const agentId = process.env.CLAUDE_AGENT_ID || String(process.ppid);
  const stateDir = path.join(projectDir, '.claude', 'state');
  const stateFile = path.join(stateDir, `secret-profile-gate-${agentId}.json`);

  const stateKey = crypto.createHash('md5')
    .update(commandStr.substring(0, 200) + ':' + cwd)
    .digest('hex');

  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch { /* no state yet */ }

  // Prune expired entries
  const now = Date.now();
  let pruned = false;
  for (const [key, entry] of Object.entries(state)) {
    if (entry && typeof entry === 'object' && entry.blocked_at && (now - entry.blocked_at) > STATE_TTL_MS) {
      delete state[key];
      pruned = true;
    }
  }

  // Second attempt: allow (agent is deliberately bypassing)
  if (state[stateKey] && (now - state[stateKey].blocked_at) < STATE_TTL_MS) {
    // Clean up state entry since we're allowing now
    delete state[stateKey];
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch { /* non-fatal */ }
    return allow();
  }

  // First attempt: record and block
  state[stateKey] = {
    blocked_at: now,
    profiles: matchingProfiles.map(([name]) => name),
    command_preview: commandStr.substring(0, 100),
  };

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch { /* non-fatal — block anyway */ }

  const matchingNames = matchingProfiles.map(([name]) => name);
  const profileDetails = matchingProfiles.map(([name, p]) => {
    const keys = (p.secretKeys || []).join(', ');
    const desc = p.description ? ` — ${p.description}` : '';
    return `  "${name}": [${keys}]${desc}`;
  });

  const reason = [
    'SECRET PROFILE MATCH — command blocked on first attempt.',
    '',
    `Matching profile(s): ${matchingNames.join(', ')}`,
    '',
    ...profileDetails,
    '',
    'HOW TO PROCEED:',
    `  Use the profile param:  secret_run_command({ profile: "${matchingNames[0]}", ... })`,
    '  This ensures all required secrets are injected consistently.',
    '',
    'If you deliberately need to run WITHOUT the profile (rare),',
    'call secret_run_command again with the same args — the gate allows second attempts.',
    '',
    'WHY: Secret profiles prevent silent failures from missing credentials.',
    'The profile system exists so agents never need to memorize which secrets a command needs.',
  ].join('\n');

  return deny(reason);
}

main().catch(() => {
  // Fail-open on unexpected errors
  process.stdout.write(NOOP);
});
