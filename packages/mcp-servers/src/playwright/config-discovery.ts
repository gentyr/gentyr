/**
 * Playwright Config Discovery
 *
 * Reads playwright.config.ts (or .js) as raw text using regex parsing.
 * No require/import of the config — avoids TS compilation and side effects.
 *
 * Project discovery is automatic from playwright.config.ts.
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface DiscoveredProject {
  name: string;
  testDir: string | null;
  storageState: string | null;
  isInfrastructure: boolean;  // seed, auth-setup, cleanup, setup
  isManual: boolean;          // name === 'manual' or ends with '-manual'
  isExtension: boolean;       // name contains 'extension'
}

export interface PlaywrightConfig {
  projects: DiscoveredProject[];
  defaultTestDir: string;                    // top-level testDir or 'e2e'
  projectDirMap: Record<string, string>;     // non-infra project -> testDir
  personaMap: Record<string, string>;        // project -> human description
  extensionProjects: Set<string>;
  authFiles: string[];                       // storageState paths found
  primaryAuthFile: string | null;            // first storageState, or null
}

// ============================================================================
// Infrastructure project names
// ============================================================================

const INFRA_PROJECTS = new Set(['seed', 'auth-setup', 'cleanup', 'setup']);

// ============================================================================
// Module-level cache
// ============================================================================

let cachedConfig: PlaywrightConfig | null = null;
let cachedProjectDir: string | null = null;

// ============================================================================
// Parsing
// ============================================================================

/**
 * Find the `projects:` array region in the config text and extract
 * individual project object blocks.
 */
function extractProjectBlocks(configText: string): string[] {
  // Find the start of `projects:` or `projects =` array
  const projectsStart = configText.search(/projects\s*[:=]\s*\[/);
  if (projectsStart === -1) return [];

  // Find the opening bracket
  const bracketStart = configText.indexOf('[', projectsStart);
  if (bracketStart === -1) return [];

  // Brace-match to find the closing bracket
  let depth = 0;
  let arrayEnd = -1;
  for (let i = bracketStart; i < configText.length; i++) {
    const ch = configText[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        arrayEnd = i;
        break;
      }
    }
  }
  if (arrayEnd === -1) return [];

  const arrayContent = configText.slice(bracketStart + 1, arrayEnd);

  // Extract each top-level { ... } block within the array.
  // Handle nested objects (like `use: { ... }`) by brace-matching.
  const blocks: string[] = [];
  let blockStart = -1;
  let braceDepth = 0;

  for (let i = 0; i < arrayContent.length; i++) {
    const ch = arrayContent[i];
    if (ch === '{') {
      if (braceDepth === 0) blockStart = i;
      braceDepth++;
    } else if (ch === '}') {
      braceDepth--;
      if (braceDepth === 0 && blockStart !== -1) {
        blocks.push(arrayContent.slice(blockStart, i + 1));
        blockStart = -1;
      }
    }
  }

  return blocks;
}

/**
 * Extract a string value for a given key from a config block.
 * Handles both single and double quotes, and backtick template literals (simple cases).
 */
function extractStringValue(block: string, key: string): string | null {
  // Match: key: 'value' or key: "value" or key: `value`
  const regex = new RegExp(`${key}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`);
  const m = block.match(regex);
  return m ? m[1] : null;
}

/**
 * Parse a single project block into a DiscoveredProject.
 */
function parseProjectBlock(block: string): DiscoveredProject | null {
  const name = extractStringValue(block, 'name');
  if (!name) return null;

  const testDir = extractStringValue(block, 'testDir');
  const storageState = extractStringValue(block, 'storageState');

  return {
    name,
    testDir,
    storageState,
    isInfrastructure: INFRA_PROJECTS.has(name),
    isManual: name === 'manual' || name.endsWith('-manual'),
    isExtension: name.includes('extension'),
  };
}

/**
 * Extract the top-level testDir from the config.
 * Looks for `testDir: 'something'` outside of the projects array.
 */
