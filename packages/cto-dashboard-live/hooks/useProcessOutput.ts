/**
 * Hook that tails a plain text output file and returns the latest lines.
 * Used for tracking demo/test process output on Page 2.
 */

import { useState, useEffect, useRef } from 'react';
import * as fs from 'fs';
import { readProcessOutput } from '../live-reader.js';

const MAX_LINES = 500;

interface ProcessOutputResult {
  lines: string[];
}

export function useProcessOutput(outputFile: string | null): ProcessOutputResult {
  const [lines, setLines] = useState<string[]>([]);
  const lastPosition = useRef<number>(0);
  const currentFile = useRef<string | null>(null);
  const watcherRef = useRef<fs.FSWatcher | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    function cleanup() {
      if (watcherRef.current) { try { watcherRef.current.close(); } catch { /* */ } watcherRef.current = null; }
      if (intervalRef.current !== null) { clearInterval(intervalRef.current); intervalRef.current = null; }
    }

    if (!outputFile) {
      cleanup();
      currentFile.current = null;
      lastPosition.current = 0;
      return cleanup;
    }

    if (outputFile !== currentFile.current) {
      cleanup();
      setLines([]);
      currentFile.current = outputFile;
      lastPosition.current = 0;
    }

    function doRead() {
      if (!currentFile.current) return;
      const { text, newPosition } = readProcessOutput(currentFile.current, lastPosition.current);
      lastPosition.current = newPosition;
      if (text.length > 0) {
        const newLines = text.split('\n').filter(l => l.length > 0);
        if (newLines.length > 0) {
          setLines(prev => {
            const combined = [...prev, ...newLines];
            return combined.length > MAX_LINES ? combined.slice(combined.length - MAX_LINES) : combined;
          });
        }
      }
    }

    doRead();

    // Try to watch the file for instant updates
    try {
      if (fs.existsSync(outputFile)) {
        watcherRef.current = fs.watch(outputFile, () => { doRead(); });
      }
    } catch { /* */ }

    // Fallback polling at 1s
    intervalRef.current = setInterval(() => {
      doRead();
      if (!watcherRef.current && currentFile.current && fs.existsSync(currentFile.current)) {
        try { watcherRef.current = fs.watch(currentFile.current, () => { doRead(); }); } catch { /* */ }
      }
    }, 1000);

    return cleanup;
  }, [outputFile]);

  return { lines };
}
