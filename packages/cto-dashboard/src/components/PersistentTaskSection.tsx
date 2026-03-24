/**
 * Persistent Task Section Component — Active persistent tasks overview
 *
 * Shows all active persistent tasks with progress bars, monitor health,
 * amendment status, and cycle counts.
 * Color coding: green (all healthy), yellow (stalled/pending amendments), red (any dead monitor)
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import type { PersistentTaskData, PersistentTaskInfo } from '../utils/persistent-task-reader.js';

export interface PersistentTaskSectionProps {
  data: PersistentTaskData;
  tip?: string;
}

const PROGRESS_BAR_WIDTH = 10;

function progressBar(pct: number): string {
  const filled = Math.round((pct / 100) * PROGRESS_BAR_WIDTH);
  const empty = PROGRESS_BAR_WIDTH - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + '...' : s;
}

function TaskRow({ task }: { task: PersistentTaskInfo }): React.ReactElement {
  const title = truncate(task.title, 28);
  const bar = progressBar(task.progressPct);
  const subTaskSummary = task.subTaskCount > 0
    ? `(${task.subTasksCompleted}/${task.subTaskCount})`
    : '(0/0)';

  const monitorColor = task.monitorAlive ? 'green' : 'red';
  const monitorLabel = task.monitorAlive
    ? `running (${task.age})`
    : `DEAD (${task.age})`;

  const amendStr = task.pendingAmendments > 0
    ? `${task.amendmentCount} (${task.pendingAmendments} pending)`
    : task.amendmentCount > 0
    ? `${task.amendmentCount}`
    : '0';

  const hasPendingAmendment = task.pendingAmendments > 0;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Title + progress bar row */}
      <Box>
        <Text color="white" bold>{title.padEnd(29)}</Text>
        <Text color="cyan"> {bar} </Text>
        <Text color="white">{task.progressPct}% </Text>
        <Text color="gray">{subTaskSummary}</Text>
      </Box>
      {/* Status detail row */}
      <Box marginLeft={2}>
        <Text color="gray">Monitor: </Text>
        <Text color={monitorColor} bold={!task.monitorAlive}>{monitorLabel}</Text>
        <Text color="gray"> | Amendments: </Text>
        <Text color={hasPendingAmendment ? 'yellow' : 'white'}>{amendStr}</Text>
        <Text color="gray"> | Cycle: </Text>
        <Text color="white">{task.cycleCount}</Text>
      </Box>
    </Box>
  );
}

export function PersistentTaskSection({ data, tip }: PersistentTaskSectionProps): React.ReactElement {
  if (!data.hasData || data.tasks.length === 0) {
    return (
      <Section title="PERSISTENT TASKS" borderColor="white" tip={tip}>
        <Text color="gray">No active persistent tasks. Use /persistent-task to create one.</Text>
      </Section>
    );
  }

  const { tasks, totalActive, monitorsAlive, pendingAmendments, monitorsDead } = data;

  // Color coding: red if any dead monitor, yellow if stalled or pending amendments, green otherwise
  const hasDeadMonitor = monitorsDead > 0;
  const hasStalled = tasks.some(t => t.stalled);
  const borderColor = hasDeadMonitor ? 'red'
    : (hasStalled || pendingAmendments > 0) ? 'yellow'
    : 'green';

  const titleParts = [`${totalActive} active`, `${monitorsAlive} monitor${monitorsAlive !== 1 ? 's' : ''} alive`];
  if (pendingAmendments > 0) {
    titleParts.push(`${pendingAmendments} amendment${pendingAmendments !== 1 ? 's' : ''} pending`);
  }
  const title = `PERSISTENT TASKS (${titleParts.join(' | ')})`;

  return (
    <Section title={title} borderColor={borderColor} titleColor={borderColor} tip={tip}>
      <Box flexDirection="column">
        {tasks.map(task => (
          <TaskRow key={task.id} task={task} />
        ))}
      </Box>
    </Section>
  );
}
