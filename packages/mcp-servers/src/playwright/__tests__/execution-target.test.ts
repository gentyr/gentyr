/**
 * Unit tests for execution-target.ts resolveExecutionTarget()
 *
 * resolveExecutionTarget() is a pure function — no I/O, no side effects.
 * Tests validate the three-tier routing decision (forced-local, forced-remote,
 * auto-routing) and every branch introduced by the remote_eligible field.
 *
 * Naming convention: "should route to <target> when <condition>"
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
 * Returns a fully-specified input that auto-routes to remote by default
 * (Fly.io configured, healthy, headless, not contended, capacity available,
 * no physical constraints).  Override individual fields in each test.
 */
function remoteInput(overrides: Partial<ExecutionTargetInput> = {}): ExecutionTargetInput {
  return {
    headless: true,
    flyConfigured: true,
    flyHealthy: true,
    displayLockContended: false,
    scenarioHeaded: false,
    usesChromeBridge: false,
    remoteEligible: undefined,
    explicitRemote: undefined,
    activeMachineCount: 0,
    maxConcurrentMachines: 3,
    ...overrides,
  };
}

/**
 * Returns a fully-specified input that routes to local by default
 * (Fly.io not configured, headless, no physical constraints).
 */
function localInput(overrides: Partial<ExecutionTargetInput> = {}): ExecutionTargetInput {
  return {
    headless: true,
    flyConfigured: false,
    flyHealthy: false,
    displayLockContended: false,
    scenarioHeaded: false,
    usesChromeBridge: false,
    remoteEligible: undefined,
    explicitRemote: undefined,
    activeMachineCount: 0,
    maxConcurrentMachines: 3,
    ...overrides,
  };
}

// ============================================================================
// Tier 0 — Steel stealth routing
// ============================================================================

/**
 * Returns an input that routes to Steel by default (stealth_required, Steel
 * configured and healthy, Fly.io also configured for dual-instance).
 */
function steelInput(overrides: Partial<ExecutionTargetInput> = {}): ExecutionTargetInput {
  return {
    headless: true,
    flyConfigured: true,
    flyHealthy: true,
    displayLockContended: false,
    scenarioHeaded: false,
    usesChromeBridge: false,
    remoteEligible: undefined,
    explicitRemote: undefined,
    activeMachineCount: 0,
    maxConcurrentMachines: 3,
    stealthRequired: true,
    dualInstance: false,
    steelConfigured: true,
    steelHealthy: true,
    activeSteelSessionCount: 0,
    maxConcurrentSteelSessions: 2,
    ...overrides,
  };
}

describe('resolveExecutionTarget — Tier 0: Steel stealth', () => {
  it('should route to steel when stealth_required and Steel configured+healthy', () => {
    const result = resolveExecutionTarget(steelInput());
    expect(result.target).toBe('steel');
    expect(result.error).toBeUndefined();
    expect(result.reason).toContain('Stealth-required');
  });

  it('should fail-closed when stealth_required but Steel not configured', () => {
    const result = resolveExecutionTarget(steelInput({ steelConfigured: false }));
    expect(result.target).toBe('steel');
    expect(result.error).toBe(true);
    expect(result.reason).toContain('not configured');
  });

  it('should fail-closed when stealth_required but Steel unhealthy', () => {
    const result = resolveExecutionTarget(steelInput({ steelHealthy: false }));
    expect(result.target).toBe('steel');
    expect(result.error).toBe(true);
    expect(result.reason).toContain('unreachable');
  });

  it('should fail-closed when stealth_required but Steel at session capacity', () => {
    const result = resolveExecutionTarget(steelInput({
      activeSteelSessionCount: 2,
      maxConcurrentSteelSessions: 2,
    }));
    expect(result.target).toBe('steel');
    expect(result.error).toBe(true);
    expect(result.reason).toContain('capacity');
    expect(result.reason).toContain('2/2');
  });

  it('should route to steel for dual_instance scenarios', () => {
    const result = resolveExecutionTarget(steelInput({
      stealthRequired: false,
      dualInstance: true,
    }));
    expect(result.target).toBe('steel');
    expect(result.error).toBeUndefined();
    expect(result.reason).toContain('Dual-instance');
  });

  it('should fail-closed for dual_instance when Fly.io not configured', () => {
    const result = resolveExecutionTarget(steelInput({
      dualInstance: true,
      flyConfigured: false,
    }));
    expect(result.target).toBe('steel');
    expect(result.error).toBe(true);
    expect(result.reason).toContain('Fly.io');
    expect(result.reason).toContain('not configured');
  });

  it('should fail-closed for dual_instance when Fly.io unhealthy', () => {
    const result = resolveExecutionTarget(steelInput({
      dualInstance: true,
      flyHealthy: false,
    }));
    expect(result.target).toBe('steel');
    expect(result.error).toBe(true);
    expect(result.reason).toContain('Fly.io');
    expect(result.reason).toContain('unreachable');
  });

  it('should not route to steel when stealthRequired=false and dualInstance=false', () => {
    // Should fall through to Tier 1-3
    const result = resolveExecutionTarget(remoteInput({
      stealthRequired: false,
      dualInstance: false,
      steelConfigured: true,
      steelHealthy: true,
    }));
    expect(result.target).not.toBe('steel');
  });

  it('should take priority over explicitRemote=false (stealth always wins)', () => {
    const result = resolveExecutionTarget(steelInput({ explicitRemote: false }));
    // stealth_required fires in Tier 0, before the explicitRemote=false check in Tier 1
    expect(result.target).toBe('steel');
  });
});

