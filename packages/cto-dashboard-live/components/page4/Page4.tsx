/**
 * Page 4: Observe — real-time session tail + signal injection.
 *
 * Layout (two-column):
 *   Left  : SessionSelector (selectable list) + SessionInfo
 *   Right : ActivityStream (JSONL tail) + SignalInput
 *
 * Keyboard map (when NOT in signal mode):
 *   ↑ / ↓   select session
 *   s        enter signal mode
 *
 * Keyboard map (when in signal mode):
 *   printable char   append to text
 *   Backspace        delete last char
 *   Enter            send signal, exit signal mode
 *   Escape           cancel, exit signal mode
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Section } from '../Section.js';
import { SessionSelector } from './SessionSelector.js';
import { SessionInfo } from './SessionInfo.js';
import { ActivityStream } from './ActivityStream.js';
import { SignalInput } from './SignalInput.js';
import { useSessionTail } from '../../hooks/useSessionTail.js';
import { sendDirectiveSignal } from '../../live-reader.js';
import type { LiveDashboardData } from '../../types.js';

interface Page4Props {
  data: LiveDashboardData;
  bodyHeight: number;
  bodyWidth: number;
}

const LEFT_WIDTH_FRACTION = 0.36;
// Rows consumed by the Section border/header in the left column.
const LEFT_HEADER_OVERHEAD = 2;
// Rows consumed by Section border + SignalInput row at bottom in the right column.
const RIGHT_HEADER_OVERHEAD = 2;
const SIGNAL_ROW_HEIGHT = 1;
const DIVIDER_HEIGHT = 1;

export function Page4({ data, bodyHeight, bodyWidth }: Page4Props): React.ReactElement {
  // ── Session selection ────────────────────────────────────────────────────
  const sessions = [
    ...data.runningSessions,
    ...data.persistentTasks.map(pt => pt.monitorSession),
  ];

  const [selectedId, setSelectedId] = useState<string | null>(
    sessions.length > 0 ? sessions[0].id : null,
  );

  // Keep selection valid when sessions list changes.
  const selectedSession = sessions.find(s => s.id === selectedId) ?? sessions[0] ?? null;
  const effectiveSelectedId = selectedSession?.id ?? null;

  // ── Signal state ─────────────────────────────────────────────────────────
  const [signalMode, setSignalMode] = useState(false);
  const [signalText, setSignalText] = useState('');
  const [lastSignalSent, setLastSignalSent] = useState<string | null>(null);
  // Timer ref to clear the "Sent: …" confirmation after 5 s.
  const sentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSentTimer = useCallback(() => {
    if (sentTimerRef.current !== null) {
      clearTimeout(sentTimerRef.current);
      sentTimerRef.current = null;
    }
  }, []);

  // Clear timer on unmount.
  useEffect(() => clearSentTimer, [clearSentTimer]);

  // ── Live tail ────────────────────────────────────────────────────────────
  const { entries, isConnected } = useSessionTail(effectiveSelectedId);

  // ── Keyboard handling ────────────────────────────────────────────────────
  useInput((input, key) => {
    if (signalMode) {
      if (key.escape) {
        setSignalMode(false);
        setSignalText('');
        return;
      }
      if (key.return) {
        const msg = signalText.trim();
        if (msg.length > 0 && effectiveSelectedId) {
          try {
            sendDirectiveSignal(effectiveSelectedId, msg);
          } catch (err) {
            // Fail loudly — surface error in last signal display.
            const errMsg = err instanceof Error ? err.message : String(err);
            setLastSignalSent(`ERROR: ${errMsg}`);
            clearSentTimer();
            sentTimerRef.current = setTimeout(() => setLastSignalSent(null), 5000);
            setSignalMode(false);
            setSignalText('');
            return;
          }
          clearSentTimer();
          setLastSignalSent(msg);
          sentTimerRef.current = setTimeout(() => setLastSignalSent(null), 5000);
        }
        setSignalMode(false);
        setSignalText('');
        return;
      }
      if (key.backspace || key.delete) {
        setSignalText(prev => prev.slice(0, -1));
        return;
      }
      // Regular printable character.
      if (input && input.length === 1 && input.charCodeAt(0) >= 32) {
        setSignalText(prev => prev + input);
        return;
      }
      return;
    }

    // Normal navigation mode.
    if (key.upArrow) {
      const idx = sessions.findIndex(s => s.id === effectiveSelectedId);
      if (idx > 0) setSelectedId(sessions[idx - 1].id);
      return;
    }
    if (key.downArrow) {
      const idx = sessions.findIndex(s => s.id === effectiveSelectedId);
      if (idx >= 0 && idx < sessions.length - 1) setSelectedId(sessions[idx + 1].id);
      return;
    }
    if (input === 's') {
      if (effectiveSelectedId) {
        setSignalMode(true);
        setSignalText('');
      }
      return;
    }
  });

  // ── Layout ───────────────────────────────────────────────────────────────
  const leftWidth = Math.floor(bodyWidth * LEFT_WIDTH_FRACTION);
  const rightWidth = bodyWidth - leftWidth - 1; // -1 for gap

  // Left column: split between selector and info panel.
  const leftInnerHeight = Math.max(2, bodyHeight - LEFT_HEADER_OVERHEAD);
  const selectorHeight = Math.floor(leftInnerHeight * 0.6);
  const infoHeight = Math.max(2, leftInnerHeight - selectorHeight - DIVIDER_HEIGHT);

  // Right column: activity stream + signal row.
  const rightInnerHeight = Math.max(2, bodyHeight - RIGHT_HEADER_OVERHEAD);
  const streamHeight = Math.max(1, rightInnerHeight - SIGNAL_ROW_HEIGHT - DIVIDER_HEIGHT);

  const connectedLabel = isConnected ? ' live' : ' disconnected';

  return (
    <Box flexDirection="row" height={bodyHeight}>
      {/* Left column */}
      <Section title="Running Sessions" width={leftWidth}>
        <SessionSelector
          sessions={sessions}
          selectedId={effectiveSelectedId}
          height={selectorHeight}
        />
        <Box height={DIVIDER_HEIGHT}>
          <Text dimColor>{'─'.repeat(Math.max(1, leftWidth - 4))}</Text>
        </Box>
        <Box flexDirection="column">
          <Text dimColor bold>Session Info</Text>
        </Box>
        <SessionInfo
          session={selectedSession}
          height={infoHeight}
        />
      </Section>

      {/* 1-char gap */}
      <Box width={1} />

      {/* Right column */}
      <Section title={`Live Activity Stream${connectedLabel}`} width={rightWidth} flexGrow={1}>
        <ActivityStream
          entries={entries}
          height={streamHeight}
          width={rightWidth - 4}
        />
        <Box height={DIVIDER_HEIGHT}>
          <Text dimColor>{'─'.repeat(Math.max(1, rightWidth - 4))}</Text>
        </Box>
        <SignalInput
          active={signalMode}
          text={signalText}
          lastSent={lastSignalSent}
          width={rightWidth - 4}
        />
      </Section>
    </Box>
  );
}
