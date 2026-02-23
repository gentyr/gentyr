/**
 * Worktree Section Component
 *
 * Shows git worktree status: summary, tabular list with agent/stage info,
 * pipeline stage breakdown, and cleanup hints for merged branches.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { formatTimeAgo } from '../utils/formatters.js';
import type { WorktreeData, WorktreeEntry, PipelineStage } from '../utils/worktree-reader.js';

export interface WorktreeSectionProps {
  data: WorktreeData;
  tip?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

function stageColor(stage: PipelineStage): string {
  if (stage === 'production') return 'green';
  if (stage === 'staging') return 'yellow';
  if (stage === 'preview') return 'cyan';
  return 'white';
}

function stageLabel(stage: PipelineStage): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

// ─── Summary ────────────────────────────────────────────────────────────

function WorktreeSummary({ summary }: { summary: WorktreeData['summary'] }): React.ReactElement {
  const parts: string[] = [];
  if (summary.active > 0) parts.push(`${summary.active} active`);
  if (summary.idle > 0) parts.push(`${summary.idle} idle`);
  if (summary.merged > 0) parts.push(`${summary.merged} merged`);
  if (summary.system > 0) parts.push(`${summary.system} system`);

  return (
    <Box>
      <Text color="white" bold>{summary.total} worktree{summary.total !== 1 ? 's' : ''}</Text>
      {parts.length > 0 && (
        <Text color="gray"> ({parts.join(', ')})</Text>
      )}
    </Box>
  );
}

// ─── Table ──────────────────────────────────────────────────────────────

function WorktreeTable({ worktrees }: { worktrees: WorktreeEntry[] }): React.ReactElement {
  // Sort: active agents first, then by lastCommitAge newest first
  const sorted = [...worktrees].sort((a, b) => {
    const aHasAgent = a.agent !== null ? 0 : 1;
    const bHasAgent = b.agent !== null ? 0 : 1;
    if (aHasAgent !== bHasAgent) return aHasAgent - bHasAgent;
    return new Date(b.lastCommitAge).getTime() - new Date(a.lastCommitAge).getTime();
  });

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box flexDirection="row">
        <Box width={24}><Text bold dimColor>Branch</Text></Box>
        <Box width={14}><Text bold dimColor>Agent</Text></Box>
        <Box width={11}><Text bold dimColor>Stage</Text></Box>
        <Box width={6}><Text bold dimColor>Age</Text></Box>
        <Box width={25}><Text bold dimColor>Commit</Text></Box>
      </Box>
      {/* Rows */}
      {sorted.map((wt) => {
        const timeStr = formatTimeAgo(wt.lastCommitAge).replace(' ago', '');

        let agentNode: React.ReactElement;
        if (wt.isSystem) {
          agentNode = <Text color="cyan">(system)</Text>;
        } else if (wt.agent) {
          agentNode = <Text color="green">{truncate(wt.agent.type, 13)}</Text>;
        } else {
          agentNode = <Text color="gray">{'\u2014'}</Text>;
        }

        return (
          <Box key={wt.path} flexDirection="row">
            <Box width={24}><Text color="white">{truncate(wt.branch, 23)}</Text></Box>
            <Box width={14}>{agentNode}</Box>
            <Box width={11}><Text color={stageColor(wt.pipelineStage)}>{stageLabel(wt.pipelineStage)}</Text></Box>
            <Box width={6}><Text color="gray">{timeStr}</Text></Box>
            <Box width={25}><Text color="gray">{truncate(wt.lastCommitMessage, 24)}</Text></Box>
          </Box>
        );
      })}
    </Box>
  );
}

// ─── Pipeline Progress ──────────────────────────────────────────────────

function PipelineProgress({ worktrees }: { worktrees: WorktreeEntry[] }): React.ReactElement {
  const stages: PipelineStage[] = ['local', 'preview', 'staging', 'production'];
  const counts: Record<PipelineStage, number> = { local: 0, preview: 0, staging: 0, production: 0 };

  for (const wt of worktrees) {
    counts[wt.pipelineStage]++;
  }

  return (
    <Box flexDirection="column">
      {stages.map(stage => (
        <Box key={stage} flexDirection="row">
          <Text color={stageColor(stage)}>{'\u25CF'} </Text>
          <Box width={13}><Text color={stageColor(stage)}>{stageLabel(stage)}</Text></Box>
          <Text color="gray">{counts[stage]} branch{counts[stage] !== 1 ? 'es' : ''}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ─── Cleanup Hint ───────────────────────────────────────────────────────

function CleanupHint({ count }: { count: number }): React.ReactElement {
  return (
    <Box>
      <Text color="yellow" dimColor>
        {count} merged worktree{count !== 1 ? 's' : ''} ready for removal
      </Text>
    </Box>
  );
}

// ─── Main Section ───────────────────────────────────────────────────────

export function WorktreeSection({ data, tip }: WorktreeSectionProps): React.ReactElement | null {
  if (!data.hasData || data.worktrees.length === 0) return null;

  return (
    <Section title="WORKTREES" borderColor="magenta" tip={tip}>
      <Box flexDirection="column" gap={1}>
        <WorktreeSummary summary={data.summary} />
        <WorktreeTable worktrees={data.worktrees} />
        <PipelineProgress worktrees={data.worktrees} />
        {data.summary.merged > 0 && <CleanupHint count={data.summary.merged} />}
      </Box>
    </Section>
  );
}
