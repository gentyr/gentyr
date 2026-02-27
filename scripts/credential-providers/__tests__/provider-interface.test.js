/**
 * Unit tests for credential provider interface.
 * Tests loadProvider() and loadProviderConfig() exported from provider-interface.js.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadProvider, loadProviderConfig } from '../provider-interface.js';

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

// ---------------------------------------------------------------------------
// loadProvider — input validation (provider name)
// ---------------------------------------------------------------------------

describe('loadProvider() — provider name validation', () => {
  it('throws on empty string providerName', async () => {
    await expect(loadProvider('', '/tmp/fake-project')).rejects.toThrow('Invalid provider name');
  });

  it('throws on null providerName', async () => {
    await expect(loadProvider(null, '/tmp/fake-project')).rejects.toThrow('Invalid provider name');
  });

  it('throws on numeric providerName', async () => {
    await expect(loadProvider(123, '/tmp/fake-project')).rejects.toThrow('Invalid provider name');
  });

  it('throws on path-traversal providerName and includes must-be message', async () => {
    await expect(loadProvider('../../etc/evil', '/tmp/fake-project')).rejects.toThrow(
      'Must be lowercase alphanumeric with hyphens only'
    );
  });

  it('throws on providerName containing a slash', async () => {
    await expect(loadProvider('foo/bar', '/tmp/fake-project')).rejects.toThrow('Invalid provider name');
  });

  it('throws on providerName containing dots', async () => {
    await expect(loadProvider('foo.bar', '/tmp/fake-project')).rejects.toThrow('Invalid provider name');
  });

  it('throws on providerName with uppercase letters', async () => {
    await expect(loadProvider('OnePassword', '/tmp/fake-project')).rejects.toThrow('Invalid provider name');
  });
});

// ---------------------------------------------------------------------------
// loadProvider — input validation (projectDir)
// ---------------------------------------------------------------------------

describe('loadProvider() — projectDir validation', () => {
  it('throws on empty string projectDir', async () => {
    await expect(loadProvider('manual', '')).rejects.toThrow('projectDir must be a non-empty string');
  });

  it('throws on null projectDir', async () => {
    await expect(loadProvider('manual', null)).rejects.toThrow('projectDir must be a non-empty string');
  });
});

// ---------------------------------------------------------------------------
// loadProvider — valid provider names (format accepted, may still throw "not found")
// ---------------------------------------------------------------------------

describe('loadProvider() — valid provider name formats', () => {
  it('accepts hyphenated provider name without "Invalid provider name" error', async () => {
    const tempDir = makeTempDir();
    // Should only throw "not found", never the name-validation error.
    const rejection = loadProvider('my-custom-provider', tempDir);
    await expect(rejection).rejects.not.toThrow('Invalid provider name');
    await expect(rejection).rejects.toThrow(/not found|Credential provider/i);
  });

  it('accepts purely alphanumeric provider name without "Invalid provider name" error', async () => {
    const tempDir = makeTempDir();
    const rejection = loadProvider('myprovider123', tempDir);
    await expect(rejection).rejects.not.toThrow('Invalid provider name');
    await expect(rejection).rejects.toThrow(/not found|Credential provider/i);
  });
});

// ---------------------------------------------------------------------------
// loadProvider — builtin providers
// ---------------------------------------------------------------------------

describe('loadProvider() — builtin provider loading', () => {
  it('loads builtin provider "manual" and returns required interface', async () => {
    const tempDir = makeTempDir();
    const provider = await loadProvider('manual', tempDir);

    expect(typeof provider.name).toBe('string');
    expect(provider.name.length).toBeGreaterThan(0);
    expect(typeof provider.isAvailable).toBe('function');
    expect(typeof provider.resolve).toBe('function');
  });

  it('loads builtin provider "onepassword" and returns required interface', async () => {
    const tempDir = makeTempDir();
    const provider = await loadProvider('onepassword', tempDir);

    expect(typeof provider.name).toBe('string');
    expect(provider.name.length).toBeGreaterThan(0);
    expect(typeof provider.isAvailable).toBe('function');
    expect(typeof provider.resolve).toBe('function');
  });

  it('throws "not found" for a non-existent provider', async () => {
    const tempDir = makeTempDir();
    await expect(loadProvider('nonexistent', tempDir)).rejects.toThrow(
      'Credential provider "nonexistent" not found'
    );
  });
});

// ---------------------------------------------------------------------------
// loadProvider — project-local provider
// ---------------------------------------------------------------------------

describe('loadProvider() — project-local provider', () => {
  it('loads a valid project-local provider and returns the required interface', async () => {
    const tempDir = makeTempDir();
    const providerDir = path.join(tempDir, '.claude', 'credential-providers');
    fs.mkdirSync(providerDir, { recursive: true });

    fs.writeFileSync(
      path.join(providerDir, 'test-provider.js'),
      [
        'export const name = "Test Provider";',
        'export async function isAvailable() { return true; }',
        'export async function resolve(key, vaultRef) { return "test-value"; }',
      ].join('\n')
    );

    const provider = await loadProvider('test-provider', tempDir);

    expect(typeof provider.name).toBe('string');
    expect(provider.name).toBe('Test Provider');
    expect(typeof provider.isAvailable).toBe('function');
    expect(typeof provider.resolve).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// validateProvider (exercised indirectly via project-local providers)
// ---------------------------------------------------------------------------

describe('validateProvider() — invalid provider exports (via project-local loading)', () => {
  it('throws when provider is missing the "name" export', async () => {
    const tempDir = makeTempDir();
    const providerDir = path.join(tempDir, '.claude', 'credential-providers');
    fs.mkdirSync(providerDir, { recursive: true });

    // Intentionally omit `name`
    fs.writeFileSync(
      path.join(providerDir, 'no-name.js'),
      [
        'export async function isAvailable() { return true; }',
        'export async function resolve(key, vaultRef) { return "val"; }',
      ].join('\n')
    );

    await expect(loadProvider('no-name', tempDir)).rejects.toThrow("must export a 'name' string");
  });

  it('throws when provider is missing the "isAvailable" export', async () => {
    const tempDir = makeTempDir();
    const providerDir = path.join(tempDir, '.claude', 'credential-providers');
    fs.mkdirSync(providerDir, { recursive: true });

    // Intentionally omit `isAvailable`
    fs.writeFileSync(
      path.join(providerDir, 'no-available.js'),
      [
        'export const name = "No Available Provider";',
        'export async function resolve(key, vaultRef) { return "val"; }',
      ].join('\n')
    );

    await expect(loadProvider('no-available', tempDir)).rejects.toThrow(
      "must export an 'isAvailable()' function"
    );
  });

  it('throws when provider is missing the "resolve" export', async () => {
    const tempDir = makeTempDir();
    const providerDir = path.join(tempDir, '.claude', 'credential-providers');
    fs.mkdirSync(providerDir, { recursive: true });

    // Intentionally omit `resolve`
    fs.writeFileSync(
      path.join(providerDir, 'no-resolve.js'),
      [
        'export const name = "No Resolve Provider";',
        'export async function isAvailable() { return true; }',
      ].join('\n')
    );

    await expect(loadProvider('no-resolve', tempDir)).rejects.toThrow(
      "must export a 'resolve(key, vaultRef)' function"
    );
  });
});

// ---------------------------------------------------------------------------
// loadProviderConfig
// ---------------------------------------------------------------------------

describe('loadProviderConfig()', () => {
  it('returns null when no config file exists', async () => {
    const tempDir = makeTempDir();
    const result = await loadProviderConfig(tempDir);
    expect(result).toBeNull();
  });

  it('throws on empty string projectDir', async () => {
    await expect(loadProviderConfig('')).rejects.toThrow('projectDir must be a non-empty string');
  });

  it('throws on null projectDir', async () => {
    await expect(loadProviderConfig(null)).rejects.toThrow('projectDir must be a non-empty string');
  });

  it('returns parsed JSON when a valid config file exists', async () => {
    const tempDir = makeTempDir();
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    const config = { provider: 'onepassword', vault: 'Production' };
    fs.writeFileSync(
      path.join(claudeDir, 'credential-provider.json'),
      JSON.stringify(config)
    );

    const result = await loadProviderConfig(tempDir);
    expect(result).toEqual(config);
  });

  it('throws with "Failed to read credential provider config" on invalid JSON', async () => {
    const tempDir = makeTempDir();
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    fs.writeFileSync(
      path.join(claudeDir, 'credential-provider.json'),
      '{ this is: not valid json }'
    );

    await expect(loadProviderConfig(tempDir)).rejects.toThrow(
      'Failed to read credential provider config'
    );
  });
});
