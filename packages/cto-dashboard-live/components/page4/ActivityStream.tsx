/**
 * ActivityStream — displays the tail of a running session's JSONL file.
 *
 * Shows the last `height` entries. Each entry is color-coded by type:
 *   tool_call     → cyan
 *   assistant_text→ white
 *   tool_result   → dim
 *   error         → red
 *   compaction    → yellow
 *
 * Auto-scrolls to the bottom by always slicing the last `height` items.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ActivityEntry } from '../../types.js';
import { truncate } from '../../utils/formatters.js';

interface ActivityStreamProps {
  entries: ActivityEntry[];
  height: number;
  width: number;
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

function EntryRow({ entry, maxTextLen }: { entry: ActivityEntry; maxTextLen: number }): React.ReactElement {
  const ts = formatTimestamp(entry.timestamp);
  const prefix = `[${ts}] `;

  switch (entry.type) {
    case 'tool_call': {
      const toolLabel = entry.toolName ?? entry.text;
      const inputPart = entry.toolInput ? ` (${truncate(entry.toolInput, maxTextLen - toolLabel.length - 10)})` : '';
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
        <Box>
          <Text dimColor>{prefix}</Text>
          <Text dimColor>[text] </Text>
          <Text>{truncate(entry.text, maxTextLen)}</Text>
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

export function ActivityStream({ entries, height, width }: ActivityStreamProps): React.ReactElement {
  const visibleHeight = Math.max(1, height);
  // Always show the newest entries (auto-scroll to bottom).
  const visible = entries.length > visibleHeight
    ? entries.slice(entries.length - visibleHeight)
    : entries;

  // Reserve space for timestamp prefix "[HH:MM:SS] [type] "
  const prefixLen = 22;
  const maxTextLen = Math.max(10, width - prefixLen);

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
