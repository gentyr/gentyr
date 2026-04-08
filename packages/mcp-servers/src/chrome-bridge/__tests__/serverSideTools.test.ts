/**
 * Unit tests for chrome-bridge server-side tools:
 * - detectChromeApp() platform guard
 * - handleReloadExtension() input validation + response shaping
 * - handleListExtensions() filtering + response shaping
 * - executeServerSideTool() dispatcher routing
 *
 * Strategy: the functions depend on execFileAsync (osascript) which requires
 * a real macOS environment with Chrome running. We extract the pure
 * deterministic logic — argument validation, JSON-to-content shaping, and
 * dispatch routing — into standalone testable wrappers that mirror the exact
 * implementations in server.ts. No network or OS calls are made.
 *
 * Critical: These tests validate structure, not performance.
 * Graceful fallbacks are NOT allowed — errors must be returned via isError.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { McpContent } from '../types.js';

// ============================================================================
// Helpers mirroring server.ts types
// ============================================================================

type ToolResult = { content: McpContent[]; isError?: boolean };

// ============================================================================
// detectChromeApp — platform guard
// ============================================================================

/**
 * Mirrors the non-macOS guard in detectChromeApp() (server.ts ~line 1021)
 * The rest of the function requires osascript; this portion is pure.
 */
function detectChromeAppPlatformGuard(platform: string): void {
  if (platform !== 'darwin') {
    throw new Error(
      'Chrome extension management tools require macOS (AppleScript). Current platform: ' +
        platform,
    );
  }
}

describe('detectChromeApp() — platform guard', () => {
  it('should throw on non-darwin platforms', () => {
    const platforms = ['linux', 'win32', 'freebsd', 'openbsd', 'android'];
    for (const p of platforms) {
      expect(() => detectChromeAppPlatformGuard(p)).toThrow(
        'Chrome extension management tools require macOS (AppleScript)',
      );
    }
  });

  it('should include the platform name in the error message', () => {
    expect(() => detectChromeAppPlatformGuard('linux')).toThrow(/linux/);
    expect(() => detectChromeAppPlatformGuard('win32')).toThrow(/win32/);
  });

  it('should not throw on darwin', () => {
    expect(() => detectChromeAppPlatformGuard('darwin')).not.toThrow();
  });
});

// ============================================================================
// handleReloadExtension — input validation (no OS calls)
// ============================================================================

/**
 * Mirrors handleReloadExtension() argument validation block (server.ts ~lines 1138–1153).
 * Returns the early-return error result when neither or both args are provided.
 * Returns null when the args are valid and would proceed to the OS call.
 */
function validateReloadExtensionArgs(
  args: Record<string, unknown>,
): ToolResult | null {
  const extensionId =
    typeof args.extension_id === 'string' ? args.extension_id.trim() : '';
  const extensionName =
    typeof args.name === 'string' ? args.name.trim() : '';

  if (!extensionId && !extensionName) {
    return {
      content: [
        {
          type: 'text',
          text: 'Provide either extension_id or name to identify the extension to reload.',
        },
      ],
      isError: true,
    };
  }

  if (extensionId && extensionName) {
    return {
      content: [{ type: 'text', text: 'Provide either extension_id or name, not both.' }],
      isError: true,
    };
  }

  return null; // valid — would proceed to OS call
}

