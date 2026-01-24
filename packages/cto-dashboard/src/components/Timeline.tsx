/**
 * Timeline component - vertical list of timeline events
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { TimelineItem, type TimelineEvent } from './TimelineItem.js';

export interface TimelineProps {
  events: TimelineEvent[];
  maxEvents?: number;
  title?: string;
  hours?: number;
}

export function Timeline({
  events,
  maxEvents = 20,
  title,
  hours = 24,
}: TimelineProps): React.ReactElement {
  // Sort by timestamp descending (most recent first)
  const sortedEvents = [...events]
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, maxEvents);

  const displayTitle = title || `TIMELINE (${hours}h)`;

  return (
    <Section title={displayTitle} borderColor="blue">
      {sortedEvents.length === 0 ? (
        <Text color="gray">No events in the last {hours} hours</Text>
      ) : (
        <Box flexDirection="column">
          {sortedEvents.map((event, idx) => (
            <TimelineItem key={idx} event={event} />
          ))}
        </Box>
      )}
    </Section>
  );
}
