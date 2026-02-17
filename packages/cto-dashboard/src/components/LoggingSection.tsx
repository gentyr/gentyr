/**
 * Logging Section Component
 *
 * Full logging dashboard with volume line graph, level/service bar charts,
 * top errors/warnings tables, source coverage assessment, and storage stats.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { LineGraph, BarChart } from '@pppp606/ink-chart';
import { Section } from './Section.js';
import { formatNumber } from '../utils/formatters.js';
import type { LoggingData } from '../utils/logging-reader.js';

export interface LoggingSectionProps {
  data: LoggingData;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

function levelColor(level: string): string {
  if (level === 'error') return 'red';
  if (level === 'warn' || level === 'warning') return 'yellow';
  if (level === 'info') return 'cyan';
  if (level === 'debug') return 'gray';
  return 'white';
}

function coverageColor(status: 'active' | 'missing' | 'low-volume'): string {
  if (status === 'active') return 'green';
  if (status === 'low-volume') return 'yellow';
  return 'gray';
}

function coverageDot(status: 'active' | 'missing' | 'low-volume'): string {
  if (status === 'missing') return '\u25CB'; // open circle
  return '\u25CF'; // filled circle
}

export function LoggingSection({ data }: LoggingSectionProps): React.ReactElement | null {
  if (!data.hasData) return null;

  const errorCount = data.byLevel.find(l => l.level === 'error')?.count || 0;
  const warnCount = data.byLevel.find(l => l.level === 'warn' || l.level === 'warning')?.count || 0;

  return (
    <Section title="LOGGING" borderColor="cyan" width="100%">
      <Box flexDirection="column">
        {/* Volume line graph + summary stats */}
        <Box flexDirection="row" gap={2}>
          <Box flexDirection="column" flexGrow={1}>
            <Text color="cyan" bold>Log Volume (24h)</Text>
            {data.volumeTimeseries.length > 0 && (
              <LineGraph
                data={[{ values: data.volumeTimeseries, color: 'cyan' }]}
                height={5}
                width={50}
              />
            )}
          </Box>
          <Box flexDirection="column" width={28}>
            <Box>
              <Text color="gray">Total: </Text>
              <Text color="white" bold>{formatNumber(data.totalLogs24h)}</Text>
            </Box>
            <Box>
              <Text color="gray">1h: </Text>
              <Text color="white">{formatNumber(data.totalLogs1h)}</Text>
            </Box>
            <Box>
              <Text color="gray">Errors: </Text>
              <Text color={errorCount > 0 ? 'red' : 'green'}>{formatNumber(errorCount)}</Text>
            </Box>
            <Box>
              <Text color="gray">Warnings: </Text>
              <Text color={warnCount > 0 ? 'yellow' : 'green'}>{formatNumber(warnCount)}</Text>
            </Box>
          </Box>
        </Box>

        {/* By Level and By Service bar charts side by side */}
        <Box flexDirection="row" gap={2} marginTop={1}>
          {data.byLevel.length > 0 && (
            <Box flexDirection="column" flexGrow={1} flexBasis={0}>
              <Text color="white" bold>By Level</Text>
              <BarChart
                data={data.byLevel.map(l => ({
                  label: l.level,
                  value: l.count,
                  color: levelColor(l.level),
                }))}
                sort="desc"
                showValue="right"
                format={(v: number) => formatNumber(v)}
                width={35}
                barChar="▆"
              />
            </Box>
          )}

          {data.byService.length > 0 && (
            <Box flexDirection="column" flexGrow={1} flexBasis={0}>
              <Text color="white" bold>By Service</Text>
              <BarChart
                data={data.byService.slice(0, 8).map(s => ({
                  label: truncate(s.service, 14),
                  value: s.count,
                }))}
                sort="desc"
                showValue="right"
                format={(v: number) => formatNumber(v)}
                width={35}
                color="cyan"
                barChar="▆"
              />
            </Box>
          )}
        </Box>

        {/* Top Errors */}
        {data.topErrors.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="red" bold>Top Errors (24h)</Text>
            {data.topErrors.map((e, i) => (
              <Box key={`err-${i}`} flexDirection="row">
                <Text color="red"> {'\u2717'} </Text>
                <Box width={40}>
                  <Text color="white">{truncate(e.message, 39)}</Text>
                </Box>
                <Box width={16}>
                  <Text color="gray">{truncate(e.service, 15)}</Text>
                </Box>
                <Text color="white">{e.count}</Text>
              </Box>
            ))}
          </Box>
        )}

        {/* Top Warnings */}
        {data.topWarnings.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="yellow" bold>Top Warnings (24h)</Text>
            {data.topWarnings.map((w, i) => (
              <Box key={`warn-${i}`} flexDirection="row">
                <Text color="yellow"> {'\u26A0'} </Text>
                <Box width={40}>
                  <Text color="white">{truncate(w.message, 39)}</Text>
                </Box>
                <Box width={16}>
                  <Text color="gray">{truncate(w.service, 15)}</Text>
                </Box>
                <Text color="white">{w.count}</Text>
              </Box>
            ))}
          </Box>
        )}

        {/* Source Coverage */}
        {data.sourceCoverage.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="white" bold>Source Coverage</Text>
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              {data.sourceCoverage.map((sc, i) => (
                <Box key={`sc-${i}`}>
                  <Text color={coverageColor(sc.status)}>
                    {coverageDot(sc.status)} {sc.source}
                  </Text>
                </Box>
              ))}
            </Box>
          </Box>
        )}

        {/* Storage footer */}
        <Box flexDirection="row" marginTop={1} gap={3}>
          <Box>
            <Text color="gray">Storage: </Text>
            <Text color="white">~{data.storage.estimatedDailyGB.toFixed(1)} GB/day</Text>
          </Box>
          <Box>
            <Text color="gray">Est. Monthly: </Text>
            <Text color="white">~${data.storage.estimatedMonthlyCost.toFixed(2)}</Text>
          </Box>
          <Box>
            <Text color="gray">Indices: </Text>
            <Text color="white">{data.storage.indexCount}</Text>
          </Box>
        </Box>
      </Box>
    </Section>
  );
}