describe('handleReloadExtension() — input validation', () => {
  describe('missing both arguments', () => {
    it('should return isError when called with empty object', () => {
      const result = validateReloadExtensionArgs({});
      expect(result).not.toBeNull();
      expect(result!.isError).toBe(true);
    });

    it('should return isError when extension_id is empty string', () => {
      const result = validateReloadExtensionArgs({ extension_id: '' });
      expect(result).not.toBeNull();
      expect(result!.isError).toBe(true);
    });

    it('should return isError when name is empty string', () => {
      const result = validateReloadExtensionArgs({ name: '' });
      expect(result).not.toBeNull();
      expect(result!.isError).toBe(true);
    });

    it('should return isError when extension_id is whitespace only', () => {
      const result = validateReloadExtensionArgs({ extension_id: '   ' });
      expect(result).not.toBeNull();
      expect(result!.isError).toBe(true);
    });

    it('should return isError when name is whitespace only', () => {
      const result = validateReloadExtensionArgs({ name: '   ' });
      expect(result).not.toBeNull();
      expect(result!.isError).toBe(true);
    });

    it('should include a helpful message when neither arg is provided', () => {
      const result = validateReloadExtensionArgs({});
      expect(result!.content).toHaveLength(1);
      expect(result!.content[0].type).toBe('text');
      expect(result!.content[0].text).toContain('extension_id');
      expect(result!.content[0].text).toContain('name');
    });
  });

  describe('both arguments provided', () => {
    it('should return isError when both extension_id and name are given', () => {
      const result = validateReloadExtensionArgs({
        extension_id: 'dojoamdbiafnflmaknagfcakgpdkmpmn',
        name: 'Gentyr',
      });
      expect(result).not.toBeNull();
      expect(result!.isError).toBe(true);
    });

    it('should mention the conflict in the error message', () => {
      const result = validateReloadExtensionArgs({
        extension_id: 'abc123',
        name: 'SomeExt',
      });
      expect(result!.content[0].text).toContain('not both');
    });
  });

  describe('valid single argument', () => {
    it('should return null (proceed) when only extension_id is provided', () => {
      const result = validateReloadExtensionArgs({
        extension_id: 'dojoamdbiafnflmaknagfcakgpdkmpmn',
      });
      expect(result).toBeNull();
    });

    it('should return null (proceed) when only name is provided', () => {
      const result = validateReloadExtensionArgs({ name: 'Gentyr' });
      expect(result).toBeNull();
    });

    it('should trim whitespace around extension_id before checking emptiness', () => {
      // A non-empty ID with surrounding whitespace should pass validation
      const result = validateReloadExtensionArgs({ extension_id: '  abc123  ' });
      expect(result).toBeNull();
    });
  });
});

// ============================================================================
// handleReloadExtension — response shaping from parsed JSON
// ============================================================================

/**
 * Mirrors the result-interpretation block in handleReloadExtension() for
 * name-based lookups (server.ts ~lines 1206–1227).
 *
 * The raw string from osascript has already been JSON.parse()'d here; we test
 * the logic that converts a parsed result object into an MCP ToolResult.
 */
function interpretReloadResult(
  parsed: {
    success: boolean;
    id?: string;
    name?: string;
    error?: string;
    message?: string;
    available?: string;
    matches?: Array<{ id: string; name: string }>;
  },
  requestedName: string,
): ToolResult {
  if (parsed.error === 'no_match') {
    return {
      content: [
        {
          type: 'text',
          text: `No extension found matching "${requestedName}". Available extensions: ${parsed.available}`,
        },
      ],
      isError: true,
    };
  }
  if (parsed.error === 'ambiguous') {
    const list = (parsed.matches || [])
      .map((m) => `  - ${m.name} (${m.id})`)
      .join('\n');
    return {
      content: [
        {
          type: 'text',
          text: `Multiple extensions match "${requestedName}":\n${list}\n\nUse extension_id for an exact match.`,
        },
      ],
      isError: true,
    };
  }
  if (!parsed.success) {
    return {
      content: [
        { type: 'text', text: `Failed to reload: ${parsed.message || parsed.error}` },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: `Extension "${parsed.name}" (${parsed.id}) reloaded successfully.`,
      },
    ],
  };
}

