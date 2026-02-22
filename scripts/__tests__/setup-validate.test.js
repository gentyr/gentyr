/**
 * Unit tests for setup-validate.js
 *
 * Tests the standalone permission validation script that checks:
 * - Credential resolution from vault-mappings.json
 * - Service health checks via read-only API calls
 * - JSON output schema compliance
 * - Graceful degradation for missing credentials
 * - Git remote parsing for GitHub/Codecov owner/repo
 *
 * Uses Node's built-in test runner (node:test) for standalone script testing.
 * Run with: node --test scripts/__tests__/setup-validate.test.js
 *
 * @version 1.0.0
 */

import { describe, it } from 'node:test';
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
 * @param {boolean} options.withVaultMappings - Create vault-mappings.json
 * @param {Object} options.mappings - Credential mappings to include
 * @param {boolean} options.withGitRemote - Initialize a git repo with origin remote
 * @param {string} options.remoteUrl - Git remote URL to use
 * @returns {Object} Test directory info
 */
function createTestProject(options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-validate-test-'));
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  if (options.withVaultMappings) {
    const mappingsPath = path.join(claudeDir, 'vault-mappings.json');
    const mappingsContent = {
      provider: '1password',
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
 * Execute setup-validate.js with a specific project directory
 * @param {string} projectDir - Project directory path
 * @param {Object} env - Additional environment variables
 * @param {string[]} extraArgs - Extra CLI arguments
 * @returns {Promise<Object>} Execution result
 */
async function runSetupValidate(projectDir, env = {}, extraArgs = []) {
  const scriptPath = path.join(__dirname, '..', 'setup-validate.js');
  const args = extraArgs.length > 0 ? ` ${extraArgs.join(' ')}` : '';

  const execEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    // Don't use real OP token for tests
    OP_SERVICE_ACCOUNT_TOKEN: undefined,
    ...env,
  };

  try {
    const { stdout, stderr } = await execAsync(`node "${scriptPath}"${args}`, {
      env: execEnv,
      timeout: 45000, // 45 second timeout (validations have their own timeouts)
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
    let json = null;
    try {
      json = JSON.parse(err.stdout || '');
    } catch {
      // Ignore
    }

    return {
      exitCode: err.code || 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      json,
      error: err.message,
    };
  }
}

// ============================================================================
// Structure Validation Tests
// ============================================================================

describe('setup-validate.js - Code Structure', () => {
  const SCRIPT_PATH = path.join(__dirname, '..', 'setup-validate.js');

  it('should be a valid ES module', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /import .* from ['"]child_process['"]/, 'Must import child_process');
    assert.match(code, /import .* from ['"]fs['"]/, 'Must import fs');
    assert.match(code, /import .* from ['"]path['"]/, 'Must import path');
  });

  it('should have shebang for direct execution', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    assert.match(code, /^#!\/usr\/bin\/env node/, 'Must have node shebang');
  });

  it('should define SERVICE_VALIDATORS registry', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /const SERVICE_VALIDATORS = \[/, 'Must define SERVICE_VALIDATORS array');
  });

  it('should include all required service validators', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    const expectedServices = [
      'vercel', 'render', 'github', 'cloudflare',
      'supabase', 'resend', 'elastic', 'codecov', 'onepassword', 'shellSync',
    ];

    for (const service of expectedServices) {
      assert.match(code, new RegExp(`name:\\s*['"]${service}['"]`), `Must include ${service} validator`);
    }
  });

  it('should define fetchWithTimeout helper', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    assert.match(code, /function fetchWithTimeout\(/, 'Must define fetchWithTimeout');
  });

  it('should define parseGitRemote helper', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    assert.match(code, /function parseGitRemote\(/, 'Must define parseGitRemote');
  });

  it('should define resolveAllCredentials helper', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    assert.match(code, /function resolveAllCredentials\(/, 'Must define resolveAllCredentials');
  });

  it('should call main() at end of script', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    const lines = code.split('\n').filter(line => line.trim().length > 0);
    const lastLines = lines.slice(-10).join('\n');
    assert.match(lastLines, /main\(\)/, 'Must call main() at end of script');
  });

  it('should use process.stdout.write for JSON output', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    assert.match(code, /process\.stdout\.write\(JSON\.stringify\(output/, 'Must use process.stdout.write for JSON output');
  });

  it('should have JSDoc header with version', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    assert.match(code, /\/\*\*/, 'Must have JSDoc header');
    assert.match(code, /GENTYR Permission Validator/i, 'Header must describe purpose');
    assert.match(code, /@version \d+\.\d+\.\d+/, 'Header must have version number');
  });

  it('should have stderr diagnostics in loadOpTokenFromMcpJson', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /process\.stderr\.write.*setup-validate.*OP_SERVICE_ACCOUNT_TOKEN/, 'loadOpTokenFromMcpJson must log to stderr for debugging');
  });
});

// ============================================================================
// parseGitRemote() Tests
// ============================================================================

describe('parseGitRemote() patterns in code', () => {
  const SCRIPT_PATH = path.join(__dirname, '..', 'setup-validate.js');

  it('should handle SSH remote pattern', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    // The regex in the code should handle git@github.com:OWNER/REPO.git
    assert.match(code, /git@\[/, 'Must have SSH remote regex');
  });

  it('should handle HTTPS remote pattern', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    // The regex in the code should handle https://github.com/OWNER/REPO.git
    assert.match(code, /https\?:/, 'Must have HTTPS remote regex');
  });

  it('should handle .git suffix removal', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    assert.match(code, /\\\.git/, 'Must handle .git suffix');
  });
});

// ============================================================================
// JSON Output Schema Tests
// ============================================================================

describe('JSON Output Schema', { concurrency: true }, () => {
  it('should output valid JSON to stdout', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path);

      assert.strictEqual(result.exitCode, 0, 'Should exit with code 0');
      assert.ok(result.json, 'Should output valid JSON');
    } finally {
      testProject.cleanup();
    }
  });

  it('should include services object', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path);

      assert.ok(result.json, 'Must have JSON output');
      assert.ok(result.json.services, 'Must have services object');
      assert.strictEqual(typeof result.json.services, 'object', 'services must be object');
    } finally {
      testProject.cleanup();
    }
  });

  it('should include summary object with all required fields', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path);

      assert.ok(result.json.summary, 'Must have summary object');

      const { summary } = result.json;
      assert.strictEqual(typeof summary.totalServices, 'number', 'totalServices must be number');
      assert.strictEqual(typeof summary.passed, 'number', 'passed must be number');
      assert.strictEqual(typeof summary.failed, 'number', 'failed must be number');
      assert.strictEqual(typeof summary.warnings, 'number', 'warnings must be number');
      assert.strictEqual(typeof summary.skipped, 'number', 'skipped must be number');

      // Validate counts add up
      assert.strictEqual(
        summary.passed + summary.failed + summary.warnings + summary.skipped,
        summary.totalServices,
        'Summary counts should add up to totalServices'
      );
    } finally {
      testProject.cleanup();
    }
  });

  it('should include timestamp', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path);

      assert.ok(result.json.timestamp, 'Must have timestamp');
      // Should be valid ISO string
      assert.ok(!isNaN(Date.parse(result.json.timestamp)), 'timestamp must be valid ISO date');
    } finally {
      testProject.cleanup();
    }
  });

  it('should have status and message fields on each service', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path);

      assert.ok(result.json.services, 'Must have services');

      for (const [name, service] of Object.entries(result.json.services)) {
        assert.ok(
          ['pass', 'fail', 'warn', 'skip'].includes(service.status),
          `${name}.status must be one of: pass, fail, warn, skip (got: ${service.status})`
        );
        assert.strictEqual(typeof service.message, 'string', `${name}.message must be string`);
      }
    } finally {
      testProject.cleanup();
    }
  });

  it('should have credentialKeys array on each service', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path);

      for (const [name, service] of Object.entries(result.json.services)) {
        assert.ok(
          Array.isArray(service.credentialKeys),
          `${name}.credentialKeys must be an array`
        );
      }
    } finally {
      testProject.cleanup();
    }
  });

  it('should include all 10 expected services in output', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path);

      const expectedServices = [
        'vercel', 'render', 'github', 'cloudflare',
        'supabase', 'resend', 'elastic', 'codecov', 'onepassword', 'shellSync',
      ];

      for (const service of expectedServices) {
        assert.ok(result.json.services[service], `${service} must be in output`);
      }

      assert.strictEqual(result.json.summary.totalServices, 10, 'Should have 10 total services');
    } finally {
      testProject.cleanup();
    }
  });
});

