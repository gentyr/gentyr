/**
 * Unit tests for AutomatedInstances component
 *
 * Tests rendering behavior for the Automated Instances dashboard:
 * - Empty state (returns null when no data)
 * - Instance table rows (scheduled and event-triggered)
 * - Footer with usage target, projected, and adjusting direction
 * - Token usage bar chart rendered when tokensByType has entries
 * - No bar chart rendered when tokensByType is empty
 * - Column header and separator rendering
 *
 * Philosophy: Validate structure and behavior, not visual appearance.
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { AutomatedInstances } from '../AutomatedInstances.js';
import type { AutomatedInstancesData } from '../../utils/automated-instances.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeData(overrides: Partial<AutomatedInstancesData> = {}): AutomatedInstancesData {
  return {
    instances: [],
    usageTarget: 90,
    currentProjected: null,
    adjustingDirection: 'stable',
    hasData: true,
    tokensByType: {},
    ...overrides,
  };
}

const SCHEDULED_INSTANCE = {
  type: 'Lint Checker',
  runs24h: 3,
  untilNext: '27m',
  freqAdj: 'baseline',
  trigger: 'scheduled' as const,
};

const EVENT_INSTANCE = {
  type: 'Pre-Commit Hook',
  runs24h: 5,
  untilNext: 'on commit',
  freqAdj: '+20% slower',
  trigger: 'commit' as const,
};

// ---------------------------------------------------------------------------
// Empty / null state
// ---------------------------------------------------------------------------

describe('AutomatedInstances - Empty State', () => {
  it('should return null when hasData is false', () => {
    const data = makeData({ hasData: false, instances: [] });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    expect(lastFrame()).toBe('');
  });

  it('should return null when instances array is empty and hasData is true', () => {
    const data = makeData({ hasData: true, instances: [] });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    expect(lastFrame()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Table structure
// ---------------------------------------------------------------------------

describe('AutomatedInstances - Table Structure', () => {
  it('should render column headers', () => {
    const data = makeData({ instances: [SCHEDULED_INSTANCE] });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('Type');
    expect(output).toContain('Runs (24h)');
    expect(output).toContain('Until Next');
    expect(output).toContain('Freq Adj');
  });

  it('should render the section title', () => {
    const data = makeData({ instances: [SCHEDULED_INSTANCE] });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('AUTOMATED INSTANCES');
  });

  it('should render a scheduled instance row', () => {
    const data = makeData({ instances: [SCHEDULED_INSTANCE] });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('Lint Checker');
    expect(output).toContain('3');
    expect(output).toContain('27m');
    expect(output).toContain('baseline');
  });

  it('should render an event-triggered instance row', () => {
    const data = makeData({ instances: [EVENT_INSTANCE] });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('Pre-Commit Hook');
    expect(output).toContain('5');
    expect(output).toContain('on commit');
    expect(output).toContain('+20% slower');
  });

  it('should render both scheduled and event-triggered instances', () => {
    const data = makeData({ instances: [SCHEDULED_INSTANCE, EVENT_INSTANCE] });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('Lint Checker');
    expect(output).toContain('Pre-Commit Hook');
  });

  it('should render all 15 instance types without crashing', () => {
    const instances: AutomatedInstancesData['instances'] = [
      { type: 'Pre-Commit Hook', runs24h: 1, untilNext: 'on commit', freqAdj: 'baseline', trigger: 'commit' },
      { type: 'Test Suite', runs24h: 0, untilNext: 'on failure', freqAdj: null, trigger: 'failure' },
      { type: 'Compliance (Hook)', runs24h: 0, untilNext: 'on change', freqAdj: 'baseline', trigger: 'file-change' },
      { type: 'Todo Maintenance', runs24h: 2, untilNext: 'on change', freqAdj: '-20% faster', trigger: 'file-change' },
      { type: 'Triage Check', runs24h: 12, untilNext: '3m', freqAdj: 'baseline', trigger: 'scheduled' },
      { type: 'Lint Checker', runs24h: 3, untilNext: '27m', freqAdj: 'baseline', trigger: 'scheduled' },
      { type: 'CLAUDE.md Refactor', runs24h: 1, untilNext: '52m', freqAdj: 'baseline', trigger: 'scheduled' },
      { type: 'Task Runner', runs24h: 4, untilNext: '15m', freqAdj: '+10% slower', trigger: 'scheduled' },
      { type: 'Production Health', runs24h: 2, untilNext: '45m', freqAdj: 'baseline', trigger: 'scheduled' },
      { type: 'Compliance (Sched.)', runs24h: 0, untilNext: 'pending', freqAdj: 'baseline', trigger: 'scheduled' },
      { type: 'User Feedback', runs24h: 1, untilNext: '1h30m', freqAdj: 'baseline', trigger: 'scheduled' },
      { type: 'Antipattern Hunter', runs24h: 1, untilNext: '2h', freqAdj: 'static 180m', trigger: 'scheduled' },
      { type: 'Staging Health', runs24h: 0, untilNext: 'now', freqAdj: 'baseline', trigger: 'scheduled' },
      { type: 'Preview Promotion', runs24h: 0, untilNext: '5h', freqAdj: 'baseline', trigger: 'scheduled' },
      { type: 'Staging Promotion', runs24h: 0, untilNext: '18h', freqAdj: 'baseline', trigger: 'scheduled' },
    ];

    const data = makeData({ instances });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('Pre-Commit Hook');
    expect(output).toContain('Staging Promotion');
    expect(output).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Footer rendering
// ---------------------------------------------------------------------------

describe('AutomatedInstances - Footer', () => {
  it('should display usage target', () => {
    const data = makeData({ instances: [SCHEDULED_INSTANCE], usageTarget: 90 });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('Usage Target');
    expect(output).toContain('90%');
  });

  it('should display N/A when currentProjected is null', () => {
    const data = makeData({ instances: [SCHEDULED_INSTANCE], currentProjected: null });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('N/A');
  });

  it('should display projected percentage when currentProjected is set', () => {
    const data = makeData({ instances: [SCHEDULED_INSTANCE], currentProjected: 87 });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('87%');
    expect(output).not.toContain('N/A');
  });

  it('should display stable adjusting direction', () => {
    const data = makeData({ instances: [SCHEDULED_INSTANCE], adjustingDirection: 'stable' });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('stable');
  });

  it('should display up adjusting direction with intervals label', () => {
    const data = makeData({ instances: [SCHEDULED_INSTANCE], adjustingDirection: 'up' });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('intervals');
    expect(output).toContain('\u2191'); // ↑ up arrow
  });

  it('should display down adjusting direction with intervals label', () => {
    const data = makeData({ instances: [SCHEDULED_INSTANCE], adjustingDirection: 'down' });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('intervals');
    expect(output).toContain('\u2193'); // ↓ down arrow
  });

  it('should round projected percentage', () => {
    const data = makeData({ instances: [SCHEDULED_INSTANCE], currentProjected: 87.6 });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('88%');
  });
});

// ---------------------------------------------------------------------------
// Token usage bar chart (tokensByType)
// ---------------------------------------------------------------------------

describe('AutomatedInstances - Token Usage Bar Chart', () => {
  it('should NOT render bar chart section when tokensByType is empty', () => {
    const data = makeData({
      instances: [SCHEDULED_INSTANCE],
      tokensByType: {},
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).not.toContain('Token Usage by Automation (24h)');
  });

  it('should render bar chart section title when tokensByType has entries', () => {
    const data = makeData({
      instances: [SCHEDULED_INSTANCE],
      tokensByType: {
        'Lint Checker': 15000,
      },
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('Token Usage by Automation (24h)');
  });

  it('should render bar chart with multiple entries without crashing', () => {
    const data = makeData({
      instances: [SCHEDULED_INSTANCE, EVENT_INSTANCE],
      tokensByType: {
        'Lint Checker': 15000,
        'Pre-Commit Hook': 12500,
        'Task Runner': 48000,
        'CLAUDE.md Refactor': 7200,
      },
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('Token Usage by Automation (24h)');
    expect(output).toBeTruthy();
  });

  it('should render bar chart with a single entry', () => {
    const data = makeData({
      instances: [SCHEDULED_INSTANCE],
      tokensByType: {
        'Task Runner': 50000,
      },
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('Token Usage by Automation (24h)');
  });

  it('should render tip text below chart when tokensByType has entries', () => {
    const data = makeData({
      instances: [SCHEDULED_INSTANCE],
      tokensByType: { 'Lint Checker': 5000 },
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('Tip:');
  });

  it('should still render tip text when tokensByType is empty', () => {
    const data = makeData({ instances: [SCHEDULED_INSTANCE], tokensByType: {} });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('Tip:');
  });
});

// ---------------------------------------------------------------------------
// Run count coloring thresholds (via output content checks)
// ---------------------------------------------------------------------------

describe('AutomatedInstances - Run Count Display', () => {
  it('should display zero run count', () => {
    const data = makeData({
      instances: [{ ...SCHEDULED_INSTANCE, runs24h: 0 }],
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('0');
  });

  it('should display non-zero run count', () => {
    const data = makeData({
      instances: [{ ...SCHEDULED_INSTANCE, runs24h: 7 }],
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('7');
  });

  it('should display high run count (> 10)', () => {
    const data = makeData({
      instances: [{ ...SCHEDULED_INSTANCE, runs24h: 25 }],
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('25');
  });
});

// ---------------------------------------------------------------------------
// Freq adjustment display variations
// ---------------------------------------------------------------------------

describe('AutomatedInstances - Frequency Adjustment Display', () => {
  it('should display null freqAdj as em-dash', () => {
    const data = makeData({
      instances: [{ ...EVENT_INSTANCE, freqAdj: null }],
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('\u2014'); // — em-dash
  });

  it('should display slower frequency adjustment', () => {
    const data = makeData({
      instances: [{ ...SCHEDULED_INSTANCE, freqAdj: '+15% slower' }],
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('+15% slower');
  });

  it('should display faster frequency adjustment', () => {
    const data = makeData({
      instances: [{ ...SCHEDULED_INSTANCE, freqAdj: '-20% faster' }],
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('-20% faster');
  });

  it('should display static mode frequency adjustment', () => {
    const data = makeData({
      instances: [{ ...SCHEDULED_INSTANCE, freqAdj: 'static 45m' }],
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    const output = lastFrame();

    expect(output).toContain('static 45m');
  });
});

// ---------------------------------------------------------------------------
// Until next display variations
// ---------------------------------------------------------------------------

describe('AutomatedInstances - Until Next Display', () => {
  it('should display "now" for overdue scheduled instances', () => {
    const data = makeData({
      instances: [{ ...SCHEDULED_INSTANCE, untilNext: 'now' }],
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    expect(lastFrame()).toContain('now');
  });

  it('should display "pending" for never-run instances', () => {
    const data = makeData({
      instances: [{ ...SCHEDULED_INSTANCE, untilNext: 'pending' }],
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    expect(lastFrame()).toContain('pending');
  });

  it('should display "on commit" for commit-triggered instances', () => {
    const data = makeData({
      instances: [{ ...EVENT_INSTANCE, untilNext: 'on commit' }],
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    expect(lastFrame()).toContain('on commit');
  });

  it('should display "on failure" for failure-triggered instances', () => {
    const data = makeData({
      instances: [{ type: 'Test Suite', runs24h: 0, untilNext: 'on failure', freqAdj: null, trigger: 'failure' as const }],
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    expect(lastFrame()).toContain('on failure');
  });

  it('should display "on change" for file-change-triggered instances', () => {
    const data = makeData({
      instances: [{ type: 'Todo Maintenance', runs24h: 0, untilNext: 'on change', freqAdj: 'baseline', trigger: 'file-change' as const }],
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    expect(lastFrame()).toContain('on change');
  });

  it('should display formatted time duration', () => {
    const data = makeData({
      instances: [{ ...SCHEDULED_INSTANCE, untilNext: '1h15m' }],
    });
    const { lastFrame } = render(<AutomatedInstances data={data} />);
    expect(lastFrame()).toContain('1h15m');
  });
});

// ---------------------------------------------------------------------------
// Complete render consistency
// ---------------------------------------------------------------------------

describe('AutomatedInstances - Render Consistency', () => {
  it('should produce identical output on repeated renders with same data', () => {
    const data = makeData({
      instances: [SCHEDULED_INSTANCE, EVENT_INSTANCE],
      usageTarget: 90,
      currentProjected: 85,
      adjustingDirection: 'down',
      tokensByType: { 'Lint Checker': 5000, 'Pre-Commit Hook': 3000 },
    });

    const { lastFrame: frame1 } = render(<AutomatedInstances data={data} />);
    const { lastFrame: frame2 } = render(<AutomatedInstances data={data} />);

    expect(frame1()).toBe(frame2());
  });
});
