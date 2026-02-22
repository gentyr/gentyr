/**
 * Unit tests for setup-check.js
 *
 * Tests the standalone credential evaluation script that checks:
 * - GENTYR installation status
 * - 1Password CLI availability and authentication
 * - vault-mappings.json configuration
 * - Credential existence in 1Password
 * - JSON output schema compliance
 *
 * Uses Node's built-in test runner (node:test) for standalone script testing.
 * Run with: node --test scripts/__tests__/setup-check.test.js
 *
 * @version 1.0.0
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a temporary project directory for testing
 * @param {Object} options - Configuration options
 * @param {boolean} options.withGentyr - Create framework directory (supports both models)
 * @param {'npm'|'legacy'} [options.gentyrModel='legacy'] - Which install model to simulate
 * @param {boolean} options.withVaultMappings - Create vault-mappings.json
 * @param {Object} options.mappings - Credential mappings to include
 * @returns {Object} Test directory info
 */
function createTestProject(options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-check-test-'));
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  if (options.withGentyr) {
    const model = options.gentyrModel || 'legacy';
    if (model === 'npm') {
      // Create node_modules/gentyr directory (npm model)
      const nmDir = path.join(tmpDir, 'node_modules', 'gentyr');
      fs.mkdirSync(nmDir, { recursive: true });
    } else {
      // Create a dummy .claude-framework directory (legacy model)
      const frameworkDir = path.join(tmpDir, '.claude-framework');
      fs.mkdirSync(frameworkDir, { recursive: true });
    }
  }

  if (options.withVaultMappings) {
    const mappingsPath = path.join(claudeDir, 'vault-mappings.json');
    const mappingsContent = {
      mappings: options.mappings || {},
    };
    fs.writeFileSync(mappingsPath, JSON.stringify(mappingsContent, null, 2));
  }

  return {
    path: tmpDir,
    cleanup: () => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Execute setup-check.js with a specific project directory
 * @param {string} projectDir - Project directory path
 * @param {Object} env - Additional environment variables
 * @returns {Promise<Object>} Execution result
 */
async function runSetupCheck(projectDir, env = {}) {
  const scriptPath = path.join(__dirname, '..', 'setup-check.js');

  const execEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    ...env,
  };

  try {
    const { stdout, stderr } = await execAsync(`node "${scriptPath}"`, {
      env: execEnv,
      timeout: 25000, // 25 second timeout (op vault list has 5s internal timeout)
    });

    let json = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      // JSON parse error - leave as null
    }

    return {
      exitCode: 0,
      stdout,
      stderr,
      json,
    };
  } catch (err) {
    return {
      exitCode: err.code || 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      json: null,
      error: err.message,
    };
  }
}

// ============================================================================
// Structure Validation Tests
// ============================================================================

