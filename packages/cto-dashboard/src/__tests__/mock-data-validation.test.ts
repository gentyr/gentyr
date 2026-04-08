/**
 * Mock Data Validation Tests
 *
 * Validates that mock data structures match their TypeScript types and real data expectations.
 * Critical for ensuring the --mock flag produces realistic dashboard output.
 *
 * Philosophy: Validate structure and type conformance, not specific values.
 */

import { describe, it, expect } from 'vitest';
import {
  getMockDashboardData,
  getMockTrajectory,
  getMockDeputyCto,
  getMockAutomatedInstances,
  getMockTesting,
  getMockDeployments,
  getMockInfra,
  getMockLogging,
} from '../mock-data.js';

describe('Mock Data Validation', () => {
  describe('getMockDashboardData', () => {
    it('should return valid DashboardData structure', () => {
      const data = getMockDashboardData();

      expect(data).toBeDefined();
      expect(data.generated_at).toBeInstanceOf(Date);
      expect(typeof data.hours).toBe('number');
      expect(data.hours).toBeGreaterThan(0);
    });

    it('should have valid quota data', () => {
      const data = getMockDashboardData();

      expect(data.quota).toBeDefined();
      if (data.quota.five_hour) {
        expect(typeof data.quota.five_hour.utilization).toBe('number');
        expect(data.quota.five_hour.utilization).toBeGreaterThanOrEqual(0);
        expect(data.quota.five_hour.utilization).toBeLessThanOrEqual(100);
      }
      if (data.quota.seven_day) {
        expect(typeof data.quota.seven_day.utilization).toBe('number');
        expect(data.quota.seven_day.utilization).toBeGreaterThanOrEqual(0);
        expect(data.quota.seven_day.utilization).toBeLessThanOrEqual(100);
      }
    });

    it('should have valid token usage metrics', () => {
      const data = getMockDashboardData();

      expect(data.token_usage).toBeDefined();
      expect(typeof data.token_usage.input).toBe('number');
      expect(typeof data.token_usage.output).toBe('number');
      expect(typeof data.token_usage.cache_read).toBe('number');
      expect(typeof data.token_usage.cache_creation).toBe('number');
      expect(typeof data.token_usage.total).toBe('number');
      expect(data.token_usage.input).toBeGreaterThanOrEqual(0);
      expect(data.token_usage.output).toBeGreaterThanOrEqual(0);
    });

    it('should have valid task metrics', () => {
      const data = getMockDashboardData();

      expect(data.tasks).toBeDefined();
      expect(typeof data.tasks.pending_total).toBe('number');
      expect(typeof data.tasks.in_progress_total).toBe('number');
      expect(typeof data.tasks.completed_total).toBe('number');
      expect(typeof data.tasks.completed_24h).toBe('number');
      expect(data.tasks.pending_total).toBeGreaterThanOrEqual(0);
      expect(data.tasks.completed_total).toBeGreaterThanOrEqual(data.tasks.completed_24h);
    });
  });

  describe('getMockTrajectory', () => {
    it('should return valid TrajectoryResult structure', () => {
      const trajectory = getMockTrajectory();

      expect(trajectory).toBeDefined();
      expect(trajectory.hasData).toBe(true);
      expect(Array.isArray(trajectory.snapshots)).toBe(true);
      expect(trajectory.snapshots.length).toBeGreaterThan(0);
    });

    it('should have snapshots with timestamp, fiveHour, sevenDay', () => {
      const trajectory = getMockTrajectory();

      trajectory.snapshots.forEach((snapshot, index) => {
        expect(snapshot.timestamp).toBeInstanceOf(Date);
        expect(typeof snapshot.fiveHour).toBe('number');
        expect(typeof snapshot.sevenDay).toBe('number');
        expect(snapshot.fiveHour).toBeGreaterThanOrEqual(0);
        expect(snapshot.fiveHour).toBeLessThanOrEqual(100);
        expect(snapshot.sevenDay).toBeGreaterThanOrEqual(0);
        expect(snapshot.sevenDay).toBeLessThanOrEqual(100);
        expect(snapshot.fiveHour).not.toBeNaN();
        expect(snapshot.sevenDay).not.toBeNaN();
      });
    });

    it('should have snapshots in chronological order', () => {
      const trajectory = getMockTrajectory();

      for (let i = 1; i < trajectory.snapshots.length; i++) {
        const prev = trajectory.snapshots[i - 1].timestamp.getTime();
        const curr = trajectory.snapshots[i].timestamp.getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });

    it('should have reset times in the future', () => {
      const trajectory = getMockTrajectory();
      const now = Date.now();

      if (trajectory.fiveHourResetTime) {
        expect(trajectory.fiveHourResetTime.getTime()).toBeGreaterThan(now);
      }
      if (trajectory.sevenDayResetTime) {
        expect(trajectory.sevenDayResetTime.getTime()).toBeGreaterThan(now);
      }
    });

    it('should have valid projection values if present', () => {
      const trajectory = getMockTrajectory();

      if (trajectory.fiveHourProjectedAtReset !== null) {
        expect(typeof trajectory.fiveHourProjectedAtReset).toBe('number');
        expect(trajectory.fiveHourProjectedAtReset).toBeGreaterThanOrEqual(0);
        expect(trajectory.fiveHourProjectedAtReset).toBeLessThanOrEqual(100);
        expect(trajectory.fiveHourProjectedAtReset).not.toBeNaN();
      }

      if (trajectory.sevenDayProjectedAtReset !== null) {
        expect(typeof trajectory.sevenDayProjectedAtReset).toBe('number');
        expect(trajectory.sevenDayProjectedAtReset).toBeGreaterThanOrEqual(0);
        expect(trajectory.sevenDayProjectedAtReset).toBeLessThanOrEqual(100);
        expect(trajectory.sevenDayProjectedAtReset).not.toBeNaN();
      }
    });

    it('should have valid trend values if present', () => {
      const trajectory = getMockTrajectory();

      if (trajectory.fiveHourTrendPerHour !== null) {
        expect(typeof trajectory.fiveHourTrendPerHour).toBe('number');
        expect(trajectory.fiveHourTrendPerHour).not.toBeNaN();
      }

      if (trajectory.sevenDayTrendPerDay !== null) {
        expect(typeof trajectory.sevenDayTrendPerDay).toBe('number');
        expect(trajectory.sevenDayTrendPerDay).not.toBeNaN();
      }
    });
  });

  describe('getMockDeputyCto', () => {
    it('should return valid DeputyCtoData structure', () => {
      const data = getMockDeputyCto();

      expect(data).toBeDefined();
      expect(data.hasData).toBe(true);
      expect(Array.isArray(data.untriaged)).toBe(true);
      expect(Array.isArray(data.escalated)).toBe(true);
      expect(Array.isArray(data.pendingQuestions)).toBe(true);
      expect(Array.isArray(data.recentlyTriaged)).toBe(true);
      expect(Array.isArray(data.answeredQuestions)).toBe(true);
    });

    it('should have counts matching array lengths', () => {
      const data = getMockDeputyCto();

      expect(data.untriagedCount).toBe(data.untriaged.length);
      expect(data.pendingQuestionCount).toBe(data.pendingQuestions.length);
    });

    it('should have valid report structures', () => {
      const data = getMockDeputyCto();

      const allReports = [...data.untriaged, ...data.escalated, ...data.recentlyTriaged];
      allReports.forEach((report) => {
        expect(typeof report.id).toBe('string');
        expect(typeof report.title).toBe('string');
        expect(typeof report.priority).toBe('string');
        expect(typeof report.triage_status).toBe('string');
        expect(typeof report.created_at).toBe('string');
      });
    });
  });

  describe('Mock Data Consistency', () => {
    it('should have timestamps within reasonable range', () => {
      const now = Date.now();
      const trajectory = getMockTrajectory();

      trajectory.snapshots.forEach((snapshot) => {
        const ts = snapshot.timestamp.getTime();
        const ageMs = now - ts;
        expect(ageMs).toBeGreaterThanOrEqual(0); // Not in future
        expect(ageMs).toBeLessThan(7 * 24 * 60 * 60 * 1000); // Not older than 7 days
      });
    });

    it('should have realistic utilization values', () => {
      const data = getMockDashboardData();

      if (data.quota.five_hour) {
        expect(data.quota.five_hour.utilization).toBeGreaterThanOrEqual(0);
        expect(data.quota.five_hour.utilization).toBeLessThanOrEqual(100);
      }
      if (data.quota.seven_day) {
        expect(data.quota.seven_day.utilization).toBeGreaterThanOrEqual(0);
        expect(data.quota.seven_day.utilization).toBeLessThanOrEqual(100);
      }
    });
  });
});
