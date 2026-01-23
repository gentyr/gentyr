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
import { McpServer, type ToolHandler } from '../shared/server.js';
import {
  ListSpecsArgsSchema,
  GetSpecArgsSchema,
  CATEGORY_INFO,
  SPEC_CATEGORIES,
  type ListSpecsArgs,
  type GetSpecArgs,
  type ListSpecsResult,
  type GetSpecResult,
  type GetSpecErrorResult,
  type SpecMetadata,
  type CategorySpecs,
  type SpecCategory,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const PROJECT_SPECS_DIR = path.join(PROJECT_DIR, 'specs');
const FRAMEWORK_SPECS_DIR = path.join(PROJECT_DIR, '.claude-framework', 'specs');

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

  const categoriesToProcess: SpecCategory[] = args.category
    ? [args.category]
    : [...SPEC_CATEGORIES];

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
          ? `.claude-framework/specs/${catInfo.path}`
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

  // Search in all categories (both project and framework)
  for (const catKey of SPEC_CATEGORIES) {
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
            ? `.claude-framework/specs/${catInfo.path}`
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

  return {
    error: `Spec not found: ${args.spec_id}`,
    hint: 'Use list_specs to see available specifications. Framework specs use F001-F005 prefixes.',
  };
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: ToolHandler[] = [
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
];

const server = new McpServer({
  name: 'specs-browser',
  version: '2.0.0',
  tools,
});

server.start();
