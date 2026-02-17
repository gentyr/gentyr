/**
 * Unit tests for credential discovery chain in data-reader.ts
 *
 * Tests the credential resolution logic that discovers API tokens from
 * multiple sources in priority order:
 *   1. CLAUDE_CODE_OAUTH_TOKEN environment variable
 *   2. macOS Keychain (security find-generic-password)
 *   3. CLAUDE_CONFIG_DIR/.credentials.json
 *   4. ~/.claude/.credentials.json (standard fallback)
 *   5. api-key-rotation.json (active keys only)
 *
 * Security-critical: ensures non-active keys are ignored and the fallback
 * chain behaves correctly when sources are missing or fail.
 *
 * Uses inline re-implementations with mocked filesystem/Keychain access
 * for isolation (follows existing test patterns in this suite).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';

// ============================================================================
// Inline re-implementations of credential discovery logic
// (mirrors data-reader.ts without importing — avoids module-level side effects)
// ============================================================================

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
  };
}

interface KeyRotationState {
  version: number;
  active_key_id: string | null;
  keys: Record<string, {
    accessToken?: string;
    subscriptionType: string;
    last_usage: {
      five_hour: number;
      seven_day: number;
    } | null;
    status: 'active' | 'exhausted' | 'invalid' | 'expired';
  }>;
  rotation_log: {
    timestamp: number;
    event: string;
  }[];
}

function extractTokenFromCreds(creds: CredentialsFile): string | null {
  if (!creds.claudeAiOauth?.accessToken) return null;
  if (creds.claudeAiOauth.expiresAt && creds.claudeAiOauth.expiresAt < Date.now()) return null;
  return creds.claudeAiOauth.accessToken;
}

function generateKeyId(accessToken: string): string {
  const cleanToken = accessToken
    .replace(/^sk-ant-oat01-/, '')
    .replace(/^sk-ant-/, '');
  return crypto.createHash('sha256').update(cleanToken).digest('hex').substring(0, 16);
}

// ============================================================================
// extractTokenFromCreds tests
// ============================================================================

describe('extractTokenFromCreds', () => {
  it('should return accessToken when present and not expired', () => {
    const creds: CredentialsFile = {
      claudeAiOauth: {
        accessToken: 'test-token-abc',
        expiresAt: Date.now() + 3600_000, // 1 hour from now
      },
    };
    expect(extractTokenFromCreds(creds)).toBe('test-token-abc');
  });

  it('should return accessToken when expiresAt is not set', () => {
    const creds: CredentialsFile = {
      claudeAiOauth: {
        accessToken: 'token-no-expiry',
      },
    };
    expect(extractTokenFromCreds(creds)).toBe('token-no-expiry');
  });

  it('should return null when token is expired', () => {
    const creds: CredentialsFile = {
      claudeAiOauth: {
        accessToken: 'expired-token',
        expiresAt: Date.now() - 1000, // expired 1 second ago
      },
    };
    expect(extractTokenFromCreds(creds)).toBeNull();
  });

  it('should return null when claudeAiOauth is missing', () => {
    const creds: CredentialsFile = {};
    expect(extractTokenFromCreds(creds)).toBeNull();
  });

  it('should return null when accessToken is missing', () => {
    const creds: CredentialsFile = {
      claudeAiOauth: {
        expiresAt: Date.now() + 3600_000,
      },
    };
    expect(extractTokenFromCreds(creds)).toBeNull();
  });

  it('should return null when accessToken is empty string', () => {
    const creds: CredentialsFile = {
      claudeAiOauth: {
        accessToken: '',
      },
    };
    // Empty string is falsy, so !creds.claudeAiOauth?.accessToken returns true
    expect(extractTokenFromCreds(creds)).toBeNull();
  });
});

// ============================================================================
// getCredentialToken — env var source (Source 1)
// ============================================================================

describe('Credential Discovery - Env var source (CLAUDE_CODE_OAUTH_TOKEN)', () => {
  let savedEnvToken: string | undefined;

  beforeEach(() => {
    savedEnvToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  });

  afterEach(() => {
    if (savedEnvToken !== undefined) {
      process.env['CLAUDE_CODE_OAUTH_TOKEN'] = savedEnvToken;
    } else {
      delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    }
  });

  /**
   * Inline getCredentialToken that only tests Source 1 (env var).
   * Isolates env var priority without filesystem or Keychain dependencies.
   */
  function getCredentialTokenEnvOnly(): string | null {
    const envToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    if (envToken) return envToken;
    return null;
  }

  it('should return env var token when CLAUDE_CODE_OAUTH_TOKEN is set', () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'env-oauth-token-123';
    expect(getCredentialTokenEnvOnly()).toBe('env-oauth-token-123');
  });

  it('should return null when CLAUDE_CODE_OAUTH_TOKEN is not set', () => {
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    expect(getCredentialTokenEnvOnly()).toBeNull();
  });

  it('should return null when CLAUDE_CODE_OAUTH_TOKEN is empty string', () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = '';
    // Empty string is falsy, so the check `if (envToken)` fails
    expect(getCredentialTokenEnvOnly()).toBeNull();
  });
});

