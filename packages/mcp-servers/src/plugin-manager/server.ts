#!/usr/bin/env node
/**
 * Plugin Manager MCP Server
 *
 * Manages GENTYR local plugins. Only registered in .mcp.json when
 * CLAUDE_PROJECT_DIR resolves to the gentyr repo itself.
 *
 * Tools: list_plugins, get_plugin_config, set_plugin_config,
 *        add_plugin_mapping, remove_plugin_mapping
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  ListPluginsArgsSchema,
  GetPluginConfigArgsSchema,
  SetPluginConfigArgsSchema,
  AddPluginMappingArgsSchema,
  RemovePluginMappingArgsSchema,
  PluginConfigSchema,
  type ListPluginsArgs,
  type GetPluginConfigArgs,
  type SetPluginConfigArgs,
  type AddPluginMappingArgs,
  type RemovePluginMappingArgs,
  type ListPluginsResult,
  type PluginConfig,
  type ErrorResult,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const GENTYR_DIR = process.env.GENTYR_DIR || path.resolve(process.cwd());
const PLUGINS_DIR = path.join(GENTYR_DIR, 'plugins');

// ============================================================================
// Helper Functions
// ============================================================================

function readPluginConfig(plugin: string): PluginConfig | null {
  const configPath = path.join(PLUGINS_DIR, plugin, 'config.json');
  if (!fs.existsSync(configPath)) { return null; }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const result = PluginConfigSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function writePluginConfig(plugin: string, config: PluginConfig): void {
  const pluginDir = path.join(PLUGINS_DIR, plugin);
  fs.mkdirSync(pluginDir, { recursive: true });
  const configPath = path.join(pluginDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

function hasServer(plugin: string): boolean {
  return fs.existsSync(path.join(PLUGINS_DIR, plugin, 'dist', 'server.js'));
}

// ============================================================================
// Tool Implementations
// ============================================================================

function listPlugins(_args: ListPluginsArgs): ListPluginsResult | ErrorResult {
  if (!fs.existsSync(PLUGINS_DIR)) {
    return { plugins: [] };
  }

  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  const plugins = entries
    .filter(e => e.isDirectory())
    .map(e => {
      const config = readPluginConfig(e.name);
      return {
        name: e.name,
        enabled: config?.enabled ?? false,
        mappings: config?.mappings.length ?? 0,
        hasServer: hasServer(e.name),
      };
    });

  return { plugins };
}

function getPluginConfig(args: GetPluginConfigArgs): PluginConfig | ErrorResult {
  const config = readPluginConfig(args.plugin);
  if (!config) {
    return { error: `Plugin "${args.plugin}" not found or has invalid config.json` };
  }
  return config;
}

function setPluginConfig(args: SetPluginConfigArgs): { success: true } | ErrorResult {
  try {
    writePluginConfig(args.plugin, args.config);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

function addPluginMapping(args: AddPluginMappingArgs): { success: true; created: boolean } | ErrorResult {
  try {
    const existing = readPluginConfig(args.plugin);
    if (!existing) {
      return { error: `Plugin "${args.plugin}" not found — create config.json first via set_plugin_config` };
    }

    const idx = existing.mappings.findIndex(m => m.projectDir === args.mapping.projectDir);
    const created = idx === -1;

    if (created) {
      existing.mappings.push(args.mapping);
    } else {
      existing.mappings[idx] = { ...existing.mappings[idx], ...args.mapping };
    }

    writePluginConfig(args.plugin, existing);
    return { success: true, created };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

function removePluginMapping(args: RemovePluginMappingArgs): { success: true; removed: boolean } | ErrorResult {
  try {
    const existing = readPluginConfig(args.plugin);
    if (!existing) {
      return { error: `Plugin "${args.plugin}" not found` };
    }

    const before = existing.mappings.length;
    existing.mappings = existing.mappings.filter(m => m.projectDir !== args.projectDir);
    const removed = existing.mappings.length < before;

    writePluginConfig(args.plugin, existing);
    return { success: true, removed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'list_plugins',
    description: 'List all installed plugins in the plugins/ directory with their status.',
    schema: ListPluginsArgsSchema,
    handler: listPlugins,
  },
  {
    name: 'get_plugin_config',
    description: 'Read the config.json for a specific plugin.',
    schema: GetPluginConfigArgsSchema,
    handler: getPluginConfig,
  },
  {
    name: 'set_plugin_config',
    description: 'Write (replace) the config.json for a plugin. Use add_plugin_mapping for upsert operations.',
    schema: SetPluginConfigArgsSchema,
    handler: setPluginConfig,
  },
  {
    name: 'add_plugin_mapping',
    description: 'Add or update a per-project mapping in a plugin\'s config (upsert by projectDir).',
    schema: AddPluginMappingArgsSchema,
    handler: addPluginMapping,
  },
  {
    name: 'remove_plugin_mapping',
    description: 'Remove a per-project mapping from a plugin\'s config by projectDir.',
    schema: RemovePluginMappingArgsSchema,
    handler: removePluginMapping,
  },
];

const server = new McpServer({
  name: 'plugin-manager',
  version: '1.0.0',
  tools,
});

server.start();
