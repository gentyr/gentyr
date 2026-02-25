/**
 * Tests for Playwright config discovery module.
 *
 * Validates regex-based parsing of playwright.config.ts to discover
 * projects, test dirs, auth files, and derived maps.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { discoverPlaywrightConfig, resetConfigCache } from '../config-discovery.js';

let tempDir: string;

beforeEach(() => {
  tempDir = path.join('/tmp', `pw-config-discovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  resetConfigCache();
});

afterEach(() => {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  resetConfigCache();
});

function writeConfig(content: string, filename = 'playwright.config.ts') {
  fs.writeFileSync(path.join(tempDir, filename), content);
}

// ============================================================================
// Basic parsing
// ============================================================================

describe('discoverPlaywrightConfig', () => {
  it('should parse minimal config with one project', () => {
    writeConfig(`
      export default defineConfig({
        testDir: './e2e',
        projects: [
          { name: 'smoke', testDir: 'e2e/smoke' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.projects).toHaveLength(1);
    expect(config.projects[0].name).toBe('smoke');
    expect(config.projects[0].testDir).toBe('e2e/smoke');
    expect(config.projectDirMap).toEqual({ smoke: 'e2e/smoke' });
  });

  it('should parse config with multiple projects including storageState', () => {
    writeConfig(`
      export default defineConfig({
        testDir: './e2e',
        projects: [
          {
            name: 'vendor-owner',
            testDir: 'e2e/vendor',
            use: { storageState: '.auth/vendor-owner.json' },
          },
          {
            name: 'vendor-admin',
            testDir: 'e2e/vendor-roles',
            use: { storageState: '.auth/vendor-admin.json' },
          },
          {
            name: 'seed',
            testDir: 'e2e/seed',
          },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.projects).toHaveLength(3);
    expect(config.projectDirMap).toEqual({
      'vendor-owner': 'e2e/vendor',
      'vendor-admin': 'e2e/vendor-roles',
    });
    expect(config.authFiles).toEqual(['.auth/vendor-owner.json', '.auth/vendor-admin.json']);
    expect(config.primaryAuthFile).toBe('.auth/vendor-owner.json');
  });

  it('should return empty result for config with no projects array', () => {
    writeConfig(`
      export default defineConfig({
        testDir: './tests',
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.projects).toHaveLength(0);
    expect(config.projectDirMap).toEqual({});
  });

  it('should return empty result for missing config file', () => {
    const config = discoverPlaywrightConfig(tempDir);

    expect(config.projects).toHaveLength(0);
    expect(config.defaultTestDir).toBe('e2e');
  });

  it('should fall back to playwright.config.js', () => {
    writeConfig(`
      module.exports = defineConfig({
        projects: [
          { name: 'basic', testDir: 'tests' },
        ],
      });
    `, 'playwright.config.js');

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.projects).toHaveLength(1);
    expect(config.projects[0].name).toBe('basic');
  });

  it('should prefer .ts over .js when both exist', () => {
    writeConfig(`
      export default defineConfig({
        projects: [
          { name: 'ts-project' },
        ],
      });
    `, 'playwright.config.ts');

    writeConfig(`
      module.exports = defineConfig({
        projects: [
          { name: 'js-project' },
        ],
      });
    `, 'playwright.config.js');

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.projects).toHaveLength(1);
    expect(config.projects[0].name).toBe('ts-project');
  });
});

// ============================================================================
// Default testDir
// ============================================================================

describe('defaultTestDir', () => {
  it('should extract top-level testDir', () => {
    writeConfig(`
      export default defineConfig({
        testDir: './tests',
        projects: [
          { name: 'basic' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.defaultTestDir).toBe('tests');
  });

  it('should strip leading ./ from testDir', () => {
    writeConfig(`
      export default defineConfig({
        testDir: './e2e',
        projects: [
          { name: 'basic' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.defaultTestDir).toBe('e2e');
  });

  it('should default to e2e when no top-level testDir specified', () => {
    writeConfig(`
      export default defineConfig({
        projects: [
          { name: 'basic' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.defaultTestDir).toBe('e2e');
  });

  it('should use defaultTestDir for projects without testDir', () => {
    writeConfig(`
      export default defineConfig({
        testDir: './tests',
        projects: [
          { name: 'one' },
          { name: 'two', testDir: 'custom' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.projectDirMap).toEqual({
      one: 'tests',
      two: 'custom',
    });
  });
});

// ============================================================================
// Infrastructure detection
// ============================================================================

describe('infrastructure detection', () => {
  it('should flag seed, auth-setup, cleanup, setup as infrastructure', () => {
    writeConfig(`
      export default defineConfig({
        projects: [
          { name: 'seed' },
          { name: 'auth-setup' },
          { name: 'cleanup' },
          { name: 'setup' },
          { name: 'main' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    const infraNames = config.projects.filter(p => p.isInfrastructure).map(p => p.name);
    expect(infraNames).toEqual(['seed', 'auth-setup', 'cleanup', 'setup']);

    // Infrastructure projects excluded from projectDirMap
    expect(config.projectDirMap).toEqual({ main: 'e2e' });
  });
});

// ============================================================================
// Extension detection
// ============================================================================

describe('extension detection', () => {
  it('should flag projects containing "extension" as extension projects', () => {
    writeConfig(`
      export default defineConfig({
        projects: [
          { name: 'extension' },
          { name: 'extension-manual' },
          { name: 'vendor-owner' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.projects.find(p => p.name === 'extension')!.isExtension).toBe(true);
    expect(config.projects.find(p => p.name === 'extension-manual')!.isExtension).toBe(true);
    expect(config.projects.find(p => p.name === 'vendor-owner')!.isExtension).toBe(false);
  });

  it('should include extension and demo projects in extensionProjects set', () => {
    writeConfig(`
      export default defineConfig({
        projects: [
          { name: 'extension' },
          { name: 'extension-manual' },
          { name: 'demo' },
          { name: 'vendor-owner' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.extensionProjects.has('extension')).toBe(true);
    expect(config.extensionProjects.has('extension-manual')).toBe(true);
    expect(config.extensionProjects.has('demo')).toBe(true);
    expect(config.extensionProjects.has('vendor-owner')).toBe(false);
  });
});

// ============================================================================
// Manual detection
// ============================================================================

describe('manual detection', () => {
  it('should flag "manual" and names ending with "-manual"', () => {
    writeConfig(`
      export default defineConfig({
        projects: [
          { name: 'manual' },
          { name: 'extension-manual' },
          { name: 'vendor-owner' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.projects.find(p => p.name === 'manual')!.isManual).toBe(true);
    expect(config.projects.find(p => p.name === 'extension-manual')!.isManual).toBe(true);
    expect(config.projects.find(p => p.name === 'vendor-owner')!.isManual).toBe(false);
  });
});

// ============================================================================
// Persona map (buildPersonaLabel)
// ============================================================================

describe('personaMap', () => {
  it('should convert kebab-case roles to title case with parenthetical', () => {
    writeConfig(`
      export default defineConfig({
        projects: [
          { name: 'vendor-owner' },
          { name: 'vendor-admin' },
          { name: 'vendor-dev' },
          { name: 'vendor-viewer' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.personaMap['vendor-owner']).toBe('Vendor (Owner)');
    expect(config.personaMap['vendor-admin']).toBe('Vendor (Admin)');
    expect(config.personaMap['vendor-dev']).toBe('Vendor (Dev)');
    expect(config.personaMap['vendor-viewer']).toBe('Vendor (Viewer)');
  });

  it('should convert general kebab-case to title case', () => {
    writeConfig(`
      export default defineConfig({
        projects: [
          { name: 'cross-persona' },
          { name: 'auth-flows' },
          { name: 'demo' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.personaMap['cross-persona']).toBe('Cross Persona');
    expect(config.personaMap['auth-flows']).toBe('Auth Flows');
    expect(config.personaMap['demo']).toBe('Demo');
  });

  it('should exclude infrastructure projects from personaMap', () => {
    writeConfig(`
      export default defineConfig({
        projects: [
          { name: 'seed' },
          { name: 'auth-setup' },
          { name: 'main' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.personaMap).toEqual({ main: 'Main' });
  });
});

// ============================================================================
// Auth files
// ============================================================================

describe('authFiles', () => {
  it('should collect unique storageState paths', () => {
    writeConfig(`
      export default defineConfig({
        projects: [
          { name: 'a', use: { storageState: '.auth/a.json' } },
          { name: 'b', use: { storageState: '.auth/b.json' } },
          { name: 'c', use: { storageState: '.auth/a.json' } },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.authFiles).toEqual(['.auth/a.json', '.auth/b.json']);
  });

  it('should set primaryAuthFile to the first storageState', () => {
    writeConfig(`
      export default defineConfig({
        projects: [
          { name: 'main', use: { storageState: '.auth/main.json' } },
          { name: 'other' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.primaryAuthFile).toBe('.auth/main.json');
  });

  it('should return null primaryAuthFile when no storageState found', () => {
    writeConfig(`
      export default defineConfig({
        projects: [
          { name: 'basic' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.primaryAuthFile).toBeNull();
    expect(config.authFiles).toEqual([]);
  });
});

// ============================================================================
// Caching
// ============================================================================

describe('caching', () => {
  it('should return cached result for same projectDir', () => {
    writeConfig(`
      export default defineConfig({
        projects: [{ name: 'cached' }],
      });
    `);

    const config1 = discoverPlaywrightConfig(tempDir);
    // Modify the file — should still return cached version
    writeConfig(`
      export default defineConfig({
        projects: [{ name: 'changed' }],
      });
    `);
    const config2 = discoverPlaywrightConfig(tempDir);

    expect(config1).toBe(config2); // Same reference
    expect(config2.projects[0].name).toBe('cached');
  });

  it('should invalidate cache for different projectDir', () => {
    writeConfig(`
      export default defineConfig({
        projects: [{ name: 'first' }],
      });
    `);

    const config1 = discoverPlaywrightConfig(tempDir);

    const tempDir2 = `${tempDir}-2`;
    fs.mkdirSync(tempDir2, { recursive: true });
    fs.writeFileSync(path.join(tempDir2, 'playwright.config.ts'), `
      export default defineConfig({
        projects: [{ name: 'second' }],
      });
    `);

    const config2 = discoverPlaywrightConfig(tempDir2);
    expect(config2.projects[0].name).toBe('second');

    fs.rmSync(tempDir2, { recursive: true, force: true });
  });
});

// ============================================================================
// Complex config parsing
// ============================================================================

describe('complex config parsing', () => {
  it('should handle nested use: { ... } objects within project blocks', () => {
    writeConfig(`
      export default defineConfig({
        testDir: './e2e',
        projects: [
          {
            name: 'vendor-owner',
            testDir: 'e2e/vendor',
            use: {
              storageState: '.auth/vendor-owner.json',
              viewport: { width: 1280, height: 720 },
            },
          },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.projects).toHaveLength(1);
    expect(config.projects[0].name).toBe('vendor-owner');
    expect(config.projects[0].storageState).toBe('.auth/vendor-owner.json');
  });

  it('should handle projects = [...] syntax (variable assignment)', () => {
    writeConfig(`
      const projects = [
        { name: 'assigned' },
      ];
      export default defineConfig({ projects });
    `);

    // This won't match because the projects: [...] pattern expects the array inline.
    // But `projects = [...]` is matched by the regex.
    const config = discoverPlaywrightConfig(tempDir);

    expect(config.projects).toHaveLength(1);
    expect(config.projects[0].name).toBe('assigned');
  });

  it('should handle many projects (real-world-like config)', () => {
    writeConfig(`
      export default defineConfig({
        testDir: './e2e',
        projects: [
          { name: 'seed', testDir: 'e2e/seed' },
          { name: 'auth-setup', testDir: 'e2e/auth-setup', dependencies: ['seed'] },
          { name: 'vendor-owner', testDir: 'e2e/vendor', use: { storageState: '.auth/vendor-owner.json' } },
          { name: 'vendor-admin', testDir: 'e2e/vendor-roles', use: { storageState: '.auth/vendor-admin.json' } },
          { name: 'vendor-dev', testDir: 'e2e/vendor-roles', use: { storageState: '.auth/vendor-dev.json' } },
          { name: 'vendor-viewer', testDir: 'e2e/vendor-roles', use: { storageState: '.auth/vendor-viewer.json' } },
          { name: 'cross-persona', testDir: 'e2e/cross-persona' },
          { name: 'auth-flows', testDir: 'e2e/auth' },
          { name: 'manual', testDir: 'e2e/manual' },
          { name: 'extension', testDir: 'e2e/extension' },
          { name: 'extension-manual', testDir: 'e2e/extension/manual' },
          { name: 'demo', testDir: 'e2e/demo' },
        ],
      });
    `);

    const config = discoverPlaywrightConfig(tempDir);

    expect(config.projects).toHaveLength(12);
    expect(Object.keys(config.projectDirMap)).toHaveLength(10); // 12 - 2 infra
    expect(config.authFiles).toHaveLength(4);
    expect(config.extensionProjects.size).toBe(3); // extension, extension-manual, demo
  });
});
