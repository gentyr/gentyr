/**
 * Feedback Personas Component
 *
 * Shows feedback persona data:
 * - Empty state when no personas are configured
 * - Satisfaction distribution summary (row of mini Section boxes)
 * - Per-persona blocks with status line + recent reports
 * - Footer with total sessions and findings
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { formatTimeAgo } from '../utils/formatters.js';
import type { FeedbackPersonasData, FeedbackPersonaSummary, PersonaReport, SatisfactionDistribution } from '../utils/data-reader.js';

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

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

function priorityColor(priority: string): string {
  switch (priority?.toLowerCase()) {
    case 'critical': return 'red';
    case 'high': return 'yellow';
    case 'normal': return 'white';
    case 'low': return 'gray';
    default: return 'gray';
  }
}

function triageStatusLabel(status: string): { label: string; color: string } {
  switch (status) {
    case 'pending': return { label: 'pending', color: 'yellow' };
    case 'in_progress': return { label: 'in progress', color: 'cyan' };
    case 'self_handled': return { label: 'handled', color: 'green' };
    case 'escalated': return { label: 'escalated', color: 'red' };
    case 'dismissed': return { label: 'dismissed', color: 'gray' };
    default: return { label: status, color: 'gray' };
  }
}

// ────────────────────────────────────────────────────────────────
// Satisfaction Summary
// ────────────────────────────────────────────────────────────────

function SatisfactionSummary({ dist }: { dist: SatisfactionDistribution }): React.ReactElement {
  const total = dist.very_satisfied + dist.satisfied + dist.neutral + dist.dissatisfied + dist.very_dissatisfied;
  if (total === 0) {
    return (
      <Box>
        <Text color="gray">No satisfaction data yet</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      <Section minWidth={16} paddingX={1} borderColor={dist.very_satisfied > 0 ? 'green' : 'gray'}>
        <Text color="gray">V.Satisfied</Text>
        <Text color="green" bold>{dist.very_satisfied}</Text>
      </Section>
      <Section minWidth={14} paddingX={1} borderColor={dist.satisfied > 0 ? 'green' : 'gray'}>
        <Text color="gray">Satisfied</Text>
        <Text color="green" bold>{dist.satisfied}</Text>
      </Section>
      <Section minWidth={14} paddingX={1} borderColor={dist.neutral > 0 ? 'yellow' : 'gray'}>
        <Text color="gray">Neutral</Text>
        <Text color="yellow" bold>{dist.neutral}</Text>
      </Section>
      <Section minWidth={16} paddingX={1} borderColor={dist.dissatisfied > 0 ? 'red' : 'gray'}>
        <Text color="gray">Dissatisfied</Text>
        <Text color="red" bold>{dist.dissatisfied}</Text>
      </Section>
      <Section minWidth={18} paddingX={1} borderColor={dist.very_dissatisfied > 0 ? 'red' : 'gray'}>
        <Text color="gray">V.Dissatisfied</Text>
        <Text color="red" bold>{dist.very_dissatisfied}</Text>
      </Section>
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────
// Report Sub-Row
// ────────────────────────────────────────────────────────────────

const RPT_ICON = 5;
const RPT_TITLE = 34;
const RPT_PRIORITY = 10;
const RPT_STATUS = 12;
const RPT_TIME = 10;

function ReportSubRow({ report }: { report: PersonaReport }): React.ReactElement {
  const timeStr = formatTimeAgo(report.created_at);
  const { label, color } = triageStatusLabel(report.triage_status);

  return (
    <Box flexDirection="row">
      <Box width={RPT_ICON}>
        <Text color={priorityColor(report.priority)}>{'\u25C6'} </Text>
      </Box>
      <Box width={RPT_TITLE}>
        <Text color="white">{truncate(report.title, RPT_TITLE - 2)}</Text>
      </Box>
      <Box width={RPT_PRIORITY}>
        <Text color={priorityColor(report.priority)}>{report.priority}</Text>
      </Box>
      <Box width={RPT_STATUS}>
        <Text color={color}>{label}</Text>
      </Box>
      <Box width={RPT_TIME}>
        <Text color="gray">{timeStr}</Text>
      </Box>
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────
// Persona Block
// ────────────────────────────────────────────────────────────────

function PersonaBlock({ persona }: { persona: FeedbackPersonaSummary }): React.ReactElement {
  const statusColor = persona.enabled ? 'green' : 'gray';
  const statusText = persona.enabled ? 'active' : 'disabled';

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Persona header line */}
      <Box>
        <Text color="cyan" bold>{persona.name}</Text>
        <Text color="gray"> ({persona.consumption_mode}) </Text>
        <Text color={statusColor}>{statusText}</Text>
        <Text color="gray"> | </Text>
        <Text>{persona.session_count} sessions</Text>
        <Text color="gray"> | </Text>
        <Text color={satisfactionColor(persona.last_satisfaction)}>{satisfactionLabel(persona.last_satisfaction)}</Text>
        <Text color="gray"> | </Text>
        <Text color={persona.findings_count > 0 ? 'yellow' : 'green'}>{persona.findings_count} findings</Text>
      </Box>

      {/* Report rows (indented) */}
      {persona.recent_reports.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {persona.recent_reports.map((r) => (
            <ReportSubRow key={r.id} report={r} />
          ))}
        </Box>
      ) : (
        <Box marginLeft={2}>
          <Text color="gray">No recent reports</Text>
        </Box>
      )}
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────
// Main Component
// ────────────────────────────────────────────────────────────────

export function FeedbackPersonas({ data }: { data: FeedbackPersonasData }): React.ReactElement {
  // Empty state
  if (data.personas.length === 0) {
    return (
      <Section title="FEEDBACK PERSONAS" borderColor="blue">
        <Box flexDirection="column">
          <Text color="gray">
            No personas configured yet. Use /configure-personas to set up
          </Text>
          <Text color="gray">
            AI user testing, or ask Claude directly — persona management
          </Text>
          <Text color="gray">
            is fully supported via MCP.
          </Text>
        </Box>
      </Section>
    );
  }

  return (
    <Section title={`FEEDBACK PERSONAS (${data.personas.length})`} borderColor="blue">
      <Box flexDirection="column">
        {/* Satisfaction distribution */}
        <SatisfactionSummary dist={data.satisfaction_distribution} />

        {/* Per-persona blocks */}
        {data.personas.map((p) => (
          <PersonaBlock key={p.name} persona={p} />
        ))}

        {/* Footer */}
        <Box marginTop={1}>
          <Text color="gray">Total: {data.total_sessions} sessions, {data.total_findings} findings</Text>
        </Box>
      </Box>
    </Section>
  );
}
