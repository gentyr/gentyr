/**
 * Unit tests for project-local MCP server preservation functions
 * in lib/shared-mcp-config.js.
 *
 * Tests: extractProjectServers, mergeProjectServers
 *
 * Run with: node --test .claude/hooks/__tests__/shared-mcp-config-merge.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractProjectServers, mergeProjectServers } from '../../../lib/shared-mcp-config.js';

describe('extractProjectServers', () => {
  it('identifies project-local servers not in the gentyr template', () => {
    const gentyrNames = new Set(['todo-db', 'agent-tracker', 'playwright']);
    const existing = {
      mcpServers: {
        'todo-db': { command: 'node', args: ['todo.js'] },
        'agent-tracker': { command: 'node', args: ['tracker.js'] },
        'my-postgres': { command: 'node', args: ['postgres-server.js'] },
        'my-docs': { command: 'node', args: ['docs-server.js'] },
      },
    };

    const result = extractProjectServers(gentyrNames, existing);
    assert.deepStrictEqual(Object.keys(result).sort(), ['my-docs', 'my-postgres']);
    assert.deepStrictEqual(result['my-postgres'], { command: 'node', args: ['postgres-server.js'] });
  });

  it('excludes plugin-manager as a dynamic gentyr server', () => {
    const gentyrNames = new Set(['todo-db']);
    const existing = {
      mcpServers: {
        'todo-db': { command: 'node', args: ['todo.js'] },
        'plugin-manager': { command: 'node', args: ['pm.js'] },
        'my-custom': { command: 'node', args: ['custom.js'] },
      },
    };

    const result = extractProjectServers(gentyrNames, existing);
    assert.deepStrictEqual(Object.keys(result), ['my-custom']);
  });

  it('excludes plugin-* prefixed servers as dynamic gentyr servers', () => {
    const gentyrNames = new Set(['todo-db']);
    const existing = {
      mcpServers: {
        'todo-db': { command: 'node', args: ['todo.js'] },
        'plugin-notion': { command: 'node', args: ['notion.js'] },
        'plugin-slack': { command: 'node', args: ['slack.js'] },
        'my-server': { command: 'node', args: ['server.js'] },
      },
    };

    const result = extractProjectServers(gentyrNames, existing);
    assert.deepStrictEqual(Object.keys(result), ['my-server']);
  });

  it('returns empty object when all servers are gentyr-managed', () => {
    const gentyrNames = new Set(['todo-db', 'playwright']);
    const existing = {
      mcpServers: {
        'todo-db': { command: 'node', args: ['todo.js'] },
        'playwright': { command: 'node', args: ['pw.js'] },
      },
    };

    const result = extractProjectServers(gentyrNames, existing);
    assert.deepStrictEqual(result, {});
  });

  it('returns empty object when existing config has no mcpServers', () => {
    const gentyrNames = new Set(['todo-db']);
    const result = extractProjectServers(gentyrNames, {});
    assert.deepStrictEqual(result, {});
  });

  it('returns empty object when existing config is null/undefined', () => {
    const gentyrNames = new Set(['todo-db']);
    assert.deepStrictEqual(extractProjectServers(gentyrNames, null), {});
    assert.deepStrictEqual(extractProjectServers(gentyrNames, undefined), {});
  });

  it('preserves full server config including env and type fields', () => {
    const gentyrNames = new Set(['todo-db']);
    const serverConfig = {
      type: 'http',
      url: 'http://localhost:9999/mcp/custom',
    };
    const existing = {
      mcpServers: {
        'todo-db': { command: 'node', args: ['todo.js'] },
        'my-http-server': serverConfig,
      },
    };

    const result = extractProjectServers(gentyrNames, existing);
    assert.deepStrictEqual(result['my-http-server'], serverConfig);
  });
});

describe('extractProjectServers — additional edge cases', () => {
  it('preserves all non-plugin servers when gentyrNames is an empty Set', () => {
    // If the template had no mcpServers, everything except plugin-* is a project server
    const gentyrNames = new Set();
    const existing = {
      mcpServers: {
        'my-server': { command: 'node', args: ['server.js'] },
        'plugin-notion': { command: 'node', args: ['notion.js'] },
      },
    };

    const result = extractProjectServers(gentyrNames, existing);
    assert.deepStrictEqual(Object.keys(result), ['my-server']);
  });

  it('handles a server with an empty config object without throwing', () => {
    const gentyrNames = new Set(['todo-db']);
    const existing = {
      mcpServers: {
        'todo-db': {},
        'my-server': {},
      },
    };

    const result = extractProjectServers(gentyrNames, existing);
    assert.deepStrictEqual(result, { 'my-server': {} });
  });
});

describe('mergeProjectServers', () => {
  it('adds project servers to the gentyr config', () => {
    const gentyrConfig = {
      mcpServers: {
        'todo-db': { command: 'node', args: ['todo.js'] },
      },
    };
    const projectServers = {
      'my-server': { command: 'node', args: ['server.js'] },
    };

    const merged = mergeProjectServers(gentyrConfig, projectServers);
    assert.strictEqual(merged, 1);
    assert.ok(gentyrConfig.mcpServers['my-server']);
    assert.deepStrictEqual(gentyrConfig.mcpServers['my-server'], { command: 'node', args: ['server.js'] });
  });

  it('does not overwrite gentyr servers on name collision', () => {
    const gentyrConfig = {
      mcpServers: {
        'todo-db': { command: 'node', args: ['gentyr-todo.js'] },
      },
    };
    const projectServers = {
      'todo-db': { command: 'node', args: ['project-todo.js'] },
      'my-server': { command: 'node', args: ['server.js'] },
    };

    const merged = mergeProjectServers(gentyrConfig, projectServers);
    assert.strictEqual(merged, 1); // only my-server, not todo-db
    assert.deepStrictEqual(gentyrConfig.mcpServers['todo-db'].args, ['gentyr-todo.js']);
    assert.ok(gentyrConfig.mcpServers['my-server']);
  });

  it('returns 0 when there are no project servers', () => {
    const gentyrConfig = { mcpServers: { 'todo-db': {} } };
    const merged = mergeProjectServers(gentyrConfig, {});
    assert.strictEqual(merged, 0);
  });

  it('creates mcpServers object if missing on gentyr config', () => {
    const gentyrConfig = {};
    const projectServers = {
      'my-server': { command: 'node', args: ['server.js'] },
    };

    const merged = mergeProjectServers(gentyrConfig, projectServers);
    assert.strictEqual(merged, 1);
    assert.ok(gentyrConfig.mcpServers['my-server']);
  });

  it('merges multiple project servers', () => {
    const gentyrConfig = { mcpServers: { 'todo-db': {} } };
    const projectServers = {
      'server-a': { command: 'node', args: ['a.js'] },
      'server-b': { command: 'node', args: ['b.js'] },
      'server-c': { type: 'http', url: 'http://localhost:5000' },
    };

    const merged = mergeProjectServers(gentyrConfig, projectServers);
    assert.strictEqual(merged, 3);
    assert.strictEqual(Object.keys(gentyrConfig.mcpServers).length, 4); // 1 gentyr + 3 project
  });
});