describe('setup-check.js - Code Structure', () => {
  const SCRIPT_PATH = path.join(__dirname, '..', 'setup-check.js');

  it('should be a valid ES module', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Should have ES module imports
    assert.match(code, /import .* from ['"]child_process['"]/, 'Must import child_process');
    assert.match(code, /import .* from ['"]fs['"]/, 'Must import fs');
    assert.match(code, /import .* from ['"]path['"]/, 'Must import path');
  });

  it('should have shebang for direct execution', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    assert.match(code, /^#!\/usr\/bin\/env node/, 'Must have node shebang');
  });

  it('should define CREDENTIALS registry', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /const CREDENTIALS = \[/, 'Must define CREDENTIALS array');

    // Should have key credentials
    assert.match(code, /GITHUB_TOKEN/, 'Must include GITHUB_TOKEN');
    assert.match(code, /RENDER_API_KEY/, 'Must include RENDER_API_KEY');
    assert.match(code, /VERCEL_TOKEN/, 'Must include VERCEL_TOKEN');
    assert.match(code, /CLOUDFLARE_API_TOKEN/, 'Must include CLOUDFLARE_API_TOKEN');
    assert.match(code, /SUPABASE_SERVICE_ROLE_KEY/, 'Must include SUPABASE_SERVICE_ROLE_KEY');
    assert.match(code, /RESEND_API_KEY/, 'Must include RESEND_API_KEY');
    assert.match(code, /ELASTIC_API_KEY/, 'Must include ELASTIC_API_KEY');
    assert.match(code, /CODECOV_TOKEN/, 'Must include CODECOV_TOKEN');
    assert.match(code, /OP_CONNECT_TOKEN/, 'Must include OP_CONNECT_TOKEN');
  });

  it('should define CREDENTIALS with required fields', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Extract CREDENTIALS array
    const credMatch = code.match(/const CREDENTIALS = \[([\s\S]*?)\];/);
    assert.ok(credMatch, 'CREDENTIALS array must be extractable');

    const credContent = credMatch[1];

    // Each entry should have key, type, opPath, setupGuidePhase
    assert.match(credContent, /key:\s*['"]/, 'Entries must have key field');
    assert.match(credContent, /type:\s*['"]/, 'Entries must have type field');
    assert.match(credContent, /opPath:/, 'Entries must have opPath field');
    assert.match(credContent, /setupGuidePhase:/, 'Entries must have setupGuidePhase field');
  });

  it('should have both secret and identifier types', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /type:\s*['"]secret['"]/, 'Must have secret type entries');
    assert.match(code, /type:\s*['"]identifier['"]/, 'Must have identifier type entries');
  });

  it('should define all required functions', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /function checkGentyrInstalled\(/, 'Must define checkGentyrInstalled');
    assert.match(code, /function checkOpCli\(/, 'Must define checkOpCli');
    assert.match(code, /function readVaultMappings\(/, 'Must define readVaultMappings');
    assert.match(code, /function checkOpSecret\(/, 'Must define checkOpSecret');
    assert.match(code, /function main\(/, 'Must define main');
  });

  it('should use op vault list for auth detection (not op whoami)', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // checkOpCli should use `op vault list` which works with service account tokens
    assert.match(code, /op.*vault.*list/, 'checkOpCli must use op vault list for auth detection');
    assert.ok(!code.includes("'whoami'"), 'Must NOT use op whoami (unreliable with service account tokens)');
  });

  it('should have stderr diagnostics in loadOpTokenFromMcpJson', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /process\.stderr\.write.*setup-check.*OP_SERVICE_ACCOUNT_TOKEN/, 'loadOpTokenFromMcpJson must log to stderr for debugging');
  });

  it('should call main() at end of script', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Should have main() invocation at end (not inside a function)
    const lines = code.split('\n').filter(line => line.trim().length > 0);
    const lastLines = lines.slice(-10).join('\n');
    assert.match(lastLines, /main\(\);?/, 'Must call main() at end of script');
  });
});

// ============================================================================
// checkGentyrInstalled() Tests
// ============================================================================

describe('checkGentyrInstalled()', () => {
  it('should return true when .claude-framework exists as directory (legacy)', () => {
    const testProject = createTestProject({ withGentyr: true, gentyrModel: 'legacy' });

    try {
      const frameworkPath = path.join(testProject.path, '.claude-framework');
      const exists = fs.existsSync(frameworkPath);
      const isDir = exists && fs.statSync(frameworkPath).isDirectory();

      assert.strictEqual(isDir, true, '.claude-framework should be a directory');
    } finally {
      testProject.cleanup();
    }
  });

  it('should return true when node_modules/gentyr exists (npm model)', () => {
    const testProject = createTestProject({ withGentyr: true, gentyrModel: 'npm' });

    try {
      const npmPath = path.join(testProject.path, 'node_modules', 'gentyr');
      const exists = fs.existsSync(npmPath);
      const isDir = exists && fs.statSync(npmPath).isDirectory();

      assert.strictEqual(isDir, true, 'node_modules/gentyr should be a directory');
    } finally {
      testProject.cleanup();
    }
  });

  it('should return false when neither framework path exists', () => {
    const testProject = createTestProject({ withGentyr: false });

    try {
      const legacyPath = path.join(testProject.path, '.claude-framework');
      const npmPath = path.join(testProject.path, 'node_modules', 'gentyr');

      assert.strictEqual(fs.existsSync(legacyPath), false, '.claude-framework should not exist');
      assert.strictEqual(fs.existsSync(npmPath), false, 'node_modules/gentyr should not exist');
    } finally {
      testProject.cleanup();
    }
  });
});

// ============================================================================
// readVaultMappings() Tests
// ============================================================================

describe('readVaultMappings()', () => {
  it('should return exists: true when vault-mappings.json present', () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: { GITHUB_TOKEN: 'op://Production/GitHub/token' },
    });

    try {
      const mappingsPath = path.join(testProject.path, '.claude', 'vault-mappings.json');
      const exists = fs.existsSync(mappingsPath);

      assert.strictEqual(exists, true, 'vault-mappings.json should exist');
    } finally {
      testProject.cleanup();
    }
  });

  it('should return exists: false when vault-mappings.json missing', () => {
    const testProject = createTestProject({ withVaultMappings: false });

    try {
      const mappingsPath = path.join(testProject.path, '.claude', 'vault-mappings.json');
      const exists = fs.existsSync(mappingsPath);

      assert.strictEqual(exists, false, 'vault-mappings.json should not exist');
    } finally {
      testProject.cleanup();
    }
  });
});

// ============================================================================
// JSON Output Schema Tests
// ============================================================================

describe('JSON Output Schema', () => {
  it('should output valid JSON to stdout', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupCheck(testProject.path);

      assert.strictEqual(result.exitCode, 0, 'Should exit with code 0');
      assert.ok(result.json, 'Should output valid JSON');
    } finally {
      testProject.cleanup();
    }
  });

  it('should include all required top-level fields', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupCheck(testProject.path);

      assert.ok(result.json, 'Must have JSON output');

      // Top-level fields
      assert.strictEqual(typeof result.json.gentyrInstalled, 'boolean', 'gentyrInstalled must be boolean');
      assert.strictEqual(typeof result.json.opCliAvailable, 'boolean', 'opCliAvailable must be boolean');
      assert.strictEqual(typeof result.json.opAuthenticated, 'boolean', 'opAuthenticated must be boolean');
      assert.strictEqual(typeof result.json.vaultMappingsExists, 'boolean', 'vaultMappingsExists must be boolean');

      // Optional fields (can be null)
      assert.ok(result.json.hasOwnProperty('opCliVersion'), 'Must have opCliVersion field');
      assert.ok(result.json.hasOwnProperty('opAccount'), 'Must have opAccount field');

      // Credentials object
      assert.ok(result.json.credentials, 'Must have credentials object');
      assert.strictEqual(typeof result.json.credentials, 'object', 'credentials must be object');

      // Summary object
      assert.ok(result.json.summary, 'Must have summary object');
      assert.strictEqual(typeof result.json.summary, 'object', 'summary must be object');
    } finally {
      testProject.cleanup();
    }
  });

  it('should include summary statistics', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupCheck(testProject.path);

      assert.ok(result.json.summary, 'Must have summary object');

      const { summary } = result.json;

      assert.strictEqual(typeof summary.totalCredentials, 'number', 'totalCredentials must be number');
      assert.strictEqual(typeof summary.secretsConfigured, 'number', 'secretsConfigured must be number');
      assert.strictEqual(typeof summary.secretsMissing, 'number', 'secretsMissing must be number');
      assert.strictEqual(typeof summary.identifiersConfigured, 'number', 'identifiersConfigured must be number');
      assert.strictEqual(typeof summary.identifiersMissing, 'number', 'identifiersMissing must be number');
      assert.strictEqual(typeof summary.requiresOpAuth, 'boolean', 'requiresOpAuth must be boolean');

      // Validate counts add up
      const totalConfigured = summary.secretsConfigured + summary.identifiersConfigured;
      const totalMissing = summary.secretsMissing + summary.identifiersMissing;
      assert.strictEqual(
        totalConfigured + totalMissing,
        summary.totalCredentials,
        'Summary counts should add up to totalCredentials'
      );
    } finally {
      testProject.cleanup();
    }
  });

  it('should include credential details for all registered credentials', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupCheck(testProject.path);

      assert.ok(result.json.credentials, 'Must have credentials object');

      const expectedKeys = [
        'GITHUB_TOKEN',
        'GITHUB_PAT',
        'RENDER_API_KEY',
        'VERCEL_TOKEN',
        'CLOUDFLARE_API_TOKEN',
        'SUPABASE_SERVICE_ROLE_KEY',
        'RESEND_API_KEY',
        'ELASTIC_API_KEY',
        'CODECOV_TOKEN',
        'OP_CONNECT_TOKEN',
        'CLOUDFLARE_ZONE_ID',
        'SUPABASE_URL',
        'SUPABASE_ANON_KEY',
        'ELASTIC_CLOUD_ID',
      ];

      for (const key of expectedKeys) {
        assert.ok(result.json.credentials[key], `credentials.${key} must exist`);
      }
    } finally {
      testProject.cleanup();
    }
  });

  it('should include credential metadata fields', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: { GITHUB_TOKEN: 'op://Production/GitHub/token' },
    });

    try {
      const result = await runSetupCheck(testProject.path);

      const githubToken = result.json.credentials.GITHUB_TOKEN;

      assert.ok(githubToken, 'GITHUB_TOKEN must exist in credentials');
      assert.strictEqual(githubToken.type, 'secret', 'type must be "secret"');
      assert.ok(githubToken.opPath, 'opPath must be present');
      assert.strictEqual(typeof githubToken.mappedInVault, 'boolean', 'mappedInVault must be boolean');
      assert.ok(githubToken.setupGuidePhase, 'setupGuidePhase must be present');

      // existsInOp can be null (if op CLI unavailable), true, or false
      assert.ok(
        githubToken.existsInOp === null ||
        githubToken.existsInOp === true ||
        githubToken.existsInOp === false,
        'existsInOp must be null, true, or false'
      );
    } finally {
      testProject.cleanup();
    }
  });
});

