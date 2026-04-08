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
import { sendDirectiveSignal, isProcessAlive, resumeSessionWithMessage } from '../../live-reader.js';
import type { LiveDashboardData, SessionItem } from '../../types.js';

interface Page4Props {
  data: LiveDashboardData;
  bodyHeight: number;
  bodyWidth: number;
  initialSession?: SessionItem | null;
}

const LEFT_WIDTH_FRACTION = 0.22;
// Rows consumed by the Section border/header in the left column.
const LEFT_HEADER_OVERHEAD = 2;
// Rows consumed by Section border + SignalInput row at bottom in the right column.
const RIGHT_HEADER_OVERHEAD = 2;
const SIGNAL_ROW_HEIGHT = 1;
const DIVIDER_HEIGHT = 1;

export function Page4({ data, bodyHeight, bodyWidth, initialSession }: Page4Props): React.ReactElement {
  // ── All available sessions (queued → running → persistent+sub-tasks → completed) ──
  const subTaskSessions: SessionItem[] = data.persistentTasks.flatMap(pt =>
    pt.subTasks
      .filter(st => st.session != null)
      .map(st => ({ ...st.session!, title: `\u2514 ${st.session!.title}` }))
  );

  const allSessions: SessionItem[] = [
    ...data.queuedSessions,
    ...data.runningSessions,
    ...data.persistentTasks.map(pt => pt.monitorSession).filter(Boolean) as SessionItem[],
    ...subTaskSessions,
    ...data.completedSessions,
  ];

  const [selectedId, setSelectedId] = useState<string | null>(
    initialSession ? initialSession.id : null,
  );

  // When a target session is passed in (e.g. from Page 1 Enter), select it.
  useEffect(() => {
    if (initialSession) {
      setSelectedId(initialSession.id);
    }
  }, [initialSession]);

  // Resolve selected session from all available sessions (running data may update)
  const selectedSession = allSessions.find(s => s.id === selectedId)
    ?? (allSessions.length > 0 ? allSessions[0] : null);
  const effectiveSelectedId = selectedSession?.id ?? null;

  // ── Summary navigation state ─────────────────────────────────────────────
  const [summaryIndex, setSummaryIndex] = useState(0);
  // Reset summary index when session changes
  useEffect(() => { setSummaryIndex(0); }, [effectiveSelectedId]);

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
  // useSessionTail needs the AGENT ID (used as [AGENT:xxx] marker in JSONL files),
  // not the queue item ID. SessionItem.sessionId contains the agent_id.
  const tailAgentId = selectedSession?.sessionId ?? null;
  const tailWorktreePath = selectedSession?.worktreePath ?? null;
  const { entries, isConnected } = useSessionTail(tailAgentId, tailWorktreePath);

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
        if (msg.length > 0 && selectedSession) {
          const alive = selectedSession.pid != null ? isProcessAlive(selectedSession.pid) : false;
          if (alive && tailAgentId) {
            // Running session: inject directive signal (needs agent ID, not queue ID).
            try {
              sendDirectiveSignal(tailAgentId, msg);
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
          } else if (selectedSession.sessionId) {
            // Completed/dead session: resume in a new Terminal window.
            resumeSessionWithMessage(selectedSession.sessionId, msg);
            clearSentTimer();
            setLastSignalSent(`Resumed: ${msg}`);
            sentTimerRef.current = setTimeout(() => setLastSignalSent(null), 5000);
          }
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
      const idx = allSessions.findIndex(s => s.id === effectiveSelectedId);
      if (idx > 0) setSelectedId(allSessions[idx - 1].id);
      return;
    }
    if (key.downArrow) {
      const idx = allSessions.findIndex(s => s.id === effectiveSelectedId);
      if (idx >= 0 && idx < allSessions.length - 1) setSelectedId(allSessions[idx + 1].id);
      return;
    }
    // Summary navigation: [ previous, ] next
    if (input === '[') {
      setSummaryIndex(prev => Math.max(0, prev - 1));
      return;
    }
    if (input === ']') {
      setSummaryIndex(prev => prev + 1); // SessionInfo clamps to max
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
  const TERMINAL_TOOLS = ['mcp__todo-db__complete_task', 'mcp__todo-db__summarize_work', 'complete_task', 'summarize_work'];
  const lastToolIsTerminal = selectedSession?.lastAction != null && TERMINAL_TOOLS.some(t => selectedSession.lastAction!.includes(t));
  const isCompleted = selectedSession == null
    || selectedSession.pid == null
    || !isProcessAlive(selectedSession.pid)
    || lastToolIsTerminal;

  return (
    <Box flexDirection="row" height={bodyHeight}>
      {/* Left column */}
      <Section title="Sessions" width={leftWidth}>
        <SessionSelector
          sessions={allSessions}
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
          agentId={tailAgentId}
          summaryIndex={summaryIndex}
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
          isCompleted={isCompleted}
        />
      </Section>
    </Box>
  );
}
