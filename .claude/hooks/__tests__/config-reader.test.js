/**
 * Tests for config-reader.js
 *
 * These tests validate:
 * 1. getCooldown() - Dynamic cooldown reading with proper fallback chain
 * 2. getTimeout() - Alias for getCooldown
 * 3. getAdjustment() - Current adjustment factor retrieval
 * 4. getDefaults() - Default cooldown values
 * 5. getConfigPath() - Config file path retrieval
 * 6. Fail-safe behavior when config is missing or corrupted
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/config-reader.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('config-reader.js - Structure Validation', () => {
  const PROJECT_DIR = process.cwd();
  const CONFIG_READER_PATH = path.join(PROJECT_DIR, '.claude/hooks/config-reader.js');

  describe('Code Structure', () => {
    it('should be a valid ES module', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      // Should use ES module imports
      assert.match(code, /import .* from ['"]fs['"]/, 'Must import fs');
      assert.match(code, /import .* from ['"]path['"]/, 'Must import path');
    });

    it('should export all required functions', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      assert.match(code, /export function getCooldown/, 'Must export getCooldown');
      assert.match(code, /export function getTimeout/, 'Must export getTimeout');
      assert.match(code, /export function getAdjustment/, 'Must export getAdjustment');
      assert.match(code, /export function getDefaults/, 'Must export getDefaults');
      assert.match(code, /export function getConfigPath/, 'Must export getConfigPath');
    });

    it('should define hardcoded DEFAULTS constant', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      assert.match(code, /const DEFAULTS = \{/, 'Must define DEFAULTS constant');

      // Should have key defaults
      assert.match(code, /hourly_tasks:\s*\d+/, 'Must have hourly_tasks default');
      assert.match(code, /triage_check:\s*\d+/, 'Must have triage_check default');
      assert.match(code, /antipattern_hunter:\s*\d+/, 'Must have antipattern_hunter default');
      assert.match(code, /task_runner:\s*\d+/, 'Must have task_runner default');
      assert.match(code, /schema_mapper:\s*\d+/, 'Must have schema_mapper default');
    });

    it('should define CONFIG_PATH constant', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      assert.match(
        code,
        /const CONFIG_PATH = path\.join\(PROJECT_DIR,\s*['"]\.claude['"]/,
        'Must define CONFIG_PATH in .claude directory'
      );
      assert.match(
        code,
        /['"]automation-config\.json['"]\)/,
        'Must point to automation-config.json'
      );
    });
  });

  describe('readConfig() - Internal Function', () => {
    it('should return null when config file does not exist', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const functionMatch = code.match(/function readConfig\(\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'readConfig() function must exist');

      const functionBody = functionMatch[0];

      // Should check if file exists
      assert.match(
        functionBody,
        /if \(!fs\.existsSync\(CONFIG_PATH\)\)/,
        'Must check if config file exists'
      );

      // Should return null when missing
      assert.match(
        functionBody,
        /return null/,
        'Must return null when config missing'
      );
    });

    it('should return null on JSON parse errors', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const functionMatch = code.match(/function readConfig\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should wrap in try-catch
      assert.match(functionBody, /try \{/, 'Must have try block');
      assert.match(functionBody, /catch/, 'Must have catch block');

      // Should return null on error (fail-safe)
      assert.match(
        functionBody,
        /catch[\s\S]*?return null/,
        'Must return null on parse error'
      );
    });

    it('should validate config version', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const functionMatch = code.match(/function readConfig\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check version === 1
      assert.match(
        functionBody,
        /config\.version !== 1/,
        'Must validate config version is 1'
      );

      // Should return null on invalid version
      assert.match(
        functionBody,
        /if[\s\S]*?version !== 1[\s\S]*?return null/s,
        'Must return null for invalid version'
      );
    });

    it('should return parsed config on success', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const functionMatch = code.match(/function readConfig\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should parse JSON
      assert.match(functionBody, /JSON\.parse\(content\)/, 'Must parse JSON content');

      // Should return config
      assert.match(functionBody, /return config/, 'Must return parsed config');
    });
  });

  describe('getCooldown() - Priority Chain', () => {
    it('should accept key and optional fallbackMinutes parameters', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      assert.match(
        code,
        /export function getCooldown\(key,\s*\[?fallbackMinutes\]?\)/,
        'getCooldown must accept key and optional fallbackMinutes'
      );
    });

    it('should return hardDefault when config is null', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const functionMatch = code.match(/export function getCooldown\(key,[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'getCooldown function must exist');

      const functionBody = functionMatch[0];

      // Should calculate hardDefault from fallbackMinutes or DEFAULTS
      assert.match(
        functionBody,
        /const hardDefault = fallbackMinutes \?\? DEFAULTS\[key\]/,
        'Must calculate hardDefault from fallbackMinutes or DEFAULTS'
      );

      // Should return hardDefault when config is null
      assert.match(
        functionBody,
        /if \(!config\)[\s\S]*?return hardDefault/s,
        'Must return hardDefault when config unavailable'
      );
    });

    it('should prioritize effective over defaults', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const functionMatch = code.match(/export function getCooldown\(key,[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check effective first
      assert.match(
        functionBody,
        /if \(config\.effective && typeof config\.effective\[key\] === ['"]number['"]\)/,
        'Must check config.effective[key] first'
      );

      // Should return effective value
      assert.match(
        functionBody,
        /return config\.effective\[key\]/,
        'Must return effective value when available'
      );
    });

    it('should fall back to config.defaults when effective missing', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const functionMatch = code.match(/export function getCooldown\(key,[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should check defaults after effective
      assert.match(
        functionBody,
        /if \(config\.defaults && typeof config\.defaults\[key\] === ['"]number['"]\)/,
        'Must check config.defaults[key] as fallback'
      );

      // Should return defaults value
      assert.match(
        functionBody,
        /return config\.defaults\[key\]/,
        'Must return defaults value when effective unavailable'
      );
    });

    it('should fall back to hardDefault as final option', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const functionMatch = code.match(/export function getCooldown\(key,[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should have final return hardDefault at end
      assert.match(
        functionBody,
        /return hardDefault;?\s*\}/,
        'Must return hardDefault as final fallback'
      );
    });

    it('should document return value in minutes', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      // Should have JSDoc comment mentioning minutes
      assert.match(
        code,
        /@returns \{number\} Cooldown in minutes/,
        'JSDoc must document return value in minutes'
      );
    });
  });

  describe('getTimeout() - Alias Function', () => {
    it('should be an alias for getCooldown', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const functionMatch = code.match(/export function getTimeout\(key,[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'getTimeout function must exist');

      const functionBody = functionMatch[0];

      // Should call getCooldown
      assert.match(
        functionBody,
        /return getCooldown\(key, fallbackMinutes\)/,
        'getTimeout must call getCooldown with same parameters'
      );
    });

    it('should have JSDoc mentioning semantic difference', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      // Should document it's an alias but semantically different
      const timeoutSection = code.match(/\/\*\*[\s\S]*?export function getTimeout/);
      assert.ok(timeoutSection, 'getTimeout must have JSDoc');

      const jsdoc = timeoutSection[0];
      assert.match(
        jsdoc,
        /Alias for getCooldown/i,
        'JSDoc must mention alias relationship'
      );
    });
  });

  describe('getAdjustment() - Adjustment Factor', () => {
    it('should return default adjustment when config unavailable', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const functionMatch = code.match(/export function getAdjustment\(\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'getAdjustment function must exist');

      const functionBody = functionMatch[0];

      // Should return default object when config is null
      assert.match(
        functionBody,
        /if \(!config \|\| !config\.adjustment\)/,
        'Must check if config.adjustment exists'
      );

      assert.match(
        functionBody,
        /return \{[\s\S]*?factor:\s*1\.0[\s\S]*?\}/,
        'Must return factor: 1.0 as default'
      );

      assert.match(
        functionBody,
        /lastUpdated:\s*null/,
        'Must return lastUpdated: null as default'
      );

      assert.match(
        functionBody,
        /constrainingMetric:\s*null/,
        'Must return constrainingMetric: null as default'
      );

      assert.match(
        functionBody,
        /projectedAtReset:\s*null/,
        'Must return projectedAtReset: null as default'
      );
    });

    it('should extract adjustment data from config', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const functionMatch = code.match(/export function getAdjustment\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should return factor with nullish coalescing
      assert.match(
        functionBody,
        /factor:\s*config\.adjustment\.factor \?\? 1\.0/,
        'Must extract factor with default 1.0'
      );

      // Should return lastUpdated
      assert.match(
        functionBody,
        /lastUpdated:\s*config\.adjustment\.last_updated \?\? null/,
        'Must extract last_updated'
      );

      // Should return constrainingMetric
      assert.match(
        functionBody,
        /constrainingMetric:\s*config\.adjustment\.constraining_metric \?\? null/,
        'Must extract constraining_metric'
      );

      // Should return projectedAtReset
      assert.match(
        functionBody,
        /projectedAtReset:\s*config\.adjustment\.projected_at_reset \?\? null/,
        'Must extract projected_at_reset'
      );
    });

    it('should document return type structure', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      // Should have JSDoc with return type
      const jsdocMatch = code.match(/\/\*\*[\s\S]*?@returns[\s\S]*?export function getAdjustment/);
      assert.ok(jsdocMatch, 'getAdjustment must have JSDoc with return type');

      const jsdoc = jsdocMatch[0];
      assert.match(jsdoc, /factor:\s*number/, 'Must document factor property');
      assert.match(jsdoc, /lastUpdated/, 'Must document lastUpdated property');
      assert.match(jsdoc, /constrainingMetric/, 'Must document constrainingMetric property');
      assert.match(jsdoc, /projectedAtReset/, 'Must document projectedAtReset property');
    });
  });

  describe('getDefaults() - Default Values', () => {
    it('should return hardcoded DEFAULTS when config unavailable', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const functionMatch = code.match(/export function getDefaults\(\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'getDefaults function must exist');

      const functionBody = functionMatch[0];

      // Should check if config is available
      assert.match(
        functionBody,
        /if \(!config \|\| !config\.defaults\)/,
        'Must check if config.defaults exists'
      );

      // Should return spread DEFAULTS
      assert.match(
        functionBody,
        /return \{[\s\S]*?\.\.\.DEFAULTS[\s\S]*?\}/,
        'Must return spread of DEFAULTS object'
      );
    });

    it('should merge config.defaults with hardcoded DEFAULTS', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const functionMatch = code.match(/export function getDefaults\(\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should merge DEFAULTS with config.defaults (config overrides)
      assert.match(
        functionBody,
        /return \{[\s\S]*?\.\.\.DEFAULTS,[\s\S]*?\.\.\.config\.defaults[\s\S]*?\}/,
        'Must merge DEFAULTS with config.defaults'
      );
    });

    it('should document return type', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      // Should have JSDoc documenting return type
      const jsdocMatch = code.match(/\/\*\*[\s\S]*?@returns[\s\S]*?export function getDefaults/);
      assert.ok(jsdocMatch, 'getDefaults must have JSDoc with return type');

      const jsdoc = jsdocMatch[0];
      assert.match(
        jsdoc,
        /Record<string, number>/,
        'Must document return as Record<string, number>'
      );
    });
  });

  describe('getConfigPath() - Path Retrieval', () => {
    it('should return CONFIG_PATH constant', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const functionMatch = code.match(/export function getConfigPath\(\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'getConfigPath function must exist');

      const functionBody = functionMatch[0];

      // Should return CONFIG_PATH
      assert.match(
        functionBody,
        /return CONFIG_PATH/,
        'Must return CONFIG_PATH constant'
      );
    });

    it('should document usage by usage-optimizer', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      // Should have comment mentioning usage-optimizer
      const jsdocMatch = code.match(/\/\*\*[\s\S]*?export function getConfigPath/);
      assert.ok(jsdocMatch, 'getConfigPath must have JSDoc');

      const jsdoc = jsdocMatch[0];
      assert.match(
        jsdoc,
        /usage-optimizer/i,
        'JSDoc must mention usage-optimizer as use case'
      );
    });
  });

  describe('Fail-Safe Behavior', () => {
    it('should never throw errors - always return safe defaults', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      // readConfig should catch all errors
      const readConfigMatch = code.match(/function readConfig\(\) \{[\s\S]*?\n\}/);
      assert.match(
        readConfigMatch[0],
        /catch[\s\S]*?return null/,
        'readConfig must catch errors and return null'
      );

      // No bare catch blocks that rethrow
      assert.doesNotMatch(
        readConfigMatch[0],
        /catch[\s\S]*?throw/,
        'readConfig must not rethrow errors'
      );
    });

    it('should document fail-safe philosophy in comments', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      // Should have comment explaining fail-safe approach
      assert.match(
        code,
        /fail-safe|falls back|fallback/i,
        'Must document fail-safe behavior in comments'
      );
    });

    it('should validate all exported functions handle null config', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      // getCooldown handles null config
      const getCooldownMatch = code.match(/export function getCooldown\([\s\S]*?\n\}/);
      assert.match(
        getCooldownMatch[0],
        /if \(!config\)/,
        'getCooldown must check for null config'
      );

      // getAdjustment handles null config
      const getAdjustmentMatch = code.match(/export function getAdjustment\([\s\S]*?\n\}/);
      assert.match(
        getAdjustmentMatch[0],
        /if \(!config/,
        'getAdjustment must check for null config'
      );

      // getDefaults handles null config
      const getDefaultsMatch = code.match(/export function getDefaults\([\s\S]*?\n\}/);
      assert.match(
        getDefaultsMatch[0],
        /if \(!config/,
        'getDefaults must check for null config'
      );
    });
  });

  describe('Hardcoded DEFAULTS Values', () => {
    it('should have reasonable default cooldowns', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const defaultsMatch = code.match(/const DEFAULTS = \{[\s\S]*?\};/);
      assert.ok(defaultsMatch, 'DEFAULTS constant must exist');

      const defaults = defaultsMatch[0];

      // All values should be positive integers (in minutes)
      const valueMatches = [...defaults.matchAll(/:\s*(\d+)/g)];
      assert.ok(valueMatches.length >= 5, 'Should have at least 5 default values');

      for (const match of valueMatches) {
        const value = parseInt(match[1], 10);
        assert.ok(value > 0, `Default cooldown ${value} must be positive`);
        assert.ok(value <= 1440, `Default cooldown ${value} must be <= 1440 minutes (24 hours)`);
      }
    });

    it('should match documented defaults in comments', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      // Should have comment documenting defaults are in minutes
      assert.match(
        code,
        /Hardcoded defaults.*minutes/i,
        'Must document that defaults are in minutes'
      );
    });
  });

  describe('Integration - Usage Examples', () => {
    it('should have usage example in comments', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      // Should have usage example
      assert.match(
        code,
        /Usage:/i,
        'Must have usage example in header comments'
      );

      // Example should show importing functions
      assert.match(
        code,
        /import \{[\s\S]*?getCooldown/,
        'Usage example must show importing getCooldown'
      );

      // Example should show converting to milliseconds
      assert.match(
        code,
        /\* 60 \* 1000/,
        'Usage example must show converting minutes to milliseconds'
      );
    });

    it('should document priority chain in getCooldown JSDoc', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      const getCooldownJsdoc = code.match(/\/\*\*[\s\S]*?export function getCooldown/);
      assert.ok(getCooldownJsdoc, 'getCooldown must have JSDoc');

      const jsdoc = getCooldownJsdoc[0];

      // Should document the priority chain
      assert.match(
        jsdoc,
        /Priority:|priority/i,
        'Must document priority chain'
      );

      assert.match(
        jsdoc,
        /effective/i,
        'Priority chain must mention effective (dynamic) values'
      );

      assert.match(
        jsdoc,
        /defaults/i,
        'Priority chain must mention defaults from config'
      );

      assert.match(
        jsdoc,
        /fallback/i,
        'Priority chain must mention hardcoded fallback'
      );
    });
  });

  describe('File Header Documentation', () => {
    it('should have complete header with description and version', () => {
      const code = fs.readFileSync(CONFIG_READER_PATH, 'utf8');

      // Should have JSDoc header
      assert.match(code, /\/\*\*/, 'Must have JSDoc header');

      // Should describe purpose
      assert.match(
        code,
        /Centralized configuration/i,
        'Header must describe centralized configuration'
      );

      // Should mention automation-config.json
      assert.match(
        code,
        /automation-config\.json/,
        'Header must reference config file name'
      );

      // Should have version
      assert.match(
        code,
        /@version \d+\.\d+\.\d+/,
        'Header must have version number'
      );
    });
  });
});

