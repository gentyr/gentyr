/**
 * Persistent Task Monitor Section Component
 *
 * Rich visual hierarchy for persistent task monitoring. Shows:
 *   - Task header (status, cycles, heartbeat, monitor PID/queue status)
 *   - Sub-tasks as a visual tree with status icons
 *   - Active agents inline under their sub-tasks (stage, progress)
 *   - Recent events timeline (last 5)
 *   - Amendments summary (acknowledged vs pending)
 *
 * Color coding:
 *   red    — any active task with a dead monitor (no revival queued)
 *   yellow — stale heartbeat, pending amendments, or queued/spawning monitor
 *   green  — all active monitors alive and heartbeating
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import type {
  PersistentTaskMonitorSectionData,
  PersistentTaskMonitorData,
  PersistentTaskMonitorSubTask,
  PersistentTaskMonitorAmendment,
  PersistentTaskMonitorEvent,
} from '../utils/persistent-task-monitor-reader.js';

export interface PersistentTaskMonitorSectionProps {
  data: PersistentTaskMonitorSectionData;
  tip?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + '...' : s;
}

function statusIcon(status: string): { icon: string; color: string } {
  switch (status) {
    case 'completed': return { icon: '*', color: 'green' };
    case 'in_progress': return { icon: '>', color: 'cyan' };
    case 'pending':
    case 'pending_review': return { icon: '-', color: 'gray' };
    default: return { icon: '\u25CF', color: 'gray' };
  }
}

function taskStatusColor(status: string): string {
  switch (status) {
    case 'active': return 'green';
    case 'paused': return 'yellow';
    case 'completed': return 'cyan';
    case 'failed': return 'red';
    default: return 'gray';
  }
}

function amendmentTypeLabel(type: string): string {
  switch (type) {
    case 'addendum': return 'add';
    case 'correction': return 'fix';
    case 'scope_change': return 'scope';
    case 'priority_shift': return 'prio';
    default: return type;
  }
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  } catch {
    return '??:??';
  }
}

// ============================================================================
// Sub-component: Sub-task Row
// ============================================================================

function SubTaskRow({ subTask, isLast }: { subTask: PersistentTaskMonitorSubTask; isLast: boolean }): React.ReactElement {
  const { icon, color } = statusIcon(subTask.status);
  const connector = isLast ? '\u2514\u2500 ' : '\u251C\u2500 ';
  const title = truncate(subTask.title, 36);

  const hasAgent = subTask.status === 'in_progress' && (subTask.agentStage !== null || subTask.agentElapsed !== null);

  return (
    <Box flexDirection="column">
      {/* Sub-task row */}
      <Box>
        <Text color="gray">{connector}</Text>
        <Text>{icon} </Text>
        <Box width={37}>
          <Text color="white">{title}</Text>
        </Box>
        <Text color="gray"> </Text>
        <Text color={color}>{subTask.status}</Text>
        {subTask.prUrl && (
          <Text color={subTask.prMerged ? 'green' : 'cyan'}>
            {' '}
            {subTask.prMerged ? '\u2713' : '\u25B6'} PR
          </Text>
        )}
      </Box>
      {/* Inline agent info */}
      {hasAgent && (
        <Box marginLeft={5}>
          <Text color="gray">{'\u2514\u2500 '}</Text>
          <Text color="cyan">Agent</Text>
          {subTask.agentId && (
            <Text color="gray"> {truncate(subTask.agentId, 10)}</Text>
          )}
          {subTask.agentStage && (
            <Text color="magenta"> [{subTask.agentStage}]</Text>
          )}
          {subTask.agentProgressPct !== null && (
            <Text color="yellow"> {subTask.agentProgressPct}%</Text>
          )}
          {subTask.agentElapsed && (
            <Text color="gray"> since {subTask.agentElapsed}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

// ============================================================================
// Sub-component: Amendments Summary
// ============================================================================

function AmendmentsSummary({ amendments, pendingCount }: {
  amendments: PersistentTaskMonitorAmendment[];
  pendingCount: number;
}): React.ReactElement {
  if (amendments.length === 0) {
    return (
      <Box>
        <Text color="gray">Amendments: </Text>
        <Text color="gray">none</Text>
      </Box>
    );
  }

  const ackCount = amendments.length - pendingCount;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="gray">Amendments: </Text>
        <Text color="white" bold>{amendments.length}</Text>
        <Text color="gray"> (</Text>
        <Text color="green">{ackCount} ack</Text>
        {pendingCount > 0 && (
          <>
            <Text color="gray">, </Text>
            <Text color="yellow" bold>{pendingCount} pending</Text>
          </>
        )}
        <Text color="gray">)</Text>
      </Box>
      {/* Show unacknowledged amendments inline */}
      {amendments
        .filter(a => !a.acknowledged)
        .map(a => (
          <Box key={a.id} marginLeft={2}>
            <Text color="yellow">[{amendmentTypeLabel(a.type)}] </Text>
            <Text color="white">{truncate(a.content, 60)}</Text>
          </Box>
        ))}
    </Box>
  );
}

// ============================================================================
// Sub-component: Recent Events
// ============================================================================

function RecentEventsLog({ events }: { events: PersistentTaskMonitorEvent[] }): React.ReactElement {
  if (events.length === 0) return <></>;

  return (
    <Box flexDirection="column">
      <Text color="gray" bold>Recent Activity:</Text>
      {events.map(event => (
        <Box key={event.id}>
          <Text color="gray">{formatTimestamp(event.timestamp)} </Text>
          <Text color="gray">{'\u2014'} </Text>
          <Text color="white">{truncate(event.details || event.type, 60)}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ============================================================================
// Sub-component: Monitor Status Line
// ============================================================================

function MonitorStatusLine({ task }: { task: PersistentTaskMonitorData }): React.ReactElement {
  let pidNode: React.ReactElement;

  if (task.monitorPid !== null && task.monitorAlive) {
    pidNode = (
      <>
        <Text color="gray">Monitor: </Text>
        <Text color="green">PID {task.monitorPid} (alive)</Text>
      </>
    );
  } else if (task.queueStatus === 'queued' || task.queueStatus === 'spawning') {
    pidNode = (
      <>
        <Text color="gray">Monitor: </Text>
        <Text color="yellow">{task.queueStatus}</Text>
        {task.queueElapsed && <Text color="gray"> ({task.queueElapsed})</Text>}
      </>
    );
  } else if (task.queueStatus === 'running') {
    pidNode = (
      <>
        <Text color="gray">Monitor: </Text>
        <Text color="cyan">running in queue</Text>
        {task.queueElapsed && <Text color="gray"> ({task.queueElapsed})</Text>}
      </>
    );
  } else {
    pidNode = (
      <>
        <Text color="gray">Monitor: </Text>
        <Text color="red" bold>DEAD</Text>
      </>
    );
  }

  const heartbeatColor = task.heartbeatStale ? 'yellow' : 'green';
  const heartbeatLabel = task.heartbeatStale && task.heartbeatAge !== '0m'
    ? `${task.heartbeatAge} (stale)`
    : `${task.heartbeatAge} ago`;

  return (
    <Box>
      {pidNode}
      <Text color="gray"> | HB: </Text>
      <Text color={heartbeatColor}>{heartbeatLabel}</Text>
      <Text color="gray"> | Cycles: </Text>
      <Text color="white">{task.cycleCount}</Text>
      {task.demoInvolved && <Text color="magenta"> [demo]</Text>}
      {task.strictInfraGuidance && <Text color="cyan"> [strict-infra]</Text>}
    </Box>
  );
}

// ============================================================================
// Sub-component: Task Card
// ============================================================================

function TaskCard({ task }: { task: PersistentTaskMonitorData }): React.ReactElement {
  const titleColor = taskStatusColor(task.status);
  const statusStr = task.status.toUpperCase();

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Task title + status */}
      <Box>
        <Text color={titleColor} bold>{truncate(task.title, 48)}</Text>
        <Text color="gray"> — </Text>
        <Text color={titleColor}>{statusStr}</Text>
        <Text color="gray"> ({task.age})</Text>
      </Box>

      {/* Monitor + heartbeat */}
      <Box marginLeft={2}>
        <MonitorStatusLine task={task} />
      </Box>

      {/* Sub-tasks tree */}
      {task.subTasks.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          <Text color="gray" bold>Sub-Tasks ({task.subTasks.length}):</Text>
          {task.subTasks.map((st, idx) => (
            <SubTaskRow
              key={st.id}
              subTask={st}
              isLast={idx === task.subTasks.length - 1}
            />
          ))}
        </Box>
      )}

      {/* Recent events */}
      {task.recentEvents.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          <RecentEventsLog events={task.recentEvents} />
        </Box>
      )}

      {/* Amendments */}
      <Box marginLeft={2} marginTop={task.recentEvents.length > 0 ? 0 : 1}>
        <AmendmentsSummary
          amendments={task.amendments}
          pendingCount={task.pendingAmendmentCount}
        />
      </Box>
    </Box>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function PersistentTaskMonitorSection({ data, tip }: PersistentTaskMonitorSectionProps): React.ReactElement {
  if (!data.hasData || data.tasks.length === 0) {
    return (
      <Section title="PERSISTENT TASK MONITOR" borderColor="white" tip={tip}>
        <Text color="gray">No active or paused persistent tasks. Use /persistent-task to create one.</Text>
      </Section>
    );
  }

  const { tasks, totalActive, totalPaused, monitorsAlive, monitorsDead, pendingAmendments } = data;

  // Border color: red if any dead monitor with no revival, yellow if pending amendments or stale heartbeat, green otherwise
  const hasUnrecoveredDead = monitorsDead > 0 && tasks.some(t => t.status === 'active' && !t.monitorAlive && t.queueStatus === null);
  const hasWarning = pendingAmendments > 0 || tasks.some(t => t.heartbeatStale && t.status === 'active');
  const borderColor = hasUnrecoveredDead ? 'red'
    : hasWarning ? 'yellow'
    : 'green';

  const titleParts: string[] = [];
  if (totalActive > 0) titleParts.push(`${totalActive} active`);
  if (totalPaused > 0) titleParts.push(`${totalPaused} paused`);
  titleParts.push(`${monitorsAlive} monitor${monitorsAlive !== 1 ? 's' : ''} alive`);
  if (pendingAmendments > 0) {
    titleParts.push(`${pendingAmendments} amendment${pendingAmendments !== 1 ? 's' : ''} pending`);
  }
  const title = `PERSISTENT TASK MONITOR (${titleParts.join(' | ')})`;

  return (
    <Section title={title} borderColor={borderColor} titleColor={borderColor} tip={tip}>
      <Box flexDirection="column">
        {tasks.map((task, idx) => (
          <React.Fragment key={task.id}>
            {idx > 0 && (
              <Box marginY={0}>
                <Text color="gray">{'\u2500'.repeat(60)}</Text>
              </Box>
            )}
            <TaskCard task={task} />
          </React.Fragment>
        ))}
      </Box>
    </Section>
  );
}
