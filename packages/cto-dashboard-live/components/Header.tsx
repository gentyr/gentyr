import React from 'react';
import { Box, Text } from 'ink';
import { formatTime } from '../utils/formatters.js';

interface HeaderProps {
  now: Date;
  running: number;
  max: number;
  mock: boolean;
}

export function Header({ now, running, max, mock }: HeaderProps): React.ReactElement {
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
    </Box>
  );
}
