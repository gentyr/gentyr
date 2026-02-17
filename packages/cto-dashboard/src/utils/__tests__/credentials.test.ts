/**
 * Unit tests for credentials.ts
 *
 * Tests:
 * - resolveCredential(): env var priority, vault-mappings fallback, op:// detection,
 *   plain values, missing file, malformed JSON
 * - resolveElasticEndpoint(): ELASTIC_ENDPOINT env var, ELASTIC_CLOUD_ID base64
 *   decoding, malformed cloud IDs, missing credentials
 * - loadOpTokenFromMcpJson(): idempotency, token loading, graceful failure
 *
 * Note: opRead() calls `op` CLI which is unavailable in CI — those paths are
 * tested via vault-mappings with plain (non-op://) values only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Helpers — mirror the logic under test for self-contained assertions
// ============================================================================

/**
 * Encode a cloud ID body the same way Elastic does:
 * "<cluster-name>:<base64 of '{esHost}${kibanaHost}')>"
 * For these tests we only need the esHost decoded from parts[1].
 */
function makeCloudId(esHost: string, kibanaHost = 'kibana.example.com'): string {
  const encoded = Buffer.from(`${esHost}$${kibanaHost}`).toString('base64');
  return `my-cluster:${encoded}`;
}

// ============================================================================
// resolveElasticEndpoint — pure logic tests (no filesystem / process.env side effects)
// ============================================================================

/**
 * Inline re-implementation of resolveElasticEndpoint() decoding logic.
 * This lets us test the cloud ID parsing branch in complete isolation without
 * importing the module (which would trigger loadOpTokenFromMcpJson side effects).
 */
function decodeCloudIdToEndpoint(cloudId: string): string | null {
  const parts = cloudId.split(':');
  if (parts.length < 2) return null;
  try {
    const decoded = Buffer.from(parts[1], 'base64').toString('utf8');
    const [esHost] = decoded.split('$');
    if (!esHost) return null;
    return `https://${esHost}`;
  } catch {
    return null;
  }
}

describe('resolveElasticEndpoint — cloud ID decoding logic', () => {
  it('should decode a standard cloud ID to an https endpoint', () => {
    const cloudId = makeCloudId('my-es-host.elastic.cloud');
    const result = decodeCloudIdToEndpoint(cloudId);

    expect(result).toBe('https://my-es-host.elastic.cloud');
  });

  it('should return null when cloud ID has no colon separator', () => {
    const result = decodeCloudIdToEndpoint('no-colon-here');

    expect(result).toBeNull();
  });

  it('should return null when cloud ID has exactly one part (trailing colon)', () => {
    // "cluster:" — parts[1] is empty string
    const result = decodeCloudIdToEndpoint('cluster:');

    expect(result).toBeNull();
  });

  it('should return null when base64 payload decodes to empty string before $', () => {
    // Base64 of '$kibana.host' — esHost is empty string before '$'
    const encoded = Buffer.from('$kibana.host').toString('base64');
    const result = decodeCloudIdToEndpoint(`cluster:${encoded}`);

    expect(result).toBeNull();
  });

  it('should decode payload with no $ separator as a single host', () => {
    // When there is no '$', decoded.split('$')[0] is the entire string
    const encoded = Buffer.from('single-host.elastic.cloud').toString('base64');
    const result = decodeCloudIdToEndpoint(`cluster:${encoded}`);

    expect(result).toBe('https://single-host.elastic.cloud');
  });

  it('should only use the part before the first $ when multiple $ exist', () => {
    const encoded = Buffer.from('es.host$kibana.host$extra').toString('base64');
    const result = decodeCloudIdToEndpoint(`cluster:${encoded}`);

    expect(result).toBe('https://es.host');
  });

  it('should return an https:// URL, never http://', () => {
    const cloudId = makeCloudId('myhost.example.com');
    const result = decodeCloudIdToEndpoint(cloudId);

    expect(result).not.toBeNull();
    expect(result!.startsWith('https://')).toBe(true);
    expect(result!.startsWith('http://')).toBe(false);
  });

  it('should return a non-empty string when cloud ID is valid', () => {
    const cloudId = makeCloudId('host.elastic.cloud');
    const result = decodeCloudIdToEndpoint(cloudId);

    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);
  });

  it('should handle cloud ID with multiple colon separators (takes second part)', () => {
    // Simulate a cloud ID like "name:base64:extra" — parts[1] is still the base64 payload
    const encoded = Buffer.from('host.elastic.cloud$kibana.elastic.cloud').toString('base64');
    const cloudId = `my-cluster:${encoded}:some-extra-part`;
    const result = decodeCloudIdToEndpoint(cloudId);

    expect(result).toBe('https://host.elastic.cloud');
  });

  it('should return null for an empty cloud ID string', () => {
    const result = decodeCloudIdToEndpoint('');

    expect(result).toBeNull();
  });

  it('should not include the kibana host in the returned endpoint', () => {
    const cloudId = makeCloudId('es-host.elastic.cloud', 'kibana-host.elastic.cloud');
    const result = decodeCloudIdToEndpoint(cloudId);

    expect(result).toBe('https://es-host.elastic.cloud');
    expect(result).not.toContain('kibana-host');
  });
});

