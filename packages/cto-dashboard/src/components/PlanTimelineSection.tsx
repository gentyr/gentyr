/**
 * Plan Timeline Section Component — State change timeline with compact arrows
 *
 * Shows chronological state changes with context.
 * White + Gray only design.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import type { PlanTimelineData, PlanTimelineEntry } from '../utils/plan-reader.js';

export interface PlanTimelineSectionProps {
  data: PlanTimelineData;
  tip?: string;
}

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function TimelineRow({ entry }: { entry: PlanTimelineEntry }): React.ReactElement {
  const time = formatTime(entry.time);
  const indent = entry.entity_type === 'substep';
  const prefix = indent ? '  \u2514 ' : '  ';
  const label = entry.label.length > 28 ? entry.label.substring(0, 25) + '...' : entry.label;
  const action = entry.new_value || 'changed';
  const detail = entry.old_value
    ? `${entry.field}: ${entry.old_value} \u2192 ${entry.new_value}`
    : `${entry.field}: ${entry.new_value}`;

  return (
    <Box>
      <Text color="gray">{time}  </Text>
      <Text color="gray">{prefix}</Text>
      <Text color={indent ? 'gray' : 'white'}>{label.padEnd(28)}</Text>
      <Text color="gray"> {'\u2192'} </Text>
      <Text color="white">{action.padEnd(12)}</Text>
      <Text color="gray"> {detail}</Text>
    </Box>
  );
}

export function PlanTimelineSection({ data, tip }: PlanTimelineSectionProps): React.ReactElement {
  if (!data.hasData || data.entries.length === 0) {
    return (
      <Section title="PLAN TIMELINE" borderColor="white" tip={tip}>
        <Text color="gray">No plan state changes in the last 24 hours.</Text>
      </Section>
    );
  }

  return (
    <Section title={`PLAN TIMELINE (${data.entries.length} events)`} borderColor="white" tip={tip}>
      <Box flexDirection="column">
        {data.entries.map((entry, idx) => (
          <TimelineRow key={idx} entry={entry} />
        ))}
      </Box>
    </Section>
  );
}
