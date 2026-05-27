#!/usr/bin/env node
/**
 * PreToolUse Hook: Secret Environment Scope Guard
 *
 * Enforces `SecretProfile.environmentScope` from services.json. When a profile
 * is tagged `production`, it is only resolvable from promotion-pipeline
 * sessions that have explicitly opted into production scope via the
 * `GENTYR_RELEASE_PHASE=prod` environment variable. Same for `staging`.
 *
 * Fires on `mcp__secret-sync__secret_run_command` and inspects the `profile`
 * argument. When the named profile has a restrictive environmentScope and
 * the current session is not running in that scope, the call is DENIED.
 *
 * Profiles without `environmentScope` (or with `environmentScope: 'any'`)
 * are unaffected — this is purely an opt-in RBAC layer for projects that
 * want to keep production credentials out of routine staging work.
 *
 * Input: JSON on stdin { tool_name, tool_input }
 * Output: JSON on stdout with permissionDecision deny (block) or empty (allow)
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';

const NOOP = JSON.stringify({ continue: true });
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

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

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch {
  // Stdin unavailable — fail-open, never block on infra issues
  allow();
}

let input;
try {
  input = JSON.parse(raw);
} catch {
  allow();
}

if (!input || input.tool_name !== 'mcp__secret-sync__secret_run_command') {
  allow();
}

const requestedProfile = input.tool_input?.profile;
if (!requestedProfile) {
  // No profile invoked — nothing to enforce. (Other gates handle the
  // "should you have used a profile" case.)
  allow();
}

// Read services.json to look up the profile's environmentScope.
let services;
try {
  const cfgPath = path.join(PROJECT_DIR, 'services.json');
  services = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch {
  // No services.json or unreadable — fail-open. The profile gate elsewhere
  // surfaces missing-config issues.
  allow();
}

const profileDef = services?.secretProfiles?.[requestedProfile];
if (!profileDef) {
  // Profile not declared in services.json — let the secret-sync server
  // surface the "unknown profile" error itself.
  allow();
}

const scope = profileDef.environmentScope ?? 'any';
if (scope === 'any') {
  allow();
}

// Map the current session's GENTYR_RELEASE_PHASE → effective scope.
// 'prod' means the session is a promote-to-prod plan agent past Phase 7.
// 'staging' means it's a /promote-to-staging preview-promoter or staging
// promotion phase agent. Other values (or unset) mean general dev work.
const phase = process.env.GENTYR_RELEASE_PHASE ?? '';
const effective = phase === 'prod' ? 'production' : (phase === 'staging' ? 'staging' : 'any');

if (effective === scope || effective === 'any' && process.env.GENTYR_PROMOTION_PIPELINE === 'true') {
  // GENTYR_PROMOTION_PIPELINE=true means we're inside a vetted promoter agent
  // but the agent didn't explicitly stamp GENTYR_RELEASE_PHASE yet (e.g. the
  // earliest phases of a /promote-to-prod plan). Allow staging-scoped reads
  // there too, but not production — production stays gated.
  if (scope === 'staging') {
    allow();
  }
}

if (scope !== effective) {
  deny(
    `Secret profile "${requestedProfile}" is scoped to "${scope}" only. ` +
    `Current session scope: "${effective}" (GENTYR_RELEASE_PHASE=${phase || 'unset'}). ` +
    `If this is a legitimate cross-env credential read, file a bypass request ` +
    `via submit_bypass_request; do NOT remove the environmentScope tag from services.json.`,
  );
}

allow();
