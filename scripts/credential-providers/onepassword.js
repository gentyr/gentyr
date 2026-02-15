#!/usr/bin/env node
/**
 * 1Password Credential Provider
 *
 * Resolves credentials from 1Password vaults using the `op` CLI.
 * Supports both service account tokens and interactive sign-in.
 *
 * Vault references follow the format: op://VaultName/ItemName/FieldName
 * Example: op://Production/Vercel/token
 *
 * Prerequisites:
 * - 1Password CLI (`op`) installed: https://developer.1password.com/docs/cli
 * - Either OP_SERVICE_ACCOUNT_TOKEN set, or interactive sign-in via `op signin`
 *
 * @version 1.0.0
 */

import { execSync } from 'child_process';

export const name = '1Password';

/**
 * Check if 1Password CLI is installed and authenticated.
 * @returns {Promise<boolean>}
 */
export async function isAvailable() {
  try {
    // Check if `op` CLI exists
    execSync('op --version', { stdio: 'pipe' });

    // Check if authenticated (service account or signed in)
    if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
      return true;
    }

    // Try to list vaults to check auth status
    execSync('op vault list --format json', { stdio: 'pipe', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a credential from 1Password.
 * @param {string} key - Environment variable name (for error messages)
 * @param {string} vaultRef - 1Password vault reference (e.g., 'op://Production/Vercel/token')
 * @returns {Promise<string>} The credential value
 * @throws {Error} If credential cannot be resolved
 */
export async function resolve(key, vaultRef) {
  if (!vaultRef || !vaultRef.startsWith('op://')) {
    throw new Error(
      `Invalid 1Password vault reference for ${key}: "${vaultRef}"\n` +
      `Expected format: op://VaultName/ItemName/FieldName\n` +
      `Example: op://Production/Vercel/token`
    );
  }

  try {
    const value = execSync(`op read "${vaultRef}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      encoding: 'utf8',
    }).trim();

    if (!value) {
      throw new Error(`Empty value returned from 1Password for ${key} (ref: ${vaultRef})`);
    }

    return value;
  } catch (err) {
    const message = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(
      `Failed to resolve ${key} from 1Password:\n` +
      `  Reference: ${vaultRef}\n` +
      `  Error: ${message}\n` +
      `\n` +
      `Ensure:\n` +
      `  1. The 1Password CLI is installed: brew install 1password-cli\n` +
      `  2. You are authenticated: op signin OR set OP_SERVICE_ACCOUNT_TOKEN\n` +
      `  3. The vault reference is correct: op read "${vaultRef}"`
    );
  }
}
