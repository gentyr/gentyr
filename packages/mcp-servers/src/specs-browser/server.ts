#!/usr/bin/env node
/**
 * Specs Browser MCP Server
 *
 * Provides tools to browse and read project specification files.
 * Specs define architectural constraints and invariants that all code must follow.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 2.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import { resolveFrameworkDir, resolveFrameworkRelative } from '../shared/resolve-framework.js';
import {
  ListSpecsArgsSchema,
  GetSpecArgsSchema,
  CreateSpecSchema,
  EditSpecSchema,
  DeleteSpecSchema,
  CreateSuiteSchema,
  GetSuiteSchema,
  ListSuitesSchema,
  EditSuiteSchema,
  DeleteSuiteSchema,
  GetSpecsForFileSchema,
  FRAMEWORK_CATEGORY_INFO,
  DEFAULT_PROJECT_CATEGORY_INFO,
  SpecsConfigSchema,
  type ListSpecsArgs,
  type GetSpecArgs,
  type CreateSpecArgs,
  type EditSpecArgs,
  type DeleteSpecArgs,
  type CreateSuiteArgs,
  type GetSuiteArgs,
  type EditSuiteArgs,
  type DeleteSuiteArgs,
  type GetSpecsForFileArgs,
  type ListSpecsResult,
  type GetSpecResult,
  type GetSpecErrorResult,
  type CreateSpecResult,
  type EditSpecResult,
  type DeleteSpecResult,
  type CreateSuiteResult,
  type GetSuiteResult,
  type ListSuitesResult,
  type EditSuiteResult,
  type DeleteSuiteResult,
  type GetSpecsForFileResult,
  type SpecForFile,
  type SubspecForFile,
  type SpecMetadata,
  type CategorySpecs,
  type CategoryInfoItem,
  type SuitesConfig,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const PROJECT_SPECS_DIR = path.join(PROJECT_DIR, 'specs');
const _fwDir = resolveFrameworkDir(PROJECT_DIR);
const _fwRel = resolveFrameworkRelative(PROJECT_DIR);
const FRAMEWORK_SPECS_DIR = _fwDir
  ? path.join(_fwDir, 'specs')
  : path.join(PROJECT_DIR, '.claude-framework', 'specs');
const CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'specs-config.json');
const SUITES_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'hooks', 'suites-config.json');
const MAPPING_FILE_PATH = path.join(PROJECT_DIR, '.claude', 'hooks', 'spec-file-mappings.json');

// ============================================================================
// Category Loading
// ============================================================================

/**
 * Load categories from framework defaults + project config
 * Merges: framework categories + default project categories + custom project categories
 */