// ============================================================================
// Graceful Degradation Tests
// ============================================================================

describe('Graceful Degradation', { concurrency: true }, () => {
  it('should handle missing vault-mappings.json (all services skip)', async () => {
    const testProject = createTestProject({
      withVaultMappings: false,
    });

    try {
      const result = await runSetupValidate(testProject.path);

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
      assert.ok(result.json, 'Should output valid JSON');

      // All services with required credentials should be skipped
      for (const [name, service] of Object.entries(result.json.services)) {
        if (service.credentialKeys.length > 0) {
          assert.strictEqual(
            service.status,
            'skip',
            `${name} should be skipped when no credentials configured`
          );
        }
      }
    } finally {
      testProject.cleanup();
    }
  });

  it('should handle empty vault-mappings.json (all services skip)', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path);

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
      assert.ok(result.json, 'Should output valid JSON');

      // Services with required credentials should be skipped
      for (const [name, service] of Object.entries(result.json.services)) {
        if (service.credentialKeys.length > 0) {
          assert.strictEqual(
            service.status,
            'skip',
            `${name} should be skipped with empty credentials`
          );
        }
      }
    } finally {
      testProject.cleanup();
    }
  });

  it('should handle partial credentials', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {
        // Only configure identifiers (no op:// references to resolve)
        SUPABASE_URL: 'https://example.supabase.co',
        CLOUDFLARE_ZONE_ID: 'abc123',
      },
    });

    try {
      const result = await runSetupValidate(testProject.path);

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
      assert.ok(result.json, 'Should output valid JSON');

      // Vercel should be skipped (no VERCEL_TOKEN)
      assert.strictEqual(result.json.services.vercel.status, 'skip', 'Vercel should be skipped');
      assert.match(result.json.services.vercel.message, /Missing credentials/, 'Should explain missing credentials');
    } finally {
      testProject.cleanup();
    }
  });

  it('should respect --repo CLI argument', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path, {}, ['--repo', 'TestOwner/TestRepo']);

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
      assert.ok(result.json, 'Should output valid JSON');
      assert.strictEqual(result.json.summary.repo, 'TestOwner/TestRepo', 'Should use repo from --repo arg');
    } finally {
      testProject.cleanup();
    }
  });

  it('should handle no git remote (repo = null)', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path);

      assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
      assert.ok(result.json, 'Should output valid JSON');

      // repo should be null since tmp dir has no git remote
      assert.strictEqual(result.json.summary.repo, null, 'repo should be null without git remote');
    } finally {
      testProject.cleanup();
    }
  });
});

