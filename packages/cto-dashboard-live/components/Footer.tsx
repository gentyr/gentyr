import React from 'react';
import { Box, Text } from 'ink';

export function Footer(): React.ReactElement {
  return (
    <Box>
      <Text dimColor>
        {' '}<Text bold inverse>{' \u2191\u2193 '}</Text> select
        {'  '}<Text bold inverse>{' \u23CE '}</Text> message
        {'  '}<Text bold inverse>{' [ ] '}</Text> summaries
        {'  '}<Text bold inverse>{' q '}</Text> quit{' '}
      </Text>
    </Box>
  );
}
