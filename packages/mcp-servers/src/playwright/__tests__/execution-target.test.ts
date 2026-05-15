/**
 * Unit tests for execution-target.ts resolveExecutionTarget()
 *
 * The new routing model is a 3-rule decision tree:
 *
 *   1. Structural local (no error): remoteEligible=false or usesChromeBridge → local
 *   2. Explicit conflict: local && stealth → error
 *   3. Explicit local: local → local
 *   4. Stealth (explicit or DB-derived): Steel.dev (fail-closed)
 *   5. Default: Fly.io (fail-closed)
 *
 * resolveExecutionTarget() is a pure function — no I/O, no side effects.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveExecutionTarget,
  detectChromeBridgeUsage,
  type ExecutionTargetInput,
} from '../execution-target.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Input that routes to Fly.io by default (no flags, Fly configured & healthy,
 * Steel also configured for stealth tests).
 */
function defaultInput(overrides: Partial<ExecutionTargetInput> = {}): ExecutionTargetInput {
  return {
    usesChromeBridge: false,
    remoteEligible: true,
    stealthRequired: false,
    flyConfigured: true,
    flyHealthy: true,
    activeMachineCount: 0,
    maxConcurrentMachines: 10,
    steelConfigured: true,
    steelHealthy: true,
    activeSteelSessionCount: 0,
    maxConcurrentSteelSessions: 2,
    ...overrides,
  };
}

// ============================================================================
// Rule 1 — Structural local (no error)
// ============================================================================

describe('resolveExecutionTarget — structural local', () => {
  it('should route to local when remoteEligible=false', () => {
    const r = resolveExecutionTarget(defaultInput({ remoteEligible: false }));
    expect(r.target).toBe('local');
    expect(r.error).toBeUndefined();
    expect(r.reason).toContain('remote_eligible=false');
  });

  it('should route to local when usesChromeBridge=true', () => {
    const r = resolveExecutionTarget(defaultInput({ usesChromeBridge: true }));
    expect(r.target).toBe('local');
    expect(r.error).toBeUndefined();
    expect(r.reason).toContain('chrome-bridge');
  });

  it('should prefer remoteEligible=false over chrome-bridge (DB is authoritative)', () => {
    const r = resolveExecutionTarget(defaultInput({
      remoteEligible: false,
      usesChromeBridge: true,
    }));
    expect(r.target).toBe('local');
    expect(r.reason).toContain('remote_eligible=false');
  });

  it('should win over explicit stealth=true (structural beats stealth)', () => {
    const r = resolveExecutionTarget(defaultInput({
      remoteEligible: false,
      stealth: true,
    }));
    expect(r.target).toBe('local');
    expect(r.error).toBeUndefined();
  });

  it('should win over stealth_required=true (structural beats stealth)', () => {
    const r = resolveExecutionTarget(defaultInput({
      usesChromeBridge: true,
      stealthRequired: true,
    }));
    expect(r.target).toBe('local');
    expect(r.error).toBeUndefined();
  });

  it('should win even when local && stealth would conflict otherwise', () => {
    // Structural local fires first, so the conflict check never runs
    const r = resolveExecutionTarget(defaultInput({
      remoteEligible: false,
      local: true,
      stealth: true,
    }));
    expect(r.target).toBe('local');
    expect(r.error).toBeUndefined();
  });
});

// ============================================================================
// Rule 2 — Explicit conflict
// ============================================================================

describe('resolveExecutionTarget — local && stealth conflict', () => {
  it('should error when both local=true and stealth=true are set', () => {
    const r = resolveExecutionTarget(defaultInput({ local: true, stealth: true }));
    expect(r.target).toBe('local');
    expect(r.error).toBe(true);
    expect(r.reason).toContain('cannot request both');
  });
});

// ============================================================================
// Rule 3 — Explicit local
// ============================================================================

describe('resolveExecutionTarget — explicit local', () => {
  it('should route to local when local=true', () => {
    const r = resolveExecutionTarget(defaultInput({ local: true }));
    expect(r.target).toBe('local');
    expect(r.error).toBeUndefined();
    expect(r.reason).toContain('local: true');
  });

  it('should route to local even when Fly.io is healthy', () => {
    const r = resolveExecutionTarget(defaultInput({
      local: true,
      flyConfigured: true,
      flyHealthy: true,
    }));
    expect(r.target).toBe('local');
  });

  it('should ignore stealthRequired when explicit local=true is set', () => {
    // Note: explicit local + stealth_required=true (DB) → local wins.
    // Only an explicit stealth=true flag conflicts with local.
    const r = resolveExecutionTarget(defaultInput({
      local: true,
      stealthRequired: true,
    }));
    expect(r.target).toBe('local');
    expect(r.error).toBeUndefined();
  });
});

// ============================================================================
// Rule 4 — Stealth (explicit or DB-derived)
// ============================================================================

