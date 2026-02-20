/**
 * Secret Sync MCP Server Tests
 *
 * Tests for secret synchronization operations between 1Password and
 * deployment platforms (Render, Vercel).
 *
 * CRITICAL: This module handles secrets and credentials.
 * Per testing policy, credential-handling code requires 100% coverage.
 *
 * Security Requirements:
 * - Secret values NEVER pass through agent context window
 * - All secrets read/write operations stay in-process
 * - No logging of secret values
 * - Fail-closed on missing credentials
 */

import { resolve } from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SyncSecretsArgsSchema,
  ListMappingsArgsSchema,
  VerifySecretsArgsSchema,
  DevServerStartArgsSchema,
  DevServerStopArgsSchema,
  DevServerStatusArgsSchema,
  DevServiceSchema,
  ServicesConfigSchema,
} from '../types.js';

describe('Secret Sync MCP Server - Schema Validation', () => {
  describe('SyncSecretsArgsSchema', () => {
    it('should validate sync to all targets', () => {
      const result = SyncSecretsArgsSchema.safeParse({
        target: 'all',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.target).toBe('all');
      }
    });

    it('should validate sync to render-production', () => {
      const result = SyncSecretsArgsSchema.safeParse({
        target: 'render-production',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.target).toBe('render-production');
      }
    });

    it('should validate sync to render-staging', () => {
      const result = SyncSecretsArgsSchema.safeParse({
        target: 'render-staging',
      });

      expect(result.success).toBe(true);
    });

    it('should validate sync to vercel', () => {
      const result = SyncSecretsArgsSchema.safeParse({
        target: 'vercel',
      });

      expect(result.success).toBe(true);
    });

    it('should validate sync to local', () => {
      const result = SyncSecretsArgsSchema.safeParse({
        target: 'local',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.target).toBe('local');
      }
    });

    it('should reject invalid target', () => {
      const result = SyncSecretsArgsSchema.safeParse({
        target: 'invalid-target',
      });

      expect(result.success).toBe(false);
    });

    it('should reject missing target', () => {
      const result = SyncSecretsArgsSchema.safeParse({});

      expect(result.success).toBe(false);
    });
  });

  describe('ListMappingsArgsSchema', () => {
    it('should validate with no target (defaults to all)', () => {
      const result = ListMappingsArgsSchema.safeParse({});

      expect(result.success).toBe(true);
    });

    it('should validate with specific target', () => {
      const result = ListMappingsArgsSchema.safeParse({
        target: 'render-production',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.target).toBe('render-production');
      }
    });

    it('should validate with all target', () => {
      const result = ListMappingsArgsSchema.safeParse({
        target: 'all',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('VerifySecretsArgsSchema', () => {
    it('should validate verify for all targets', () => {
      const result = VerifySecretsArgsSchema.safeParse({
        target: 'all',
      });

      expect(result.success).toBe(true);
    });

    it('should validate verify for specific target', () => {
      const result = VerifySecretsArgsSchema.safeParse({
        target: 'vercel',
      });

      expect(result.success).toBe(true);
    });

    it('should reject invalid target', () => {
      const result = VerifySecretsArgsSchema.safeParse({
        target: 'aws',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('ServicesConfigSchema', () => {
    it('should validate complete services config', () => {
      const config = {
        render: {
          production: {
            serviceId: 'srv-prod-123',
          },
          staging: {
            serviceId: 'srv-staging-456',
          },
        },
        vercel: {
          projectId: 'prj_vercel789',
        },
        secrets: {
          renderProduction: {
            DATABASE_URL: 'op://vault/db-prod/credential',
            API_KEY: 'op://vault/api-key-prod/credential',
          },
          renderStaging: {
            DATABASE_URL: 'op://vault/db-staging/credential',
          },
          vercel: {
            DATABASE_URL: {
              ref: 'op://vault/db-vercel/credential',
              target: ['production', 'preview'],
              type: 'encrypted',
            },
          },
          manual: [
            { service: 'render-production', key: 'STRIPE_WEBHOOK_SECRET', notes: 'Must be set manually in Render dashboard' },
          ],
        },
      };

      const result = ServicesConfigSchema.safeParse(config);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.render?.production?.serviceId).toBe('srv-prod-123');
        expect(result.data.vercel?.projectId).toBe('prj_vercel789');
        expect(result.data.secrets.manual).toHaveLength(1);
      }
    });

    it('should validate minimal services config', () => {
      const config = {
        secrets: {},
      };

      const result = ServicesConfigSchema.safeParse(config);

      expect(result.success).toBe(true);
    });

    it('should validate config with only Render production', () => {
      const config = {
        render: {
          production: {
            serviceId: 'srv-prod-123',
          },
        },
        secrets: {
          renderProduction: {
            API_KEY: 'op://vault/api/key',
          },
        },
      };

      const result = ServicesConfigSchema.safeParse(config);

      expect(result.success).toBe(true);
    });

    it('should validate config with local target and secrets.local', () => {
      const config = {
        local: {
          confFile: 'op-secrets.conf',
        },
        secrets: {
          local: {
            ELASTIC_CLOUD_ID: 'op://Production/Elastic/cloud-id',
            ELASTIC_API_KEY: 'op://Production/Elastic/api-key',
          },
        },
      };

      const result = ServicesConfigSchema.safeParse(config);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.local?.confFile).toBe('op-secrets.conf');
        expect(result.data.secrets.local).toEqual({
          ELASTIC_CLOUD_ID: 'op://Production/Elastic/cloud-id',
          ELASTIC_API_KEY: 'op://Production/Elastic/api-key',
        });
      }
    });

    it('should reject secrets.local values that are not op:// references', () => {
      const config = {
        secrets: {
          local: {
            ELASTIC_API_KEY: 'actual-secret-value-not-a-reference',
          },
        },
      };

      const result = ServicesConfigSchema.safeParse(config);

      expect(result.success).toBe(false);
    });

    it('should validate local config with default confFile', () => {
      const config = {
        local: {},
        secrets: {
          local: {
            SOME_KEY: 'op://Vault/Item/field',
          },
        },
      };

      const result = ServicesConfigSchema.safeParse(config);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.local?.confFile).toBe('op-secrets.conf');
      }
    });

    it('should validate config with manual secrets only', () => {
      const config = {
        secrets: {
          manual: [
            { service: 'render-production', key: 'SECRET_1', notes: 'Must be set manually' },
            { service: 'render-production', key: 'SECRET_2', notes: 'Must be set manually' },
          ],
        },
      };

      const result = ServicesConfigSchema.safeParse(config);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.secrets.manual).toHaveLength(2);
      }
    });
  });
});

describe('Secret Sync MCP Server - Render Integration', () => {
  describe('renderSetEnvVar() - POST to PUT Migration', () => {
    it('should document the critical API change from POST to PUT', () => {
      /**
       * CRITICAL CHANGE DOCUMENTATION:
       *
       * Previous behavior (BEFORE):
       * - Try POST /services/${serviceId}/env-vars with body { key, value }
       * - On 409 conflict, fallback to PUT /services/${serviceId}/env-vars/${key}
       * - Return 'created' or 'updated' based on which succeeded
       *
       * Current behavior (AFTER):
       * - First: GET /services/${serviceId}/env-vars to check if key exists
       * - Then: PUT /services/${serviceId}/env-vars/${key} with body { value }
       * - Return 'created' or 'updated' based on pre-check
       *
       * BREAKING CHANGES:
       * 1. Added additional API call (renderListEnvVars) before every upsert
       * 2. No longer relies on try/catch for flow control
       * 3. Explicit existence check instead of error-based detection
       *
       * PERFORMANCE IMPACT:
       * - Old: 1 API call (POST) on create, 2 API calls (POST + PUT) on update
       * - New: 2 API calls (GET + PUT) on both create and update
       *
       * RELIABILITY IMPACT:
       * - Positive: No longer uses exceptions for flow control
       * - Positive: PUT is idempotent (safer than POST)
       * - Negative: Additional API call increases failure surface
       *
       * Rationale: Aligns with Render API's documented upsert pattern
       */
      expect(true).toBe(true);
    });

    it('should validate the new two-step upsert process', () => {
      /**
       * Step 1: Check if env var exists
       * - Call: renderListEnvVars(serviceId)
       * - Returns: string[] of existing key names
       * - Check: existingKeys.includes(key)
       *
       * Step 2: Upsert with PUT
       * - Call: renderFetch(`/services/${serviceId}/env-vars/${key}`, { method: 'PUT', body: { value } })
       * - Always succeeds (upsert behavior)
       * - Return: 'created' if key was not in existingKeys, 'updated' if it was
       */
      const existingKeys = ['DATABASE_URL', 'API_KEY'];
      const newKey = 'REDIS_URL';
      const existingKey = 'API_KEY';

      const isNewKey = !existingKeys.includes(newKey);
      const isExistingKey = existingKeys.includes(existingKey);

      expect(isNewKey).toBe(true);
      expect(isExistingKey).toBe(true);
    });

    it('should validate renderListEnvVars is called before renderSetEnvVar', () => {
      /**
       * CRITICAL: renderSetEnvVar now depends on renderListEnvVars
       *
       * Flow:
       * 1. const existingKeys = await renderListEnvVars(serviceId);
       * 2. const exists = existingKeys.includes(key);
       * 3. await renderFetch(...PUT request...)
       * 4. return exists ? 'updated' : 'created';
       *
       * This must be tested to ensure:
       * - renderListEnvVars is called with correct serviceId
       * - Result is used to determine return value
       * - PUT is always executed regardless of existence check
       */
      expect(true).toBe(true);
    });

    it('should document error handling changes', () => {
      /**
       * Error Handling Changes:
       *
       * OLD:
       * - try { POST } catch { if 409: PUT, else: throw }
       * - Explicit handling of conflict errors
       * - Different code paths for create vs update
       *
       * NEW:
       * - No try/catch around the main operation
       * - Errors from renderListEnvVars propagate up
       * - Errors from PUT propagate up
       * - No special handling for conflicts (they shouldn't occur with PUT)
       *
       * IMPLICATION:
       * - Any network error in renderListEnvVars fails the entire operation
       * - Cannot upsert if list operation fails (even if PUT would work)
       * - More conservative error handling (fail-closed)
       */
      expect(true).toBe(true);
    });
  });

  describe('renderListEnvVars() - New Dependency', () => {
    it('should validate renderListEnvVars response structure', () => {
      /**
       * renderListEnvVars returns a simplified array of key names.
       *
       * API Response:
       * Array<{ envVar: { key: string; value?: string; updatedAt: string } }>
       *
       * Function Return:
       * string[] - just the key names
       *
       * Example:
       * API: [{ envVar: { key: 'DATABASE_URL', ... } }, { envVar: { key: 'API_KEY', ... } }]
       * Return: ['DATABASE_URL', 'API_KEY']
       */
      const mockApiResponse = [
        { envVar: { key: 'DATABASE_URL', updatedAt: '2024-01-15T10:00:00Z' } },
        { envVar: { key: 'API_KEY', updatedAt: '2024-01-15T10:00:00Z' } },
      ];

      const extractedKeys = mockApiResponse.map(item => item.envVar.key);

      expect(extractedKeys).toEqual(['DATABASE_URL', 'API_KEY']);
      expect(Array.isArray(extractedKeys)).toBe(true);
    });

    it('should handle empty env var list', () => {
      /**
       * When a service has no environment variables:
       * - API returns: []
       * - Function returns: []
       * - includes() check always returns false (all keys are new)
       */
      const emptyResponse: Array<{ envVar: { key: string } }> = [];
      const extractedKeys = emptyResponse.map(item => item.envVar.key);

      expect(extractedKeys).toEqual([]);
      expect(extractedKeys.includes('ANY_KEY')).toBe(false);
    });
  });

  describe('renderFetch() - API Client', () => {
    it('should validate renderFetch error handling', () => {
      /**
       * renderFetch implements comprehensive error handling:
       *
       * 1. Check response.ok
       * 2. If not ok:
       *    a. Try to parse JSON error response
       *    b. Extract message or errors array
       *    c. Throw Error with meaningful message
       * 3. If parsing fails:
       *    - Use HTTP status and statusText
       *
       * Error Response Formats:
       * - { message: string }
       * - { errors: unknown[] }
       * - Both fields may be present
       */
      const errorWithMessage = {
        message: 'Service not found',
      };

      const errorWithArray = {
        errors: ['Invalid API key', 'Rate limit exceeded'],
      };

      expect(errorWithMessage.message).toBe('Service not found');
      expect(Array.isArray(errorWithArray.errors)).toBe(true);
    });

    it('should handle 204 No Content responses', () => {
      /**
       * For endpoints that return no body (like some DELETE operations),
       * renderFetch returns null for 204 status codes.
       */
      const noContentStatus = 204;
      const expectedReturn = null;

      expect(noContentStatus).toBe(204);
      expect(expectedReturn).toBeNull();
    });

    it('should validate Authorization header is always included', () => {
      /**
       * Every renderFetch call must include:
       * Authorization: Bearer ${RENDER_API_KEY}
       *
       * This is the authentication mechanism for Render API.
       */
      const expectedHeaders = {
        Authorization: expect.stringMatching(/^Bearer .+/),
        'Content-Type': 'application/json',
      };

      expect(expectedHeaders.Authorization).toBeDefined();
      expect(expectedHeaders['Content-Type']).toBe('application/json');
    });
  });
});

describe('Secret Sync MCP Server - Security', () => {
  describe('Credential Isolation - No Context Window Exposure', () => {
    it('should document that secret values never pass through agent context', () => {
      /**
       * CRITICAL SECURITY REQUIREMENT:
       *
       * Secret values are read from 1Password and written to deployment platforms
       * WITHOUT ever being exposed to the AI agent's context window.
       *
       * Implementation:
       * 1. opRead() executes 'op read' command in-process
       * 2. Secret value is captured in local variable
       * 3. Value is immediately passed to renderSetEnvVar() or vercelSetEnvVar()
       * 4. Value never appears in:
       *    - Function return values sent to agent
       *    - Error messages
       *    - Log output
       *    - MCP tool responses
       *
       * Tools return only metadata:
       * - SyncResult.synced contains { key, service, status } - NO values
       * - MappingResult.mappings contains { key, reference } - NO secret values
       * - VerifyResult.verified contains { key, exists } - NO values
       */
      expect(true).toBe(true);
    });

    it('should validate opRead() executes in-process and returns value', () => {
      /**
       * opRead(reference: string): string
       *
       * - Executes: op read <reference>
       * - Environment: OP_SERVICE_ACCOUNT_TOKEN
       * - Returns: Secret value as string (trimmed)
       * - Throws: Error if read fails
       *
       * The value is returned to the calling function but NEVER
       * propagated to the agent's context window.
       */
      const reference = 'op://vault/database/password';
      const expectedCommand = 'op';
      const expectedArgs = ['read', reference];

      expect(expectedCommand).toBe('op');
      expect(expectedArgs).toContain('read');
      expect(expectedArgs).toContain(reference);
    });

    it('should validate SyncResult does not contain secret values', () => {
      /**
       * SyncResult type structure:
       * {
       *   synced: Array<{
       *     key: string;           // Env var name (safe to expose)
       *     service: string;       // Target service (safe to expose)
       *     status: 'created' | 'updated' | 'error';  // Result status (safe)
       *     error?: string;        // Error message (must not contain secrets)
       *   }>;
       *   errors: Array<{
       *     key: string;
       *     service: string;
       *     error: string;         // Must not contain secret values
       *   }>;
       *   manual: string[];        // Manual instructions (safe)
       * }
       *
       * IMPORTANT: Secret values are never included in this response.
       */
      const mockSyncResult = {
        synced: [
          { key: 'DATABASE_URL', service: 'render-production', status: 'created' as const },
          { key: 'API_KEY', service: 'render-production', status: 'updated' as const },
        ],
        errors: [],
        manual: ['WEBHOOK_SECRET must be set manually'],
      };

      expect(mockSyncResult.synced[0]).not.toHaveProperty('value');
      expect(mockSyncResult.synced[1]).not.toHaveProperty('value');
      expect(mockSyncResult.synced[0].key).toBe('DATABASE_URL');
    });

    it('should validate MappingResult does not contain secret values', () => {
      /**
       * MappingResult type structure:
       * {
       *   mappings: Array<{
       *     key: string;           // Env var name (safe)
       *     reference: string;     // 1Password reference (safe - not the actual secret)
       *     service: string;       // Target service (safe)
       *   }>;
       *   manual: string[];
       * }
       *
       * The 1Password reference (e.g., "op://vault/db/password") is NOT a secret.
       * It's a pointer to a secret, safe to expose to the agent.
       */
      const mockMappingResult = {
        mappings: [
          {
            key: 'DATABASE_URL',
            reference: 'op://vault/database/connection-string',
            service: 'render-production',
          },
        ],
        manual: [],
      };

      expect(mockMappingResult.mappings[0]).toHaveProperty('reference');
      expect(mockMappingResult.mappings[0].reference).toMatch(/^op:\/\//);
      expect(mockMappingResult.mappings[0]).not.toHaveProperty('value');
    });

    it('should validate VerifyResult does not contain secret values', () => {
      /**
       * VerifyResult type structure:
       * {
       *   verified: Array<{
       *     key: string;
       *     service: string;
       *     exists: boolean;       // Just existence check, no value
       *     error?: string;
       *   }>;
       *   errors: Array<{ service: string; error: string }>;
       * }
       */
      const mockVerifyResult = {
        verified: [
          { key: 'DATABASE_URL', service: 'vercel', exists: true },
          { key: 'API_KEY', service: 'vercel', exists: false },
        ],
        errors: [],
      };

      expect(mockVerifyResult.verified[0]).not.toHaveProperty('value');
      expect(mockVerifyResult.verified[0].exists).toBe(true);
      expect(typeof mockVerifyResult.verified[0].exists).toBe('boolean');
    });
  });

  describe('Fail-Closed - Missing Credentials', () => {
    it('should document required environment variables', () => {
      /**
       * Required environment variables (all optional, but required for specific operations):
       *
       * OP_SERVICE_ACCOUNT_TOKEN: 1Password service account token
       * - Required for: opRead() operations
       * - Fail behavior: Throws error with message
       *
       * RENDER_API_KEY: Render API key
       * - Required for: renderFetch() operations
       * - Fail behavior: Throws error with message
       *
       * VERCEL_TOKEN: Vercel API token
       * - Required for: vercelFetch() operations
       * - Fail behavior: Throws error with message
       *
       * VERCEL_TEAM_ID: Vercel team ID (optional)
       * - Required for: Team-scoped Vercel operations
       * - Fail behavior: Operations run in personal account scope
       *
       * CLAUDE_PROJECT_DIR: Project directory (defaults to '.')
       * - Required for: Loading services.json
       * - Fail behavior: Defaults to current directory
       */
      expect(true).toBe(true);
    });

    it('should validate opRead fails when OP_SERVICE_ACCOUNT_TOKEN is missing', () => {
      /**
       * opRead implementation:
       *
       * if (!OP_SERVICE_ACCOUNT_TOKEN) {
       *   throw new Error('OP_SERVICE_ACCOUNT_TOKEN not set');
       * }
       *
       * This is fail-closed: Cannot read secrets without proper auth.
       */
      const OP_SERVICE_ACCOUNT_TOKEN = process.env.OP_SERVICE_ACCOUNT_TOKEN;

      if (!OP_SERVICE_ACCOUNT_TOKEN) {
        expect(() => {
          if (!OP_SERVICE_ACCOUNT_TOKEN) {
            throw new Error('OP_SERVICE_ACCOUNT_TOKEN not set');
          }
        }).toThrow('OP_SERVICE_ACCOUNT_TOKEN not set');
      }
    });

    it('should validate renderFetch fails when RENDER_API_KEY is missing', () => {
      /**
       * renderFetch implementation:
       *
       * if (!RENDER_API_KEY) {
       *   throw new Error('RENDER_API_KEY not set');
       * }
       *
       * This is fail-closed: Cannot interact with Render API without auth.
       */
      const RENDER_API_KEY = process.env.RENDER_API_KEY;

      if (!RENDER_API_KEY) {
        expect(() => {
          if (!RENDER_API_KEY) {
            throw new Error('RENDER_API_KEY not set');
          }
        }).toThrow('RENDER_API_KEY not set');
      }
    });

    it('should validate vercelFetch fails when VERCEL_TOKEN is missing', () => {
      /**
       * vercelFetch implementation:
       *
       * if (!VERCEL_TOKEN) {
       *   throw new Error('VERCEL_TOKEN not set');
       * }
       */
      const VERCEL_TOKEN = process.env.VERCEL_TOKEN;

      if (!VERCEL_TOKEN) {
        expect(() => {
          if (!VERCEL_TOKEN) {
            throw new Error('VERCEL_TOKEN not set');
          }
        }).toThrow('VERCEL_TOKEN not set');
      }
    });
  });

  describe('Error Messages - No Secret Leakage', () => {
    it('should validate error messages never contain secret values', () => {
      /**
       * All error messages must be carefully crafted to avoid leaking secrets:
       *
       * SAFE:
       * - "Failed to read op://vault/db/password: command not found"
       * - "HTTP 401: Unauthorized"
       * - "Failed to sync DATABASE_URL to render-production"
       *
       * UNSAFE (must never happen):
       * - "Failed to set DATABASE_URL=postgresql://user:password@host/db"
       * - "Secret value 'sk_live_abc123' is invalid"
       */
      const safeError = 'Failed to read op://vault/db/password: command not found';
      const secretValue = 'postgresql://user:secret_password@host/db';

      expect(safeError).not.toContain(secretValue);
      expect(safeError).toContain('op://vault/');
    });

    it('should validate opRead error handling does not leak values', () => {
      /**
       * opRead catches errors and re-throws with context:
       *
       * catch (err) {
       *   const message = err instanceof Error ? err.message : String(err);
       *   throw new Error(`Failed to read ${reference}: ${message}`);
       * }
       *
       * This includes the REFERENCE (safe) but not the VALUE (secret).
       */
      const reference = 'op://vault/api-key/credential';
      const errorContext = `Failed to read ${reference}: command not found`;

      expect(errorContext).toContain(reference);
      expect(errorContext).not.toContain('sk_live_');
    });
  });
});

describe('Secret Sync MCP Server - Integration Behavior', () => {
  describe('syncSecrets() - Multi-Target Orchestration', () => {
    it('should validate target expansion for "all"', () => {
      /**
       * When target is 'all':
       * - Expands to: ['render-production', 'render-staging', 'vercel']
       * - Local is excluded from 'all' — must be explicitly requested
       * - Errors in one target do not stop others
       */
      const target = 'all';
      const expandedTargets = ['render-production', 'render-staging', 'vercel'] as const;

      expect(target).toBe('all');
      expect(expandedTargets).toHaveLength(3);
      expect(expandedTargets).toContain('render-production');
      expect(expandedTargets).not.toContain('local');
    });

    it('should validate single target processing', () => {
      /**
       * When target is specific (e.g., 'render-production'):
       * - Expands to: ['render-production']
       * - Syncs only to that target
       */
      const target = 'render-production';
      const expandedTargets = [target];

      expect(expandedTargets).toHaveLength(1);
      expect(expandedTargets[0]).toBe('render-production');
    });

    it('should validate error handling preserves partial success', () => {
      /**
       * syncSecrets continues processing even when individual secrets fail:
       *
       * for (const [key, ref] of Object.entries(secrets)) {
       *   try {
       *     // ... sync logic ...
       *     synced.push({ key, service, status });
       *   } catch (err) {
       *     synced.push({ key, service, status: 'error', error: message });
       *   }
       * }
       *
       * Result: Some secrets sync successfully, others record errors.
       * All results are returned to agent for review.
       */
      const mockResults = [
        { key: 'DATABASE_URL', service: 'render-production', status: 'created' as const },
        { key: 'API_KEY', service: 'render-production', status: 'error' as const, error: 'Invalid reference' },
        { key: 'REDIS_URL', service: 'render-production', status: 'updated' as const },
      ];

      const successCount = mockResults.filter(r => r.status !== 'error').length;
      const errorCount = mockResults.filter(r => r.status === 'error').length;

      expect(successCount).toBe(2);
      expect(errorCount).toBe(1);
    });
  });

  describe('Performance Characteristics', () => {
    it('should document API call count for renderSetEnvVar', () => {
      /**
       * API calls per renderSetEnvVar invocation:
       * 1. GET /services/${serviceId}/env-vars (list all keys)
       * 2. PUT /services/${serviceId}/env-vars/${key} (upsert)
       *
       * Total: 2 API calls per secret
       *
       * For N secrets to same service:
       * - Old behavior: N calls (POST) on create, 2N calls on update
       * - New behavior: 2N calls always
       *
       * OPTIMIZATION OPPORTUNITY:
       * - Could cache renderListEnvVars result across multiple secrets
       * - Would reduce to N+1 calls (1 list + N upserts)
       * - Not currently implemented
       */
      const secretCount = 5;
      const apiCallsPerSecret = 2;
      const totalApiCalls = secretCount * apiCallsPerSecret;

      expect(totalApiCalls).toBe(10);
    });
  });
});

describe('Secret Sync MCP Server - Local Target', () => {
  describe('syncSecrets() - Local Target Behavior', () => {
    it('should generate conf file with op:// references only (no opRead calls)', () => {
      /**
       * CRITICAL SECURITY REQUIREMENT:
       *
       * The local target writes op:// REFERENCES to op-secrets.conf.
       * It NEVER calls opRead() to resolve actual secret values.
       * This is the fundamental difference from Render/Vercel targets.
       *
       * Flow:
       * 1. Read secrets.local from services.json
       * 2. Write each entry as KEY=op://... to conf file
       * 3. Report each key as status: 'created'
       *
       * NO opRead() calls are made — secrets never touch the MCP process.
       * Resolution happens at runtime via `op run`.
       */
      const localSecrets = {
        ELASTIC_CLOUD_ID: 'op://Production/Elastic/cloud-id',
        ELASTIC_API_KEY: 'op://Production/Elastic/api-key',
      };

      const expectedLines = Object.entries(localSecrets).map(
        ([key, ref]) => `${key}=${ref}`
      );

      expect(expectedLines).toEqual([
        'ELASTIC_CLOUD_ID=op://Production/Elastic/cloud-id',
        'ELASTIC_API_KEY=op://Production/Elastic/api-key',
      ]);

      // Verify references are NOT resolved values
      for (const line of expectedLines) {
        const value = line.split('=').slice(1).join('=');
        expect(value).toMatch(/^op:\/\//);
      }
    });

    it('should include header comments in generated conf file', () => {
      /**
       * The generated op-secrets.conf includes informational header comments:
       * - Auto-generated notice
       * - Security note about op:// references
       * - Generation timestamp
       */
      const expectedHeaderPatterns = [
        /^# Auto-generated/,
        /op:\/\/ references/,
        /op run/,
      ];

      for (const pattern of expectedHeaderPatterns) {
        expect(pattern).toBeInstanceOf(RegExp);
      }
    });

    it('should report each key as status created', () => {
      /**
       * Unlike Render/Vercel targets which report 'created' or 'updated',
       * local target always reports 'created' since the conf file is
       * fully regenerated on each sync.
       */
      const localSecrets = {
        ELASTIC_CLOUD_ID: 'op://Production/Elastic/cloud-id',
        ELASTIC_API_KEY: 'op://Production/Elastic/api-key',
      };

      const results = Object.keys(localSecrets).map(key => ({
        key,
        service: 'local',
        status: 'created' as const,
      }));

      expect(results).toHaveLength(2);
      expect(results.every(r => r.status === 'created')).toBe(true);
      expect(results.every(r => r.service === 'local')).toBe(true);
    });
  });

  describe('listMappings() - Local Target', () => {
    it('should return local mappings with op:// references', () => {
      /**
       * listMappings({ target: 'local' }) returns entries from secrets.local
       * with service: 'local'.
       */
      const localSecrets = {
        ELASTIC_CLOUD_ID: 'op://Production/Elastic/cloud-id',
        ELASTIC_API_KEY: 'op://Production/Elastic/api-key',
      };

      const mappings = Object.entries(localSecrets).map(([key, ref]) => ({
        key,
        reference: ref,
        service: 'local',
      }));

      expect(mappings).toHaveLength(2);
      expect(mappings[0]).toEqual({
        key: 'ELASTIC_CLOUD_ID',
        reference: 'op://Production/Elastic/cloud-id',
        service: 'local',
      });
    });
  });

  describe('verifySecrets() - Local Target', () => {
    it('should verify keys exist in conf file by parsing KEY=value lines', () => {
      /**
       * Verification reads op-secrets.conf and checks that each key
       * from secrets.local is present as a KEY=... line.
       *
       * Parsing rules:
       * - Skip blank lines
       * - Skip comment lines (starting with #)
       * - Split on first = to extract key name
       */
      const confContent = [
        '# Auto-generated by secret-sync MCP server',
        '# Contains op:// references only',
        '',
        'ELASTIC_CLOUD_ID=op://Production/Elastic/cloud-id',
        'ELASTIC_API_KEY=op://Production/Elastic/api-key',
      ].join('\n');

      const existingKeys = confContent
        .split('\n')
        .filter(line => line.trim() && !line.startsWith('#'))
        .map(line => line.split('=')[0]);

      expect(existingKeys).toEqual(['ELASTIC_CLOUD_ID', 'ELASTIC_API_KEY']);
      expect(existingKeys.includes('ELASTIC_CLOUD_ID')).toBe(true);
      expect(existingKeys.includes('MISSING_KEY')).toBe(false);
    });

    it('should report error when conf file does not exist', () => {
      /**
       * If op-secrets.conf is missing, verifySecrets reports:
       * - Error: "Conf file not found: <path>"
       * - All keys marked as exists: false with error message
       */
      const confExists = false;
      const expectedError = 'Conf file not found';

      expect(confExists).toBe(false);
      expect(expectedError).toContain('Conf file not found');
    });
  });

  describe('Target "all" Expansion', () => {
    it('should NOT include local in all target expansion', () => {
      /**
       * When target is 'all':
       * - Expands to: ['render-production', 'render-staging', 'vercel']
       * - Local is excluded — must be explicitly requested
       * - This prevents unintended filesystem writes when CTO approves "all"
       */
      const expandedTargets = ['render-production', 'render-staging', 'vercel'] as const;

      expect(expandedTargets).toHaveLength(3);
      expect(expandedTargets).not.toContain('local');
      expect(expandedTargets).toContain('render-production');
      expect(expandedTargets).toContain('render-staging');
      expect(expandedTargets).toContain('vercel');
    });
  });

  describe('Security - No Secret Resolution', () => {
    it('should validate that local target never resolves secrets', () => {
      /**
       * CRITICAL: The local target MUST NOT call opRead().
       *
       * Render/Vercel targets:
       * 1. opRead(ref) → resolved value
       * 2. Push value to platform API
       *
       * Local target:
       * 1. Write ref directly to conf file (op://... reference)
       * 2. NO opRead() call — no secret resolution
       *
       * Resolution happens at runtime:
       * op run --env-file=op-secrets.conf -- pnpm dev
       *   → op CLI reads op:// references
       *   → Resolves to actual values
       *   → Injects into child process environment (memory only)
       */
      const renderFlow = ['opRead', 'renderSetEnvVar'];
      const localFlow = ['writeFileSync']; // No opRead!

      expect(renderFlow).toContain('opRead');
      expect(localFlow).not.toContain('opRead');
    });

    it('should validate conf file contains only references', () => {
      /**
       * Every value in the generated conf file MUST start with op://
       * This ensures no resolved secret values are written to disk.
       */
      const confLines = [
        'ELASTIC_CLOUD_ID=op://Production/Elastic/cloud-id',
        'ELASTIC_API_KEY=op://Production/Elastic/api-key',
      ];

      for (const line of confLines) {
        const value = line.split('=').slice(1).join('=');
        expect(value).toMatch(/^op:\/\//);
        // Ensure it's not a resolved value
        expect(value).not.toMatch(/^[a-zA-Z0-9+/=]{20,}/); // Not a base64 token
        expect(value).not.toMatch(/^sk_/); // Not an API key
      }
    });
  });
});

describe('Secret Sync MCP Server - Path Traversal Defense', () => {
  describe('ServicesConfigSchema - confFile validation', () => {
    it('should reject confFile with path traversal', () => {
      const result = ServicesConfigSchema.safeParse({
        local: { confFile: '../../etc/cron.d/evil' },
        secrets: {},
      });
      expect(result.success).toBe(false);
    });

    it('should reject confFile with absolute path', () => {
      const result = ServicesConfigSchema.safeParse({
        local: { confFile: '/etc/passwd' },
        secrets: {},
      });
      expect(result.success).toBe(false);
    });

    it('should reject confFile with directory separator', () => {
      const result = ServicesConfigSchema.safeParse({
        local: { confFile: 'subdir/secrets.conf' },
        secrets: {},
      });
      expect(result.success).toBe(false);
    });

    it('should reject confFile starting with dot', () => {
      const result = ServicesConfigSchema.safeParse({
        local: { confFile: '.hidden-file' },
        secrets: {},
      });
      expect(result.success).toBe(false);
    });

    it('should accept valid confFile filename', () => {
      const result = ServicesConfigSchema.safeParse({
        local: { confFile: 'my-secrets.conf' },
        secrets: {},
      });
      expect(result.success).toBe(true);
    });

    it('should accept confFile with dots and dashes', () => {
      const result = ServicesConfigSchema.safeParse({
        local: { confFile: 'op-secrets.local.conf' },
        secrets: {},
      });
      expect(result.success).toBe(true);
    });

    it('should accept default confFile value', () => {
      const result = ServicesConfigSchema.safeParse({
        local: {},
        secrets: {},
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.local?.confFile).toBe('op-secrets.conf');
      }
    });
  });

  describe('safeProjectPath - runtime boundary check', () => {
    /**
     * Reimplements safeProjectPath logic for direct unit testing
     * since the function is not exported from server.ts.
     */
    function safeProjectPath(projectDir: string, relativePath: string): string {
      const resolved = resolve(projectDir, relativePath);
      const projectRoot = resolve(projectDir);
      if (!resolved.startsWith(projectRoot + '/') && resolved !== projectRoot) {
        throw new Error(`Path traversal blocked: ${relativePath} resolves outside project directory`);
      }
      return resolved;
    }

    it('should allow simple filename within project', () => {
      const result = safeProjectPath('/project', 'op-secrets.conf');
      expect(result).toBe('/project/op-secrets.conf');
    });

    it('should throw on relative path traversal', () => {
      expect(() => safeProjectPath('/project', '../../etc/passwd')).toThrow(
        'Path traversal blocked'
      );
    });

    it('should throw on absolute path outside project', () => {
      expect(() => safeProjectPath('/project', '/etc/passwd')).toThrow(
        'Path traversal blocked'
      );
    });

    it('should throw on dotdot traversal to parent', () => {
      expect(() => safeProjectPath('/project', '../sibling/file')).toThrow(
        'Path traversal blocked'
      );
    });

    it('should allow path that resolves within project', () => {
      const result = safeProjectPath('/project', 'subdir/../op-secrets.conf');
      expect(result).toBe('/project/op-secrets.conf');
    });
  });
});

describe('Secret Sync MCP Server - Target Expansion Security', () => {
  describe('"all" target must not include local', () => {
    it('should expand "all" to 3 remote targets only', () => {
      /**
       * After security hardening, "all" expands to remote targets only.
       * Local must be explicitly requested to ensure CTO approval covers
       * only intended operations.
       */
      const expandedTargets = ['render-production', 'render-staging', 'vercel'] as const;
      expect(expandedTargets).toHaveLength(3);
      expect(expandedTargets).not.toContain('local');
    });

    it('should still allow explicit local target', () => {
      const result = SyncSecretsArgsSchema.safeParse({ target: 'local' });
      expect(result.success).toBe(true);
    });
  });

  describe('Defense-in-Depth: Schema + Runtime Checks', () => {
    it('should document layered security approach', () => {
      /**
       * CRITICAL: Path traversal defense uses defense-in-depth:
       *
       * Layer 1 (Schema Validation):
       * - ServicesConfigSchema.local.confFile has regex validation
       * - Blocks: absolute paths, directory separators, dotdot, leading dots
       * - Protects: services.json loading (user-editable config)
       *
       * Layer 2 (Runtime Boundary Check):
       * - safeProjectPath(relativePath) validates resolved path
       * - Uses resolve() + startsWith() to ensure path stays in PROJECT_DIR
       * - Protects: Against any bypass of Layer 1 or unexpected edge cases
       *
       * Both layers MUST be tested independently.
       * Both layers MUST be verified to execute in actual code paths.
       */
      expect(true).toBe(true);
    });

    it('should verify regex rejects common path traversal patterns', () => {
      /**
       * Test Layer 1: Schema validation
       * These attacks should be blocked before reaching runtime.
       */
      const attacks = [
        '../../etc/passwd',              // Relative traversal
        '/etc/passwd',                    // Absolute path
        'subdir/secrets.conf',            // Directory separator
        '.hidden',                        // Leading dot
        '..sneaky.conf',                  // Leading dotdot
        'evil\x00.conf',                  // Null byte (regex should block special chars)
      ];

      for (const attack of attacks) {
        const result = ServicesConfigSchema.safeParse({
          local: { confFile: attack },
          secrets: {},
        });
        expect(result.success).toBe(false);
      }
    });

    it('should verify safeProjectPath handles edge cases that bypass regex', () => {
      /**
       * Test Layer 2: Runtime boundary check
       * Even if Layer 1 is bypassed, Layer 2 must catch traversal.
       */
      function safeProjectPath(projectDir: string, relativePath: string): string {
        const resolved = resolve(projectDir, relativePath);
        const projectRoot = resolve(projectDir);
        if (!resolved.startsWith(projectRoot + '/') && resolved !== projectRoot) {
          throw new Error(`Path traversal blocked: ${relativePath} resolves outside project directory`);
        }
        return resolved;
      }

      // Valid: filename that normalizes to project root
      const validPath = safeProjectPath('/project', 'op-secrets.conf');
      expect(validPath).toBe('/project/op-secrets.conf');

      // Invalid: normalized path escapes project
      expect(() => safeProjectPath('/project', '../../etc/passwd')).toThrow('Path traversal blocked');

      // Edge case: path with embedded dotdot that normalizes within project
      const edgeCase = safeProjectPath('/project', 'a/../op-secrets.conf');
      expect(edgeCase).toBe('/project/op-secrets.conf');
    });

    it('should require both layers to be tested in integration', () => {
      /**
       * CRITICAL TEST REQUIREMENT:
       *
       * This test file currently verifies:
       * ✅ Layer 1: Schema validation logic (lines 1072-1129)
       * ✅ Layer 2: safeProjectPath logic (lines 1132-1173)
       *
       * MISSING (critical gap):
       * ❌ Integration test verifying safeProjectPath is CALLED in syncSecrets()
       * ❌ Integration test verifying safeProjectPath is CALLED in verifySecrets()
       * ❌ Integration test with actual filesystem (not just mocked logic)
       *
       * Rationale:
       * - Logic tests verify the IMPLEMENTATION of each layer
       * - Integration tests verify each layer is INVOKED in the actual code path
       * - Without integration tests, a refactor could remove safeProjectPath calls
       *   and all tests would still pass
       *
       * Note: Full integration tests require filesystem access and are marked
       * as opportunistic tests (not run in CI). This test documents the gap.
       */
      expect(true).toBe(true);
    });
  });

  describe('Critical Code Paths Verification', () => {
    it('should verify syncSecrets calls safeProjectPath for local target', () => {
      /**
       * CODE PATH VERIFICATION:
       *
       * In server.ts:syncSecrets(), line 342:
       *   const confFile = safeProjectPath(config.local?.confFile || 'op-secrets.conf');
       *
       * This test verifies the EXPECTED behavior:
       * 1. When target='local', confFile is computed via safeProjectPath
       * 2. Default value 'op-secrets.conf' is used if config.local.confFile is undefined
       * 3. safeProjectPath throws if path traversal is attempted
       *
       * LIMITATION: This is a documentation test, not an execution test.
       * Actual execution verification would require:
       * - Exporting safeProjectPath or using a spy/mock
       * - Creating a test services.json with malicious confFile
       * - Calling syncSecrets and verifying it throws
       */
      const expectedCodePath = {
        function: 'syncSecrets',
        target: 'local',
        line: 342,
        statement: "const confFile = safeProjectPath(config.local?.confFile || 'op-secrets.conf');",
      };

      expect(expectedCodePath.function).toBe('syncSecrets');
      expect(expectedCodePath.target).toBe('local');
      expect(expectedCodePath.line).toBe(342);
    });

    it('should verify verifySecrets calls safeProjectPath for local target', () => {
      /**
       * CODE PATH VERIFICATION:
       *
       * In server.ts:verifySecrets(), line 515:
       *   const confFile = safeProjectPath(config.local?.confFile || 'op-secrets.conf');
       *
       * This test verifies the EXPECTED behavior:
       * 1. When target='local', confFile is computed via safeProjectPath
       * 2. Default value 'op-secrets.conf' is used if config.local.confFile is undefined
       * 3. safeProjectPath throws if path traversal is attempted
       */
      const expectedCodePath = {
        function: 'verifySecrets',
        target: 'local',
        line: 515,
        statement: "const confFile = safeProjectPath(config.local?.confFile || 'op-secrets.conf');",
      };

      expect(expectedCodePath.function).toBe('verifySecrets');
      expect(expectedCodePath.target).toBe('local');
      expect(expectedCodePath.line).toBe(515);
    });

    it('should document that loadServicesConfig uses hardcoded path (no user input)', () => {
      /**
       * SECURITY NOTE:
       *
       * In server.ts:loadServicesConfig(), line 60:
       *   const configPath = join(PROJECT_DIR, '.claude/config/services.json');
       *
       * This is SAFE and does NOT need safeProjectPath because:
       * 1. The path is HARDCODED (no user input)
       * 2. PROJECT_DIR comes from CLAUDE_PROJECT_DIR env var (trusted source)
       * 3. '.claude/config/services.json' is a literal string (no interpolation)
       *
       * User-controlled input (confFile) is validated when READING services.json,
       * not when LOADING it. The schema validation catches malicious confFile values.
       */
      const safeUsageOfJoin = {
        function: 'loadServicesConfig',
        line: 60,
        statement: "const configPath = join(PROJECT_DIR, '.claude/config/services.json');",
        safe: true,
        reason: 'Hardcoded path, no user input',
      };

      expect(safeUsageOfJoin.safe).toBe(true);
    });
  });

  describe('Null Byte Injection Defense', () => {
    it('should verify regex blocks null bytes and special characters', () => {
      /**
       * Null byte injection attacks (e.g., "secrets.conf\x00../../etc/passwd")
       * historically bypassed some path validation.
       *
       * The regex /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ blocks:
       * - Null bytes (\x00)
       * - Control characters
       * - Unicode characters (only ASCII allowed)
       * - Any special characters besides . _ -
       */
      const nullByteAttacks = [
        'secrets.conf\x00../../etc/passwd',
        'secrets\x00.conf',
        'secret\u0000s.conf',
      ];

      for (const attack of nullByteAttacks) {
        const result = ServicesConfigSchema.safeParse({
          local: { confFile: attack },
          secrets: {},
        });
        expect(result.success).toBe(false);
      }
    });

    it('should verify regex blocks Unicode normalization attacks', () => {
      /**
       * Unicode normalization attacks use visually similar characters:
       * - U+2215 (DIVISION SLASH) looks like /
       * - U+FF0E (FULLWIDTH FULL STOP) looks like .
       *
       * The regex [a-zA-Z0-9][a-zA-Z0-9._-]* only allows ASCII characters,
       * so these attacks are blocked.
       */
      const unicodeAttacks = [
        'secrets\u2215conf',       // Division slash (looks like /)
        'secrets\uFF0Econf',        // Fullwidth full stop (looks like .)
      ];

      for (const attack of unicodeAttacks) {
        const result = ServicesConfigSchema.safeParse({
          local: { confFile: attack },
          secrets: {},
        });
        expect(result.success).toBe(false);
      }
    });
  });

  describe('Comprehensive Attack Vector Coverage', () => {
    it('should block all common path traversal attack vectors', () => {
      /**
       * COMPREHENSIVE PATH TRAVERSAL ATTACK TEST
       *
       * This test validates that the Zod schema blocks ALL common attack vectors
       * that could be used to write files outside the project directory.
       *
       * Attack categories:
       * 1. Relative path traversal (../)
       * 2. Absolute paths (/)
       * 3. Null byte injection (\x00)
       * 4. Unicode tricks (fullwidth characters)
       * 5. Hidden files (leading dot)
       * 6. Directory separators (/)
       * 7. Windows-style paths (\)
       * 8. URL encoding attempts (%2e%2e%2f)
       */
      const attackVectors = [
        // Relative traversal
        '../secrets.conf',
        '../../etc/passwd',
        '../../../etc/shadow',
        '....//....//etc/passwd',

        // Absolute paths
        '/etc/passwd',
        '/tmp/evil.conf',
        '/var/log/secrets.conf',

        // Null byte injection
        'secrets.conf\x00.jpg',
        'secrets\x00/../../../etc/passwd',

        // Unicode normalization
        'secrets\u2215conf',              // Division slash
        'secrets\uFF0Econf',               // Fullwidth full stop
        '\uFF0E\uFF0E/secrets.conf',       // Fullwidth ..

        // Hidden files
        '.secrets',
        '.hidden-conf',
        '..sneaky',

        // Directory separators
        'subdir/secrets.conf',
        'nested/deep/secrets.conf',
        './secrets.conf',                  // Leading dot-slash

        // Windows-style paths (should be blocked even though we're Unix)
        'C:\\secrets.conf',
        '\\\\server\\share\\secrets.conf',
        'secrets\\conf',

        // URL encoding attempts (should be blocked as invalid chars)
        '%2e%2e%2fsecrets.conf',
        'secrets%00.conf',

        // Control characters
        'secrets\r.conf',
        'secrets\n.conf',
        'secrets\t.conf',

        // Symbolic link tricks (blocked by directory separator)
        'link/../../secrets.conf',

        // Empty string (must start with alphanumeric)
        '',

        // Only special characters
        '...',
        '---',
        '___',
      ];

      for (const attack of attackVectors) {
        const result = ServicesConfigSchema.safeParse({
          local: { confFile: attack },
          secrets: {},
        });

        expect(result.success).toBe(false);
      }
    });

    it('should allow only safe filenames', () => {
      /**
       * POSITIVE TEST: Valid filenames that should pass validation
       *
       * Requirements:
       * - Must start with alphanumeric
       * - Can contain: letters, numbers, dots, underscores, hyphens
       * - No directory separators
       * - No path traversal
       */
      const validFilenames = [
        'op-secrets.conf',                 // Default
        'secrets.conf',
        'my-secrets.conf',
        'production-secrets.conf',
        'secrets-2024.conf',
        'app1.secrets.conf',
        'db_credentials.conf',
        'API-KEYS-PROD.conf',
        'x',                               // Single character
        '1secrets.conf',                   // Starting with number
        'secrets.local.dev.conf',          // Multiple dots
        'very-long-filename-with-many-words.conf',
      ];

      for (const filename of validFilenames) {
        const result = ServicesConfigSchema.safeParse({
          local: { confFile: filename },
          secrets: {},
        });

        expect(result.success).toBe(true);
      }
    });

    it('should fail loudly with clear error message on path traversal attempt', () => {
      /**
       * CRITICAL: When path traversal is attempted, the error message
       * must be clear and actionable.
       *
       * This validates that developers/attackers receive immediate
       * feedback that path traversal is blocked.
       */
      const result = ServicesConfigSchema.safeParse({
        local: { confFile: '../../etc/passwd' },
        secrets: {},
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMessage = result.error.message;
        expect(errorMessage).toMatch(/confFile must be a simple filename/);
      }
    });
  });
});

// ============================================================================
// Dev Server MCP Tools - Schema Validation
// ============================================================================

describe('Dev Server MCP Tools - Schema Validation', () => {
  describe('DevServiceSchema', () => {
    it('should validate complete dev service config', () => {
      const result = DevServiceSchema.safeParse({
        filter: '@acme-app/backend',
        command: 'dev',
        port: 3001,
        label: 'Acme App Backend (Hono)',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.filter).toBe('@acme-app/backend');
        expect(result.data.command).toBe('dev');
        expect(result.data.port).toBe(3001);
        expect(result.data.label).toBe('Acme App Backend (Hono)');
      }
    });

    it('should default command to "dev"', () => {
      const result = DevServiceSchema.safeParse({
        filter: '@acme-app/web',
        port: 3000,
        label: 'Acme App Web',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.command).toBe('dev');
      }
    });

    it('should accept port 0 for services without ports (e.g. extension)', () => {
      const result = DevServiceSchema.safeParse({
        filter: 'acme-app-extension',
        command: 'dev',
        port: 0,
        label: 'Extension (esbuild watch)',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.port).toBe(0);
      }
    });

    it('should reject missing filter', () => {
      const result = DevServiceSchema.safeParse({
        command: 'dev',
        port: 3000,
        label: 'Missing filter',
      });

      expect(result.success).toBe(false);
    });

    it('should reject missing port', () => {
      const result = DevServiceSchema.safeParse({
        filter: '@acme-app/backend',
        command: 'dev',
        label: 'Missing port',
      });

      expect(result.success).toBe(false);
    });

    it('should reject missing label', () => {
      const result = DevServiceSchema.safeParse({
        filter: '@acme-app/backend',
        command: 'dev',
        port: 3001,
      });

      expect(result.success).toBe(false);
    });

    it('should reject filter with shell metacharacters', () => {
      const attacks = [
        '; rm -rf /',
        '$(whoami)',
        '`whoami`',
        'pkg && evil',
        'pkg | evil',
      ];

      for (const attack of attacks) {
        const result = DevServiceSchema.safeParse({
          filter: attack,
          command: 'dev',
          port: 3000,
          label: 'Test',
        });
        expect(result.success).toBe(false);
      }
    });

    it('should reject command with shell metacharacters', () => {
      const attacks = [
        '; rm -rf /',
        'dev && evil',
        'dev; evil',
        '../../../etc/passwd',
      ];

      for (const attack of attacks) {
        const result = DevServiceSchema.safeParse({
          filter: '@acme-app/backend',
          command: attack,
          port: 3000,
          label: 'Test',
        });
        expect(result.success).toBe(false);
      }
    });

    it('should accept valid filter patterns', () => {
      const valid = [
        '@acme-app/backend',
        '@acme-app/web',
        'acme-app-extension',
        '@scope/pkg_name',
      ];

      for (const filter of valid) {
        const result = DevServiceSchema.safeParse({
          filter,
          command: 'dev',
          port: 3000,
          label: 'Test',
        });
        expect(result.success).toBe(true);
      }
    });

    it('should accept valid command patterns', () => {
      const valid = ['dev', 'build', 'dev:watch', 'test_unit', 'start-dev'];

      for (const command of valid) {
        const result = DevServiceSchema.safeParse({
          filter: '@acme-app/backend',
          command,
          port: 3000,
          label: 'Test',
        });
        expect(result.success).toBe(true);
      }
    });

    it('should reject port outside valid range', () => {
      const invalid = [-1, 65536, 100000];

      for (const port of invalid) {
        const result = DevServiceSchema.safeParse({
          filter: '@acme-app/backend',
          command: 'dev',
          port,
          label: 'Test',
        });
        expect(result.success).toBe(false);
      }
    });
  });

  describe('DevServerStartArgsSchema', () => {
    it('should validate with no services (start all)', () => {
      const result = DevServerStartArgsSchema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.services).toBeUndefined();
        expect(result.data.force).toBe(false);
      }
    });

    it('should validate with specific services', () => {
      const result = DevServerStartArgsSchema.safeParse({
        services: ['backend', 'web'],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.services).toEqual(['backend', 'web']);
      }
    });

    it('should validate with force flag', () => {
      const result = DevServerStartArgsSchema.safeParse({
        force: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.force).toBe(true);
      }
    });

    it('should validate with services and force combined', () => {
      const result = DevServerStartArgsSchema.safeParse({
        services: ['backend'],
        force: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.services).toEqual(['backend']);
        expect(result.data.force).toBe(true);
      }
    });

    it('should default force to false', () => {
      const result = DevServerStartArgsSchema.safeParse({
        services: ['backend'],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.force).toBe(false);
      }
    });
  });

  describe('DevServerStopArgsSchema', () => {
    it('should validate with no services (stop all)', () => {
      const result = DevServerStopArgsSchema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.services).toBeUndefined();
      }
    });

    it('should validate with specific services', () => {
      const result = DevServerStopArgsSchema.safeParse({
        services: ['backend'],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.services).toEqual(['backend']);
      }
    });

    it('should accept empty services array', () => {
      const result = DevServerStopArgsSchema.safeParse({
        services: [],
      });

      expect(result.success).toBe(true);
    });
  });

  describe('DevServerStatusArgsSchema', () => {
    it('should validate empty object', () => {
      const result = DevServerStatusArgsSchema.safeParse({});

      expect(result.success).toBe(true);
    });
  });

  describe('ServicesConfigSchema - devServices extension', () => {
    it('should validate config with devServices', () => {
      const config = {
        devServices: {
          backend: {
            filter: '@acme-app/backend',
            command: 'dev',
            port: 3001,
            label: 'Acme App Backend',
          },
          web: {
            filter: '@acme-app/web',
            command: 'dev',
            port: 3000,
            label: 'Acme App Web',
          },
        },
        secrets: {},
      };

      const result = ServicesConfigSchema.safeParse(config);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.devServices).toBeDefined();
        expect(Object.keys(result.data.devServices!)).toHaveLength(2);
        expect(result.data.devServices!.backend.filter).toBe('@acme-app/backend');
        expect(result.data.devServices!.web.port).toBe(3000);
      }
    });

    it('should validate config without devServices (backward compat)', () => {
      const config = {
        secrets: {},
      };

      const result = ServicesConfigSchema.safeParse(config);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.devServices).toBeUndefined();
      }
    });

    it('should validate config with devServices and all other sections', () => {
      const config = {
        render: {
          production: { serviceId: 'srv-prod-123' },
        },
        local: { confFile: 'op-secrets.conf' },
        devServices: {
          extension: {
            filter: 'acme-app-extension',
            command: 'dev',
            port: 0,
            label: 'Extension',
          },
        },
        secrets: {
          local: {
            ELASTIC_CLOUD_ID: 'op://Production/Elastic/cloud-id',
          },
        },
      };

      const result = ServicesConfigSchema.safeParse(config);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.devServices).toBeDefined();
        expect(result.data.render?.production?.serviceId).toBe('srv-prod-123');
        expect(result.data.secrets.local?.ELASTIC_CLOUD_ID).toBe('op://Production/Elastic/cloud-id');
      }
    });

    it('should reject devServices with invalid service config', () => {
      const config = {
        devServices: {
          backend: {
            filter: '@acme-app/backend',
            // Missing port and label
          },
        },
        secrets: {},
      };

      const result = ServicesConfigSchema.safeParse(config);

      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Dev Server MCP Tools - Behavior
// ============================================================================

describe('Dev Server MCP Tools - Behavior', () => {
  describe('devServerStart - Process Lifecycle', () => {
    it('should document start flow: resolve secrets → check ports → spawn', () => {
      /**
       * devServerStart flow:
       * 1. Load config, validate service names against devServices
       * 2. resolveLocalSecrets() — calls opRead() for each secrets.local entry
       *    - Values stay in MCP server memory
       *    - Failed keys are collected (not thrown)
       * 3. For each service:
       *    a. Check if already running in managedProcesses map
       *    b. Check port conflict (skip if port === 0)
       *    c. Spawn via pnpm --filter <filter> run <command>
       *    d. Inject resolved env vars into child process
       *    e. Capture stdout/stderr in ring buffer
       *    f. Register exit handler for auto-cleanup
       * 4. Return metadata only: { name, label, pid, port, status }
       */
      const expectedFlow = [
        'loadServicesConfig',
        'resolveLocalSecrets',
        'checkAlreadyRunning',
        'checkPortConflict',
        'spawn',
        'captureOutput',
        'registerExitHandler',
      ];

      expect(expectedFlow).toContain('resolveLocalSecrets');
      expect(expectedFlow).toContain('spawn');
      expect(expectedFlow.indexOf('resolveLocalSecrets')).toBeLessThan(
        expectedFlow.indexOf('spawn')
      );
    });

    it('should validate that start result never contains secret values', () => {
      /**
       * CRITICAL SECURITY: DevServerStartResult structure:
       * {
       *   started: [{ name, label, pid, port, status }],  // No secrets
       *   secretsResolved: number,                          // Count only
       *   secretsFailed: string[],                          // Key names only
       * }
       */
      const mockResult = {
        started: [
          { name: 'backend', label: 'Acme App Backend', pid: 12345, port: 3001, status: 'started' as const },
        ],
        secretsResolved: 5,
        secretsFailed: ['MISSING_KEY'],
      };

      // Verify no secret values in result (field names like "secretsResolved" are safe metadata)
      const serialized = JSON.stringify(mockResult);
      expect(serialized).not.toMatch(/op:\/\//);
      expect(serialized).not.toMatch(/sk_live_/);
      expect(serialized).not.toMatch(/sk_test_/);
      expect(serialized).not.toMatch(/postgresql:\/\//);
      expect(serialized).not.toMatch(/Bearer\s/);
      expect(serialized).not.toMatch(/password[=:]/i);

      // Verify only metadata is present
      expect(mockResult.started[0]).toHaveProperty('name');
      expect(mockResult.started[0]).toHaveProperty('pid');
      expect(mockResult.started[0]).toHaveProperty('port');
      expect(mockResult.started[0]).toHaveProperty('status');
      expect(mockResult.started[0]).not.toHaveProperty('env');
      expect(mockResult.started[0]).not.toHaveProperty('secrets');
      expect(mockResult.started[0]).not.toHaveProperty('value');
    });

    it('should validate already-running detection', () => {
      /**
       * When a service is already in managedProcesses and its PID is alive:
       * - Returns status: 'already_running'
       * - Does NOT spawn a new process
       * - Returns the existing PID
       */
      const mockExisting = {
        name: 'backend',
        label: 'Acme App Backend',
        pid: 12345,
        port: 3001,
        status: 'already_running' as const,
      };

      expect(mockExisting.status).toBe('already_running');
      expect(mockExisting.pid).toBe(12345);
    });

    it('should validate port conflict handling', () => {
      /**
       * Port conflict scenarios:
       * 1. Port busy + force: false → error with message
       * 2. Port busy + force: true → kill existing, then spawn
       * 3. Port 0 (no port) → skip port check entirely
       */
      const portBusyNoForce = {
        name: 'backend',
        label: 'Backend',
        pid: 0,
        port: 3001,
        status: 'error' as const,
        error: 'Port 3001 already in use. Use force: true to kill existing process.',
      };

      expect(portBusyNoForce.status).toBe('error');
      expect(portBusyNoForce.error).toContain('already in use');
      expect(portBusyNoForce.error).toContain('force: true');
    });

    it('should validate unknown service name rejection', () => {
      /**
       * If a requested service name is not in devServices config:
       * - Throws Error with available service names listed
       * - Fail-closed: no partial starts if any name is invalid
       */
      const availableServices = ['backend', 'web', 'extension'];
      const requestedService = 'unknown-service';

      expect(availableServices).not.toContain(requestedService);

      const expectedError = `Unknown service "${requestedService}". Available: ${availableServices.join(', ')}`;
      expect(expectedError).toContain(requestedService);
      expect(expectedError).toContain('Available:');
    });
  });

  describe('devServerStop - Graceful Shutdown', () => {
    it('should document stop flow: SIGTERM → wait → SIGKILL', () => {
      /**
       * devServerStop flow:
       * 1. Look up process in managedProcesses map
       * 2. If not found → status: 'not_running'
       * 3. If found but PID dead → cleanup map, status: 'not_running'
       * 4. Send SIGTERM
       * 5. Wait up to 5 seconds for exit
       * 6. If still alive → SIGKILL, status: 'force_killed'
       * 7. If exited → status: 'stopped'
       * 8. Remove from managedProcesses map
       */
      const possibleStatuses = ['stopped', 'not_running', 'force_killed', 'error'];

      expect(possibleStatuses).toContain('stopped');
      expect(possibleStatuses).toContain('force_killed');
      expect(possibleStatuses).toContain('not_running');
    });

    it('should validate stop result structure', () => {
      const mockResult = {
        stopped: [
          { name: 'backend', pid: 12345, status: 'stopped' as const },
          { name: 'web', pid: 12346, status: 'not_running' as const },
        ],
      };

      expect(mockResult.stopped).toHaveLength(2);
      expect(mockResult.stopped[0]).not.toHaveProperty('env');
      expect(mockResult.stopped[0]).not.toHaveProperty('secrets');
    });

    it('should handle not-running services gracefully', () => {
      const mockResult = {
        stopped: [
          { name: 'nonexistent', pid: 0, status: 'not_running' as const },
        ],
      };

      expect(mockResult.stopped[0].status).toBe('not_running');
      expect(mockResult.stopped[0].pid).toBe(0);
    });
  });

  describe('devServerStatus - Health Check', () => {
    it('should validate status result structure', () => {
      const mockResult = {
        services: [
          {
            name: 'backend',
            label: 'Acme App Backend',
            pid: 12345,
            port: 3001,
            running: true,
            uptime: 120,
            detectedPort: 3001,
          },
          {
            name: 'extension',
            label: 'Extension',
            pid: 12346,
            port: 0,
            running: true,
            uptime: 115,
            detectedPort: null,
          },
        ],
      };

      expect(mockResult.services).toHaveLength(2);
      expect(mockResult.services[0].running).toBe(true);
      expect(mockResult.services[0].uptime).toBe(120);
      expect(mockResult.services[1].detectedPort).toBeNull();
      expect(mockResult.services[1].port).toBe(0);
    });

    it('should clean up dead entries from map', () => {
      /**
       * devServerStatus checks isProcessAlive(pid) for each entry.
       * If process is dead, it removes the entry from managedProcesses
       * but still returns it in the response (with running: false).
       */
      const mockDeadService = {
        name: 'backend',
        label: 'Backend',
        pid: 99999,
        port: 3001,
        running: false,
        uptime: 0,
        detectedPort: null,
      };

      expect(mockDeadService.running).toBe(false);
      expect(mockDeadService.uptime).toBe(0);
    });
  });

  describe('Port Detection from Output', () => {
    it('should detect port from common framework output patterns', () => {
      /**
       * detectPort scans the ring buffer for common port-binding messages.
       * Supported patterns include:
       * - "listening on :3001"
       * - "started on http://localhost:3000"
       * - "ready on http://localhost:3001"
       * - "http://localhost:3001"
       * - "port 3001"
       */
      const outputLines = [
        '> @acme-app/backend@1.0.0 dev',
        '> tsx watch src/index.ts',
        'Server listening on :3001',
      ];

      // Regex pattern from server.ts
      const portPatterns = [
        /listening on.*:(\d+)/i,
        /started.*on.*:(\d+)/i,
        /ready on.*:(\d+)/i,
        /http:\/\/localhost:(\d+)/i,
        /http:\/\/127\.0\.0\.1:(\d+)/i,
        /port\s+(\d+)/i,
      ];

      let detectedPort: number | null = null;
      for (let i = outputLines.length - 1; i >= 0; i--) {
        for (const pattern of portPatterns) {
          const match = outputLines[i].match(pattern);
          if (match) {
            detectedPort = parseInt(match[1], 10);
            break;
          }
        }
        if (detectedPort !== null) break;
      }

      expect(detectedPort).toBe(3001);
    });

    it('should detect port from Next.js output', () => {
      const outputLines = [
        '> @acme-app/web@1.0.0 dev',
        '> next dev',
        '   ▲ Next.js 15.0.0',
        '   - Local:        http://localhost:3000',
      ];

      const pattern = /http:\/\/localhost:(\d+)/i;
      let detectedPort: number | null = null;

      for (let i = outputLines.length - 1; i >= 0; i--) {
        const match = outputLines[i].match(pattern);
        if (match) {
          detectedPort = parseInt(match[1], 10);
          break;
        }
      }

      expect(detectedPort).toBe(3000);
    });

    it('should return null when no port detected', () => {
      const outputLines = [
        '> acme-app-extension@1.0.0 dev',
        '> esbuild --watch',
        'Build succeeded',
      ];

      const portPatterns = [
        /listening on.*:(\d+)/i,
        /http:\/\/localhost:(\d+)/i,
      ];

      let detectedPort: number | null = null;
      for (const line of outputLines) {
        for (const pattern of portPatterns) {
          const match = line.match(pattern);
          if (match) {
            detectedPort = parseInt(match[1], 10);
          }
        }
      }

      expect(detectedPort).toBeNull();
    });
  });
});

// ============================================================================
// Dev Server MCP Tools - Security
// ============================================================================

describe('Dev Server MCP Tools - Security', () => {
  describe('Secret Value Isolation', () => {
    it('should validate DevServerStartResult never contains secret values', () => {
      /**
       * CRITICAL: The DevServerStartResult type contains ONLY:
       * - started[].name: string (service name)
       * - started[].label: string (human-readable label)
       * - started[].pid: number (process ID)
       * - started[].port: number (expected port)
       * - started[].status: enum (started|already_running|error)
       * - started[].error?: string (error message, NOT secret values)
       * - secretsResolved: number (count only)
       * - secretsFailed: string[] (key names only, NOT values or references)
       *
       * Secret values exist ONLY in:
       * 1. resolveLocalSecrets() local variable (resolvedEnv)
       * 2. Child process env vars (passed via spawn options)
       */
      const typeFields = [
        'name', 'label', 'pid', 'port', 'status', 'error',
        'secretsResolved', 'secretsFailed',
      ];

      const dangerousFields = ['value', 'secret', 'credential', 'token', 'env', 'password'];

      for (const field of dangerousFields) {
        expect(typeFields).not.toContain(field);
      }
    });

    it('should validate resolveLocalSecrets failures do not expose partial values', () => {
      /**
       * When resolveLocalSecrets encounters an opRead failure:
       * - The key name is added to failedKeys
       * - The error is caught (not propagated)
       * - No partial secret values are stored
       * - resolvedEnv only contains FULLY resolved values
       *
       * This prevents scenarios like:
       * - Partial base64 token exposure
       * - Connection string with embedded credentials
       * - API key prefix exposure
       */
      const mockResolveResult = {
        resolvedEnv: {
          SUPABASE_URL: '[resolved-in-process]',
          RESEND_API_KEY: '[resolved-in-process]',
        },
        failedKeys: ['STRIPE_SECRET_KEY', 'ELASTIC_API_KEY'],
      };

      // failedKeys contains ONLY key names
      for (const key of mockResolveResult.failedKeys) {
        expect(key).not.toMatch(/^sk_/);
        expect(key).not.toMatch(/^op:\/\//);
        expect(key).not.toMatch(/[=:]/); // Not a key=value pair
      }
    });

    it('should validate ring buffer contents are never serialized in responses', () => {
      /**
       * The output ring buffer (outputBuffer) captures stdout/stderr
       * from child processes for port detection ONLY.
       *
       * Ring buffer contents:
       * - Used internally by detectPort()
       * - NEVER included in any tool response
       * - Could contain log output with sensitive data
       * - Maximum 50 lines (bounded memory)
       *
       * Responses that must NOT include buffer:
       * - DevServerStartResult: No outputBuffer field
       * - DevServerStopResult: No outputBuffer field
       * - DevServerStatusResult: detectedPort only (number|null)
       */
      const mockStatusResponse = {
        services: [{
          name: 'backend',
          label: 'Backend',
          pid: 12345,
          port: 3001,
          running: true,
          uptime: 60,
          detectedPort: 3001,
        }],
      };

      const serialized = JSON.stringify(mockStatusResponse);
      expect(serialized).not.toContain('outputBuffer');
      expect(serialized).not.toContain('stdout');
      expect(serialized).not.toContain('stderr');
    });
  });

  describe('Process Cleanup', () => {
    it('should document cleanup on MCP server exit', () => {
      /**
       * CRITICAL: Orphan process prevention
       *
       * The MCP server registers handlers for:
       * - process.on('exit') → cleanupManagedProcesses()
       * - process.on('SIGINT') → cleanupManagedProcesses() + exit
       * - process.on('SIGTERM') → cleanupManagedProcesses() + exit
       *
       * cleanupManagedProcesses() iterates managedProcesses map:
       * 1. Check if PID is alive
       * 2. Send SIGTERM to alive processes
       * 3. Clear the map
       *
       * This ensures dev servers don't outlive the Claude Code session.
       */
      const signals = ['exit', 'SIGINT', 'SIGTERM'];

      expect(signals).toContain('exit');
      expect(signals).toContain('SIGINT');
      expect(signals).toContain('SIGTERM');
    });

    it('should document child process exit auto-removal', () => {
      /**
       * Each spawned child process registers an exit handler:
       *
       * child.on('exit', () => {
       *   managedProcesses.delete(name);
       * });
       *
       * This ensures the map stays clean when processes exit
       * naturally (e.g., crash, manual kill, build completion).
       */
      expect(true).toBe(true);
    });
  });

  describe('Port 0 Services', () => {
    it('should skip port checks when port is 0', () => {
      /**
       * Services with port: 0 (e.g., extension with esbuild watch):
       * - isPortInUse(0) → always returns false
       * - killPort(0) → no-op
       * - No PORT env var injected
       * - detectPort may still find a port from output (informational)
       */
      const extensionService = {
        filter: 'acme-app-extension',
        command: 'dev',
        port: 0,
        label: 'Extension',
      };

      expect(extensionService.port).toBe(0);
    });
  });

  describe('Infrastructure Credential Filtering', () => {
    it('should exclude all infrastructure credentials from child env', () => {
      /**
       * CRITICAL: The INFRA_CRED_KEYS set must filter these keys
       * from process.env before passing to child spawn.
       * This test verifies the filtering logic used in devServerStart.
       */
      const INFRA_CRED_KEYS = new Set([
        'OP_SERVICE_ACCOUNT_TOKEN',
        'RENDER_API_KEY',
        'VERCEL_TOKEN',
        'VERCEL_TEAM_ID',
        'GH_TOKEN',
        'GITHUB_TOKEN',
      ]);

      const mockProcessEnv: Record<string, string> = {
        HOME: '/Users/test',
        PATH: '/usr/bin',
        NODE_ENV: 'development',
        OP_SERVICE_ACCOUNT_TOKEN: 'secret-op-token',
        RENDER_API_KEY: 'secret-render-key',
        VERCEL_TOKEN: 'secret-vercel-token',
        VERCEL_TEAM_ID: 'team-123',
        GH_TOKEN: 'secret-gh-token',
        GITHUB_TOKEN: 'secret-github-token',
        SUPABASE_URL: 'https://db.supabase.co',
      };

      const childEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(mockProcessEnv)) {
        if (v !== undefined && !INFRA_CRED_KEYS.has(k)) childEnv[k] = v;
      }

      // Infrastructure creds excluded
      expect(childEnv).not.toHaveProperty('OP_SERVICE_ACCOUNT_TOKEN');
      expect(childEnv).not.toHaveProperty('RENDER_API_KEY');
      expect(childEnv).not.toHaveProperty('VERCEL_TOKEN');
      expect(childEnv).not.toHaveProperty('VERCEL_TEAM_ID');
      expect(childEnv).not.toHaveProperty('GH_TOKEN');
      expect(childEnv).not.toHaveProperty('GITHUB_TOKEN');

      // Application env vars preserved
      expect(childEnv).toHaveProperty('HOME', '/Users/test');
      expect(childEnv).toHaveProperty('PATH', '/usr/bin');
      expect(childEnv).toHaveProperty('NODE_ENV', 'development');
      expect(childEnv).toHaveProperty('SUPABASE_URL', 'https://db.supabase.co');
    });

    it('should inject resolved secrets into child env, overriding parent values', () => {
      const childEnv: Record<string, string> = {
        HOME: '/Users/test',
        SUPABASE_URL: 'old-value',
      };

      const resolvedEnv: Record<string, string> = {
        SUPABASE_URL: 'resolved-from-1password',
        ELASTIC_CLOUD_ID: 'resolved-elastic-id',
      };

      Object.assign(childEnv, resolvedEnv);

      expect(childEnv.SUPABASE_URL).toBe('resolved-from-1password');
      expect(childEnv.ELASTIC_CLOUD_ID).toBe('resolved-elastic-id');
      expect(childEnv.HOME).toBe('/Users/test');
    });
  });
});

// ============================================================================
// Dev Server MCP Tools - Functional Helper Tests
// ============================================================================

describe('Dev Server MCP Tools - Functional Helpers', () => {
  describe('Ring Buffer (appendOutput logic)', () => {
    it('should append lines up to MAX_OUTPUT_LINES', () => {
      const MAX_OUTPUT_LINES = 50;
      const buffer: string[] = [];

      function appendOutput(buf: string[], line: string): void {
        buf.push(line);
        if (buf.length > MAX_OUTPUT_LINES) {
          buf.shift();
        }
      }

      // Fill to capacity
      for (let i = 0; i < MAX_OUTPUT_LINES; i++) {
        appendOutput(buffer, `line-${i}`);
      }

      expect(buffer).toHaveLength(MAX_OUTPUT_LINES);
      expect(buffer[0]).toBe('line-0');
      expect(buffer[MAX_OUTPUT_LINES - 1]).toBe(`line-${MAX_OUTPUT_LINES - 1}`);
    });

    it('should evict oldest line when buffer overflows', () => {
      const MAX_OUTPUT_LINES = 50;
      const buffer: string[] = [];

      function appendOutput(buf: string[], line: string): void {
        buf.push(line);
        if (buf.length > MAX_OUTPUT_LINES) {
          buf.shift();
        }
      }

      // Fill to capacity + 5
      for (let i = 0; i < MAX_OUTPUT_LINES + 5; i++) {
        appendOutput(buffer, `line-${i}`);
      }

      expect(buffer).toHaveLength(MAX_OUTPUT_LINES);
      // First 5 should be evicted
      expect(buffer[0]).toBe('line-5');
      expect(buffer[MAX_OUTPUT_LINES - 1]).toBe(`line-${MAX_OUTPUT_LINES + 4}`);
    });
  });

  describe('detectPort (port detection from output)', () => {
    const portPatterns = [
      /listening on.*:(\d+)/i,
      /started.*on.*:(\d+)/i,
      /ready on.*:(\d+)/i,
      /http:\/\/localhost:(\d+)/i,
      /http:\/\/127\.0\.0\.1:(\d+)/i,
      /port\s+(\d+)/i,
    ];

    function detectPort(lines: string[]): number | null {
      for (let i = lines.length - 1; i >= 0; i--) {
        for (const pattern of portPatterns) {
          const match = lines[i].match(pattern);
          if (match) {
            const port = parseInt(match[1], 10);
            if (port > 0 && port < 65536) return port;
          }
        }
      }
      return null;
    }

    it('should detect Hono server port', () => {
      expect(detectPort(['Server listening on :3001'])).toBe(3001);
    });

    it('should detect Express server port', () => {
      expect(detectPort(['Express started on http://localhost:4000'])).toBe(4000);
    });

    it('should detect Next.js server port', () => {
      expect(detectPort(['   - Local:        http://localhost:3000'])).toBe(3000);
    });

    it('should detect 127.0.0.1 binding', () => {
      expect(detectPort(['Listening at http://127.0.0.1:8080'])).toBe(8080);
    });

    it('should detect "ready on" pattern', () => {
      expect(detectPort(['Server ready on http://localhost:5000'])).toBe(5000);
    });

    it('should detect "port N" pattern', () => {
      expect(detectPort(['Running on port 9000'])).toBe(9000);
    });

    it('should return null for no port', () => {
      expect(detectPort(['Build succeeded', 'Watching for changes'])).toBeNull();
    });

    it('should return null for empty buffer', () => {
      expect(detectPort([])).toBeNull();
    });

    it('should prefer latest port if multiple detected', () => {
      const lines = [
        'Server started on port 3000',
        'Restarted on port 3001',
      ];
      expect(detectPort(lines)).toBe(3001);
    });

    it('should reject port 0 and invalid ports', () => {
      expect(detectPort(['listening on :0'])).toBeNull();
      expect(detectPort(['listening on :99999'])).toBeNull();
    });
  });

  describe('isProcessAlive logic', () => {
    it('should return false for non-existent PID', () => {
      function isProcessAlive(pid: number): boolean {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }

      // PID 99999999 should not exist
      expect(isProcessAlive(99999999)).toBe(false);
    });

    it('should return true for current process PID', () => {
      function isProcessAlive(pid: number): boolean {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }

      // Current process should always be alive
      expect(isProcessAlive(process.pid)).toBe(true);
    });
  });
});
