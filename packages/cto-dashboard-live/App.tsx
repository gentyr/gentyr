/**
 * Root App component — single-page live session observer.
 * Renders Header, the observe view (session list + activity stream), and Footer.
 */

import React from 'react';
import { Box, useApp, useInput } from 'ink';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useClock } from './hooks/useClock.js';
import { useDataPoller } from './hooks/useDataPoller.js';
import { Header } from './components/Header.js';
import { Footer } from './components/Footer.js';
import { ObserveView } from './components/ObserveView.js';

interface AppProps {
  mock: boolean;
}

export function App({ mock }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const now = useClock();
  const { data } = useDataPoller(3000, mock);

  const bodyHeight = Math.max(5, rows - 2);

  useInput((input, _key) => {
    if (input === 'q') { exit(); return; }
  }, { isActive: process.stdin.isTTY === true });

  return (
    <Box flexDirection="column" height={rows}>
      <Header now={now} running={data.capacity.running} max={data.capacity.max} mock={mock} />

      <ObserveView
        data={data}
        bodyHeight={bodyHeight}
        bodyWidth={columns}
      />

      <Footer />
    </Box>
  );
}
