/**
 * Product Manager Section Component
 *
 * Shows PMF analysis status:
 * - Not started: prompt to use /product-manager
 * - In progress: section progress with check marks
 * - Completed: section progress + compliance bar
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import type { ProductManagerData } from '../utils/product-manager-reader.js';

export interface ProductManagerSectionProps {
  data: ProductManagerData;
  tip?: string;
}

function statusColor(status: string): string {
  switch (status) {
    case 'not_started': return 'gray';
    case 'pending_approval': return 'yellow';
    case 'approved': return 'cyan';
    case 'in_progress': return 'blue';
    case 'completed': return 'green';
    default: return 'gray';
  }
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ').toUpperCase();
}

function ComplianceBar({ pct, mapped, total }: { pct: number; mapped: number; total: number }): React.ReactElement {
  const barWidth = 20;
  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  const color = pct >= 90 ? 'green' : pct >= 60 ? 'yellow' : 'red';

  return (
    <Box>
      <Text color="gray">Persona Coverage: </Text>
      <Text color="white">{mapped}/{total} mapped </Text>
      <Text color="gray">({pct}%) </Text>
      <Text color={color}>{bar}</Text>
    </Box>
  );
}

export function ProductManagerSection({ data, tip }: ProductManagerSectionProps): React.ReactElement {
  // Not started state
  if (!data.hasData || data.status === 'not_started') {
    return (
      <Section title="PRODUCT-MARKET FIT" borderColor="magenta" tip={tip}>
        <Text color="gray">No PMF analysis initiated. Use /product-manager to start.</Text>
      </Section>
    );
  }

  return (
    <Section title={`PRODUCT-MARKET FIT (${data.sections_populated}/${data.total_sections})`} borderColor="magenta" tip={tip}>
      <Box flexDirection="column">
        {/* Status row */}
        <Box>
          <Text color="gray">Status: </Text>
          <Text color={statusColor(data.status)} bold>{statusLabel(data.status)}</Text>
        </Box>

        {/* Section progress */}
        {data.sections.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {data.sections.map((sec) => {
              const icon = sec.populated ? '\u2713' : '\u25CB';
              const iconColor = sec.populated ? 'green' : 'gray';
              const entryLabel = sec.entry_count !== undefined
                ? ` (${sec.entry_count} entries)`
                : '';

              return (
                <Box key={sec.number}>
                  <Text color={iconColor}>{icon} </Text>
                  <Text color={sec.populated ? 'white' : 'gray'}>
                    {sec.title}{entryLabel}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}

        {/* Compliance bar (only when completed or has pain points) */}
        {data.compliance && (
          <Box marginTop={1}>
            <ComplianceBar
              pct={data.compliance.pct}
              mapped={data.compliance.mapped}
              total={data.compliance.total_pain_points}
            />
          </Box>
        )}
      </Box>
    </Section>
  );
}
