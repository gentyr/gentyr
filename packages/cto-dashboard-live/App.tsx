/**
 * Root App component — multi-page live CTO dashboard.
 * Page 1: Session observer (session list + activity stream)
 * Page 2: Demos & Tests (scenario list + test file list + output)
 * Page 3: Plans (plan list + phase/task tree + recent changes)
 * Page 4: Specs (spec navigator + spec viewer)
 * Page 5: Live AI Commentary Feed (60s polling, streaming claude -p)
 */

import React, { useState, useEffect } from 'react';
import { Box, useApp, useInput } from 'ink';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useClock } from './hooks/useClock.js';
import { useDataPoller } from './hooks/useDataPoller.js';
import { usePage2Data } from './hooks/usePage2Data.js';
import { usePage3Data } from './hooks/usePage3Data.js';
import { usePage4Data } from './hooks/usePage4Data.js';
import { useLiveFeed } from './hooks/useLiveFeed.js';
import { Header } from './components/Header.js';
import { Footer } from './components/Footer.js';
import { ObserveView } from './components/ObserveView.js';
import { ReleaseBanner } from './components/ReleaseBanner.js';
import { DemosTestsView } from './components/DemosTestsView.js';
import { PlansView } from './components/PlansView.js';
import { SpecsView } from './components/SpecsView.js';
import { CommentaryView } from './components/CommentaryView.js';
import { readReleaseStatus } from './live-reader.js';
import type { PageId, ReleaseStatus } from './types.js';

interface AppProps {
  mock: boolean;
}

export function App({ mock }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const now = useClock();
  const { data } = useDataPoller(3000, mock);
  const [activePage, setActivePage] = useState<PageId>(1);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [selectedSpecId, setSelectedSpecId] = useState<string | null>(null);
  const page2Data = usePage2Data(10000, mock, activePage === 2);
  const page3Data = usePage3Data(10000, mock, activePage === 3, selectedPlanId);
  const page4Data = usePage4Data(10000, mock, activePage === 4, selectedSpecId);
  const page5Data = useLiveFeed(mock);

  // Release status polling (10s interval, Page 1 only)
  const [releaseStatus, setReleaseStatus] = useState<ReleaseStatus | null>(null);
  useEffect(() => {
    if (mock) return;
    // Initial read
    try { setReleaseStatus(readReleaseStatus()); } catch { /* */ }
    const id = setInterval(() => {
      try { setReleaseStatus(readReleaseStatus()); } catch { /* */ }
    }, 10000);
    return () => clearInterval(id);
  }, [mock]);

  const releaseBannerHeight = releaseStatus && activePage === 1 ? 4 : 0;
  const bodyHeight = Math.max(5, rows - 2 - releaseBannerHeight);

  useInput((input, key) => {
    if (input === 'q') { exit(); return; }
    if (key.tab) { setActivePage(prev => (prev % 5 + 1) as PageId); return; }
    if (input === '1') { setActivePage(1); return; }
    if (input === '2') { setActivePage(2); return; }
    if (input === '3') { setActivePage(3); return; }
    if (input === '4') { setActivePage(4); return; }
    if (input === '5') { setActivePage(5); return; }
  }, { isActive: process.stdin.isTTY === true });

  return (
    <Box flexDirection="column" height={rows}>
      <Header now={now} running={data.capacity.running} max={data.capacity.max} mock={mock} activePage={activePage} />

      {activePage === 1 && releaseStatus && (
        <ReleaseBanner release={releaseStatus} width={columns} />
      )}
      {activePage === 1 && (
        <ObserveView
          data={data}
          bodyHeight={bodyHeight}
          bodyWidth={columns}
          isActive={activePage === 1}
        />
      )}
      {activePage === 2 && (
        <DemosTestsView
          data={page2Data}
          bodyHeight={bodyHeight}
          bodyWidth={columns}
          isActive={activePage === 2}
        />
      )}
      {activePage === 3 && (
        <PlansView
          data={page3Data}
          bodyHeight={bodyHeight}
          bodyWidth={columns}
          isActive={activePage === 3}
          onSelectPlan={setSelectedPlanId}
        />
      )}
      {activePage === 4 && (
        <SpecsView
          data={page4Data}
          bodyHeight={bodyHeight}
          bodyWidth={columns}
          isActive={activePage === 4}
          onSelectSpec={setSelectedSpecId}
        />
      )}
      {activePage === 5 && (
        <CommentaryView
          data={page5Data}
          bodyHeight={bodyHeight}
          bodyWidth={columns}
          isActive={activePage === 5}
        />
      )}

      <Footer activePage={activePage} />
    </Box>
  );
}
