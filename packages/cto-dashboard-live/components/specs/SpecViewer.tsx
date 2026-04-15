/**
 * SpecViewer — right panel for Page 4.
 * Renders spec markdown with light formatting.
 * Scrollable via scrollOffset.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { truncate } from '../../utils/formatters.js';

interface SpecViewerProps {
  content: string | null;
  scrollOffset: number;
  height: number;
  width: number;
}

type LineType = 'h1' | 'h2' | 'h3' | 'body' | 'code' | 'blank';

interface ParsedLine {
  type: LineType;
  text: string;
  indented: boolean;
}

function parseLine(raw: string): ParsedLine {
  if (raw.startsWith('# '))  return { type: 'h1',   text: raw.slice(2).trim(),  indented: false };
  if (raw.startsWith('## ')) return { type: 'h2',   text: raw.slice(3).trim(),  indented: false };
  if (raw.startsWith('### '))return { type: 'h3',   text: raw.slice(4).trim(),  indented: false };
  if (raw.startsWith('```') || raw.startsWith('    ')) return { type: 'code', text: raw, indented: false };
  if (raw.trim() === '')     return { type: 'blank', text: '',                   indented: false };
  return { type: 'body', text: raw, indented: raw.startsWith(' ') };
}

/** Strip **bold** markers and backticks for display */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function LineRenderer({ line, width }: { line: ParsedLine; width: number }): React.ReactElement {
  const maxWidth = Math.max(4, width);

  switch (line.type) {
    case 'h1':
      return (
        <Box height={1} overflow="hidden">
          <Text bold color="white">{truncate(line.text, maxWidth)}</Text>
        </Box>
      );
    case 'h2':
      return (
        <Box height={1} overflow="hidden">
          <Text bold>{truncate(line.text, maxWidth)}</Text>
        </Box>
      );
    case 'h3':
      return (
        <Box height={1} overflow="hidden">
          <Text bold dimColor>{truncate(line.text, maxWidth)}</Text>
        </Box>
      );
    case 'code':
      return (
        <Box height={1} overflow="hidden">
          <Text dimColor>{truncate(line.text, maxWidth)}</Text>
        </Box>
      );
    case 'blank':
      return <Box height={1}><Text> </Text></Box>;
    default:
      return (
        <Box height={1} overflow="hidden">
          <Text>{truncate(stripMarkdown(line.text), maxWidth)}</Text>
        </Box>
      );
  }
}

export function SpecViewer({ content, scrollOffset, height, width }: SpecViewerProps): React.ReactElement {
  if (!content) {
    return (
      <Box flexDirection="column" height={height}>
        <Text dimColor>  (no spec selected)</Text>
      </Box>
    );
  }

  const rawLines = content.split('\n');
  const parsed = rawLines.map(parseLine);

  const visible = parsed.slice(scrollOffset, scrollOffset + height);
  const remaining = parsed.length - scrollOffset - height;

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {visible.map((line, i) => (
        <LineRenderer key={scrollOffset + i} line={line} width={width - 2} />
      ))}
      {remaining > 0 && (
        <Box height={1}>
          <Text dimColor>  \u2193 {remaining} more lines</Text>
        </Box>
      )}
    </Box>
  );
}
