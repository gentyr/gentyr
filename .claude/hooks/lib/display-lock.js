/**
 * Display Lock — backward-compatibility shim.
 * All functionality has been moved to resource-lock.js (shared resource registry).
 *
 * This file re-exports the display-lock API from resource-lock.js so that existing
 * callers (session-reaper, session-queue, playwright MCP server, etc.) continue to
 * work without modification.
 *
 * @module lib/display-lock
 * @see lib/resource-lock
 */
export {
  acquireDisplayLock,
  releaseDisplayLock,
  renewDisplayLock,
  getDisplayLockStatus,
  checkAndExpireLock,
  removeFromDisplayQueue,
} from './resource-lock.js';
