/**
 * Polling hook for Page 2 data (demo scenarios + test files).
 * Only polls when the page is active; pauses otherwise.
 */

import { useState, useEffect } from 'react';
import type { Page2Data } from '../types.js';
import { getMockPage2Data } from '../mock-data.js';
import { readPage2Data } from '../live-reader.js';

const EMPTY: Page2Data = { scenarios: [], testFiles: [], environments: [] };

export function usePage2Data(intervalMs: number, mock: boolean, active: boolean): Page2Data {
  const [data, setData] = useState<Page2Data>(() => {
    if (!active) return mock ? getMockPage2Data() : EMPTY;
    return mock ? getMockPage2Data() : readPage2Data();
  });

  useEffect(() => {
    if (mock) {
      setData(getMockPage2Data());
      return;
    }
    if (!active) return;

    // Immediate read on activation
    try { setData(readPage2Data()); } catch { /* keep stale */ }

    const id = setInterval(() => {
      try { setData(readPage2Data()); } catch { /* keep stale */ }
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, mock, active]);

  return data;
}
