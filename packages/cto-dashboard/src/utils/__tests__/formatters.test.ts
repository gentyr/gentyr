/**
 * Unit tests for formatting utilities
 *
 * Tests number formatting, duration formatting, percentage formatting,
 * time formatting, and cache rate calculation.
 *
 * Philosophy: Validate structure and behavior, not performance.
 */

import { describe, it, expect } from 'vitest';
import {
  formatNumber,
  formatDuration,
  formatPercent,
  formatTime,
  formatDateTime,
  calculateCacheRate,
} from '../formatters.js';

describe('formatNumber', () => {
  it('should format numbers under 1K as strings', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(1)).toBe('1');
    expect(formatNumber(42)).toBe('42');
    expect(formatNumber(999)).toBe('999');
  });

  it('should format numbers in thousands with K suffix', () => {
    expect(formatNumber(1000)).toBe('1.0K');
    expect(formatNumber(1500)).toBe('1.5K');
    expect(formatNumber(10000)).toBe('10.0K');
    expect(formatNumber(999999)).toBe('1000.0K');
  });

  it('should format numbers in millions with M suffix', () => {
    expect(formatNumber(1_000_000)).toBe('1.0M');
    expect(formatNumber(1_500_000)).toBe('1.5M');
    expect(formatNumber(10_000_000)).toBe('10.0M');
    expect(formatNumber(999_999_999)).toBe('1000.0M');
  });

  it('should format numbers in billions with B suffix', () => {
    expect(formatNumber(1_000_000_000)).toBe('1.0B');
    expect(formatNumber(1_500_000_000)).toBe('1.5B');
    expect(formatNumber(10_000_000_000)).toBe('10.0B');
  });

  it('should handle edge cases', () => {
    // Boundary at 1K
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1000)).toBe('1.0K');

    // Boundary at 1M
    expect(formatNumber(999_999)).toBe('1000.0K');
    expect(formatNumber(1_000_000)).toBe('1.0M');

    // Boundary at 1B
    expect(formatNumber(999_999_999)).toBe('1000.0M');
    expect(formatNumber(1_000_000_000)).toBe('1.0B');
  });

  it('should return a string type', () => {
    expect(typeof formatNumber(0)).toBe('string');
    expect(typeof formatNumber(1000)).toBe('string');
    expect(typeof formatNumber(1_000_000)).toBe('string');
    expect(typeof formatNumber(1_000_000_000)).toBe('string');
  });

  it('should handle decimal precision correctly', () => {
    // Should have one decimal place for K/M/B
    expect(formatNumber(1234)).toBe('1.2K');
    expect(formatNumber(1567)).toBe('1.6K');
    expect(formatNumber(1_234_567)).toBe('1.2M');
    expect(formatNumber(1_567_890_123)).toBe('1.6B');
  });
});

describe('formatDuration', () => {
  it('should format durations under 1 minute as seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(59000)).toBe('59s');
  });

  it('should format durations in minutes', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(90000)).toBe('1m 30s');
    expect(formatDuration(125000)).toBe('2m 5s');
    expect(formatDuration(3599000)).toBe('59m 59s');
  });

  it('should format durations in hours', () => {
    expect(formatDuration(3600000)).toBe('1h 0m');
    expect(formatDuration(3660000)).toBe('1h 1m');
    expect(formatDuration(5400000)).toBe('1h 30m');
    expect(formatDuration(7200000)).toBe('2h 0m');
  });

  it('should handle edge cases', () => {
    // Boundary at 1 minute
    expect(formatDuration(59999)).toBe('59s');
    expect(formatDuration(60000)).toBe('1m 0s');

    // Boundary at 1 hour
    expect(formatDuration(3599999)).toBe('59m 59s');
    expect(formatDuration(3600000)).toBe('1h 0m');
  });

  it('should return a string type', () => {
    expect(typeof formatDuration(0)).toBe('string');
    expect(typeof formatDuration(60000)).toBe('string');
    expect(typeof formatDuration(3600000)).toBe('string');
  });

  it('should floor partial seconds/minutes/hours', () => {
    expect(formatDuration(1999)).toBe('1s'); // 1.999 seconds -> 1s
    expect(formatDuration(61999)).toBe('1m 1s'); // 1m 1.999s -> 1m 1s
    expect(formatDuration(3661999)).toBe('1h 1m'); // 1h 1m 1.999s -> 1h 1m
  });
});

describe('formatPercent', () => {
  it('should format percentages with % symbol', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(50)).toBe('50%');
    expect(formatPercent(100)).toBe('100%');
  });

  it('should round to nearest integer', () => {
    expect(formatPercent(50.4)).toBe('50%');
    expect(formatPercent(50.5)).toBe('51%');
    expect(formatPercent(50.6)).toBe('51%');
    expect(formatPercent(99.9)).toBe('100%');
  });

  it('should handle edge cases', () => {
    expect(formatPercent(0.1)).toBe('0%');
    expect(formatPercent(0.5)).toBe('1%');
    expect(formatPercent(0.4)).toBe('0%');
  });

  it('should return a string type', () => {
    expect(typeof formatPercent(0)).toBe('string');
    expect(typeof formatPercent(50)).toBe('string');
    expect(typeof formatPercent(100)).toBe('string');
  });

  it('should handle decimals correctly', () => {
    expect(formatPercent(33.33)).toBe('33%');
    expect(formatPercent(66.66)).toBe('67%');
    expect(formatPercent(12.5)).toBe('13%');
  });
});

