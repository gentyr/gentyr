/**
 * Testing Section Component
 *
 * Shows test health data:
 * - Currently failing suites with fix attempt pips, age coloring, and framework
 * - Agent breakdown by framework (24h)
 * - Resolved suites and unique failure signatures
 * - 7-day test failure agent sparkline
 * - Codecov coverage + trend (optional)
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { formatTimeAgo } from '../utils/formatters.js';
import type { TestingData, FailingSuite } from '../utils/testing-reader.js';

export interface TestingSectionProps {
  data: TestingData;
}

// Sparkline block characters (8 levels)
const SPARK_BLOCKS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

// Column widths for tabular layout
const COL_NAME = 35;
const COL_AGE = 9;
const COL_FW = 9;

function miniSparkline(data: number[], color: string): React.ReactElement {
  if (data.length === 0 || data.every(d => d === 0)) {
    return <Text color="gray">no data</Text>;
  }

  const max = Math.max(...data, 1);
  const chars = data.map(v => {
    const idx = Math.min(Math.round((v / max) * 7), 7);
    return SPARK_BLOCKS[idx];
  });

  return <Text color={color}>{chars.join('')}</Text>;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

function ageColor(since: string): string {
  const hoursAgo = (Date.now() - new Date(since).getTime()) / (3600 * 1000);
  if (hoursAgo > 6) return 'red';
  if (hoursAgo > 1) return 'yellow';
  return 'white';
}

function frameworkColor(fw: string): string {
  switch (fw) {
    case 'jest': return 'magenta';
    case 'vitest': return 'green';
    case 'playwright': return 'blue';
    default: return 'gray';
  }
}

function FixAttemptPips({ count }: { count: number }): React.ReactElement {
  if (count === 0) {
    return <Text color="gray">{'\u25CB'.repeat(5)} 0</Text>;
  }
  const maxPips = 5;
  const filled = Math.min(count, maxPips);
  const empty = maxPips - filled;
  const pips = '\u25CF'.repeat(filled) + '\u25CB'.repeat(empty);
  const color = count >= 4 ? 'red' : count >= 2 ? 'yellow' : 'white';
  return <Text color={color}>{pips} {count}</Text>;
}

function FailingSuiteRow({ suite }: { suite: FailingSuite }): React.ReactElement {
  return (
    <Box flexDirection="row">
      <Text color="red">  {'\u2717'} </Text>
      <Box width={COL_NAME}>
        <Text color="white">{truncate(suite.name, COL_NAME - 1)}</Text>
      </Box>
      <Box width={COL_AGE}>
        <Text color={ageColor(suite.since)}>{formatTimeAgo(suite.since)}</Text>
      </Box>
      <Box width={COL_FW}>
        <Text color={frameworkColor(suite.framework)}>{suite.framework === 'unknown' ? '-' : suite.framework}</Text>
      </Box>
      <FixAttemptPips count={suite.fixAttempts} />
    </Box>
  );
}

export function TestingSection({ data }: TestingSectionProps): React.ReactElement | null {
  if (!data.hasData) return null;

  const hasFailingSuites = data.failingSuites.length > 0;
  const hasActivity = data.dailyTestActivity.length > 0;
  const hasCodecov = data.codecov !== null;
  const bd = data.agentBreakdown24h;
  const hasAgentActivity = data.testAgentSpawns24h > 0;
  const hasSummaryMetrics = hasAgentActivity || data.suitesFixedRecently > 0 || data.uniqueFailureSignatures24h > 0;

  return (
    <Section title="TESTING" borderColor="red" width="100%">
      <Box flexDirection="column">
        {/* Failing suites */}
        {hasFailingSuites && (
          <Box flexDirection="column">
            <Text color="red" bold>Failing Suites ({data.failingSuites.length})</Text>
            {data.failingSuites.map((s, i) => (
              <FailingSuiteRow key={`fs-${i}`} suite={s} />
            ))}
          </Box>
        )}

        {!hasFailingSuites && (
          <Box>
            <Text color="green" bold>All Suites Passing</Text>
          </Box>
        )}

        {/* Agent breakdown + summary metrics */}
        {hasSummaryMetrics && (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" gap={2}>
              <Text color="gray">Agents (24h): </Text>
              <Text color={hasAgentActivity ? 'cyan' : 'gray'}>{data.testAgentSpawns24h}</Text>
              {hasAgentActivity && (
                <>
                  <Text color="gray">  Jest: </Text><Text color="magenta">{bd.jest}</Text>
                  <Text color="gray">  Vitest: </Text><Text color="green">{bd.vitest}</Text>
                  <Text color="gray">  PW: </Text><Text color="blue">{bd.playwright}</Text>
                  <Text color="gray">  Writer: </Text><Text color="cyan">{bd.testWriter}</Text>
                </>
              )}
            </Box>
            <Box flexDirection="row" gap={3}>
              {data.suitesFixedRecently > 0 && (
                <Box>
                  <Text color="gray">Resolved: </Text>
                  <Text color="green">{data.suitesFixedRecently} suite{data.suitesFixedRecently !== 1 ? 's' : ''}</Text>
                </Box>
              )}
              {data.uniqueFailureSignatures24h > 0 && (
                <Box>
                  <Text color="gray">Unique failures: </Text>
                  <Text color="yellow">{data.uniqueFailureSignatures24h}</Text>
                </Box>
              )}
            </Box>
          </Box>
        )}

        {/* Sparkline + Codecov footer */}
        <Box flexDirection="row" marginTop={1} gap={3}>
          {hasActivity && (
            <Box>
              <Text color="gray">7d activity: </Text>
              {miniSparkline(data.dailyTestActivity, 'cyan')}
            </Box>
          )}
          {hasCodecov && data.codecov && (
            <>
              <Box>
                <Text color="gray">Coverage: </Text>
                <Text color={data.codecov.coveragePercent >= 80 ? 'green' : data.codecov.coveragePercent >= 60 ? 'yellow' : 'red'}>
                  {Math.round(data.codecov.coveragePercent)}%
                </Text>
              </Box>
              {data.codecov.trend.length > 0 && (
                <Box>
                  <Text color="gray">7d trend: </Text>
                  {miniSparkline(data.codecov.trend, 'green')}
                </Box>
              )}
            </>
          )}
        </Box>
      </Box>
    </Section>
  );
}
