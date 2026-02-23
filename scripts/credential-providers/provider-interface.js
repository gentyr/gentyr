#!/usr/bin/env node
/**
 * Credential Provider Interface
 *
 * Defines the contract for pluggable credential providers in GENTYR.
 * Providers resolve credential values from various backends (1Password,
 * manual input, custom vaults, etc.) and inject them into .mcp.json
 * env blocks — never into the shell environment.
 *
 * Security Model:
 * - Credentials go in .mcp.json env blocks (not the shell)
 * - .mcp.json is root-owned (agent can't read or modify)
 * - Gate hook blocks protected MCP tools without CTO approval
 * - Read hook blocks credential files (.mcp.json, .env*, etc.)
 *
 * To create a custom provider:
 * 1. Create a file at .claude/credential-providers/<name>.js in your project
 * 2. Export: { name, isAvailable(), resolve(key, vaultRef) }
 * 3. Set provider in .claude/credential-provider.json
 *
 * @version 1.0.0
 */

import { existsSync, readFileSync } from 'fs';

/**
 * @typedef {Object} CredentialProvider
 * @property {string} name - Human-readable provider name
 * @property {() => Promise<boolean>} isAvailable - Check if provider can be used
 * @property {(key: string, vaultRef: string) => Promise<string>} resolve - Resolve a credential value
 */

/** Only allow alphanumeric and hyphens in provider names to prevent path traversal. */
const PROVIDER_NAME_RE = /^[a-z0-9-]+$/;

/**
 * Load a credential provider by name.
 * Checks project-local providers first, then GENTYR built-in providers.
 *
 * @param {string} providerName - Provider name (e.g., 'onepassword', 'manual')
 * @param {string} projectDir - Project root directory
 * @returns {CredentialProvider} The loaded provider
 * @throws {Error} If provider not found or invalid
 */
export async function loadProvider(providerName, projectDir) {
  if (typeof providerName !== 'string' || !PROVIDER_NAME_RE.test(providerName)) {
    throw new Error(
      `Invalid provider name "${providerName}". ` +
      `Must be lowercase alphanumeric with hyphens only (e.g., 'onepassword', 'manual').`
    );
  }
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    throw new Error('projectDir must be a non-empty string.');
  }

  // 1. Check project-local providers first
  const localPath = `${projectDir}/.claude/credential-providers/${providerName}.js`;

  if (existsSync(localPath)) {
    const provider = await import(localPath);
    validateProvider(provider, providerName, localPath);
    return provider;
  }

  // 2. Check GENTYR built-in providers
  const builtinPath = new URL(`./${providerName}.js`, import.meta.url).pathname;
  if (existsSync(builtinPath)) {
    const provider = await import(builtinPath);
    validateProvider(provider, providerName, builtinPath);
    return provider;
  }

  throw new Error(
    `Credential provider "${providerName}" not found.\n` +
    `Checked:\n` +
    `  - ${localPath} (project-local)\n` +
    `  - ${builtinPath} (GENTYR built-in)\n` +
    `Available built-in providers: onepassword, manual`
  );
}

/**
 * Validate that a provider module exports the required interface.
 * @param {object} provider - The imported provider module
 * @param {string} name - Provider name (for error messages)
 * @param {string} filepath - Provider file path (for error messages)
 */
function validateProvider(provider, name, filepath) {
  if (typeof provider.name !== 'string') {
    throw new Error(`Provider "${name}" at ${filepath} must export a 'name' string.`);
  }
  if (typeof provider.isAvailable !== 'function') {
    throw new Error(`Provider "${name}" at ${filepath} must export an 'isAvailable()' function.`);
  }
  if (typeof provider.resolve !== 'function') {
    throw new Error(`Provider "${name}" at ${filepath} must export a 'resolve(key, vaultRef)' function.`);
  }
}

/**
 * Load credential provider configuration for a project.
 * @param {string} projectDir - Project root directory
 * @returns {object|null} Config object or null if not configured
 */
export async function loadProviderConfig(projectDir) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    throw new Error('projectDir must be a non-empty string.');
  }

  const configPath = `${projectDir}/.claude/credential-provider.json`;

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read credential provider config at ${configPath}: ${err.message}`);
  }
}