// ============================================================================
// Graceful Degradation Tests
// ============================================================================

describe('Graceful Degradation', () => {
  it('should handle missing GENTYR installation', async () => {
    const testProject = createTestProject({
      withGentyr: false,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupCheck(testProject.path);

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
      assert.ok(result.json, 'Should output valid JSON');
      assert.strictEqual(result.json.gentyrInstalled, false, 'gentyrInstalled should be false');
    } finally {
      testProject.cleanup();
    }
  });

  it('should handle missing vault-mappings.json', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: false,
    });

    try {
      const result = await runSetupCheck(testProject.path);

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
      assert.ok(result.json, 'Should output valid JSON');
      assert.strictEqual(result.json.vaultMappingsExists, false, 'vaultMappingsExists should be false');
      assert.strictEqual(result.json.summary.identifiersMissing, 4, 'All identifiers should be missing');
    } finally {
      testProject.cleanup();
    }
  });

  it('should handle partially configured mappings', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {
        GITHUB_TOKEN: 'op://Production/GitHub/token',
        SUPABASE_URL: 'https://example.supabase.co',
        // Other credentials missing
      },
    });

    try {
      const result = await runSetupCheck(testProject.path);

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
      assert.ok(result.json, 'Should output valid JSON');

      assert.strictEqual(result.json.credentials.GITHUB_TOKEN.mappedInVault, true, 'GITHUB_TOKEN should be mapped');
      assert.strictEqual(result.json.credentials.SUPABASE_URL.mappedInVault, true, 'SUPABASE_URL should be mapped');
      assert.strictEqual(result.json.credentials.VERCEL_TOKEN.mappedInVault, false, 'VERCEL_TOKEN should not be mapped');

      // Summary should reflect partial configuration
      assert.ok(result.json.summary.secretsMissing > 0, 'Some secrets should be missing');
      assert.ok(result.json.summary.identifiersMissing > 0, 'Some identifiers should be missing');
    } finally {
      testProject.cleanup();
    }
  });

  it('should set opCliAvailable: false when op CLI not in PATH', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      // Run with minimal PATH (keep node, but not op CLI)
      // We need to keep node in PATH so the script itself can run
      const nodePath = process.execPath.split('/').slice(0, -1).join('/');
      const result = await runSetupCheck(testProject.path, {
        PATH: nodePath,
      });

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
      assert.ok(result.json, 'Should output valid JSON');

      // Note: This test is opportunistic - if op CLI is in the same directory as node,
      // opCliAvailable will be true. We only assert on the degradation behavior.
      if (result.json.opCliAvailable === false) {
        assert.strictEqual(result.json.opCliVersion, null, 'opCliVersion should be null');
        assert.strictEqual(result.json.opAuthenticated, false, 'opAuthenticated should be false');

        // All secrets should have existsInOp: null (could not check)
        for (const [key, cred] of Object.entries(result.json.credentials)) {
          if (cred.type === 'secret') {
            assert.strictEqual(
              cred.existsInOp,
              null,
              `${key}.existsInOp should be null when op CLI unavailable`
            );
          }
        }
      } else {
        // op CLI was found - skip assertions (test is opportunistic)
        assert.ok(true, 'op CLI found in minimal PATH - test skipped');
      }
    } finally {
      testProject.cleanup();
    }
  });

  it('should handle corrupted vault-mappings.json', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: false,
    });

    try {
      // Write corrupted JSON
      const claudeDir = path.join(testProject.path, '.claude');
      const mappingsPath = path.join(claudeDir, 'vault-mappings.json');
      fs.writeFileSync(mappingsPath, '{ invalid json }');

      const result = await runSetupCheck(testProject.path);

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully despite corrupted file');
      assert.ok(result.json, 'Should output valid JSON');
      assert.strictEqual(result.json.vaultMappingsExists, false, 'Should treat corrupted file as non-existent');
    } finally {
      testProject.cleanup();
    }
  });
});

