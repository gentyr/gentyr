/**
 * Execution Target Resolver for Demos
 *
 * Determines whether a demo should run locally, on a remote Fly.io machine,
 * or on a Steel.dev cloud browser.
 *
 * The model is a 3-rule decision tree, in priority order:
 *   1. Structural local: `usesChromeBridge` or `remoteEligible === false` → local
 *      (no error — these scenarios are physically incapable of running remotely)
 *   2. Explicit conflict: `local === true && stealth === true` → error
 *   3. Explicit local: `local === true` → local (CTO-gated for spawned agents — handled by hook)
 *   4. Stealth (explicit or DB-derived `stealthRequired`): Steel.dev (fail-closed)
 *   5. Default: Fly.io (fail-closed)
 *
 * This module is pure — no side effects, no imports of GENTYR hooks or MCP
 * infrastructure. All I/O is isolated to the async utility functions at the
 * bottom of the file.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * All inputs required to make an execution target routing decision.
 */
export interface ExecutionTargetInput {
  /** Caller explicitly requested local execution. */
  local?: boolean;
  /** Caller explicitly requested stealth (Steel.dev) execution. */
  stealth?: boolean;
  /** Whether the scenario uses chrome-bridge fixtures (structural local override). */
  usesChromeBridge: boolean;
  /**
   * Whether the scenario has remote_eligible=true in the DB.
   * `false` is an authoritative structural local override (e.g., chrome-bridge, local-only).
   * `true` or `undefined` defers to the rest of the routing tree.
   */
  remoteEligible?: boolean;
  /**
   * DB-derived stealth requirement (`demo_scenarios.stealth_required`).
   * When `true`, treated identically to `stealth: true` at routing time.
   */
  stealthRequired?: boolean;
  /** Whether Fly.io is configured in services.json (apiToken + appName resolved). */
  flyConfigured: boolean;
  /** Whether Fly.io API is reachable (health check passed). */
  flyHealthy: boolean;
  /** Number of currently running Fly machines. */
  activeMachineCount?: number;
  /** Max concurrent Fly.io machines allowed. */
  maxConcurrentMachines?: number;
  /** Whether Steel.dev is configured in services.json (apiKey resolved + enabled). */
  steelConfigured?: boolean;
  /** Whether Steel.dev API is reachable (health check passed). */
  steelHealthy?: boolean;
  /** Number of currently active Steel sessions. */
  activeSteelSessionCount?: number;
  /** Max concurrent Steel sessions allowed. */
  maxConcurrentSteelSessions?: number;
}

/**
 * The resolved execution target with a human-readable routing reason.
 */
export interface ExecutionTarget {
  /** Where to execute: local machine, Fly.io, or Steel.dev cloud browser. */
  target: 'local' | 'fly' | 'steel';
  /** Human-readable reason for the routing decision. */
  reason: string;
  /**
   * When true, the routing decision is an error — the caller must abort, not execute.
   * Used for fail-closed scenarios (e.g., stealth required but Steel not configured;
   * default Fly.io routing when Fly is not configured; `local && stealth` conflict).
   */
  error?: boolean;
}

// ============================================================================
// Core Resolver
// ============================================================================

/**
 * Determine whether a demo should run locally, on Fly.io, or on Steel.dev.
 *
 * Decision tree (in evaluation order):
 *
 *   1. Structural local (no error):
 *      - `remoteEligible === false` OR `usesChromeBridge` → `local`
 *      - These scenarios are physically incapable of running remotely
 *        (chrome-bridge sockets, extension fixtures, local-only DB flag).
 *
 *   2. Explicit conflict:
 *      - `local === true && stealth === true` → error
 *
 *   3. Explicit local:
 *      - `local === true` → `local`
 *      - CTO-gated for spawned agents at the hook layer (`demo-local-guard.js`);
 *        not enforced here.
 *
 *   4. Stealth (explicit or DB-derived):
 *      - `stealth === true` OR `stealthRequired === true` → `steel`
 *      - Fail-closed: must be configured, healthy, and under capacity.
 *
 *   5. Default:
 *      - `fly` — fail-closed: must be configured, healthy, and under capacity.
 */
