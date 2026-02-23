/**
 * Deployments Section Component
 *
 * Shows per-environment health overview (Preview, Staging, Production),
 * per-environment deploy tables, pipeline state, and deployment stats.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { formatTimeAgo } from '../utils/formatters.js';
import type { DeploymentsData, DeploymentEntry, DeployEnvironment } from '../utils/deployments-reader.js';

export interface DeploymentsSectionProps {
  data: DeploymentsData;
  tip?: string;
}

function statusColor(status: string): string {
  if (status === 'live' || status === 'ready' || status === 'active') return 'green';
  if (status === 'building') return 'yellow';
  if (status === 'failed' || status === 'error') return 'red';
  if (status === 'suspended') return 'gray';
  return 'white';
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

function envLabel(env: DeployEnvironment): string {
  return env.charAt(0).toUpperCase() + env.slice(1);
}

function envColor(env: DeployEnvironment): string {
  if (env === 'production') return 'green';
  if (env === 'staging') return 'yellow';
  return 'cyan';
}

function envHealthStatus(deploys: DeploymentEntry[]): { status: string; color: string } {
  if (deploys.length === 0) return { status: 'no data', color: 'gray' };
  const latest = deploys[0];
  if (latest.status === 'failed' || latest.status === 'error') return { status: 'failing', color: 'red' };
  if (latest.status === 'building') return { status: 'deploying', color: 'yellow' };
  return { status: 'healthy', color: 'green' };
}

// ─── Environment Health Overview ─────────────────────────────────────────

function EnvironmentHealth({ data, localDevCount }: { data: DeploymentsData; localDevCount: number }): React.ReactElement {
  const envs: DeployEnvironment[] = ['production', 'staging', 'preview'];

  return (
    <Box flexDirection="row" gap={3}>
      <Box key="local-dev" flexDirection="column" width={18}>
        <Text color="cyan" bold>Local Dev</Text>
        <Text color={localDevCount > 0 ? 'white' : 'gray'}>
          {localDevCount} branch{localDevCount !== 1 ? 'es' : ''}
        </Text>
      </Box>
      {envs.map(env => {
        const deploys = data.byEnvironment[env];
        const health = envHealthStatus(deploys);
        const latest = deploys.length > 0 ? deploys[0] : null;

        return (
          <Box key={env} flexDirection="column" width={18}>
            <Text color={envColor(env)} bold>{envLabel(env)}</Text>
            <Box>
              <Text color={health.color}>{'\u25CF'} {health.status}</Text>
            </Box>
            {latest && (
              <Text color="gray">
                {formatTimeAgo(latest.deployedAt)} via {latest.platform}
              </Text>
            )}
            <Text color="gray">{deploys.length} deploy{deploys.length !== 1 ? 's' : ''}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ─── Pipeline Detail ─────────────────────────────────────────────────────

function PipelineDetail({ pipeline }: { pipeline: DeploymentsData['pipeline'] }): React.ReactElement {
  const previewOk = pipeline.previewStatus === 'checked';
  const stagingOk = pipeline.stagingStatus === 'checked';
  const { localDevCount, stagingFreezeActive } = pipeline;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color="gray">Pipeline: </Text>
        <Text color={localDevCount > 0 ? 'cyan' : 'gray'} dimColor={localDevCount === 0}>local dev ({localDevCount})</Text>
        <Text color="gray"> {'\u2192'} </Text>
        <Text color={previewOk ? 'green' : 'gray'}>preview {previewOk ? '\u2713' : '\u2013'}</Text>
        <Text color="gray"> {'\u2192'} </Text>
        <Text color={stagingOk ? 'green' : 'gray'}>staging {stagingOk ? '\u2713' : '\u2013'}</Text>
        {stagingFreezeActive && <Text color="cyan"> {'\u2744'}</Text>}
        <Text color="gray"> {'\u2192'} </Text>
        <Text color="gray">production (24h gate)</Text>
        {pipeline.lastPromotionAt && (
          <>
            <Text color="gray">  Last: </Text>
            <Text color="white">{formatTimeAgo(pipeline.lastPromotionAt)}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

// ─── Deploy Table Row ────────────────────────────────────────────────────

function EnvDeployRow({ deploy }: { deploy: DeploymentEntry }): React.ReactElement {
  const timeStr = formatTimeAgo(deploy.deployedAt).replace(' ago', '');
  return (
    <Box flexDirection="row">
      <Box width={8}><Text color="gray">{timeStr}</Text></Box>
      <Box width={4}><Text color={statusColor(deploy.status)}>{'\u25CF'} </Text></Box>
      <Box width={24}><Text color="white">{truncate(deploy.service, 23)}</Text></Box>
      <Box width={9}><Text color="gray">{deploy.platform}</Text></Box>
      <Box width={10}><Text color={statusColor(deploy.status)}>{deploy.status}</Text></Box>
      {deploy.commitMessage && (
        <Box width={25}><Text color="gray">{truncate(deploy.commitMessage, 24)}</Text></Box>
      )}
    </Box>
  );
}

// ─── Per-Environment Deploy Table ────────────────────────────────────────

function EnvironmentDeploys({ env, deploys }: { env: DeployEnvironment; deploys: DeploymentEntry[] }): React.ReactElement | null {
  if (deploys.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={envColor(env)} bold>{envLabel(env)} Deploys</Text>
      {deploys.map((d, i) => (
        <EnvDeployRow key={`${env}-${i}`} deploy={d} />
      ))}
    </Box>
  );
}

// ─── Deploy Stats Footer ─────────────────────────────────────────────────

function DeployStats({ stats }: { stats: DeploymentsData['stats'] }): React.ReactElement {
  const successRate = stats.totalDeploys24h > 0
    ? Math.round((stats.successCount24h / stats.totalDeploys24h) * 100)
    : 0;
  const deploysPerHour = stats.totalDeploys24h > 0
    ? (stats.totalDeploys24h / 24).toFixed(1)
    : '0';

  return (
    <Box flexDirection="row" marginTop={1} gap={3}>
      <Box>
        <Text color="gray">Deploys (24h): </Text>
        <Text color="white">{stats.totalDeploys24h}</Text>
      </Box>
      <Box>
        <Text color="gray">Success: </Text>
        <Text color={successRate >= 90 ? 'green' : successRate >= 70 ? 'yellow' : 'red'}>{successRate}%</Text>
      </Box>
      <Box>
        <Text color="gray">Failed: </Text>
        <Text color={stats.failedCount24h > 0 ? 'red' : 'green'}>{stats.failedCount24h}</Text>
      </Box>
      <Box>
        <Text color="gray">Freq: </Text>
        <Text color="white">{deploysPerHour}/hr</Text>
      </Box>
    </Box>
  );
}

// ─── Main Section ────────────────────────────────────────────────────────

export function DeploymentsSection({ data, tip }: DeploymentsSectionProps): React.ReactElement | null {
  if (!data.hasData) return null;

  return (
    <Section title="DEPLOYMENTS" borderColor="blue" width="100%" tip={tip}>
      <Box flexDirection="column">
        {/* Per-environment health overview */}
        <EnvironmentHealth data={data} localDevCount={data.pipeline.localDevCount} />

        {/* Pipeline promotion state */}
        <PipelineDetail pipeline={data.pipeline} />

        {/* Per-environment deploy tables */}
        <EnvironmentDeploys env="production" deploys={data.byEnvironment.production} />
        <EnvironmentDeploys env="staging" deploys={data.byEnvironment.staging} />
        <EnvironmentDeploys env="preview" deploys={data.byEnvironment.preview} />

        {/* Deploy stats footer */}
        <DeployStats stats={data.stats} />
      </Box>
    </Section>
  );
}
