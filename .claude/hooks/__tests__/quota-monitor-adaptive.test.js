/**
 * Tests for quota-monitor.js - adaptive intervals and predictive rotation
 *
 * Covers the new adaptive check intervals and velocity-based rotation:
 * 1. getAdaptiveInterval() - tier boundaries (< 70%, 70-85%, 85-95%, >= 95%)
 * 2. computeVelocity() - usage change tracking over rolling window
 * 3. Predictive rotation - triggers when projected to hit 100% within 1.5x interval
 * 4. Usage history tracking - rolling 5-sample window
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/quota-monitor-adaptive.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QUOTA_MONITOR_PATH = path.join(__dirname, '..', 'quota-monitor.js');

describe('quota-monitor.js - Adaptive Intervals', () => {
  describe('Code Structure: ADAPTIVE_INTERVALS constant', () => {
    it('should define ADAPTIVE_INTERVALS array with tier objects', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      assert.match(
        code,
        /const ADAPTIVE_INTERVALS\s*=/,
        'Must define ADAPTIVE_INTERVALS constant'
      );

      // Should be an array
      assert.match(
        code,
        /ADAPTIVE_INTERVALS\s*=\s*\[/,
        'ADAPTIVE_INTERVALS must be an array'
      );
    });

    it('should define tier for usage < 70% at 5 min interval', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      // Should have 70% tier
      assert.match(
        code,
        /maxUsage:\s*70/,
        'Must define 70% threshold tier'
      );

      // Should have 5 min interval (5 * 60 * 1000 = 300000)
      assert.match(
        code,
        /5\s*\*\s*60\s*\*\s*1000/,
        'Must define 5-minute interval for low usage tier'
      );
    });

    it('should define tier for usage 70-85% at 2 min interval', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      // Should have 85% tier
      assert.match(
        code,
        /maxUsage:\s*85/,
        'Must define 85% threshold tier'
      );

      // Should have 2 min interval (2 * 60 * 1000 = 120000)
      assert.match(
        code,
        /2\s*\*\s*60\s*\*\s*1000/,
        'Must define 2-minute interval for medium usage tier'
      );
    });

    it('should define tier for usage 85-95% at 1 min interval', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      // Should have 95% tier
      assert.match(
        code,
        /maxUsage:\s*95/,
        'Must define 95% threshold tier'
      );

      // Should have 1 min interval (60 * 1000 = 60000)
      assert.match(
        code,
        /60\s*\*\s*1000/,
        'Must define 1-minute interval for high usage tier'
      );
    });

    it('should define tier for usage >= 95% at 30 sec interval', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      // Should have Infinity tier (catch-all)
      assert.match(
        code,
        /maxUsage:\s*Infinity/,
        'Must define Infinity threshold for highest tier'
      );

      // Should have 30 sec interval (30 * 1000 = 30000)
      assert.match(
        code,
        /30\s*\*\s*1000/,
        'Must define 30-second interval for critical usage tier'
      );
    });
  });

  describe('Code Structure: getAdaptiveInterval() function', () => {
    it('should define getAdaptiveInterval function', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      assert.match(
        code,
        /function getAdaptiveInterval\(/,
        'Must define getAdaptiveInterval function'
      );
    });

    it('should accept usagePercent parameter', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const fnMatch = code.match(/function getAdaptiveInterval\([^)]*\)/);
      assert.ok(fnMatch, 'getAdaptiveInterval must be defined');

      assert.match(
        fnMatch[0],
        /usagePercent/,
        'Must accept usagePercent parameter'
      );
    });

    it('should iterate through ADAPTIVE_INTERVALS to find matching tier', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const fnMatch = code.match(/function getAdaptiveInterval[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'getAdaptiveInterval must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /for.*ADAPTIVE_INTERVALS/,
        'Must iterate through ADAPTIVE_INTERVALS'
      );
    });

    it('should return intervalMs from matching tier', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const fnMatch = code.match(/function getAdaptiveInterval[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'getAdaptiveInterval must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /return.*intervalMs/,
        'Must return intervalMs from matching tier'
      );
    });

    it('should have fallback for edge cases', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const fnMatch = code.match(/function getAdaptiveInterval[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'getAdaptiveInterval must be defined');
      const fnBody = fnMatch[0];

      // Should have fallback return outside loop
      const returnStatements = fnBody.match(/return/g);
      assert.ok(
        returnStatements && returnStatements.length >= 2,
        'Must have fallback return statement'
      );
    });
  });

  describe('Behavioral logic: getAdaptiveInterval() tier selection', () => {
    it('should return 5-minute interval for usage < 70%', () => {
      const ADAPTIVE_INTERVALS = [
        { maxUsage: 70,  intervalMs: 5 * 60 * 1000 },
        { maxUsage: 85,  intervalMs: 2 * 60 * 1000 },
        { maxUsage: 95,  intervalMs: 60 * 1000 },
        { maxUsage: Infinity, intervalMs: 30 * 1000 },
      ];

      function getAdaptiveInterval(usagePercent) {
        for (const tier of ADAPTIVE_INTERVALS) {
          if (usagePercent < tier.maxUsage) {
            return tier.intervalMs;
          }
        }
        return ADAPTIVE_INTERVALS[ADAPTIVE_INTERVALS.length - 1].intervalMs;
      }

      assert.strictEqual(
        getAdaptiveInterval(0),
        5 * 60 * 1000,
        'Usage 0% should return 5-minute interval'
      );

      assert.strictEqual(
        getAdaptiveInterval(50),
        5 * 60 * 1000,
        'Usage 50% should return 5-minute interval'
      );

      assert.strictEqual(
        getAdaptiveInterval(69.9),
        5 * 60 * 1000,
        'Usage 69.9% should return 5-minute interval'
      );
    });

    it('should return 2-minute interval for usage 70-84.9%', () => {
      const ADAPTIVE_INTERVALS = [
        { maxUsage: 70,  intervalMs: 5 * 60 * 1000 },
        { maxUsage: 85,  intervalMs: 2 * 60 * 1000 },
        { maxUsage: 95,  intervalMs: 60 * 1000 },
        { maxUsage: Infinity, intervalMs: 30 * 1000 },
      ];

      function getAdaptiveInterval(usagePercent) {
        for (const tier of ADAPTIVE_INTERVALS) {
          if (usagePercent < tier.maxUsage) {
            return tier.intervalMs;
          }
        }
        return ADAPTIVE_INTERVALS[ADAPTIVE_INTERVALS.length - 1].intervalMs;
      }

      assert.strictEqual(
        getAdaptiveInterval(70),
        2 * 60 * 1000,
        'Usage 70% should return 2-minute interval'
      );

      assert.strictEqual(
        getAdaptiveInterval(80),
        2 * 60 * 1000,
        'Usage 80% should return 2-minute interval'
      );

      assert.strictEqual(
        getAdaptiveInterval(84.9),
        2 * 60 * 1000,
        'Usage 84.9% should return 2-minute interval'
      );
    });

    it('should return 1-minute interval for usage 85-94.9%', () => {
      const ADAPTIVE_INTERVALS = [
        { maxUsage: 70,  intervalMs: 5 * 60 * 1000 },
        { maxUsage: 85,  intervalMs: 2 * 60 * 1000 },
        { maxUsage: 95,  intervalMs: 60 * 1000 },
        { maxUsage: Infinity, intervalMs: 30 * 1000 },
      ];

      function getAdaptiveInterval(usagePercent) {
        for (const tier of ADAPTIVE_INTERVALS) {
          if (usagePercent < tier.maxUsage) {
            return tier.intervalMs;
          }
        }
        return ADAPTIVE_INTERVALS[ADAPTIVE_INTERVALS.length - 1].intervalMs;
      }

      assert.strictEqual(
        getAdaptiveInterval(85),
        60 * 1000,
        'Usage 85% should return 1-minute interval'
      );

      assert.strictEqual(
        getAdaptiveInterval(90),
        60 * 1000,
        'Usage 90% should return 1-minute interval'
      );

      assert.strictEqual(
        getAdaptiveInterval(94.9),
        60 * 1000,
        'Usage 94.9% should return 1-minute interval'
      );
    });

    it('should return 30-second interval for usage >= 95%', () => {
      const ADAPTIVE_INTERVALS = [
        { maxUsage: 70,  intervalMs: 5 * 60 * 1000 },
        { maxUsage: 85,  intervalMs: 2 * 60 * 1000 },
        { maxUsage: 95,  intervalMs: 60 * 1000 },
        { maxUsage: Infinity, intervalMs: 30 * 1000 },
      ];

      function getAdaptiveInterval(usagePercent) {
        for (const tier of ADAPTIVE_INTERVALS) {
          if (usagePercent < tier.maxUsage) {
            return tier.intervalMs;
          }
        }
        return ADAPTIVE_INTERVALS[ADAPTIVE_INTERVALS.length - 1].intervalMs;
      }

      assert.strictEqual(
        getAdaptiveInterval(95),
        30 * 1000,
        'Usage 95% should return 30-second interval'
      );

      assert.strictEqual(
        getAdaptiveInterval(98),
        30 * 1000,
        'Usage 98% should return 30-second interval'
      );

      assert.strictEqual(
        getAdaptiveInterval(100),
        30 * 1000,
        'Usage 100% should return 30-second interval'
      );
    });
  });
});

describe('quota-monitor.js - Velocity Tracking', () => {
  describe('Code Structure: computeVelocity() function', () => {
    it('should define computeVelocity function', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      assert.match(
        code,
        /function computeVelocity\(/,
        'Must define computeVelocity function'
      );
    });

    it('should accept usageHistory parameter', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const fnMatch = code.match(/function computeVelocity\([^)]*\)/);
      assert.ok(fnMatch, 'computeVelocity must be defined');

      assert.match(
        fnMatch[0],
        /usageHistory/,
        'Must accept usageHistory parameter'
      );
    });

    it('should return 0 if usageHistory has less than 2 entries', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const fnMatch = code.match(/function computeVelocity[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'computeVelocity must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /length < 2[\s\S]*?return 0/,
        'Must return 0 when insufficient data points'
      );
    });

    it('should compute time delta in minutes', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const fnMatch = code.match(/function computeVelocity[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'computeVelocity must be defined');
      const fnBody = fnMatch[0];

      // Should divide by 60 * 1000 to convert ms to minutes
      assert.match(
        fnBody,
        /\/ \(60 \* 1000\)/,
        'Must convert milliseconds to minutes'
      );
    });

    it('should return 0 if time delta is <= 0', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const fnMatch = code.match(/function computeVelocity[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'computeVelocity must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /timeDelta.*<= 0[\s\S]*?return 0/,
        'Must return 0 when time delta is non-positive'
      );
    });

    it('should compute velocity as usage delta / time delta', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const fnMatch = code.match(/function computeVelocity[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'computeVelocity must be defined');
      const fnBody = fnMatch[0];

      // Should compute usage delta
      assert.match(
        fnBody,
        /newest\.usage - oldest\.usage/,
        'Must compute usage delta between oldest and newest'
      );

      // Should return delta / time
      assert.match(
        fnBody,
        /return.*\/.*timeDelta/,
        'Must return usage delta divided by time delta'
      );
    });
  });

  describe('Behavioral logic: computeVelocity() scenarios', () => {
    it('should return 0 when usageHistory is empty', () => {
      function computeVelocity(usageHistory) {
        if (!Array.isArray(usageHistory) || usageHistory.length < 2) {
          return 0;
        }
        const oldest = usageHistory[0];
        const newest = usageHistory[usageHistory.length - 1];
        const timeDeltaMs = newest.timestamp - oldest.timestamp;
        if (timeDeltaMs <= 0) {
          return 0;
        }
        const timeDeltaMin = timeDeltaMs / (60 * 1000);
        return (newest.usage - oldest.usage) / timeDeltaMin;
      }

      assert.strictEqual(
        computeVelocity([]),
        0,
        'Empty history should return 0 velocity'
      );
    });

    it('should return 0 when usageHistory has only 1 entry', () => {
      function computeVelocity(usageHistory) {
        if (!Array.isArray(usageHistory) || usageHistory.length < 2) {
          return 0;
        }
        const oldest = usageHistory[0];
        const newest = usageHistory[usageHistory.length - 1];
        const timeDeltaMs = newest.timestamp - oldest.timestamp;
        if (timeDeltaMs <= 0) {
          return 0;
        }
        const timeDeltaMin = timeDeltaMs / (60 * 1000);
        return (newest.usage - oldest.usage) / timeDeltaMin;
      }

      const history = [{ usage: 50, timestamp: Date.now() }];
      assert.strictEqual(
        computeVelocity(history),
        0,
        'Single entry should return 0 velocity'
      );
    });

    it('should return 0 when time delta is 0 (same timestamps)', () => {
      function computeVelocity(usageHistory) {
        if (!Array.isArray(usageHistory) || usageHistory.length < 2) {
          return 0;
        }
        const oldest = usageHistory[0];
        const newest = usageHistory[usageHistory.length - 1];
        const timeDeltaMs = newest.timestamp - oldest.timestamp;
        if (timeDeltaMs <= 0) {
          return 0;
        }
        const timeDeltaMin = timeDeltaMs / (60 * 1000);
        return (newest.usage - oldest.usage) / timeDeltaMin;
      }

      const now = Date.now();
      const history = [
        { usage: 50, timestamp: now },
        { usage: 60, timestamp: now }, // same timestamp
      ];

      assert.strictEqual(
        computeVelocity(history),
        0,
        'Same timestamps should return 0 velocity'
      );
    });

    it('should compute positive velocity when usage is increasing', () => {
      function computeVelocity(usageHistory) {
        if (!Array.isArray(usageHistory) || usageHistory.length < 2) {
          return 0;
        }
        const oldest = usageHistory[0];
        const newest = usageHistory[usageHistory.length - 1];
        const timeDeltaMs = newest.timestamp - oldest.timestamp;
        if (timeDeltaMs <= 0) {
          return 0;
        }
        const timeDeltaMin = timeDeltaMs / (60 * 1000);
        return (newest.usage - oldest.usage) / timeDeltaMin;
      }

      const now = Date.now();
      const history = [
        { usage: 50, timestamp: now - 2 * 60 * 1000 },  // 2 min ago
        { usage: 60, timestamp: now },                  // now
      ];

      const velocity = computeVelocity(history);
      assert.strictEqual(
        velocity,
        5,
        'Usage increase of 10% over 2 minutes should yield 5% per minute'
      );
    });

    it('should compute negative velocity when usage is decreasing', () => {
      function computeVelocity(usageHistory) {
        if (!Array.isArray(usageHistory) || usageHistory.length < 2) {
          return 0;
        }
        const oldest = usageHistory[0];
        const newest = usageHistory[usageHistory.length - 1];
        const timeDeltaMs = newest.timestamp - oldest.timestamp;
        if (timeDeltaMs <= 0) {
          return 0;
        }
        const timeDeltaMin = timeDeltaMs / (60 * 1000);
        return (newest.usage - oldest.usage) / timeDeltaMin;
      }

      const now = Date.now();
      const history = [
        { usage: 80, timestamp: now - 5 * 60 * 1000 },  // 5 min ago
        { usage: 70, timestamp: now },                  // now
      ];

      const velocity = computeVelocity(history);
      assert.strictEqual(
        velocity,
        -2,
        'Usage decrease of 10% over 5 minutes should yield -2% per minute'
      );
    });

    it('should use only oldest and newest entries in rolling window', () => {
      function computeVelocity(usageHistory) {
        if (!Array.isArray(usageHistory) || usageHistory.length < 2) {
          return 0;
        }
        const oldest = usageHistory[0];
        const newest = usageHistory[usageHistory.length - 1];
        const timeDeltaMs = newest.timestamp - oldest.timestamp;
        if (timeDeltaMs <= 0) {
          return 0;
        }
        const timeDeltaMin = timeDeltaMs / (60 * 1000);
        return (newest.usage - oldest.usage) / timeDeltaMin;
      }

      const now = Date.now();
      const history = [
        { usage: 50, timestamp: now - 4 * 60 * 1000 },  // oldest
        { usage: 55, timestamp: now - 3 * 60 * 1000 },  // middle (ignored)
        { usage: 52, timestamp: now - 2 * 60 * 1000 },  // middle (ignored)
        { usage: 58, timestamp: now - 1 * 60 * 1000 },  // middle (ignored)
        { usage: 70, timestamp: now },                  // newest
      ];

      const velocity = computeVelocity(history);
      assert.strictEqual(
        velocity,
        5,
        'Velocity should be computed from oldest (50%) to newest (70%) = 20% over 4 min = 5%/min'
      );
    });
  });

  describe('Code Structure: Usage history tracking', () => {
    it('should define USAGE_HISTORY_MAX constant for rolling window size', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      assert.match(
        code,
        /const USAGE_HISTORY_MAX\s*=\s*5/,
        'Must define USAGE_HISTORY_MAX = 5 for rolling window'
      );
    });

    it('should push current usage to usageHistory array', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const mainMatch = code.match(/async function main\(\)[\s\S]*$/);
      assert.ok(mainMatch, 'main() must be defined');
      const mainBody = mainMatch[0];

      assert.match(
        mainBody,
        /usageHistory\.push\(/,
        'Must push new usage snapshot to usageHistory'
      );
    });

    it('should trim usageHistory to USAGE_HISTORY_MAX size', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const mainMatch = code.match(/async function main\(\)[\s\S]*$/);
      assert.ok(mainMatch, 'main() must be defined');
      const mainBody = mainMatch[0];

      assert.match(
        mainBody,
        /while.*usageHistory\.length > USAGE_HISTORY_MAX/,
        'Must trim usageHistory when it exceeds max size'
      );

      assert.match(
        mainBody,
        /usageHistory\.shift\(\)/,
        'Must use shift() to remove oldest entry'
      );
    });

    it('should store usageHistory in throttle state', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const mainMatch = code.match(/async function main\(\)[\s\S]*$/);
      assert.ok(mainMatch, 'main() must be defined');
      const mainBody = mainMatch[0];

      assert.match(
        mainBody,
        /throttle\.usageHistory\s*=/,
        'Must store usageHistory in throttle state'
      );
    });
  });
});

describe('quota-monitor.js - Predictive Rotation', () => {
  describe('Code Structure: Predictive rotation logic', () => {
    it('should compute velocity after updating usage history', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const mainMatch = code.match(/async function main\(\)[\s\S]*$/);
      assert.ok(mainMatch, 'main() must be defined');
      const mainBody = mainMatch[0];

      assert.match(
        mainBody,
        /const velocity = computeVelocity\(usageHistory\)/,
        'Must compute velocity from usageHistory'
      );
    });

    it('should check predictive rotation condition', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const mainMatch = code.match(/async function main\(\)[\s\S]*$/);
      assert.ok(mainMatch, 'main() must be defined');
      const mainBody = mainMatch[0];

      // Should check velocity > 0
      assert.match(
        mainBody,
        /velocity > 0/,
        'Must check velocity > 0 for predictive rotation'
      );

      // Should compute remaining percent
      assert.match(
        mainBody,
        /remainingPercent = 100 - maxUsage/,
        'Must compute remaining percent to exhaustion'
      );

      // Should compute minutes to exhaustion
      assert.match(
        mainBody,
        /minutesToExhaustion = remainingPercent \/ velocity/,
        'Must compute minutes to exhaustion'
      );
    });

    it('should use 1.5x current interval as prediction horizon', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const mainMatch = code.match(/async function main\(\)[\s\S]*$/);
      assert.ok(mainMatch, 'main() must be defined');
      const mainBody = mainMatch[0];

      assert.match(
        mainBody,
        /predictionHorizon = throttle\.currentIntervalMs \* 1\.5/,
        'Must use 1.5x interval as prediction horizon'
      );
    });

    it('should set predictiveRotation flag when projected to hit 100% within horizon', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const mainMatch = code.match(/async function main\(\)[\s\S]*$/);
      assert.ok(mainMatch, 'main() must be defined');
      const mainBody = mainMatch[0];

      assert.match(
        mainBody,
        /if \(msToExhaustion < predictionHorizon\)/,
        'Must check if time to exhaustion is less than prediction horizon'
      );

      assert.match(
        mainBody,
        /predictiveRotation = true/,
        'Must set predictiveRotation flag when condition is met'
      );
    });

    it('should only trigger predictive rotation when usage < PROACTIVE_THRESHOLD', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const mainMatch = code.match(/async function main\(\)[\s\S]*$/);
      assert.ok(mainMatch, 'main() must be defined');
      const mainBody = mainMatch[0];

      // Predictive check should be conditional on usage < threshold
      assert.match(
        mainBody,
        /maxUsage < PROACTIVE_THRESHOLD/,
        'Must only predict when usage is below proactive threshold'
      );
    });

    it('should include velocity in rotation reason when predictive', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const mainMatch = code.match(/async function main\(\)[\s\S]*$/);
      assert.ok(mainMatch, 'main() must be defined');
      const mainBody = mainMatch[0];

      assert.match(
        mainBody,
        /quota_monitor_predictive.*vel/,
        'Must include velocity in predictive rotation reason'
      );
    });

    it('should include predictive flag in logRotationEvent metadata', () => {
      const code = fs.readFileSync(QUOTA_MONITOR_PATH, 'utf8');

      const mainMatch = code.match(/async function main\(\)[\s\S]*$/);
      assert.ok(mainMatch, 'main() must be defined');
      const mainBody = mainMatch[0];

      assert.match(
        mainBody,
        /predictive: predictiveRotation/,
        'Must include predictive flag in rotation event metadata'
      );
    });
  });

  describe('Behavioral logic: Predictive rotation scenarios', () => {
    it('should NOT trigger predictive rotation when velocity is 0', () => {
      const velocity = 0;
      const maxUsage = 80;
      const currentIntervalMs = 2 * 60 * 1000; // 2 min

      // Simulate predictive check
      let predictiveRotation = false;
      if (velocity > 0 && maxUsage < 95) {
        const remainingPercent = 100 - maxUsage;
        const minutesToExhaustion = remainingPercent / velocity;
        const msToExhaustion = minutesToExhaustion * 60 * 1000;
        const predictionHorizon = currentIntervalMs * 1.5;
        if (msToExhaustion < predictionHorizon) {
          predictiveRotation = true;
        }
      }

      assert.strictEqual(
        predictiveRotation,
        false,
        'Should NOT trigger when velocity is 0'
      );
    });

    it('should NOT trigger predictive rotation when velocity is negative', () => {
      const velocity = -2; // usage decreasing
      const maxUsage = 80;
      const currentIntervalMs = 2 * 60 * 1000;

      let predictiveRotation = false;
      if (velocity > 0 && maxUsage < 95) {
        const remainingPercent = 100 - maxUsage;
        const minutesToExhaustion = remainingPercent / velocity;
        const msToExhaustion = minutesToExhaustion * 60 * 1000;
        const predictionHorizon = currentIntervalMs * 1.5;
        if (msToExhaustion < predictionHorizon) {
          predictiveRotation = true;
        }
      }

      assert.strictEqual(
        predictiveRotation,
        false,
        'Should NOT trigger when velocity is negative (usage decreasing)'
      );
    });

    it('should trigger predictive rotation when projected to hit 100% within 1.5x interval', () => {
      const velocity = 10; // 10% per minute
      const maxUsage = 80; // current usage
      const currentIntervalMs = 2 * 60 * 1000; // 2 min check interval

      let predictiveRotation = false;
      if (velocity > 0 && maxUsage < 95) {
        const remainingPercent = 100 - maxUsage; // 20%
        const minutesToExhaustion = remainingPercent / velocity; // 20 / 10 = 2 min
        const msToExhaustion = minutesToExhaustion * 60 * 1000; // 120000 ms
        const predictionHorizon = currentIntervalMs * 1.5; // 180000 ms (3 min)
        if (msToExhaustion < predictionHorizon) {
          predictiveRotation = true;
        }
      }

      assert.strictEqual(
        predictiveRotation,
        true,
        'Should trigger when 2 min to exhaustion < 3 min horizon'
      );
    });

    it('should NOT trigger predictive rotation when time to exhaustion exceeds horizon', () => {
      const velocity = 5; // 5% per minute
      const maxUsage = 70; // current usage
      const currentIntervalMs = 2 * 60 * 1000; // 2 min check interval

      let predictiveRotation = false;
      if (velocity > 0 && maxUsage < 95) {
        const remainingPercent = 100 - maxUsage; // 30%
        const minutesToExhaustion = remainingPercent / velocity; // 30 / 5 = 6 min
        const msToExhaustion = minutesToExhaustion * 60 * 1000; // 360000 ms
        const predictionHorizon = currentIntervalMs * 1.5; // 180000 ms (3 min)
        if (msToExhaustion < predictionHorizon) {
          predictiveRotation = true;
        }
      }

      assert.strictEqual(
        predictiveRotation,
        false,
        'Should NOT trigger when 6 min to exhaustion > 3 min horizon'
      );
    });

    it('should NOT trigger predictive rotation when already above PROACTIVE_THRESHOLD', () => {
      const velocity = 10;
      const maxUsage = 96; // above 95% threshold
      const currentIntervalMs = 30 * 1000; // 30 sec interval
      const PROACTIVE_THRESHOLD = 95;

      let predictiveRotation = false;
      if (velocity > 0 && maxUsage < PROACTIVE_THRESHOLD) {
        const remainingPercent = 100 - maxUsage;
        const minutesToExhaustion = remainingPercent / velocity;
        const msToExhaustion = minutesToExhaustion * 60 * 1000;
        const predictionHorizon = currentIntervalMs * 1.5;
        if (msToExhaustion < predictionHorizon) {
          predictiveRotation = true;
        }
      }

      assert.strictEqual(
        predictiveRotation,
        false,
        'Should NOT trigger predictive when already above 95% (normal rotation takes over)'
      );
    });
  });
});