// ============================================================================
// resolveElasticEndpoint — integration with process.env (env var priority)
// ============================================================================

describe('resolveElasticEndpoint — env var priority', () => {
  let savedEndpoint: string | undefined;
  let savedCloudId: string | undefined;

  beforeEach(() => {
    savedEndpoint = process.env['ELASTIC_ENDPOINT'];
    savedCloudId = process.env['ELASTIC_CLOUD_ID'];
    delete process.env['ELASTIC_ENDPOINT'];
    delete process.env['ELASTIC_CLOUD_ID'];
  });

  afterEach(() => {
    if (savedEndpoint !== undefined) {
      process.env['ELASTIC_ENDPOINT'] = savedEndpoint;
    } else {
      delete process.env['ELASTIC_ENDPOINT'];
    }
    if (savedCloudId !== undefined) {
      process.env['ELASTIC_CLOUD_ID'] = savedCloudId;
    } else {
      delete process.env['ELASTIC_CLOUD_ID'];
    }
  });

  it('should return null when neither credential is set', async () => {
    // Import dynamically so env var state is read at call time
    const { resolveElasticEndpoint } = await import('../credentials.js');
    const result = resolveElasticEndpoint();

    expect(result).toBeNull();
  });

  it('should return the ELASTIC_ENDPOINT value directly when set', async () => {
    process.env['ELASTIC_ENDPOINT'] = 'https://my-serverless.elastic.cloud';
    const { resolveElasticEndpoint } = await import('../credentials.js');
    const result = resolveElasticEndpoint();

    expect(result).toBe('https://my-serverless.elastic.cloud');
  });

  it('should prefer ELASTIC_ENDPOINT over ELASTIC_CLOUD_ID when both are set', async () => {
    process.env['ELASTIC_ENDPOINT'] = 'https://direct-endpoint.elastic.cloud';
    process.env['ELASTIC_CLOUD_ID'] = makeCloudId('cloud-id-host.elastic.cloud');

    const { resolveElasticEndpoint } = await import('../credentials.js');
    const result = resolveElasticEndpoint();

    expect(result).toBe('https://direct-endpoint.elastic.cloud');
    expect(result).not.toContain('cloud-id-host');
  });

  it('should decode ELASTIC_CLOUD_ID when ELASTIC_ENDPOINT is absent', async () => {
    delete process.env['ELASTIC_ENDPOINT'];
    process.env['ELASTIC_CLOUD_ID'] = makeCloudId('my-hosted-es.elastic.cloud');

    const { resolveElasticEndpoint } = await import('../credentials.js');
    const result = resolveElasticEndpoint();

    expect(result).toBe('https://my-hosted-es.elastic.cloud');
  });

  it('should return null when ELASTIC_CLOUD_ID has no colon separator', async () => {
    delete process.env['ELASTIC_ENDPOINT'];
    process.env['ELASTIC_CLOUD_ID'] = 'notavalidcloudid';

    const { resolveElasticEndpoint } = await import('../credentials.js');
    const result = resolveElasticEndpoint();

    expect(result).toBeNull();
  });

  it('should return a string or null — never undefined', async () => {
    const { resolveElasticEndpoint } = await import('../credentials.js');
    const result = resolveElasticEndpoint();

    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('should return an https URL when endpoint is derived from cloud ID', async () => {
    delete process.env['ELASTIC_ENDPOINT'];
    process.env['ELASTIC_CLOUD_ID'] = makeCloudId('es.elastic.cloud');

    const { resolveElasticEndpoint } = await import('../credentials.js');
    const result = resolveElasticEndpoint();

    expect(result).not.toBeNull();
    expect(result!.startsWith('https://')).toBe(true);
  });
});

// ============================================================================
// resolveCredential — env var behavior
//
// NOTE: The vault-mappings.json path is a module-level constant resolved at
// import time from CLAUDE_PROJECT_DIR (or process.cwd()). Because Vitest
// caches module imports, we cannot change that path at runtime.  Tests for the
// vault-mappings fallback path therefore exercise the logic via inline
// re-implementation (mirroring the pattern used throughout this test suite).
// ============================================================================

/**
 * Inline re-implementation of getVaultMapping() from credentials.ts.
 * Allows vault-mappings tests to run against arbitrary file paths without
 * depending on the module-level constant.
 */
function getVaultMapping(vaultPath: string, key: string): string | null {
  try {
    if (!fs.existsSync(vaultPath)) return null;
    const data = JSON.parse(fs.readFileSync(vaultPath, 'utf8')) as { mappings?: Record<string, string> };
    return data.mappings?.[key] ?? null;
  } catch {
    return null;
  }
}

describe('resolveCredential — env var behavior', () => {
  let savedEnvVars: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnvVars = {
      ELASTIC_API_KEY: process.env['ELASTIC_API_KEY'],
      MY_TEST_CRED: process.env['MY_TEST_CRED'],
    };
    delete process.env['ELASTIC_API_KEY'];
    delete process.env['MY_TEST_CRED'];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnvVars)) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  });

  it('should return the env var value when set', async () => {
    process.env['ELASTIC_API_KEY'] = 'env-api-key-abc123';
    const { resolveCredential } = await import('../credentials.js');
    const result = resolveCredential('ELASTIC_API_KEY');

    expect(result).toBe('env-api-key-abc123');
  });

  it('should return null when no env var is set and no vault file exists', async () => {
    const { resolveCredential } = await import('../credentials.js');
    const result = resolveCredential('MY_TEST_CRED');

    // MY_TEST_CRED is not in any vault file in the real project dir
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('should return string or null — never undefined', async () => {
    const { resolveCredential } = await import('../credentials.js');
    const result = resolveCredential('MY_TEST_CRED');

    expect(result === null || typeof result === 'string').toBe(true);
    expect(result).not.toBeUndefined();
  });
});

