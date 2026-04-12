/**
 * Root App component — multi-page live CTO dashboard.
 * Page 1: Session observer (session list + activity stream)
 * Page 2: Demos & Tests (scenario list + test file list + output)
 */

import React, { useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useClock } from './hooks/useClock.js';
import { useDataPoller } from './hooks/useDataPoller.js';
import { usePage2Data } from './hooks/usePage2Data.js';
import { Header } from './components/Header.js';
import { Footer } from './components/Footer.js';
import { ObserveView } from './components/ObserveView.js';
import { DemosTestsView } from './components/DemosTestsView.js';
import type { PageId } from './types.js';

interface AppProps {
  mock: boolean;
}

export function App({ mock }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const now = useClock();
  const { data } = useDataPoller(3000, mock);
  const [activePage, setActivePage] = useState<PageId>(1);
  const page2Data = usePage2Data(10000, mock, activePage === 2);

  const bodyHeight = Math.max(5, rows - 2);

  useInput((input, key) => {
    if (input === 'q') { exit(); return; }
    if (key.tab) { setActivePage(prev => prev === 1 ? 2 : 1); return; }
    if (input === '1') { setActivePage(1); return; }
    if (input === '2') { setActivePage(2); return; }
  }, { isActive: process.stdin.isTTY === true });

  return (
    <Box flexDirection="column" height={rows}>
      <Header now={now} running={data.capacity.running} max={data.capacity.max} mock={mock} activePage={activePage} />

      {activePage === 1 ? (
        <ObserveView
          data={data}
          bodyHeight={bodyHeight}
          bodyWidth={columns}
          isActive={activePage === 1}
        />
      ) : (
        <DemosTestsView
          data={page2Data}
          bodyHeight={bodyHeight}
          bodyWidth={columns}
          isActive={activePage === 2}
        />
      )}

      <Footer activePage={activePage} />
    </Box>
  );
}
