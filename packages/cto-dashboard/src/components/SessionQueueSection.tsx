/**
 * Session Queue Section Component — Session queue status (compact)
 *
 * Shows running sessions, queued sessions, capacity, and 24h throughput.
 * White + Gray only design with red/yellow/green color coding for capacity.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import type { SessionQueueData, QueuedItem, RunningItem } from '../utils/session-queue-reader.js';

export interface SessionQueueSectionProps {
  data: SessionQueueData;
  tip?: string;
}

function priorityIndicator(priority: string): string {
  if (priority === 'cto') return '>>>';
  if (priority === 'critical') return '!! ';
  if (priority === 'urgent') return '!  ';
  return '   ';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + '...' : s;
}

function QueuedRow({ item }: { item: QueuedItem }): React.ReactElement {
  const indicator = priorityIndicator(item.priority);
  const isCto = item.priority === 'cto';
  const indicatorColor = isCto ? 'magenta'
    : item.priority === 'critical' ? 'red'
    : item.priority === 'urgent' ? 'yellow'
    : 'gray';
  const title = truncate(item.title, 40);

  return (
    <Box>
      <Text color={indicatorColor} bold={isCto}>{indicator} </Text>
      <Text color={isCto ? 'magenta' : 'white'} bold={isCto}>{title.padEnd(41)}</Text>
      <Text color="gray"> {item.source.substring(0, 20).padEnd(21)}</Text>
      <Text color="gray">{item.waitTime.padStart(6)}</Text>
    </Box>
  );
}

function RunningRow({ item }: { item: RunningItem }): React.ReactElement {
  const title = truncate(item.title, 38);

  return (
    <Box>
      <Text color="cyan">  </Text>
      <Text color="white">{title.padEnd(39)}</Text>
      <Text color="gray"> {item.source.substring(0, 18).padEnd(19)}</Text>
      <Text color="gray">PID {item.pid} </Text>
      <Text color="gray">{item.elapsed.padStart(5)}</Text>
      {item.lastTool && (
        <>
          <Text color="gray"> </Text>
          <Text color="cyan">[{truncate(item.lastTool, 20)}]</Text>
        </>
      )}
    </Box>
  );
}

export function SessionQueueSection({ data, tip }: SessionQueueSectionProps): React.ReactElement {
  if (!data.hasData) {
    return (
      <Section title="SESSION QUEUE" borderColor="white" tip={tip}>
        <Text color="gray">No queue data available</Text>
      </Section>
    );
  }

  const { maxConcurrent, running, availableSlots, queuedItems, runningItems, stats } = data;

  // Separate suspended items from regular queued items (suspended items have 'suspended' in source or lane)
  const suspendedItems = queuedItems.filter(item => item.source === 'suspended' || item.lane === 'suspended');
  const activeQueuedItems = queuedItems.filter(item => item.source !== 'suspended' && item.lane !== 'suspended');
  const ctoPriorityQueued = activeQueuedItems.filter(item => item.priority === 'cto');
  const regularQueued = activeQueuedItems.filter(item => item.priority !== 'cto');

  // Color coding: green if >25% slots available, yellow if >75% full, red if at capacity or items queued
  const utilizationPct = running / maxConcurrent;
  const hasCtoItems = ctoPriorityQueued.length > 0;
  const titleColor = hasCtoItems ? 'magenta'
    : activeQueuedItems.length > 0 || utilizationPct >= 1
    ? 'red'
    : utilizationPct >= 0.75
    ? 'yellow'
    : 'green';

  const title = `SESSION QUEUE (${running}/${maxConcurrent} running, ${activeQueuedItems.length} queued${suspendedItems.length > 0 ? `, ${suspendedItems.length} suspended` : ''})`;
  const topSources = Object.entries(stats.bySource).slice(0, 3).map(([src, cnt]) => `${src}:${cnt}`).join(', ');

  return (
    <Section title={title} borderColor={titleColor} titleColor={titleColor} tip={tip}>
      <Box flexDirection="column">
        {/* Capacity bar */}
        <Box marginBottom={activeQueuedItems.length > 0 || runningItems.length > 0 ? 1 : 0}>
          <Text color="gray">Capacity: </Text>
          <Text color={titleColor} bold>{running}/{maxConcurrent}</Text>
          <Text color="gray"> ({availableSlots} slot{availableSlots !== 1 ? 's' : ''} available)</Text>
          {stats.completedLast24h > 0 && (
            <>
              <Text color="gray">  |  </Text>
              <Text color="white">{stats.completedLast24h} completed/24h</Text>
            </>
          )}
          {stats.avgWaitSeconds > 0 && (
            <>
              <Text color="gray">  avg wait </Text>
              <Text color="white">{stats.avgWaitSeconds}s</Text>
            </>
          )}
        </Box>

        {/* Running items */}
        {runningItems.length > 0 && (
          <Box flexDirection="column" marginBottom={activeQueuedItems.length > 0 || suspendedItems.length > 0 ? 1 : 0}>
            <Box>
              <Text color="cyan" bold>RUNNING</Text>
            </Box>
            {runningItems.map(item => (
              <RunningRow key={item.id} item={item} />
            ))}
          </Box>
        )}

        {/* CTO-priority queued items (shown separately with magenta) */}
        {ctoPriorityQueued.length > 0 && (
          <Box flexDirection="column" marginBottom={regularQueued.length > 0 || suspendedItems.length > 0 ? 1 : 0}>
            <Box>
              <Text color="magenta" bold>CTO PRIORITY</Text>
            </Box>
            {ctoPriorityQueued.map(item => (
              <QueuedRow key={item.id} item={item} />
            ))}
          </Box>
        )}

        {/* Regular queued items */}
        {regularQueued.length > 0 && (
          <Box flexDirection="column" marginBottom={suspendedItems.length > 0 ? 1 : 0}>
            <Box>
              <Text color="yellow" bold>QUEUED</Text>
            </Box>
            {regularQueued.map(item => (
              <QueuedRow key={item.id} item={item} />
            ))}
          </Box>
        )}

        {/* Suspended items */}
        {suspendedItems.length > 0 && (
          <Box flexDirection="column">
            <Box>
              <Text color="gray" bold>SUSPENDED</Text>
            </Box>
            {suspendedItems.map(item => (
              <QueuedRow key={item.id} item={item} />
            ))}
          </Box>
        )}

        {/* Stats row */}
        {topSources && (
          <Box marginTop={runningItems.length > 0 || activeQueuedItems.length > 0 ? 1 : 0}>
            <Text color="gray">Sources (24h): </Text>
            <Text color="white">{topSources}</Text>
          </Box>
        )}

        {/* All-clear message */}
        {runningItems.length === 0 && activeQueuedItems.length === 0 && suspendedItems.length === 0 && (
          <Text color="gray">Queue empty — {availableSlots} slot{availableSlots !== 1 ? 's' : ''} available</Text>
        )}
      </Box>
    </Section>
  );
}
