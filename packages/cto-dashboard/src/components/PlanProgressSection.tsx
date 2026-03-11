/**
 * Plan Progress Section Component — Detailed progress with agent assignments
 *
 * Shows full progress bars + sub-steps + agent assignment + completions + ready to spawn.
 * White + Gray only design.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { QuotaBar } from './QuotaBar.js';
import type { PlanProgressData, PlanTaskInfo, PlanSubstepInfo } from '../utils/plan-reader.js';

export interface PlanProgressSectionProps {
  data: PlanProgressData;
  tip?: string;
}

const FULL = '\u2588';
const EMPTY = '\u2591';

function SubstepRow({ substep }: { substep: PlanSubstepInfo }): React.ReactElement {
  const indicator = substep.completed ? `[${FULL}]` : `[${EMPTY}]`;
  const color = substep.completed ? 'white' : 'gray';
  return (
    <Box marginLeft={8}>
      <Text color={color}>{indicator} {substep.title}</Text>
    </Box>
  );
}

function TaskRow({ task }: { task: PlanTaskInfo }): React.ReactElement {
  const statusColor = task.status === 'ready' || task.status === 'in_progress' || task.status === 'completed'
    ? 'white' : 'gray';
  const agentLabel = task.agent_type ? ` [${task.agent_type}]` : '';
  const prLabel = task.pr_number ? ` PR #${task.pr_number}${task.pr_merged ? ' merged' : ''}` : '';

  return (
    <Box flexDirection="column" marginLeft={4}>
      <Box>
        <Text color={statusColor}>{task.title}</Text>
        <Text color="gray">  {task.status.toUpperCase()}{agentLabel}{prLabel}</Text>
      </Box>
      <Box marginLeft={2}>
        <QuotaBar label="" percentage={task.progress_pct} width={12} />
      </Box>
      {task.substeps.map((ss) => (
        <SubstepRow key={ss.id} substep={ss} />
      ))}
    </Box>
  );
}

export function PlanProgressSection({ data, tip }: PlanProgressSectionProps): React.ReactElement {
  if (!data.hasData || data.plans.length === 0) {
    return (
      <Section title="PLAN PROGRESS" borderColor="white" tip={tip}>
        <Text color="gray">No active plans with progress data.</Text>
      </Section>
    );
  }

  return (
    <Box flexDirection="column">
      {data.plans.map((plan) => (
        <Section key={plan.id} title={`PLAN: ${plan.title} (${plan.progress_pct}%)`} borderColor="white" tip={tip}>
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <QuotaBar label="Overall" percentage={plan.progress_pct} width={20} />
            </Box>

            {plan.tasks_by_phase.map((phaseGroup, idx) => (
              <Box key={idx} flexDirection="column" marginBottom={1}>
                <Text color="white" bold>  {phaseGroup.phase}</Text>
                {phaseGroup.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </Box>
            ))}

            <Box marginTop={1}>
              <Text color="gray">
                Tasks: {plan.completed_tasks}/{plan.task_count} complete | {plan.ready_tasks} ready | {plan.active_tasks} active
              </Text>
            </Box>
          </Box>
        </Section>
      ))}
    </Box>
  );
}