// ============================================================================
// Credential Security Tests
// ============================================================================

describe('Credential Security', { concurrency: true }, () => {
  it('should never include credential values in JSON output', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {
        VERCEL_TOKEN: 'op://Production/Vercel/token',
        SUPABASE_URL: 'https://example.supabase.co',
        CLOUDFLARE_ZONE_ID: 'abc123def456',
      },
    });

    try {
      const result = await runSetupValidate(testProject.path);

      const outputStr = JSON.stringify(result.json);

      // The op:// reference should not appear in output
      assert.ok(!outputStr.includes('op://Production/Vercel/token'), 'op:// references must not appear in output');

      // Direct values from vault-mappings should not appear
      assert.ok(!outputStr.includes('abc123def456'), 'Direct credential values must not appear in output');
    } finally {
      testProject.cleanup();
    }
  });
});

// ============================================================================
// Summary Calculation Tests
// ============================================================================

describe('Summary Calculation', { concurrency: true }, () => {
  it('should count passed/failed/warned/skipped correctly', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path);

      assert.ok(result.json.summary, 'Must have summary');

      const { summary, services } = result.json;

      // Count manually
      const statuses = Object.values(services);
      const expectedPassed = statuses.filter(s => s.status === 'pass').length;
      const expectedFailed = statuses.filter(s => s.status === 'fail').length;
      const expectedWarnings = statuses.filter(s => s.status === 'warn').length;
      const expectedSkipped = statuses.filter(s => s.status === 'skip').length;

      assert.strictEqual(summary.passed, expectedPassed, 'passed count should match');
      assert.strictEqual(summary.failed, expectedFailed, 'failed count should match');
      assert.strictEqual(summary.warnings, expectedWarnings, 'warnings count should match');
      assert.strictEqual(summary.skipped, expectedSkipped, 'skipped count should match');
    } finally {
      testProject.cleanup();
    }
  });

  it('should have totalServices equal to 10', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path);

      assert.strictEqual(result.json.summary.totalServices, 10, 'Should validate 10 services');
    } finally {
      testProject.cleanup();
    }
  });
});

// ============================================================================
// Validator Credential Keys Tests
// ============================================================================

describe('Service Validator Credential Keys', { concurrency: true }, () => {
  it('should list correct credential keys for each service', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path);

      const expectedKeys = {
        vercel: ['VERCEL_TOKEN'],
        render: ['RENDER_API_KEY'],
        github: ['GITHUB_TOKEN'],
        cloudflare: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID'],
        supabase: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_ACCESS_TOKEN'],
        resend: ['RESEND_API_KEY'],
        elastic: ['ELASTIC_API_KEY'],
        codecov: ['CODECOV_TOKEN'],
        onepassword: [],
        shellSync: [],
      };

      for (const [service, keys] of Object.entries(expectedKeys)) {
        assert.deepStrictEqual(
          result.json.services[service].credentialKeys,
          keys,
          `${service} should have credential keys: ${keys.join(', ')}`
        );
      }
    } finally {
      testProject.cleanup();
    }
  });
});