// ============================================================================
// getCredentialToken — CLAUDE_CONFIG_DIR source (Source 3)
// ============================================================================

describe('Credential Discovery - CLAUDE_CONFIG_DIR source', () => {
  let tempDir: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = path.join('/tmp', `cred-config-dir-test-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    savedConfigDir = process.env['CLAUDE_CONFIG_DIR'];
  });

  afterEach(() => {
    if (savedConfigDir !== undefined) {
      process.env['CLAUDE_CONFIG_DIR'] = savedConfigDir;
    } else {
      delete process.env['CLAUDE_CONFIG_DIR'];
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Inline getCredentialToken for Source 3 only (CLAUDE_CONFIG_DIR).
   */
  function getTokenFromConfigDir(): string | null {
    const configDir = process.env['CLAUDE_CONFIG_DIR'];
    if (configDir) {
      const configCredsPath = path.join(configDir, '.credentials.json');
      try {
        if (fs.existsSync(configCredsPath)) {
          const creds = JSON.parse(fs.readFileSync(configCredsPath, 'utf8')) as CredentialsFile;
          return extractTokenFromCreds(creds);
        }
      } catch {
        // Fall through
      }
    }
    return null;
  }

  it('should read token from CLAUDE_CONFIG_DIR/.credentials.json', () => {
    process.env['CLAUDE_CONFIG_DIR'] = tempDir;
    const creds: CredentialsFile = {
      claudeAiOauth: {
        accessToken: 'config-dir-token',
        expiresAt: Date.now() + 3600_000,
      },
    };
    fs.writeFileSync(path.join(tempDir, '.credentials.json'), JSON.stringify(creds));

    expect(getTokenFromConfigDir()).toBe('config-dir-token');
  });

  it('should return null when CLAUDE_CONFIG_DIR is not set', () => {
    delete process.env['CLAUDE_CONFIG_DIR'];
    expect(getTokenFromConfigDir()).toBeNull();
  });

  it('should return null when credentials file does not exist in CLAUDE_CONFIG_DIR', () => {
    process.env['CLAUDE_CONFIG_DIR'] = tempDir;
    // No .credentials.json file created
    expect(getTokenFromConfigDir()).toBeNull();
  });

  it('should return null when credentials file is malformed JSON', () => {
    process.env['CLAUDE_CONFIG_DIR'] = tempDir;
    fs.writeFileSync(path.join(tempDir, '.credentials.json'), 'NOT JSON {{{{');
    expect(getTokenFromConfigDir()).toBeNull();
  });

  it('should return null when token in config dir credentials is expired', () => {
    process.env['CLAUDE_CONFIG_DIR'] = tempDir;
    const creds: CredentialsFile = {
      claudeAiOauth: {
        accessToken: 'expired-config-token',
        expiresAt: Date.now() - 1000,
      },
    };
    fs.writeFileSync(path.join(tempDir, '.credentials.json'), JSON.stringify(creds));

    expect(getTokenFromConfigDir()).toBeNull();
  });
});

// ============================================================================
// getCredentialToken — Standard credentials file source (Source 4)
// ============================================================================

describe('Credential Discovery - Standard credentials file (~/.claude/.credentials.json)', () => {
  let tempDir: string;
  let credentialsPath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `cred-standard-test-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    credentialsPath = path.join(tempDir, '.credentials.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Inline getCredentialToken for Source 4 only (standard credentials file).
   */
  function getTokenFromStandardCreds(): string | null {
    try {
      if (fs.existsSync(credentialsPath)) {
        const creds = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as CredentialsFile;
        return extractTokenFromCreds(creds);
      }
    } catch {
      // Fall through
    }
    return null;
  }

  it('should read token from standard credentials file', () => {
    const creds: CredentialsFile = {
      claudeAiOauth: {
        accessToken: 'standard-creds-token',
        expiresAt: Date.now() + 3600_000,
      },
    };
    fs.writeFileSync(credentialsPath, JSON.stringify(creds));

    expect(getTokenFromStandardCreds()).toBe('standard-creds-token');
  });

  it('should return null when standard credentials file does not exist', () => {
    expect(getTokenFromStandardCreds()).toBeNull();
  });

  it('should return null when standard credentials file is malformed', () => {
    fs.writeFileSync(credentialsPath, '{ invalid json }}}');
    expect(getTokenFromStandardCreds()).toBeNull();
  });

  it('should return null when token in standard credentials is expired', () => {
    const creds: CredentialsFile = {
      claudeAiOauth: {
        accessToken: 'expired-standard-token',
        expiresAt: Date.now() - 60_000,
      },
    };
    fs.writeFileSync(credentialsPath, JSON.stringify(creds));

    expect(getTokenFromStandardCreds()).toBeNull();
  });

  it('should return token when expiresAt is not present (no expiration)', () => {
    const creds: CredentialsFile = {
      claudeAiOauth: {
        accessToken: 'no-expiry-token',
      },
    };
    fs.writeFileSync(credentialsPath, JSON.stringify(creds));

    expect(getTokenFromStandardCreds()).toBe('no-expiry-token');
  });
});

// ============================================================================
// getAccessToken — api-key-rotation.json source (Source 5)
// ============================================================================

describe('Credential Discovery - api-key-rotation.json source', () => {
  let tempDir: string;
  let rotationStatePath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `cred-rotation-test-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    rotationStatePath = path.join(tempDir, 'api-key-rotation.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Inline getAccessToken for Source 5 only (rotation state file).
   * Simulates the case where Sources 1-4 return null.
   */
  function getTokenFromRotation(): string | null {
    if (fs.existsSync(rotationStatePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(rotationStatePath, 'utf8')) as KeyRotationState;
        if (state?.version === 1 && state.keys) {
          // Try active key first
          const activeKeyData = state.active_key_id ? state.keys[state.active_key_id] : undefined;
          if (activeKeyData?.accessToken && activeKeyData.status === 'active') {
            return activeKeyData.accessToken;
          }
          // Fallback: any active key
          for (const keyData of Object.values(state.keys)) {
            if (keyData.accessToken && keyData.status === 'active') {
              return keyData.accessToken;
            }
          }
        }
      } catch {
        // Fall through
      }
    }
    return null;
  }

  it('should return token from active key in rotation state', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-abc',
      keys: {
        'key-abc': {
          accessToken: 'rotation-active-token',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'active',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getTokenFromRotation()).toBe('rotation-active-token');
  });

  it('should fallback to any active key when active_key_id is null', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: null,
      keys: {
        'key-xyz': {
          accessToken: 'fallback-active-token',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'active',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getTokenFromRotation()).toBe('fallback-active-token');
  });

  it('should ignore non-active keys (exhausted)', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-exhausted',
      keys: {
        'key-exhausted': {
          accessToken: 'exhausted-token',
          subscriptionType: 'max_5',
          last_usage: { five_hour: 95, seven_day: 80 },
          status: 'exhausted',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getTokenFromRotation()).toBeNull();
  });

  it('should ignore invalid keys', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-invalid',
      keys: {
        'key-invalid': {
          accessToken: 'invalid-token',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'invalid',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getTokenFromRotation()).toBeNull();
  });

  it('should ignore expired keys', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-expired',
      keys: {
        'key-expired': {
          accessToken: 'expired-token',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'expired',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getTokenFromRotation()).toBeNull();
  });

  it('should return null when rotation state file does not exist', () => {
    expect(getTokenFromRotation()).toBeNull();
  });

  it('should return null when rotation state is malformed JSON', () => {
    fs.writeFileSync(rotationStatePath, 'NOT VALID JSON');
    expect(getTokenFromRotation()).toBeNull();
  });

  it('should return null when rotation state has wrong version', () => {
    const state = {
      version: 2,
      active_key_id: 'key-abc',
      keys: {
        'key-abc': {
          accessToken: 'token',
          subscriptionType: 'max_5',
          status: 'active',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getTokenFromRotation()).toBeNull();
  });

  it('should return null when active key has no accessToken', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-no-token',
      keys: {
        'key-no-token': {
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'active',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getTokenFromRotation()).toBeNull();
  });

  it('should skip non-active keys and find first active key with token', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-exhausted',
      keys: {
        'key-exhausted': {
          accessToken: 'exhausted-token',
          subscriptionType: 'max_5',
          last_usage: { five_hour: 100, seven_day: 90 },
          status: 'exhausted',
        },
        'key-invalid': {
          accessToken: 'invalid-token',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'invalid',
        },
        'key-active': {
          accessToken: 'active-fallback-token',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'active',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getTokenFromRotation()).toBe('active-fallback-token');
  });
});

// ============================================================================
// Fallback chain behavior (Sources 1-5 in priority order)
// ============================================================================

describe('Credential Discovery - Fallback chain behavior', () => {
  let tempDir: string;
  let credentialsPath: string;
  let rotationStatePath: string;
  let savedEnvToken: string | undefined;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = path.join('/tmp', `cred-chain-test-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    credentialsPath = path.join(tempDir, '.credentials.json');
    rotationStatePath = path.join(tempDir, 'api-key-rotation.json');
    savedEnvToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    savedConfigDir = process.env['CLAUDE_CONFIG_DIR'];
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    delete process.env['CLAUDE_CONFIG_DIR'];
  });

  afterEach(() => {
    if (savedEnvToken !== undefined) {
      process.env['CLAUDE_CODE_OAUTH_TOKEN'] = savedEnvToken;
    } else {
      delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    }
    if (savedConfigDir !== undefined) {
      process.env['CLAUDE_CONFIG_DIR'] = savedConfigDir;
    } else {
      delete process.env['CLAUDE_CONFIG_DIR'];
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Full fallback chain (Sources 1, 3, 4, 5).
   * Note: Source 2 (macOS Keychain) is omitted since it requires the `security`
   * CLI tool and cannot be reliably mocked without process.platform manipulation.
   */
  function getAccessTokenChain(): string | null {
    // Source 1: Environment variable
    const envToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    if (envToken) return envToken;

    // Source 3: CLAUDE_CONFIG_DIR
    const configDir = process.env['CLAUDE_CONFIG_DIR'];
    if (configDir) {
      const configCredsPath = path.join(configDir, '.credentials.json');
      try {
        if (fs.existsSync(configCredsPath)) {
          const creds = JSON.parse(fs.readFileSync(configCredsPath, 'utf8')) as CredentialsFile;
          const token = extractTokenFromCreds(creds);
          if (token) return token;
        }
      } catch {
        // Fall through
      }
    }

    // Source 4: Standard credentials file
    try {
      if (fs.existsSync(credentialsPath)) {
        const creds = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as CredentialsFile;
        const token = extractTokenFromCreds(creds);
        if (token) return token;
      }
    } catch {
      // Fall through
    }

    // Source 5: Key rotation state
    if (fs.existsSync(rotationStatePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(rotationStatePath, 'utf8')) as KeyRotationState;
        if (state?.version === 1 && state.keys) {
          const activeKeyData = state.active_key_id ? state.keys[state.active_key_id] : undefined;
          if (activeKeyData?.accessToken && activeKeyData.status === 'active') {
            return activeKeyData.accessToken;
          }
          for (const keyData of Object.values(state.keys)) {
            if (keyData.accessToken && keyData.status === 'active') {
              return keyData.accessToken;
            }
          }
        }
      } catch {
        // Fall through
      }
    }

    return null;
  }

  it('should prefer env var over all other sources', () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'env-token';

    // Also set up credentials file and rotation state
    const creds: CredentialsFile = {
      claudeAiOauth: { accessToken: 'creds-token', expiresAt: Date.now() + 3600_000 },
    };
    fs.writeFileSync(credentialsPath, JSON.stringify(creds));

    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-1',
      keys: { 'key-1': { accessToken: 'rotation-token', subscriptionType: 'max_5', last_usage: null, status: 'active' } },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getAccessTokenChain()).toBe('env-token');
  });

  it('should fall back to CLAUDE_CONFIG_DIR when env var is absent', () => {
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env['CLAUDE_CONFIG_DIR'] = configDir;

    const creds: CredentialsFile = {
      claudeAiOauth: { accessToken: 'config-dir-token', expiresAt: Date.now() + 3600_000 },
    };
    fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify(creds));

    expect(getAccessTokenChain()).toBe('config-dir-token');
  });

  it('should fall back to standard credentials when env and config dir are absent', () => {
    const creds: CredentialsFile = {
      claudeAiOauth: { accessToken: 'standard-token', expiresAt: Date.now() + 3600_000 },
    };
    fs.writeFileSync(credentialsPath, JSON.stringify(creds));

    expect(getAccessTokenChain()).toBe('standard-token');
  });

  it('should fall back to rotation state when all credential sources fail', () => {
    // No env var, no config dir, no standard credentials
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-1',
      keys: { 'key-1': { accessToken: 'rotation-fallback-token', subscriptionType: 'max_5', last_usage: null, status: 'active' } },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getAccessTokenChain()).toBe('rotation-fallback-token');
  });

  it('should return null when all sources fail', () => {
    // Nothing configured — no env var, no config dir, no creds file, no rotation state
    expect(getAccessTokenChain()).toBeNull();
  });

  it('should skip expired credentials and fall back to next source', () => {
    // Expired standard credentials
    const creds: CredentialsFile = {
      claudeAiOauth: { accessToken: 'expired-standard', expiresAt: Date.now() - 1000 },
    };
    fs.writeFileSync(credentialsPath, JSON.stringify(creds));

    // Active rotation key
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-1',
      keys: { 'key-1': { accessToken: 'rotation-token', subscriptionType: 'max_5', last_usage: null, status: 'active' } },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getAccessTokenChain()).toBe('rotation-token');
  });

  it('should skip malformed credentials file and fall back to rotation state', () => {
    fs.writeFileSync(credentialsPath, 'NOT JSON AT ALL');

    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-1',
      keys: { 'key-1': { accessToken: 'rotation-from-malformed', subscriptionType: 'max_5', last_usage: null, status: 'active' } },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getAccessTokenChain()).toBe('rotation-from-malformed');
  });
});

