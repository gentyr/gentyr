/**
 * Feedback Personas Component
 *
 * Table showing all configured user feedback personas:
 * - Name - persona identifier
 * - Mode - consumption mode (GUI, CLI, API, SDK)
 * - Status - active/disabled
 * - Sessions - count of feedback sessions run
 * - Satisfaction - latest satisfaction level
 * - Findings - count of issues found
 *
 * Footer shows: Total sessions and total findings
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import type { FeedbackPersonasData } from '../utils/data-reader.js';

// Column widths
const COL_NAME = 20;
const COL_MODE = 6;
const COL_STATUS = 10;
const COL_SESSIONS = 10;
const COL_SATISFACTION = 18;
const COL_FINDINGS = 10;

function satisfactionColor(level: string | null): string {
  if (!level) return 'gray';
  if (level === 'very_satisfied' || level === 'satisfied') return 'green';
  if (level === 'neutral') return 'yellow';
  return 'red';
}

function satisfactionLabel(level: string | null): string {
  if (!level) return '---';
  return level.replace(/_/g, ' ');
}

export function FeedbackPersonas({ data }: { data: FeedbackPersonasData }): React.ReactElement | null {
  if (data.personas.length === 0) return null;

  return (
    <Section title={`FEEDBACK PERSONAS (${data.personas.length})`} borderColor="blue">
      <Box flexDirection="column">
        {/* Header */}
        <Box>
          <Box width={COL_NAME}><Text color="gray" bold>Name</Text></Box>
          <Box width={COL_MODE}><Text color="gray" bold>Mode</Text></Box>
          <Box width={COL_STATUS}><Text color="gray" bold>Status</Text></Box>
          <Box width={COL_SESSIONS}><Text color="gray" bold>Sessions</Text></Box>
          <Box width={COL_SATISFACTION}><Text color="gray" bold>Satisfaction</Text></Box>
          <Box width={COL_FINDINGS}><Text color="gray" bold>Findings</Text></Box>
        </Box>

        {/* Rows */}
        {data.personas.map((p) => (
          <Box key={p.name}>
            <Box width={COL_NAME}><Text>{p.name}</Text></Box>
            <Box width={COL_MODE}><Text color="cyan">{p.consumption_mode}</Text></Box>
            <Box width={COL_STATUS}>
              <Text color={p.enabled ? 'green' : 'gray'}>{p.enabled ? 'active' : 'disabled'}</Text>
            </Box>
            <Box width={COL_SESSIONS}><Text>{p.session_count}</Text></Box>
            <Box width={COL_SATISFACTION}>
              <Text color={satisfactionColor(p.last_satisfaction)}>{satisfactionLabel(p.last_satisfaction)}</Text>
            </Box>
            <Box width={COL_FINDINGS}>
              <Text color={p.findings_count > 0 ? 'yellow' : 'green'}>{p.findings_count}</Text>
            </Box>
          </Box>
        ))}

        {/* Footer */}
        <Box marginTop={1}>
          <Text color="gray">Total: {data.total_sessions} sessions, {data.total_findings} findings</Text>
        </Box>
      </Box>
    </Section>
  );
}
