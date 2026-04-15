/**
 * Polling hook for Page 4 data (specs).
 * Only polls when the page is active; pauses otherwise.
 */

import { useState, useEffect } from 'react';
import type { Page4Data } from '../types.js';
import { getMockPage4Data } from '../mock-data.js';
import { readPage4Data } from '../live-reader.js';

const EMPTY: Page4Data = { categories: [], suites: [], totalSpecs: 0, selectedSpecContent: null };

export function usePage4Data(intervalMs: number, mock: boolean, active: boolean, selectedSpecId: string | null): Page4Data {
  const [data, setData] = useState<Page4Data>(() => {
    if (!active) return mock ? getMockPage4Data() : EMPTY;
    return mock ? getMockPage4Data() : readPage4Data(selectedSpecId);
  });

  useEffect(() => {
    if (mock) {
      setData(getMockPage4Data());
      return;
    }
    if (!active) return;

    // Immediate read on activation
    try { setData(readPage4Data(selectedSpecId)); } catch { /* keep stale */ }

    const id = setInterval(() => {
      try { setData(readPage4Data(selectedSpecId)); } catch { /* keep stale */ }
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, mock, active, selectedSpecId]);

  return data;
}
