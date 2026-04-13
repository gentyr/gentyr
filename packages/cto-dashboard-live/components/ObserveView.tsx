/**
 * ObserveView — real-time session tail + signal injection.
 *
 * Layout (two-column):
 *   Left  : SessionSelector (selectable list) + SessionInfo
 *   Right : ActivityStream (JSONL tail) + SignalInput
 *
 * Keyboard map (when NOT in signal mode):
 *   up/down   select session
 *   Enter     enter signal mode
 *   [ / ]     navigate summaries
 *
 * Keyboard map (when in signal mode):
 *   printable char   append to text
 *   Backspace        delete last char
 *   Enter            send signal (if text non-empty) or exit signal mode
 *   Escape           cancel, exit signal mode
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Section } from './Section.js';
import { SessionSelector } from './page4/SessionSelector.js';
import { SessionInfo } from './page4/SessionInfo.js';
import { ActivityStream } from './page4/ActivityStream.js';
import { SignalInput } from './page4/SignalInput.js';
import { useSessionTail } from '../hooks/useSessionTail.js';
import { sendDirectiveSignal, isProcessAlive, resumeSessionWithMessage, getSignalDeliveryStatus } from '../live-reader.js';
import type { LiveDashboardData, SessionItem, DisplaySession } from '../types.js';

interface ObserveViewProps {
  data: LiveDashboardData;
  bodyHeight: number;
  bodyWidth: number;
  isActive: boolean;
}

const LEFT_WIDTH_FRACTION = 0.35;
const LEFT_HEADER_OVERHEAD = 2;
const RIGHT_HEADER_OVERHEAD = 2;
const SIGNAL_ROW_HEIGHT = 1;
const DIVIDER_HEIGHT = 1;

/** Build a flat list of DisplaySession with hierarchy info */
function buildDisplaySessions(data: LiveDashboardData): DisplaySession[] {
  const result: DisplaySession[] = [];

  // Queued sessions (top-level)
  for (const s of data.queuedSessions) {
    result.push({ session: s, indent: 0, isMonitor: false });
  }

  // Persistent tasks: monitor + indented children
  for (const pt of data.persistentTasks) {
    result.push({
      session: pt.monitorSession,
      indent: 0,
      isMonitor: true,
      persistentTaskTitle: pt.title,
    });
    // Sub-task sessions (indented)
    for (const st of pt.subTasks) {
      if (st.session) {
        result.push({ session: st.session, indent: 1, isMonitor: false });
      }
    }
  }

  // Standalone running sessions
  for (const s of data.runningSessions) {
    result.push({ session: s, indent: 0, isMonitor: false });
  }

  // Suspended sessions
  for (const s of data.suspendedSessions) {
    result.push({ session: s, indent: 0, isMonitor: false });
  }

  // Completed sessions
  for (const s of data.completedSessions) {
    result.push({ session: s, indent: 0, isMonitor: false });
  }

  return result;
}

