/**
 * Hook that tails a running agent's JSONL session file and
 * produces a live-updating list of ActivityEntry items.
 *
 * Uses fs.watch for near-instant updates with a 2s interval fallback.
 * Ring buffer: keeps at most MAX_ENTRIES entries.
 * On session death: keeps entries and appends a session_end marker.
 * Exposes resetSessionEnd() to re-activate tailing after an inline resume.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import * as fs from 'fs';
import type { ActivityEntry } from '../types.js';
import { readSessionTail, findSessionFile } from '../live-reader.js';

const MAX_ENTRIES = 200;
const STALE_READ_THRESHOLD = 5;

interface SessionTailResult {
  entries: ActivityEntry[];
  isConnected: boolean;
  /** Re-activate tailing after resuming a dead session. Clears session_end state and restarts the watcher. */
  resetSessionEnd: () => void;
}

export function useSessionTail(agentId: string | null, worktreePath?: string | null): SessionTailResult {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  const lastPosition = useRef<number>(0);
  const currentAgentId = useRef<string | null>(null);
  const currentWorktreePath = useRef<string | null | undefined>(undefined);
  const watcherRef = useRef<fs.FSWatcher | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const staleReadCount = useRef<number>(0);
  const sessionEndedRef = useRef<boolean>(false);
  // Incremented to force the effect to re-run after resetSessionEnd
  const [restartToken, setRestartToken] = useState(0);

  const resetSessionEnd = useCallback(() => {
    sessionEndedRef.current = false;
    staleReadCount.current = 0;
    // Trigger the effect to re-run, which re-creates the watcher and interval
    setRestartToken(t => t + 1);
  }, []);

  useEffect(() => {
    function cleanup() {
      if (watcherRef.current) { try { watcherRef.current.close(); } catch { /* */ } watcherRef.current = null; }
      if (intervalRef.current !== null) { clearInterval(intervalRef.current); intervalRef.current = null; }
    }

    if (agentId === null) {
      cleanup();
      // Keep entries visible for the last selected session (don't clear)
      setIsConnected(false);
      currentAgentId.current = null;
      lastPosition.current = 0;
      staleReadCount.current = 0;
      sessionEndedRef.current = false;
      return cleanup;
    }

    // Only clear when switching to a DIFFERENT session
    if (agentId !== currentAgentId.current || worktreePath !== currentWorktreePath.current) {
      cleanup();
      setEntries([]);
      setIsConnected(false);
      currentAgentId.current = agentId;
      currentWorktreePath.current = worktreePath;
      lastPosition.current = 0;
      staleReadCount.current = 0;
      sessionEndedRef.current = false;
    }

    function doRead() {
      if (!currentAgentId.current || sessionEndedRef.current) return;
      const { entries: newEntries, newPosition } = readSessionTail(currentAgentId.current, lastPosition.current, currentWorktreePath.current);
      if (newPosition > 0) setIsConnected(true);
      if (newEntries.length === 0 && newPosition === lastPosition.current) staleReadCount.current++;
      else staleReadCount.current = 0;
      lastPosition.current = newPosition;
      if (newEntries.length > 0) {
        setEntries(prev => {
          const combined = [...prev, ...newEntries];
          return combined.length > MAX_ENTRIES ? combined.slice(combined.length - MAX_ENTRIES) : combined;
        });
      }
      // Detect session end: no new data for several reads + file stale 30s
      if (staleReadCount.current >= STALE_READ_THRESHOLD && !sessionEndedRef.current) {
        const file = findSessionFile(currentAgentId.current, currentWorktreePath.current);
        if (file) {
          try {
            const stat = fs.statSync(file);
            if (Date.now() - stat.mtimeMs > 120000) {
              sessionEndedRef.current = true;
              setEntries(prev => [...prev, { type: 'session_end' as const, timestamp: new Date().toISOString(), text: 'Session ended' }]);
              cleanup();
            }
          } catch { /* */ }
        }
      }
    }

    doRead();

    function tryWatch() {
      if (!currentAgentId.current) return;
      try {
        const { newPosition } = readSessionTail(currentAgentId.current, 0, currentWorktreePath.current);
        if (newPosition === 0) return;
        const filePath = findSessionFile(currentAgentId.current, currentWorktreePath.current);
        if (!filePath || watcherRef.current) return;
        watcherRef.current = fs.watch(filePath, () => { doRead(); });
      } catch { /* */ }
    }

    tryWatch();
    intervalRef.current = setInterval(() => { doRead(); if (!watcherRef.current) tryWatch(); }, 2000);
    return cleanup;
  }, [agentId, worktreePath, restartToken]); // eslint-disable-line react-hooks/exhaustive-deps

  return { entries, isConnected, resetSessionEnd };
}