// ============================================================================
// 1Password Validator Tests
// ============================================================================

describe('validateOnePassword() implementation', () => {
  const SCRIPT_PATH = path.join(__dirname, '..', 'setup-validate.js');

  it('should check for OP_SERVICE_ACCOUNT_TOKEN environment variable first', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify the function checks for OP_SERVICE_ACCOUNT_TOKEN before calling op CLI
    assert.match(code, /if \(!process\.env\.OP_SERVICE_ACCOUNT_TOKEN\)/,
      'validateOnePassword must check for OP_SERVICE_ACCOUNT_TOKEN environment variable');

    // Verify it returns fail status when token is not set
    assert.match(code, /return \{\s*status:\s*'fail',\s*message:\s*'1Password service account token not configured'/,
      'validateOnePassword must return fail when OP_SERVICE_ACCOUNT_TOKEN is not set');
  });

  it('should use "op whoami" as primary authentication check', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify the function uses 'whoami' command as primary check
    assert.match(code, /execFileSync\('op',\s*\['whoami',\s*'--format',\s*'json'\]/,
      'validateOnePassword must use "op whoami --format json" as primary auth check');
  });

  it('should optionally try "op vault list" for richer status message', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify the function uses 'vault list' command as optional enhancement
    assert.match(code, /execFileSync\('op',\s*\['vault',\s*'list',\s*'--format',\s*'json'\]/,
      'validateOnePassword must use "op vault list" as optional check');

    // Verify it's wrapped in a try-catch (optional behavior)
    assert.match(code, /try\s*\{[\s\S]*vault list[\s\S]*\}\s*catch/i,
      'validateOnePassword must wrap vault list in try-catch since it is optional');
  });

  it('should parse JSON output from op whoami', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Check that the whoami output is parsed as JSON
    assert.match(code, /JSON\.parse\(whoamiOutput\)/,
      'validateOnePassword must parse JSON output from op whoami');
  });

  it('should parse JSON output from op vault list', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Check that the vault list output is parsed as JSON
    assert.match(code, /JSON\.parse\(vaultOutput\)/,
      'validateOnePassword must parse JSON output from op vault list');
  });

  it('should return pass when whoami succeeds but vault list fails (403)', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify that when vault list fails (403) but whoami succeeded, it returns pass
    // This is in the catch block for vault list, inside the try block for whoami
    assert.match(code, /catch.*vault list.*return \{\s*status:\s*'pass'/s,
      'validateOnePassword must return pass when vault list fails but whoami succeeded');

    // Verify the message mentions vault enumeration not permitted
    assert.match(code, /Vault enumeration not permitted.*op read still works/i,
      'validateOnePassword must explain that vault enumeration is not permitted but op read works');
  });

  it('should check for 403/Forbidden errors in whoami catch block', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify 403 handling in the whoami catch block
    assert.match(code, /403.*Forbidden/i,
      'validateOnePassword must check for 403/Forbidden errors in whoami catch block');
  });

  it('should return warn status when whoami succeeds but no vaults are accessible', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Check for warn status when vaults array is empty
    assert.match(code, /status:\s*'warn'.*no vaults accessible/i,
      'validateOnePassword must return warn status when no vaults accessible');
  });

  it('should provide remediation for no vaults accessible', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify remediation message for no vaults
    assert.match(code, /remediation:.*service account.*vault/i,
      'validateOnePassword must provide remediation for no vaults accessible');
  });

  it('should capture and include stderr in error messages', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify stderr is captured in catch block
    assert.match(code, /err\.stderr/,
      'validateOnePassword must capture stderr from op command errors');
  });

  it('should handle "not signed in" error message in whoami catch block', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Check for "not signed in" error handling
    assert.match(code, /not signed in.*unauthorized.*401/i,
      'validateOnePassword must handle "not signed in" errors in whoami catch block');
  });

  it('should provide remediation for authentication errors', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify remediation for auth errors
    assert.match(code, /remediation:.*op signin.*OP_SERVICE_ACCOUNT_TOKEN/,
      'validateOnePassword must provide remediation for auth errors');
  });

  it('should provide remediation for 403 service account errors in whoami catch block', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify remediation for 403 errors suggests token regeneration
    assert.match(code, /remediation:.*service account token.*--op-token/i,
      'validateOnePassword must provide remediation for 403 service account errors');
  });

  it('should check array length and verify vaults exist when vault list succeeds', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify that the code checks if vaults array has items
    assert.match(code, /Array\.isArray\(vaults\).*vaults\.length\s*>\s*0/,
      'validateOnePassword must check if vaults array has items');
  });

  it('should return pass status when vaults are accessible', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify pass status when authenticated with vaults
    assert.match(code, /status:\s*'pass'.*Authenticated.*vault.*accessible/i,
      'validateOnePassword must return pass status when vaults accessible');
  });

  it('should handle generic CLI errors gracefully', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify fallback error handling
    assert.match(code, /1Password CLI error/,
      'validateOnePassword must handle generic CLI errors');
  });

  it('should provide remediation when OP_SERVICE_ACCOUNT_TOKEN is not set', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify remediation message for missing token
    assert.match(code, /remediation:.*setup\.sh.*--op-token.*OP_SERVICE_ACCOUNT_TOKEN/,
      'validateOnePassword must provide remediation for missing OP_SERVICE_ACCOUNT_TOKEN');
  });
});

