/**
 * gentyr set-op-token — rotate the 1Password service account token
 *
 * Updates the OP_SERVICE_ACCOUNT_TOKEN in three places:
 *   1. Shell profile (~/.zshrc or ~/.bashrc) — managed `# BEGIN GENTYR OP` block
 *   2. Automation service (launchd plist on macOS, systemd unit on Linux)
 *   3. MCP daemon service (separate plist/unit, same scheme)
 *
 * After updating, the launchd/systemd services are reloaded so the new token
 * takes effect immediately for headless credential resolution. Existing
 * interactive shells must `source ~/.zshrc` (or open a new shell) to pick up
 * the new token in their own environment.
 *
 * Usage:
 *   npx gentyr set-op-token                       # Prompts for token via stdin (no shell history)
 *   npx gentyr set-op-token --token <new-token>   # For scripting (token visible in ps/shell history)
 *   cat token.txt | npx gentyr set-op-token       # From a file via stdin
 *
 * Exit codes:
 *   0  success
 *   1  invalid arguments, missing token, validation failure, or service reload failure
 *
 * @module commands/set-op-token
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { resolveFrameworkDir } from '../lib/resolve-framework.js';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const CYAN = '\x1b[0;36m';
const NC = '\x1b[0m';

/** Validate OP token format. Same regex as init.js — alphanumeric, dashes,
 *  underscores, dots, minimum 10 chars. 1Password service account tokens are
 *  long base64-like strings; this is permissive enough to accept all real ones
 *  and strict enough to reject anything with shell metacharacters. */
const SAFE_OP_TOKEN_RE = /^[a-zA-Z0-9_.-]{10,}$/;
function isValidOpToken(token) {
  return typeof token === 'string' && SAFE_OP_TOKEN_RE.test(token);
}

/** Parse argv into options. */
function parseArgs(args) {
  const opts = { token: '', help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--token' && args[i + 1]) {
      opts.token = args[++i];
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--token') {
      // `--token` with no value — treat as help/error
      opts.help = true;
    } else {
      console.error(`${RED}Unknown argument: ${a}${NC}`);
      opts.help = true;
    }
  }
  return opts;
}

function printUsage() {
  console.log(`${GREEN}gentyr set-op-token${NC}

Rotate the 1Password service account token used by GENTYR's automation
service and MCP daemon for headless credential resolution.

Usage:
  npx gentyr set-op-token                       Prompt for token via stdin (no shell history)
  npx gentyr set-op-token --token <new-token>   Pass via flag (visible in ps/shell history)
  cat token.txt | npx gentyr set-op-token       Read token from stdin

What gets updated:
  1. Shell profile (~/.zshrc or ~/.bashrc) — managed GENTYR OP block
  2. Automation service env (launchd plist on macOS, systemd unit on Linux)
  3. MCP daemon service env (separate plist/unit)

Both services are restarted after the update so the new token takes effect
immediately. To use the new token in your current interactive shell, run
\`source ~/.zshrc\` (or open a new shell).
`);
}

/** Read a single line from stdin, masking the input is NOT supported by
 *  Node's readline — but if stdin is a TTY we instruct the user. If stdin is
 *  piped (not a TTY), we just read it. */
async function readTokenFromStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      // Interactive: prompt the user. We don't mask (Node's readline doesn't
      // support it cleanly) — instead the line is read directly and never echoed
      // to terminal scrollback by GENTYR (the terminal echo is the OS's call).
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      rl.question(`${CYAN}Paste 1Password service account token (input is visible in this terminal): ${NC}`, (answer) => {
        rl.close();
        resolve((answer || '').trim());
      });
    } else {
      // Piped: read all of stdin, trim newlines.
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { buf += chunk; });
      process.stdin.on('end', () => resolve(buf.trim()));
      process.stdin.on('error', reject);
    }
  });
}

