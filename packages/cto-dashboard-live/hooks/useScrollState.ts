import { useState, useCallback } from 'react';

export interface ScrollState {
  selectedIndex: number;
  scrollOffset: number;
  selectNext: () => void;
  selectPrev: () => void;
  scrollToHome: () => void;
  setItemCount: (count: number) => void;
  setVisibleHeight: (height: number) => void;
  setHomeIndex: (index: number) => void;
  /** For pages 2-3 (no selection, just scroll) */
  scrollDown: () => void;
  scrollUp: () => void;
  scrollToTop: () => void;
  setMaxScroll: (max: number) => void;
}

export function useScrollState(initialIndex = 0): ScrollState {
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [itemCount, setItemCount] = useState(0);
  const [visibleHeight, setVisibleHeight] = useState(30);
  const [homeIndex, setHomeIndex] = useState(0);
  const [maxScroll, setMaxScroll] = useState(0);

  const ensureVisible = useCallback((index: number, currentOffset: number): number => {
    if (index < currentOffset) return index;
    if (index >= currentOffset + visibleHeight) return index - visibleHeight + 1;
    return currentOffset;
  }, [visibleHeight]);

  const selectNext = useCallback(() => {
    setSelectedIndex(prev => {
      const next = Math.min(prev + 1, Math.max(0, itemCount - 1));
      setScrollOffset(cur => ensureVisible(next, cur));
      return next;
    });
  }, [itemCount, ensureVisible]);

  const selectPrev = useCallback(() => {
    setSelectedIndex(prev => {
      const next = Math.max(prev - 1, 0);
      setScrollOffset(cur => ensureVisible(next, cur));
      return next;
    });
  }, [ensureVisible]);

  const scrollToHome = useCallback(() => {
    setSelectedIndex(homeIndex);
    setScrollOffset(homeIndex);
  }, [homeIndex]);

  const scrollDown = useCallback(() => {
    setScrollOffset(prev => Math.min(prev + 1, maxScroll));
  }, [maxScroll]);

  const scrollUp = useCallback(() => {
    setScrollOffset(prev => Math.max(prev - 1, 0));
  }, []);

  const scrollToTop = useCallback(() => {
    setScrollOffset(0);
  }, []);

  return {
    selectedIndex,
    scrollOffset,
    selectNext,
    selectPrev,
    scrollToHome,
    setItemCount,
    setVisibleHeight,
    setHomeIndex,
    scrollDown,
    scrollUp,
    scrollToTop,
    setMaxScroll,
  };
}