export function ObserveView({ data, bodyHeight, bodyWidth, isActive }: ObserveViewProps): React.ReactElement {
  const displaySessions = buildDisplaySessions(data);
  const allSessions = displaySessions.map(ds => ds.session);

  const [selectedId, setSelectedId] = useState<string | null>(
    allSessions.length > 0 ? allSessions[0].id : null,
  );

  // Resolve selected session
  const selectedSession = allSessions.find(s => s.id === selectedId)
    ?? (allSessions.length > 0 ? allSessions[0] : null);
  const effectiveSelectedId = selectedSession?.id ?? null;

  // Summary navigation state
  const [summaryIndex, setSummaryIndex] = useState(0);
  useEffect(() => { setSummaryIndex(0); }, [effectiveSelectedId]);

  // Signal state
  const [signalMode, setSignalMode] = useState(false);
  const [signalText, setSignalText] = useState('');
  const [lastSignalStatus, setLastSignalStatus] = useState<string | null>(null);
  const sentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deliveryPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearSentTimer = useCallback(() => {
    if (sentTimerRef.current !== null) {
      clearTimeout(sentTimerRef.current);
      sentTimerRef.current = null;
    }
  }, []);

  const clearDeliveryPoll = useCallback(() => {
    if (deliveryPollRef.current !== null) {
      clearInterval(deliveryPollRef.current);
      deliveryPollRef.current = null;
    }
  }, []);

  useEffect(() => () => clearDeliveryPoll(), [clearDeliveryPoll]);
  useEffect(() => clearSentTimer, [clearSentTimer]);

  // Live tail
  const tailAgentId = selectedSession?.sessionId ?? null;
  const tailWorktreePath = selectedSession?.worktreePath ?? null;
  const { entries, isConnected, resetSessionEnd } = useSessionTail(tailAgentId, tailWorktreePath);

  // Injected entries (user messages) that appear in the activity stream
  const [injectedEntries, setInjectedEntries] = useState<import('../types.js').ActivityEntry[]>([]);
  // Merge tail entries with injected entries, sorted by timestamp
  const mergedEntries = React.useMemo(() => {
    if (injectedEntries.length === 0) return entries;
    return [...entries, ...injectedEntries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }, [entries, injectedEntries]);
  // Clear injected entries when switching sessions
  useEffect(() => { setInjectedEntries([]); }, [effectiveSelectedId]);

  // Detect if selected session is completed/dead
  const TERMINAL_TOOLS = ['mcp__todo-db__complete_task', 'mcp__todo-db__summarize_work', 'complete_task', 'summarize_work'];
  const lastToolIsTerminal = selectedSession?.lastAction != null && TERMINAL_TOOLS.some(t => selectedSession.lastAction!.includes(t));
  const hasSessionEndMarker = entries.some(e => e.type === 'session_end');
  const isCompleted = selectedSession == null
    || selectedSession.pid == null
    || !isProcessAlive(selectedSession.pid)
    || lastToolIsTerminal
    || hasSessionEndMarker;

  // Keyboard handling
  useInput((input, key) => {
    if (signalMode) {
      if (key.escape) {
        setSignalMode(false);
        setSignalText('');
        return;
      }
      if (key.return) {
        const msg = signalText.trim();
        if (msg.length === 0) {
          // Empty enter = cancel signal mode
          setSignalMode(false);
          setSignalText('');
          return;
        }
        if (selectedSession) {
          const alive = selectedSession.pid != null
            ? isProcessAlive(selectedSession.pid) && !hasSessionEndMarker
            : false;
          if (alive && tailAgentId) {
            // Running session: inject directive signal
            let signalId: string | undefined;
            try {
              const result = sendDirectiveSignal(tailAgentId, msg, selectedSession.worktreePath);
              signalId = result.signalId;
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              setLastSignalStatus(`ERROR: ${errMsg}`);
              clearSentTimer();
              sentTimerRef.current = setTimeout(() => setLastSignalStatus(null), 8000);
              setSignalMode(false);
              setSignalText('');
              return;
            }
            clearSentTimer();
            clearDeliveryPoll();
            setLastSignalStatus(`Pending: "${msg}"`);
            // Poll for delivery; escalate to resume if agent dies mid-delivery
            if (signalId) {
              let pollCount = 0;
              deliveryPollRef.current = setInterval(() => {
                pollCount++;
                const status = getSignalDeliveryStatus(signalId!, selectedSession.worktreePath);
                if (status?.status === 'acknowledged') {
                  setLastSignalStatus(`Ack'd: "${msg}"`);
                  clearDeliveryPoll();
                  sentTimerRef.current = setTimeout(() => setLastSignalStatus(null), 10000);
                } else if (status?.status === 'read') {
                  setLastSignalStatus(`Delivered: "${msg}"`);
                } else if (pollCount >= 15) {
                  // 30s without read — check if agent is still alive
                  const stillAlive = selectedSession.pid != null && isProcessAlive(selectedSession.pid);
                  if (!stillAlive && selectedSession.sessionId) {
                    // Agent died — escalate to inline resume
                    clearDeliveryPoll();
                    setInjectedEntries(prev => [...prev, {
                      type: 'user_message' as const,
                      timestamp: new Date().toISOString(),
                      text: msg,
                    }]);
                    resetSessionEnd();
                    resumeSessionWithMessage(selectedSession.sessionId, msg);
                    setLastSignalStatus(`Resuming... (agent exited)`);
                    sentTimerRef.current = setTimeout(() => setLastSignalStatus(null), 10000);
                  } else {
                    // Agent alive but busy — update status
                    setLastSignalStatus(`Queued: "${msg}"`);
                  }
                }
              }, 2000);
            }
          } else if (selectedSession.sessionId) {
            // Completed/dead session: resume inline (background spawn)
            setInjectedEntries(prev => [...prev, {
              type: 'user_message' as const,
              timestamp: new Date().toISOString(),
              text: msg,
            }]);
            resetSessionEnd();
            resumeSessionWithMessage(selectedSession.sessionId, msg);
            clearSentTimer();
            setLastSignalStatus(`Resuming...`);
            sentTimerRef.current = setTimeout(() => setLastSignalStatus(null), 8000);
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
      if (input && input.length === 1 && input.charCodeAt(0) >= 32) {
        setSignalText(prev => prev + input);
        return;
      }
      return;
    }

    // Normal navigation mode
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
    if (input === '[') {
      setSummaryIndex(prev => Math.max(0, prev - 1));
      return;
    }
    if (input === ']') {
      setSummaryIndex(prev => prev + 1);
      return;
    }
    if (key.return) {
      if (effectiveSelectedId) {
        setSignalMode(true);
        setSignalText('');
      }
      return;
    }
  }, { isActive });

  // Clear delivery poll when session changes
  useEffect(() => {
    clearDeliveryPoll();
    setLastSignalStatus(null);
  }, [effectiveSelectedId, clearDeliveryPoll]);

  // Layout
  const leftWidth = Math.floor(bodyWidth * LEFT_WIDTH_FRACTION);
  const rightWidth = bodyWidth - leftWidth - 1;

  const leftInnerHeight = Math.max(2, bodyHeight - LEFT_HEADER_OVERHEAD);
  const selectorHeight = Math.floor(leftInnerHeight * 0.6);
  const infoHeight = Math.max(2, leftInnerHeight - selectorHeight - DIVIDER_HEIGHT);

  const rightInnerHeight = Math.max(2, bodyHeight - RIGHT_HEADER_OVERHEAD);
  const streamHeight = Math.max(1, rightInnerHeight - SIGNAL_ROW_HEIGHT - DIVIDER_HEIGHT);

  const connectedLabel = isConnected ? ' live' : ' disconnected';

  return (
    <Box flexDirection="row" height={bodyHeight}>
      {/* Left column */}
      <Section title="Sessions" width={leftWidth}>
        <SessionSelector
          displaySessions={displaySessions}
          selectedId={effectiveSelectedId}
          height={selectorHeight}
          width={leftWidth - 4}
        />
        <Box height={DIVIDER_HEIGHT}>
          <Text dimColor>{'\u2500'.repeat(Math.max(1, leftWidth - 4))}</Text>
        </Box>
        <Box flexDirection="column">
          <Text dimColor bold>Session Info</Text>
        </Box>
        <SessionInfo
          session={selectedSession}
          agentId={tailAgentId}
          summaryIndex={summaryIndex}
          height={infoHeight}
          width={leftWidth - 4}
        />
      </Section>

      {/* 1-char gap */}
      <Box width={1} />

      {/* Right column */}
      <Section title={`Live Activity Stream${connectedLabel}`} width={rightWidth} flexGrow={1}>
        <ActivityStream
          entries={mergedEntries}
          height={streamHeight}
          width={rightWidth - 4}
        />
        <Box height={DIVIDER_HEIGHT}>
          <Text dimColor>{'\u2500'.repeat(Math.max(1, rightWidth - 4))}</Text>
        </Box>
        <SignalInput
          active={signalMode}
          text={signalText}
          lastStatus={lastSignalStatus}
          width={rightWidth - 4}
          isCompleted={isCompleted}
        />
      </Section>
    </Box>
  );
}