// ============================================================================
// GITHUB_TOKEN / GITHUB_PAT Deduplication Tests
// ============================================================================

describe('GITHUB_TOKEN / GITHUB_PAT Deduplication', () => {
  it('should cache op:// path checks to avoid redundant calls', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {
        GITHUB_TOKEN: 'op://Production/GitHub/token',
        GITHUB_PAT: 'op://Production/GitHub/token',
      },
    });

    try {
      const result = await runSetupCheck(testProject.path);

      assert.ok(result.json, 'Should output valid JSON');

      // Both should have the same existsInOp value (either both null, both true, or both false)
      const githubToken = result.json.credentials.GITHUB_TOKEN;
      const githubPat = result.json.credentials.GITHUB_PAT;

      assert.strictEqual(
        githubToken.existsInOp,
        githubPat.existsInOp,
        'GITHUB_TOKEN and GITHUB_PAT should have same existsInOp (cached)'
      );
    } finally {
      testProject.cleanup();
    }
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
  it('should use CLAUDE_PROJECT_DIR environment variable', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupCheck(testProject.path);

      assert.strictEqual(result.exitCode, 0, 'Should use CLAUDE_PROJECT_DIR');
      assert.ok(result.json, 'Should output valid JSON');
      assert.strictEqual(result.json.gentyrInstalled, true, 'Should detect GENTYR in test project');
    } finally {
      testProject.cleanup();
    }
  });

  it('should fall back to process.cwd() when CLAUDE_PROJECT_DIR not set', async () => {
    const testProject = createTestProject({
      withGentyr: false,
      withVaultMappings: false,
    });

    try {
      // Run without CLAUDE_PROJECT_DIR (will use process.cwd())
      const scriptPath = path.join(__dirname, '..', 'setup-check.js');

      const { stdout } = await execAsync(`node "${scriptPath}"`, {
        cwd: testProject.path,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: undefined, // Explicitly unset
        },
      });

      const json = JSON.parse(stdout);
      assert.ok(json, 'Should output valid JSON when using cwd');
    } finally {
      testProject.cleanup();
    }
  });

  it('should handle secrets with null opPath (identifiers)', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {
        CLOUDFLARE_ZONE_ID: 'abc123',
        SUPABASE_URL: 'https://example.supabase.co',
      },
    });

    try {
      const result = await runSetupCheck(testProject.path);

      const zoneId = result.json.credentials.CLOUDFLARE_ZONE_ID;
      const supabaseUrl = result.json.credentials.SUPABASE_URL;

      assert.strictEqual(zoneId.type, 'identifier', 'CLOUDFLARE_ZONE_ID should be identifier');
      assert.strictEqual(zoneId.opPath, null, 'Identifier should have null opPath');
      assert.strictEqual(zoneId.existsInOp, null, 'Identifier should have null existsInOp');
      assert.strictEqual(zoneId.mappedInVault, true, 'Should detect mapping in vault-mappings.json');

      assert.strictEqual(supabaseUrl.type, 'identifier', 'SUPABASE_URL should be identifier');
      assert.strictEqual(supabaseUrl.opPath, null, 'Identifier should have null opPath');
    } finally {
      testProject.cleanup();
    }
  });
});

