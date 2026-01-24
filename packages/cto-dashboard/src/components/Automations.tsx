/**
 * Automations component - shows all spawnable Claude instances
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import type { AutomationInfo, AutomationTrigger } from '../utils/data-reader.js';

const TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  continuous: 'Continuous',
  commit: 'Commit',
  prompt: 'Prompt',
  'file-change': 'File Change',
};

const TRIGGER_COLORS: Record<AutomationTrigger, string> = {
  continuous: 'cyan',
  commit: 'yellow',
  prompt: 'magenta',
  'file-change': 'blue',
};

function formatTime12h(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).replace(' ', '');
}

function formatDelta(seconds: number): string {
  if (seconds < 0) return '0s';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return secs > 0 ? `${minutes}m${secs}s` : `${minutes}m`;
  }
  return `${secs}s`;
}

function formatIntervalDelta(defaultMin: number, effectiveMin: number): string {
  const diff = effectiveMin - defaultMin;
  if (diff === 0) return '';
  const sign = diff > 0 ? '+' : '';
  return ` [${sign}${formatDelta(Math.abs(diff) * 60)}]`;
}

interface AutomationRowProps {
  automation: AutomationInfo;
}

function AutomationRow({ automation }: AutomationRowProps): React.ReactElement {
  const triggerLabel = TRIGGER_LABELS[automation.trigger];
  const triggerColor = TRIGGER_COLORS[automation.trigger];

  // Format interval info for continuous automations
  let intervalText = '';
  let deltaText = '';
  let nextTimeText = '';

  if (automation.trigger === 'continuous' && automation.effective_interval_minutes != null) {
    const effectiveMin = automation.effective_interval_minutes;
    const defaultMin = automation.default_interval_minutes ?? effectiveMin;

    intervalText = `Every ${effectiveMin}m`;
    deltaText = formatIntervalDelta(defaultMin, effectiveMin);

    if (automation.next_run) {
      nextTimeText = formatTime12h(automation.next_run);
      if (automation.seconds_until_next != null) {
        nextTimeText += ` (${formatDelta(automation.seconds_until_next)})`;
      }
    } else {
      nextTimeText = 'N/A';
    }
  }

  return (
    <Box flexDirection="row" gap={1}>
      {/* Name - fixed width */}
      <Box width={18}>
        <Text color="white">{automation.name}</Text>
      </Box>

      {/* Trigger type */}
      <Box width={12}>
        <Text color={triggerColor}>{triggerLabel}</Text>
      </Box>

      {/* Interval (for continuous) */}
      <Box width={20}>
        {automation.trigger === 'continuous' ? (
          <>
            <Text color="gray">{intervalText}</Text>
            {deltaText && <Text color="yellow">{deltaText}</Text>}
          </>
        ) : (
          <Text color="gray">On trigger</Text>
        )}
      </Box>

      {/* Next run (for continuous) */}
      <Box>
        {automation.trigger === 'continuous' && (
          <>
            <Text color="gray">Next: </Text>
            <Text color="cyan">{nextTimeText}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

export interface AutomationsProps {
  automations: AutomationInfo[];
}

export function Automations({ automations }: AutomationsProps): React.ReactElement {
  // Separate continuous from hook-triggered
  const continuous = automations.filter(a => a.trigger === 'continuous');
  const hookTriggered = automations.filter(a => a.trigger !== 'continuous');

  return (
    <Section title="AUTOMATIONS" borderColor="magenta">
      {/* Header row */}
      <Box flexDirection="row" gap={1} marginBottom={1}>
        <Box width={18}>
          <Text color="gray" bold>Name</Text>
        </Box>
        <Box width={12}>
          <Text color="gray" bold>Trigger</Text>
        </Box>
        <Box width={20}>
          <Text color="gray" bold>Interval</Text>
        </Box>
        <Box>
          <Text color="gray" bold>Next Run</Text>
        </Box>
      </Box>

      {/* Continuous automations */}
      {continuous.map((auto, idx) => (
        <AutomationRow key={`cont-${idx}`} automation={auto} />
      ))}

      {/* Separator */}
      {hookTriggered.length > 0 && (
        <Box marginY={0}>
          <Text color="gray">{'─'.repeat(60)}</Text>
        </Box>
      )}

      {/* Hook-triggered automations */}
      {hookTriggered.map((auto, idx) => (
        <AutomationRow key={`hook-${idx}`} automation={auto} />
      ))}
    </Section>
  );
}
