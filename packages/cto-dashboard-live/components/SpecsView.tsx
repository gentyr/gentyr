/**
 * SpecsView — Page 4 of the live CTO dashboard.
 *
 * Layout (two-column):
 *   Left  : SpecNavigator (35%)
 *   Right : SpecViewer (65%)
 *
 * Keyboard map:
 *   left/right   switch active panel
 *   up/down      navigate specs (left) or scroll content (right)
 */

import React, { useState, useEffect } from 'react';
import { Box, useInput } from 'ink';
import { Section } from './Section.js';
import { SpecNavigator, specSelectableCount } from './specs/SpecNavigator.js';
import { SpecViewer } from './specs/SpecViewer.js';
import type { Page4Data, SpecItem } from '../types.js';

interface SpecsViewProps {
  data: Page4Data;
  bodyHeight: number;
  bodyWidth: number;
  isActive: boolean;
  onSelectSpec: (specId: string | null) => void;
}

type ActivePanel = 'navigator' | 'viewer';

const LEFT_WIDTH_FRACTION = 0.35;
const HEADER_OVERHEAD = 2;

function getSelectedSpec(data: Page4Data, flatIndex: number): SpecItem | null {
  let idx = 0;
  for (const cat of data.categories) {
    for (const spec of cat.specs) {
      if (idx === flatIndex) return spec;
      idx++;
    }
  }
  return null;
}

export function SpecsView({ data, bodyHeight, bodyWidth, isActive, onSelectSpec }: SpecsViewProps): React.ReactElement {
  const [activePanel, setActivePanel] = useState<ActivePanel>('navigator');
  const [selectedFlatIndex, setSelectedFlatIndex] = useState(0);
  const [viewerScrollOffset, setViewerScrollOffset] = useState(0);

  const totalSelectableSpecs = specSelectableCount(data.categories);

  // Notify parent when selected spec changes
  useEffect(() => {
    const spec = getSelectedSpec(data, selectedFlatIndex);
    onSelectSpec(spec?.specId ?? null);
  }, [selectedFlatIndex, data, onSelectSpec]);

  // Reset scroll when spec changes
  useEffect(() => {
    setViewerScrollOffset(0);
  }, [selectedFlatIndex]);

  // Clamp index when categories change
  useEffect(() => {
    if (totalSelectableSpecs > 0 && selectedFlatIndex >= totalSelectableSpecs) {
      setSelectedFlatIndex(totalSelectableSpecs - 1);
    }
  }, [totalSelectableSpecs, selectedFlatIndex]);

  useInput((input, key) => {
    if (key.leftArrow) { setActivePanel('navigator'); return; }
    if (key.rightArrow) { setActivePanel('viewer'); return; }

    if (key.upArrow) {
      if (activePanel === 'navigator') {
        setSelectedFlatIndex(prev => Math.max(0, prev - 1));
      } else {
        setViewerScrollOffset(prev => Math.max(0, prev - 1));
      }
      return;
    }
    if (key.downArrow) {
      if (activePanel === 'navigator') {
        setSelectedFlatIndex(prev => Math.min(Math.max(0, totalSelectableSpecs - 1), prev + 1));
      } else {
        setViewerScrollOffset(prev => prev + 1);
      }
      return;
    }
  }, { isActive });

  const leftWidth = Math.floor(bodyWidth * LEFT_WIDTH_FRACTION);
  const rightWidth = bodyWidth - leftWidth - 1;
  const leftInnerHeight = Math.max(2, bodyHeight - HEADER_OVERHEAD);
  const rightInnerHeight = Math.max(2, bodyHeight - HEADER_OVERHEAD);

  const selectedSpec = getSelectedSpec(data, selectedFlatIndex);

  return (
    <Box flexDirection="row" height={bodyHeight}>
      <Section
        title={`Specs (${data.totalSpecs})`}
        width={leftWidth}
        tip={activePanel === 'navigator' ? '\u25C0 active' : undefined}
      >
        <SpecNavigator
          categories={data.categories}
          suites={data.suites}
          selectedFlatIndex={selectedFlatIndex}
          height={leftInnerHeight}
          width={leftWidth - 4}
          isActive={activePanel === 'navigator'}
        />
      </Section>

      <Box width={1} />

      <Section
        title={selectedSpec ? selectedSpec.specId : 'Spec Viewer'}
        width={rightWidth}
        flexGrow={1}
        tip={activePanel === 'viewer' ? 'active \u25B6' : undefined}
      >
        <SpecViewer
          content={data.selectedSpecContent}
          scrollOffset={viewerScrollOffset}
          height={rightInnerHeight}
          width={rightWidth - 4}
        />
      </Section>
    </Box>
  );
}