function loadCategories(): Record<string, CategoryInfoItem> {
  const categories: Record<string, CategoryInfoItem> = {
    // Framework categories (always available)
    ...FRAMEWORK_CATEGORY_INFO,
    // Default project categories
    ...DEFAULT_PROJECT_CATEGORY_INFO,
  };

  // Load project-specific additions from .claude/specs-config.json
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const config = SpecsConfigSchema.parse(JSON.parse(raw));

      for (const [key, value] of Object.entries(config.categories)) {
        categories[key] = {
          path: value.path,
          description: value.description,
          source: 'project',
          prefix: value.prefix,
        };
      }
    } catch (err) {
      // G001: Log error but continue with defaults
      console.error(`[specs-browser] Failed to load config from ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return categories;
}

// Load categories at startup
const CATEGORY_INFO = loadCategories();

/**
 * Get the specs directory for a category based on its source
 */
function getSpecsDir(catInfo: { source: 'project' | 'framework'; path: string }): string {
  const baseDir = catInfo.source === 'framework' ? FRAMEWORK_SPECS_DIR : PROJECT_SPECS_DIR;
  return path.join(baseDir, catInfo.path);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse spec file metadata from content
 */
function parseSpecMetadata(content: string, filename: string): SpecMetadata {
  const lines = content.split('\n');
  const metadata: SpecMetadata = {
    title: filename.replace('.md', ''),
    ruleId: null,
    severity: null,
    category: null,
    lastUpdated: null,
  };

  // Extract first heading as title
  for (const line of lines) {
    if (line.startsWith('# ')) {
      metadata.title = line.substring(2).trim();
      break;
    }
  }

  // Extract metadata fields
  for (const line of lines) {
    if (line.startsWith('**Rule ID**:')) {
      metadata.ruleId = line.replace('**Rule ID**:', '').trim();
    } else if (line.startsWith('**Severity**:')) {
      metadata.severity = line.replace('**Severity**:', '').trim();
    } else if (line.startsWith('**Category**:')) {
      metadata.category = line.replace('**Category**:', '').trim();
    } else if (line.startsWith('**Last Updated**:')) {
      metadata.lastUpdated = line.replace('**Last Updated**:', '').trim();
    }
  }

  return metadata;
}

// ============================================================================
// Suite Config Loading
// ============================================================================

/**
 * Load suites config from suites-config.json
 * Returns null if file doesn't exist (optional feature)
 */
function loadSuitesConfig(): SuitesConfig | null {
  if (!fs.existsSync(SUITES_CONFIG_PATH)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(SUITES_CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`[specs-browser] Failed to load suites-config.json: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Save suites config to suites-config.json
 */
function saveSuitesConfig(config: SuitesConfig): void {
  // Ensure directory exists
  const dir = path.dirname(SUITES_CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SUITES_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Simple glob pattern matching
 * Supports: *, **, ?
 */
function matchesGlob(filePath: string, pattern: string): boolean {
  // Convert glob pattern to regex
  let regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars
    .replace(/\*\*/g, '{{DOUBLESTAR}}')     // Placeholder for **
    .replace(/\*/g, '[^/]*')                // * matches anything except /
    .replace(/\?/g, '[^/]')                 // ? matches single char except /
    .replace(/\{\{DOUBLESTAR\}\}/g, '.*');  // ** matches everything

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(filePath);
}

/**
 * Load spec-file-mappings.json
 */
interface SpecFileMappings {
  specs: Record<string, {
    priority: string;
    files: Array<{
      path: string;
      lastVerified: string | null;
    }>;
  }>;
}

function loadSpecFileMappings(): SpecFileMappings | null {
  if (!fs.existsSync(MAPPING_FILE_PATH)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(MAPPING_FILE_PATH, 'utf8'));
  } catch (err) {
    console.error(`[specs-browser] Failed to load spec-file-mappings.json: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * List all specs, optionally filtered by category
 */
function listSpecs(args: ListSpecsArgs): ListSpecsResult {
  const result: ListSpecsResult = {
    categories: {},
    total: 0,
  };

  // Get available categories from loaded config
  const availableCategories = Object.keys(CATEGORY_INFO);

  // Runtime validation: check if category is valid
  if (args.category && !availableCategories.includes(args.category)) {
    throw new Error(
      `Unknown category: "${args.category}". Available: ${availableCategories.join(', ')}`
    );
  }

  const categoriesToProcess: string[] = args.category
    ? [args.category]
    : availableCategories;

  for (const catKey of categoriesToProcess) {
    const catInfo = CATEGORY_INFO[catKey];
    const catDir = getSpecsDir(catInfo);

    const categoryResult: CategorySpecs = {
      description: catInfo.description,
      specs: [],
    };

    // Check if directory exists (G001: file-not-found vs corruption)
    if (!fs.existsSync(catDir)) {
      result.categories[catKey] = categoryResult;
      continue;
    }

    try {
      const files = fs.readdirSync(catDir)
        .filter(f => f.endsWith('.md'))
        .sort();

      for (const file of files) {
        const filePath = path.join(catDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const metadata = parseSpecMetadata(content, file);

        const specId = file.replace('.md', '');
        // Use appropriate base path based on source
        const basePath = catInfo.source === 'framework'
          ? `${_fwRel}/specs/${catInfo.path}`
          : `specs/${catInfo.path}`;
        categoryResult.specs.push({
          spec_id: specId,
          title: metadata.title,
          severity: metadata.severity,
          rule_id: metadata.ruleId,
          file: `${basePath}/${file}`,
        });
        result.total++;
      }
    } catch (err) {
      // G001: Report errors instead of silent ignore
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read specs directory ${catDir}: ${message}`);
    }

    result.categories[catKey] = categoryResult;
  }

  return result;
}

/**
 * Get a single spec by ID
 */
function getSpec(args: GetSpecArgs): GetSpecResult | GetSpecErrorResult {
  const specId = args.spec_id.toUpperCase();

  // Search in all categories (framework + project + custom)
  for (const catKey of Object.keys(CATEGORY_INFO)) {
    const catInfo = CATEGORY_INFO[catKey];
    const catDir = getSpecsDir(catInfo);

    // Skip non-existent directories
    if (!fs.existsSync(catDir)) {continue;}

    try {
      const files = fs.readdirSync(catDir);

      for (const file of files) {
        const fileId = file.replace('.md', '').toUpperCase();

        // Match exact ID or file starting with ID-
        if (fileId === specId || file.toUpperCase().startsWith(`${specId}-`)) {
          const filePath = path.join(catDir, file);
          const content = fs.readFileSync(filePath, 'utf8');
          const metadata = parseSpecMetadata(content, file);

          // Use appropriate base path based on source
          const basePath = catInfo.source === 'framework'
            ? `${_fwRel}/specs/${catInfo.path}`
            : `specs/${catInfo.path}`;

          return {
            spec_id: file.replace('.md', ''),
            category: catKey,
            file: `${basePath}/${file}`,
            title: metadata.title,
            severity: metadata.severity,
            rule_id: metadata.ruleId,
            last_updated: metadata.lastUpdated,
            content,
          };
        }
      }
    } catch (err) {
      // G001: Report read errors
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to search specs directory ${catDir}: ${message}`);
    }
  }

  const availableCategories = Object.keys(CATEGORY_INFO).join(', ');
  return {
    error: `Spec not found: ${args.spec_id}`,
    hint: `Use list_specs to see available specifications. Categories: ${availableCategories}`,
  };
}

/**
 * Create a new spec file
 */
function createSpec(args: CreateSpecArgs): CreateSpecResult {
  const { spec_id, category, suite, title, content } = args;

  let targetDir: string;
  let basePath: string;

  if (suite) {
    // Creating in a suite's spec dir
    const suitesConfig = loadSuitesConfig();
    if (!suitesConfig?.suites?.[suite]) {
      throw new Error(`Suite not found: ${suite}`);
    }
    const suiteConfig = suitesConfig.suites[suite];
    const specDir = suiteConfig.mappedSpecs?.dir || `specs/suites/${suite}`;
    targetDir = path.join(PROJECT_DIR, specDir);
    basePath = specDir;
  } else {
    // Creating in main category
    const catInfo = CATEGORY_INFO[category];
    if (!catInfo) {
      throw new Error(`Unknown category: ${category}. Available: ${Object.keys(CATEGORY_INFO).join(', ')}`);
    }
    targetDir = getSpecsDir(catInfo);
    basePath = catInfo.source === 'framework'
      ? `${_fwRel}/specs/${catInfo.path}`
      : `specs/${catInfo.path}`;
  }

  // Create directory if needed
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const filename = `${spec_id}.md`;
  const filepath = path.join(targetDir, filename);

  if (fs.existsSync(filepath)) {
    throw new Error(`Spec already exists: ${spec_id}`);
  }

  // Build content with title as header
  const fullContent = `# ${title}\n\n${content}`;
  fs.writeFileSync(filepath, fullContent, 'utf8');

  return { success: true, file: `${basePath}/${filename}` };
}

/**
 * Edit an existing spec file
 */
function editSpec(args: EditSpecArgs): EditSpecResult {
  // Find spec across all categories and suites
  const result = getSpec({ spec_id: args.spec_id });
  if ('error' in result) {
    throw new Error(result.error);
  }

  const filepath = path.join(PROJECT_DIR, result.file);
  let newContent: string;

  if (args.content) {
    // Full replacement
    newContent = args.content;
  } else if (args.append) {
    // Append to existing
    newContent = result.content + '\n' + args.append;
  } else if (args.title) {
    // Update title only
    newContent = result.content.replace(/^# .+$/m, `# ${args.title}`);
  } else {
    throw new Error('Must provide content, append, or title');
  }

  fs.writeFileSync(filepath, newContent, 'utf8');
  return { success: true, file: result.file };
}

/**
 * Delete a spec file
 */
function deleteSpec(args: DeleteSpecArgs): DeleteSpecResult {
  if (!args.confirm) {
    throw new Error('Must set confirm: true to delete');
  }

  const result = getSpec({ spec_id: args.spec_id });
  if ('error' in result) {
    throw new Error(result.error);
  }

  const filepath = path.join(PROJECT_DIR, result.file);
  fs.unlinkSync(filepath);

  return { success: true, deleted: result.file };
}

/**
 * List all configured suites
 */
function listSuites(): ListSuitesResult {
  const config = loadSuitesConfig();
  if (!config) {
    return { suites: [] };
  }

  return {
    suites: Object.entries(config.suites).map(([id, suite]) => ({
      id,
      description: suite.description,
      scope: suite.scope,
      enabled: suite.enabled ?? true,
    })),
  };
}

/**
 * Get details of a specific suite
 */
function getSuite(args: GetSuiteArgs): GetSuiteResult {
  const config = loadSuitesConfig();
  if (!config?.suites?.[args.suite_id]) {
    throw new Error(`Suite not found: ${args.suite_id}`);
  }

  const suite = config.suites[args.suite_id];
  return {
    suite_id: args.suite_id,
    description: suite.description,
    scope: suite.scope,
    mappedSpecs: suite.mappedSpecs,
    exploratorySpecs: suite.exploratorySpecs,
    enabled: suite.enabled ?? true,
  };
}

/**
 * Create a new suite
 */
function createSuite(args: CreateSuiteArgs): CreateSuiteResult {
  let config = loadSuitesConfig() || { version: 1, suites: {} };

  if (config.suites[args.suite_id]) {
    throw new Error(`Suite already exists: ${args.suite_id}`);
  }

  config.suites[args.suite_id] = {
    description: args.description,
    scope: args.scope,
    mappedSpecs: args.mapped_specs_dir ? {
      dir: args.mapped_specs_dir,
      pattern: args.mapped_specs_pattern || '*.md',
    } : null,
    exploratorySpecs: args.exploratory_specs_dir ? {
      dir: args.exploratory_specs_dir,
      pattern: args.exploratory_specs_pattern || '*.md',
    } : null,
    enabled: true,
  };

  // Create directories if specified
  if (args.mapped_specs_dir) {
    const dir = path.join(PROJECT_DIR, args.mapped_specs_dir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  if (args.exploratory_specs_dir) {
    const dir = path.join(PROJECT_DIR, args.exploratory_specs_dir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  saveSuitesConfig(config);
  return { success: true, suite_id: args.suite_id };
}

/**
 * Edit an existing suite
 */
function editSuite(args: EditSuiteArgs): EditSuiteResult {
  const config = loadSuitesConfig();
  if (!config?.suites?.[args.suite_id]) {
    throw new Error(`Suite not found: ${args.suite_id}`);
  }

  const suite = config.suites[args.suite_id];

  // Update fields that were provided
  if (args.description !== undefined) {
    suite.description = args.description;
  }
  if (args.scope !== undefined) {
    suite.scope = args.scope;
  }
  if (args.enabled !== undefined) {
    suite.enabled = args.enabled;
  }

  // Handle mappedSpecs updates
  if (args.mapped_specs_dir !== undefined) {
    if (args.mapped_specs_dir) {
      suite.mappedSpecs = {
        dir: args.mapped_specs_dir,
        pattern: args.mapped_specs_pattern || suite.mappedSpecs?.pattern || '*.md',
      };
      // Create directory if it doesn't exist
      const dir = path.join(PROJECT_DIR, args.mapped_specs_dir);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } else {
      suite.mappedSpecs = null;
    }
  } else if (args.mapped_specs_pattern !== undefined && suite.mappedSpecs) {
    suite.mappedSpecs.pattern = args.mapped_specs_pattern;
  }

  // Handle exploratorySpecs updates
  if (args.exploratory_specs_dir !== undefined) {
    if (args.exploratory_specs_dir) {
      suite.exploratorySpecs = {
        dir: args.exploratory_specs_dir,
        pattern: args.exploratory_specs_pattern || suite.exploratorySpecs?.pattern || '*.md',
      };
      // Create directory if it doesn't exist
      const dir = path.join(PROJECT_DIR, args.exploratory_specs_dir);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } else {
      suite.exploratorySpecs = null;
    }
  } else if (args.exploratory_specs_pattern !== undefined && suite.exploratorySpecs) {
    suite.exploratorySpecs.pattern = args.exploratory_specs_pattern;
  }

  saveSuitesConfig(config);
  return { success: true, suite_id: args.suite_id };
}

/**
 * Delete a suite (does not delete specs, just the config)
 */
function deleteSuite(args: DeleteSuiteArgs): DeleteSuiteResult {
  if (!args.confirm) {
    throw new Error('Must set confirm: true to delete');
  }

  const config = loadSuitesConfig();
  if (!config?.suites?.[args.suite_id]) {
    throw new Error(`Suite not found: ${args.suite_id}`);
  }

  delete config.suites[args.suite_id];
  saveSuitesConfig(config);

  return { success: true, deleted: args.suite_id };
}

/**
 * Get all specs (main and subspecs) that apply to a file
 */
function getSpecsForFile(args: GetSpecsForFileArgs): GetSpecsForFileResult {
  let filePath = args.file_path;

  // Normalize to relative path
  if (path.isAbsolute(filePath)) {
    filePath = path.relative(PROJECT_DIR, filePath);
  }

  // Remove leading ./ if present
  if (filePath.startsWith('./')) {
    filePath = filePath.slice(2);
  }

  const specs: SpecForFile[] = [];
  const subspecs: SubspecForFile[] = [];

  // 1. Find main specs from spec-file-mappings.json
  const mappings = loadSpecFileMappings();
  if (mappings) {
    for (const [specName, specData] of Object.entries(mappings.specs || {})) {
      const fileEntry = specData.files?.find(f => f.path === filePath);
      if (fileEntry) {
        specs.push({
          spec_id: specName.replace('.md', ''),
          file: `specs/global/${specName}`,
          priority: specData.priority,
          lastVerified: fileEntry.lastVerified,
        });
      }
    }
  }

  // 2. Find subspecs from matching suites
  const suitesConfig = loadSuitesConfig();
  if (suitesConfig) {
    for (const [suiteId, suite] of Object.entries(suitesConfig.suites)) {
      if (!suite.enabled) continue;

      // Check if file matches suite scope
      if (matchesGlob(filePath, suite.scope)) {
        // Get specs from this suite's mappedSpecs directory
        if (suite.mappedSpecs) {
          const specsDir = path.join(PROJECT_DIR, suite.mappedSpecs.dir);
          if (fs.existsSync(specsDir)) {
            const pattern = suite.mappedSpecs.pattern || '*.md';
            const specFiles = fs.readdirSync(specsDir).filter(f => {
              if (!f.endsWith('.md')) return false;
              return matchesGlob(f, pattern);
            });

            for (const specFile of specFiles) {
              subspecs.push({
                spec_id: specFile.replace('.md', ''),
                file: `${suite.mappedSpecs.dir}/${specFile}`,
                suite_id: suiteId,
                suite_scope: suite.scope,
                priority: 'medium',
              });
            }
          }
        }

        // Also include exploratory specs that would apply
        if (suite.exploratorySpecs) {
          const specsDir = path.join(PROJECT_DIR, suite.exploratorySpecs.dir);
          if (fs.existsSync(specsDir)) {
            const pattern = suite.exploratorySpecs.pattern || '*.md';
            const specFiles = fs.readdirSync(specsDir).filter(f => {
              if (!f.endsWith('.md')) return false;
              return matchesGlob(f, pattern);
            });

            for (const specFile of specFiles) {
              subspecs.push({
                spec_id: specFile.replace('.md', ''),
                file: `${suite.exploratorySpecs.dir}/${specFile}`,
                suite_id: suiteId,
                suite_scope: suite.scope,
                priority: 'medium',
              });
            }
          }
        }
      }
    }
  }

  return {
    file_path: filePath,
    specs,
    subspecs,
    total: specs.length + subspecs.length,
  };
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  // Existing tools
  {
    name: 'list_specs',
    description: 'List all specification files organized by category. Returns spec IDs, titles, and categories.',
    schema: ListSpecsArgsSchema,
    handler: listSpecs,
  },
  {
    name: 'get_spec',
    description: 'Get the full content of a specification file. Use spec_id from list_specs.',
    schema: GetSpecArgsSchema,
    handler: getSpec,
  },
  // Spec management tools
  {
    name: 'create_spec',
    description: 'Create a new spec file in a category or suite. Creates directories if needed.',
    schema: CreateSpecSchema,
    handler: createSpec,
  },
  {
    name: 'edit_spec',
    description: 'Edit an existing spec file. Supports full replacement, title update, or appending content.',
    schema: EditSpecSchema,
    handler: editSpec,
  },
  {
    name: 'delete_spec',
    description: 'Delete a spec file. Requires confirm: true to proceed.',
    schema: DeleteSpecSchema,
    handler: deleteSpec,
  },
  // Suite management tools
  {
    name: 'list_suites',
    description: 'List all configured spec suites. Returns empty array if no suites-config.json exists.',
    schema: ListSuitesSchema,
    handler: listSuites,
  },
  {
    name: 'get_suite',
    description: 'Get full details of a spec suite including mappedSpecs and exploratorySpecs configuration.',
    schema: GetSuiteSchema,
    handler: getSuite,
  },
  {
    name: 'create_suite',
    description: 'Create a new spec suite for a directory pattern. Creates suites-config.json if needed.',
    schema: CreateSuiteSchema,
    handler: createSuite,
  },
  {
    name: 'edit_suite',
    description: 'Edit an existing suite configuration. Only updates specified fields.',
    schema: EditSuiteSchema,
    handler: editSuite,
  },
  {
    name: 'delete_suite',
    description: 'Delete a suite from config. Does not delete the spec files, just the suite configuration.',
    schema: DeleteSuiteSchema,
    handler: deleteSuite,
  },
  // Utility tools
  {
    name: 'get_specs_for_file',
    description: 'Find all specs that apply to a specific file. Returns main specs (from spec-file-mappings.json) and subspecs (from matching suites). Accepts relative or absolute paths.',
    schema: GetSpecsForFileSchema,
    handler: getSpecsForFile,
  },
];

const server = new McpServer({
  name: 'specs-browser',
  version: '2.0.0',
  tools,
});

server.start();