describe('resolveExecutionTarget — stealth (Steel.dev)', () => {
  it('should route to steel when stealth=true and Steel configured + healthy', () => {
    const r = resolveExecutionTarget(defaultInput({ stealth: true }));
    expect(r.target).toBe('steel');
    expect(r.error).toBeUndefined();
    expect(r.reason).toContain('stealth: true');
  });

  it('should route to steel when stealthRequired=true (DB flag)', () => {
    const r = resolveExecutionTarget(defaultInput({ stealthRequired: true }));
    expect(r.target).toBe('steel');
    expect(r.error).toBeUndefined();
    expect(r.reason).toContain('stealth_required=true');
  });

  it('should fail-closed when stealth=true but Steel not configured', () => {
    const r = resolveExecutionTarget(defaultInput({
      stealth: true,
      steelConfigured: false,
    }));
    expect(r.target).toBe('steel');
    expect(r.error).toBe(true);
    expect(r.reason).toContain('not configured');
  });

  it('should fail-closed when stealth=true but Steel unhealthy', () => {
    const r = resolveExecutionTarget(defaultInput({
      stealth: true,
      steelHealthy: false,
    }));
    expect(r.target).toBe('steel');
    expect(r.error).toBe(true);
    expect(r.reason).toContain('unreachable');
  });

  it('should fail-closed when stealth=true but Steel at session capacity', () => {
    const r = resolveExecutionTarget(defaultInput({
      stealth: true,
      activeSteelSessionCount: 2,
      maxConcurrentSteelSessions: 2,
    }));
    expect(r.target).toBe('steel');
    expect(r.error).toBe(true);
    expect(r.reason).toContain('capacity');
    expect(r.reason).toContain('2/2');
  });

  it('should fail-closed when stealthRequired=true but Steel not configured', () => {
    const r = resolveExecutionTarget(defaultInput({
      stealthRequired: true,
      steelConfigured: false,
    }));
    expect(r.target).toBe('steel');
    expect(r.error).toBe(true);
    expect(r.reason).toContain('stealth_required=true');
  });
});

// ============================================================================
// Rule 5 — Default Fly.io
// ============================================================================

describe('resolveExecutionTarget — default Fly.io', () => {
  it('should route to fly when no local/stealth flags and Fly healthy', () => {
    const r = resolveExecutionTarget(defaultInput());
    expect(r.target).toBe('fly');
    expect(r.error).toBeUndefined();
    expect(r.reason).toContain('default');
  });

  it('should fail-closed when Fly.io not configured', () => {
    const r = resolveExecutionTarget(defaultInput({ flyConfigured: false }));
    expect(r.target).toBe('fly');
    expect(r.error).toBe(true);
    expect(r.reason).toContain('not configured');
  });

  it('should fail-closed when Fly.io unhealthy', () => {
    const r = resolveExecutionTarget(defaultInput({ flyHealthy: false }));
    expect(r.target).toBe('fly');
    expect(r.error).toBe(true);
    expect(r.reason).toContain('unreachable');
  });

  it('should fail-closed when Fly.io at machine capacity', () => {
    const r = resolveExecutionTarget(defaultInput({
      activeMachineCount: 10,
      maxConcurrentMachines: 10,
    }));
    expect(r.target).toBe('fly');
    expect(r.error).toBe(true);
    expect(r.reason).toContain('capacity');
    expect(r.reason).toContain('10/10');
  });

  it('should route to fly when remoteEligible is undefined (heuristics defer)', () => {
    const r = resolveExecutionTarget(defaultInput({ remoteEligible: undefined }));
    expect(r.target).toBe('fly');
    expect(r.error).toBeUndefined();
  });

  it('should route to fly when remoteEligible is explicitly true', () => {
    const r = resolveExecutionTarget(defaultInput({ remoteEligible: true }));
    expect(r.target).toBe('fly');
    expect(r.error).toBeUndefined();
  });
});

// ============================================================================
// Return-value shape
// ============================================================================

describe('resolveExecutionTarget — return shape', () => {
  it('should always return target in {local, fly, steel}', () => {
    const inputs: ExecutionTargetInput[] = [
      defaultInput(),
      defaultInput({ local: true }),
      defaultInput({ stealth: true }),
      defaultInput({ remoteEligible: false }),
      defaultInput({ flyConfigured: false }),
    ];
    for (const input of inputs) {
      const r = resolveExecutionTarget(input);
      expect(['local', 'fly', 'steel']).toContain(r.target);
    }
  });

  it('should always return a non-empty reason', () => {
    const r = resolveExecutionTarget(defaultInput());
    expect(typeof r.reason).toBe('string');
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('should never set error on a healthy default route', () => {
    const r = resolveExecutionTarget(defaultInput());
    expect(r.error).toBeUndefined();
  });
});

// ============================================================================
// detectChromeBridgeUsage — heuristic helper (unchanged)
// ============================================================================

describe('detectChromeBridgeUsage', () => {
  it('should detect ext- prefix patterns', () => {
    expect(detectChromeBridgeUsage('e2e/demo/ext-sidebar.demo.ts')).toBe(true);
    expect(detectChromeBridgeUsage('tests/ext-auth.demo.ts')).toBe(true);
  });

  it('should detect platform prefix patterns', () => {
    expect(detectChromeBridgeUsage('e2e/platformIntegration.demo.ts')).toBe(true);
    expect(detectChromeBridgeUsage('e2e/Platform-demo.demo.ts')).toBe(true);
  });

  it('should detect /extension/ path segment', () => {
    expect(detectChromeBridgeUsage('tests/extension/sidebar.demo.ts')).toBe(true);
    expect(detectChromeBridgeUsage('/app/extension/panel.demo.ts')).toBe(true);
  });

  it('should detect /platform-fixtures path segment', () => {
    expect(detectChromeBridgeUsage('tests/platform-fixtures/auth.demo.ts')).toBe(true);
  });

  it('should return false for normal demo files', () => {
    expect(detectChromeBridgeUsage('e2e/demo/onboarding.demo.ts')).toBe(false);
    expect(detectChromeBridgeUsage('e2e/demo/billing.demo.ts')).toBe(false);
    expect(detectChromeBridgeUsage('tests/user-flow.demo.ts')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(detectChromeBridgeUsage('')).toBe(false);
  });
});
