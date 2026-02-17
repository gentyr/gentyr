/**
 * Unit tests for deployments-reader.ts helper functions
 *
 * Tests the pure business-logic helpers that do NOT require network access:
 *   - inferEnvironment()        — maps service name / target to DeployEnvironment
 *   - normalizeRenderStatus()   — maps Render deploy statuses to canonical strings
 *   - normalizeVercelStatus()   — maps Vercel deploy states to canonical strings
 *   - truncateMessage()         — trims long commit messages and multi-line strings
 *
 * These helpers are unexported, so the logic is replicated here for isolation.
 * If the source ever exports them, replace the local copies with direct imports.
 *
 * Philosophy: validate structure and behaviour, never test performance.
 * Fail loudly — no silent fallbacks.
 */

import { describe, it, expect } from 'vitest';
import type { DeployEnvironment } from '../deployments-reader.js';

// ============================================================================
// Replicated helpers (keep in sync with deployments-reader.ts)
// ============================================================================

function inferEnvironment(serviceName: string, target?: string): DeployEnvironment {
  if (target === 'production') return 'production';
  if (target === 'preview' || target === 'development') return 'preview';
  const lower = serviceName.toLowerCase();
  if (lower.includes('staging') || lower.includes('stg')) return 'staging';
  if (lower.includes('preview') || lower.includes('dev')) return 'preview';
  return 'production';
}

function normalizeRenderStatus(status: string): string {
  if (status === 'live') return 'live';
  if (status.includes('in_progress')) return 'building';
  if (status.includes('failed')) return 'failed';
  if (status === 'deactivated' || status === 'canceled') return 'failed';
  return status;
}

function normalizeVercelStatus(state: string): string {
  if (state === 'READY') return 'ready';
  if (state === 'ERROR' || state === 'CANCELED') return 'failed';
  if (state === 'BUILDING' || state === 'QUEUED' || state === 'INITIALIZING') return 'building';
  return state.toLowerCase();
}

function truncateMessage(msg: string | undefined | null, maxLen = 60): string | undefined {
  if (!msg) return undefined;
  const line = msg.split('\n')[0].trim();
  if (line.length <= maxLen) return line;
  return line.slice(0, maxLen - 1) + '\u2026';
}

// ============================================================================
// inferEnvironment
// ============================================================================

describe('inferEnvironment - explicit target parameter', () => {
  it('should return "production" when target is "production"', () => {
    expect(inferEnvironment('my-service', 'production')).toBe('production');
  });

  it('should return "preview" when target is "preview"', () => {
    expect(inferEnvironment('my-service', 'preview')).toBe('preview');
  });

  it('should return "preview" when target is "development"', () => {
    expect(inferEnvironment('my-service', 'development')).toBe('preview');
  });

  it('should prefer explicit target over service name keyword', () => {
    // Service name says "staging" but explicit target overrides it
    expect(inferEnvironment('my-staging-service', 'production')).toBe('production');
    expect(inferEnvironment('my-prod-service', 'preview')).toBe('preview');
  });
});

describe('inferEnvironment - staging detection via service name', () => {
  it('should return "staging" when service name contains "staging"', () => {
    expect(inferEnvironment('my-staging-service')).toBe('staging');
  });

  it('should return "staging" when service name contains "stg"', () => {
    expect(inferEnvironment('api-stg')).toBe('staging');
  });

  it('should be case-insensitive for staging keyword', () => {
    expect(inferEnvironment('API-STAGING')).toBe('staging');
    expect(inferEnvironment('API-STG')).toBe('staging');
    expect(inferEnvironment('Staging-API')).toBe('staging');
  });

  it('should return "staging" when service name has staging as substring', () => {
    expect(inferEnvironment('backend-staging-worker')).toBe('staging');
    expect(inferEnvironment('frontend-stg-v2')).toBe('staging');
  });
});

