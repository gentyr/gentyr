import React from 'react';
import { Box, Text } from 'ink';
import { formatTime } from '../utils/formatters.js';

interface HeaderProps {
  now: Date;
  running: number;
  max: number;
  page: 1 | 2 | 3;
  mock: boolean;
}

const PAGE_LABELS: Record<number, string> = { 1: 'Operations', 2: 'Details', 3: 'Analytics' };

export function Header({ now, running, max, page, mock }: HeaderProps): React.ReactElement {
  return (
    <Box>
      <Text bold> GENTYR LIVE </Text>
      <Text dimColor>{'│'} </Text>
      <Text>{formatTime(now)}</Text>
      <Text dimColor> {'│'} </Text>
      <Text bold>{running}</Text>
      <Text dimColor>/{max} sessions</Text>
      <Text dimColor> {'│'} </Text>
      {[1, 2, 3].map(p => (
        <React.Fragment key={p}>
          {p === page ? (
            <Text bold inverse> {p} </Text>
          ) : (
            <Text dimColor> {p} </Text>
          )}
        </React.Fragment>
      ))}
      <Text dimColor> {PAGE_LABELS[page]}</Text>
      {mock && (
        <>
          <Text dimColor> {'│'} </Text>
          <Text bold>MOCK</Text>
        </>
      )}
    </Box>
  );
}
