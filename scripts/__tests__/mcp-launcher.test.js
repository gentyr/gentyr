/**
 * Unit tests for mcp-launcher.js credential resolution
 *
 * Tests the headless guard logic that prevents macOS TCC prompts
 * when launching MCP servers in automation contexts.
 *
 * Key behaviors:
 * - Skips op read when GENTYR_LAUNCHD_SERVICE=true and no OP_SERVICE_ACCOUNT_TOKEN
 * - Proceeds with op read when OP_SERVICE_ACCOUNT_TOKEN is available
 * - Skips credentials already in environment
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';

/**
 * Mock implementation of mcp-launcher.js credential resolution logic
 */
class McpCredentialResolver {
  constructor() {
    this.opReadCalls = [];
    this.resolvedCount = 0;
    this.skippedCount = 0;
  }

  /**
   * Resolve credentials for a server
   * @param {string[]} credentialKeys - Keys this server needs
   * @param {Object} mappings - Vault mappings (key -> op:// reference)
   */
  resolveCredentials(credentialKeys, mappings) {
    this.resolvedCount = 0;
    this.skippedCount = 0;
    this.opReadCalls = [];

    for (const key of credentialKeys) {
      // Skip if already set (e.g., from CI/CD environment, service account, etc.)
      if (process.env[key]) {
        this.skippedCount++;
        continue;
      }

      const ref = mappings[key];
      if (!ref) {
        continue;
      }

      if (ref.startsWith('op://')) {
        // In headless automation without a service account token, skip op read
        // to prevent macOS TCC prompts and 1Password Touch ID prompts.
        if (process.env.GENTYR_LAUNCHD_SERVICE === 'true' && !process.env.OP_SERVICE_ACCOUNT_TOKEN) {
          // Skip - would trigger macOS prompt
          continue;
        }

        // Would call: execFileSync('op', ['read', ref])
        this.opReadCalls.push({ key, ref });
        process.env[key] = `resolved-${key}`;
        this.resolvedCount++;
      } else {
        // Direct value (non-secret identifier like URL, zone ID, cloud ID)
        process.env[key] = ref;
        this.resolvedCount++;
      }
    }

    return {
      resolvedCount: this.resolvedCount,
      skippedCount: this.skippedCount,
      opReadCalls: this.opReadCalls.length,
    };
  }
}

