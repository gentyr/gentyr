/**
 * Polling hook for Page 3 data (plans).
 * Only polls when the page is active; pauses otherwise.
 */

import { useState, useEffect } from 'react';
import type { Page3Data } from '../types.js';
import { getMockPage3Data } from '../mock-data.js';
import { readPage3Data } from '../live-reader.js';

const EMPTY: Page3Data = { plans: [], planDetail: null, recentChanges: [] };

export function usePage3Data(intervalMs: number, mock: boolean, active: boolean, selectedPlanId: string | null): Page3Data {
  const [data, setData] = useState<Page3Data>(() => {
    if (!active) return mock ? getMockPage3Data() : EMPTY;
    return mock ? getMockPage3Data() : readPage3Data(selectedPlanId);
  });

  useEffect(() => {
    if (mock) {
      setData(getMockPage3Data());
      return;
    }
    if (!active) return;

    // Immediate read on activation
    try { setData(readPage3Data(selectedPlanId)); } catch { /* keep stale */ }

    const id = setInterval(() => {
      try { setData(readPage3Data(selectedPlanId)); } catch { /* keep stale */ }
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, mock, active, selectedPlanId]);

  return data;
}
