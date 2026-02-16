/**
 * Automated Instances Component
 *
 * Table showing all automated Claude triggers:
 * - Type (name of the automation)
 * - Runs (24h) - count from agent-tracker
 * - Until Next - time until next scheduled run (or "on commit"/"on failure")
 * - Freq Adj - frequency adjustment from usage optimizer or static mode
 *
 * Footer shows: Usage Target, Current Projected, Adjusting direction
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import type { AutomatedInstancesData, AutomatedInstance } from '../utils/automated-instances.js';

export interface AutomatedInstancesProps {
  data: AutomatedInstancesData;
}

// Column widths for alignment
const COL_TYPE = 22;
const COL_RUNS = 12;
const COL_UNTIL = 14;
const COL_FREQ = 19;

function HeaderRow(): React.ReactElement {
  return (
    <Box flexDirection="row">
      <Box width={COL_TYPE}>
        <Text color="gray" bold>Type</Text>
      </Box>
      <Box width={COL_RUNS}>
        <Text color="gray" bold>Runs (24h)</Text>
      </Box>
      <Box width={COL_UNTIL}>
        <Text color="gray" bold>Until Next</Text>
      </Box>
      <Box width={COL_FREQ}>
        <Text color="gray" bold>Freq Adj</Text>
      </Box>
    </Box>
  );
}

function Separator(): React.ReactElement {
  const totalWidth = COL_TYPE + COL_RUNS + COL_UNTIL + COL_FREQ;
  return (
    <Box>
      <Text color="gray">{'─'.repeat(totalWidth)}</Text>
    </Box>
  );
}

interface InstanceRowProps {
  instance: AutomatedInstance;
}

function InstanceRow({ instance }: InstanceRowProps): React.ReactElement {
  // Color for run count
  const runsColor = instance.runs24h > 10 ? 'cyan' : instance.runs24h > 0 ? 'white' : 'gray';

  // Color for until next
  let untilColor = 'gray';
  if (instance.untilNext === 'now') untilColor = 'yellow';
  else if (instance.untilNext === 'pending') untilColor = 'gray';
  else if (instance.untilNext.startsWith('on ')) untilColor = 'magenta';
  else if (instance.untilNext !== '-') untilColor = 'cyan';

  // Color for freq adj
  let freqColor = 'gray';
  const freqText = instance.freqAdj || '—';
  if (instance.freqAdj) {
    if (instance.freqAdj.includes('slower')) freqColor = 'yellow';
    else if (instance.freqAdj.includes('faster')) freqColor = 'green';
    else if (instance.freqAdj.startsWith('static')) freqColor = 'blue';
    else if (instance.freqAdj === 'baseline') freqColor = 'gray';
    else if (instance.freqAdj === 'no data') freqColor = 'gray';
  }

  return (
    <Box flexDirection="row">
      <Box width={COL_TYPE}>
        <Text color="white">{instance.type}</Text>
      </Box>
      <Box width={COL_RUNS}>
        <Text color={runsColor}>{instance.runs24h}</Text>
      </Box>
      <Box width={COL_UNTIL}>
        <Text color={untilColor}>{instance.untilNext}</Text>
      </Box>
      <Box width={COL_FREQ}>
        <Text color={freqColor}>{freqText}</Text>
      </Box>
    </Box>
  );
}

interface FooterProps {
  usageTarget: number;
  currentProjected: number | null;
  adjustingDirection: 'up' | 'down' | 'stable';
}

function Footer({ usageTarget, currentProjected, adjustingDirection }: FooterProps): React.ReactElement {
  // Format projected (value is already a percentage 0-100)
  const projectedText = currentProjected !== null ? `${Math.round(currentProjected)}%` : 'N/A';

  // Determine projected color
  let projectedColor = 'gray';
  if (currentProjected !== null) {
    if (currentProjected > usageTarget + 5) projectedColor = 'yellow';
    else if (currentProjected < usageTarget - 10) projectedColor = 'green';
    else projectedColor = 'cyan';
  }

  // Format adjusting direction
  let adjustText = '';
  let adjustColor = 'gray';
  if (adjustingDirection === 'up') {
    adjustText = '↑ intervals';
    adjustColor = 'yellow';
  } else if (adjustingDirection === 'down') {
    adjustText = '↓ intervals';
    adjustColor = 'green';
  } else {
    adjustText = '→ stable';
    adjustColor = 'gray';
  }

  return (
    <Box marginTop={1}>
      <Text color="gray">Usage Target: </Text>
      <Text color="white">{usageTarget}%</Text>
      <Text color="gray">  |  Current Projected: </Text>
      <Text color={projectedColor}>{projectedText}</Text>
      <Text color="gray">  |  Adjusting: </Text>
      <Text color={adjustColor}>{adjustText}</Text>
    </Box>
  );
}

export function AutomatedInstances({ data }: AutomatedInstancesProps): React.ReactElement | null {
  if (!data.hasData || data.instances.length === 0) {
    return null;
  }

  // Separate scheduled from event-triggered
  const scheduled = data.instances.filter(i => i.trigger === 'scheduled');
  const eventTriggered = data.instances.filter(i => i.trigger !== 'scheduled');

  return (
    <Section title="AUTOMATED INSTANCES" borderColor="magenta" width="100%">
      <Box flexDirection="column">
        {/* Header */}
        <HeaderRow />
        <Separator />

        {/* Scheduled instances */}
        {scheduled.map((instance, idx) => (
          <InstanceRow key={`sched-${idx}`} instance={instance} />
        ))}

        {/* Separator between scheduled and event-triggered */}
        {eventTriggered.length > 0 && scheduled.length > 0 && (
          <Box marginY={0}>
            <Separator />
          </Box>
        )}

        {/* Event-triggered instances */}
        {eventTriggered.map((instance, idx) => (
          <InstanceRow key={`event-${idx}`} instance={instance} />
        ))}

        {/* Footer with usage metrics */}
        <Footer
          usageTarget={data.usageTarget}
          currentProjected={data.currentProjected}
          adjustingDirection={data.adjustingDirection}
        />

        {/* Hint */}
        <Box marginTop={1}>
          <Text color="gray" dimColor>Tip: Ask Claude Code to adjust frequency or switch modes (load balanced / static).</Text>
        </Box>
      </Box>
    </Section>
  );
}
