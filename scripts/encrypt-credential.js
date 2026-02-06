#!/usr/bin/env node
/**
 * Credential Encryption Utility
 *
 * Encrypts credentials for use with the CTO-protected MCP action system.
 * Encrypted credentials can only be decrypted by the approval system
 * when a CTO has approved the action.
 *
 * Usage:
 *   # Interactive mode (prompts for input)
 *   node scripts/encrypt-credential.js
 *
 *   # Encrypt a specific value
 *   node scripts/encrypt-credential.js --value "secret-key-here"
 *
 *   # Encrypt and show command to update .mcp.json
 *   node scripts/encrypt-credential.js --value "secret" --env-var SUPABASE_KEY
 *
 *   # Generate a new protection key
 *   node scripts/encrypt-credential.js --generate-key
 *
 *   # Decrypt a value (for debugging, requires protection key)
 *   node scripts/encrypt-credential.js --decrypt "${GENTYR_ENCRYPTED:...}"
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PROTECTION_KEY_PATH = path.join(PROJECT_DIR, '.claude', 'protection-key');

// Encryption constants
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const ENCRYPTED_PREFIX = '${GENTYR_ENCRYPTED:';
const ENCRYPTED_SUFFIX = '}';

// ============================================================================
// Key Management
// ============================================================================

function generateKey() {
  return crypto.randomBytes(KEY_LENGTH).toString('base64');
}

function readKey() {
  if (!fs.existsSync(PROTECTION_KEY_PATH)) {
    return null;
  }
  return Buffer.from(fs.readFileSync(PROTECTION_KEY_PATH, 'utf8').trim(), 'base64');
}

function writeKey(keyBase64) {
  const dir = path.dirname(PROTECTION_KEY_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PROTECTION_KEY_PATH, keyBase64 + '\n', { mode: 0o600 });
}

// ============================================================================
// Encryption / Decryption
// ============================================================================

function encrypt(value, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(value, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all base64)
  const payload = `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
  return `${ENCRYPTED_PREFIX}${payload}${ENCRYPTED_SUFFIX}`;
}

function decrypt(encryptedValue, key) {
  if (!encryptedValue.startsWith(ENCRYPTED_PREFIX) || !encryptedValue.endsWith(ENCRYPTED_SUFFIX)) {
    throw new Error('Invalid encrypted value format');
  }

  const payload = encryptedValue.slice(ENCRYPTED_PREFIX.length, -ENCRYPTED_SUFFIX.length);
  const [ivBase64, authTagBase64, ciphertext] = payload.split(':');

  if (!ivBase64 || !authTagBase64 || !ciphertext) {
    throw new Error('Invalid encrypted payload format');
  }

  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// ============================================================================
// Interactive Mode
// ============================================================================

function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function question(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function interactiveMode() {
  const rl = createInterface();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          GENTYR Credential Encryption Utility                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Check for existing key
  let key = readKey();
  if (key) {
    console.log('✓ Found existing protection key');
  } else {
    console.log('No protection key found. Generating new key...');
    const newKey = generateKey();
    writeKey(newKey);
    key = Buffer.from(newKey, 'base64');
    console.log('✓ Generated and saved new protection key');
    console.log('');
    console.log('IMPORTANT: After setup, make the key file root-owned:');
    console.log(`  sudo chown root:root ${PROTECTION_KEY_PATH}`);
    console.log(`  sudo chmod 600 ${PROTECTION_KEY_PATH}`);
  }

  console.log('');

  // Get value to encrypt
  const value = await question(rl, 'Enter the credential value to encrypt: ');

  if (!value.trim()) {
    console.log('No value provided. Exiting.');
    rl.close();
    process.exit(1);
  }

  // Get optional env var name
  const envVar = await question(rl, 'Environment variable name (optional, for .mcp.json): ');

  rl.close();

  // Encrypt
  const encrypted = encrypt(value, key);

  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('ENCRYPTED VALUE:');
  console.log('');
  console.log(encrypted);
  console.log('');

  if (envVar.trim()) {
    console.log('════════════════════════════════════════════════════════════════');
    console.log('For .mcp.json, use:');
    console.log('');
    console.log(`  "${envVar}": "${encrypted}"`);
    console.log('');
  }

  console.log('════════════════════════════════════════════════════════════════');
}

// ============================================================================
// CLI Mode
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    value: null,
    envVar: null,
    decrypt: null,
    generateKey: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--generate-key') {
      options.generateKey = true;
    } else if (arg === '--value' && args[i + 1]) {
      options.value = args[++i];
    } else if (arg === '--env-var' && args[i + 1]) {
      options.envVar = args[++i];
    } else if (arg === '--decrypt' && args[i + 1]) {
      options.decrypt = args[++i];
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Credential Encryption Utility

Usage:
  node scripts/encrypt-credential.js [options]

Options:
  --help, -h          Show this help message
  --generate-key      Generate a new protection key
  --value <value>     Encrypt the specified value
  --env-var <name>    Include env var name in output (for .mcp.json)
  --decrypt <value>   Decrypt an encrypted value (for debugging)

Examples:
  # Interactive mode
  node scripts/encrypt-credential.js

  # Generate new protection key
  node scripts/encrypt-credential.js --generate-key

  # Encrypt a value
  node scripts/encrypt-credential.js --value "my-api-key"

  # Encrypt with env var name for .mcp.json
  node scripts/encrypt-credential.js --value "my-api-key" --env-var SUPABASE_SERVICE_ROLE_KEY

  # Decrypt (for debugging)
  node scripts/encrypt-credential.js --decrypt '\${GENTYR_ENCRYPTED:...}'

Security:
  The protection key is stored at: .claude/protection-key
  After setup, make it root-owned:
    sudo chown root:root .claude/protection-key
    sudo chmod 600 .claude/protection-key
`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (options.generateKey) {
    const newKey = generateKey();
    writeKey(newKey);
    console.log('Generated new protection key.');
    console.log(`Saved to: ${PROTECTION_KEY_PATH}`);
    console.log('');
    console.log('IMPORTANT: Make the key file root-owned:');
    console.log(`  sudo chown root:root ${PROTECTION_KEY_PATH}`);
    console.log(`  sudo chmod 600 ${PROTECTION_KEY_PATH}`);
    process.exit(0);
  }

  if (options.decrypt) {
    const key = readKey();
    if (!key) {
      console.error('Error: No protection key found. Cannot decrypt.');
      process.exit(1);
    }

    try {
      const decrypted = decrypt(options.decrypt, key);
      console.log('Decrypted value:');
      console.log(decrypted);
    } catch (err) {
      console.error(`Decryption failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (options.value) {
    let key = readKey();
    if (!key) {
      console.log('No protection key found. Generating new key...');
      const newKey = generateKey();
      writeKey(newKey);
      key = Buffer.from(newKey, 'base64');
      console.log(`Saved to: ${PROTECTION_KEY_PATH}`);
      console.log('');
    }

    const encrypted = encrypt(options.value, key);

    if (options.envVar) {
      // Output in .mcp.json format
      console.log(`"${options.envVar}": "${encrypted}"`);
    } else {
      console.log(encrypted);
    }
    process.exit(0);
  }

  // No CLI options provided, run interactive mode
  await interactiveMode();
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