// ============================================================================
// Tier 1 — Forced local (physical requirements)
// ============================================================================

describe('resolveExecutionTarget — Tier 1: forced local', () => {
  it('should route to local when explicitRemote=false regardless of all other flags', () => {
    const result = resolveExecutionTarget(remoteInput({ explicitRemote: false }));
    expect(result.target).toBe('local');
    expect(result.reason).toContain('remote: false');
  });

  it('should route to local when remoteEligible=false and no explicit remote request', () => {
    const result = resolveExecutionTarget(remoteInput({ remoteEligible: false }));
    expect(result.target).toBe('local');
    expect(result.reason).toContain('remote_eligible=false');
  });

  it('should route to local when remoteEligible=false even if explicitRemote=true', () => {
    const result = resolveExecutionTarget(remoteInput({
      remoteEligible: false,
      explicitRemote: true,
    }));
    expect(result.target).toBe('local');
    expect(result.reason).toContain('remote_eligible=false');
    expect(result.reason).toContain('DB override');
  });

  it('should route to local when usesChromeBridge=true (no explicit remote)', () => {
    const result = resolveExecutionTarget(remoteInput({ usesChromeBridge: true }));
    expect(result.target).toBe('local');
    expect(result.reason).toContain('chrome-bridge');
  });

  it('should route to local when usesChromeBridge=true even if explicitRemote=true', () => {
    const result = resolveExecutionTarget(remoteInput({
      usesChromeBridge: true,
      explicitRemote: true,
    }));
    expect(result.target).toBe('local');
    expect(result.reason.toLowerCase()).toContain('chrome-bridge');
  });

  it('should route to local when scenarioHeaded=true (no explicit remote)', () => {
    const result = resolveExecutionTarget(remoteInput({ scenarioHeaded: true }));
    expect(result.target).toBe('local');
    expect(result.reason).toContain('headed=true');
  });

  it('should route to remote when scenarioHeaded=true and explicitRemote=true (Xvfb path)', () => {
    const result = resolveExecutionTarget(remoteInput({
      scenarioHeaded: true,
      explicitRemote: true,
    }));
    expect(result.target).toBe('remote');
    expect(result.reason).toContain('Xvfb');
  });

  it('should route to local when headless=false without explicit remote', () => {
    const result = resolveExecutionTarget(remoteInput({ headless: false }));
    expect(result.target).toBe('local');
    expect(result.reason).toContain('headed mode');
  });

  it('should route to remote when headless=false with explicitRemote=true (Xvfb path)', () => {
    const result = resolveExecutionTarget(remoteInput({
      headless: false,
      explicitRemote: true,
    }));
    expect(result.target).toBe('remote');
    expect(result.reason).toContain('Xvfb');
  });

  describe('remoteEligible priority ordering', () => {
    it('should check remoteEligible=false before usesChromeBridge (DB is authoritative)', () => {
      // Both remoteEligible=false AND usesChromeBridge=true — remoteEligible fires first
      const result = resolveExecutionTarget(remoteInput({
        remoteEligible: false,
        usesChromeBridge: true,
        explicitRemote: true,
      }));
      expect(result.target).toBe('local');
      expect(result.reason).toContain('remote_eligible=false');
    });

    it('should check remoteEligible=false before scenarioHeaded', () => {
      const result = resolveExecutionTarget(remoteInput({
        remoteEligible: false,
        scenarioHeaded: true,
      }));
      expect(result.target).toBe('local');
      expect(result.reason).toContain('remote_eligible=false');
    });
  });
});

// ============================================================================
// Tier 2 — Forced remote (explicit agent request)
// ============================================================================

