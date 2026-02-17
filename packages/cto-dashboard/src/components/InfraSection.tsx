/**
 * Infrastructure Section Component
 *
 * Shows health summary for 5 providers: Render, Vercel, Supabase, Elastic, Cloudflare.
 * Each provider shows a 1-2 line summary with status dots.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { formatNumber } from '../utils/formatters.js';
import type { InfraData } from '../utils/infra-reader.js';

export interface InfraSectionProps {
  data: InfraData;
}

function providerColor(available: boolean, hasIssues: boolean): string {
  if (!available) return 'gray';
  if (hasIssues) return 'yellow';
  return 'green';
}

function StatusDot({ color }: { color: string }): React.ReactElement {
  return <Text color={color}>{'\u25CF'}</Text>;
}

export function InfraSection({ data }: InfraSectionProps): React.ReactElement | null {
  if (!data.hasData) return null;

  const renderColor = providerColor(data.render.available, data.render.suspendedCount > 0);
  const vercelColor = providerColor(data.vercel.available, data.vercel.errorDeploys > 0);
  const supabaseColor = providerColor(data.supabase.available, !data.supabase.healthy);
  const elasticColor = providerColor(data.elastic.available, data.elastic.errorCount1h > 0);
  const cloudflareColor = providerColor(
    data.cloudflare.available,
    data.cloudflare.status !== 'active' && data.cloudflare.available,
  );

  return (
    <Section title="INFRASTRUCTURE" borderColor="magenta" width="100%">
      <Box flexDirection="column">
        {/* Provider summary row */}
        <Box flexDirection="row" gap={2}>
          {/* Render */}
          <Box flexDirection="column" width={18}>
            <Text color="white" bold>Render</Text>
            {data.render.available ? (
              <>
                <Box>
                  <StatusDot color={renderColor} />
                  <Text color="white"> {data.render.serviceCount} service{data.render.serviceCount !== 1 ? 's' : ''}</Text>
                </Box>
                <Text color={data.render.suspendedCount > 0 ? 'yellow' : 'gray'}>
                  {data.render.suspendedCount} suspended
                </Text>
              </>
            ) : (
              <Text color="gray">unavailable</Text>
            )}
          </Box>

          {/* Vercel */}
          <Box flexDirection="column" width={18}>
            <Text color="white" bold>Vercel</Text>
            {data.vercel.available ? (
              <>
                <Box>
                  <StatusDot color={vercelColor} />
                  <Text color="white"> {data.vercel.projectCount} project{data.vercel.projectCount !== 1 ? 's' : ''}</Text>
                </Box>
                <Text color={data.vercel.errorDeploys > 0 ? 'red' : 'gray'}>
                  {data.vercel.errorDeploys} error{data.vercel.errorDeploys !== 1 ? 's' : ''} (24h)
                </Text>
              </>
            ) : (
              <Text color="gray">unavailable</Text>
            )}
          </Box>

          {/* Supabase */}
          <Box flexDirection="column" width={18}>
            <Text color="white" bold>Supabase</Text>
            {data.supabase.available ? (
              <Box>
                <StatusDot color={supabaseColor} />
                <Text color={data.supabase.healthy ? 'green' : 'red'}>
                  {' '}{data.supabase.healthy ? 'healthy' : 'unhealthy'}
                </Text>
              </Box>
            ) : (
              <Text color="gray">unavailable</Text>
            )}
          </Box>

          {/* Elastic */}
          <Box flexDirection="column" width={14}>
            <Text color="white" bold>Elastic</Text>
            {data.elastic.available ? (
              <>
                <Box>
                  <StatusDot color={elasticColor} />
                  <Text color="white"> active</Text>
                </Box>
                <Text color={data.elastic.errorCount1h > 0 ? 'red' : 'gray'}>
                  {data.elastic.errorCount1h} err/1h
                </Text>
              </>
            ) : (
              <Text color="gray">unavailable</Text>
            )}
          </Box>

          {/* Cloudflare */}
          <Box flexDirection="column" width={14}>
            <Text color="white" bold>Cloudflare</Text>
            {data.cloudflare.available ? (
              <Box>
                <StatusDot color={cloudflareColor} />
                <Text color={cloudflareColor}> {data.cloudflare.status}</Text>
              </Box>
            ) : (
              <Text color="gray">unavailable</Text>
            )}
          </Box>
        </Box>

        {/* Elastic detail row */}
        {data.elastic.available && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="cyan" bold>Elastic Logs (1h)</Text>
            <Box flexDirection="row">
              <Text color="gray"> {'\u251C\u2500'} Total: </Text>
              <Text color="white">{formatNumber(data.elastic.totalLogs1h)}</Text>
              <Text color="gray">    Errors: </Text>
              <Text color={data.elastic.errorCount1h > 0 ? 'red' : 'green'}>{data.elastic.errorCount1h}</Text>
              <Text color="gray">    Warnings: </Text>
              <Text color={data.elastic.warnCount1h > 0 ? 'yellow' : 'green'}>{data.elastic.warnCount1h}</Text>
            </Box>
            {data.elastic.topServices.length > 0 && (
              <Box>
                <Text color="gray"> {'\u2514\u2500'} Top: </Text>
                <Text color="white">
                  {data.elastic.topServices.map(s => `${s.name} (${formatNumber(s.count)})`).join('  ')}
                </Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Section>
  );
}
