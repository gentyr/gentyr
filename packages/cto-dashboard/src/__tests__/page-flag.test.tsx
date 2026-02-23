/**
 * Tests for --page flag behavior
 *
 * Covers two areas introduced by the --page 1|2|3 change:
 *
 * 1. App component page prop — conditional rendering gates (showPage1/2/3).
 *    Uses ink-testing-library with mock data to verify that sections for the
 *    requested page are rendered and sections for other pages are not.
 *
 * 2. parseArgs page logic — the argument parsing rules live in index.tsx which
 *    is not exported, so we test the identical rules in isolation here. The
 *    logic is simple enough that duplicating it is the right trade-off vs.
 *    refactoring the production entry-point to support testability.
 *
 * Philosophy: Validate structure and behavior, not visual appearance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../App.js';
import {
  getMockDashboardData,
  getMockTimelineEvents,
  getMockTrajectory,
  getMockAutomatedInstances,
  getMockDeputyCto,
  getMockTesting,
  getMockDeployments,
  getMockInfra,
  getMockLogging,
  getMockAccountOverview,
  getMockWorktrees,
  getMockProductManager,
  getMockWorklog,
} from '../mock-data.js';

// ---------------------------------------------------------------------------
// Shared full-props builder using mock data
// ---------------------------------------------------------------------------

function buildProps(page?: 1 | 2 | 3) {
  return {
    data: getMockDashboardData(),
    timelineEvents: getMockTimelineEvents(),
    trajectory: getMockTrajectory(),
    automatedInstances: getMockAutomatedInstances(),
    deputyCto: getMockDeputyCto(),
    testing: getMockTesting(),
    deployments: getMockDeployments(),
    infra: getMockInfra(),
    logging: getMockLogging(),
    accountOverview: getMockAccountOverview(),
    worktrees: getMockWorktrees(),
    productManager: getMockProductManager(),
    worklog: getMockWorklog(),
    page,
  };
}

// ---------------------------------------------------------------------------
// App component — page prop conditional rendering
// ---------------------------------------------------------------------------

describe('App page prop', () => {
  describe('no page prop (full dashboard)', () => {
    it('should render the page 1 header', () => {
      const { lastFrame } = render(<App {...buildProps()} />);
      expect(lastFrame()).toContain('GENTYR CTO DASHBOARD');
    });

    it('should render a page 2 section title', () => {
      const { lastFrame } = render(<App {...buildProps()} />);
      // TestingSection renders "TESTING" in its title
      expect(lastFrame()).toContain('TESTING');
    });

    it('should render a page 3 section title', () => {
      const { lastFrame } = render(<App {...buildProps()} />);
      // MetricsSummary renders "METRICS SUMMARY"
      expect(lastFrame()).toContain('METRICS SUMMARY');
    });
  });

  describe('page=1', () => {
    it('should render the header', () => {
      const { lastFrame } = render(<App {...buildProps(1)} />);
      expect(lastFrame()).toContain('GENTYR CTO DASHBOARD');
    });

    it('should render a quota section', () => {
      const { lastFrame } = render(<App {...buildProps(1)} />);
      expect(lastFrame()).toContain('QUOTA & CAPACITY');
    });

    it('should render the system status section', () => {
      const { lastFrame } = render(<App {...buildProps(1)} />);
      expect(lastFrame()).toContain('SYSTEM STATUS');
    });

    it('should NOT render the metrics summary (page 3)', () => {
      const { lastFrame } = render(<App {...buildProps(1)} />);
      expect(lastFrame()).not.toContain('METRICS SUMMARY');
    });

    it('should NOT render testing section title (page 2)', () => {
      const { lastFrame } = render(<App {...buildProps(1)} />);
      expect(lastFrame()).not.toContain('TESTING');
    });
  });

  describe('page=2', () => {
    it('should NOT render the header (page 1)', () => {
      const { lastFrame } = render(<App {...buildProps(2)} />);
      expect(lastFrame()).not.toContain('GENTYR CTO DASHBOARD');
    });

    it('should NOT render quota section (page 1)', () => {
      const { lastFrame } = render(<App {...buildProps(2)} />);
      expect(lastFrame()).not.toContain('QUOTA & CAPACITY');
    });

    it('should NOT render metrics summary (page 3)', () => {
      const { lastFrame } = render(<App {...buildProps(2)} />);
      expect(lastFrame()).not.toContain('METRICS SUMMARY');
    });

    it('should render testing section (page 2)', () => {
      const { lastFrame } = render(<App {...buildProps(2)} />);
      expect(lastFrame()).toContain('TESTING');
    });

    it('should render deployments section (page 2)', () => {
      const { lastFrame } = render(<App {...buildProps(2)} />);
      expect(lastFrame()).toContain('DEPLOYMENTS');
    });
  });

  describe('page=3', () => {
    it('should NOT render the header (page 1)', () => {
      const { lastFrame } = render(<App {...buildProps(3)} />);
      expect(lastFrame()).not.toContain('GENTYR CTO DASHBOARD');
    });

    it('should NOT render testing section (page 2)', () => {
      const { lastFrame } = render(<App {...buildProps(3)} />);
      expect(lastFrame()).not.toContain('TESTING');
    });

    it('should render metrics summary (page 3)', () => {
      const { lastFrame } = render(<App {...buildProps(3)} />);
      expect(lastFrame()).toContain('METRICS SUMMARY');
    });

    it('should render worklog section (page 3)', () => {
      const { lastFrame } = render(<App {...buildProps(3)} />);
      expect(lastFrame()).toContain('WORKLOG');
    });
  });

  describe('page prop type', () => {
    it('should accept undefined page (renders all pages)', () => {
      // No throw, renders header from page 1 and summary from page 3
      const { lastFrame } = render(<App {...buildProps(undefined)} />);
      const output = lastFrame();
      expect(output).toContain('GENTYR CTO DASHBOARD');
      expect(output).toContain('METRICS SUMMARY');
    });
  });
});

// ---------------------------------------------------------------------------
// parseArgs page logic (rules mirrored from index.tsx — not exported)
//
// The production function reads process.argv directly; we reproduce the
// identical parsing rules here to keep them tested without modifying the
// entry-point. If the rules change in index.tsx, update this block too.
// ---------------------------------------------------------------------------

/** Mirrors the --page parsing block from parseArgs() in index.tsx */
function parsePage(argv: string[]): { page: 1 | 2 | 3 | null; warning: string | null } {
  let page: 1 | 2 | 3 | null = null;
  let warning: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--page') {
      const value = argv[i + 1];
      if (value === '1') page = 1;
      else if (value === '2') page = 2;
      else if (value === '3') page = 3;
      else if (value) {
        warning = `Warning: --page must be 1, 2, or 3, got "${value}"`;
      }
    }
  }

  return { page, warning };
}

