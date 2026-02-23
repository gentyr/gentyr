/**
 * Section component with rounded corners (borderStyle: 'round')
 * Provides consistent container styling across the dashboard.
 *
 * Title is rendered inline in the top border: ╭─ TITLE ──────╮
 * Uses borderTop={false} and a custom top line to achieve this.
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
  borderColor?: string;
  titleColor?: string;
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
  borderColor = 'gray',
  titleColor = 'cyan',
  tip,
}: SectionProps): React.ReactElement {
  if (title) {
    // Compute fill width for the top border line
    // Terminal width minus: ╭─ (2) + space (1) + title + space (1) + ─...─╮ (1)
    const termWidth = typeof width === 'number' ? width : (process.stdout.columns || 80);
    const overhead = 5; // "╭─ " (3) + " " (1) + "╮" (1)
    const fillWidth = Math.max(1, termWidth - title.length - overhead);

    return (
      <Box flexDirection="column" width={width} minWidth={minWidth} flexGrow={flexGrow}>
        {/* Custom top border with embedded title */}
        <Text color={borderColor}>
          {'\u256D\u2500 '}<Text color={titleColor} bold>{title}</Text>{' ' + '\u2500'.repeat(fillWidth) + '\u256E'}
        </Text>
        {/* Box with no top border — left/right/bottom still render */}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderTop={false}
          borderColor={borderColor}
          width="100%"
          flexGrow={1}
          paddingX={paddingX}
          paddingY={paddingY}
        >
          {children}
          {tip && (
            <Box paddingX={1}>
              <Text color="gray" dimColor>Tip: {tip}</Text>
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      width={width}
      minWidth={minWidth}
      flexGrow={flexGrow}
      paddingX={paddingX}
      paddingY={paddingY}
    >
      {children}
      {tip && (
        <Box paddingX={1}>
          <Text color="gray" dimColor>Tip: {tip}</Text>
        </Box>
      )}
    </Box>
  );
}
