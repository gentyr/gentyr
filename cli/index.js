#!/usr/bin/env node
/**
 * GENTYR CLI
 *
 * Usage:
 *   npx gentyr init [--op-token <token>]     # First-time project setup
 *   npx gentyr sync                          # Force sync (rebuild MCP servers + re-merge configs)
 *   npx gentyr status                        # Show installation state
 *   npx gentyr protect                       # Enable root-owned protection (prompts for sudo internally)
 *   npx gentyr unprotect                     # Disable protection (prompts for sudo internally)
 *   npx gentyr uninstall                     # Remove GENTYR from project
 *   npx gentyr migrate                       # Convert from .claude-framework to npm
 *   npx gentyr scaffold <name>               # Scaffold new project
 *   npx gentyr proxy [disable|enable]       # Disable/enable the rotation proxy
 *
 * @module cli
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COMMANDS = {
  init: './commands/init.js',
  sync: './commands/sync.js',
  status: './commands/status.js',
  protect: './commands/protect.js',
  unprotect: './commands/protect.js',
  uninstall: './commands/uninstall.js',
  migrate: './commands/migrate.js',
  scaffold: './commands/scaffold.js',
  'remove-account': './commands/remove-account.js',
  proxy: './commands/proxy.js',
};

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const NC = '\x1b[0m';

function printUsage() {
  console.log(`${GREEN}GENTYR CLI${NC}

Usage: npx gentyr <command> [options]

Commands:
  init [--op-token <token>]   First-time project setup
  sync                        Force sync (rebuild MCP servers + re-merge configs)
  status                      Show installation state
  protect                     Enable root-owned protection (prompts for sudo internally)
  unprotect                   Disable protection (prompts for sudo internally)
  uninstall                   Remove GENTYR from project
  migrate                     Convert from .claude-framework to npm model
  scaffold <name>             Scaffold new project
  remove-account <email>     Remove an account from rotation
  proxy [disable|enable]     Disable/enable the rotation proxy

Options:
  --help, -h                  Show this help message
  --version, -v               Show version
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  if (command === '--version' || command === '-v') {
    try {
      const versionPath = path.join(__dirname, '..', 'version.json');
      const { default: vj } = await import(versionPath, { with: { type: 'json' } });
      console.log(vj.version);
    } catch {
      // Fallback: read with fs
      const fs = await import('node:fs');
      try {
        const vj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8'));
        console.log(vj.version);
      } catch {
        console.log('unknown');
      }
    }
    process.exit(0);
  }

  const commandPath = COMMANDS[command];
  if (!commandPath) {
    console.error(`${RED}Unknown command: ${command}${NC}`);
    console.error('Run `npx gentyr --help` for available commands.');
    process.exit(1);
  }

  try {
    const mod = await import(commandPath);

    // Pass remaining args and handle 'unprotect' as a mode
    const commandArgs = args.slice(1);
    if (command === 'unprotect') {
      commandArgs.unshift('--mode', 'unprotect');
    }

    await mod.default(commandArgs);
  } catch (err) {
    console.error(`${RED}Error running '${command}':${NC} ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