describe('parseArgs --page logic', () => {
  describe('valid values', () => {
    it('should parse --page 1 as page=1', () => {
      const { page } = parsePage(['--page', '1']);
      expect(page).toBe(1);
    });

    it('should parse --page 2 as page=2', () => {
      const { page } = parsePage(['--page', '2']);
      expect(page).toBe(2);
    });

    it('should parse --page 3 as page=3', () => {
      const { page } = parsePage(['--page', '3']);
      expect(page).toBe(3);
    });

    it('should default to null when --page is absent', () => {
      const { page } = parsePage(['--hours', '48', '--mock']);
      expect(page).toBeNull();
    });

    it('should default to null when argv is empty', () => {
      const { page } = parsePage([]);
      expect(page).toBeNull();
    });
  });

  describe('invalid values', () => {
    it('should return null page and a warning for out-of-range value "0"', () => {
      const { page, warning } = parsePage(['--page', '0']);
      expect(page).toBeNull();
      expect(warning).not.toBeNull();
      expect(warning).toContain('"0"');
    });

    it('should return null page and a warning for out-of-range value "4"', () => {
      const { page, warning } = parsePage(['--page', '4']);
      expect(page).toBeNull();
      expect(warning).not.toBeNull();
      expect(warning).toContain('"4"');
    });

    it('should return null page and a warning for non-numeric value', () => {
      const { page, warning } = parsePage(['--page', 'all']);
      expect(page).toBeNull();
      expect(warning).not.toBeNull();
      expect(warning).toContain('"all"');
    });

    it('should not emit a warning for a valid value', () => {
      const { warning } = parsePage(['--page', '2']);
      expect(warning).toBeNull();
    });
  });

  describe('argument ordering', () => {
    it('should parse --page when mixed with other flags', () => {
      const { page } = parsePage(['--hours', '8', '--page', '2', '--mock']);
      expect(page).toBe(2);
    });

    it('should parse --page when it appears first', () => {
      const { page } = parsePage(['--page', '3', '--hours', '12']);
      expect(page).toBe(3);
    });

    it('should use the last --page value when flag appears twice', () => {
      // The loop does not break early, so the last assignment wins
      const { page } = parsePage(['--page', '1', '--page', '3']);
      expect(page).toBe(3);
    });
  });
});
