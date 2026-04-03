/**
 * Root App component — page routing, keyboard handler, layout.
 * Three pages: 1=Operations, 2=Details, 3=Analytics
 * Supports infinite scroll for completed sessions.
 */

import React, { useState, useMemo, useEffect } from 'react';
import { execFileSync } from 'child_process';
import { Box, useApp, useInput } from 'ink';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useClock } from './hooks/useClock.js';
import { useScrollState } from './hooks/useScrollState.js';
import { useDataPoller } from './hooks/useDataPoller.js';
import { Header } from './components/Header.js';
import { Footer } from './components/Footer.js';
import { Page1 } from './components/page1/Page1.js';
import { Page2 } from './components/page2/Page2.js';
import { Page3 } from './components/page3/Page3.js';
import { buildSelectableItems, findHomeIndex } from './components/page1/SessionList.js';

interface AppProps {
  mock: boolean;
}

export function App({ mock }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const now = useClock();
  const { data, loadMoreCompleted } = useDataPoller(3000, mock);
  const [page, setPage] = useState<1 | 2 | 3>(1);

  const selectableItems = useMemo(() => buildSelectableItems(data), [data]);
  const homeIndex = useMemo(() => findHomeIndex(data), [data]);

  const page1Scroll = useScrollState(homeIndex);
  const page2Scroll = useScrollState();
  const page3Scroll = useScrollState();

  useEffect(() => {
    page1Scroll.setItemCount(selectableItems.length);
    page1Scroll.setHomeIndex(homeIndex);
  }, [selectableItems.length, homeIndex, page1Scroll]);

  const bodyHeight = Math.max(5, rows - 2);

  useEffect(() => {
    page1Scroll.setVisibleHeight(bodyHeight);
  }, [bodyHeight, page1Scroll]);

  useEffect(() => {
    page2Scroll.setMaxScroll(100);
    page3Scroll.setMaxScroll(50);
  }, [page2Scroll, page3Scroll]);

  // Infinite scroll: load more completed sessions when near the bottom
  useEffect(() => {
    if (page !== 1) return;
    const nearEnd = page1Scroll.selectedIndex >= selectableItems.length - 3;
    if (nearEnd && selectableItems.length > 0) {
      loadMoreCompleted();
    }
  }, [page, page1Scroll.selectedIndex, selectableItems.length, loadMoreCompleted]);

  useInput((input, key) => {
    if (input === 'q') { exit(); return; }
    if (input === '1') { setPage(1); return; }
    if (input === '2') { setPage(2); return; }
    if (input === '3') { setPage(3); return; }

    if (input === 'h') {
      if (page === 1) page1Scroll.scrollToHome();
      else if (page === 2) page2Scroll.scrollToTop();
      else page3Scroll.scrollToTop();
      return;
    }

    if (key.upArrow) {
      if (page === 1) page1Scroll.selectPrev();
      else if (page === 2) page2Scroll.scrollUp();
      else page3Scroll.scrollUp();
      return;
    }
    if (key.downArrow) {
      if (page === 1) page1Scroll.selectNext();
      else if (page === 2) page2Scroll.scrollDown();
      else page3Scroll.scrollDown();
      return;
    }

    if (key.return && page === 1) {
      const selected = selectableItems[page1Scroll.selectedIndex];
      if (selected && selected.item.pid && selected.item.sessionId) {
        joinSession(selected.item);
      }
      return;
    }
  }, { isActive: process.stdin.isTTY === true });

  return (
    <Box flexDirection="column" height={rows}>
      <Header now={now} running={data.capacity.running} max={data.capacity.max} page={page} mock={mock} />

      {page === 1 && (
        <Page1
          data={data}
          selectedIndex={page1Scroll.selectedIndex}
          scrollOffset={page1Scroll.scrollOffset}
          width={columns}
          height={bodyHeight}
        />
      )}

      {page === 2 && (
        <Page2
          data={data.page2}
          infra={data.page3}
          scrollOffset={page2Scroll.scrollOffset}
          height={bodyHeight}
          width={columns}
        />
      )}

      {page === 3 && (
        <Page3
          data={data.pageAnalytics}
          scrollOffset={page3Scroll.scrollOffset}
          height={bodyHeight}
          width={columns}
        />
      )}

      <Footer page={page} />
    </Box>
  );
}

/** Join a session by killing headless PID and opening in Terminal.app */
function joinSession(item: { pid: number | null; sessionId: string | null }): void {
  if (!item.pid || !item.sessionId) return;
  try {
    process.kill(item.pid, 'SIGTERM');
  } catch { /* already dead */ }

  const projectDir = process.env['CLAUDE_PROJECT_DIR'] || process.cwd();
  const cmd = `cd "${projectDir}" && claude --resume "${item.sessionId}"`;
  try {
    execFileSync('osascript', ['-e', `tell application "Terminal"\ndo script "${cmd}"\nactivate\nend tell`], { timeout: 10000, stdio: 'pipe' });
  } catch { /* best effort */ }
}
