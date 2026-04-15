/**
 * SpecNavigator — left panel for Page 4.
 *
 * Categories as non-selectable headers (cyan bold), specs listed below each.
 * Same pattern as TestFileList: flat array of rows, selectable index skips headers.
 *
 * At the bottom: suites section.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SpecCategoryItem, SuiteItem } from '../../types.js';
import { truncate } from '../../utils/formatters.js';

interface SpecNavigatorProps {
  categories: SpecCategoryItem[];
  suites: SuiteItem[];
  selectedFlatIndex: number;
  height: number;
  width: number;
  isActive: boolean;
}

interface DisplayRow {
  type: 'category' | 'spec' | 'empty';
  key: string;
  label: string;
  flatIndex?: number;
  severity?: string | null;
  specId?: string;
}

function buildRows(categories: SpecCategoryItem[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let selectableIndex = 0;

  for (const cat of categories) {
    const count = cat.specs.length;
    rows.push({ type: 'category', key: `cat-${cat.key}`, label: `${cat.key} (${count} spec${count !== 1 ? 's' : ''})` });
    if (count === 0) {
      rows.push({ type: 'empty', key: `empty-${cat.key}`, label: '  (empty)' });
    } else {
      for (const spec of cat.specs) {
        rows.push({ type: 'spec', key: `spec-${spec.specId}`, label: spec.title, flatIndex: selectableIndex, severity: spec.severity, specId: spec.specId });
        selectableIndex++;
      }
    }
  }
  return rows;
}

function severityIndicator(severity: string | null): { char: string; color: string } {
  if (!severity) return { char: '\u00B7', color: 'gray' };
  switch (severity.toLowerCase()) {
    case 'critical': return { char: '!', color: 'red' };
    case 'required': return { char: '*', color: 'yellow' };
    default:         return { char: '\u00B7', color: 'gray' };
  }
}

function SpecRow({ row, isSelected, width, isActive }: { row: DisplayRow; isSelected: boolean; width: number; isActive: boolean }): React.ReactElement {
  if (row.type === 'category') {
    return (
      <Box height={1}>
        <Text color="cyan" bold>{truncate(row.label, width)}</Text>
      </Box>
    );
  }
  if (row.type === 'empty') {
    return (
      <Box height={1}>
        <Text dimColor>{row.label}</Text>
      </Box>
    );
  }

  const { char, color } = severityIndicator(row.severity ?? null);
  const highlight = isSelected && isActive;
  const nameWidth = Math.max(4, width - 4);

  return (
    <Box height={1}>
      <Text>{highlight ? '\u25B8 ' : '  '}</Text>
      <Text color={color} bold={highlight}>{char} </Text>
      <Box width={nameWidth} overflow="hidden">
        <Text {...(highlight ? { color: 'white', bold: true } : isSelected ? {} : { dimColor: true })}>
          {truncate(row.label, nameWidth)}
        </Text>
      </Box>
    </Box>
  );
}

const SUITES_OVERHEAD = 2; // divider + header row (at minimum)

export function SpecNavigator({ categories, suites, selectedFlatIndex, height, width, isActive }: SpecNavigatorProps): React.ReactElement {
  if (categories.length === 0) {
    return (
      <Box flexDirection="column" height={height}>
        <Text dimColor>  No spec directories found</Text>
      </Box>
    );
  }

  const suitesHeight = suites.length > 0 ? Math.min(suites.length + SUITES_OVERHEAD, Math.floor(height * 0.25)) : 0;
  const listHeight = Math.max(2, height - suitesHeight);

  const rows = buildRows(categories);
  const selectedRowIdx = rows.findIndex(r => r.type === 'spec' && r.flatIndex === selectedFlatIndex);

  const startIdx = Math.max(0, Math.min(
    selectedRowIdx >= 0 ? selectedRowIdx - Math.floor(listHeight / 2) : 0,
    Math.max(0, rows.length - listHeight),
  ));
  const visible = rows.slice(startIdx, startIdx + listHeight);

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Box flexDirection="column" height={listHeight} overflow="hidden">
        {visible.map(row => (
          <SpecRow
            key={row.key}
            row={row}
            isSelected={row.type === 'spec' && row.flatIndex === selectedFlatIndex}
            width={width}
            isActive={isActive}
          />
        ))}
      </Box>

      {suitesHeight > 0 && (
        <Box flexDirection="column" height={suitesHeight} overflow="hidden">
          <Box height={1}>
            <Text dimColor>{'\u2500'.repeat(3)} Suites {'\u2500'.repeat(Math.max(1, width - 11))}</Text>
          </Box>
          {suites.slice(0, suitesHeight - 1).map(s => (
            <Box key={s.id} height={1}>
              <Text color={s.enabled ? 'green' : 'gray'}>{s.enabled ? '\u25CF' : '\u25CB'} </Text>
              <Text>{truncate(s.id, Math.max(4, Math.floor(width * 0.4)))}</Text>
              <Text dimColor>  {truncate(s.scope, Math.max(4, width - s.id.length - 4))}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** Count total selectable (non-header) spec items */
export function specSelectableCount(categories: SpecCategoryItem[]): number {
  return categories.reduce((sum, c) => sum + c.specs.length, 0);
}
