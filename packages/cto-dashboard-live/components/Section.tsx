/**
 * Section component with rounded corners and embedded title.
 * Monochrome — white borders, white text.
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface SectionProps {
  title?: string;
  children: React.ReactNode;
  width?: number | string;
  minWidth?: number;
  flexGrow?: number;
  paddingX?: number;
  paddingY?: number;
  tip?: string;
}

export function Section({
  title,
  children,
  width,
  minWidth,
  flexGrow,
  paddingX = 1,
  paddingY = 0,
  tip,
}: SectionProps): React.ReactElement {
  if (title) {
    const termWidth = typeof width === 'number' ? width : (process.stdout.columns || 80);
    const overhead = 5; // "╭─ " + " " + "╮"
    const tipStr = tip ? `  ${tip} ` : '';
    const fillWidth = Math.max(1, termWidth - title.length - tipStr.length - overhead);

    return (
      <Box flexDirection="column" width={width} minWidth={minWidth} flexGrow={flexGrow}>
        <Text color="white">
          {'\u256D\u2500 '}<Text bold>{title}</Text>{' ' + '\u2500'.repeat(fillWidth)}{tip ? <Text dimColor>{tipStr}</Text> : ''}{'\u256E'}
        </Text>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderTop={false}
          borderColor="white"
          width="100%"
          flexGrow={1}
          paddingX={paddingX}
          paddingY={paddingY}
        >
          {children}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="white"
      width={width}
      minWidth={minWidth}
      flexGrow={flexGrow}
      paddingX={paddingX}
      paddingY={paddingY}
    >
      {children}
    </Box>
  );
}
