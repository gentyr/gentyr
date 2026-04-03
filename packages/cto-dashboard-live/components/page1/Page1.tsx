/**
 * Page 1: Operations — Two-column layout.
 * Left: selectable session list. Right: compact widgets + worklog.
 */

import React from 'react';
import { Box } from 'ink';
import { SessionList } from './SessionList.js';
import { RightPanel } from './RightPanel.js';
import type { LiveDashboardData } from '../../types.js';

interface Page1Props {
  data: LiveDashboardData;
  selectedIndex: number;
  scrollOffset: number;
  width: number;
  height: number;
}

export function Page1({ data, selectedIndex, scrollOffset, width, height }: Page1Props): React.ReactElement {
  const leftWidth = Math.floor(width / 2);
  const rightWidth = width - leftWidth - 1;

  return (
    <Box flexDirection="row" height={height}>
      <Box width={leftWidth}>
        <SessionList
          data={data}
          selectedIndex={selectedIndex}
          scrollOffset={scrollOffset}
          width={leftWidth}
          height={height}
        />
      </Box>
      <Box width={1} />
      <Box width={rightWidth}>
        <RightPanel data={data} width={rightWidth} height={height} />
      </Box>
    </Box>
  );
}