// ============================================================================
// Codecov Validator Tests
// ============================================================================

describe('validateCodecov() implementation', () => {
  const SCRIPT_PATH = path.join(__dirname, '..', 'setup-validate.js');

  it('should use Codecov v2 API endpoint', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify the function uses v2 API (api/v2)
    assert.match(code, /api\.codecov\.io\/api\/v2\//,
      'validateCodecov must use Codecov v2 API endpoint');
  });

  it('should use "token" prefix in Authorization header, not "bearer"', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify Authorization header uses "token" prefix
    assert.match(code, /Authorization:\s*`token \$\{creds\.CODECOV_TOKEN\}`/,
      'validateCodecov must use "token" prefix in Authorization header');

    // Verify it does NOT use "bearer" prefix
    assert.doesNotMatch(code, /Authorization:\s*`bearer \$\{creds\.CODECOV_TOKEN\}`/i,
      'validateCodecov must NOT use "bearer" prefix in Authorization header');
  });

  it('should include Accept header for JSON responses', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify Accept: application/json header
    assert.match(code, /Accept:\s*['"]application\/json['"]/,
      'validateCodecov must include Accept: application/json header');
  });

  it('should handle 401 and 403 status codes for invalid tokens', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify handling of 401 or 403
    assert.match(code, /response\.status === 401.*response\.status === 403/,
      'validateCodecov must check for 401 or 403 status codes');
  });

  it('should provide remediation for invalid tokens', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify remediation message points to Codecov settings
    assert.match(code, /remediation:.*codecov\.io.*Repository Settings/i,
      'validateCodecov must provide remediation pointing to Codecov settings');
  });

  it('should skip validation when owner is not available', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify skip behavior when owner is missing
    assert.match(code, /if \(!owner\)[\s\S]{0,100}status:\s*'skip'/,
      'validateCodecov must skip when owner is not available');
  });

  it('should use GitHub owner in API endpoint', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify API endpoint includes github/{owner}
    assert.match(code, /github\/.*encodeURIComponent\(owner\)/,
      'validateCodecov must use GitHub owner in API endpoint');
  });
});

// ============================================================================
// Resend Validator Tests
// ============================================================================