function extractDefaultTestDir(configText: string): string {
  // Remove the projects array to avoid matching testDir inside project blocks
  const projectsStart = configText.search(/projects\s*[:=]\s*\[/);
  const textBeforeProjects = projectsStart > 0 ? configText.slice(0, projectsStart) : configText;

  const m = textBeforeProjects.match(/testDir\s*:\s*['"`]([^'"`]+)['"`]/);
  return m ? m[1].replace(/^\.\//, '') : 'e2e';
}

/**
 * Build a human-readable persona label from a project name.
 * kebab-case -> Title Case with parenthetical roles.
 *
 * Examples:
 *   vendor-owner -> Vendor (Owner)
 *   cross-persona -> Cross-Persona
 *   auth-flows -> Auth Flows
 *   extension-manual -> Extension Manual
 */
function buildPersonaLabel(name: string): string {
  // Check for role-style names like "vendor-owner", "vendor-admin"
  const roleMatch = name.match(/^(\w+)-(owner|admin|dev|developer|viewer)$/);
  if (roleMatch) {
    const base = roleMatch[1].charAt(0).toUpperCase() + roleMatch[1].slice(1);
    const role = roleMatch[2].charAt(0).toUpperCase() + roleMatch[2].slice(1);
    return `${base} (${role})`;
  }

  // General: kebab-case to Title Case
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Discover Playwright configuration by parsing the config file as raw text.
 * Returns empty config if the file doesn't exist or can't be parsed.
 *
 * **Caching**: Results are cached per projectDir for the lifetime of the process
 * (no TTL). If the config file is edited, the MCP server must be restarted to
 * pick up changes. Use {@link resetConfigCache} in tests.
 */
export function discoverPlaywrightConfig(projectDir: string): PlaywrightConfig {
  // Return cached result if same projectDir
  if (cachedConfig && cachedProjectDir === projectDir) {
    return cachedConfig;
  }

  const empty: PlaywrightConfig = {
    projects: [],
    defaultTestDir: 'e2e',
    projectDirMap: {},
    personaMap: {},
    extensionProjects: new Set(),
    authFiles: [],
    primaryAuthFile: null,
  };

  // Find config file
  const tsConfig = path.join(projectDir, 'playwright.config.ts');
  const jsConfig = path.join(projectDir, 'playwright.config.js');
  const configPath = fs.existsSync(tsConfig) ? tsConfig : (fs.existsSync(jsConfig) ? jsConfig : null);

  if (!configPath) {
    cachedConfig = empty;
    cachedProjectDir = projectDir;
    return empty;
  }

  let configText: string;
  try {
    configText = fs.readFileSync(configPath, 'utf8');
  } catch {
    cachedConfig = empty;
    cachedProjectDir = projectDir;
    return empty;
  }

  const defaultTestDir = extractDefaultTestDir(configText);
  const blocks = extractProjectBlocks(configText);
  const projects: DiscoveredProject[] = [];

  for (const block of blocks) {
    const project = parseProjectBlock(block);
    if (project) {
      projects.push(project);
    }
  }

  if (projects.length === 0) {
    cachedConfig = empty;
    cachedProjectDir = projectDir;
    return empty;
  }

  // Build derived maps
  const projectDirMap: Record<string, string> = {};
  const personaMap: Record<string, string> = {};
  const extensionProjects = new Set<string>();
  const authFiles: string[] = [];
  const seenAuthFiles = new Set<string>();

  for (const p of projects) {
    // projectDirMap: non-infrastructure projects only
    if (!p.isInfrastructure) {
      const dir = p.testDir ? p.testDir.replace(/^\.\//, '') : defaultTestDir;
      projectDirMap[p.name] = dir;
    }

    // personaMap for all non-infrastructure projects
    if (!p.isInfrastructure) {
      personaMap[p.name] = buildPersonaLabel(p.name);
    }

    // extension projects
    if (p.isExtension || p.name === 'demo') {
      extensionProjects.add(p.name);
    }

    // Collect unique auth files
    if (p.storageState && !seenAuthFiles.has(p.storageState)) {
      seenAuthFiles.add(p.storageState);
      authFiles.push(p.storageState);
    }
  }

  const primaryAuthFile = authFiles.length > 0 ? authFiles[0] : null;

  const config: PlaywrightConfig = {
    projects,
    defaultTestDir,
    projectDirMap,
    personaMap,
    extensionProjects,
    authFiles,
    primaryAuthFile,
  };

  cachedConfig = config;
  cachedProjectDir = projectDir;
  return config;
}

/**
 * Reset the module cache. Exposed for testing only.
 */
export function resetConfigCache(): void {
  cachedConfig = null;
  cachedProjectDir = null;
}
