import React from 'react';
import { Box, Text } from 'ink';

interface FooterProps {
  page: 1 | 2 | 3 | 4;
}

export function Footer({ page }: FooterProps): React.ReactElement {
  return (
    <Box justifyContent="space-between">
      <Box>
        {page === 1 ? (
          <Text dimColor>
            {' '}<Text bold inverse>{' \u2191\u2193 '}</Text> select  <Text bold inverse>{' \u23CE '}</Text> join  <Text bold inverse>{' h '}</Text> home
          </Text>
        ) : page === 4 ? (
          <Text dimColor>
            {' '}<Text bold inverse>{' \u2191\u2193 '}</Text> select session  <Text bold inverse>{' s '}</Text> signal  <Text bold inverse>{' 1-3 '}</Text> other pages
          </Text>
        ) : (
          <Text dimColor>
            {' '}<Text bold inverse>{' \u2191\u2193 '}</Text> scroll  <Text bold inverse>{' h '}</Text> top
          </Text>
        )}
      </Box>
      <Box>
        <Text dimColor>
          <Text bold inverse>{' 1 '}</Text> Ops <Text bold inverse>{' 2 '}</Text> Detail <Text bold inverse>{' 3 '}</Text> Analytics <Text bold inverse>{' 4 '}</Text> Observe  <Text bold inverse>{' q '}</Text> quit{' '}
        </Text>
      </Box>
    </Box>
  );
}
