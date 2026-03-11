/**
 * Plan Audit Section Component — Agent metrics table
 *
 * Shows per-agent metrics (tasks assigned/completed/PRs) and phase efficiency.
 * White + Gray only design.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { QuotaBar } from './QuotaBar.js';
import type { PlanAuditData, PlanAgentMetric, PlanPhaseInfo } from '../utils/plan-reader.js';

export interface PlanAuditSectionProps {
  data: PlanAuditData;
  tip?: string;
}

function AgentRow({ agent }: { agent: PlanAgentMetric }): React.ReactElement {
  const name = agent.agent_type.padEnd(20);
  return (
    <Box>
      <Text color="white">{name}</Text>
      <Text color="gray">{String(agent.tasks_assigned).padStart(8)}</Text>
      <Text color="gray">{String(agent.tasks_completed).padStart(8)}</Text>
      <Text color="gray">{String(agent.prs_merged).padStart(6)}</Text>
    </Box>
  );
}

function PhaseRow({ phase }: { phase: PlanPhaseInfo }): React.ReactElement {
  return (
    <Box marginLeft={2}>
      <Text color="gray">Phase {phase.phase_order}: </Text>
      <Text color="white">{phase.title}</Text>
      <Text color="gray"> - {phase.completed_tasks}/{phase.task_count} tasks </Text>
      <QuotaBar label="" percentage={phase.progress_pct} width={8} />
    </Box>
  );
}

export function PlanAuditSection({ data, tip }: PlanAuditSectionProps): React.ReactElement {
  if (!data.hasData || data.plans.length === 0) {
    return (
      <Section title="PLAN AUDIT" borderColor="white" tip={tip}>
        <Text color="gray">No plan audit data available.</Text>
      </Section>
    );
  }

  return (
    <Box flexDirection="column">
      {data.plans.map((plan, idx) => (
        <Section key={idx} title={`PLAN AUDIT: ${plan.title}`} borderColor="white" tip={tip}>
          <Box flexDirection="column">
            {/* Agent metrics header */}
            <Box>
              <Text color="gray" bold>{'Agent Type'.padEnd(20)}</Text>
              <Text color="gray" bold>{'Assigned'.padStart(8)}</Text>
              <Text color="gray" bold>{'    Done'.padStart(8)}</Text>
              <Text color="gray" bold>{'  PRs'.padStart(6)}</Text>
            </Box>

            {plan.agents.map((agent, aidx) => (
              <AgentRow key={aidx} agent={agent} />
            ))}

            {/* Phase efficiency */}
            <Box marginTop={1} flexDirection="column">
              <Text color="gray" bold>Phase Efficiency:</Text>
              {plan.phases.map((phase) => (
                <PhaseRow key={phase.id} phase={phase} />
              ))}
            </Box>
          </Box>
        </Section>
      ))}
    </Box>
  );
}
