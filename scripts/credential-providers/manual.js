#!/usr/bin/env node
/**
 * Manual Credential Provider
 *
 * Prompts the user interactively for each credential value.
 * This is the fallback provider when no automated provider is available.
 *
 * @version 1.0.0
 */

import * as readline from 'readline';

export const name = 'Manual Input';

/**
 * Manual provider is always available (just requires human input).
 * @returns {Promise<boolean>}
 */
export async function isAvailable() {
  // Only available in interactive terminal
  return process.stdin.isTTY === true;
}

/**
 * Prompt the user for a credential value.
 * @param {string} key - Environment variable name
 * @param {string} vaultRef - Hint/description (not used for lookup, just displayed)
 * @returns {Promise<string>} The credential value entered by the user
 * @throws {Error} If no value entered or not interactive
 */
export async function resolve(key, vaultRef) {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Manual credential provider requires an interactive terminal.\n` +
      `Cannot prompt for ${key}. Use a different provider (e.g., onepassword).`
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // Use stderr to not interfere with stdout
  });

  return new Promise((resolve, reject) => {
    const hint = vaultRef ? ` (hint: ${vaultRef})` : '';
    rl.question(`  Enter value for ${key}${hint}: `, (answer) => {
      rl.close();
      const value = answer.trim();
      if (!value) {
        reject(new Error(`No value entered for ${key}. Credential is required.`));
      } else {
        resolve(value);
      }
    });
  });
}