describe('formatTime', () => {
  it('should format time as HH:MM in 24-hour format', () => {
    const date1 = new Date('2026-01-23T09:30:00');
    expect(formatTime(date1)).toBe('09:30');

    const date2 = new Date('2026-01-23T14:45:00');
    expect(formatTime(date2)).toBe('14:45');

    const date3 = new Date('2026-01-23T23:59:00');
    expect(formatTime(date3)).toBe('23:59');
  });

  it('should pad single digits with zeros', () => {
    const date1 = new Date('2026-01-23T00:00:00');
    expect(formatTime(date1)).toBe('00:00');

    const date2 = new Date('2026-01-23T01:05:00');
    expect(formatTime(date2)).toBe('01:05');
  });

  it('should return a string type', () => {
    const date = new Date('2026-01-23T12:00:00');
    expect(typeof formatTime(date)).toBe('string');
  });

  it('should handle midnight and noon', () => {
    const midnight = new Date('2026-01-23T00:00:00');
    expect(formatTime(midnight)).toBe('00:00');

    const noon = new Date('2026-01-23T12:00:00');
    expect(formatTime(noon)).toBe('12:00');
  });
});

describe('formatDateTime', () => {
  it('should format datetime as YYYY-MM-DD HH:MM', () => {
    const date1 = new Date('2026-01-23T09:30:00');
    expect(formatDateTime(date1)).toBe('2026-01-23 09:30');

    const date2 = new Date('2026-12-31T23:59:00');
    expect(formatDateTime(date2)).toBe('2026-12-31 23:59');
  });

  it('should handle single-digit months and days', () => {
    const date = new Date('2026-01-05T01:05:00');
    expect(formatDateTime(date)).toBe('2026-01-05 01:05');
  });

  it('should return a string type', () => {
    const date = new Date('2026-01-23T12:00:00');
    expect(typeof formatDateTime(date)).toBe('string');
  });

  it('should use YYYY-MM-DD format (ISO 8601)', () => {
    const date = new Date('2026-01-23T12:00:00');
    const result = formatDateTime(date);
    // Date portion should be YYYY-MM-DD
    const datePart = result.split(' ')[0];
    expect(datePart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('calculateCacheRate', () => {
  it('should calculate cache rate as percentage', () => {
    expect(calculateCacheRate(80, 20)).toBe(80); // 80/(80+20) = 80%
    expect(calculateCacheRate(50, 50)).toBe(50); // 50/(50+50) = 50%
    expect(calculateCacheRate(90, 10)).toBe(90); // 90/(90+10) = 90%
  });

  it('should return 0 when total input is 0', () => {
    expect(calculateCacheRate(0, 0)).toBe(0);
  });

  it('should return 0 when cache is 0', () => {
    expect(calculateCacheRate(0, 100)).toBe(0);
  });

  it('should return 100 when all input is cached', () => {
    expect(calculateCacheRate(100, 0)).toBe(100);
  });

  it('should round to nearest integer', () => {
    expect(calculateCacheRate(33, 67)).toBe(33); // 33/100 = 33%
    expect(calculateCacheRate(67, 33)).toBe(67); // 67/100 = 67%
    expect(calculateCacheRate(1, 2)).toBe(33); // 1/3 = 33.33% -> 33%
  });

  it('should return a number type', () => {
    expect(typeof calculateCacheRate(80, 20)).toBe('number');
    expect(typeof calculateCacheRate(0, 0)).toBe('number');
  });

  it('should handle large numbers', () => {
    expect(calculateCacheRate(1_000_000, 1_000_000)).toBe(50);
    expect(calculateCacheRate(9_000_000, 1_000_000)).toBe(90);
  });

  it('should validate cache rate is within 0-100 range', () => {
    const rate1 = calculateCacheRate(80, 20);
    expect(rate1).toBeGreaterThanOrEqual(0);
    expect(rate1).toBeLessThanOrEqual(100);

    const rate2 = calculateCacheRate(0, 0);
    expect(rate2).toBeGreaterThanOrEqual(0);
    expect(rate2).toBeLessThanOrEqual(100);

    const rate3 = calculateCacheRate(100, 0);
    expect(rate3).toBeGreaterThanOrEqual(0);
    expect(rate3).toBeLessThanOrEqual(100);
  });

  it('should not return NaN', () => {
    expect(calculateCacheRate(80, 20)).not.toBeNaN();
    expect(calculateCacheRate(0, 0)).not.toBeNaN();
    expect(calculateCacheRate(100, 0)).not.toBeNaN();
    expect(calculateCacheRate(0, 100)).not.toBeNaN();
  });
});
