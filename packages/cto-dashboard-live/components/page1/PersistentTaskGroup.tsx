/**
 * PersistentTaskGroup — PT header as a Section, monitor and children outside it.
 * No nesting of bordered cards inside bordered cards.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from '../Section.js';
import type { PersistentTaskItem } from '../../types.js';
import { SessionRow } from './SessionRow.js';
import { SubTaskRow } from './SubTaskRow.js';
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
  if (task.bridgeMainTree) flags.push('bridge');
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

      {/* Sub-tasks — indented text + child session cards */}
      {task.subTasks.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          <Text dimColor bold>{'Sub-Tasks ('}{task.subTasks.length}{')'}</Text>
          {task.subTasks.map((st, idx) => {
            const isChildSel = selectedChildId === st.id;
            const isLast = idx === task.subTasks.length - 1;

            return (
              <Box key={st.id} flexDirection="column">
                <SubTaskRow subTask={st} isLast={isLast} width={width - 4} />
                {st.session && (
                  <Box marginLeft={4}>
                    <SessionRow item={st.session} selected={isChildSel} width={width - 8} />
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
