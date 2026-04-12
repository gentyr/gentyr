import React from 'react';
import { Box, Text } from 'ink';
import type { PageId } from '../types.js';

interface FooterProps {
  activePage: PageId;
}

export function Footer({ activePage }: FooterProps): React.ReactElement {
  if (activePage === 2) {
    return (
      <Box>
        <Text dimColor>
          {' '}<Text bold inverse>{' \u2191\u2193 '}</Text> select
          {'  '}<Text bold inverse>{' \u2190\u2192 '}</Text> panel
          {'  '}<Text bold inverse>{' \u23CE '}</Text> run
          {'  '}<Text bold inverse>{' s '}</Text> stop
          {'  '}<Text bold inverse>{' Tab '}</Text> page
          {'  '}<Text bold inverse>{' q '}</Text> quit{' '}
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text dimColor>
        {' '}<Text bold inverse>{' \u2191\u2193 '}</Text> select
        {'  '}<Text bold inverse>{' \u23CE '}</Text> message
        {'  '}<Text bold inverse>{' [ ] '}</Text> summaries
        {'  '}<Text bold inverse>{' Tab '}</Text> page
        {'  '}<Text bold inverse>{' q '}</Text> quit{' '}
      </Text>
    </Box>
  );
}