/** Rewrite the managed `# BEGIN GENTYR OP` block in ~/.zshrc or ~/.bashrc. */
function updateShellProfile(token) {
  const home = process.env.HOME || '';
  const profiles = [path.join(home, '.zshrc'), path.join(home, '.bashrc')];
  const profile = profiles.find(p => fs.existsSync(p));

  if (!profile) {
    console.log(`  ${YELLOW}No .zshrc or .bashrc found — skipped shell profile update${NC}`);
    return null;
  }

  let content = fs.readFileSync(profile, 'utf8');
  // Remove existing managed block + any legacy unmanaged export
  content = content.replace(/# BEGIN GENTYR OP[\s\S]*?# END GENTYR OP\n?/g, '');
  content = content.replace(/^export OP_SERVICE_ACCOUNT_TOKEN=.*\n?/gm, '');
  content = content.replace(/^# 1Password Service Account Token\n?/gm, '');

  content += `\n# BEGIN GENTYR OP
# 1Password Service Account Token (managed by GENTYR — do not edit manually)
export OP_SERVICE_ACCOUNT_TOKEN="${token}"
# END GENTYR OP\n`;

  fs.writeFileSync(profile, content);
  return profile;
}

/** Re-run setup-automation-service.sh setup with the new token. This is the
 *  same path used by `init` and works on both macOS (launchd) and Linux
 *  (systemd) — the script handles platform detection internally. It regenerates
 *  BOTH the automation service AND the MCP daemon service with the new token
 *  and reloads both. */
function refreshServices(frameworkDir, projectDir, token) {
  const script = path.join(frameworkDir, 'scripts', 'setup-automation-service.sh');
  if (!fs.existsSync(script)) {
    throw new Error(`setup-automation-service.sh not found at ${script}. Is GENTYR installed?`);
  }
  // `setup` is idempotent — it preserves config when re-run, but with --op-token
  // it overwrites the env var entry in both plist/unit files and reloads.
  execFileSync(script, ['setup', '--path', projectDir, '--op-token', token], {
    stdio: 'inherit',
    timeout: 90000,
  });
}

export default async function setOpToken(args) {
  const opts = parseArgs(args);
  if (opts.help) {
    printUsage();
    process.exit(opts.token ? 0 : 1);
  }

  let token = opts.token;
  if (!token) {
    try {
      token = await readTokenFromStdin();
    } catch (err) {
      console.error(`${RED}Failed to read token from stdin: ${err.message}${NC}`);
      process.exit(1);
    }
  }

  if (!isValidOpToken(token)) {
    console.error(`${RED}Invalid OP token format.${NC}`);
    console.error(`Expected: alphanumeric + dashes/underscores/dots, minimum 10 chars.`);
    console.error(`Got: ${token ? `"${token.slice(0, 8)}…" (length ${token.length})` : 'empty'}`);
    process.exit(1);
  }

  const projectDir = process.cwd();
  let frameworkDir;
  try {
    frameworkDir = resolveFrameworkDir(projectDir);
  } catch (err) {
    console.error(`${RED}Could not resolve framework directory: ${err.message}${NC}`);
    console.error(`Run this command from inside a project that has GENTYR installed.`);
    process.exit(1);
  }

  console.log(`${GREEN}Updating OP_SERVICE_ACCOUNT_TOKEN${NC}`);
  console.log(`  Project: ${projectDir}`);
  console.log(`  Framework: ${frameworkDir}`);
  console.log(`  Token: ${token.slice(0, 8)}…${token.slice(-4)} (length ${token.length})`);
  console.log();

  // 1. Shell profile (managed block)
  console.log(`${CYAN}1/2 Shell profile${NC}`);
  const profile = updateShellProfile(token);
  if (profile) {
    console.log(`  Updated managed OP block in ${profile}`);
    console.log(`  ${YELLOW}Note: existing shells must \`source ${profile}\` or open a new shell.${NC}`);
  }
  console.log();

  // 2. Automation + MCP daemon services (regenerated + reloaded by setup script)
  console.log(`${CYAN}2/2 Automation service + MCP daemon${NC}`);
  try {
    refreshServices(frameworkDir, projectDir, token);
  } catch (err) {
    console.error();
    console.error(`${RED}Service refresh failed: ${err.message}${NC}`);
    console.error(`The shell profile was updated, but launchd/systemd reload failed.`);
    console.error(`Investigate with:`);
    console.error(`  scripts/setup-automation-service.sh status --path ${projectDir}`);
    process.exit(1);
  }

  console.log();
  console.log(`${GREEN}✓ OP_SERVICE_ACCOUNT_TOKEN rotated${NC}`);
  console.log(`  Verify with: scripts/setup-automation-service.sh status --path ${projectDir}`);
  console.log(`  Or check MCP daemon health: curl -sf http://localhost:18090/health`);
}
