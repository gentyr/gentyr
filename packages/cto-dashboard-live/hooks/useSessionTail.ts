/**
 * Hook that tails a running agent's JSONL session file and
 * produces a live-updating list of ActivityEntry items.
 *
 * Uses fs.watch for near-instant updates with a 2s interval
 * fallback in case the watch event is not fired (e.g. network FS).
 *
 * Ring buffer: keeps at most MAX_ENTRIES entries to prevent
 * unbounded memory growth during long sessions.
 */

import { useState, useEffect, useRef } from 'react';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ActivityEntry } from '../types.js';
import { readSessionTail } from '../live-reader.js';

const MAX_ENTRIES = 200;

interface SessionTailResult {
  entries: ActivityEntry[];
  isConnected: boolean;
}

export function useSessionTail(agentId: string | null): SessionTailResult {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  // Track the last byte position so we only read NEW data on each tick.
  const lastPosition = useRef<number>(0);
  // Track the current agentId so we can reset state on change.
  const currentAgentId = useRef<string | null>(null);
  // The fs.Watcher handle for cleanup.
  const watcherRef = useRef<fs.FSWatcher | null>(null);
  // Interval handle for the 2s fallback.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Cleanup helper — stops both the watcher and interval.
    function cleanup() {
      if (watcherRef.current) {
        try { watcherRef.current.close(); } catch { /* */ }
        watcherRef.current = null;
      }
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    if (agentId === null) {
      cleanup();
      setEntries([]);
      setIsConnected(false);
      currentAgentId.current = null;
      lastPosition.current = 0;
      return cleanup;
    }

    // Reset when the selected agent changes.
    if (agentId !== currentAgentId.current) {
      cleanup();
      setEntries([]);
      setIsConnected(false);
      currentAgentId.current = agentId;
      lastPosition.current = 0;
    }

    // Do an initial read to bootstrap the buffer with the tail of the file.
    function doRead() {
      if (!currentAgentId.current) return;
      const { entries: newEntries, newPosition } = readSessionTail(
        currentAgentId.current,
        lastPosition.current,
      );
      if (newPosition > 0) {
        setIsConnected(true);
      }
      lastPosition.current = newPosition;
      if (newEntries.length > 0) {
        setEntries(prev => {
          const combined = [...prev, ...newEntries];
          // Apply ring buffer limit.
          return combined.length > MAX_ENTRIES
            ? combined.slice(combined.length - MAX_ENTRIES)
            : combined;
        });
      }
    }

    // Perform initial load so the screen isn't blank while waiting.
    doRead();

    // Try to set up an fs.watch watcher on the session file.
    // We re-resolve the file path on each event in case it was recreated.
    // If the file doesn't exist yet, we'll keep trying via the interval.
    function tryWatch() {
      if (!currentAgentId.current) return;
      // Resolve file path by doing a one-off read attempt.
      try {
        const { newPosition } = readSessionTail(currentAgentId.current, 0);
        if (newPosition === 0) return; // File not found yet.

        // Find the actual file path — we need it for fs.watch.
        // Locate the session directory using the same logic as live-reader.ts.
        const PROJECT_DIR = process.env['CLAUDE_PROJECT_DIR'] || process.cwd();
        const encoded = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-');
        const base = path.join(os.homedir(), '.claude', 'projects');
        let sessionDir: string | null = null;
        for (const variant of [encoded, encoded.replace(/^-/, '')]) {
          const p = path.join(base, variant);
          if (fs.existsSync(p)) { sessionDir = p; break; }
        }
        if (!sessionDir) return;

        const marker = `[AGENT:${currentAgentId.current}]`;
        let filePath: string | null = null;
        for (const f of fs.readdirSync(sessionDir)) {
          if (!f.endsWith('.jsonl')) continue;
          const fp = path.join(sessionDir, f);
          const fdh = fs.openSync(fp, 'r');
          const buf = Buffer.alloc(2048);
          const n = fs.readSync(fdh, buf, 0, 2048, 0);
          fs.closeSync(fdh);
          if (buf.toString('utf8', 0, n).includes(marker)) { filePath = fp; break; }
        }
        if (!filePath) return;

        if (watcherRef.current) return; // already watching
        watcherRef.current = fs.watch(filePath, () => {
          doRead();
        });
      } catch { /* best-effort */ }
    }

    tryWatch();

    // 2s fallback interval — handles the case where fs.watch fails or the
    // file doesn't exist yet when the hook first mounts.
    intervalRef.current = setInterval(() => {
      doRead();
      if (!watcherRef.current) tryWatch();
    }, 2000);

    return cleanup;
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { entries, isConnected };
}
