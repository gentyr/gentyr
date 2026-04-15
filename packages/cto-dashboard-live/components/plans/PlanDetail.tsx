/**
 * PlanDetail — right panel for Page 3.
 * Renders phases as headers with tasks + substeps indented below.
 * Recent state changes shown at the bottom.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { PlanPhaseItem, PlanTaskItem, PlanStateChange } from '../../types.js';
import { truncate, renderProgressBar, formatTimestamp } from '../../utils/formatters.js';

interface PlanDetailProps {
  detail: { planId: string; phases: PlanPhaseItem[] } | null;
  recentChanges: PlanStateChange[];
  scrollOffset: number;
  height: number;
  width: number;
}

function taskStatusDot(status: string): { char: string; color: string } {
  switch (status) {
    case 'completed':   return { char: '\u25CF', color: 'green' };
    case 'in_progress': return { char: '\u25CF', color: 'yellow' };
    case 'ready':       return { char: '\u25CF', color: 'blue' };
    case 'blocked':     return { char: '\u25CF', color: 'red' };
    case 'skipped':     return { char: '\u25E6', color: 'gray' };
    default:            return { char: '\u25CF', color: 'gray' };
  }
}

interface DisplayLine {
  key: string;
  content: React.ReactElement;
}

function buildLines(phases: PlanPhaseItem[], width: number): DisplayLine[] {
  const lines: DisplayLine[] = [];

  for (const phase of phases) {
    const BAR_WIDTH = 8;
    const bar = renderProgressBar(phase.progressPct, BAR_WIDTH);
    const phaseLabel = truncate(phase.title, Math.max(4, width - BAR_WIDTH - 14));
    lines.push({
      key: `phase-${phase.id}`,
      content: (
        <Box height={1} key={`phase-${phase.id}`}>
          <Text bold color="cyan">{phaseLabel}</Text>
          <Text dimColor>{'  [' + bar + ']'}</Text>
        </Box>
      ),
    });

    for (const task of phase.tasks) {
      const { char, color } = taskStatusDot(task.status);
      const statusLabel = task.status.replace('_', ' ');
      const prStr = task.prNumber != null ? ` PR#${task.prNumber}${task.prMerged ? ' \u2713' : ''}` : '';
      const agentStr = task.agentType && task.status === 'in_progress' ? `  ${task.agentType}` : '';
      const substepStr = task.substepProgress ? `  ${task.substepProgress}` : '';
      const rightInfo = `${statusLabel}${substepStr}${agentStr}${prStr}`;
      const taskWidth = Math.max(4, width - 4 - rightInfo.length - 2);
      const taskTitle = truncate(task.title, taskWidth);

      lines.push({
        key: `task-${task.id}`,
        content: (
          <Box height={1} key={`task-${task.id}`}>
            <Text>{'  '}</Text>
            <Text color={color}>{char} </Text>
            <Box width={taskWidth} overflow="hidden">
              <Text dimColor={task.status === 'pending' || task.status === 'blocked'}>{taskTitle}</Text>
            </Box>
            <Text> </Text>
            <Text dimColor>{rightInfo}</Text>
          </Box>
        ),
      });

      if (task.blockedBy.length > 0) {
        lines.push({
          key: `blocked-${task.id}`,
          content: (
            <Box height={1} key={`blocked-${task.id}`}>
              <Text dimColor>{'     blocked by: '}{truncate(task.blockedBy.join(', '), Math.max(4, width - 20))}</Text>
            </Box>
          ),
        });
      }
    }

    // Blank line between phases
    lines.push({
      key: `sep-${phase.id}`,
      content: <Box height={1} key={`sep-${phase.id}`}><Text> </Text></Box>,
    });
  }

  return lines;
}

const CHANGES_HEADER_HEIGHT = 2; // divider + title

export function PlanDetail({ detail, recentChanges, scrollOffset, height, width }: PlanDetailProps): React.ReactElement {
  if (!detail || detail.phases.length === 0) {
    return (
      <Box flexDirection="column" height={height}>
        <Text dimColor>  Select a plan to view details</Text>
      </Box>
    );
  }

  const changesHeight = Math.min(recentChanges.length + CHANGES_HEADER_HEIGHT, Math.floor(height * 0.28));
  const treeHeight = Math.max(2, height - changesHeight);

  const lines = buildLines(detail.phases, width - 2);
  const visibleLines = lines.slice(scrollOffset, scrollOffset + treeHeight);

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {/* Phase/task tree */}
      <Box flexDirection="column" height={treeHeight} overflow="hidden">
        {visibleLines.map(l => l.content)}
        {visibleLines.length === 0 && (
          <Text dimColor>  (no phases)</Text>
        )}
      </Box>

      {/* Recent changes */}
      <Box flexDirection="column" height={changesHeight} overflow="hidden">
        <Box height={1}>
          <Text dimColor>{'\u2500'.repeat(3)} Recent Changes {'\u2500'.repeat(Math.max(1, width - 20))}</Text>
        </Box>
        {recentChanges.slice(0, changesHeight - CHANGES_HEADER_HEIGHT).map((c, i) => {
          const time = formatTimestamp(c.changedAt.includes('T') ? c.changedAt : c.changedAt.replace(' ', 'T') + 'Z');
          const label = truncate(c.label, Math.max(4, Math.floor(width * 0.4)));
          const change = truncate(`${c.field}: ${c.oldValue ?? '(none)'} \u2192 ${c.newValue ?? '(none)'}`, Math.max(4, width - label.length - 10));
          return (
            <Box key={i} height={1}>
              <Text dimColor>{time}  </Text>
              <Text>{label}</Text>
              <Text dimColor>  {change}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