// ============================================================================
// collectAllKeys — Key collection and deduplication
// ============================================================================

describe('Credential Discovery - collectAllKeys behavior', () => {
  let tempDir: string;
  let rotationStatePath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `collect-keys-test-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    rotationStatePath = path.join(tempDir, 'api-key-rotation.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  interface CollectedKey {
    key_id: string;
    access_token: string;
    subscription_type: string;
    is_current: boolean;
  }

  /**
   * Inline collectAllKeys that reads from rotation state file.
   * credToken parameter simulates the result of getCredentialToken().
   */
  function collectAllKeys(credToken: string | null): { keys: CollectedKey[]; rotationState: KeyRotationState | null } {
    const keyMap = new Map<string, CollectedKey>();
    let rotationState: KeyRotationState | null = null;

    // Source A: Key rotation state file
    if (fs.existsSync(rotationStatePath)) {
      try {
        const content = fs.readFileSync(rotationStatePath, 'utf8');
        const state = JSON.parse(content) as KeyRotationState;
        if (state?.version === 1 && typeof state.keys === 'object') {
          rotationState = state;
          for (const [keyId, keyData] of Object.entries(state.keys)) {
            if (keyData.status === 'invalid' || keyData.status === 'expired') continue;
            if (!keyData.accessToken) continue;
            keyMap.set(keyId, {
              key_id: keyId,
              access_token: keyData.accessToken,
              subscription_type: keyData.subscriptionType || 'unknown',
              is_current: keyId === state.active_key_id,
            });
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Source B: Current credentials
    if (credToken) {
      const credKeyId = generateKeyId(credToken);
      if (!keyMap.has(credKeyId)) {
        keyMap.set(credKeyId, {
          key_id: credKeyId,
          access_token: credToken,
          subscription_type: 'unknown',
          is_current: !rotationState,
        });
      }
    }

    return { keys: Array.from(keyMap.values()), rotationState };
  }

  it('should collect active keys from rotation state', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-abc',
      keys: {
        'key-abc': {
          accessToken: 'token-abc',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'active',
        },
        'key-def': {
          accessToken: 'token-def',
          subscriptionType: 'pro',
          last_usage: null,
          status: 'active',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    const result = collectAllKeys(null);
    expect(result.keys).toHaveLength(2);
    expect(result.keys.find(k => k.key_id === 'key-abc')?.is_current).toBe(true);
    expect(result.keys.find(k => k.key_id === 'key-def')?.is_current).toBe(false);
  });

  it('should include exhausted keys (they may have recovered)', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-active',
      keys: {
        'key-active': {
          accessToken: 'token-active',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'active',
        },
        'key-exhausted': {
          accessToken: 'token-exhausted',
          subscriptionType: 'max_5',
          last_usage: { five_hour: 100, seven_day: 90 },
          status: 'exhausted',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    const result = collectAllKeys(null);
    expect(result.keys).toHaveLength(2);
    expect(result.keys.find(k => k.key_id === 'key-exhausted')).toBeDefined();
  });

  it('should exclude invalid keys', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: null,
      keys: {
        'key-invalid': {
          accessToken: 'token-invalid',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'invalid',
        },
        'key-active': {
          accessToken: 'token-active',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'active',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    const result = collectAllKeys(null);
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].key_id).toBe('key-active');
  });

  it('should exclude expired keys', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: null,
      keys: {
        'key-expired': {
          accessToken: 'token-expired',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'expired',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    const result = collectAllKeys(null);
    expect(result.keys).toHaveLength(0);
  });

  it('should skip keys without accessToken', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-no-token',
      keys: {
        'key-no-token': {
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'active',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    const result = collectAllKeys(null);
    expect(result.keys).toHaveLength(0);
  });

  it('should deduplicate credential token if already in rotation state', () => {
    const sharedToken = 'sk-ant-oat01-shared-token-value';
    const sharedKeyId = generateKeyId(sharedToken);

    const state: KeyRotationState = {
      version: 1,
      active_key_id: sharedKeyId,
      keys: {
        [sharedKeyId]: {
          accessToken: sharedToken,
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'active',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    // Pass the same token as credToken — should be deduplicated
    const result = collectAllKeys(sharedToken);
    expect(result.keys).toHaveLength(1);
    // The rotation state entry should win (has subscription_type info)
    expect(result.keys[0].subscription_type).toBe('max_5');
  });

  it('should add credential token as separate key when not in rotation state', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-rotation',
      keys: {
        'key-rotation': {
          accessToken: 'rotation-token',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'active',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    const result = collectAllKeys('different-credential-token');
    expect(result.keys).toHaveLength(2);
  });

  it('should mark credential token as current when no rotation state exists', () => {
    const result = collectAllKeys('standalone-cred-token');
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].is_current).toBe(true);
    expect(result.keys[0].subscription_type).toBe('unknown');
    expect(result.rotationState).toBeNull();
  });

  it('should mark credential token as NOT current when rotation state exists', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-rotation',
      keys: {
        'key-rotation': {
          accessToken: 'rotation-token',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'active',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    const result = collectAllKeys('different-cred-token');
    const credKey = result.keys.find(k => k.key_id !== 'key-rotation');
    expect(credKey?.is_current).toBe(false);
  });

  it('should return empty keys when all sources fail', () => {
    const result = collectAllKeys(null);
    expect(result.keys).toHaveLength(0);
    expect(result.rotationState).toBeNull();
  });

  it('should handle malformed rotation state gracefully', () => {
    fs.writeFileSync(rotationStatePath, 'NOT JSON');

    const result = collectAllKeys('fallback-token');
    // Should still have the credential token
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].access_token).toBe('fallback-token');
    expect(result.rotationState).toBeNull();
  });
});

// ============================================================================
// generateKeyId — Key ID generation
// ============================================================================

describe('generateKeyId', () => {
  it('should produce a 16-character hex string', () => {
    const keyId = generateKeyId('some-access-token');
    expect(keyId).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(keyId)).toBe(true);
  });

  it('should strip sk-ant-oat01- prefix before hashing', () => {
    const withPrefix = generateKeyId('sk-ant-oat01-rest-of-token');
    const withoutPrefix = generateKeyId('rest-of-token');
    expect(withPrefix).toBe(withoutPrefix);
  });

  it('should strip sk-ant- prefix before hashing', () => {
    const withPrefix = generateKeyId('sk-ant-rest-of-token');
    const withoutPrefix = generateKeyId('rest-of-token');
    expect(withPrefix).toBe(withoutPrefix);
  });

  it('should produce different IDs for different tokens', () => {
    const id1 = generateKeyId('token-alpha');
    const id2 = generateKeyId('token-beta');
    expect(id1).not.toBe(id2);
  });

  it('should produce consistent IDs for the same token', () => {
    const id1 = generateKeyId('consistent-token');
    const id2 = generateKeyId('consistent-token');
    expect(id1).toBe(id2);
  });
});

// ============================================================================
// Security: Non-active keys in rotation file must be ignored
// ============================================================================

describe('Security: Non-active keys in rotation file are ignored', () => {
  let tempDir: string;
  let rotationStatePath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `security-rotation-test-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    rotationStatePath = path.join(tempDir, 'api-key-rotation.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Simulates getAccessToken Source 5 — only returns active keys.
   */
  function getActiveTokenFromRotation(): string | null {
    if (!fs.existsSync(rotationStatePath)) return null;
    try {
      const state = JSON.parse(fs.readFileSync(rotationStatePath, 'utf8')) as KeyRotationState;
      if (state?.version === 1 && state.keys) {
        const activeKeyData = state.active_key_id ? state.keys[state.active_key_id] : undefined;
        if (activeKeyData?.accessToken && activeKeyData.status === 'active') {
          return activeKeyData.accessToken;
        }
        for (const keyData of Object.values(state.keys)) {
          if (keyData.accessToken && keyData.status === 'active') {
            return keyData.accessToken;
          }
        }
      }
    } catch {
      // Fall through
    }
    return null;
  }

  it('should NOT return exhausted key tokens', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-1',
      keys: {
        'key-1': {
          accessToken: 'exhausted-secret-token',
          subscriptionType: 'max_5',
          last_usage: { five_hour: 100, seven_day: 95 },
          status: 'exhausted',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getActiveTokenFromRotation()).toBeNull();
  });

  it('should NOT return invalid key tokens', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-1',
      keys: {
        'key-1': {
          accessToken: 'invalid-secret-token',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'invalid',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getActiveTokenFromRotation()).toBeNull();
  });

  it('should NOT return expired key tokens', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-1',
      keys: {
        'key-1': {
          accessToken: 'expired-secret-token',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'expired',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getActiveTokenFromRotation()).toBeNull();
  });

  it('should return ONLY the active key when multiple keys exist with mixed statuses', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: 'key-active',
      keys: {
        'key-exhausted': {
          accessToken: 'exhausted-secret',
          subscriptionType: 'max_5',
          last_usage: { five_hour: 100, seven_day: 100 },
          status: 'exhausted',
        },
        'key-invalid': {
          accessToken: 'invalid-secret',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'invalid',
        },
        'key-expired': {
          accessToken: 'expired-secret',
          subscriptionType: 'max_5',
          last_usage: null,
          status: 'expired',
        },
        'key-active': {
          accessToken: 'the-only-valid-token',
          subscriptionType: 'max_5',
          last_usage: { five_hour: 30, seven_day: 20 },
          status: 'active',
        },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getActiveTokenFromRotation()).toBe('the-only-valid-token');
  });

  it('should return null when rotation file has only non-active keys', () => {
    const state: KeyRotationState = {
      version: 1,
      active_key_id: null,
      keys: {
        'key-1': { accessToken: 'token-1', subscriptionType: 'max_5', last_usage: null, status: 'exhausted' },
        'key-2': { accessToken: 'token-2', subscriptionType: 'max_5', last_usage: null, status: 'invalid' },
        'key-3': { accessToken: 'token-3', subscriptionType: 'max_5', last_usage: null, status: 'expired' },
      },
      rotation_log: [],
    };
    fs.writeFileSync(rotationStatePath, JSON.stringify(state));

    expect(getActiveTokenFromRotation()).toBeNull();
  });
});