describe('MCP Launcher Credential Resolution (mcp-launcher.js)', () => {
  let originalEnv;
  let resolver;

  beforeEach(() => {
    originalEnv = { ...process.env };
    resolver = new McpCredentialResolver();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('headless guard', () => {
    it('should skip op read when GENTYR_LAUNCHD_SERVICE=true and no OP_SERVICE_ACCOUNT_TOKEN', () => {
      process.env.GENTYR_LAUNCHD_SERVICE = 'true';
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;

      const credentialKeys = ['RESEND_API_KEY', 'RENDER_API_KEY'];
      const mappings = {
        RESEND_API_KEY: 'op://Private/Resend/api_key',
        RENDER_API_KEY: 'op://Private/Render/api_key',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.opReadCalls, 0);
      assert.strictEqual(result.resolvedCount, 0);
      assert.strictEqual(result.skippedCount, 0);
      assert.strictEqual(process.env.RESEND_API_KEY, undefined);
      assert.strictEqual(process.env.RENDER_API_KEY, undefined);
    });

    it('should proceed with op read when OP_SERVICE_ACCOUNT_TOKEN is set', () => {
      process.env.GENTYR_LAUNCHD_SERVICE = 'true';
      process.env.OP_SERVICE_ACCOUNT_TOKEN = 'ops_test_token_abc123';

      const credentialKeys = ['RESEND_API_KEY'];
      const mappings = {
        RESEND_API_KEY: 'op://Private/Resend/api_key',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.opReadCalls, 1);
      assert.strictEqual(result.resolvedCount, 1);
      assert.strictEqual(resolver.opReadCalls[0].key, 'RESEND_API_KEY');
      assert.strictEqual(resolver.opReadCalls[0].ref, 'op://Private/Resend/api_key');
      assert.strictEqual(process.env.RESEND_API_KEY, 'resolved-RESEND_API_KEY');
    });

    it('should proceed with op read when not in headless mode', () => {
      delete process.env.GENTYR_LAUNCHD_SERVICE;
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;

      const credentialKeys = ['RESEND_API_KEY'];
      const mappings = {
        RESEND_API_KEY: 'op://Private/Resend/api_key',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.opReadCalls, 1);
      assert.strictEqual(result.resolvedCount, 1);
    });

    it('should proceed when GENTYR_LAUNCHD_SERVICE=false', () => {
      process.env.GENTYR_LAUNCHD_SERVICE = 'false';
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;

      const credentialKeys = ['RESEND_API_KEY'];
      const mappings = {
        RESEND_API_KEY: 'op://Private/Resend/api_key',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.opReadCalls, 1);
      assert.strictEqual(result.resolvedCount, 1);
    });

    it('should skip when GENTYR_LAUNCHD_SERVICE=true with empty OP_SERVICE_ACCOUNT_TOKEN', () => {
      process.env.GENTYR_LAUNCHD_SERVICE = 'true';
      process.env.OP_SERVICE_ACCOUNT_TOKEN = '';

      const credentialKeys = ['RESEND_API_KEY'];
      const mappings = {
        RESEND_API_KEY: 'op://Private/Resend/api_key',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      // Empty string is falsy, so should skip
      assert.strictEqual(result.opReadCalls, 0);
      assert.strictEqual(result.resolvedCount, 0);
    });
  });

  describe('environment variable precedence', () => {
    it('should skip resolution if credential is already in environment', () => {
      process.env.RESEND_API_KEY = 'already-set-value';

      const credentialKeys = ['RESEND_API_KEY', 'RENDER_API_KEY'];
      const mappings = {
        RESEND_API_KEY: 'op://Private/Resend/api_key',
        RENDER_API_KEY: 'op://Private/Render/api_key',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.skippedCount, 1);
      assert.strictEqual(result.opReadCalls, 1); // Only RENDER_API_KEY
      assert.strictEqual(process.env.RESEND_API_KEY, 'already-set-value');
    });

    it('should skip all credentials if all are already in environment', () => {
      process.env.RESEND_API_KEY = 'already-set-1';
      process.env.RENDER_API_KEY = 'already-set-2';

      const credentialKeys = ['RESEND_API_KEY', 'RENDER_API_KEY'];
      const mappings = {
        RESEND_API_KEY: 'op://Private/Resend/api_key',
        RENDER_API_KEY: 'op://Private/Render/api_key',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.skippedCount, 2);
      assert.strictEqual(result.opReadCalls, 0);
      assert.strictEqual(result.resolvedCount, 0);
    });

    it('should prefer pre-resolved credentials from hourly-automation.js', () => {
      // Simulate credentials pre-resolved by hourly-automation.js
      process.env.RESEND_API_KEY = 'pre-resolved-by-automation';

      const credentialKeys = ['RESEND_API_KEY'];
      const mappings = {
        RESEND_API_KEY: 'op://Private/Resend/api_key',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.skippedCount, 1);
      assert.strictEqual(result.opReadCalls, 0);
      assert.strictEqual(process.env.RESEND_API_KEY, 'pre-resolved-by-automation');
    });
  });

  describe('direct value handling', () => {
    it('should set direct values (non-op:// references) without op read', () => {
      const credentialKeys = ['ELASTIC_CLOUD_ID', 'RESEND_API_KEY'];
      const mappings = {
        ELASTIC_CLOUD_ID: 'my-cloud-id-123',  // Direct value, not secret
        RESEND_API_KEY: 'op://Private/Resend/api_key',  // Secret reference
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.resolvedCount, 2);
      assert.strictEqual(result.opReadCalls, 1); // Only for RESEND_API_KEY
      assert.strictEqual(process.env.ELASTIC_CLOUD_ID, 'my-cloud-id-123');
      assert.strictEqual(process.env.RESEND_API_KEY, 'resolved-RESEND_API_KEY');
    });

    it('should handle mix of direct values, op:// refs, and pre-set env vars', () => {
      process.env.PRE_SET_KEY = 'already-set';

      const credentialKeys = ['PRE_SET_KEY', 'ELASTIC_CLOUD_ID', 'RESEND_API_KEY'];
      const mappings = {
        PRE_SET_KEY: 'op://Private/PreSet/key',
        ELASTIC_CLOUD_ID: 'cloud-id-xyz',
        RESEND_API_KEY: 'op://Private/Resend/api_key',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.skippedCount, 1); // PRE_SET_KEY
      assert.strictEqual(result.resolvedCount, 2); // ELASTIC_CLOUD_ID + RESEND_API_KEY
      assert.strictEqual(result.opReadCalls, 1); // Only RESEND_API_KEY
      assert.strictEqual(process.env.PRE_SET_KEY, 'already-set');
      assert.strictEqual(process.env.ELASTIC_CLOUD_ID, 'cloud-id-xyz');
    });
  });

  describe('missing mappings', () => {
    it('should skip credentials with no mapping', () => {
      const credentialKeys = ['RESEND_API_KEY', 'UNMAPPED_KEY'];
      const mappings = {
        RESEND_API_KEY: 'op://Private/Resend/api_key',
        // UNMAPPED_KEY is missing
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.resolvedCount, 1);
      assert.strictEqual(result.opReadCalls, 1);
      assert.strictEqual(process.env.UNMAPPED_KEY, undefined);
    });

    it('should handle empty mappings object', () => {
      const credentialKeys = ['RESEND_API_KEY'];
      const mappings = {};

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.resolvedCount, 0);
      assert.strictEqual(result.opReadCalls, 0);
    });
  });

  describe('empty credential keys', () => {
    it('should handle empty credentialKeys array', () => {
      const credentialKeys = [];
      const mappings = {
        RESEND_API_KEY: 'op://Private/Resend/api_key',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.resolvedCount, 0);
      assert.strictEqual(result.opReadCalls, 0);
    });
  });

  describe('integration with hourly-automation.js', () => {
    it('should demonstrate end-to-end flow: automation pre-resolves, mcp-launcher skips', () => {
      // Step 1: hourly-automation.js pre-resolves credentials
      process.env.RESEND_API_KEY = 'pre-resolved-by-automation';
      process.env.RENDER_API_KEY = 'pre-resolved-by-automation';

      // Step 2: MCP launcher starts a server
      const credentialKeys = ['RESEND_API_KEY', 'RENDER_API_KEY'];
      const mappings = {
        RESEND_API_KEY: 'op://Private/Resend/api_key',
        RENDER_API_KEY: 'op://Private/Render/api_key',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      // Both credentials were already in env, so mcp-launcher skips op read
      assert.strictEqual(result.skippedCount, 2);
      assert.strictEqual(result.opReadCalls, 0);
      assert.strictEqual(result.resolvedCount, 0);
    });

    it('should demonstrate headless flow: no pre-resolve, no service account = no credentials', () => {
      // Headless automation without service account
      process.env.GENTYR_LAUNCHD_SERVICE = 'true';
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;

      // No pre-resolved credentials
      delete process.env.RESEND_API_KEY;

      const credentialKeys = ['RESEND_API_KEY'];
      const mappings = {
        RESEND_API_KEY: 'op://Private/Resend/api_key',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      // mcp-launcher skips op read to prevent macOS prompt
      assert.strictEqual(result.opReadCalls, 0);
      assert.strictEqual(result.resolvedCount, 0);
      assert.strictEqual(process.env.RESEND_API_KEY, undefined);
    });

    it('should demonstrate service account flow: headless + service account = credentials resolved', () => {
      process.env.GENTYR_LAUNCHD_SERVICE = 'true';
      process.env.OP_SERVICE_ACCOUNT_TOKEN = 'ops_service_account_token';

      const credentialKeys = ['RESEND_API_KEY'];
      const mappings = {
        RESEND_API_KEY: 'op://Private/Resend/api_key',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      // With service account, op read proceeds via API (no desktop app)
      assert.strictEqual(result.opReadCalls, 1);
      assert.strictEqual(result.resolvedCount, 1);
    });
  });

  describe('real-world server configurations', () => {
    it('should resolve credentials for resend MCP server', () => {
      const credentialKeys = ['RESEND_API_KEY'];
      const mappings = {
        RESEND_API_KEY: 'op://Private/Resend/credential',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.resolvedCount, 1);
      assert.strictEqual(result.opReadCalls, 1);
    });

    it('should resolve credentials for render MCP server', () => {
      const credentialKeys = ['RENDER_API_KEY'];
      const mappings = {
        RENDER_API_KEY: 'op://Private/Render/credential',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.resolvedCount, 1);
      assert.strictEqual(result.opReadCalls, 1);
    });

    it('should resolve credentials for elastic-logs MCP server', () => {
      const credentialKeys = ['ELASTIC_API_KEY', 'ELASTIC_CLOUD_ID'];
      const mappings = {
        ELASTIC_API_KEY: 'op://Private/Elastic/api_key',
        ELASTIC_CLOUD_ID: 'my-deployment:dXMtZWFzdC0xLmF3cy5mb3VuZC5pbw==',
      };

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.resolvedCount, 2);
      assert.strictEqual(result.opReadCalls, 1); // Only ELASTIC_API_KEY
      assert.strictEqual(process.env.ELASTIC_CLOUD_ID, 'my-deployment:dXMtZWFzdC0xLmF3cy5mb3VuZC5pbw==');
    });

    it('should handle onepassword MCP server (no credentials needed)', () => {
      const credentialKeys = [];
      const mappings = {};

      const result = resolver.resolveCredentials(credentialKeys, mappings);

      assert.strictEqual(result.resolvedCount, 0);
      assert.strictEqual(result.opReadCalls, 0);
    });
  });

  describe('string comparison edge cases', () => {
    it('should match GENTYR_LAUNCHD_SERVICE exactly (case sensitive)', () => {
      const testCases = [
        { value: 'true', expectedSkip: true },
        { value: 'TRUE', expectedSkip: false },
        { value: 'True', expectedSkip: false },
        { value: '1', expectedSkip: false },
        { value: 'yes', expectedSkip: false },
      ];

      for (const { value, expectedSkip } of testCases) {
        // Reset env
        for (const key of Object.keys(process.env)) {
          if (key.startsWith('RESEND') || key.startsWith('GENTYR') || key.startsWith('OP_')) {
            delete process.env[key];
          }
        }

        process.env.GENTYR_LAUNCHD_SERVICE = value;

        const credentialKeys = ['RESEND_API_KEY'];
        const mappings = {
          RESEND_API_KEY: 'op://Private/Resend/api_key',
        };

        const result = resolver.resolveCredentials(credentialKeys, mappings);

        if (expectedSkip) {
          assert.strictEqual(
            result.opReadCalls,
            0,
            `Expected skip for GENTYR_LAUNCHD_SERVICE="${value}"`
          );
        } else {
          assert.strictEqual(
            result.opReadCalls,
            1,
            `Expected proceed for GENTYR_LAUNCHD_SERVICE="${value}"`
          );
        }
      }
    });
  });
});
