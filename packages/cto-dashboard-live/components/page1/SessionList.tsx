/**
 * SessionList — left panel with virtual windowing.
 *
 * Builds a flat array of "render blocks" from all sections, each with an
 * estimated line height. Only blocks visible in the viewport are rendered.
 * No marginTop hack, no overflow:hidden — just a direct slice of items.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { LiveDashboardData, SessionItem, PersistentTaskItem } from '../../types.js';
import { SessionRow, estimateCardLines } from './SessionRow.js';
import { PersistentTaskGroup } from './PersistentTaskGroup.js';

interface SessionListProps {
  data: LiveDashboardData;
  selectedIndex: number;
  /** Index of the first visible block */
  scrollOffset: number;
  width: number;
  height: number;
}

export interface SelectableItem {
  type: 'session';
  sessionId: string;
  item: SessionItem;
}

// ============================================================================
// Render blocks
// ============================================================================

interface RenderBlock {
  kind: 'divider' | 'session' | 'pt-group' | 'message';
  key: string;
  lines: number;            // estimated line height
  selectableIndex: number;  // -1 for non-selectable
  // Payload (only one is set per block)
  session?: SessionItem;
  ptTask?: PersistentTaskItem;
  ptMonitorSelected?: boolean;
  ptChildSelId?: string | null;
  label?: string;
  count?: number;
}

function estimateSessionLines(s: SessionItem): number {
  return estimateCardLines(s);
}

function estimatePtLines(pt: PersistentTaskItem): number {
  // Section border top(1) + HB line(1) + monitor session(2) + "Sub-Tasks" label(1)
  // + subtasks (each ~1-3 lines) + border bottom(1)
  let h = 6;
  for (const st of pt.subTasks) {
    h += 1; // tree connector + title
    if (st.status === 'in_progress' && st.agentStage) h += 1; // agent stage
    if (st.session) h += 2; // child session row
    if (st.worklog) h += 2; // worklog
  }
  return h;
}

// ============================================================================
// Build the block list + selectable items
// ============================================================================

export function buildSelectableItems(data: LiveDashboardData): SelectableItem[] {
  const items: SelectableItem[] = [];
  for (const s of data.queuedSessions) {
    items.push({ type: 'session', sessionId: s.id, item: s });
  }
  for (const pt of data.persistentTasks) {
    items.push({ type: 'session', sessionId: pt.monitorSession.id, item: pt.monitorSession });
    for (const st of pt.subTasks) {
      if (st.session) items.push({ type: 'session', sessionId: st.session.id, item: st.session });
    }
  }
  for (const s of data.runningSessions) {
    items.push({ type: 'session', sessionId: s.id, item: s });
  }
  for (const s of data.suspendedSessions) {
    items.push({ type: 'session', sessionId: s.id, item: s });
  }
  for (const s of data.completedSessions) {
    items.push({ type: 'session', sessionId: s.id, item: s });
  }
  return items;
}

export function findHomeIndex(data: LiveDashboardData): number {
  return data.queuedSessions.length;
}

function buildBlocks(
  data: LiveDashboardData,
  selectedSessionId: string | null,
  selectableItems: SelectableItem[],
): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let selIdx = 0; // tracks position in selectableItems

  // QUEUED
  blocks.push({ kind: 'divider', key: 'div-queued', lines: 2, selectableIndex: -1, label: 'QUEUED', count: data.queuedSessions.length });
  if (data.queuedSessions.length === 0) {
    blocks.push({ kind: 'message', key: 'msg-no-queued', lines: 1, selectableIndex: -1, label: '  No queued sessions' });
  }
  for (const s of data.queuedSessions) {
    blocks.push({ kind: 'session', key: `s-${s.id}`, lines: estimateSessionLines(s), selectableIndex: selIdx, session: s });
    selIdx++;
  }

  // ACTIVE
  const { running, max } = data.capacity;
  blocks.push({ kind: 'divider', key: 'div-active', lines: 2, selectableIndex: -1, label: `ACTIVE ${running}/${max}` });

  // Persistent tasks
  for (const pt of data.persistentTasks) {
    // PT monitor selectable index
    const monitorSelIdx = selIdx;
    selIdx++;
    // PT child selectable indices
    const childIdxMap = new Map<string, number>();
    for (const st of pt.subTasks) {
      if (st.session) {
        childIdxMap.set(st.id, selIdx);
        selIdx++;
      }
    }

    const monitorSel = pt.monitorSession.id === selectedSessionId;
    let childSelId: string | null = null;
    for (const st of pt.subTasks) {
      if (st.session && st.session.id === selectedSessionId) { childSelId = st.id; break; }
    }

    blocks.push({
      kind: 'pt-group', key: `pt-${pt.id}`, lines: estimatePtLines(pt),
      selectableIndex: monitorSelIdx,
      ptTask: pt, ptMonitorSelected: monitorSel, ptChildSelId: childSelId,
    });
  }

  // Running
  for (const s of data.runningSessions) {
    blocks.push({ kind: 'session', key: `s-${s.id}`, lines: estimateSessionLines(s), selectableIndex: selIdx, session: s });
    selIdx++;
  }

  // Suspended
  if (data.suspendedSessions.length > 0) {
    blocks.push({ kind: 'divider', key: 'div-suspended', lines: 2, selectableIndex: -1, label: 'SUSPENDED', count: data.suspendedSessions.length });
    for (const s of data.suspendedSessions) {
      const isSel = s.id === selectedSessionId;
      blocks.push({ kind: 'session', key: `s-${s.id}`, lines: estimateSessionLines(s), selectableIndex: selIdx, session: s });
      selIdx++;
    }
  }

  // Completed
  blocks.push({ kind: 'divider', key: 'div-completed', lines: 2, selectableIndex: -1, label: 'COMPLETED', count: data.completedSessions.length });
  if (data.completedSessions.length === 0) {
    blocks.push({ kind: 'message', key: 'msg-no-completed', lines: 1, selectableIndex: -1, label: '  No completed sessions' });
  }
  for (const s of data.completedSessions) {
    blocks.push({ kind: 'session', key: `s-${s.id}`, lines: estimateSessionLines(s), selectableIndex: selIdx, session: s });
    selIdx++;
  }

  return blocks;
}

