import React from 'react';
import { Box, Text } from 'ink';
import { formatTime } from '../utils/formatters.js';
import type { PageId } from '../types.js';

interface HeaderProps {
  now: Date;
  running: number;
  max: number;
  mock: boolean;
  activePage: PageId;
}

export function Header({ now, running, max, mock, activePage }: HeaderProps): React.ReactElement {
  return (
    <Box>
      <Text bold> GENTYR LIVE </Text>
      <Text dimColor>{'|'} </Text>
      <Text>{formatTime(now)}</Text>
      <Text dimColor> {'|'} </Text>
      <Text bold>{running}</Text>
      <Text dimColor>/{max} sessions</Text>
      {mock && (
        <>
          <Text dimColor> {'|'} </Text>
          <Text bold>MOCK</Text>
        </>
      )}
      <Text dimColor> {'|'} </Text>
      <Text {...(activePage === 1 ? { bold: true, inverse: true } : { dimColor: true })}>{' 1 Sessions '}</Text>
      <Text> </Text>
      <Text {...(activePage === 2 ? { bold: true, inverse: true } : { dimColor: true })}>{' 2 Demos & Tests '}</Text>
    </Box>
  );
}
