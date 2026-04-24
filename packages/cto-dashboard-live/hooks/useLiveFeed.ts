/**
 * useLiveFeed — Reads feed entries from live-feed.db (written by the daemon)
 * and streaming state from live-feed-streaming.json.
 *
 * No LLM calls — this is a pure reader. The daemon handles generation.
 * Supports: initial history load, polling for new entries, load-more for scroll-up.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Page5Data, FeedMessage } from '../types.js';
import { getMockPage5Data } from '../mock-data.js';
import { readFeedEntries, readFeedStreamingState } from '../live-reader.js';

const POLL_NEW_INTERVAL_MS = 3000;    // check for new entries every 3s
const POLL_STREAM_INTERVAL_MS = 2000; // check streaming state every 2s

export function useLiveFeed(mock: boolean): Page5Data & { loadMore: () => void; hasMore: boolean } {
  const [messages, setMessages] = useState<FeedMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [lastGeneratedAt, setLastGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const maxIdRef = useRef(0);
  const minIdRef = useRef(Infinity);
  const initialLoadDone = useRef(false);

  // Initial load — newest 50 entries from DB
  useEffect(() => {
    if (mock || initialLoadDone.current) return;
    initialLoadDone.current = true;

    try {
      const { entries, hasMore: more } = readFeedEntries({ limit: 50 });
      if (entries.length > 0) {
        setMessages(entries);
        maxIdRef.current = Math.max(...entries.map(e => Number(e.id)));
        minIdRef.current = Math.min(...entries.map(e => Number(e.id)));
        setLastGeneratedAt(entries[entries.length - 1].timestamp);
      }
      setHasMore(more);
    } catch { /* */ }
  }, [mock]);

  // Poll for new entries (every 3s)
  useEffect(() => {
    if (mock) return;

    const poll = () => {
      try {
        const { entries } = readFeedEntries({ afterId: maxIdRef.current });
        if (entries.length > 0) {
          setMessages(prev => [...prev, ...entries]);
          maxIdRef.current = Math.max(...entries.map(e => Number(e.id)));
          if (minIdRef.current === Infinity) {
            minIdRef.current = Math.min(...entries.map(e => Number(e.id)));
          }
          setLastGeneratedAt(entries[entries.length - 1].timestamp);
          setError(null);
        }
      } catch { /* keep stale */ }
    };

    const id = setInterval(poll, POLL_NEW_INTERVAL_MS);
    return () => clearInterval(id);
  }, [mock]);

  // Poll streaming state (every 2s)
  useEffect(() => {
    if (mock) return;

    const poll = () => {
      try {
        const state = readFeedStreamingState();
        setStreamingText(state.text);
        setIsGenerating(state.isGenerating);
      } catch { /* */ }
    };

    // Immediate check
    poll();
    const id = setInterval(poll, POLL_STREAM_INTERVAL_MS);
    return () => clearInterval(id);
  }, [mock]);

  // Load more (scroll-up pagination)
  const loadMore = useCallback(() => {
    if (mock || !hasMore || minIdRef.current === Infinity) return;

    try {
      const { entries, hasMore: more } = readFeedEntries({ beforeId: minIdRef.current, limit: 50 });
      if (entries.length > 0) {
        setMessages(prev => [...entries, ...prev]);
        minIdRef.current = Math.min(...entries.map(e => Number(e.id)));
      }
      setHasMore(more);
    } catch { /* */ }
  }, [mock, hasMore]);

  if (mock) {
    return { ...getMockPage5Data(), loadMore: () => {}, hasMore: false };
  }

  return { messages, streamingText, isGenerating, lastGeneratedAt, error, loadMore, hasMore };
}
