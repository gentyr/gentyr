/**
 * Page 2: Intelligence + Infrastructure — two-column layout. Monochrome.
 *
 * Left:  Accounts, Deputy-CTO Detail, Personas, Product-Market Fit
 * Right: Testing, Deployments, Worktrees, Infra, Logging, Timeline
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from '../Section.js';
import type { Page2Data, Page3Data, TriageReport, PendingQuestion, FeedbackPersona, AccountInfo, DeploymentItem, WorktreeInfo, TimelineEvent } from '../../types.js';
import { formatTimeAgo, formatTimestamp, truncate } from '../../utils/formatters.js';

interface Page2Props {
  data: Page2Data;
  infra: Page3Data;
  scrollOffset: number;
  height: number;
  width: number;
}

// ============================================================================
// Left column sections (Intelligence)
// ============================================================================

function AccountOverviewSection({ accounts, width }: { accounts: AccountInfo[]; width: number }): React.ReactElement {
  if (accounts.length === 0) return <></>;
  return (
    <Section title={`ACCOUNT OVERVIEW (${accounts.length})`} width={width} tip="/show accounts">
      {accounts.map(a => (
        <Box key={a.email}>
          <Text>{truncate(a.email, 24).padEnd(25)}</Text>
          <Text bold>{a.status.padEnd(8)}</Text>
          <Text dimColor>{a.subscription.padEnd(10)}</Text>
          <Text dimColor>5h:{a.fiveHourPct}% 7d:{a.sevenDayPct}%</Text>
        </Box>
      ))}
    </Section>
  );
}

function DeputyCtoDetailSection({ data, width }: { data: Page2Data['deputyCto']; width: number }): React.ReactElement {
  if (!data.hasData) return <></>;
  return (
    <Section title="DEPUTY-CTO DETAIL" width={width} tip="/show deputy-cto">
      <Box flexDirection="column">
        {data.untriaged.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>Untriaged ({data.untriaged.length})</Text>
            {data.untriaged.map((r: TriageReport) => (
              <Box key={r.id}>
                <Text bold>{r.priority.padEnd(8)}</Text>
                <Text>{truncate(r.title, Math.max(10, width - 25))}</Text>
                <Text dimColor> {formatTimeAgo(r.createdAt)}</Text>
              </Box>
            ))}
          </Box>
        )}
        {data.escalated.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>Escalated ({data.escalated.length})</Text>
            {data.escalated.map((r: TriageReport) => (
              <Box key={r.id}>
                <Text bold>{r.priority.padEnd(8)}</Text>
                <Text>{truncate(r.title, Math.max(10, width - 25))}</Text>
                <Text dimColor> {formatTimeAgo(r.createdAt)}</Text>
              </Box>
            ))}
          </Box>
        )}
        {data.pendingQuestions.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>Pending Questions ({data.pendingQuestions.length})</Text>
            {data.pendingQuestions.map((q: PendingQuestion) => (
              <Box key={q.id} flexDirection="column">
                <Box>
                  <Text>{truncate(q.title, Math.max(10, width - 16))}</Text>
                  <Text dimColor> [{q.type}]</Text>
                </Box>
                {q.recommendation && (
                  <Box marginLeft={2}>
                    <Text dimColor>Rec: {truncate(q.recommendation, Math.max(10, width - 12))}</Text>
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}
        {data.recentlyTriaged.length > 0 && (
          <Box flexDirection="column">
            <Text bold dimColor>Recently Triaged (24h)</Text>
            {data.recentlyTriaged.map((r: TriageReport) => (
              <Box key={r.id}>
                <Text dimColor>{(r.outcome || r.status).padEnd(14)}</Text>
                <Text>{truncate(r.title, Math.max(10, width - 28))}</Text>
                <Text dimColor> {formatTimeAgo(r.createdAt)}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Section>
  );
}

function PersonasSection({ personas, width }: { personas: FeedbackPersona[]; width: number }): React.ReactElement {
  if (personas.length === 0) return <></>;
  return (
    <Section title={`FEEDBACK PERSONAS (${personas.length})`} width={width} tip="/persona-feedback">
      {personas.map(p => (
        <Box key={p.name}>
          <Text bold>{truncate(p.name, 16).padEnd(17)}</Text>
          <Text dimColor>{p.consumptionModes.padEnd(6)}</Text>
          <Text>{(p.enabled ? 'on' : 'off').padEnd(4)}</Text>
          <Text dimColor>{`${p.sessionCount}s · ${p.findingsCount}f`}</Text>
        </Box>
      ))}
    </Section>
  );
}

function ProductManagerSection({ enabled, sectionsCompleted, width }: { enabled: boolean; sectionsCompleted: number; width: number }): React.ReactElement {
  return (
    <Section title="PRODUCT-MARKET FIT" width={width} tip="/show product-market-fit">
      <Box>
        <Text dimColor>Status </Text>
        <Text bold>{enabled ? 'ENABLED' : 'DISABLED'}</Text>
        <Text dimColor>{' · Sections '}</Text>
        <Text bold>{sectionsCompleted}</Text><Text dimColor>/6</Text>
      </Box>
    </Section>
  );
}

// ============================================================================
// Right column sections (Infrastructure)
// ============================================================================

function TestingSection({ data, width }: { data: Page3Data['testing']; width: number }): React.ReactElement {
  if (!data.hasData) {
    return (
      <Section title="TESTING" width={width} tip="/show testing">
        <Text dimColor>No test data available</Text>
      </Section>
    );
  }
  const passRate = data.totalTests > 0 ? Math.round((data.passing / data.totalTests) * 100) : 0;
  return (
    <Section title="TESTING" width={width} tip="/show testing">
      <Box>
        <Text bold>{data.passing}</Text><Text dimColor>{' passing · '}</Text>
        <Text bold>{data.failing}</Text><Text dimColor>{' failing · '}</Text>
        <Text dimColor>{`${data.skipped} skip`}</Text>
      </Box>
      <Box>
        <Text>{data.totalTests} total ({passRate}%)</Text>
        {data.coveragePct != null && (
          <Text dimColor>{' · Cov '}<Text bold>{data.coveragePct}%</Text></Text>
        )}
      </Box>
    </Section>
  );
}

function DeploymentsSection({ deployments, width }: { deployments: DeploymentItem[]; width: number }): React.ReactElement {
  if (deployments.length === 0) {
    return (
      <Section title="DEPLOYMENTS" width={width} tip="/show deployments">
        <Text dimColor>No recent deployments</Text>
      </Section>
    );
  }
  return (
    <Section title={`DEPLOYMENTS (${deployments.length})`} width={width} tip="/show deployments">
      <Box flexDirection="column">
        <Box>
          <Text bold dimColor>{'Service'.padEnd(18)}{'Env'.padEnd(10)}{'Status'.padEnd(10)}{'Time'}</Text>
        </Box>
        {deployments.map((d, i) => (
          <Box key={i}>
            <Text>{truncate(d.service, 17).padEnd(18)}</Text>
            <Text dimColor>{d.environment.padEnd(10)}</Text>
            <Text bold>{d.status.padEnd(10)}</Text>
            <Text dimColor>{formatTimestamp(d.timestamp)}</Text>
          </Box>
        ))}
      </Box>
    </Section>
  );
}

function WorktreeSection({ worktrees, width }: { worktrees: WorktreeInfo[]; width: number }): React.ReactElement {
  if (worktrees.length === 0) {
    return (
      <Section title="WORKTREES" width={width} tip="/show worktrees">
        <Text dimColor>No active worktrees</Text>
      </Section>
    );
  }
  return (
    <Section title={`WORKTREES (${worktrees.length})`} width={width} tip="/show worktrees">
      {worktrees.map((w, i) => (
        <Box key={i}>
          <Text>{truncate(w.branch, Math.max(10, width - 20)).padEnd(Math.max(10, width - 20))}</Text>
          <Text dimColor> {w.age.padEnd(6)}</Text>
          <Text bold>{w.hasChanges ? 'dirty' : 'clean'}</Text>
        </Box>
      ))}
    </Section>
  );
}

function InfraSection({ infra, width }: { infra: Page3Data['infra']; width: number }): React.ReactElement {
  return (
    <Section title="INFRASTRUCTURE" width={width} tip="/show infra">
      <Box>
        <Text dimColor>Render </Text>
        <Text bold>{infra.renderServices}</Text><Text dimColor> svc</Text>
        {infra.renderSuspended > 0 && <Text dimColor> ({infra.renderSuspended} sus)</Text>}
        <Text dimColor>{' · Vercel '}</Text>
        <Text bold>{infra.vercelProjects}</Text><Text dimColor> proj</Text>
      </Box>
      <Box>
        <Text dimColor>Supabase </Text>
        <Text bold>{infra.supabaseHealthy ? 'healthy' : 'down'}</Text>
        <Text dimColor>{' · CF '}</Text>
        <Text bold>{infra.cloudflareStatus}</Text>
      </Box>
    </Section>
  );
}

function LoggingSection({ logging, width }: { logging: Page3Data['logging']; width: number }): React.ReactElement {
  return (
    <Section title="LOGGING" width={width} tip="/show logging">
      <Box>
        <Text dimColor>1h </Text><Text bold>{logging.totalLogs1h}</Text>
        <Text dimColor>{' · 24h '}</Text><Text bold>{logging.totalLogs24h}</Text>
      </Box>
      <Box>
        <Text dimColor>Err </Text><Text bold>{logging.errorCount1h}</Text>
        <Text dimColor>{' · Warn '}</Text><Text bold>{logging.warnCount1h}</Text>
      </Box>
    </Section>
  );
}

const EVENT_ICONS: Record<string, string> = {
  hook: '\u2731', report: '\u25C6', question: '?', task: '+', session: '\u25CB',
};

function TimelineSection({ events, width }: { events: TimelineEvent[]; width: number }): React.ReactElement {
  const sorted = [...events].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return (
    <Section title={`TIMELINE (${events.length})`} width={width} tip="/show timeline">
      {sorted.length === 0 ? (
        <Text dimColor>No recent events</Text>
      ) : (
        <Box flexDirection="column">
          {sorted.map((e, i) => {
            const icon = EVENT_ICONS[e.type] || '\u00B7';
            const time = formatTimestamp(e.timestamp.toISOString());
            return (
              <Box key={i}>
                <Text dimColor>{time} </Text>
                <Text>{icon} </Text>
                <Text>{truncate(e.title, Math.max(10, width - 14))}</Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Section>
  );
}

// ============================================================================
// Page 2 layout
// ============================================================================

export function Page2({ data, infra, scrollOffset, height, width }: Page2Props): React.ReactElement {
  const leftW = Math.floor(width / 2);
  const rightW = width - leftW - 1;

  return (
    <Box flexDirection="row" height={height}>
      {/* Left: Intelligence */}
      <Box flexDirection="column" width={leftW} height={height} overflow="hidden">
        <Box flexDirection="column" marginTop={-scrollOffset}>
          <AccountOverviewSection accounts={data.accounts} width={leftW} />
          <Box marginTop={1}>
            <DeputyCtoDetailSection data={data.deputyCto} width={leftW} />
          </Box>
          <Box marginTop={1}>
            <PersonasSection personas={data.personas} width={leftW} />
          </Box>
          <Box marginTop={1}>
            <ProductManagerSection enabled={data.productManagerEnabled} sectionsCompleted={data.productManagerSectionsCompleted} width={leftW} />
          </Box>
        </Box>
      </Box>
      {/* Gap */}
      <Box width={1} />
      {/* Right: Infrastructure */}
      <Box flexDirection="column" width={rightW} height={height} overflow="hidden">
        <Box flexDirection="column" marginTop={-scrollOffset}>
          <TestingSection data={infra.testing} width={rightW} />
          <Box marginTop={1}>
            <DeploymentsSection deployments={infra.deployments} width={rightW} />
          </Box>
          <Box marginTop={1}>
            <WorktreeSection worktrees={infra.worktrees} width={rightW} />
          </Box>
          <Box marginTop={1}>
            <InfraSection infra={infra.infra} width={rightW} />
          </Box>
          <Box marginTop={1}>
            <LoggingSection logging={infra.logging} width={rightW} />
          </Box>
          <Box marginTop={1}>
            <TimelineSection events={infra.timeline} width={rightW} />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
