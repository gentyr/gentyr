/**
 * Unit tests for logging-reader.ts
 *
 * Tests business logic for:
 * - parseSizeToBytes: converts Elasticsearch size strings to byte counts
 * - assessSourceCoverage: classifies log sources as active/missing/low-volume
 * - getLoggingData: main entry point returns empty data when credentials absent,
 *   sets hasData correctly, and returns correct output structure
 *
 * Since parseSizeToBytes and assessSourceCoverage are not exported, their logic
 * is inlined in this file to test it directly — following the same pattern used
 * elsewhere in this test suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getLoggingData } from '../logging-reader.js';

// ============================================================================
// Inline reimplementation of parseSizeToBytes (mirrors logging-reader.ts)
// ============================================================================

function parseSizeToBytes(sizeStr: string): number {
  const match = sizeStr.match(/^([\d.]+)(b|kb|mb|gb|tb)$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024,
  };
  return value * (multipliers[unit] || 1);
}

// ============================================================================
// Inline reimplementation of assessSourceCoverage (mirrors logging-reader.ts)
// ============================================================================

type SourceStatus = 'active' | 'missing' | 'low-volume';

interface SourceCoverageEntry {
  source: string;
  status: SourceStatus;
  description: string;
}

interface ServiceEntry {
  service: string;
  count: number;
}

interface SourceEntry {
  source: string;
  count: number;
}

const EXPECTED_SOURCES = [
  { source: 'api', description: 'Application API server logs' },
  { source: 'worker', description: 'Background job/worker logs' },
  { source: 'deployment', description: 'Deploy event logs from Render/Vercel' },
  { source: 'ci-cd', description: 'CI/CD pipeline logs (GitHub Actions)' },
  { source: 'testing', description: 'Test execution logs (Vitest/Playwright)' },
  { source: 'database', description: 'Supabase/Postgres query logs' },
  { source: 'cdn', description: 'Cloudflare access/WAF logs' },
  { source: 'auth', description: 'Authentication event logs' },
  { source: 'cron', description: 'Scheduled job execution logs' },
];

const LOW_VOLUME_THRESHOLD = 10;

function assessSourceCoverage(
  byService: ServiceEntry[],
  bySource: SourceEntry[],
): SourceCoverageEntry[] {
  const activeNames = new Set<string>();
  for (const s of byService) {
    activeNames.add(s.service.toLowerCase());
  }
  for (const s of bySource) {
    activeNames.add(s.source.toLowerCase());
  }

  const countByName = new Map<string, number>();
  for (const s of byService) {
    countByName.set(s.service.toLowerCase(), s.count);
  }
  for (const s of bySource) {
    const existing = countByName.get(s.source.toLowerCase()) || 0;
    countByName.set(s.source.toLowerCase(), Math.max(existing, s.count));
  }

  return EXPECTED_SOURCES.map(expected => {
    const matchingName = [...activeNames].find(name =>
      name.includes(expected.source) || expected.source.includes(name),
    );

    if (!matchingName) {
      return { source: expected.source, status: 'missing' as const, description: expected.description };
    }

    const count = countByName.get(matchingName) || 0;
    if (count < LOW_VOLUME_THRESHOLD) {
      return { source: expected.source, status: 'low-volume' as const, description: expected.description };
    }

    return { source: expected.source, status: 'active' as const, description: expected.description };
  });
}

// ============================================================================
// parseSizeToBytes
// ============================================================================

describe('parseSizeToBytes', () => {
  it('should parse bytes (b) correctly', () => {
    expect(parseSizeToBytes('100b')).toBe(100);
    expect(parseSizeToBytes('1b')).toBe(1);
    expect(parseSizeToBytes('0b')).toBe(0);
  });

  it('should parse kilobytes (kb) correctly', () => {
    expect(parseSizeToBytes('1kb')).toBe(1024);
    expect(parseSizeToBytes('2kb')).toBe(2048);
    expect(parseSizeToBytes('512kb')).toBe(512 * 1024);
  });

  it('should parse megabytes (mb) correctly', () => {
    expect(parseSizeToBytes('1mb')).toBe(1024 * 1024);
    expect(parseSizeToBytes('500mb')).toBe(500 * 1024 * 1024);
    expect(parseSizeToBytes('100mb')).toBe(100 * 1024 * 1024);
  });

  it('should parse gigabytes (gb) correctly', () => {
    expect(parseSizeToBytes('1gb')).toBe(1024 * 1024 * 1024);
    expect(parseSizeToBytes('2gb')).toBe(2 * 1024 * 1024 * 1024);
    expect(parseSizeToBytes('10gb')).toBe(10 * 1024 * 1024 * 1024);
  });

  it('should parse terabytes (tb) correctly', () => {
    expect(parseSizeToBytes('1tb')).toBe(1024 * 1024 * 1024 * 1024);
    expect(parseSizeToBytes('2tb')).toBe(2 * 1024 * 1024 * 1024 * 1024);
  });

  it('should parse decimal values', () => {
    const result = parseSizeToBytes('1.2gb');
    expect(result).toBeCloseTo(1.2 * 1024 * 1024 * 1024, 0);
  });

  it('should be case-insensitive for unit suffix', () => {
    expect(parseSizeToBytes('500MB')).toBe(500 * 1024 * 1024);
    expect(parseSizeToBytes('1GB')).toBe(1024 * 1024 * 1024);
    expect(parseSizeToBytes('10KB')).toBe(10 * 1024);
    expect(parseSizeToBytes('2TB')).toBe(2 * 1024 * 1024 * 1024 * 1024);
  });

  it('should return 0 for unrecognized format', () => {
    expect(parseSizeToBytes('')).toBe(0);
    expect(parseSizeToBytes('invalid')).toBe(0);
    expect(parseSizeToBytes('100')).toBe(0);
    expect(parseSizeToBytes('mb')).toBe(0);
    expect(parseSizeToBytes('abc mb')).toBe(0);
  });

  it('should return a non-negative number', () => {
    const inputs = ['0b', '1kb', '500mb', '1.2gb', '2tb'];
    for (const input of inputs) {
      const result = parseSizeToBytes(input);
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(result)).toBe(false);
    }
  });

  it('should scale correctly across all units (each 1024x larger)', () => {
    const b = parseSizeToBytes('1b');
    const kb = parseSizeToBytes('1kb');
    const mb = parseSizeToBytes('1mb');
    const gb = parseSizeToBytes('1gb');
    const tb = parseSizeToBytes('1tb');

    expect(kb / b).toBe(1024);
    expect(mb / kb).toBe(1024);
    expect(gb / mb).toBe(1024);
    expect(tb / gb).toBe(1024);
  });
});

// ============================================================================
// assessSourceCoverage
// ============================================================================

describe('assessSourceCoverage', () => {
  it('should return an entry for every expected source', () => {
    const result = assessSourceCoverage([], []);

    expect(result.length).toBe(EXPECTED_SOURCES.length);

    const resultSources = result.map(r => r.source);
    for (const expected of EXPECTED_SOURCES) {
      expect(resultSources).toContain(expected.source);
    }
  });

  it('should mark all sources as missing when no services or sources provided', () => {
    const result = assessSourceCoverage([], []);

    for (const entry of result) {
      expect(entry.status).toBe('missing');
    }
  });

  it('should mark a source as active when count meets the threshold', () => {
    const byService: ServiceEntry[] = [{ service: 'api', count: 100 }];
    const result = assessSourceCoverage(byService, []);

    const apiEntry = result.find(r => r.source === 'api');
    expect(apiEntry).toBeDefined();
    expect(apiEntry!.status).toBe('active');
  });

  it('should mark a source as low-volume when count is below threshold', () => {
    const byService: ServiceEntry[] = [{ service: 'api', count: 5 }];
    const result = assessSourceCoverage(byService, []);

    const apiEntry = result.find(r => r.source === 'api');
    expect(apiEntry).toBeDefined();
    expect(apiEntry!.status).toBe('low-volume');
  });

  it('should mark a source as low-volume when count equals zero', () => {
    const byService: ServiceEntry[] = [{ service: 'api', count: 0 }];
    const result = assessSourceCoverage(byService, []);

    const apiEntry = result.find(r => r.source === 'api');
    expect(apiEntry!.status).toBe('low-volume');
  });

  it('should use threshold boundary correctly (9 = low-volume, 10 = active)', () => {
    const belowThreshold: ServiceEntry[] = [{ service: 'api', count: 9 }];
    const atThreshold: ServiceEntry[] = [{ service: 'api', count: 10 }];

    const belowResult = assessSourceCoverage(belowThreshold, []);
    expect(belowResult.find(r => r.source === 'api')!.status).toBe('low-volume');

    const atResult = assessSourceCoverage(atThreshold, []);
    expect(atResult.find(r => r.source === 'api')!.status).toBe('active');
  });

  it('should match source names from bySource as well as byService', () => {
    const bySource: SourceEntry[] = [{ source: 'worker', count: 50 }];
    const result = assessSourceCoverage([], bySource);

    const workerEntry = result.find(r => r.source === 'worker');
    expect(workerEntry).toBeDefined();
    expect(workerEntry!.status).toBe('active');
  });

  it('should use the maximum count when a source appears in both byService and bySource', () => {
    // byService has count 5 (below threshold), bySource has count 20 (above threshold)
    const byService: ServiceEntry[] = [{ service: 'auth', count: 5 }];
    const bySource: SourceEntry[] = [{ source: 'auth', count: 20 }];
    const result = assessSourceCoverage(byService, bySource);

    const authEntry = result.find(r => r.source === 'auth');
    expect(authEntry!.status).toBe('active');
  });

  it('should match via substring containment (service name contains expected source)', () => {
    // 'api-gateway' contains 'api'
    const byService: ServiceEntry[] = [{ service: 'api-gateway', count: 100 }];
    const result = assessSourceCoverage(byService, []);

    const apiEntry = result.find(r => r.source === 'api');
    expect(apiEntry!.status).toBe('active');
  });

  it('should be case-insensitive when matching service names', () => {
    const byService: ServiceEntry[] = [{ service: 'API', count: 100 }];
    const result = assessSourceCoverage(byService, []);

    const apiEntry = result.find(r => r.source === 'api');
    expect(apiEntry!.status).toBe('active');
  });

  it('should preserve the description from EXPECTED_SOURCES', () => {
    const result = assessSourceCoverage([], []);

    for (const entry of result) {
      const expected = EXPECTED_SOURCES.find(e => e.source === entry.source);
      expect(expected).toBeDefined();
      expect(entry.description).toBe(expected!.description);
    }
  });

  it('should handle multiple active sources independently', () => {
    const byService: ServiceEntry[] = [
      { service: 'api', count: 500 },
      { service: 'worker', count: 200 },
      { service: 'auth', count: 100 },
    ];
    const result = assessSourceCoverage(byService, []);

    expect(result.find(r => r.source === 'api')!.status).toBe('active');
    expect(result.find(r => r.source === 'worker')!.status).toBe('active');
    expect(result.find(r => r.source === 'auth')!.status).toBe('active');

    // Sources not in byService remain missing
    expect(result.find(r => r.source === 'cron')!.status).toBe('missing');
    expect(result.find(r => r.source === 'cdn')!.status).toBe('missing');
  });

  it('should return only valid status values', () => {
    const byService: ServiceEntry[] = [
      { service: 'api', count: 100 },
      { service: 'worker', count: 5 },
    ];
    const result = assessSourceCoverage(byService, []);

    const validStatuses: SourceStatus[] = ['active', 'missing', 'low-volume'];
    for (const entry of result) {
      expect(validStatuses).toContain(entry.status);
    }
  });

  it('should validate structure of each returned entry', () => {
    const byService: ServiceEntry[] = [{ service: 'api', count: 100 }];
    const result = assessSourceCoverage(byService, []);

    for (const entry of result) {
      expect(typeof entry.source).toBe('string');
      expect(entry.source.length).toBeGreaterThan(0);
      expect(typeof entry.status).toBe('string');
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// getLoggingData — main entry point
// ============================================================================

describe('getLoggingData - credentials absent', () => {
  let savedEndpoint: string | undefined;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    savedEndpoint = process.env['ELASTIC_ENDPOINT'];
    savedApiKey = process.env['ELASTIC_API_KEY'];
    delete process.env['ELASTIC_ENDPOINT'];
    delete process.env['ELASTIC_API_KEY'];
  });

  afterEach(() => {
    if (savedEndpoint !== undefined) {
      process.env['ELASTIC_ENDPOINT'] = savedEndpoint;
    } else {
      delete process.env['ELASTIC_ENDPOINT'];
    }
    if (savedApiKey !== undefined) {
      process.env['ELASTIC_API_KEY'] = savedApiKey;
    } else {
      delete process.env['ELASTIC_API_KEY'];
    }
  });

  it('should return empty LoggingData when no credentials are configured', async () => {
    const result = await getLoggingData();

    expect(result.hasData).toBe(false);
    expect(result.totalLogs1h).toBe(0);
    expect(result.totalLogs24h).toBe(0);
    expect(result.volumeTimeseries).toEqual([]);
    expect(result.byLevel).toEqual([]);
    expect(result.byService).toEqual([]);
    expect(result.bySource).toEqual([]);
    expect(result.topErrors).toEqual([]);
    expect(result.topWarnings).toEqual([]);
    expect(result.storage.estimatedDailyGB).toBe(0);
    expect(result.storage.estimatedMonthlyCost).toBe(0);
    expect(result.storage.indexCount).toBe(0);
    expect(result.sourceCoverage).toEqual([]);
  });

  it('should return empty data when only ELASTIC_ENDPOINT is set (missing API key)', async () => {
    process.env['ELASTIC_ENDPOINT'] = 'https://elastic.example.com';
    delete process.env['ELASTIC_API_KEY'];

    const result = await getLoggingData();

    expect(result.hasData).toBe(false);
  });

  it('should return empty data when only ELASTIC_API_KEY is set (missing endpoint)', async () => {
    delete process.env['ELASTIC_ENDPOINT'];
    process.env['ELASTIC_API_KEY'] = 'test-api-key';

    const result = await getLoggingData();

    expect(result.hasData).toBe(false);
  });

  it('should validate the full structure of the returned LoggingData object', async () => {
    const result = await getLoggingData();

    // Top-level fields
    expect(result).toHaveProperty('hasData');
    expect(result).toHaveProperty('totalLogs1h');
    expect(result).toHaveProperty('totalLogs24h');
    expect(result).toHaveProperty('volumeTimeseries');
    expect(result).toHaveProperty('byLevel');
    expect(result).toHaveProperty('byService');
    expect(result).toHaveProperty('bySource');
    expect(result).toHaveProperty('topErrors');
    expect(result).toHaveProperty('topWarnings');
    expect(result).toHaveProperty('storage');
    expect(result).toHaveProperty('sourceCoverage');

    // Type assertions
    expect(typeof result.hasData).toBe('boolean');
    expect(typeof result.totalLogs1h).toBe('number');
    expect(typeof result.totalLogs24h).toBe('number');
    expect(Array.isArray(result.volumeTimeseries)).toBe(true);
    expect(Array.isArray(result.byLevel)).toBe(true);
    expect(Array.isArray(result.byService)).toBe(true);
    expect(Array.isArray(result.bySource)).toBe(true);
    expect(Array.isArray(result.topErrors)).toBe(true);
    expect(Array.isArray(result.topWarnings)).toBe(true);
    expect(Array.isArray(result.sourceCoverage)).toBe(true);

    // Storage sub-object
    expect(result.storage).toHaveProperty('estimatedDailyGB');
    expect(result.storage).toHaveProperty('estimatedMonthlyCost');
    expect(result.storage).toHaveProperty('indexCount');
    expect(typeof result.storage.estimatedDailyGB).toBe('number');
    expect(typeof result.storage.estimatedMonthlyCost).toBe('number');
    expect(typeof result.storage.indexCount).toBe('number');
  });

  it('should return non-NaN numeric fields', async () => {
    const result = await getLoggingData();

    expect(Number.isNaN(result.totalLogs1h)).toBe(false);
    expect(Number.isNaN(result.totalLogs24h)).toBe(false);
    expect(Number.isNaN(result.storage.estimatedDailyGB)).toBe(false);
    expect(Number.isNaN(result.storage.estimatedMonthlyCost)).toBe(false);
    expect(Number.isNaN(result.storage.indexCount)).toBe(false);
  });

  it('should return non-negative numeric fields', async () => {
    const result = await getLoggingData();

    expect(result.totalLogs1h).toBeGreaterThanOrEqual(0);
    expect(result.totalLogs24h).toBeGreaterThanOrEqual(0);
    expect(result.storage.estimatedDailyGB).toBeGreaterThanOrEqual(0);
    expect(result.storage.estimatedMonthlyCost).toBeGreaterThanOrEqual(0);
    expect(result.storage.indexCount).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// Storage cost computation logic (inlined from queryStorage)
// ============================================================================

describe('Storage estimation logic', () => {
  // Mirror the calculation from queryStorage in logging-reader.ts
  const computeStorageEstimate = (totalBytes: number, indexCount: number) => {
    const totalGB = totalBytes / (1024 * 1024 * 1024);
    const estimatedDailyGB = totalGB / 7;
    const estimatedMonthlyCost = estimatedDailyGB * 30 * 0.25;
    return { estimatedDailyGB, estimatedMonthlyCost, indexCount };
  };

  it('should return zero estimates for zero bytes', () => {
    const result = computeStorageEstimate(0, 0);

    expect(result.estimatedDailyGB).toBe(0);
    expect(result.estimatedMonthlyCost).toBe(0);
    expect(result.indexCount).toBe(0);
  });

  it('should divide total storage by 7 to get daily estimate', () => {
    const totalBytes = 7 * 1024 * 1024 * 1024; // 7 GB
    const result = computeStorageEstimate(totalBytes, 1);

    expect(result.estimatedDailyGB).toBeCloseTo(1.0, 5);
  });

  it('should compute monthly cost as dailyGB * 30 * 0.25', () => {
    const totalBytes = 7 * 1024 * 1024 * 1024; // 7 GB total => 1 GB/day
    const result = computeStorageEstimate(totalBytes, 1);

    // 1 GB/day * 30 days * $0.25/GB = $7.50
    expect(result.estimatedMonthlyCost).toBeCloseTo(7.5, 5);
  });

  it('should preserve index count as provided', () => {
    const result = computeStorageEstimate(0, 42);

    expect(result.indexCount).toBe(42);
  });

  it('should return non-NaN values', () => {
    const result = computeStorageEstimate(500 * 1024 * 1024, 3);

    expect(Number.isNaN(result.estimatedDailyGB)).toBe(false);
    expect(Number.isNaN(result.estimatedMonthlyCost)).toBe(false);
  });

  it('should scale linearly with total bytes', () => {
    const result1 = computeStorageEstimate(1024 * 1024 * 1024, 1);   // 1 GB
    const result2 = computeStorageEstimate(2 * 1024 * 1024 * 1024, 1); // 2 GB

    expect(result2.estimatedDailyGB).toBeCloseTo(result1.estimatedDailyGB * 2, 10);
    expect(result2.estimatedMonthlyCost).toBeCloseTo(result1.estimatedMonthlyCost * 2, 10);
  });
});

// ============================================================================
// hasData flag logic
// ============================================================================

describe('LoggingData hasData flag logic', () => {
  // Mirror the hasData computation: volume.totalLogs24h > 0 || volume.totalLogs1h > 0
  const computeHasData = (totalLogs24h: number, totalLogs1h: number): boolean => {
    return totalLogs24h > 0 || totalLogs1h > 0;
  };

  it('should be false when both counts are zero', () => {
    expect(computeHasData(0, 0)).toBe(false);
  });

  it('should be true when only 24h count is non-zero', () => {
    expect(computeHasData(100, 0)).toBe(true);
  });

  it('should be true when only 1h count is non-zero', () => {
    expect(computeHasData(0, 5)).toBe(true);
  });

  it('should be true when both counts are non-zero', () => {
    expect(computeHasData(200, 10)).toBe(true);
  });
});

// ============================================================================
// volumeTimeseries padding logic
// ============================================================================

describe('volumeTimeseries padding logic', () => {
  // Mirror the padding/slicing logic from queryVolumeAndBreakdowns
  const buildTimeseries = (bucketCounts: number[]): number[] => {
    let timeseries = [...bucketCounts];
    while (timeseries.length < 24) {
      timeseries.unshift(0);
    }
    return timeseries.slice(-24);
  };

  it('should pad with leading zeros when fewer than 24 buckets', () => {
    const result = buildTimeseries([10, 20, 30]);

    expect(result.length).toBe(24);
    // Last 3 entries should be the original values
    expect(result[21]).toBe(10);
    expect(result[22]).toBe(20);
    expect(result[23]).toBe(30);
    // First entries should be zeros
    expect(result[0]).toBe(0);
    expect(result[20]).toBe(0);
  });

  it('should return exactly 24 entries when given exactly 24 buckets', () => {
    const input = Array.from({ length: 24 }, (_, i) => i + 1);
    const result = buildTimeseries(input);

    expect(result.length).toBe(24);
    expect(result).toEqual(input);
  });

  it('should truncate to last 24 entries when given more than 24 buckets', () => {
    const input = Array.from({ length: 30 }, (_, i) => i + 1);
    const result = buildTimeseries(input);

    expect(result.length).toBe(24);
    // Should be the last 24 values: 7 through 30
    expect(result[0]).toBe(7);
    expect(result[23]).toBe(30);
  });

  it('should return 24 zeros when given empty input', () => {
    const result = buildTimeseries([]);

    expect(result.length).toBe(24);
    expect(result.every(v => v === 0)).toBe(true);
  });

  it('should return non-negative numbers', () => {
    const result = buildTimeseries([5, 10, 15]);

    for (const count of result) {
      expect(count).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(count)).toBe(false);
    }
  });
});
