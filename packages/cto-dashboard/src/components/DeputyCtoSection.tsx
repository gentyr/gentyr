/**
 * Deputy CTO Section Component
 *
 * Shows triage pipeline data:
 * - Summary metric boxes (untriaged, escalated, pending Q, 24h handled/dismissed)
 * - Untriaged reports (pending CTO attention)
 * - Escalated reports
 * - CTO questions (pending + answered)
 * - Recently triaged (24h summary)
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { formatTimeAgo } from '../utils/formatters.js';
import type { DeputyCtoData, TriagedReport, PendingQuestion, AnsweredQuestion } from '../utils/deputy-cto-reader.js';

export interface DeputyCtoSectionProps {
  data: DeputyCtoData;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

// Column widths
const COL_ICON = 3;
const COL_TITLE = 35;
const COL_PRIORITY = 10;
const COL_TIME = 12;
const COL_OUTCOME = 12;
const COL_ANSWER = 26;

const TOTAL_WIDTH = COL_ICON + COL_TITLE + COL_PRIORITY + COL_TIME;

function priorityColor(priority: string): string {
  switch (priority?.toLowerCase()) {
    case 'critical': return 'red';
    case 'high': return 'yellow';
    case 'medium': return 'white';
    case 'low': return 'gray';
    default: return 'gray';
  }
}

function outcomeIcon(status: string): { icon: string; color: string } {
  switch (status) {
    case 'self_handled': return { icon: '\u2713', color: 'green' };
    case 'escalated': return { icon: '\u2191', color: 'yellow' };
    case 'dismissed': return { icon: '\u2715', color: 'gray' };
    default: return { icon: '\u2022', color: 'white' };
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

// ────────────────────────────────────────────────────────────────
// Summary Metrics
// ────────────────────────────────────────────────────────────────

function SummaryMetrics({ data }: { data: DeputyCtoData }): React.ReactElement {
  return (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      <Section minWidth={14} paddingX={1} borderColor={data.untriagedCount > 0 ? 'yellow' : 'gray'}>
        <Text color="gray">Untriaged</Text>
        <Text color={data.untriagedCount > 0 ? 'yellow' : 'gray'} bold>{data.untriagedCount}</Text>
      </Section>
      <Section minWidth={14} paddingX={1} borderColor={data.escalated.length > 0 ? 'red' : 'gray'}>
        <Text color="gray">Escalated</Text>
        <Text color={data.escalated.length > 0 ? 'red' : 'gray'} bold>{data.escalated.length}</Text>
      </Section>
      <Section minWidth={14} paddingX={1} borderColor={data.pendingQuestionCount > 0 ? 'yellow' : 'gray'}>
        <Text color="gray">Pending Q</Text>
        <Text color={data.pendingQuestionCount > 0 ? 'yellow' : 'gray'} bold>{data.pendingQuestionCount}</Text>
      </Section>
      <Section minWidth={14} paddingX={1} borderColor="gray">
        <Text color="gray">24h Handled</Text>
        <Text color="green" bold>{data.selfHandled24h}</Text>
      </Section>
      <Section minWidth={14} paddingX={1} borderColor={data.escalated24h > 0 ? 'yellow' : 'gray'}>
        <Text color="gray">24h Escalated</Text>
        <Text color={data.escalated24h > 0 ? 'yellow' : 'gray'} bold>{data.escalated24h}</Text>
      </Section>
      <Section minWidth={14} paddingX={1} borderColor="gray">
        <Text color="gray">24h Dismissed</Text>
        <Text color="gray" bold>{data.dismissed24h}</Text>
      </Section>
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────
// Table Components
// ────────────────────────────────────────────────────────────────

function ReportTableHeader({ showOutcome }: { showOutcome?: boolean }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={COL_ICON} />
        <Box width={COL_TITLE}><Text color="gray" bold>Title</Text></Box>
        <Box width={COL_PRIORITY}><Text color="gray" bold>Priority</Text></Box>
        {showOutcome && <Box width={COL_OUTCOME}><Text color="gray" bold>Outcome</Text></Box>}
        <Box width={COL_TIME}><Text color="gray" bold>Time</Text></Box>
      </Box>
      <Text color="gray">{'\u2500'.repeat(showOutcome ? TOTAL_WIDTH + COL_OUTCOME : TOTAL_WIDTH)}</Text>
    </Box>
  );
}

function ReportRow({ report, showOutcome }: { report: TriagedReport; showOutcome?: boolean }): React.ReactElement {
  const timeStr = report.triage_completed_at
    ? formatTimeAgo(report.triage_completed_at)
    : formatTimeAgo(report.created_at);

  return (
    <Box flexDirection="row">
      <Box width={COL_ICON}>
        <Text color={priorityColor(report.priority)}>{'\u25C6'} </Text>
      </Box>
      <Box width={COL_TITLE}>
        <Text color="white">{truncate(report.title, COL_TITLE - 2)}</Text>
      </Box>
      <Box width={COL_PRIORITY}>
        <Text color={priorityColor(report.priority)}>{report.priority || '-'}</Text>
      </Box>
      {showOutcome && (
        <Box width={COL_OUTCOME}>
          <Text color={outcomeIcon(report.triage_status).color}>
            {outcomeIcon(report.triage_status).icon} {formatTriageStatus(report.triage_status)}
          </Text>
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
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={COL_ICON}>
          <Text color="yellow">? </Text>
        </Box>
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
      {question.recommendation && (
        <Box marginLeft={COL_ICON}>
          <Text color="gray">{'\u2514\u2500 '}</Text>
          <Text color="cyan">{truncate(question.recommendation, COL_TITLE + COL_PRIORITY - 4)}</Text>
        </Box>
      )}
    </Box>
  );
}

function QuestionTableHeader(): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={COL_ICON} />
        <Box width={COL_TITLE}><Text color="gray" bold>Title</Text></Box>
        <Box width={COL_PRIORITY}><Text color="gray" bold>Type</Text></Box>
        <Box width={COL_TIME}><Text color="gray" bold>Time</Text></Box>
      </Box>
      <Text color="gray">{'\u2500'.repeat(TOTAL_WIDTH)}</Text>
    </Box>
  );
}

function AnsweredTableHeader(): React.ReactElement {
  const width = COL_ICON + COL_TITLE + COL_ANSWER + COL_TIME;
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={COL_ICON} />
        <Box width={COL_TITLE}><Text color="gray" bold>Question</Text></Box>
        <Box width={COL_ANSWER}><Text color="gray" bold>Answer</Text></Box>
        <Box width={COL_TIME}><Text color="gray" bold>Time</Text></Box>
      </Box>
      <Text color="gray">{'\u2500'.repeat(width)}</Text>
    </Box>
  );
}

function AnsweredRow({ question }: { question: AnsweredQuestion }): React.ReactElement {
  const timeStr = formatTimeAgo(question.answered_at);
  const answer = question.answer ? truncate(question.answer, COL_ANSWER - 2) : '-';

  return (
    <Box flexDirection="row">
      <Box width={COL_ICON}>
        <Text color="green">{'\u2713'} </Text>
      </Box>
      <Box width={COL_TITLE}>
        <Text color="white">{truncate(question.title, COL_TITLE - 2)}</Text>
      </Box>
      <Box width={COL_ANSWER}>
        <Text color="green">{answer}</Text>
      </Box>
      <Box width={COL_TIME}>
        <Text color="gray">{timeStr}</Text>
      </Box>
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────
// Subsection Headers
// ────────────────────────────────────────────────────────────────

function SubsectionHeader({ icon, label, count, color }: {
  icon: string;
  label: string;
  count?: number;
  color: string;
}): React.ReactElement {
  return (
    <Box>
      <Text color={color} bold>{icon} {label}</Text>
      {count !== undefined && <Text color={color} bold> ({count})</Text>}
    </Box>
  );
}

function Divider(): React.ReactElement {
  return (
    <Box marginY={0}>
      <Text color="gray">{'\u2500'.repeat(TOTAL_WIDTH)}</Text>
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────
// Main Component
// ────────────────────────────────────────────────────────────────

export function DeputyCtoSection({ data }: DeputyCtoSectionProps): React.ReactElement | null {
  if (!data.hasData) return null;

  const hasUntriaged = data.untriaged.length > 0;
  const hasEscalated = data.escalated.length > 0;
  const hasRecentlyTriaged = data.recentlyTriaged.length > 0;
  const hasPendingQuestions = data.pendingQuestions.length > 0;
  const hasAnsweredQuestions = data.answeredQuestions.length > 0;
  const hasActionItems = hasUntriaged || hasEscalated || hasPendingQuestions;
  const hasHistory = hasRecentlyTriaged || hasAnsweredQuestions;

  return (
    <Section title="DEPUTY CTO" borderColor="yellow">
      <Box flexDirection="column">
        {/* Summary metric boxes */}
        <SummaryMetrics data={data} />

        {/* ── Action Required ────────────────────────────────── */}

        {/* Untriaged reports */}
        {hasUntriaged && (
          <Box flexDirection="column" marginTop={1}>
            <SubsectionHeader icon={'\u25C6'} label="UNTRIAGED" count={data.untriagedCount} color="yellow" />
            <ReportTableHeader />
            {data.untriaged.map((r, i) => (
              <ReportRow key={`u-${i}`} report={r} />
            ))}
          </Box>
        )}

        {/* Escalated reports */}
        {hasEscalated && (
          <Box flexDirection="column" marginTop={1}>
            <SubsectionHeader icon={'\u25B2'} label="ESCALATED" color="red" />
            <ReportTableHeader />
            {data.escalated.map((r, i) => (
              <ReportRow key={`e-${i}`} report={r} />
            ))}
          </Box>
        )}

        {/* Pending CTO questions */}
        {hasPendingQuestions && (
          <Box flexDirection="column" marginTop={1}>
            <SubsectionHeader icon="?" label="PENDING QUESTIONS" count={data.pendingQuestionCount} color="yellow" />
            <QuestionTableHeader />
            {data.pendingQuestions.map((q, i) => (
              <QuestionRow key={`pq-${i}`} question={q} />
            ))}
          </Box>
        )}

        {/* ── Separator between action items and history ────── */}
        {hasActionItems && hasHistory && (
          <Box marginTop={1}>
            <Divider />
          </Box>
        )}

        {/* ── Historical (24h) ───────────────────────────────── */}

        {/* Recently triaged (24h) */}
        {hasRecentlyTriaged && (
          <Box flexDirection="column" marginTop={1}>
            <SubsectionHeader icon={'\u25CB'} label="Recently Triaged" color="gray" />
            <ReportTableHeader showOutcome />
            {data.recentlyTriaged.map((r, i) => (
              <ReportRow key={`rt-${i}`} report={r} showOutcome />
            ))}
          </Box>
        )}

        {/* Answered questions (24h) */}
        {hasAnsweredQuestions && (
          <Box flexDirection="column" marginTop={1}>
            <SubsectionHeader icon={'\u2713'} label="Answered Questions" color="gray" />
            <AnsweredTableHeader />
            {data.answeredQuestions.map((q, i) => (
              <AnsweredRow key={`aq-${i}`} question={q} />
            ))}
          </Box>
        )}
      </Box>
    </Section>
  );
}
