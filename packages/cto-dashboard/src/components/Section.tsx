/**
 * Section component with rounded corners (borderStyle: 'round')
 * Provides consistent container styling across the dashboard
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
}: SectionProps): React.ReactElement {
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
      {title && (
        <Box marginBottom={0}>
          <Text color={titleColor} bold>
            {title}
          </Text>
        </Box>
      )}
      {children}
    </Box>
  );
}