// ============================================================================
// Compute visible window
// ============================================================================

/**
 * Given a block array and a scroll offset (block index), find the range
 * [windowStart, windowEnd) of blocks that fit within `maxLines`.
 */
function computeVisibleWindow(blocks: RenderBlock[], scrollBlockIdx: number, maxLines: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(scrollBlockIdx, blocks.length - 1));
  let usedLines = 0;
  let end = start;
  while (end < blocks.length && usedLines + blocks[end].lines <= maxLines) {
    usedLines += blocks[end].lines;
    end++;
  }
  // If we didn't fill the screen and there's room above, pull start back
  if (usedLines < maxLines && start > 0) {
    let s = start - 1;
    while (s >= 0 && usedLines + blocks[s].lines <= maxLines) {
      usedLines += blocks[s].lines;
      s--;
    }
    return { start: s + 1, end };
  }
  return { start, end };
}

/**
 * Find the block index that contains a given selectable index.
 */
function findBlockForSelectable(blocks: RenderBlock[], selectableIdx: number): number {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.selectableIndex === selectableIdx) return i;
    // PT groups contain multiple selectable indices
    if (b.kind === 'pt-group' && b.ptTask) {
      let ptSelIdx = b.selectableIndex; // monitor
      if (selectableIdx === ptSelIdx) return i;
      for (const st of b.ptTask.subTasks) {
        if (st.session) {
          ptSelIdx++;
          if (selectableIdx === ptSelIdx) return i;
        }
      }
    }
  }
  return 0;
}

// ============================================================================
// Section label component
// ============================================================================

function SectionLabel({ label, count, width }: { label: string; count?: number; width: number }): React.ReactElement {
  const text = count != null ? `${label} (${count})` : label;
  const lineLen = Math.max(1, width - text.length - 4);
  return (
    <Box marginTop={1}>
      <Text dimColor>{'\u2500\u2500 '}</Text>
      <Text bold>{text}</Text>
      <Text dimColor>{' ' + '\u2500'.repeat(lineLen)}</Text>
    </Box>
  );
}

// ============================================================================
// Main component
// ============================================================================

export function SessionList({ data, selectedIndex, scrollOffset, width, height }: SessionListProps): React.ReactElement {
  const selectableItems = useMemo(() => buildSelectableItems(data), [data]);
  const selectedItem = selectableItems[selectedIndex];
  const selectedSessionId = selectedItem?.sessionId ?? null;

  // Build flat block list
  const blocks = useMemo(
    () => buildBlocks(data, selectedSessionId, selectableItems),
    [data, selectedSessionId, selectableItems],
  );

  // Find which block the selected item is in, ensure it's visible
  const selectedBlockIdx = useMemo(
    () => findBlockForSelectable(blocks, selectedIndex),
    [blocks, selectedIndex],
  );

  // Compute scroll position entirely from the selected block.
  // Place the selected block roughly in the top third of the viewport.
  const effectiveScroll = useMemo(() => {
    // Walk backward from selectedBlockIdx to fill about 1/3 of the viewport above it
    const targetAbove = Math.floor(height / 3);
    let cumLines = 0;
    let s = selectedBlockIdx;
    while (s > 0 && cumLines < targetAbove) {
      s--;
      cumLines += blocks[s].lines;
    }
    return s;
  }, [blocks, selectedBlockIdx, height]);

  // Get visible window
  const { start, end } = useMemo(
    () => computeVisibleWindow(blocks, effectiveScroll, height),
    [blocks, effectiveScroll, height],
  );

  const visibleBlocks = blocks.slice(start, end);

  return (
    <Box flexDirection="column" width={width}>
      {visibleBlocks.map(block => {
        switch (block.kind) {
          case 'divider':
            return <SectionLabel key={block.key} label={block.label!} count={block.count} width={width} />;

          case 'message':
            return <Text key={block.key} dimColor>{block.label}</Text>;

          case 'session':
            return (
              <SessionRow
                key={block.key}
                item={block.session!}
                selected={block.session!.id === selectedSessionId}
                width={width}
              />
            );

          case 'pt-group':
            return (
              <PersistentTaskGroup
                key={block.key}
                task={block.ptTask!}
                monitorSelected={block.ptMonitorSelected!}
                selectedChildId={block.ptChildSelId ?? null}
                width={width}
              />
            );

          default:
            return null;
        }
      })}
    </Box>
  );
}