describe('config-reader.js - Behavior Validation', () => {
  const PROJECT_DIR = process.cwd();
  const CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');

  let originalConfig = null;

  beforeEach(() => {
    // Back up existing config if present
    if (fs.existsSync(CONFIG_PATH)) {
      originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
    }
  });

  afterEach(() => {
    // Restore original config
    if (originalConfig !== null) {
      fs.writeFileSync(CONFIG_PATH, originalConfig);
    } else if (fs.existsSync(CONFIG_PATH)) {
      fs.unlinkSync(CONFIG_PATH);
    }
  });

  it('should handle missing config file gracefully', async () => {
    // Ensure config doesn't exist
    if (fs.existsSync(CONFIG_PATH)) {
      fs.unlinkSync(CONFIG_PATH);
    }

    // Import fresh module
    const configReaderPath = path.join(PROJECT_DIR, '.claude/hooks/config-reader.js');
    const { getCooldown, getDefaults } = await import(`${configReaderPath}?t=${Date.now()}`);

    // Should return fallback
    const cooldown = getCooldown('hourly_tasks', 55);
    assert.strictEqual(typeof cooldown, 'number', 'Should return a number');
    assert.strictEqual(cooldown, 55, 'Should return fallback value when config missing');

    // Should return hardcoded defaults
    const defaults = getDefaults();
    assert.ok(defaults, 'Should return defaults object');
    assert.ok(defaults.hourly_tasks, 'Should have hourly_tasks in defaults');
  });

  it('should handle corrupted config file gracefully', async () => {
    // Ensure directory exists
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });

    // Write corrupted JSON
    fs.writeFileSync(CONFIG_PATH, '{ invalid json }', 'utf8');

    // Import fresh module
    const configReaderPath = path.join(PROJECT_DIR, '.claude/hooks/config-reader.js');
    const { getCooldown } = await import(`${configReaderPath}?t=${Date.now()}`);

    // Should return fallback (no error thrown)
    const cooldown = getCooldown('hourly_tasks', 55);
    assert.strictEqual(typeof cooldown, 'number', 'Should return a number');
    assert.strictEqual(cooldown, 55, 'Should return fallback value for corrupted config');
  });

  it('should prioritize effective over defaults', async () => {
    // Write config with both effective and defaults
    const testConfig = {
      version: 1,
      defaults: {
        hourly_tasks: 55,
      },
      effective: {
        hourly_tasks: 30, // Effective should win
      },
    };

    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(testConfig, null, 2));

    // Import fresh module
    const configReaderPath = path.join(PROJECT_DIR, '.claude/hooks/config-reader.js');
    const { getCooldown } = await import(`${configReaderPath}?t=${Date.now()}`);

    const cooldown = getCooldown('hourly_tasks', 99);
    assert.strictEqual(cooldown, 30, 'Should return effective value over defaults');
  });

  it('should fall back to config.defaults when effective missing', async () => {
    // Write config with only defaults
    const testConfig = {
      version: 1,
      defaults: {
        hourly_tasks: 40,
      },
    };

    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(testConfig, null, 2));

    // Import fresh module
    const configReaderPath = path.join(PROJECT_DIR, '.claude/hooks/config-reader.js');
    const { getCooldown } = await import(`${configReaderPath}?t=${Date.now()}`);

    const cooldown = getCooldown('hourly_tasks', 99);
    assert.strictEqual(cooldown, 40, 'Should return config.defaults value when effective missing');
  });

  it('should return hardDefault when neither effective nor defaults present', async () => {
    // Write config with empty objects
    const testConfig = {
      version: 1,
      defaults: {},
      effective: {},
    };

    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(testConfig, null, 2));

    // Import fresh module
    const configReaderPath = path.join(PROJECT_DIR, '.claude/hooks/config-reader.js');
    const { getCooldown } = await import(`${configReaderPath}?t=${Date.now()}`);

    const cooldown = getCooldown('hourly_tasks', 88);
    assert.strictEqual(cooldown, 88, 'Should return fallbackMinutes parameter');
  });

  it('should reject config with wrong version', async () => {
    // Write config with wrong version
    const testConfig = {
      version: 2, // Wrong version
      defaults: {
        hourly_tasks: 25,
      },
    };

    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(testConfig, null, 2));

    // Import fresh module
    const configReaderPath = path.join(PROJECT_DIR, '.claude/hooks/config-reader.js');
    const { getCooldown } = await import(`${configReaderPath}?t=${Date.now()}`);

    const cooldown = getCooldown('hourly_tasks', 77);
    assert.strictEqual(cooldown, 77, 'Should reject invalid version and use fallback');
  });
});
