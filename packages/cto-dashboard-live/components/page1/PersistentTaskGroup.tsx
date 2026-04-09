/**
 * PersistentTaskGroup — PT header as a Section, monitor and children outside it.
 * No nesting of bordered cards inside bordered cards.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from '../Section.js';
import type { PersistentTaskItem, SessionItem } from '../../types.js';
import { SessionRow } from './SessionRow.js';
import { truncate } from '../../utils/formatters.js';

interface PersistentTaskGroupProps {
  task: PersistentTaskItem;
  monitorSelected: boolean;
  selectedChildId: string | null;
  width: number;
}

export function PersistentTaskGroup({ task, monitorSelected, selectedChildId, width }: PersistentTaskGroupProps): React.ReactElement {
  const flags: string[] = [];
  if (task.demoInvolved) flags.push('demo');
  if (task.strictInfraGuidance) flags.push('strict-infra');
  const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';
  const titleText = `${truncate(task.title, width - 30)} ${task.status.toUpperCase()} (${task.age})${flagStr}`;

  return (
    <Box flexDirection="column" width={width}>
      {/* PT header — bordered Section with just metadata (single <Text>, no multi-line) */}
      <Section title={titleText} width={width}>
        <Text dimColor>
          {'HB '}{task.heartbeatAge}{task.heartbeatStale ? ' (stale)' : ''}{' · Cycles '}{task.cycleCount}
        </Text>
      </Section>

      {/* Monitor session — separate bordered card, indented */}
      <Box marginLeft={2}>
        <SessionRow item={task.monitorSession} selected={monitorSelected} width={width - 2} />
      </Box>

      {/* Sub-tasks — rendered as session cards, same style as monitor */}
      {task.subTasks.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          <Text dimColor bold>{'Sub-Tasks ('}{task.subTasks.length}{')'}</Text>
          {task.subTasks.map((st) => {
            const isChildSel = selectedChildId === st.id;
            // Use the existing session card if available, otherwise build one from sub-task data
            const sessionItem: SessionItem = st.session ?? {
              id: st.id,
              status: st.status === 'completed' ? 'completed' : st.status === 'in_progress' ? 'alive' : 'queued',
              priority: 'normal',
              agentType: st.section || 'unknown',
              title: st.title,
              pid: null,
              lastAction: st.agentStage,
              lastActionTimestamp: new Date().toISOString(),
              lastMessage: st.worklog?.summary ?? null,
              description: null,
              killReason: null,
              totalTokens: st.worklog?.tokens ?? null,
              sessionId: null,
              elapsed: st.worklog?.durationMs != null ? `${Math.round(st.worklog.durationMs / 1000)}s` : '',
              worklog: st.worklog,
              worktreePath: null,
            };
            return (
              <Box key={st.id} marginLeft={2}>
                <SessionRow item={sessionItem} selected={isChildSel} width={width - 6} />
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
