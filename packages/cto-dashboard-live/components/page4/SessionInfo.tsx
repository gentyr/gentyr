/**
 * SessionInfo — detail panel for the selected session.
 * Shows: PID, agent type, elapsed, title, and a timeline of LLM summaries.
 * Navigate summaries with [ and ] keys (driven by parent via summaryIndex prop).
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { SessionItem } from '../../types.js';
import { truncate, formatTimeAgo } from '../../utils/formatters.js';
import { getSessionSummaries } from '../../live-reader.js';

interface SessionInfoProps {
  session: SessionItem | null;
  agentId: string | null;
  summaryIndex: number;
  height: number;
}

function InfoRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Box flexDirection="row">
      <Text dimColor>{label.padEnd(12)}</Text>
      <Text>{value}</Text>
    </Box>
  );
}

export function SessionInfo({ session, agentId, summaryIndex, height }: SessionInfoProps): React.ReactElement {
  const [summaries, setSummaries] = useState<Array<{ id: string; summary: string; created_at: string }>>([]);

  // Reload summaries when agent changes or periodically (every 30s via parent re-render)
  useEffect(() => {
    if (!agentId) { setSummaries([]); return; }
    setSummaries(getSessionSummaries(agentId));
  }, [agentId]);

  // Refresh summaries every 30 seconds
  useEffect(() => {
    if (!agentId) return;
    const id = setInterval(() => {
      setSummaries(getSessionSummaries(agentId));
    }, 30000);
    return () => clearInterval(id);
  }, [agentId]);

  if (!session) {
    return (
      <Box flexDirection="column" height={height}>
        <Text dimColor>  Select a session</Text>
      </Box>
    );
  }

  const pid = session.pid ? String(session.pid) : 'N/A';
  const agentType = session.agentType || 'unknown';
  const elapsed = session.elapsed;
  const lastTool = session.lastAction ?? 'none';
  const title = session.title || '(untitled)';

  // Clamp summary index
  const clampedIdx = summaries.length > 0
    ? Math.max(0, Math.min(summaryIndex, summaries.length - 1))
    : -1;
  const currentSummary = clampedIdx >= 0 ? summaries[clampedIdx] : null;

  // Calculate available height for summary text
  // Info rows: PID, Type, Elapsed, Last tool, Title = ~5-6 rows, divider = 1, header = 1
  const infoRows = 5;
  const summaryHeaderRows = 1;
  const availableForSummary = Math.max(1, height - infoRows - summaryHeaderRows - 1);

  // Wrap summary text to fit width (rough, ~26 chars for left column)
  const wrapWidth = 26;
  const summaryLines: string[] = [];
  if (currentSummary) {
    const words = currentSummary.summary.split(' ');
    let line = '';
    for (const word of words) {
      if (line.length + word.length + 1 > wrapWidth && line.length > 0) {
        summaryLines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) summaryLines.push(line);
  }

  return (
    <Box flexDirection="column" height={height}>
      <InfoRow label="PID:" value={pid} />
      <InfoRow label="Type:" value={truncate(agentType, 30)} />
      <InfoRow label="Elapsed:" value={elapsed} />
      <InfoRow label="Last tool:" value={truncate(lastTool, 30)} />
      <Box flexDirection="column">
        <Text dimColor>{'Title:'.padEnd(12)}</Text>
        <Text wrap="wrap">{title}</Text>
      </Box>

      {/* Summaries section */}
      <Box marginTop={1} flexDirection="column">
        {summaries.length > 0 ? (
          <>
            <Text bold dimColor>
              {`Summary ${clampedIdx + 1}/${summaries.length}`}
              {currentSummary ? ` ${formatTimeAgo(currentSummary.created_at)}` : ''}
            </Text>
            {summaryLines.slice(0, availableForSummary).map((line, i) => (
              <Text key={i} wrap="truncate">{line}</Text>
            ))}
            {summaryLines.length > availableForSummary && (
              <Text dimColor>...</Text>
            )}
          </>
        ) : (
          <Text dimColor>No summaries yet</Text>
        )}
      </Box>
    </Box>
  );
}
