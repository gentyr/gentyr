/**
 * CommentaryView — Page 5 of the CTO Dashboard.
 * Full-width scrollable feed of AI-generated commentary with streaming support.
 * Reads from live-feed.db (written by daemon). Supports load-more for history.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Page5Data, FeedMessage } from '../types.js';
import { truncate, formatTimestamp } from '../utils/formatters.js';

interface CommentaryViewProps {
  data: Page5Data & { loadMore: () => void; hasMore: boolean };
  bodyHeight: number;
  bodyWidth: number;
  isActive: boolean;
}

interface DisplayLine {
  key: string;
  content: React.ReactElement;
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  const words = text.split(/\s+/);
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function buildMessageLines(msg: FeedMessage, width: number): DisplayLine[] {
  const lines: DisplayLine[] = [];
  const contentWidth = Math.max(10, width - 4);
  const time = formatTimestamp(msg.timestamp.includes('T') ? msg.timestamp : msg.timestamp.replace(' ', 'T') + 'Z');
  const divider = '\u2500'.repeat(Math.max(1, contentWidth - time.length - 3));

  lines.push({
    key: `msg-hdr-${msg.id}`,
    content: (
      <Box height={1} key={`msg-hdr-${msg.id}`}>
        <Text dimColor>  [{time}] {divider}</Text>
      </Box>
    ),
  });

  const wrapped = wrapText(msg.text, contentWidth);
  for (let i = 0; i < wrapped.length; i++) {
    lines.push({
      key: `msg-${msg.id}-${i}`,
      content: (
        <Box height={1} key={`msg-${msg.id}-${i}`}>
          <Text>  {wrapped[i]}</Text>
        </Box>
      ),
    });
  }

  lines.push({
    key: `msg-sep-${msg.id}`,
    content: <Box height={1} key={`msg-sep-${msg.id}`}><Text> </Text></Box>,
  });

  return lines;
}

function buildStreamingLines(text: string, width: number): DisplayLine[] {
  const lines: DisplayLine[] = [];
  const contentWidth = Math.max(10, width - 4);
  const divider = '\u2500'.repeat(Math.max(1, contentWidth - 16));

  lines.push({
    key: 'stream-hdr',
    content: (
      <Box height={1} key="stream-hdr">
        <Text>  </Text>
        <Text color="magenta">[generating...]</Text>
        <Text dimColor> {divider}</Text>
      </Box>
    ),
  });

  const wrapped = wrapText(text, contentWidth - 1);
  for (let i = 0; i < wrapped.length; i++) {
    const isLast = i === wrapped.length - 1;
    lines.push({
      key: `stream-${i}`,
      content: (
        <Box height={1} key={`stream-${i}`}>
          <Text color="magenta">  {wrapped[i]}{isLast ? '\u2588' : ''}</Text>
        </Box>
      ),
    });
  }

  return lines;
}

const STATUS_HEIGHT = 1;

export function CommentaryView({ data, bodyHeight, bodyWidth, isActive }: CommentaryViewProps): React.ReactElement {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [following, setFollowing] = useState(true);
  const prevMessageCountRef = useRef(data.messages.length);

  // Build all display lines
  const allLines: DisplayLine[] = [];

  // Load-more indicator at top
  if (data.hasMore) {
    allLines.push({
      key: 'load-more',
      content: (
        <Box height={1} key="load-more">
          <Text dimColor>  {'--- scroll up for older entries ---'}</Text>
        </Box>
      ),
    });
  }

  if (data.messages.length === 0 && !data.isGenerating) {
    allLines.push({
      key: 'empty',
      content: (
        <Box height={1} key="empty">
          <Text dimColor>  Waiting for feed entries... (daemon writes every 60s when activity detected)</Text>
        </Box>
      ),
    });
  }

  for (const msg of data.messages) {
    allLines.push(...buildMessageLines(msg, bodyWidth));
  }

  if (data.streamingText) {
    allLines.push(...buildStreamingLines(data.streamingText, bodyWidth));
  } else if (data.isGenerating) {
    allLines.push({
      key: 'gen-wait',
      content: (
        <Box height={1} key="gen-wait">
          <Text color="magenta">  {'\u23F3'} Generating commentary...</Text>
        </Box>
      ),
    });
  }

  const feedHeight = Math.max(2, bodyHeight - STATUS_HEIGHT);
  const maxScroll = Math.max(0, allLines.length - feedHeight);

  // Auto-scroll when following and new content arrives
  useEffect(() => {
    if (following) {
      setScrollOffset(maxScroll);
    }
  }, [following, maxScroll, data.messages.length, data.streamingText]);

  // Detect new messages to re-engage following
  useEffect(() => {
    if (data.messages.length > prevMessageCountRef.current && isActive) {
      setFollowing(true);
    }
    prevMessageCountRef.current = data.messages.length;
  }, [data.messages.length, isActive]);

  // Keyboard
  useInput((input, key) => {
    if (key.upArrow) {
      setFollowing(false);
      const newOffset = Math.max(0, scrollOffset - 1);
      setScrollOffset(newOffset);
      // Trigger load-more when scrolled to top
      if (newOffset === 0 && data.hasMore) {
        data.loadMore();
      }
      return;
    }
    if (key.downArrow) {
      const next = Math.min(maxScroll, scrollOffset + 1);
      if (next >= maxScroll) setFollowing(true);
      setScrollOffset(next);
      return;
    }
    if (key.pageUp) {
      setFollowing(false);
      const newOffset = Math.max(0, scrollOffset - feedHeight);
      setScrollOffset(newOffset);
      if (newOffset === 0 && data.hasMore) {
        data.loadMore();
      }
      return;
    }
    if (key.pageDown) {
      const next = Math.min(maxScroll, scrollOffset + feedHeight);
      if (next >= maxScroll) setFollowing(true);
      setScrollOffset(next);
      return;
    }
    if (input === 'end' || (key.meta && key.downArrow)) {
      setFollowing(true);
      setScrollOffset(maxScroll);
      return;
    }
  }, { isActive });

  const visibleLines = allLines.slice(scrollOffset, scrollOffset + feedHeight);

  // Status bar
  let statusText = '';
  if (data.error) {
    statusText = `Error: ${data.error}`;
  } else if (data.isGenerating) {
    statusText = `Generating... | ${data.messages.length} entries`;
  } else if (data.lastGeneratedAt) {
    const ageMs = Date.now() - new Date(data.lastGeneratedAt).getTime();
    const ageSec = Math.floor(ageMs / 1000);
    statusText = `Last entry: ${ageSec}s ago | ${data.messages.length} entries loaded`;
  } else {
    statusText = 'Waiting for daemon...';
  }

  if (!following && allLines.length > feedHeight) {
    statusText += ` | scrolled (end to follow)`;
  }

  return (
    <Box flexDirection="column" height={bodyHeight} overflow="hidden">
      <Box flexDirection="column" height={feedHeight} overflow="hidden">
        {visibleLines.map(l => l.content)}
      </Box>
      <Box height={STATUS_HEIGHT}>
        <Text dimColor>  {truncate(statusText, bodyWidth - 4)}</Text>
      </Box>
    </Box>
  );
}
