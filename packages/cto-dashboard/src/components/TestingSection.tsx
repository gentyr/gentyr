/**
 * Testing Section Component
 *
 * Shows test health data:
 * - Currently failing suites
 * - Test fix agent activity (24h)
 * - 7-day test failure agent sparkline
 * - Codecov coverage + trend (optional)
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import type { TestingData, FailingSuite } from '../utils/testing-reader.js';

export interface TestingSectionProps {
  data: TestingData;
}

// Sparkline block characters (8 levels)
const SPARK_BLOCKS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

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

function formatTimeAgo(isoStr: string): string {
  const now = Date.now();
  const then = new Date(isoStr).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function FailingSuiteRow({ suite }: { suite: FailingSuite }): React.ReactElement {
  return (
    <Box>
      <Text color="red">  \u2717 </Text>
      <Text color="white">{suite.name}</Text>
      <Text color="gray"> (since {formatTimeAgo(suite.since)})</Text>
    </Box>
  );
}

export function TestingSection({ data }: TestingSectionProps): React.ReactElement | null {
  if (!data.hasData) return null;

  const hasFailingSuites = data.failingSuites.length > 0;
  const hasActivity = data.dailyTestActivity.length > 0;
  const hasCodecov = data.codecov !== null;

  return (
    <Section title="TESTING" borderColor="red">
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

        {/* Test agent activity + sparkline */}
        <Box flexDirection="row" marginTop={1} gap={3}>
          <Box>
            <Text color="gray">Test fix agents (24h): </Text>
            <Text color={data.testAgentSpawns24h > 0 ? 'cyan' : 'gray'}>{data.testAgentSpawns24h}</Text>
          </Box>
          {hasActivity && (
            <Box>
              <Text color="gray">7d activity: </Text>
              {miniSparkline(data.dailyTestActivity, 'cyan')}
            </Box>
          )}
        </Box>

        {/* Codecov */}
        {hasCodecov && data.codecov && (
          <Box flexDirection="row" marginTop={1} gap={3}>
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
          </Box>
        )}
      </Box>
    </Section>
  );
}