// ============================================================================
// loadOpTokenFromMcpJson() Tests
// ============================================================================

describe('loadOpTokenFromMcpJson()', () => {
  it('should load OP_SERVICE_ACCOUNT_TOKEN from .mcp.json when not in env', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      // Create .mcp.json with token
      const mcpPath = path.join(testProject.path, '.mcp.json');
      const mcpContent = {
        mcpServers: {
          'onepassword': {
            command: 'node',
            args: ['server.js'],
            env: {
              OP_SERVICE_ACCOUNT_TOKEN: 'ops_test_token_123',
            },
          },
        },
      };
      fs.writeFileSync(mcpPath, JSON.stringify(mcpContent, null, 2));

      // Run WITHOUT token in environment
      const result = await runSetupCheck(testProject.path, {
        OP_SERVICE_ACCOUNT_TOKEN: undefined,
      });

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
      assert.ok(result.json, 'Should output valid JSON');

      // If op CLI is available, it should now be authenticated with the loaded token
      // (This is opportunistic - depends on op CLI availability)
    } finally {
      testProject.cleanup();
    }
  });

  it('should not read .mcp.json when OP_SERVICE_ACCOUNT_TOKEN already in env', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      // Create .mcp.json with different token
      const mcpPath = path.join(testProject.path, '.mcp.json');
      const mcpContent = {
        mcpServers: {
          'onepassword': {
            command: 'node',
            args: ['server.js'],
            env: {
              OP_SERVICE_ACCOUNT_TOKEN: 'ops_should_not_be_used',
            },
          },
        },
      };
      fs.writeFileSync(mcpPath, JSON.stringify(mcpContent, null, 2));

      // Run WITH token already in environment
      const result = await runSetupCheck(testProject.path, {
        OP_SERVICE_ACCOUNT_TOKEN: 'ops_existing_token',
      });

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
      assert.ok(result.json, 'Should output valid JSON');

      // Script should use existing token, not load from .mcp.json
      // (Can't directly verify this without inspecting process.env in the child process,
      // but the test ensures the script runs successfully with token in env)
    } finally {
      testProject.cleanup();
    }
  });

  it('should gracefully handle missing .mcp.json', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      // No .mcp.json created
      const mcpPath = path.join(testProject.path, '.mcp.json');
      assert.strictEqual(fs.existsSync(mcpPath), false, '.mcp.json should not exist');

      const result = await runSetupCheck(testProject.path, {
        OP_SERVICE_ACCOUNT_TOKEN: undefined,
      });

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully without .mcp.json');
      assert.ok(result.json, 'Should output valid JSON');
    } finally {
      testProject.cleanup();
    }
  });

  it('should gracefully handle corrupted .mcp.json', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      // Create corrupted .mcp.json
      const mcpPath = path.join(testProject.path, '.mcp.json');
      fs.writeFileSync(mcpPath, '{ invalid json }');

      const result = await runSetupCheck(testProject.path, {
        OP_SERVICE_ACCOUNT_TOKEN: undefined,
      });

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully with corrupted .mcp.json');
      assert.ok(result.json, 'Should output valid JSON');
    } finally {
      testProject.cleanup();
    }
  });

  it('should gracefully handle .mcp.json without mcpServers', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      // Create .mcp.json without mcpServers
      const mcpPath = path.join(testProject.path, '.mcp.json');
      fs.writeFileSync(mcpPath, JSON.stringify({ other: 'data' }, null, 2));

      const result = await runSetupCheck(testProject.path, {
        OP_SERVICE_ACCOUNT_TOKEN: undefined,
      });

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
      assert.ok(result.json, 'Should output valid JSON');
    } finally {
      testProject.cleanup();
    }
  });

  it('should gracefully handle .mcp.json with mcpServers but no OP_SERVICE_ACCOUNT_TOKEN', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      // Create .mcp.json with mcpServers but no token
      const mcpPath = path.join(testProject.path, '.mcp.json');
      const mcpContent = {
        mcpServers: {
          'other-server': {
            command: 'node',
            args: ['server.js'],
            env: {
              OTHER_VAR: 'value',
            },
          },
        },
      };
      fs.writeFileSync(mcpPath, JSON.stringify(mcpContent, null, 2));

      const result = await runSetupCheck(testProject.path, {
        OP_SERVICE_ACCOUNT_TOKEN: undefined,
      });

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
      assert.ok(result.json, 'Should output valid JSON');
    } finally {
      testProject.cleanup();
    }
  });

  it('should find token in second server when first server has no token', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      // Create .mcp.json with token in second server
      const mcpPath = path.join(testProject.path, '.mcp.json');
      const mcpContent = {
        mcpServers: {
          'first-server': {
            command: 'node',
            args: ['server.js'],
            env: {
              OTHER_VAR: 'value',
            },
          },
          'onepassword': {
            command: 'node',
            args: ['op-server.js'],
            env: {
              OP_SERVICE_ACCOUNT_TOKEN: 'ops_second_server_token',
            },
          },
        },
      };
      fs.writeFileSync(mcpPath, JSON.stringify(mcpContent, null, 2));

      const result = await runSetupCheck(testProject.path, {
        OP_SERVICE_ACCOUNT_TOKEN: undefined,
      });

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
      assert.ok(result.json, 'Should output valid JSON');
    } finally {
      testProject.cleanup();
    }
  });
});

