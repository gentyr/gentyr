/**
 * Display Lock Manager — handles resource lock lifecycle for CTO dashboard demos.
 *
 * When the CTO launches a demo from the dashboard (Page 2), this module:
 *   1. Force-acquires the display + chrome-bridge locks, displacing any agent holder
 *   2. Signals the displaced agent to pause display-dependent work
 *   3. On demo completion, releases the locks (auto-promoting the displaced agent)
 *      and signals them to resume
 *
 * Uses dynamic import() to load resource-lock.js and session-signals.js from the
 * project's .claude/hooks/lib/ directory (same pattern as other GENTYR consumers).
 */

import * as path from 'path';

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const HOOKS_LIB = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib');
const CTO_AGENT_ID = 'cto-dashboard';

interface DisplacedHolder {
  agent_id: string;
  queue_id: string | null;
  title: string | null;
}

interface PreemptResult {
  resourcesAcquired: string[];
  displacedHolders: DisplacedHolder[];
}

// Module-level state: tracks displaced holders across preempt → release lifecycle
let _displacedHolders: DisplacedHolder[] = [];
let _acquiredResources: string[] = [];
let _exitHandlerRegistered = false;
let _renewalTimer: ReturnType<typeof setInterval> | null = null;

// Cached module references for synchronous use in the exit handler
let _resourceLockModule: any = null;

/**
 * Dynamically load resource-lock.js from the project's hooks lib.
 * Caches the module reference for the synchronous exit handler.
 * Returns null on failure (non-fatal).
 */
async function loadResourceLock(): Promise<any | null> {
  try {
    _resourceLockModule = await import(path.join(HOOKS_LIB, 'resource-lock.js'));
    return _resourceLockModule;
  } catch {
    return null;
  }
}

/**
 * Dynamically load session-signals.js from the project's hooks lib.
 * Returns null on failure (non-fatal).
 */
async function loadSignals(): Promise<any | null> {
  try {
    return await import(path.join(HOOKS_LIB, 'session-signals.js'));
  } catch {
    return null;
  }
}

/**
 * Register a process exit handler that releases locks synchronously.
 * better-sqlite3 is synchronous so this works in 'exit' handlers.
 */
function ensureExitHandler(): void {
  if (_exitHandlerRegistered) return;
  _exitHandlerRegistered = true;

  process.on('exit', () => {
    if (_renewalTimer !== null) {
      clearInterval(_renewalTimer);
      _renewalTimer = null;
    }
    if (_acquiredResources.length === 0) return;
    if (!_resourceLockModule) return;
    for (const resourceId of _acquiredResources) {
      try {
        _resourceLockModule.releaseResource(resourceId, CTO_AGENT_ID);
      } catch { /* best-effort */ }
    }
    _acquiredResources = [];
    _displacedHolders = [];
  });
}

/**
 * Force-acquire display and chrome-bridge locks before launching a CTO demo.
 * Displaced agents are re-enqueued and signaled to pause.
 *
 * Non-fatal: if resource-lock or session-signals modules are unavailable,
 * returns an empty result and the demo proceeds without lock integration.
 */
export async function preemptForCtoDashboardDemo(demoTitle: string): Promise<PreemptResult> {
  const result: PreemptResult = { resourcesAcquired: [], displacedHolders: [] };

  const resourceLock = await loadResourceLock();
  if (!resourceLock) return result;

  ensureExitHandler();

  const resources = ['display', 'chrome-bridge'];
  const lockTitle = `CTO Dashboard: ${demoTitle}`;

  for (const resourceId of resources) {
    try {
      const acquired = resourceLock.forceAcquireResource(
        resourceId, CTO_AGENT_ID, null, lockTitle, { ttlMinutes: 30, protectedBy: CTO_AGENT_ID },
      );
      if (acquired.acquired) {
        result.resourcesAcquired.push(resourceId);
        if (acquired.prev_holder) {
          // Deduplicate — same agent may hold both display and chrome-bridge
          const exists = result.displacedHolders.some(
            (h: DisplacedHolder) => h.agent_id === acquired.prev_holder.agent_id,
          );
          if (!exists) {
            result.displacedHolders.push(acquired.prev_holder);
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  // Update module state
  _acquiredResources = result.resourcesAcquired;
  _displacedHolders = result.displacedHolders;

  // Start heartbeat renewal timer — renew every 5 minutes to prevent TTL expiry
  if (result.resourcesAcquired.length > 0) {
    if (_renewalTimer !== null) {
      clearInterval(_renewalTimer);
    }
    _renewalTimer = setInterval(() => {
      for (const resourceId of _acquiredResources) {
        try {
          resourceLock.renewResource(resourceId, CTO_AGENT_ID);
        } catch { /* non-fatal */ }
      }
    }, 5 * 60 * 1000); // 5 minutes
  }

  // Signal displaced agents to pause
  if (result.displacedHolders.length > 0) {
    const signals = await loadSignals();
    if (signals) {
      for (const holder of result.displacedHolders) {
        try {
          signals.sendSignal({
            fromAgentId: CTO_AGENT_ID,
            fromAgentType: 'cto-dashboard',
            fromTaskTitle: 'CTO Dashboard Demo',
            toAgentId: holder.agent_id,
            toAgentType: 'unknown',
            tier: 'directive',
            message: `CTO is manually running a demo ("${demoTitle}"). The display and chrome-bridge resources have been preempted. PAUSE all display-dependent work (headed demos, chrome-bridge interactions, screen captures) immediately. You will receive a follow-up signal when the CTO demo finishes and you can resume.`,
            projectDir: PROJECT_DIR,
          });
        } catch { /* non-fatal */ }
      }
    }
  }

  return result;
}

/**
 * Release display and chrome-bridge locks after a CTO demo finishes.
 * The displaced agent is auto-promoted by the lock system and signaled to resume.
 */
export async function releaseCtoDashboardDemo(): Promise<void> {
  // Stop the heartbeat renewal timer
  if (_renewalTimer !== null) {
    clearInterval(_renewalTimer);
    _renewalTimer = null;
  }

  // Snapshot and clear state atomically to prevent double-release from concurrent calls
  const resourcesToRelease = _acquiredResources;
  const holdersToSignal = _displacedHolders;
  _acquiredResources = [];
  _displacedHolders = [];

  if (resourcesToRelease.length === 0) return;

  const resourceLock = await loadResourceLock();
  if (resourceLock) {
    for (const resourceId of resourcesToRelease) {
      try {
        resourceLock.releaseResource(resourceId, CTO_AGENT_ID);
      } catch { /* non-fatal */ }
    }
  }

  // Signal displaced agents they can resume
  if (holdersToSignal.length > 0) {
    const signals = await loadSignals();
    if (signals) {
      for (const holder of holdersToSignal) {
        try {
          signals.sendSignal({
            fromAgentId: CTO_AGENT_ID,
            fromAgentType: 'cto-dashboard',
            fromTaskTitle: 'CTO Dashboard Demo',
            toAgentId: holder.agent_id,
            toAgentType: 'unknown',
            tier: 'directive',
            message: 'CTO demo has finished. The display and chrome-bridge resources are now available. You may RESUME display-dependent work. If you were waiting for the display lock, it should now be re-acquired for you automatically.',
            projectDir: PROJECT_DIR,
          });
        } catch { /* non-fatal */ }
      }
    }
  }
}