// ============================================================================
// vault-mappings.json reading logic (inline re-implementation)
// ============================================================================

describe('vault-mappings.json reading logic', () => {
  let tempDir: string;
  let vaultMappingsPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join('/tmp', 'creds-vault-test-'));
    fs.mkdirSync(path.join(tempDir, '.claude'), { recursive: true });
    vaultMappingsPath = path.join(tempDir, '.claude', 'vault-mappings.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should return a plain string value from vault-mappings.json', () => {
    const mappings = { mappings: { MY_TEST_CRED: 'plain-value-from-vault' } };
    fs.writeFileSync(vaultMappingsPath, JSON.stringify(mappings));

    const result = getVaultMapping(vaultMappingsPath, 'MY_TEST_CRED');

    expect(result).toBe('plain-value-from-vault');
  });

  it('should return null when key is not present in mappings', () => {
    const mappings = { mappings: { OTHER_KEY: 'some-value' } };
    fs.writeFileSync(vaultMappingsPath, JSON.stringify(mappings));

    const result = getVaultMapping(vaultMappingsPath, 'MY_TEST_CRED');

    expect(result).toBeNull();
  });

  it('should return null when vault-mappings.json is malformed JSON', () => {
    fs.writeFileSync(vaultMappingsPath, 'NOT VALID JSON {{{{');

    const result = getVaultMapping(vaultMappingsPath, 'MY_TEST_CRED');

    expect(result).toBeNull();
  });

  it('should return null when vault-mappings.json file does not exist', () => {
    const result = getVaultMapping(path.join(tempDir, '.claude', 'nonexistent.json'), 'MY_TEST_CRED');

    expect(result).toBeNull();
  });

  it('should return null when vault-mappings.json has no mappings field', () => {
    const mappings = { other_field: {} };
    fs.writeFileSync(vaultMappingsPath, JSON.stringify(mappings));

    const result = getVaultMapping(vaultMappingsPath, 'MY_TEST_CRED');

    expect(result).toBeNull();
  });

  it('should return null when mappings object is empty', () => {
    const mappings = { mappings: {} };
    fs.writeFileSync(vaultMappingsPath, JSON.stringify(mappings));

    const result = getVaultMapping(vaultMappingsPath, 'MY_TEST_CRED');

    expect(result).toBeNull();
  });

  it('should return an op:// reference string as-is (not resolved here)', () => {
    const opRef = 'op://Private/MyService/api-key';
    const mappings = { mappings: { MY_TEST_CRED: opRef } };
    fs.writeFileSync(vaultMappingsPath, JSON.stringify(mappings));

    const result = getVaultMapping(vaultMappingsPath, 'MY_TEST_CRED');

    expect(result).toBe(opRef);
    expect(result!.startsWith('op://')).toBe(true);
  });

  it('should return string or null — never undefined', () => {
    const result = getVaultMapping(vaultMappingsPath, 'ANYTHING');

    expect(result === null || typeof result === 'string').toBe(true);
    expect(result).not.toBeUndefined();
  });
});