export function resolveExecutionTarget(input: ExecutionTargetInput): ExecutionTarget {
  const {
    local = false,
    stealth = false,
    usesChromeBridge,
    remoteEligible,
    stealthRequired = false,
    flyConfigured,
    flyHealthy,
    activeMachineCount = 0,
    maxConcurrentMachines = 10,
    steelConfigured = false,
    steelHealthy = false,
    activeSteelSessionCount = 0,
    maxConcurrentSteelSessions = 2,
  } = input;

  // --------------------------------------------------------------------------
  // Rule 1: Structural local (no error)
  // --------------------------------------------------------------------------
  // These scenarios are physically incapable of running remotely. The DB
  // override (`remoteEligible=false`) takes precedence over heuristic detection.

  if (remoteEligible === false) {
    return {
      target: 'local',
      reason: 'Scenario not remote-eligible (remote_eligible=false in DB)',
    };
  }

  if (usesChromeBridge) {
    return {
      target: 'local',
      reason: 'Scenario uses chrome-bridge (requires local Chrome with extension socket)',
    };
  }

  // --------------------------------------------------------------------------
  // Rule 2: Explicit conflict
  // --------------------------------------------------------------------------

  if (local && stealth) {
    return {
      target: 'local',
      reason: 'Conflicting flags: cannot request both local=true and stealth=true',
      error: true,
    };
  }

  // --------------------------------------------------------------------------
  // Rule 3: Explicit local
  // --------------------------------------------------------------------------

  if (local) {
    return {
      target: 'local',
      reason: 'Explicitly requested local execution (local: true)',
    };
  }

  // --------------------------------------------------------------------------
  // Rule 4: Stealth (explicit or DB-derived) — fail-closed
  // --------------------------------------------------------------------------

  const wantStealth = stealth || stealthRequired;
  if (wantStealth) {
    const stealthSource = stealth
      ? 'stealth: true'
      : 'stealth_required=true in DB';
    if (!steelConfigured) {
      return {
        target: 'steel',
        reason: `Stealth requested (${stealthSource}) but Steel.dev is not configured in services.json`,
        error: true,
      };
    }
    if (!steelHealthy) {
      return {
        target: 'steel',
        reason: `Stealth requested (${stealthSource}) but Steel.dev API is unreachable`,
        error: true,
      };
    }
    if (activeSteelSessionCount >= maxConcurrentSteelSessions) {
      return {
        target: 'steel',
        reason: `Stealth requested (${stealthSource}) but Steel.dev at session capacity (${activeSteelSessionCount}/${maxConcurrentSteelSessions})`,
        error: true,
      };
    }
    return {
      target: 'steel',
      reason: `Routed to Steel.dev cloud browser (${stealthSource})`,
    };
  }

  // --------------------------------------------------------------------------
  // Rule 5: Default — Fly.io (fail-closed)
  // --------------------------------------------------------------------------

  if (!flyConfigured) {
    return {
      target: 'fly',
      reason: 'Default routing requires Fly.io but it is not configured in services.json',
      error: true,
    };
  }
  if (!flyHealthy) {
    return {
      target: 'fly',
      reason: 'Default routing requires Fly.io but Fly.io API is unreachable',
      error: true,
    };
  }
  if (activeMachineCount >= maxConcurrentMachines) {
    return {
      target: 'fly',
      reason: `Default routing requires Fly.io but at machine capacity (${activeMachineCount}/${maxConcurrentMachines})`,
      error: true,
    };
  }

  return {
    target: 'fly',
    reason: 'Routed to Fly.io (default — configured, healthy, capacity available)',
  };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Detect if a scenario uses chrome-bridge based on test file path patterns.
 *
 * This is a heuristic — scenarios matching these patterns typically import
 * platformTest fixtures that require the chrome-bridge Unix domain socket
 * connection.  It cannot be fully accurate without parsing fixture imports,
 * so callers should treat `true` as "probably requires chrome-bridge" and
 * fall through to a runtime failure message if the heuristic is wrong.
 *
 * Patterns matched:
 *   - `ext-<anything>.demo.ts`     — extension demos
 *   - `platform<anything>.demo.ts` — platform integration demos
 *   - paths containing `/extension/`
 *   - paths containing `/platform-fixtures`
 */
export function detectChromeBridgeUsage(testFile: string): boolean {
  const chromeBridgePatterns: RegExp[] = [
    /\bext-[^/]+\.demo\.ts$/,
    /\bplatform[^/]*\.demo\.ts$/i,
    /\/extension\//i,
    /\/platform-fixtures/i,
  ];

  return chromeBridgePatterns.some(pattern => pattern.test(testFile));
}

/**
 * Quick health check for the Fly.io Machines API.
 *
 * Issues a GET request to the machines list endpoint for `appName` and
 * returns `true` if the API responds with a 2xx status within `timeoutMs`.
 * Returns `false` on any network error, timeout, or non-2xx response so
 * that callers treat an unreachable API as a routing error (fail-closed),
 * not an unhandled exception.
 */
export async function checkFlyHealth(
  apiToken: string,
  appName: string,
  timeoutMs: number = 5000,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(
      `https://api.machines.dev/v1/apps/${appName}/machines`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiToken}` },
        signal: controller.signal,
      },
    );

    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Quick health check for the Steel.dev Cloud Browser API.
 *
 * Issues a GET request to the sessions list endpoint and returns `true`
 * if the API responds with a 2xx status within `timeoutMs`. Returns
 * `false` on any network error, timeout, or non-2xx response so that
 * callers treat an unreachable API as a fail-closed error for stealth
 * scenarios, not an unhandled exception.
 */
export async function checkSteelHealth(
  apiKey: string,
  timeoutMs: number = 5000,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(
      'https://api.steel.dev/v1/sessions',
      {
        method: 'GET',
        headers: {
          'steel-api-key': apiKey,
        },
        signal: controller.signal,
      },
    );

    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}
