/**
 * Infrastructure Section Component
 *
 * Shows health summary for 5 providers: Render, Vercel, Supabase, Elastic, Cloudflare.
 * Each provider shows a 1-2 line summary with status dots.
 * Per-platform event tables shown below the provider grid.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { formatNumber, formatTimeAgo } from '../utils/formatters.js';
import type { InfraData } from '../utils/infra-reader.js';
import type { DeploymentsData, DeploymentEntry } from '../utils/deployments-reader.js';

export interface InfraSectionProps {
  data: InfraData;
  deployments?: DeploymentsData;
}

function providerColor(available: boolean, hasIssues: boolean): string {
  if (!available) return 'gray';
  if (hasIssues) return 'yellow';
  return 'green';
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

function statusColor(status: string): string {
  if (status === 'live' || status === 'ready' || status === 'active') return 'green';
  if (status === 'building') return 'yellow';
  if (status === 'failed' || status === 'error') return 'red';
  return 'white';
}

function EventRow({ deploy }: { deploy: DeploymentEntry }): React.ReactElement {
  const timeStr = formatTimeAgo(deploy.deployedAt).replace(' ago', '');
  return (
    <Box flexDirection="row">
      <Box width={8}><Text color="gray">{timeStr}</Text></Box>
      <Box width={24}><Text color="white">{truncate(deploy.service, 23)}</Text></Box>
      <Text color={statusColor(deploy.status)}>{deploy.status}</Text>
    </Box>
  );
}

export function InfraSection({ data, deployments }: InfraSectionProps): React.ReactElement | null {
  if (!data.hasData) return null;

  const renderColor = providerColor(data.render.available, data.render.suspendedCount > 0);
  const vercelColor = providerColor(data.vercel.available, data.vercel.errorDeploys > 0);
  const supabaseColor = providerColor(data.supabase.available, !data.supabase.healthy);
  const elasticColor = providerColor(data.elastic.available, data.elastic.errorCount1h > 0);
  const cloudflareColor = providerColor(
    data.cloudflare.available,
    data.cloudflare.status !== 'active' && data.cloudflare.available,
  );

  const renderDeploys = deployments?.render.recentDeploys.slice(0, 3) || [];
  const vercelDeploys = deployments?.vercel.recentDeploys.slice(0, 3) || [];

  return (
    <Section title="INFRASTRUCTURE" borderColor="magenta" width="100%">
      <Box flexDirection="column">
        {/* Provider summary — single-line per provider for clean alignment */}
        <Box flexDirection="row">
          <Box width={16}>
            <Text color="white" bold>Provider</Text>
          </Box>
          <Box width={14}>
            <Text color="white" bold>Status</Text>
          </Box>
          <Box width={20}>
            <Text color="white" bold>Detail</Text>
          </Box>
          <Text color="white" bold>Extra</Text>
        </Box>

        {/* Render */}
        <Box flexDirection="row">
          <Box width={16}><Text color="white">Render</Text></Box>
          <Box width={14}>
            {data.render.available ? (
              <Text color={renderColor}>{'\u25CF'} {data.render.serviceCount} svc</Text>
            ) : (
              <Text color="gray">{'\u25CB'} unavailable</Text>
            )}
          </Box>
          <Box width={20}>
            {data.render.available && (
              <Text color={data.render.suspendedCount > 0 ? 'yellow' : 'gray'}>
                {data.render.suspendedCount} suspended
              </Text>
            )}
          </Box>
          {data.render.available && data.render.lastDeployAt && (
            <Text color="gray">deploy {formatTimeAgo(data.render.lastDeployAt)}</Text>
          )}
        </Box>

        {/* Vercel */}
        <Box flexDirection="row">
          <Box width={16}><Text color="white">Vercel</Text></Box>
          <Box width={14}>
            {data.vercel.available ? (
              <Text color={vercelColor}>{'\u25CF'} {data.vercel.projectCount} proj</Text>
            ) : (
              <Text color="gray">{'\u25CB'} unavailable</Text>
            )}
          </Box>
          <Box width={20}>
            {data.vercel.available && (
              <Text color={data.vercel.errorDeploys > 0 ? 'red' : 'gray'}>
                {data.vercel.errorDeploys} err (24h)
              </Text>
            )}
          </Box>
          {data.vercel.available && data.vercel.buildingCount > 0 && (
            <Text color="yellow">{data.vercel.buildingCount} building</Text>
          )}
        </Box>

        {/* Supabase */}
        <Box flexDirection="row">
          <Box width={16}><Text color="white">Supabase</Text></Box>
          <Box width={14}>
            {data.supabase.available ? (
              <Text color={supabaseColor}>{'\u25CF'} {data.supabase.healthy ? 'healthy' : 'unhealthy'}</Text>
            ) : (
              <Text color="gray">{'\u25CB'} unavailable</Text>
            )}
          </Box>
        </Box>

        {/* Elastic */}
        <Box flexDirection="row">
          <Box width={16}><Text color="white">Elastic</Text></Box>
          <Box width={14}>
            {data.elastic.available ? (
              <Text color={elasticColor}>{'\u25CF'} active</Text>
            ) : (
              <Text color="gray">{'\u25CB'} unavailable</Text>
            )}
          </Box>
          <Box width={20}>
            {data.elastic.available && (
              <Text color="white">{formatNumber(data.elastic.totalLogs1h)} logs/1h</Text>
            )}
          </Box>
          {data.elastic.available && (
            <Text color={data.elastic.errorCount1h > 0 ? 'red' : 'gray'}>
              {data.elastic.errorCount1h} err  {data.elastic.warnCount1h} warn
            </Text>
          )}
        </Box>

        {/* Cloudflare */}
        <Box flexDirection="row">
          <Box width={16}><Text color="white">Cloudflare</Text></Box>
          <Box width={14}>
            {data.cloudflare.available ? (
              <Text color={cloudflareColor}>{'\u25CF'} {data.cloudflare.status}</Text>
            ) : (
              <Text color="gray">{'\u25CB'} unavailable</Text>
            )}
          </Box>
          <Box width={20}>
            {data.cloudflare.available && data.cloudflare.planName && (
              <Text color="gray">{data.cloudflare.planName}</Text>
            )}
          </Box>
          {data.cloudflare.available && data.cloudflare.nameServers.length > 0 && (
            <Text color="gray">NS: {data.cloudflare.nameServers.length}</Text>
          )}
        </Box>

        {/* Per-platform event tables */}
        {(renderDeploys.length > 0 || vercelDeploys.length > 0) && (
          <Box flexDirection="column" marginTop={1}>
            {renderDeploys.length > 0 && (
              <Box flexDirection="column">
                <Text color="cyan" bold>Render Events</Text>
                {renderDeploys.map((d, i) => (
                  <EventRow key={`re-${i}`} deploy={d} />
                ))}
              </Box>
            )}

            {vercelDeploys.length > 0 && (
              <Box flexDirection="column" marginTop={renderDeploys.length > 0 ? 1 : 0}>
                <Text color="cyan" bold>Vercel Events</Text>
                {vercelDeploys.map((d, i) => (
                  <EventRow key={`ve-${i}`} deploy={d} />
                ))}
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Section>
  );
}
