/**
 * PlanList — scrollable selectable list of plans.
 *
 * Each plan is 2 rows:
 *   Row 1: [dot] [title]               [progress bar] [pct]
 *   Row 2:       [phase count] | [task summary] · updated [age]
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { PlanItem } from '../../types.js';
import { truncate, formatElapsed, renderProgressBar } from '../../utils/formatters.js';

interface PlanListProps {
  plans: PlanItem[];
  selectedIndex: number;
  height: number;
  width: number;
  isActive: boolean;
}

function statusDot(status: string): { char: string; color: string } {
  switch (status) {
    case 'active': return { char: '\u25CF', color: 'green' };
    case 'paused': return { char: '\u25CF', color: 'yellow' };
    default:       return { char: '\u25CF', color: 'gray' };
  }
}

function ageLabel(isoOrNull: string | null): string {
  if (!isoOrNull) return '?';
  try {
    // Handle SQLite datetime format "YYYY-MM-DD HH:MM:SS"
    const iso = isoOrNull.includes('T') ? isoOrNull : isoOrNull.replace(' ', 'T') + 'Z';
    const ms = Date.now() - new Date(iso).getTime();
    return formatElapsed(Math.max(0, ms)) + ' ago';
  } catch { return '?'; }
}

function PlanRow({ plan, isSelected, width, isActive }: { plan: PlanItem; isSelected: boolean; width: number; isActive: boolean }): React.ReactElement {
  const { char, color } = statusDot(plan.status);
  const highlight = isSelected && isActive;
  const sel: Record<string, unknown> = highlight ? { color: 'white', bold: true } : {};
  const selDim: Record<string, unknown> = highlight ? { color: 'white' } : { dimColor: true };

  const BAR_WIDTH = 10;
  const bar = renderProgressBar(plan.progressPct, BAR_WIDTH);
  const barLen = BAR_WIDTH + 5; // "████── 50%" = 10 + " " + "N%" (up to 4 chars)
  const titleWidth = Math.max(4, width - 4 - barLen);
  const titleText = truncate(plan.title, titleWidth);

  const meta: string[] = [];
  meta.push(`${plan.phaseCount} phase${plan.phaseCount !== 1 ? 's' : ''}`);
  const taskSummary = `${plan.completedTasks}/${plan.taskCount} tasks`;
  const extras: string[] = [];
  if (plan.readyTasks > 0) extras.push(`${plan.readyTasks} ready`);
  if (plan.activeTasks > 0) extras.push(`${plan.activeTasks} active`);
  meta.push(extras.length > 0 ? `${taskSummary} (${extras.join(', ')})` : taskSummary);
  meta.push(`updated ${ageLabel(plan.updatedAt)}`);
  const metaStr = truncate(meta.join(' \u00B7 '), Math.max(4, width - 4));

  return (
    <Box flexDirection="column" height={2} overflow="hidden">
      <Box height={1}>
        <Box width={2}>
          <Text color={color} bold>{char} </Text>
        </Box>
        <Box width={titleWidth} overflow="hidden">
          <Text {...sel}>{titleText}</Text>
        </Box>
        <Text> </Text>
        <Text dimColor={!highlight}>[</Text>
        <Text color={highlight ? 'green' : 'white'} dimColor={!highlight}>{bar}</Text>
        <Text dimColor={!highlight}>]</Text>
      </Box>
      <Box height={1}>
        <Box width={2}><Text> </Text></Box>
        <Box overflow="hidden">
          <Text {...selDim}>{metaStr}</Text>
        </Box>
      </Box>
    </Box>
  );
}

export function PlanList({ plans, selectedIndex, height, width, isActive }: PlanListProps): React.ReactElement {
  if (plans.length === 0) {
    return (
      <Box flexDirection="column" height={height}>
        <Text dimColor>  No active plans</Text>
      </Box>
    );
  }

  const itemsPerPage = Math.max(1, Math.floor(height / 2));
  const startIdx = Math.max(0, Math.min(
    selectedIndex - Math.floor(itemsPerPage / 2),
    plans.length - itemsPerPage,
  ));
  const visible = plans.slice(startIdx, startIdx + itemsPerPage);

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {visible.map((plan, i) => (
        <PlanRow
          key={plan.id}
          plan={plan}
          isSelected={startIdx + i === selectedIndex}
          width={width}
          isActive={isActive}
        />
      ))}
    </Box>
  );
}