describe('validateResend() implementation', () => {
  const SCRIPT_PATH = path.join(__dirname, '..', 'setup-validate.js');

  it('should parse response body to check for restricted_api_key', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify JSON parsing of response body
    assert.match(code, /await domainsResponse\.json\(\)/,
      'validateResend must parse response body as JSON');

    // Verify check for restricted_api_key
    assert.match(code, /body\.name === ['"]restricted_api_key['"]/,
      'validateResend must check if body.name === "restricted_api_key"');
  });

  it('should return warn status for restricted (send-only) keys', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify warn status for restricted keys
    assert.match(code, /status:\s*'warn'[\s\S]{0,200}Sending access/i,
      'validateResend must return warn status for send-only keys');
  });

  it('should return fail status for genuinely invalid keys', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify fail status for invalid keys (after checking for restricted_api_key)
    // The pattern should be: check for restricted_api_key, then return fail
    assert.match(code, /status:\s*'fail'.*API key invalid or expired/,
      'validateResend must return fail status for invalid keys');
  });

  it('should include permissions metadata in response', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify permissions object is included
    assert.match(code, /permissions:\s*\{\s*level:/,
      'validateResend must include permissions object in response');

    // Verify sending_only level
    assert.match(code, /level:\s*['"]sending_only['"]/,
      'validateResend must include sending_only permission level');

    // Verify full_access level
    assert.match(code, /level:\s*['"]full_access['"]/,
      'validateResend must include full_access permission level');
  });

  it('should provide remediation for restricted keys', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify remediation for restricted keys mentions full access
    assert.match(code, /remediation:.*Full access.*resend\.com\/api-keys/i,
      'validateResend must provide remediation for restricted keys');
  });

  it('should provide remediation for invalid keys', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify remediation for invalid keys
    assert.match(code, /remediation:.*Generate.*new API key.*resend\.com\/api-keys/i,
      'validateResend must provide remediation for invalid keys');
  });

  it('should handle JSON parse errors gracefully', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify try-catch for JSON parsing
    assert.match(code, /try\s*\{[\s\S]*await domainsResponse\.json\(\)[\s\S]*\}\s*catch/,
      'validateResend must handle JSON parse errors with try-catch');
  });

  it('should test /domains endpoint for permission check', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify /domains endpoint is used
    assert.match(code, /api\.resend\.com\/domains/,
      'validateResend must test /domains endpoint');
  });

  it('should use Bearer authentication', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify Bearer token in Authorization header
    assert.match(code, /Authorization:\s*`Bearer \$\{creds\.RESEND_API_KEY\}`/,
      'validateResend must use Bearer authentication');
  });

  it('should return pass status with domain count for full access', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // Verify pass status includes domain count
    assert.match(code, /status:\s*'pass'.*full access.*domain/i,
      'validateResend must return pass status with domain count for full access');
  });
});

// ============================================================================
// validateShellSync() Tests
// ============================================================================