describe('resolveExecutionTarget — Tier 2: forced remote', () => {
  it('should route to remote when explicitRemote=true, Fly.io configured and healthy', () => {
    const result = resolveExecutionTarget(remoteInput({ explicitRemote: true }));
    expect(result.target).toBe('remote');
    expect(result.reason).toContain('remote: true');
  });

  it('should fall back to local when explicitRemote=true but Fly.io not configured', () => {
    const result = resolveExecutionTarget(remoteInput({
      explicitRemote: true,
      flyConfigured: false,
    }));
    expect(result.target).toBe('local');
    expect(result.reason).toContain('not configured');
  });

  it('should fall back to local when explicitRemote=true but Fly.io unhealthy', () => {
    const result = resolveExecutionTarget(remoteInput({
      explicitRemote: true,
      flyHealthy: false,
    }));
    expect(result.target).toBe('local');
    expect(result.reason).toContain('unreachable');
  });

  it('should fall back to local when explicitRemote=true but at machine capacity', () => {
    const result = resolveExecutionTarget(remoteInput({
      explicitRemote: true,
      activeMachineCount: 3,
      maxConcurrentMachines: 3,
    }));
    expect(result.target).toBe('local');
    expect(result.reason).toContain('capacity');
    expect(result.reason).toContain('3/3');
  });
});

// ============================================================================
// Tier 3 — Auto-routing
// ============================================================================

describe('resolveExecutionTarget — Tier 3: auto-routing', () => {
  it('should auto-route to local when Fly.io not configured', () => {
    const result = resolveExecutionTarget(localInput());
    expect(result.target).toBe('local');
    expect(result.reason).toContain('not configured');
  });

  it('should auto-route to local when Fly.io configured but unhealthy', () => {
    const result = resolveExecutionTarget(remoteInput({ flyHealthy: false }));
    expect(result.target).toBe('local');
    expect(result.reason).toContain('unreachable');
  });

  it('should auto-route to local when at machine capacity', () => {
    const result = resolveExecutionTarget(remoteInput({
      activeMachineCount: 3,
      maxConcurrentMachines: 3,
    }));
    expect(result.target).toBe('local');
    expect(result.reason).toContain('capacity');
  });

  it('should auto-route to remote on contention bypass (headless + display lock held)', () => {
    const result = resolveExecutionTarget(remoteInput({ displayLockContended: true }));
    expect(result.target).toBe('remote');
    expect(result.autoDowngraded).toBe(true);
    expect(result.reason).toContain('contended');
  });

  it('should auto-route to remote when Fly.io configured, healthy, headless', () => {
    const result = resolveExecutionTarget(remoteInput());
    expect(result.target).toBe('remote');
    expect(result.reason).toContain('Auto-routed');
  });

  it('should auto-route to local when remoteEligible=false despite Fly.io healthy', () => {
    const result = resolveExecutionTarget(remoteInput({ remoteEligible: false }));
    expect(result.target).toBe('local');
    expect(result.reason).toContain('remote_eligible=false');
  });

  it('should auto-route to remote when remoteEligible=true (explicit) and Fly.io healthy', () => {
    const result = resolveExecutionTarget(remoteInput({ remoteEligible: true }));
    expect(result.target).toBe('remote');
    expect(result.reason).toContain('Auto-routed');
  });

  it('should auto-route to remote when remoteEligible=undefined (heuristics apply)', () => {
    // undefined means "use heuristics", which default to remote when Fly.io is ready
    const result = resolveExecutionTarget(remoteInput({ remoteEligible: undefined }));
    expect(result.target).toBe('remote');
  });

  it('should not set autoDowngraded on a normal remote route', () => {
    const result = resolveExecutionTarget(remoteInput());
    expect(result.autoDowngraded).toBeUndefined();
  });

  it('should route to local even on display contention when remoteEligible=false', () => {
    // remoteEligible=false must be blocked before the contention bypass path
    const result = resolveExecutionTarget(remoteInput({
      displayLockContended: true,
      remoteEligible: false,
    }));
    expect(result.target).toBe('local');
    expect(result.reason).toContain('remote_eligible=false');
  });
});

// ============================================================================
// ExecutionTarget shape — structural validation
// ============================================================================

describe('resolveExecutionTarget — return value shape', () => {
  it('should always return a target string', () => {
    for (const input of [remoteInput(), localInput()]) {
      const result = resolveExecutionTarget(input);
      expect(typeof result.target).toBe('string');
      expect(['local', 'remote', 'steel']).toContain(result.target);
    }
  });

  it('should always return a non-empty reason string', () => {
    for (const input of [remoteInput(), localInput()]) {
      const result = resolveExecutionTarget(input);
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('should only set autoDowngraded when contention bypass fires', () => {
    const contended = resolveExecutionTarget(remoteInput({ displayLockContended: true }));
    expect(contended.autoDowngraded).toBe(true);

    const normal = resolveExecutionTarget(remoteInput({ displayLockContended: false }));
    expect(normal.autoDowngraded).toBeUndefined();
  });
});

// ============================================================================
// detectChromeBridgeUsage — heuristic helper
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
