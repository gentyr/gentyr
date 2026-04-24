/**
 * Execution Target Resolver for Remote Playwright
 *
 * Determines whether a demo should run locally or on a remote Fly.io machine.
 * Implements a three-tier priority system: forced-local physical requirements,
 * forced-remote explicit requests, and intelligent auto-routing.
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
  /** Whether the demo is explicitly set to headless mode */
  headless: boolean;
  /** Whether Fly.io is configured in services.json */
  flyConfigured: boolean;
  /** Whether Fly.io API is reachable (health check passed) */
  flyHealthy: boolean;
  /** Whether the display lock is currently held by another agent */
  displayLockContended: boolean;
  /** Whether the scenario has headed=true in the DB (requires window recording) */
  scenarioHeaded: boolean;
  /** Whether the scenario uses chrome-bridge fixtures */
  usesChromeBridge: boolean;
  /** Explicit remote override from the agent (true=force remote, false=force local, undefined=auto) */
  explicitRemote?: boolean;
  /** Number of currently running Fly machines */
  activeMachineCount?: number;
  /** Max concurrent machines allowed */
  maxConcurrentMachines?: number;
}

/**
 * The resolved execution target with a human-readable routing reason.
 */
export interface ExecutionTarget {
  /** Where to execute: local machine or remote Fly.io */
  target: 'local' | 'remote';
  /** Human-readable reason for the routing decision */
  reason: string;
  /**
   * Whether this was an auto-downgrade from headed to headless+remote.
   * Only set to true on the specific contention-bypass path.
   */
  autoDowngraded?: boolean;
}

// ============================================================================
// Core Resolver
// ============================================================================

/**
 * Determine whether a demo should run locally or on a remote Fly.io machine.
 *
 * Three-tier priority system:
 *
 * Tier 1 (forced local): Scenarios that physically require local resources
 *   - Headed demos (need display for window recording)
 *   - Chrome-bridge scenarios (need real Chrome + extension socket)
 *   - Scenario has headed=true flag in DB
 *   - Agent explicitly passed remote=false
 *
 * Tier 2 (forced remote): Agent explicitly requested remote execution
 *   - Agent passed remote=true
 *   - Only valid if the demo is headless-eligible (no chrome-bridge, no headed requirement)
 *   - If forced remote but demo requires local resources, returns local with warning in reason
 *
 * Tier 3 (auto-routing): Intelligent routing based on current state
 *   - If Fly.io is configured AND healthy AND demo is headless → remote
 *   - If display lock is contended AND demo is headless-eligible → remote (contention bypass)
 *   - If Fly.io is at machine capacity → local (with reason noting capacity)
 *   - Fallback → local
 */
export function resolveExecutionTarget(input: ExecutionTargetInput): ExecutionTarget {
  const {
    headless,
    flyConfigured,
    flyHealthy,
    displayLockContended,
    scenarioHeaded,
    usesChromeBridge,
    explicitRemote,
    activeMachineCount = 0,
    maxConcurrentMachines = 3,
  } = input;

  // --------------------------------------------------------------------------
  // Tier 1: Forced local (physical requirements)
  // --------------------------------------------------------------------------

  // explicit remote=false always wins regardless of other flags
  if (explicitRemote === false) {
    return { target: 'local', reason: 'Explicitly requested local execution (remote: false)' };
  }

  // Chrome-bridge scenarios require a local Chrome process with an active
  // extension socket — there is no equivalent on a remote machine.
  if (usesChromeBridge) {
    if (explicitRemote === true) {
      return {
        target: 'local',
        reason: 'Chrome-bridge scenarios require local Chrome with extension socket — cannot run remotely',
      };
    }
    return { target: 'local', reason: 'Scenario uses chrome-bridge (requires local Chrome)' };
  }

  // Scenarios flagged headed=true in the DB require ScreenCaptureKit / display
  // access for window recording — remote machines have no display.
  if (scenarioHeaded) {
    if (explicitRemote === true) {
      return {
        target: 'local',
        reason: 'Scenario has headed=true (requires window recording) — cannot run remotely',
      };
    }
    return { target: 'local', reason: 'Scenario requires headed browser (headed=true in DB)' };
  }

  // headless=false at the call site also implies local display access.
  if (!headless) {
    if (explicitRemote === true) {
      return {
        target: 'local',
        reason: 'Headed mode requested (headless=false) — cannot run remotely without display',
      };
    }
    return { target: 'local', reason: 'Running in headed mode (requires local display)' };
  }

  // --------------------------------------------------------------------------
  // Beyond this point the demo is headless-eligible.
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Tier 2: Forced remote (explicit agent request)
  // --------------------------------------------------------------------------

  if (explicitRemote === true) {
    if (!flyConfigured) {
      return {
        target: 'local',
        reason: 'Remote execution requested but Fly.io is not configured in services.json',
      };
    }
    if (!flyHealthy) {
      return {
        target: 'local',
        reason: 'Remote execution requested but Fly.io API is unreachable',
      };
    }
    if (activeMachineCount >= maxConcurrentMachines) {
      return {
        target: 'local',
        reason: `Remote execution requested but at machine capacity (${activeMachineCount}/${maxConcurrentMachines})`,
      };
    }
    return { target: 'remote', reason: 'Explicitly requested remote execution (remote: true)' };
  }

  // --------------------------------------------------------------------------
  // Tier 3: Auto-routing
  // --------------------------------------------------------------------------

  if (!flyConfigured) {
    return { target: 'local', reason: 'Fly.io not configured — running locally' };
  }

  if (!flyHealthy) {
    return { target: 'local', reason: 'Fly.io API unreachable — falling back to local' };
  }

  if (activeMachineCount >= maxConcurrentMachines) {
    return {
      target: 'local',
      reason: `Fly.io at machine capacity (${activeMachineCount}/${maxConcurrentMachines}) — running locally`,
    };
  }

  // Contention bypass: display lock held by another agent — route this headless
  // demo to Fly.io so it does not queue behind the headed session.
  if (displayLockContended) {
    return {
      target: 'remote',
      reason: 'Display lock contended — routing headless demo to Fly.io to bypass queue',
      autoDowngraded: true,
    };
  }

  // Default auto-route: Fly.io is configured, healthy, and has capacity.
  return { target: 'remote', reason: 'Auto-routed to Fly.io (configured, healthy, headless-eligible)' };
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
 * that callers treat an unreachable API as a routing fallback to local,
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
