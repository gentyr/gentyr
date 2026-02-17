/**
 * Deployments Section Component
 *
 * Shows Render + Vercel service status, combined recent deploy timeline,
 * and GENTYR pipeline promotion state.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { formatTimeAgo } from '../utils/formatters.js';
import type { DeploymentsData, DeploymentEntry } from '../utils/deployments-reader.js';

export interface DeploymentsSectionProps {
  data: DeploymentsData;
}

function statusColor(status: string): string {
  if (status === 'live' || status === 'ready' || status === 'active') return 'green';
  if (status === 'building') return 'yellow';
  if (status === 'failed' || status === 'error') return 'red';
  if (status === 'suspended') return 'gray';
  return 'white';
}

function statusDot(): string {
  return '\u25CF';
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

function ServiceList({ title, items }: {
  title: string;
  items: Array<{ name: string; status: string; extra?: string }>;
}): React.ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0}>
      <Text color="white" bold>{title}</Text>
      {items.length === 0 && (
        <Text color="gray">  unavailable</Text>
      )}
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        const prefix = isLast ? ' \u2514\u2500 ' : ' \u251C\u2500 ';
        return (
          <Box key={`svc-${i}`} flexDirection="row">
            <Text color="gray">{prefix}</Text>
            <Text color="white">{truncate(item.name, 16)}</Text>
            <Text>  </Text>
            <Text color={statusColor(item.status)}>{statusDot()} {item.status}</Text>
            {item.extra && <Text color="gray">  {item.extra}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}

function DeployRow({ deploy }: { deploy: DeploymentEntry }): React.ReactElement {
  const timeStr = formatTimeAgo(deploy.deployedAt).replace(' ago', '');
  return (
    <Box flexDirection="row">
      <Box width={8}>
        <Text color="gray">{timeStr}</Text>
      </Box>
      <Text color={statusColor(deploy.status)}> {statusDot()} </Text>
      <Box width={16}>
        <Text color="white">{truncate(deploy.service, 15)}</Text>
      </Box>
      <Box width={9}>
        <Text color="gray">{deploy.platform}</Text>
      </Box>
      <Box width={10}>
        <Text color={statusColor(deploy.status)}>{deploy.status}</Text>
      </Box>
      {deploy.commitMessage && (
        <Text color="gray">{truncate(deploy.commitMessage, 40)}</Text>
      )}
    </Box>
  );
}

function PipelineRow({ pipeline }: { pipeline: DeploymentsData['pipeline'] }): React.ReactElement {
  const previewOk = pipeline.previewStatus === 'checked';
  const stagingOk = pipeline.stagingStatus === 'checked';

  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color="gray">Pipeline:  </Text>
      <Text color={previewOk ? 'green' : 'gray'}>preview {previewOk ? '\u2713' : '\u2013'}</Text>
      <Text color="gray">  {'\u2192'}  </Text>
      <Text color={stagingOk ? 'green' : 'gray'}>staging {stagingOk ? '\u2713' : '\u2013'}</Text>
      <Text color="gray">  {'\u2192'}  </Text>
      <Text color="gray">production (24h gate)</Text>
    </Box>
  );
}

export function DeploymentsSection({ data }: DeploymentsSectionProps): React.ReactElement | null {
  if (!data.hasData) return null;

  const renderServices = data.render.services.map(s => ({
    name: s.name,
    status: s.suspended ? 'suspended' : 'active',
    extra: s.type,
  }));

  const vercelProjects = data.vercel.projects.map(p => ({
    name: p.name,
    status: 'active',
    extra: p.framework,
  }));

  return (
    <Section title="DEPLOYMENTS" borderColor="blue" width="100%">
      <Box flexDirection="column">
        {/* Side-by-side service lists */}
        <Box flexDirection="row" gap={2}>
          <ServiceList title="Render" items={renderServices} />
          <ServiceList title="Vercel" items={vercelProjects} />
        </Box>

        {/* Recent deploys timeline */}
        {data.combined.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="white" bold>Recent Deploys</Text>
            {data.combined.map((d, i) => (
              <DeployRow key={`deploy-${i}`} deploy={d} />
            ))}
          </Box>
        )}

        {/* Pipeline promotion state */}
        <PipelineRow pipeline={data.pipeline} />
      </Box>
    </Section>
  );
}
