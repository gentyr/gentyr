/**
 * SubTaskRow — returns a single <Text> with embedded \n for ALL sub-task content.
 * This prevents Ink's line-merging bug when there are many <Text> siblings.
 */

import React from 'react';
import { Text } from 'ink';
import type { SubTaskItem } from '../../types.js';
import { formatElapsed, formatTokens, truncate } from '../../utils/formatters.js';

interface SubTaskRowProps {
  subTask: SubTaskItem;
  isLast: boolean;
  width: number;
}

function statusIcon(status: string): string {
  switch (status) {
    case 'completed': return '\u2713';
    case 'in_progress': return '\u25B6';
    case 'pending':
    case 'pending_review': return '\u25CB';
    default: return '\u00B7';
  }
}

export function SubTaskRow({ subTask, isLast, width }: SubTaskRowProps): React.ReactElement {
  const icon = statusIcon(subTask.status);
  const connector = isLast ? '\u2514\u2500 ' : '\u251C\u2500 ';
  const continuation = isLast ? '   ' : '\u2502  ';
  const titleMax = Math.max(8, width - 12);
  const isDone = subTask.status === 'completed';
  const isActive = subTask.status === 'in_progress';

  const rightParts: string[] = [];
  if (isActive && subTask.agentStage) {
    rightParts.push(`[${subTask.agentStage}]`);
    if (subTask.agentProgressPct != null) rightParts.push(`${subTask.agentProgressPct}%`);
  }
  if (subTask.prUrl) rightParts.push(subTask.prMerged ? '\u2713PR' : 'PR');
  const rightStr = rightParts.length > 0 ? ' ' + rightParts.join(' ') : '';

  // Build all lines for this sub-task as a single string
  const lines: string[] = [];
  lines.push(`${connector}${icon} ${truncate(subTask.title, titleMax - rightStr.length)}${rightStr}`);

  if (isDone && subTask.worklog) {
    const ok = subTask.worklog.success ? 'OK' : 'FAIL';
    const dur = subTask.worklog.durationMs != null ? formatElapsed(subTask.worklog.durationMs) : '-';
    const tok = formatTokens(subTask.worklog.tokens);
    lines.push(`${continuation} ${ok} ${dur} ${tok}`);
    lines.push(`${continuation} ${truncate(subTask.worklog.summary, Math.max(8, width - 6))}`);
  }

  return (
    <Text dimColor={isDone} bold={isActive}>
      {lines.join('\n')}
    </Text>
  );
}

export function estimateSubTaskLines(st: SubTaskItem): number {
  let h = 1;
  if (st.status === 'completed' && st.worklog) h += 2;
  return h;
}
