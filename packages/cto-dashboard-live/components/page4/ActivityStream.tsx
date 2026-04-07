/**
 * ActivityStream — displays the tail of a running session's JSONL file.
 *
 * Shows the last `height` rows of entries. Each entry is color-coded by type:
 *   tool_call     → cyan
 *   assistant_text→ white
 *   tool_result   → dim
 *   error         → red
 *   compaction    → yellow
 *
 * Row-aware: assistant_text entries consume 2+ rows (header + wrapped body),
 * so we walk backwards counting actual rows rather than naively slicing.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ActivityEntry } from '../../types.js';
import { truncate } from '../../utils/formatters.js';

interface ActivityStreamProps {
  entries: ActivityEntry[];
  height: number;
  width: number;
  scrollOffset?: number;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    const s = d.getSeconds().toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  } catch {
    return '??:??:??';
  }
}

/** Estimate how many terminal rows an entry will consume. */
function estimateRows(entry: ActivityEntry, availableWidth: number): number {
  if (entry.type !== 'assistant_text') return 1;
  // Header row "[HH:MM:SS] [text] " + text rows (marginLeft=2 reduces width by 2)
  const textWidth = Math.max(10, availableWidth - 2);
  const textRows = Math.max(1, Math.ceil(entry.text.length / textWidth));
  return 1 + textRows;
}

function EntryRow({ entry, maxTextLen }: { entry: ActivityEntry; maxTextLen: number }): React.ReactElement {
  const ts = formatTimestamp(entry.timestamp);
  const prefix = `[${ts}] `;

  switch (entry.type) {
    case 'tool_call': {
      const toolLabel = truncate(entry.toolName ?? entry.text, maxTextLen - 10);
      const inputMaxLen = Math.max(0, maxTextLen - toolLabel.length - 10);
      const inputPart = entry.toolInput && inputMaxLen > 3
        ? ` (${truncate(entry.toolInput, inputMaxLen)})`
        : '';
      return (
        <Box>
          <Text dimColor>{prefix}</Text>
          <Text color="cyan">[tool] </Text>
          <Text color="cyan" bold>{toolLabel}</Text>
          <Text dimColor>{inputPart}</Text>
        </Box>
      );
    }
    case 'assistant_text':
      return (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>{prefix}</Text>
            <Text dimColor>[text] </Text>
          </Box>
          <Box marginLeft={2}>
            <Text wrap="wrap">{entry.text}</Text>
          </Box>
        </Box>
      );
    case 'tool_result':
      return (
        <Box>
          <Text dimColor>{prefix}</Text>
          <Text dimColor>[result] {truncate(entry.resultPreview ?? entry.text, maxTextLen)}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box>
          <Text dimColor>{prefix}</Text>
          <Text color="red">[error] </Text>
          <Text color="red">{truncate(entry.text, maxTextLen)}</Text>
        </Box>
      );
    case 'compaction':
      return (
        <Box>
          <Text dimColor>{prefix}</Text>
          <Text color="yellow">[compact] </Text>
          <Text color="yellow">{entry.text}</Text>
        </Box>
      );
    default:
      return (
        <Box>
          <Text dimColor>{prefix}{truncate(entry.text, maxTextLen)}</Text>
        </Box>
      );
  }
}

export function ActivityStream({ entries, height, width, scrollOffset = 0 }: ActivityStreamProps): React.ReactElement {
  const visibleHeight = Math.max(1, height);

  // Reserve space for timestamp prefix "[HH:MM:SS] [type] "
  const prefixLen = 22;
  const maxTextLen = Math.max(10, width - prefixLen);

  // Row-aware visible entry selection: walk backwards counting actual rows
  // so multi-row assistant_text entries are properly accounted for.
  const clampedOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, entries.length - 1)));
  const endIndex = entries.length - clampedOffset;

  const visible: ActivityEntry[] = [];
  let usedRows = 0;
  for (let i = endIndex - 1; i >= 0 && usedRows < visibleHeight; i--) {
    const rows = estimateRows(entries[i], width);
    if (usedRows + rows > visibleHeight) break;
    visible.unshift(entries[i]);
    usedRows += rows;
  }

  if (visible.length === 0) {
    return (
      <Box flexDirection="column" height={visibleHeight}>
        <Text dimColor>  Waiting for activity...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={visibleHeight} overflow="hidden">
      {visible.map((entry, i) => (
        <EntryRow key={`${entry.timestamp}-${i}`} entry={entry} maxTextLen={maxTextLen} />
      ))}
    </Box>
  );
}