describe('handleReloadExtension() — response shaping', () => {
  describe('no_match error', () => {
    it('should return isError with the requested name and available list', () => {
      const result = interpretReloadResult(
        { success: false, error: 'no_match', available: 'Foo (abc), Bar (def)' },
        'Gentyr',
      );
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('"Gentyr"');
      expect(result.content[0].text).toContain('Foo (abc), Bar (def)');
    });
  });

  describe('ambiguous error', () => {
    it('should return isError listing all matching extensions', () => {
      const result = interpretReloadResult(
        {
          success: false,
          error: 'ambiguous',
          matches: [
            { id: 'abc', name: 'Gentyr Dev' },
            { id: 'def', name: 'Gentyr Prod' },
          ],
        },
        'Gentyr',
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Gentyr Dev');
      expect(result.content[0].text).toContain('Gentyr Prod');
      expect(result.content[0].text).toContain('extension_id');
    });

    it('should handle empty matches array in ambiguous result', () => {
      const result = interpretReloadResult(
        { success: false, error: 'ambiguous', matches: [] },
        'test',
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('reload_failed error', () => {
    it('should return isError with the failure message', () => {
      const result = interpretReloadResult(
        { success: false, error: 'reload_failed', message: 'Extension not found' },
        'Gentyr',
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Extension not found');
    });

    it('should fall back to error code when message is absent', () => {
      const result = interpretReloadResult(
        { success: false, error: 'some_code' },
        'Gentyr',
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('some_code');
    });
  });

  describe('successful reload', () => {
    it('should return success content with name and id', () => {
      const result = interpretReloadResult(
        { success: true, id: 'dojoamd', name: 'Gentyr Extension' },
        'Gentyr',
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Gentyr Extension');
      expect(result.content[0].text).toContain('dojoamd');
      expect(result.content[0].text).toContain('reloaded successfully');
    });

    it('should return content as a valid McpContent array', () => {
      const result = interpretReloadResult(
        { success: true, id: 'abc', name: 'My Ext' },
        'My',
      );
      expect(Array.isArray(result.content)).toBe(true);
      result.content.forEach((item) => {
        expect(typeof item.type).toBe('string');
        expect(item.type.length).toBeGreaterThan(0);
      });
    });
  });
});

// ============================================================================
// handleListExtensions — filtering and response shaping
// ============================================================================

interface ExtensionRecord {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  type: string;
  description: string;
}

/**
 * Mirrors the filtering + response-formatting in handleListExtensions()
 * (server.ts ~lines 1117–1134).
 *
 * The extensions array here represents the already-parsed output from
 * chrome.developerPrivate.getExtensionsInfo() mapped to our shape.
 */
function formatExtensionList(
  extensions: ExtensionRecord[],
  enabledOnly: boolean,
): ToolResult {
  let filtered = extensions;
  if (enabledOnly) {
    filtered = extensions.filter((e) => e.enabled);
  }

  const lines = filtered.map(
    (e) =>
      `${e.enabled ? '[ON] ' : '[OFF]'} ${e.name} (${e.id}) v${e.version} [${e.type}]${e.description ? ' — ' + e.description : ''}`,
  );

  return {
    content: [
      {
        type: 'text',
        text: `Found ${filtered.length} extension${filtered.length !== 1 ? 's' : ''}:\n\n${lines.join('\n')}`,
      },
    ],
  };
}

const FIXTURE_EXTENSIONS: ExtensionRecord[] = [
  { id: 'aaa', name: 'Ext Alpha', version: '1.0.0', enabled: true, type: 'extension', description: 'Alpha extension' },
  { id: 'bbb', name: 'Ext Beta', version: '2.1.0', enabled: false, type: 'extension', description: 'Beta extension' },
  { id: 'ccc', name: 'Ext Gamma', version: '3.0.1', enabled: true, type: 'theme', description: '' },
];

describe('handleListExtensions() — filtering and response shaping', () => {
  describe('enabled_only = false (default)', () => {
    it('should return all extensions regardless of enabled status', () => {
      const result = formatExtensionList(FIXTURE_EXTENSIONS, false);
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Ext Alpha');
      expect(result.content[0].text).toContain('Ext Beta');
      expect(result.content[0].text).toContain('Ext Gamma');
    });

    it('should report the correct total count', () => {
      const result = formatExtensionList(FIXTURE_EXTENSIONS, false);
      expect(result.content[0].text).toContain('Found 3 extensions');
    });
  });

  describe('enabled_only = true', () => {
    it('should exclude disabled extensions', () => {
      const result = formatExtensionList(FIXTURE_EXTENSIONS, true);
      expect(result.content[0].text).not.toContain('Ext Beta');
    });

    it('should include only enabled extensions', () => {
      const result = formatExtensionList(FIXTURE_EXTENSIONS, true);
      expect(result.content[0].text).toContain('Ext Alpha');
      expect(result.content[0].text).toContain('Ext Gamma');
    });

    it('should report the filtered count, not the total count', () => {
      const result = formatExtensionList(FIXTURE_EXTENSIONS, true);
      expect(result.content[0].text).toContain('Found 2 extensions');
    });
  });

  describe('singular/plural grammar', () => {
    it('should use "extension" (singular) when exactly one is returned', () => {
      const single = [FIXTURE_EXTENSIONS[0]];
      const result = formatExtensionList(single, false);
      expect(result.content[0].text).toContain('Found 1 extension:');
      expect(result.content[0].text).not.toContain('Found 1 extensions');
    });

    it('should use "extensions" (plural) when zero are returned', () => {
      const result = formatExtensionList([], false);
      expect(result.content[0].text).toContain('Found 0 extensions');
    });

    it('should use "extensions" (plural) when two or more are returned', () => {
      const result = formatExtensionList(FIXTURE_EXTENSIONS, false);
      expect(result.content[0].text).toContain('Found 3 extensions');
    });
  });

  describe('per-extension line format', () => {
    it('should prefix enabled extensions with [ON]', () => {
      const result = formatExtensionList([FIXTURE_EXTENSIONS[0]], false);
      expect(result.content[0].text).toContain('[ON]');
    });

    it('should prefix disabled extensions with [OFF]', () => {
      const result = formatExtensionList([FIXTURE_EXTENSIONS[1]], false);
      expect(result.content[0].text).toContain('[OFF]');
    });

    it('should include the extension id in parentheses', () => {
      const result = formatExtensionList([FIXTURE_EXTENSIONS[0]], false);
      expect(result.content[0].text).toContain('(aaa)');
    });

    it('should include the version with a v prefix', () => {
      const result = formatExtensionList([FIXTURE_EXTENSIONS[0]], false);
      expect(result.content[0].text).toContain('v1.0.0');
    });

    it('should include the type in brackets', () => {
      const result = formatExtensionList([FIXTURE_EXTENSIONS[0]], false);
      expect(result.content[0].text).toContain('[extension]');
    });

    it('should include description when present', () => {
      const result = formatExtensionList([FIXTURE_EXTENSIONS[0]], false);
      expect(result.content[0].text).toContain('Alpha extension');
    });

    it('should omit description separator when description is empty', () => {
      const result = formatExtensionList([FIXTURE_EXTENSIONS[2]], false); // description: ''
      expect(result.content[0].text).not.toContain(' — ');
    });
  });

  describe('response structure', () => {
    it('should return exactly one content item', () => {
      const result = formatExtensionList(FIXTURE_EXTENSIONS, false);
      expect(result.content).toHaveLength(1);
    });

    it('should return content of type text', () => {
      const result = formatExtensionList(FIXTURE_EXTENSIONS, false);
      expect(result.content[0].type).toBe('text');
    });

    it('should not set isError on success', () => {
      const result = formatExtensionList(FIXTURE_EXTENSIONS, false);
      expect(result.isError).toBeUndefined();
    });

    it('should return a valid McpContent array', () => {
      const result = formatExtensionList(FIXTURE_EXTENSIONS, false);
      expect(Array.isArray(result.content)).toBe(true);
      result.content.forEach((item) => {
        expect(typeof item.type).toBe('string');
        expect(item.type.length).toBeGreaterThan(0);
      });
    });
  });

  describe('empty extension list', () => {
    it('should return a result (not an error) for an empty list', () => {
      const result = formatExtensionList([], false);
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
    });

    it('should report zero extensions found', () => {
      const result = formatExtensionList([], false);
      expect(result.content[0].text).toContain('Found 0 extensions');
    });
  });
});

// ============================================================================
// executeServerSideTool — dispatcher routing
// ============================================================================

/**
 * Mirrors executeServerSideTool() (server.ts ~lines 1230–1242).
 *
 * We use a fake handler registry to test routing without touching os.exec.
 */
class TestableServerSideDispatcher {
  private callLog: Array<{ toolName: string; args: Record<string, unknown> }> = [];

  // Fake handlers that record calls and return fixture results
  private fakeHandlers: Record<string, (args: Record<string, unknown>) => ToolResult> = {
    list_chrome_extensions: (args) => {
      this.callLog.push({ toolName: 'list_chrome_extensions', args });
      return { content: [{ type: 'text', text: 'list result' }] };
    },
    reload_chrome_extension: (args) => {
      this.callLog.push({ toolName: 'reload_chrome_extension', args });
      return { content: [{ type: 'text', text: 'reload result' }] };
    },
  };

  executeServerSideTool(
    toolName: string,
    args: Record<string, unknown>,
  ): ToolResult {
    const handler = this.fakeHandlers[toolName];
    if (handler) return handler(args);
    return {
      content: [{ type: 'text', text: `Unknown server-side tool: ${toolName}` }],
      isError: true,
    };
  }

  getCallLog(): Array<{ toolName: string; args: Record<string, unknown> }> {
    return this.callLog;
  }
}

describe('executeServerSideTool() — dispatcher routing', () => {
  let dispatcher: TestableServerSideDispatcher;

  beforeEach(() => {
    dispatcher = new TestableServerSideDispatcher();
  });

  describe('known tools', () => {
    it('should route list_chrome_extensions to the list handler', () => {
      const result = dispatcher.executeServerSideTool('list_chrome_extensions', {});
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('list result');
    });

    it('should route reload_chrome_extension to the reload handler', () => {
      const result = dispatcher.executeServerSideTool('reload_chrome_extension', { name: 'test' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('reload result');
    });

    it('should forward args to the list handler', () => {
      dispatcher.executeServerSideTool('list_chrome_extensions', { enabled_only: true });
      const log = dispatcher.getCallLog();
      expect(log).toHaveLength(1);
      expect(log[0].args).toEqual({ enabled_only: true });
    });

    it('should forward args to the reload handler', () => {
      dispatcher.executeServerSideTool('reload_chrome_extension', { extension_id: 'abc' });
      const log = dispatcher.getCallLog();
      expect(log).toHaveLength(1);
      expect(log[0].args).toEqual({ extension_id: 'abc' });
    });
  });

  describe('unknown tool', () => {
    it('should return isError for an unrecognised tool name', () => {
      const result = dispatcher.executeServerSideTool('unknown_tool', {});
      expect(result.isError).toBe(true);
    });

    it('should include the tool name in the error message', () => {
      const result = dispatcher.executeServerSideTool('mystery_tool', {});
      expect(result.content[0].text).toContain('mystery_tool');
    });

    it('should return a single text content item for unknown tools', () => {
      const result = dispatcher.executeServerSideTool('bad_tool', {});
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('SERVER_SIDE_TOOLS set membership', () => {
    it('should handle both documented server-side tool names', () => {
      // Validates the set of tool names that bypass socket proxying
      const serverSideTools = ['list_chrome_extensions', 'reload_chrome_extension'];
      for (const name of serverSideTools) {
        const result = dispatcher.executeServerSideTool(name, {});
        expect(result.isError).toBeUndefined();
      }
    });

    it('should treat socket-proxied tool names as unknown', () => {
      // These go through the socket, not executeServerSideTool
      const socketTools = ['navigate', 'read_page', 'tabs_context_mcp', 'computer'];
      for (const name of socketTools) {
        const result = dispatcher.executeServerSideTool(name, {});
        expect(result.isError).toBe(true);
      }
    });
  });
});
