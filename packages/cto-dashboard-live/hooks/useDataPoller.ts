import { useState, useEffect, useCallback, useRef } from 'react';
import type { LiveDashboardData, SessionItem } from '../types.js';
import { getMockData } from '../mock-data.js';
import { readLiveData, readMoreCompleted } from '../live-reader.js';

interface DataPollerResult {
  data: LiveDashboardData;
  loadMoreCompleted: () => void;
  hasMoreCompleted: boolean;
}

export function useDataPoller(intervalMs: number, mock: boolean): DataPollerResult {
  const [data, setData] = useState<LiveDashboardData>(() => mock ? getMockData() : readLiveData());
  const [extraCompleted, setExtraCompleted] = useState<SessionItem[]>([]);
  const completedOffset = useRef(20);
  const loadingMore = useRef(false);
  const hasMoreRef = useRef(true);

  useEffect(() => {
    if (mock) return;
    const id = setInterval(() => {
      try {
        const fresh = readLiveData();
        if (extraCompleted.length > 0) {
          fresh.completedSessions = [...fresh.completedSessions, ...extraCompleted];
        }
        setData(fresh);
      } catch { /* keep stale */ }
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, mock, extraCompleted]);

  const loadMoreCompleted = useCallback(() => {
    if (mock || loadingMore.current || !hasMoreRef.current) return;
    loadingMore.current = true;
    try {
      const more = readMoreCompleted(completedOffset.current, 20);
      if (more.length === 0) {
        hasMoreRef.current = false;
      } else {
        completedOffset.current += more.length;
        setExtraCompleted(prev => [...prev, ...more]);
        setData(prev => ({
          ...prev,
          completedSessions: [...prev.completedSessions, ...more],
        }));
      }
    } catch { /* */ }
    finally { loadingMore.current = false; }
  }, [mock]);

  return { data, loadMoreCompleted, hasMoreCompleted: hasMoreRef.current };
}
