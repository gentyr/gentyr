/**
 * ScenarioList — scrollable selectable list of demo scenarios.
 *
 * Each item is 2 rows:
 *   Row 1: [dot] [title]
 *   Row 2:       [persona] | [category] | [headed] | [last recorded ago]
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DemoScenarioItem } from '../../types.js';
import { truncate, formatElapsed } from '../../utils/formatters.js';

interface ScenarioListProps {
  scenarios: DemoScenarioItem[];
  selectedId: string | null;
  height: number;
  width: number;
  isActive: boolean;
}

const DOT = '\u25CF';

function agoLabel(isoStr: string | null): string {
  if (!isoStr) return 'never';
  try {
    const ms = Date.now() - new Date(isoStr).getTime();
    return formatElapsed(Math.max(0, ms)) + ' ago';
  } catch { return '?'; }
}

function ScenarioRow({ scenario, isSelected, width, isActive }: { scenario: DemoScenarioItem; isSelected: boolean; width: number; isActive: boolean }): React.ReactElement {
  const dotColor = scenario.enabled ? 'green' : 'gray';
  const titleWidth = Math.max(4, width - 4);
  const titleText = truncate(scenario.title, titleWidth);

  const meta: string[] = [];
  meta.push(scenario.personaName);
  if (scenario.category) meta.push(scenario.category);
  if (scenario.headed) meta.push('headed');
  meta.push(agoLabel(scenario.lastRecordedAt));
  const metaStr = truncate(meta.join(' \u00B7 '), Math.max(4, width - 4));

  const highlight = isSelected && isActive;
  const sel = highlight ? { color: 'white' as const, bold: true } : {};
  const selDim = highlight ? { color: 'white' as const } : { dimColor: true };

  return (
    <Box flexDirection="column" height={2} overflow="hidden">
      <Box height={1}>
        <Box width={2}>
          <Text color={dotColor} bold>{DOT} </Text>
        </Box>
        <Box width={titleWidth} overflow="hidden">
          <Text {...(highlight ? sel : isSelected ? {} : { dimColor: !scenario.enabled })}>{titleText}</Text>
        </Box>
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

export function ScenarioList({ scenarios, selectedId, height, width, isActive }: ScenarioListProps): React.ReactElement {
  if (scenarios.length === 0) {
    return (
      <Box flexDirection="column" height={height}>
        <Text dimColor>  No demo scenarios</Text>
      </Box>
    );
  }

  const itemsPerPage = Math.max(1, Math.floor(height / 2));
  const selectedIndex = scenarios.findIndex(s => s.id === selectedId);
  let startIdx = 0;
  if (selectedIndex >= 0) {
    startIdx = Math.max(0, Math.min(selectedIndex - Math.floor(itemsPerPage / 2), scenarios.length - itemsPerPage));
  }
  const visible = scenarios.slice(startIdx, startIdx + itemsPerPage);

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {visible.map((s) => (
        <ScenarioRow key={s.id} scenario={s} isSelected={s.id === selectedId} width={width} isActive={isActive} />
      ))}
    </Box>
  );
}
