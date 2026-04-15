/**
 * TestFileList — scrollable selectable list of Playwright test files,
 * grouped by project with non-selectable project headers.
 *
 * Uses a flat selectable index that skips header rows.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { TestFileItem } from '../../types.js';
import { truncate } from '../../utils/formatters.js';

interface TestFileListProps {
  testFiles: TestFileItem[];
  selectedIndex: number;
  height: number;
  width: number;
  isActive: boolean;
}

interface DisplayRow {
  type: 'header' | 'file';
  project: string;
  file?: TestFileItem;
  fileIndex?: number; // index into flat selectable list
}

function buildRows(testFiles: TestFileItem[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let currentProject = '';
  let selectableIndex = 0;
  for (const file of testFiles) {
    if (file.project !== currentProject) {
      currentProject = file.project;
      rows.push({ type: 'header', project: currentProject });
    }
    rows.push({ type: 'file', project: currentProject, file, fileIndex: selectableIndex });
    selectableIndex++;
  }
  return rows;
}

function FileRow({ row, isSelected, width, isActive }: { row: DisplayRow; isSelected: boolean; width: number; isActive: boolean }): React.ReactElement {
  if (row.type === 'header') {
    return (
      <Box height={1}>
        <Text color="cyan" bold>{truncate(row.project, width)}</Text>
      </Box>
    );
  }

  const file = row.file!;
  const highlight = isSelected && isActive;
  const badge = file.isDemo ? ' demo' : ' spec';
  const badgeColor = file.isDemo ? 'yellow' : 'blue';
  const nameWidth = Math.max(4, width - badge.length - 4);
  const cursor = isSelected ? '\u25B8 ' : '  ';

  return (
    <Box height={1}>
      <Text>{cursor}</Text>
      <Box width={nameWidth} overflow="hidden">
        <Text {...(highlight ? { color: 'white' as const, bold: true, inverse: true } : isSelected ? { bold: true } : { dimColor: true })}>
          {truncate(file.fileName, nameWidth)}
        </Text>
      </Box>
      <Text color={badgeColor} dimColor={!highlight}>{badge}</Text>
    </Box>
  );
}

export function TestFileList({ testFiles, selectedIndex, height, width, isActive }: TestFileListProps): React.ReactElement {
  if (testFiles.length === 0) {
    return (
      <Box flexDirection="column" height={height}>
        <Text dimColor>  No test files found</Text>
      </Box>
    );
  }

  const rows = buildRows(testFiles);

  // Find the row index of the selected file
  const selectedRowIdx = rows.findIndex(r => r.type === 'file' && r.fileIndex === selectedIndex);

  // Viewport scrolling
  const startIdx = Math.max(0, Math.min(
    selectedRowIdx >= 0 ? selectedRowIdx - Math.floor(height / 2) : 0,
    Math.max(0, rows.length - height),
  ));
  const visible = rows.slice(startIdx, startIdx + height);

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {visible.map((row, i) => (
        <FileRow
          key={row.type === 'header' ? `hdr-${row.project}` : `file-${row.fileIndex}`}
          row={row}
          isSelected={row.type === 'file' && row.fileIndex === selectedIndex}
          width={width}
          isActive={isActive}
        />
      ))}
    </Box>
  );
}

/** Count total selectable (non-header) items */
export function selectableCount(testFiles: TestFileItem[]): number {
  return testFiles.length;
}