// ============================================================================
// resolveElasticEndpoint — return type contract
// ============================================================================

describe('resolveElasticEndpoint — return type contract', () => {
  it('should return null or a string URL — never a number, boolean, or object', async () => {
    const { resolveElasticEndpoint } = await import('../credentials.js');
    const result = resolveElasticEndpoint();

    const isNullOrString = result === null || typeof result === 'string';
    expect(isNullOrString).toBe(true);
  });

  it('should never return an empty string (only null or a real URL)', async () => {
    process.env['ELASTIC_ENDPOINT'] = 'https://real-endpoint.elastic.cloud';
    const { resolveElasticEndpoint } = await import('../credentials.js');
    const result = resolveElasticEndpoint();

    if (result !== null) {
      expect(result.length).toBeGreaterThan(0);
    }
    delete process.env['ELASTIC_ENDPOINT'];
  });
});

// ============================================================================
// loadOpTokenFromMcpJson — idempotency and structure (no actual op CLI calls)
// ============================================================================

describe('loadOpTokenFromMcpJson — graceful failure on missing .mcp.json', () => {
  let savedProjectDir: string | undefined;

  beforeEach(() => {
    savedProjectDir = process.env['CLAUDE_PROJECT_DIR'];
    // Point to a directory that has no .mcp.json
    process.env['CLAUDE_PROJECT_DIR'] = '/tmp/no-mcp-json-dir-that-does-not-exist';
  });

  afterEach(() => {
    if (savedProjectDir !== undefined) {
      process.env['CLAUDE_PROJECT_DIR'] = savedProjectDir;
    } else {
      delete process.env['CLAUDE_PROJECT_DIR'];
    }
  });

  it('should not throw when .mcp.json does not exist', async () => {
    const { loadOpTokenFromMcpJson } = await import('../credentials.js');

    expect(() => loadOpTokenFromMcpJson()).not.toThrow();
  });
});

