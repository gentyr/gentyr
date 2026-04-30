/**
 * Async context propagation for request-scoped logging.
 *
 * Uses AsyncLocalStorage to thread requestId, userId, and custom
 * context fields through async call chains without explicit parameter passing.
 *
 * Usage:
 *   import { withContext, getContext } from '@my-project/logger';
 *
 *   // In middleware:
 *   app.use((req, res, next) => {
 *     withContext({ requestId: req.headers['x-request-id'] }, next);
 *   });
 *
 *   // Anywhere downstream:
 *   const ctx = getContext(); // { requestId: 'abc-123' }
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  requestId?: string;
  userId?: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Run a function within a logging context. Works for both sync and async functions. */
export function withContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Get the current logging context (or empty object if none). */
export function getContext(): LogContext {
  return storage.getStore() ?? {};
}

/** Extend the current context with additional fields. */
export function extendContext(extra: Partial<LogContext>): void {
  const current = storage.getStore();
  if (current) {
    Object.assign(current, extra);
  }
}