describe('validateShellSync() implementation', () => {
  const SCRIPT_PATH = path.join(__dirname, '..', 'setup-validate.js');

  it('should define validateShellSync function', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /function validateShellSync\(\)/,
      'Must define validateShellSync function');
  });

  it('should use CLAUDE_PROJECT_DIR or cwd to locate .mcp.json', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // validateShellSync must resolve projectDir the same way as the rest of the script
    assert.match(code, /process\.env\.CLAUDE_PROJECT_DIR \|\| process\.cwd\(\)/,
      'validateShellSync must use CLAUDE_PROJECT_DIR with cwd fallback');
  });

  it('should read .mcp.json to get the source-of-truth token', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /const mcpPath = path\.join\(projectDir,\s*['"]\.mcp\.json['"]\)/,
      'validateShellSync must construct mcpPath from projectDir');

    assert.match(code, /JSON\.parse\(fs\.readFileSync\(mcpPath/,
      'validateShellSync must parse .mcp.json');
  });

  it('should return warn status when .mcp.json cannot be read', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /status:\s*'warn',\s*message:\s*'Could not read \.mcp\.json/,
      'validateShellSync must return warn when .mcp.json is unreadable');
  });

  it('should return warn status when no OP_SERVICE_ACCOUNT_TOKEN in .mcp.json', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /status:\s*'warn',\s*message:\s*'No OP_SERVICE_ACCOUNT_TOKEN in \.mcp\.json'/,
      'validateShellSync must return warn when .mcp.json has no OP token');
  });

  it('should look for .zshrc before .bashrc', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // .zshrc check must appear before .bashrc check in the fs.existsSync ternary
    const zshrcIdx = code.indexOf('.zshrc');
    const bashrcIdx = code.indexOf('.bashrc');
    assert.ok(zshrcIdx > -1, 'Must reference .zshrc');
    assert.ok(bashrcIdx > -1, 'Must reference .bashrc');
    assert.ok(zshrcIdx < bashrcIdx, 'Must prefer .zshrc over .bashrc (check .zshrc first)');
  });

  it('should return warn when no .zshrc or .bashrc is found', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /status:\s*'warn',\s*message:\s*'No \.zshrc or \.bashrc found'/,
      'validateShellSync must return warn when no shell profile exists');

    assert.match(code, /remediation:.*setup\.sh.*shell profile/i,
      'validateShellSync must provide remediation for missing shell profile');
  });

  it('should return warn when shell profile cannot be read', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /status:\s*'warn',\s*message:.*Could not read/,
      'validateShellSync must return warn when shell profile is unreadable');
  });

  it('should check for BEGIN GENTYR OP and END GENTYR OP markers', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /# BEGIN GENTYR OP/,
      'validateShellSync must check for BEGIN GENTYR OP marker');
    assert.match(code, /# END GENTYR OP/,
      'validateShellSync must check for END GENTYR OP marker');
  });

  it('should return fail when unmanaged OP export exists outside GENTYR block', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /export OP_SERVICE_ACCOUNT_TOKEN=/,
      'validateShellSync must detect unmanaged export');

    assert.match(code, /status:\s*'fail',\s*message:\s*'Unmanaged OP_SERVICE_ACCOUNT_TOKEN in shell profile/,
      'validateShellSync must return fail for unmanaged export');

    assert.match(code, /remediation:.*setup\.sh.*managed block/i,
      'validateShellSync must provide remediation for unmanaged export');
  });

  it('should return fail when no GENTYR OP block exists at all', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /status:\s*'fail',\s*message:\s*'No GENTYR OP block in shell profile'/,
      'validateShellSync must return fail when GENTYR block is absent');

    assert.match(code, /remediation:.*setup\.sh.*managed OP block/i,
      'validateShellSync must provide remediation for missing block');
  });

  it('should extract token from managed block via regex', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.ok(code.includes('# BEGIN GENTYR OP') && code.includes('OP_SERVICE_ACCOUNT_TOKEN="?([^"\\s]+)"?'),
      'validateShellSync must parse token from GENTYR block with a regex capture group that handles optional quotes');
  });

  it('should return fail when GENTYR block exists but token cannot be parsed', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /status:\s*'fail',\s*message:\s*'GENTYR OP block found but could not parse token'/,
      'validateShellSync must return fail when block regex does not match');

    assert.match(code, /remediation:.*setup\.sh.*regenerate managed block/i,
      'validateShellSync must provide remediation for unparseable block');
  });

  it('should return pass when shell token matches .mcp.json token', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /shellToken === mcpToken/,
      'validateShellSync must compare extracted shell token with mcp token');

    assert.match(code, /status:\s*'pass',\s*message:.*Shell profile in sync with \.mcp\.json/,
      'validateShellSync must return pass when tokens match');
  });

  it('should return fail when shell token differs from .mcp.json token', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /status:\s*'fail',\s*message:\s*'Shell OP token differs from \.mcp\.json/,
      'validateShellSync must return fail when shell token does not match .mcp.json');

    assert.match(code, /remediation:.*setup\.sh.*re-sync/i,
      'validateShellSync must provide remediation for token mismatch');
  });

  it('should be included in SERVICE_VALIDATORS registry', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    assert.match(code, /name:\s*['"]shellSync['"]/,
      'shellSync must be registered in SERVICE_VALIDATORS');

    // Verify it uses validateShellSync
    assert.match(code, /validate:\s*validateShellSync/,
      'shellSync entry must reference validateShellSync as its validate function');
  });

  it('should have empty credentialKeys array (no required credentials)', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

    // The shellSync entry in SERVICE_VALIDATORS must have credentialKeys: []
    // so it is never skipped for missing credentials.
    const shellSyncBlock = code.match(/name:\s*['"]shellSync['"][\s\S]*?credentialKeys:\s*\[\]/);
    assert.ok(shellSyncBlock, 'shellSync must have credentialKeys: [] to avoid being skipped');
  });
});

// ============================================================================
// shellSync Integration Tests
// ============================================================================