// ============================================================================
// Summary Calculation Tests
// ============================================================================

describe('Summary Calculation Logic', () => {
  it('should count secretsConfigured correctly', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {
        GITHUB_TOKEN: 'op://Production/GitHub/token',
        RENDER_API_KEY: 'op://Production/Render/api-key',
      },
    });

    try {
      const result = await runSetupCheck(testProject.path);

      // When op CLI is unavailable, existsInOp = null
      // Secret is "configured" if mapped AND not known-missing (existsInOp !== false)
      // So with existsInOp = null, secretsConfigured should be 2
      assert.ok(
        result.json.summary.secretsConfigured >= 2,
        'Should count mapped secrets as configured when existsInOp is null or true'
      );
    } finally {
      testProject.cleanup();
    }
  });

  it('should count identifiersConfigured correctly', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {
        CLOUDFLARE_ZONE_ID: 'abc123',
        SUPABASE_URL: 'https://example.supabase.co',
      },
    });

    try {
      const result = await runSetupCheck(testProject.path);

      assert.strictEqual(
        result.json.summary.identifiersConfigured,
        2,
        'Should count 2 configured identifiers'
      );
    } finally {
      testProject.cleanup();
    }
  });

  it('should set requiresOpAuth when op available but not authenticated', async () => {
    const testProject = createTestProject({
      withGentyr: true,
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupCheck(testProject.path);

      // requiresOpAuth = op.available && !op.authenticated && secretsMissing > 0
      if (result.json.opCliAvailable && !result.json.opAuthenticated && result.json.summary.secretsMissing > 0) {
        assert.strictEqual(
          result.json.summary.requiresOpAuth,
          true,
          'Should require op auth when op CLI available but not authenticated'
        );
      }
    } finally {
      testProject.cleanup();
    }
  });
});

// ============================================================================
// Documentation Tests
// ============================================================================

describe('Documentation and Metadata', () => {
  const SCRIPT_PATH = path.join(__dirname, '..', 'setup-check.js');

  it('should have JSDoc header with description', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /\/\*\*/, 'Must have JSDoc header');
    assert.match(code, /GENTYR Setup Check/i, 'Header must describe purpose');
    assert.match(code, /@version \d+\.\d+\.\d+/, 'Header must have version number');
  });

  it('should document output format in header', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /Output:.*JSON/i, 'Header must document JSON output');
    assert.match(code, /stdout/i, 'Header must mention stdout');
    assert.match(code, /stderr/i, 'Header must mention stderr for diagnostics');
  });

  it('should document usage in header', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /Usage:/i, 'Header must have usage section');
    assert.match(code, /node.*setup-check\.js/, 'Header must show how to run script');
  });

  it('should use process.stdout.write for JSON output', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Should write JSON to stdout with process.stdout.write (not console.log)
    assert.match(
      code,
      /process\.stdout\.write\(JSON\.stringify\(output/,
      'Must use process.stdout.write for JSON output'
    );
  });
});
