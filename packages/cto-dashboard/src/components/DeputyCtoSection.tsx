/**
 * Deputy CTO Section Component
 *
 * Shows triage pipeline data:
 * - Untriaged reports (pending CTO attention)
 * - Recently triaged (24h summary)
 * - Escalated reports
 * - CTO questions (pending + answered)
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import type { DeputyCtoData, TriagedReport, PendingQuestion, AnsweredQuestion } from '../utils/deputy-cto-reader.js';

export interface DeputyCtoSectionProps {
  data: DeputyCtoData;
}

function formatTimeAgo(isoStr: string): string {
  const now = Date.now();
  const then = new Date(isoStr).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

const COL_TITLE = 45;
const COL_PRIORITY = 10;
const COL_TIME = 12;

function priorityColor(priority: string): string {
  switch (priority?.toLowerCase()) {
    case 'critical': return 'red';
    case 'high': return 'yellow';
    case 'medium': return 'white';
    case 'low': return 'gray';
    default: return 'gray';
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'self_handled': return 'green';
    case 'escalated': return 'yellow';
    case 'dismissed': return 'gray';
    default: return 'white';
  }
}

function formatTriageStatus(status: string): string {
  switch (status) {
    case 'self_handled': return 'Handled';
    case 'escalated': return 'Escalated';
    case 'dismissed': return 'Dismissed';
    default: return status;
  }
}

function ReportRow({ report, showOutcome }: { report: TriagedReport; showOutcome?: boolean }): React.ReactElement {
  const timeStr = report.triage_completed_at
    ? formatTimeAgo(report.triage_completed_at)
    : formatTimeAgo(report.created_at);

  return (
    <Box flexDirection="row">
      <Box width={COL_TITLE}>
        <Text color="white">{truncate(report.title, COL_TITLE - 2)}</Text>
      </Box>
      <Box width={COL_PRIORITY}>
        <Text color={priorityColor(report.priority)}>{report.priority || '-'}</Text>
      </Box>
      {showOutcome && (
        <Box width={14}>
          <Text color={statusColor(report.triage_status)}>{formatTriageStatus(report.triage_status)}</Text>
        </Box>
      )}
      <Box width={COL_TIME}>
        <Text color="gray">{timeStr}</Text>
      </Box>
    </Box>
  );
}

function QuestionRow({ question }: { question: PendingQuestion }): React.ReactElement {
  const timeStr = formatTimeAgo(question.created_at);

  return (
    <Box flexDirection="row">
      <Box width={COL_TITLE}>
        <Text color="yellow">{truncate(question.title, COL_TITLE - 2)}</Text>
      </Box>
      <Box width={COL_PRIORITY}>
        <Text color="cyan">{question.type}</Text>
      </Box>
      <Box width={COL_TIME}>
        <Text color="gray">{timeStr}</Text>
      </Box>
    </Box>
  );
}

function AnsweredRow({ question }: { question: AnsweredQuestion }): React.ReactElement {
  const timeStr = formatTimeAgo(question.answered_at);
  const answer = question.answer ? truncate(question.answer, 35) : '-';

  return (
    <Box flexDirection="row">
      <Box width={COL_TITLE}>
        <Text color="white">{truncate(question.title, COL_TITLE - 2)}</Text>
      </Box>
      <Box width={35}>
        <Text color="green">{answer}</Text>
      </Box>
      <Box width={COL_TIME}>
        <Text color="gray">{timeStr}</Text>
      </Box>
    </Box>
  );
}

export function DeputyCtoSection({ data }: DeputyCtoSectionProps): React.ReactElement | null {
  if (!data.hasData) return null;

  const hasUntriaged = data.untriaged.length > 0;
  const hasEscalated = data.escalated.length > 0;
  const hasRecentlyTriaged = data.recentlyTriaged.length > 0;
  const hasPendingQuestions = data.pendingQuestions.length > 0;
  const hasAnsweredQuestions = data.answeredQuestions.length > 0;

  return (
    <Section title="DEPUTY CTO" borderColor="yellow">
      <Box flexDirection="column">
        {/* Untriaged reports */}
        {hasUntriaged && (
          <Box flexDirection="column">
            <Text color="yellow" bold>Untriaged ({data.untriagedCount})</Text>
            {data.untriaged.map((r, i) => (
              <ReportRow key={`u-${i}`} report={r} />
            ))}
          </Box>
        )}

        {/* Escalated reports */}
        {hasEscalated && (
          <Box flexDirection="column" marginTop={hasUntriaged ? 1 : 0}>
            <Text color="red" bold>Escalated</Text>
            {data.escalated.map((r, i) => (
              <ReportRow key={`e-${i}`} report={r} />
            ))}
          </Box>
        )}

        {/* Pending CTO questions */}
        {hasPendingQuestions && (
          <Box flexDirection="column" marginTop={hasUntriaged || hasEscalated ? 1 : 0}>
            <Text color="yellow" bold>Pending Questions ({data.pendingQuestionCount})</Text>
            {data.pendingQuestions.map((q, i) => (
              <QuestionRow key={`pq-${i}`} question={q} />
            ))}
          </Box>
        )}

        {/* Recently triaged (24h) */}
        {hasRecentlyTriaged && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray" bold>Recently Triaged (24h)</Text>
            {data.recentlyTriaged.map((r, i) => (
              <ReportRow key={`rt-${i}`} report={r} showOutcome />
            ))}
          </Box>
        )}

        {/* Answered questions (24h) */}
        {hasAnsweredQuestions && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray" bold>Answered Questions (24h)</Text>
            {data.answeredQuestions.map((q, i) => (
              <AnsweredRow key={`aq-${i}`} question={q} />
            ))}
          </Box>
        )}

        {/* Summary line */}
        <Box marginTop={1}>
          <Text color="gray">24h: </Text>
          <Text color="green">Self-handled: {data.selfHandled24h}</Text>
          <Text color="gray"> | </Text>
          <Text color="yellow">Escalated: {data.escalated24h}</Text>
          <Text color="gray"> | </Text>
          <Text color="gray">Dismissed: {data.dismissed24h}</Text>
          <Text color="gray"> | </Text>
          <Text color="yellow">Pending Q: {data.pendingQuestionCount}</Text>
        </Box>
      </Box>
    </Section>
  );
}
