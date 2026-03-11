/**
 * Plan Section Component — Active plans overview (compact)
 *
 * Shows all active plans with phase progress bars and ready-to-spawn summary.
 * White + Gray only design.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { QuotaBar } from './QuotaBar.js';
import type { PlanData, PlanInfo, PlanPhaseInfo } from '../utils/plan-reader.js';

export interface PlanSectionProps {
  data: PlanData;
  tip?: string;
}

function PhaseBar({ phase }: { phase: PlanPhaseInfo }): React.ReactElement {
  const label = `P${phase.phase_order}`;
  return <QuotaBar label={label} percentage={phase.progress_pct} width={10} />;
}

function PlanRow({ plan }: { plan: PlanInfo }): React.ReactElement {
  const title = plan.title.length > 30 ? plan.title.substring(0, 27) + '...' : plan.title;
  const statusColor = plan.status === 'active' ? 'white' : 'gray';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={statusColor} bold>{title}</Text>
        <Text color="gray"> | </Text>
        <Text color="white">{plan.completed_tasks}/{plan.task_count} tasks</Text>
        <Text color="gray"> | </Text>
        <Text color="white">{plan.ready_tasks} ready</Text>
        {plan.active_tasks > 0 && (
          <>
            <Text color="gray"> | </Text>
            <Text color="white">{plan.active_tasks} active</Text>
          </>
        )}
      </Box>
      <Box marginLeft={2} flexDirection="column">
        {plan.phases.map((phase) => (
          <PhaseBar key={phase.id} phase={phase} />
        ))}
      </Box>
    </Box>
  );
}

export function PlanSection({ data, tip }: PlanSectionProps): React.ReactElement {
  if (!data.hasData || data.plans.length === 0) {
    return (
      <Section title="PLANS" borderColor="white" tip={tip}>
        <Text color="gray">No active plans. Use /plan to create one.</Text>
      </Section>
    );
  }

  const title = `PLANS (${data.plans.length} active | ${data.total_ready} ready | ${data.total_active} running)`;

  return (
    <Section title={title} borderColor="white" tip={tip}>
      <Box flexDirection="column">
        {data.plans.map((plan) => (
          <PlanRow key={plan.id} plan={plan} />
        ))}
      </Box>
    </Section>
  );
}
