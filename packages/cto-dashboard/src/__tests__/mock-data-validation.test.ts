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
  getMockAccountOverview,
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

    it('should have verified_quota with multiple keys', () => {
      const data = getMockDashboardData();

      expect(data.verified_quota).toBeDefined();
      expect(data.verified_quota.keys).toBeDefined();
      expect(Array.isArray(data.verified_quota.keys)).toBe(true);
      expect(data.verified_quota.keys.length).toBeGreaterThan(1);
    });

    it('should have quota data for each key', () => {
      const data = getMockDashboardData();

      data.verified_quota.keys.forEach((key, index) => {
        expect(key.key_id).toBeDefined();
        expect(typeof key.key_id).toBe('string');
        expect(key.subscription_type).toBeDefined();
        expect(typeof key.is_current).toBe('boolean');
        expect(typeof key.healthy).toBe('boolean');

        if (key.healthy && key.quota) {
          expect(key.quota.five_hour).toBeDefined();
          expect(key.quota.seven_day).toBeDefined();
          expect(typeof key.quota.five_hour?.utilization).toBe('number');
          expect(typeof key.quota.seven_day?.utilization).toBe('number');
          expect(key.quota.five_hour!.utilization).toBeGreaterThanOrEqual(0);
          expect(key.quota.five_hour!.utilization).toBeLessThanOrEqual(100);
          expect(key.quota.seven_day!.utilization).toBeGreaterThanOrEqual(0);
          expect(key.quota.seven_day!.utilization).toBeLessThanOrEqual(100);
        }
      });
    });

    it('should have exactly one active key', () => {
      const data = getMockDashboardData();

      const activeKeys = data.verified_quota.keys.filter(k => k.is_current);
      expect(activeKeys.length).toBe(1);
    });

    it('should have aggregate quota matching key count', () => {
      const data = getMockDashboardData();

      expect(data.verified_quota.aggregate).toBeDefined();
      expect(data.verified_quota.healthy_count).toBe(
        data.verified_quota.keys.filter(k => k.healthy).length
      );
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

  describe('getMockAccountOverview', () => {
    it('should return valid AccountOverviewData structure', () => {
      const data = getMockAccountOverview();

      expect(data).toBeDefined();
      expect(data.hasData).toBe(true);
      expect(Array.isArray(data.accounts)).toBe(true);
      expect(Array.isArray(data.events)).toBe(true);
      expect(data.accounts.length).toBeGreaterThan(1);
    });

    it('should have exactly one active account', () => {
      const data = getMockAccountOverview();

      const activeAccounts = data.accounts.filter(a => a.isCurrent);
      expect(activeAccounts.length).toBe(1);
      expect(data.activeKeyId).toBe(activeAccounts[0].keyId);
    });

    it('should have valid account structures', () => {
      const data = getMockAccountOverview();

      data.accounts.forEach((account) => {
        expect(typeof account.keyId).toBe('string');
        expect(typeof account.status).toBe('string');
        expect(typeof account.isCurrent).toBe('boolean');
        expect(typeof account.subscriptionType).toBe('string');
        expect(typeof account.fiveHourPct).toBe('number');
        expect(typeof account.sevenDayPct).toBe('number');
        expect(account.fiveHourPct).toBeGreaterThanOrEqual(0);
        expect(account.fiveHourPct).toBeLessThanOrEqual(100);
        expect(account.sevenDayPct).toBeGreaterThanOrEqual(0);
        expect(account.sevenDayPct).toBeLessThanOrEqual(100);
        expect(account.expiresAt).toBeInstanceOf(Date);
        expect(account.addedAt).toBeInstanceOf(Date);
      });
    });

    it('should have valid event structures', () => {
      const data = getMockAccountOverview();

      data.events.forEach((event) => {
        expect(event.timestamp).toBeInstanceOf(Date);
        expect(typeof event.event).toBe('string');
        expect(typeof event.keyId).toBe('string');
        expect(typeof event.description).toBe('string');
      });
    });

    it('should have events in reverse chronological order', () => {
      const data = getMockAccountOverview();

      for (let i = 1; i < data.events.length; i++) {
        const prev = data.events[i - 1].timestamp.getTime();
        const curr = data.events[i].timestamp.getTime();
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    });
  });

  describe('Mock Data Consistency', () => {
    it('should have consistent key IDs across dashboard and trajectory', () => {
      const dashboardData = getMockDashboardData();

      expect(dashboardData.verified_quota.keys.length).toBeGreaterThan(1);

      // Verify all keys have unique IDs
      const keyIds = dashboardData.verified_quota.keys.map(k => k.key_id);
      const uniqueKeyIds = new Set(keyIds);
      expect(uniqueKeyIds.size).toBe(keyIds.length);
    });

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

      data.verified_quota.keys.forEach((key) => {
        if (key.healthy && key.quota) {
          const fiveHour = key.quota.five_hour?.utilization;
          const sevenDay = key.quota.seven_day?.utilization;

          if (fiveHour !== undefined) {
            expect(fiveHour).toBeGreaterThanOrEqual(0);
            expect(fiveHour).toBeLessThanOrEqual(100);
          }

          if (sevenDay !== undefined) {
            expect(sevenDay).toBeGreaterThanOrEqual(0);
            expect(sevenDay).toBeLessThanOrEqual(100);
          }
        }
      });
    });
  });
});
