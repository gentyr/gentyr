/**
 * PlansView — Page 3 of the live CTO dashboard.
 *
 * Layout (two-column):
 *   Left  : PlanList (35%)
 *   Right : PlanDetail (65%)
 *
 * Keyboard map:
 *   left/right   switch active panel
 *   up/down      navigate plans (left) or scroll detail (right)
 */

import React, { useState, useEffect } from 'react';
import { Box, useInput } from 'ink';
import { Section } from './Section.js';
import { PlanList } from './plans/PlanList.js';
import { PlanDetail } from './plans/PlanDetail.js';
import type { Page3Data } from '../types.js';

interface PlansViewProps {
  data: Page3Data;
  bodyHeight: number;
  bodyWidth: number;
  isActive: boolean;
  onSelectPlan: (planId: string | null) => void;
}

type ActivePanel = 'plans' | 'detail';

const LEFT_WIDTH_FRACTION = 0.35;
const HEADER_OVERHEAD = 2;

export function PlansView({ data, bodyHeight, bodyWidth, isActive, onSelectPlan }: PlansViewProps): React.ReactElement {
  const [activePanel, setActivePanel] = useState<ActivePanel>('plans');
  const [selectedPlanIndex, setSelectedPlanIndex] = useState(0);
  const [detailScrollOffset, setDetailScrollOffset] = useState(0);

  // Notify parent when selected plan changes
  useEffect(() => {
    const plan = data.plans[selectedPlanIndex];
    onSelectPlan(plan?.id ?? null);
  }, [selectedPlanIndex, data.plans, onSelectPlan]);

  // Reset scroll offset when plan changes
  useEffect(() => {
    setDetailScrollOffset(0);
  }, [selectedPlanIndex]);

  // Clamp selectedPlanIndex when plans list changes length
  useEffect(() => {
    if (data.plans.length > 0 && selectedPlanIndex >= data.plans.length) {
      setSelectedPlanIndex(data.plans.length - 1);
    }
  }, [data.plans.length, selectedPlanIndex]);

  useInput((input, key) => {
    if (key.leftArrow) { setActivePanel('plans'); return; }
    if (key.rightArrow) { setActivePanel('detail'); return; }

    if (key.upArrow) {
      if (activePanel === 'plans') {
        setSelectedPlanIndex(prev => Math.max(0, prev - 1));
      } else {
        setDetailScrollOffset(prev => Math.max(0, prev - 1));
      }
      return;
    }
    if (key.downArrow) {
      if (activePanel === 'plans') {
        setSelectedPlanIndex(prev => Math.min(data.plans.length - 1, prev + 1));
      } else {
        setDetailScrollOffset(prev => prev + 1);
      }
      return;
    }
  }, { isActive });

  const leftWidth = Math.floor(bodyWidth * LEFT_WIDTH_FRACTION);
  const rightWidth = bodyWidth - leftWidth - 1;
  const leftInnerHeight = Math.max(2, bodyHeight - HEADER_OVERHEAD);
  const rightInnerHeight = Math.max(2, bodyHeight - HEADER_OVERHEAD);

  const selectedPlan = data.plans[selectedPlanIndex];

  return (
    <Box flexDirection="row" height={bodyHeight}>
      <Section
        title="Plans"
        width={leftWidth}
        tip={activePanel === 'plans' ? '\u25C0 active' : undefined}
      >
        <PlanList
          plans={data.plans}
          selectedIndex={selectedPlanIndex}
          height={leftInnerHeight}
          width={leftWidth - 4}
          isActive={activePanel === 'plans'}
        />
      </Section>

      <Box width={1} />

      <Section
        title={selectedPlan ? selectedPlan.title : 'Plan Detail'}
        width={rightWidth}
        flexGrow={1}
        tip={activePanel === 'detail' ? 'active \u25B6' : undefined}
      >
        <PlanDetail
          detail={data.planDetail}
          recentChanges={data.recentChanges}
          scrollOffset={detailScrollOffset}
          height={rightInnerHeight}
          width={rightWidth - 4}
        />
      </Section>
    </Box>
  );
}