describe('inferEnvironment - preview detection via service name', () => {
  it('should return "preview" when service name contains "preview"', () => {
    expect(inferEnvironment('my-preview-service')).toBe('preview');
  });

  it('should return "preview" when service name contains "dev"', () => {
    expect(inferEnvironment('api-dev')).toBe('preview');
  });

  it('should be case-insensitive for preview keyword', () => {
    expect(inferEnvironment('MY-PREVIEW-API')).toBe('preview');
    expect(inferEnvironment('MY-DEV-API')).toBe('preview');
  });

  it('should return "preview" when service name has dev as substring', () => {
    expect(inferEnvironment('backend-dev-worker')).toBe('preview');
  });
});

describe('inferEnvironment - production fallback', () => {
  it('should return "production" when no target and no keywords match', () => {
    expect(inferEnvironment('my-api')).toBe('production');
  });

  it('should return "production" for generic service names', () => {
    expect(inferEnvironment('web')).toBe('production');
    expect(inferEnvironment('api')).toBe('production');
    expect(inferEnvironment('backend')).toBe('production');
    expect(inferEnvironment('worker')).toBe('production');
  });

  it('should return "production" when target is undefined', () => {
    expect(inferEnvironment('production-api', undefined)).toBe('production');
  });

  it('should return "production" for an empty service name with no target', () => {
    expect(inferEnvironment('')).toBe('production');
  });
});

describe('inferEnvironment - return type is always a valid DeployEnvironment', () => {
  const validEnvironments: DeployEnvironment[] = ['preview', 'staging', 'production'];

  const cases: Array<[string, string | undefined]> = [
    ['my-api', undefined],
    ['my-staging-api', undefined],
    ['my-preview-api', undefined],
    ['any-service', 'production'],
    ['any-service', 'preview'],
    ['any-service', 'development'],
  ];

  for (const [name, target] of cases) {
    it(`should return a valid DeployEnvironment for name="${name}" target=${target}`, () => {
      const result = inferEnvironment(name, target);
      expect(validEnvironments).toContain(result);
    });
  }
});

// ============================================================================
// normalizeRenderStatus
// ============================================================================

describe('normalizeRenderStatus - known statuses', () => {
  it('should return "live" for status "live"', () => {
    expect(normalizeRenderStatus('live')).toBe('live');
  });

  it('should return "building" for status "build_in_progress"', () => {
    expect(normalizeRenderStatus('build_in_progress')).toBe('building');
  });

  it('should return "building" for status "update_in_progress"', () => {
    expect(normalizeRenderStatus('update_in_progress')).toBe('building');
  });

  it('should return "failed" for status "build_failed"', () => {
    expect(normalizeRenderStatus('build_failed')).toBe('failed');
  });

  it('should return "failed" for status "update_failed"', () => {
    expect(normalizeRenderStatus('update_failed')).toBe('failed');
  });

  it('should return "failed" for status "deactivated"', () => {
    expect(normalizeRenderStatus('deactivated')).toBe('failed');
  });

  it('should return "failed" for status "canceled"', () => {
    expect(normalizeRenderStatus('canceled')).toBe('failed');
  });
});

describe('normalizeRenderStatus - passthrough for unknown statuses', () => {
  it('should return unknown status unchanged', () => {
    expect(normalizeRenderStatus('unknown_state')).toBe('unknown_state');
  });

  it('should return empty string unchanged', () => {
    expect(normalizeRenderStatus('')).toBe('');
  });
});

// ============================================================================
// normalizeVercelStatus
// ============================================================================

