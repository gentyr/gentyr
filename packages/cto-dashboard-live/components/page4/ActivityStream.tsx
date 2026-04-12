/**
 * ActivityStream — displays the tail of a running session's JSONL file.
 * Color-coded by type. Row-aware for multi-line text entries.
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
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
  } catch { return '??:??:??'; }
}

function estimateRows(entry: ActivityEntry, availableWidth: number): number {
  if (entry.type !== 'assistant_text') return 1;
  const textWidth = Math.max(10, availableWidth - 2);
  return 1 + Math.max(1, Math.ceil(entry.text.length / textWidth));
}

function EntryRow({ entry, maxTextLen }: { entry: ActivityEntry; maxTextLen: number }): React.ReactElement {
  const prefix = `[${formatTimestamp(entry.timestamp)}] `;

  switch (entry.type) {
    case 'tool_call': {
      const toolLabel = truncate(entry.toolName ?? entry.text, maxTextLen - 10);
      const inputMaxLen = Math.max(0, maxTextLen - toolLabel.length - 10);
      const inputPart = entry.toolInput && inputMaxLen > 3 ? ` (${truncate(entry.toolInput, inputMaxLen)})` : '';
      return (<Box><Text dimColor>{prefix}</Text><Text color="cyan">[tool] </Text><Text color="cyan" bold>{toolLabel}</Text><Text dimColor>{inputPart}</Text></Box>);
    }
    case 'assistant_text':
      return (<Box flexDirection="column"><Box><Text dimColor>{prefix}</Text><Text dimColor>[text] </Text></Box><Box marginLeft={2}><Text wrap="wrap">{entry.text}</Text></Box></Box>);
    case 'tool_result':
      return (<Box><Text dimColor>{prefix}[result] {truncate(entry.resultPreview ?? entry.text, maxTextLen)}</Text></Box>);
    case 'error':
      return (<Box><Text dimColor>{prefix}</Text><Text color="red">[error] {truncate(entry.text, maxTextLen)}</Text></Box>);
    case 'compaction':
      return (<Box><Text dimColor>{prefix}</Text><Text color="yellow">[compact] {entry.text}</Text></Box>);
    case 'session_end':
      return (<Box><Text dimColor>{prefix}[end] {entry.text}</Text></Box>);
    case 'user_message':
      return (<Box><Text dimColor>{prefix}</Text><Text color="green" bold>[you] </Text><Text>{truncate(entry.text, maxTextLen)}</Text></Box>);
    default:
      return (<Box><Text dimColor>{prefix}{truncate(entry.text, maxTextLen)}</Text></Box>);
  }
}

export function ActivityStream({ entries, height, width, scrollOffset = 0 }: ActivityStreamProps): React.ReactElement {
  const visibleHeight = Math.max(1, height);
  const maxTextLen = Math.max(10, width - 22);
  const endIndex = entries.length - Math.max(0, Math.min(scrollOffset, Math.max(0, entries.length - 1)));
  const visible: ActivityEntry[] = [];
  let usedRows = 0;
  for (let i = endIndex - 1; i >= 0 && usedRows < visibleHeight; i--) {
    const rows = estimateRows(entries[i], width);
    if (usedRows + rows > visibleHeight) break;
    visible.unshift(entries[i]);
    usedRows += rows;
  }
  if (visible.length === 0) {
    return (<Box flexDirection="column" height={visibleHeight}><Text dimColor>  Waiting for activity...</Text></Box>);
  }
  return (
    <Box flexDirection="column" height={visibleHeight} overflow="hidden">
      {visible.map((entry, i) => (<EntryRow key={`${entry.timestamp}-${i}`} entry={entry} maxTextLen={maxTextLen} />))}
    </Box>
  );
}