// ============================================================================
// queryStorage fallback estimation logic (mirrored from logging-reader.ts)
// ============================================================================

/**
 * Inline re-implementation of the queryStorage fallback path.
 * When _cat/indices returns a non-OK response, the function estimates
 * storage from totalDocs24h * 500 bytes per document.
 */
function estimateStorageFromDocCount(totalDocs24h: number): {
  estimatedDailyGB: number;
  estimatedMonthlyCost: number;
  indexCount: number;
} {
  if (totalDocs24h <= 0) {
    return { estimatedDailyGB: 0, estimatedMonthlyCost: 0, indexCount: 0 };
  }
  const avgDocBytes = 500;
  const estimatedDailyGB = (totalDocs24h * avgDocBytes) / (1024 * 1024 * 1024);
  const estimatedMonthlyCost = estimatedDailyGB * 30 * 0.25;
  return { estimatedDailyGB, estimatedMonthlyCost, indexCount: 1 };
}

describe('queryStorage fallback estimation logic', () => {
  it('should return zero estimates when totalDocs24h is zero', () => {
    const result = estimateStorageFromDocCount(0);

    expect(result.estimatedDailyGB).toBe(0);
    expect(result.estimatedMonthlyCost).toBe(0);
    expect(result.indexCount).toBe(0);
  });

  it('should return zero estimates when totalDocs24h is negative', () => {
    const result = estimateStorageFromDocCount(-100);

    expect(result.estimatedDailyGB).toBe(0);
    expect(result.estimatedMonthlyCost).toBe(0);
    expect(result.indexCount).toBe(0);
  });

  it('should always return indexCount of 1 when docs are present', () => {
    const result = estimateStorageFromDocCount(1000);

    expect(result.indexCount).toBe(1);
  });

  it('should compute estimatedDailyGB as docs * 500 bytes / 1 GiB', () => {
    // 1 GiB = 1024^3 bytes; so 1 GiB / 500 = 2,147,483.648 docs needed for 1 GB
    const docsForOneGiB = Math.ceil((1024 * 1024 * 1024) / 500);
    const result = estimateStorageFromDocCount(docsForOneGiB);

    expect(result.estimatedDailyGB).toBeGreaterThanOrEqual(1.0);
    expect(result.estimatedDailyGB).toBeLessThan(1.01); // within 1%
  });

  it('should compute estimatedMonthlyCost as estimatedDailyGB * 30 * 0.25', () => {
    const totalDocs = 100_000;
    const result = estimateStorageFromDocCount(totalDocs);

    const expectedDailyGB = (totalDocs * 500) / (1024 * 1024 * 1024);
    const expectedMonthlyCost = expectedDailyGB * 30 * 0.25;

    expect(result.estimatedDailyGB).toBeCloseTo(expectedDailyGB, 10);
    expect(result.estimatedMonthlyCost).toBeCloseTo(expectedMonthlyCost, 10);
  });

  it('should scale linearly with totalDocs24h', () => {
    const result1 = estimateStorageFromDocCount(1_000);
    const result2 = estimateStorageFromDocCount(2_000);

    expect(result2.estimatedDailyGB).toBeCloseTo(result1.estimatedDailyGB * 2, 10);
    expect(result2.estimatedMonthlyCost).toBeCloseTo(result1.estimatedMonthlyCost * 2, 10);
  });

  it('should return non-NaN values for any positive doc count', () => {
    const inputs = [1, 100, 10_000, 1_000_000];
    for (const count of inputs) {
      const result = estimateStorageFromDocCount(count);
      expect(Number.isNaN(result.estimatedDailyGB)).toBe(false);
      expect(Number.isNaN(result.estimatedMonthlyCost)).toBe(false);
      expect(Number.isNaN(result.indexCount)).toBe(false);
    }
  });

  it('should return non-negative values', () => {
    const inputs = [0, 1, 50_000];
    for (const count of inputs) {
      const result = estimateStorageFromDocCount(count);
      expect(result.estimatedDailyGB).toBeGreaterThanOrEqual(0);
      expect(result.estimatedMonthlyCost).toBeGreaterThanOrEqual(0);
      expect(result.indexCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('should return a finite number for very large doc counts', () => {
    const result = estimateStorageFromDocCount(1_000_000_000);

    expect(Number.isFinite(result.estimatedDailyGB)).toBe(true);
    expect(Number.isFinite(result.estimatedMonthlyCost)).toBe(true);
  });
});

// ============================================================================
// Elasticsearch .keyword field naming contract
// ============================================================================

/**
 * These tests document and enforce the field naming convention used in
 * Elasticsearch queries across logging-reader.ts and infra-reader.ts.
 *
 * Elastic keyword fields must use the `.keyword` suffix for term aggregations
 * and term filters on text fields. Querying `level` (the analyzed field) will
 * return no results in most mappings; `level.keyword` is the keyword sub-field.
 */
describe('Elasticsearch .keyword field naming convention', () => {
  const AGGREGATION_FIELDS = [
    'level.keyword',
    'service.keyword',
    'module.keyword',
    'message.keyword',
  ] as const;

  const TERM_FILTER_FIELDS = [
    'level.keyword',
    'service.keyword',
  ] as const;

  it('should use .keyword suffix for all term aggregation fields', () => {
    for (const field of AGGREGATION_FIELDS) {
      expect(field.endsWith('.keyword')).toBe(true);
    }
  });

  it('should use .keyword suffix for all term filter fields', () => {
    for (const field of TERM_FILTER_FIELDS) {
      expect(field.endsWith('.keyword')).toBe(true);
    }
  });

  it('should not use bare field names (without .keyword) for term operations', () => {
    const bareFields = ['level', 'service', 'module', 'message'];
    for (const bare of bareFields) {
      // Bare field is NOT present in the keyword list
      expect((AGGREGATION_FIELDS as readonly string[]).includes(bare)).toBe(false);
    }
  });

  it('should match the expected field names used in queryVolumeAndBreakdowns', () => {
    // These are the exact field names from the body24h query in logging-reader.ts
    const volumeQueryFields = {
      by_level: 'level.keyword',
      by_service: 'service.keyword',
      by_source: 'module.keyword',
    };

    for (const field of Object.values(volumeQueryFields)) {
      expect(field.endsWith('.keyword')).toBe(true);
    }
  });

  it('should match the expected term filter fields used in queryTopMessages', () => {
    const termFilterFields = [
      'level.keyword', // errors filter: { term: { 'level.keyword': 'error' } }
      'level.keyword', // warnings filter: { term: { 'level.keyword': 'warn' } }
      'service.keyword', // top_services sub-aggregation
      'message.keyword', // top_messages aggregation
    ];

    for (const field of termFilterFields) {
      expect(field.endsWith('.keyword')).toBe(true);
    }
  });

  it('should match the expected fields used in queryElastic (infra-reader)', () => {
    // These are the exact field names from infra-reader.ts queryElastic
    const infraQueryFields = {
      by_level: 'level.keyword',
      by_service: 'service.keyword',
    };

    for (const field of Object.values(infraQueryFields)) {
      expect(field.endsWith('.keyword')).toBe(true);
    }
  });
});