describe('shellSync output in JSON', { concurrency: true }, () => {
  it('should include shellSync in services output', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path);

      assert.ok(result.json, 'Must have JSON output');
      assert.ok(result.json.services.shellSync, 'shellSync must appear in services output');
    } finally {
      testProject.cleanup();
    }
  });

  it('should have status and message on shellSync result', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    try {
      const result = await runSetupValidate(testProject.path);

      const { shellSync } = result.json.services;
      assert.ok(
        ['pass', 'fail', 'warn', 'skip'].includes(shellSync.status),
        `shellSync.status must be one of: pass, fail, warn, skip (got: ${shellSync.status})`
      );
      assert.strictEqual(typeof shellSync.message, 'string', 'shellSync.message must be string');
    } finally {
      testProject.cleanup();
    }
  });

  it('should return a warn status when HOME has no .zshrc or .bashrc', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    // Create a temp HOME with no shell profiles to force the warn path
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-home-'));
    try {
      // Create a .mcp.json so validateShellSync gets past the mcp-read stage
      const mcpContent = {
        mcpServers: {
          onepassword: {
            command: 'node',
            args: ['op-server.js'],
            env: { OP_SERVICE_ACCOUNT_TOKEN: 'ops_test_token_abc' },
          },
        },
      };
      fs.writeFileSync(path.join(testProject.path, '.mcp.json'), JSON.stringify(mcpContent, null, 2));

      const result = await runSetupValidate(testProject.path, { HOME: fakeHome });

      assert.ok(result.json, 'Must have JSON output');
      const { shellSync } = result.json.services;

      // With no .zshrc or .bashrc in fakeHome, shellSync must warn
      assert.strictEqual(shellSync.status, 'warn', 'Should warn when HOME has no shell profiles');
      assert.match(shellSync.message, /No \.zshrc or \.bashrc found/,
        'Message must indicate no shell profile was found');
    } finally {
      testProject.cleanup();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('should return fail status when shell profile has unmanaged OP export', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-home-'));
    try {
      // Create .mcp.json with token
      const mcpToken = 'ops_mcp_token_xyz';
      const mcpContent = {
        mcpServers: {
          onepassword: {
            command: 'node',
            args: ['op-server.js'],
            env: { OP_SERVICE_ACCOUNT_TOKEN: mcpToken },
          },
        },
      };
      fs.writeFileSync(path.join(testProject.path, '.mcp.json'), JSON.stringify(mcpContent, null, 2));

      // Create a .zshrc with unmanaged export (no GENTYR block)
      const zshrc = path.join(fakeHome, '.zshrc');
      fs.writeFileSync(zshrc, 'export OP_SERVICE_ACCOUNT_TOKEN=some_old_token\n');

      const result = await runSetupValidate(testProject.path, { HOME: fakeHome });

      assert.ok(result.json, 'Must have JSON output');
      const { shellSync } = result.json.services;

      assert.strictEqual(shellSync.status, 'fail', 'Should fail for unmanaged OP export');
      assert.match(shellSync.message, /Unmanaged OP_SERVICE_ACCOUNT_TOKEN/,
        'Message must describe the unmanaged export condition');
    } finally {
      testProject.cleanup();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('should return fail when GENTYR block token differs from .mcp.json', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-home-'));
    try {
      const mcpToken = 'ops_mcp_current_token';
      const staleToken = 'ops_stale_token_from_last_install';

      // .mcp.json uses mcpToken
      const mcpContent = {
        mcpServers: {
          onepassword: {
            command: 'node',
            args: ['op-server.js'],
            env: { OP_SERVICE_ACCOUNT_TOKEN: mcpToken },
          },
        },
      };
      fs.writeFileSync(path.join(testProject.path, '.mcp.json'), JSON.stringify(mcpContent, null, 2));

      // .zshrc has a GENTYR block with a different (stale) token
      const zshrc = path.join(fakeHome, '.zshrc');
      fs.writeFileSync(zshrc, [
        '# some other config',
        '',
        '# BEGIN GENTYR OP',
        '# 1Password Service Account Token (managed by GENTYR setup.sh — do not edit manually)',
        `export OP_SERVICE_ACCOUNT_TOKEN=${staleToken}`,
        '# END GENTYR OP',
        '',
      ].join('\n'));

      const result = await runSetupValidate(testProject.path, { HOME: fakeHome });

      assert.ok(result.json, 'Must have JSON output');
      const { shellSync } = result.json.services;

      assert.strictEqual(shellSync.status, 'fail', 'Should fail when shell token differs from .mcp.json');
      assert.match(shellSync.message, /Shell OP token differs from \.mcp\.json/,
        'Message must describe the token mismatch');
    } finally {
      testProject.cleanup();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('should return pass when GENTYR block token matches .mcp.json', async () => {
    const testProject = createTestProject({
      withVaultMappings: true,
      mappings: {},
    });

    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-home-'));
    try {
      const syncedToken = 'ops_synced_token_123';

      // .mcp.json and .zshrc both have the same token
      const mcpContent = {
        mcpServers: {
          onepassword: {
            command: 'node',
            args: ['op-server.js'],
            env: { OP_SERVICE_ACCOUNT_TOKEN: syncedToken },
          },
        },
      };
      fs.writeFileSync(path.join(testProject.path, '.mcp.json'), JSON.stringify(mcpContent, null, 2));

      const zshrc = path.join(fakeHome, '.zshrc');
      fs.writeFileSync(zshrc, [
        '# BEGIN GENTYR OP',
        '# 1Password Service Account Token (managed by GENTYR setup.sh — do not edit manually)',
        `export OP_SERVICE_ACCOUNT_TOKEN=${syncedToken}`,
        '# END GENTYR OP',
        '',
      ].join('\n'));

      const result = await runSetupValidate(testProject.path, { HOME: fakeHome });

      assert.ok(result.json, 'Must have JSON output');
      const { shellSync } = result.json.services;

      assert.strictEqual(shellSync.status, 'pass', 'Should pass when shell token matches .mcp.json');
      assert.match(shellSync.message, /Shell profile in sync with \.mcp\.json/,
        'Message must confirm sync status');
    } finally {
      testProject.cleanup();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