describe('normalizeVercelStatus - known states', () => {
  it('should return "ready" for state "READY"', () => {
    expect(normalizeVercelStatus('READY')).toBe('ready');
  });

  it('should return "failed" for state "ERROR"', () => {
    expect(normalizeVercelStatus('ERROR')).toBe('failed');
  });

  it('should return "failed" for state "CANCELED"', () => {
    expect(normalizeVercelStatus('CANCELED')).toBe('failed');
  });

  it('should return "building" for state "BUILDING"', () => {
    expect(normalizeVercelStatus('BUILDING')).toBe('building');
  });

  it('should return "building" for state "QUEUED"', () => {
    expect(normalizeVercelStatus('QUEUED')).toBe('building');
  });

  it('should return "building" for state "INITIALIZING"', () => {
    expect(normalizeVercelStatus('INITIALIZING')).toBe('building');
  });
});

describe('normalizeVercelStatus - unknown states are lowercased', () => {
  it('should lowercase unknown states', () => {
    expect(normalizeVercelStatus('UNKNOWN')).toBe('unknown');
  });

  it('should lowercase mixed-case unknown states', () => {
    expect(normalizeVercelStatus('SomeFutureState')).toBe('somefuturestate');
  });

  it('should return empty string for empty input', () => {
    expect(normalizeVercelStatus('')).toBe('');
  });
});

// ============================================================================
// truncateMessage
// ============================================================================

describe('truncateMessage - null and undefined input', () => {
  it('should return undefined for undefined input', () => {
    expect(truncateMessage(undefined)).toBeUndefined();
  });

  it('should return undefined for null input', () => {
    expect(truncateMessage(null)).toBeUndefined();
  });

  it('should return undefined for empty string', () => {
    expect(truncateMessage('')).toBeUndefined();
  });
});

describe('truncateMessage - short messages pass through unchanged', () => {
  it('should return message unchanged when within default limit', () => {
    const msg = 'Fix bug in login flow';
    expect(truncateMessage(msg)).toBe(msg);
  });

  it('should return message of exactly 60 chars unchanged', () => {
    const msg = 'A'.repeat(60);
    expect(truncateMessage(msg)).toBe(msg);
    expect(truncateMessage(msg)!.length).toBe(60);
  });

  it('should return message of 59 chars unchanged', () => {
    const msg = 'A'.repeat(59);
    expect(truncateMessage(msg)).toBe(msg);
  });
});

describe('truncateMessage - long messages are truncated with ellipsis', () => {
  it('should truncate message longer than 60 chars and append ellipsis', () => {
    const msg = 'A'.repeat(61);
    const result = truncateMessage(msg);
    expect(result).toBeDefined();
    expect(result!.length).toBe(60);
    expect(result!.endsWith('\u2026')).toBe(true);
  });

  it('should truncate to maxLen characters including the ellipsis', () => {
    const msg = 'B'.repeat(100);
    const result = truncateMessage(msg);
    expect(result!.length).toBe(60);
    expect(result).toBe('B'.repeat(59) + '\u2026');
  });

  it('should respect custom maxLen parameter', () => {
    const msg = 'X'.repeat(30);
    const result = truncateMessage(msg, 20);
    expect(result!.length).toBe(20);
    expect(result!.endsWith('\u2026')).toBe(true);
  });

  it('should not truncate when message equals custom maxLen', () => {
    const msg = 'X'.repeat(20);
    const result = truncateMessage(msg, 20);
    expect(result).toBe(msg);
    expect(result!.length).toBe(20);
  });
});

describe('truncateMessage - multi-line messages use only the first line', () => {
  it('should use only the first line of a multi-line message', () => {
    const msg = 'First line\nSecond line\nThird line';
    expect(truncateMessage(msg)).toBe('First line');
  });

  it('should trim leading/trailing whitespace from the first line', () => {
    const msg = '  Trimmed message  \nSecond line';
    expect(truncateMessage(msg)).toBe('Trimmed message');
  });

  it('should truncate long first lines from multi-line messages', () => {
    const firstLine = 'A'.repeat(80);
    const msg = firstLine + '\nSome other line';
    const result = truncateMessage(msg);
    expect(result!.length).toBe(60);
    expect(result!.endsWith('\u2026')).toBe(true);
  });
});
