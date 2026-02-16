/**
 * Unit tests for Setup Helper MCP Server
 *
 * Tests the three-phase interaction (overview, questions, command generation),
 * state detection, shell quoting (G003), and OP token security pattern.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTempDir } from '../../__testUtils__/index.js';
import { McpServer, type AnyToolHandler } from '../../shared/server.js';
import { GentyrSetupArgsSchema, type GentyrSetupArgs, type SetupResponse } from '../types.js';

// ============================================================================
// Test Helpers
// ============================================================================

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: {
    content: Array<{ type: string; text: string }>;
  };
  error?: { code: number; message: string };
}

/**
 * Create a minimal setup-helper handler for testing.
 * Re-implements the core logic with injectable paths, avoiding module-level constants.
 */
function createTestHandler(frameworkDir: string, projectDir: string) {
  function shellQuote(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  function detectState(projectPath: string) {
    const frameworkSymlink = path.join(projectPath, '.claude-framework');
    const protectionState = path.join(projectPath, '.claude', 'protection-state.json');
    const mcpJson = path.join(projectPath, '.mcp.json');

    let isInstalled = false;
    try {
      isInstalled = fs.existsSync(frameworkSymlink) && (
        fs.lstatSync(frameworkSymlink).isSymbolicLink() ||
        fs.lstatSync(frameworkSymlink).isDirectory()
      );
    } catch {
      // fail-safe
    }

    let isProtected = false;
    if (fs.existsSync(protectionState)) {
      try {
        const state = JSON.parse(fs.readFileSync(protectionState, 'utf8'));
        isProtected = state.protected === true;
      } catch {
        // fail-safe
      }
    }

    const hasMcpJson = fs.existsSync(mcpJson);

    let hasOpToken = false;
    if (hasMcpJson) {
      try {
        const config = JSON.parse(fs.readFileSync(mcpJson, 'utf8'));
        for (const server of Object.values(config.mcpServers || {})) {
          const srv = server as { env?: Record<string, string> };
          if (srv.env?.OP_SERVICE_ACCOUNT_TOKEN) {
            hasOpToken = true;
            break;
          }
        }
      } catch {
        // fail-safe
      }
    }

    return {
      is_installed: isInstalled,
      is_protected: isProtected,
      has_mcp_json: hasMcpJson,
      has_op_token: hasOpToken,
      framework_path: frameworkDir,
      project_path: projectPath,
    };
  }

  return function handleSetup(args: GentyrSetupArgs): SetupResponse {
    const projectPath = args.project_path
      ? path.resolve(args.project_path)
      : projectDir;

    if (!args.action) {
      const state = detectState(projectPath);
      const actions = [
        { action: 'install' as const, description: 'Fresh install.', requires_sudo: false },
        { action: 'uninstall' as const, description: 'Remove GENTYR.', requires_sudo: true },
        { action: 'reinstall' as const, description: 'Full cycle.', requires_sudo: true },
        { action: 'protect' as const, description: 'Enable protection.', requires_sudo: true },
        { action: 'unprotect' as const, description: 'Disable protection.', requires_sudo: true },
        { action: 'status' as const, description: 'Check status.', requires_sudo: false },
        { action: 'scaffold' as const, description: 'New project.', requires_sudo: false },
      ];
      return { status: 'overview', message: '', detected_state: state, actions };
    }

    const action = args.action;
    const setupScript = path.join(frameworkDir, 'scripts', 'setup.sh');
    const reinstallScript = path.join(frameworkDir, 'scripts', 'reinstall.sh');
    const automationScript = path.join(frameworkDir, 'scripts', 'setup-automation-service.sh');
    const targetPath = args.project_path ? path.resolve(args.project_path) : projectPath;
    const quotedPath = shellQuote(targetPath);

    const simpleActions = ['uninstall', 'protect', 'unprotect', 'status', 'scaffold'];
    const hasAnyOption = args.protect !== undefined ||
      args.with_op_token !== undefined ||
      args.makerkit !== undefined ||
      args.protect_mcp !== undefined;

    if (!simpleActions.includes(action) && !hasAnyOption) {
      return {
        status: 'needs_input',
        action,
        description: '',
        questions: [],
      };
    }

    const commands: string[] = [];
    let requiresSudo = false;

    function addOpTokenCommands(mainCommand: string): void {
      commands.push('# Step 1 - Securely enter your 1Password token (paste and press Enter):');
      commands.push('read -rs OP_TOKEN');
      commands.push('');
      commands.push('# Step 2 - Run setup:');
      commands.push(`${mainCommand} --op-token "$OP_TOKEN"`);
      commands.push('');
      commands.push('# Step 3 - Clean up the token from memory:');
      commands.push('unset OP_TOKEN');
    }

    switch (action) {
      case 'install': {
        const parts: string[] = [];
        if (args.protect) { parts.push('sudo'); requiresSudo = true; }
        parts.push(setupScript, '--path', quotedPath);
        if (args.protect) parts.push('--protect');
        if (args.makerkit === 'force') parts.push('--makerkit');
        if (args.makerkit === 'skip') parts.push('--no-makerkit');
        if (args.protect_mcp) parts.push('--protect-mcp');
        const baseCommand = parts.join(' ');
        if (args.with_op_token) { addOpTokenCommands(baseCommand); } else { commands.push(baseCommand); }
        break;
      }
      case 'uninstall':
        requiresSudo = true;
        commands.push(`sudo ${setupScript} --path ${quotedPath} --uninstall`);
        break;
      case 'reinstall': {
        requiresSudo = true;
        const parts: string[] = ['sudo', reinstallScript, '--path', quotedPath];
        if (args.makerkit === 'force') parts.push('--makerkit');
        if (args.makerkit === 'skip') parts.push('--no-makerkit');
        const baseCommand = parts.join(' ');
        if (args.with_op_token) { addOpTokenCommands(baseCommand); } else { commands.push(baseCommand); }
        break;
      }
      case 'protect':
        requiresSudo = true;
        commands.push(`sudo ${setupScript} --path ${quotedPath} --protect-only`);
        break;
      case 'unprotect':
        requiresSudo = true;
        commands.push(`sudo ${setupScript} --path ${quotedPath} --unprotect-only`);
        break;
      case 'status':
        commands.push(`${automationScript} status --path ${quotedPath}`);
        break;
      case 'scaffold':
        commands.push(`${setupScript} --scaffold --path ${quotedPath}`);
        break;
    }

    return {
      status: 'ready',
      commands,
      requires_sudo: requiresSudo,
      explanation: '',
      warnings: [],
      next_steps: [],
    };
  };
}

function createTestServer(frameworkDir: string, projectDir: string): McpServer {
  const handler = createTestHandler(frameworkDir, projectDir);
  const tools: AnyToolHandler[] = [
    {
      name: 'gentyr_setup',
      description: 'Test setup helper',
      schema: GentyrSetupArgsSchema,
      handler,
    },
  ];
  return new McpServer({ name: 'setup-helper-test', version: '1.0.0', tools });
}

async function callTool(
  server: McpServer,
  args: Record<string, unknown> = {},
): Promise<SetupResponse> {
  const response = await server.processRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'gentyr_setup', arguments: args },
  }) as JsonRpcResponse;

  const text = response.result?.content?.[0]?.text;
  if (!text) throw new Error('No response text');
  return JSON.parse(text) as SetupResponse;
}

// ============================================================================
// Tests
// ============================================================================

describe('Setup Helper Server', () => {
  let tempDir: ReturnType<typeof createTempDir>;
  let frameworkDir: string;
  let projectDir: string;
  let server: McpServer;

  beforeEach(() => {
    tempDir = createTempDir('setup-helper-test');
    frameworkDir = path.join(tempDir.path, 'framework');
    projectDir = path.join(tempDir.path, 'project');

    // Create framework structure
    fs.mkdirSync(path.join(frameworkDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(frameworkDir, 'scripts', 'setup.sh'), '#!/bin/bash\n');
    fs.writeFileSync(path.join(frameworkDir, 'scripts', 'reinstall.sh'), '#!/bin/bash\n');
    fs.writeFileSync(path.join(frameworkDir, 'scripts', 'setup-automation-service.sh'), '#!/bin/bash\n');

    // Create project structure
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });

    server = createTestServer(frameworkDir, projectDir);
  });

  afterEach(() => {
    tempDir.cleanup();
  });

  // --------------------------------------------------------------------------
  // Phase 0: Overview
  // --------------------------------------------------------------------------

  describe('Phase 0: Overview', () => {
    it('should return overview when no action provided', async () => {
      const result = await callTool(server);
      expect(result.status).toBe('overview');
      if (result.status !== 'overview') return;
      expect(result.actions).toHaveLength(7);
      expect(result.actions.map(a => a.action)).toEqual([
        'install', 'uninstall', 'reinstall', 'protect', 'unprotect', 'status', 'scaffold',
      ]);
    });

    it('should detect not-installed state', async () => {
      const result = await callTool(server);
      if (result.status !== 'overview') throw new Error('Expected overview');
      expect(result.detected_state.is_installed).toBe(false);
      expect(result.detected_state.is_protected).toBe(false);
    });

    it('should detect installed state via symlink', async () => {
      // Create .claude-framework symlink
      fs.symlinkSync(frameworkDir, path.join(projectDir, '.claude-framework'));

      const result = await callTool(server);
      if (result.status !== 'overview') throw new Error('Expected overview');
      expect(result.detected_state.is_installed).toBe(true);
    });

    it('should detect protected state', async () => {
      fs.writeFileSync(
        path.join(projectDir, '.claude', 'protection-state.json'),
        JSON.stringify({ protected: true }),
      );

      const result = await callTool(server);
      if (result.status !== 'overview') throw new Error('Expected overview');
      expect(result.detected_state.is_protected).toBe(true);
    });

    it('should detect OP token in .mcp.json', async () => {
      fs.writeFileSync(
        path.join(projectDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            vercel: { env: { OP_SERVICE_ACCOUNT_TOKEN: 'test-token' } },
          },
        }),
      );

      const result = await callTool(server);
      if (result.status !== 'overview') throw new Error('Expected overview');
      expect(result.detected_state.has_op_token).toBe(true);
      expect(result.detected_state.has_mcp_json).toBe(true);
    });

    it('should handle corrupted protection-state.json gracefully (G001)', async () => {
      fs.writeFileSync(
        path.join(projectDir, '.claude', 'protection-state.json'),
        'not json',
      );

      const result = await callTool(server);
      if (result.status !== 'overview') throw new Error('Expected overview');
      expect(result.detected_state.is_protected).toBe(false);
    });

    it('should handle corrupted .mcp.json gracefully (G001)', async () => {
      fs.writeFileSync(path.join(projectDir, '.mcp.json'), '{broken');

      const result = await callTool(server);
      if (result.status !== 'overview') throw new Error('Expected overview');
      expect(result.detected_state.has_op_token).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Phase 1: Questions
  // --------------------------------------------------------------------------

  describe('Phase 1: Questions', () => {
    it('should return questions for install with no options', async () => {
      const result = await callTool(server, { action: 'install' });
      expect(result.status).toBe('needs_input');
    });

    it('should return questions for reinstall with no options', async () => {
      const result = await callTool(server, { action: 'reinstall' });
      expect(result.status).toBe('needs_input');
    });

    it('should skip questions for simple actions', async () => {
      for (const action of ['uninstall', 'protect', 'unprotect', 'status', 'scaffold'] as const) {
        const result = await callTool(server, { action });
        expect(result.status).toBe('ready');
      }
    });
  });

  // --------------------------------------------------------------------------
  // Phase 2: Command Generation
  // --------------------------------------------------------------------------

  describe('Phase 2: Command Generation', () => {
    it('should generate install command without protection', async () => {
      const result = await callTool(server, {
        action: 'install',
        project_path: projectDir,
        protect: false,
        makerkit: 'auto',
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toContain('setup.sh');
      expect(result.commands[0]).toContain('--path');
      expect(result.commands[0]).not.toContain('sudo');
      expect(result.requires_sudo).toBe(false);
    });

    it('should generate install command with sudo when protect is true', async () => {
      const result = await callTool(server, {
        action: 'install',
        project_path: projectDir,
        protect: true,
        makerkit: 'auto',
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands[0]).toMatch(/^sudo /);
      expect(result.commands[0]).toContain('--protect');
      expect(result.requires_sudo).toBe(true);
    });

    it('should generate install with --makerkit flag', async () => {
      const result = await callTool(server, {
        action: 'install',
        project_path: projectDir,
        protect: false,
        makerkit: 'force',
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands[0]).toContain('--makerkit');
    });

    it('should generate install with --no-makerkit flag', async () => {
      const result = await callTool(server, {
        action: 'install',
        project_path: projectDir,
        protect: false,
        makerkit: 'skip',
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands[0]).toContain('--no-makerkit');
    });

    it('should generate install with --protect-mcp flag', async () => {
      const result = await callTool(server, {
        action: 'install',
        project_path: projectDir,
        protect: true,
        protect_mcp: true,
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands[0]).toContain('--protect-mcp');
    });

    it('should generate uninstall command with sudo', async () => {
      const result = await callTool(server, {
        action: 'uninstall',
        project_path: projectDir,
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatch(/^sudo /);
      expect(result.commands[0]).toContain('--uninstall');
      expect(result.requires_sudo).toBe(true);
    });

    it('should generate reinstall command with sudo', async () => {
      const result = await callTool(server, {
        action: 'reinstall',
        project_path: projectDir,
        makerkit: 'auto',
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands[0]).toMatch(/^sudo /);
      expect(result.commands[0]).toContain('reinstall.sh');
    });

    it('should generate protect command with sudo', async () => {
      const result = await callTool(server, {
        action: 'protect',
        project_path: projectDir,
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands[0]).toContain('--protect-only');
      expect(result.requires_sudo).toBe(true);
    });

    it('should generate unprotect command with sudo', async () => {
      const result = await callTool(server, {
        action: 'unprotect',
        project_path: projectDir,
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands[0]).toContain('--unprotect-only');
    });

    it('should generate status command without sudo', async () => {
      const result = await callTool(server, {
        action: 'status',
        project_path: projectDir,
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands[0]).toContain('setup-automation-service.sh');
      expect(result.commands[0]).toContain('status');
      expect(result.commands[0]).not.toMatch(/^sudo /);
      expect(result.requires_sudo).toBe(false);
    });

    it('should generate scaffold command', async () => {
      const result = await callTool(server, {
        action: 'scaffold',
        project_path: projectDir,
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands[0]).toContain('--scaffold');
    });

    it('should use absolute paths in all commands', async () => {
      const result = await callTool(server, {
        action: 'uninstall',
        project_path: projectDir,
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      // All path segments should be absolute (start with /)
      expect(result.commands[0]).toMatch(/\/.*setup\.sh/);
      expect(result.commands[0]).toMatch(/--path "\/.*"/);
    });
  });

  // --------------------------------------------------------------------------
  // Shell Quoting
  // --------------------------------------------------------------------------

  describe('Shell Quoting', () => {
    it('should quote paths with spaces', async () => {
      const pathWithSpaces = path.join(tempDir.path, 'my project');
      fs.mkdirSync(pathWithSpaces, { recursive: true });

      const result = await callTool(server, {
        action: 'uninstall',
        project_path: pathWithSpaces,
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands[0]).toContain(`"${pathWithSpaces}"`);
    });

    it('should escape double quotes in paths', async () => {
      // Test the quoting function directly via command output
      const result = await callTool(server, {
        action: 'status',
        project_path: '/tmp/test"path',
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands[0]).toContain('"/tmp/test\\"path"');
    });
  });

  // --------------------------------------------------------------------------
  // OP Token Security
  // --------------------------------------------------------------------------

  describe('OP Token Security', () => {
    it('should generate two-part command for install with OP token', async () => {
      const result = await callTool(server, {
        action: 'install',
        project_path: projectDir,
        protect: true,
        with_op_token: true,
      });
      if (result.status !== 'ready') throw new Error('Expected ready');

      // Should have 8 lines: comment, read, blank, comment, command, blank, comment, unset
      expect(result.commands).toHaveLength(8);
      expect(result.commands[0]).toContain('Step 1');
      expect(result.commands[1]).toBe('read -rs OP_TOKEN');
      expect(result.commands[2]).toBe('');
      expect(result.commands[3]).toContain('Step 2');
      expect(result.commands[4]).toContain('--op-token "$OP_TOKEN"');
      expect(result.commands[5]).toBe('');
      expect(result.commands[6]).toContain('Step 3');
      expect(result.commands[7]).toBe('unset OP_TOKEN');
    });

    it('should generate three-step command for reinstall with OP token', async () => {
      const result = await callTool(server, {
        action: 'reinstall',
        project_path: projectDir,
        with_op_token: true,
        makerkit: 'auto',
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands).toHaveLength(8);
      expect(result.commands[1]).toBe('read -rs OP_TOKEN');
      expect(result.commands[4]).toContain('reinstall.sh');
      expect(result.commands[7]).toBe('unset OP_TOKEN');
    });

    it('should NOT include OP token commands when with_op_token is false', async () => {
      const result = await callTool(server, {
        action: 'install',
        project_path: projectDir,
        protect: true,
        with_op_token: false,
      });
      if (result.status !== 'ready') throw new Error('Expected ready');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).not.toContain('OP_TOKEN');
      expect(result.commands[0]).not.toContain('read -rs');
    });

    it('should never include actual token values in output', async () => {
      const result = await callTool(server, {
        action: 'install',
        project_path: projectDir,
        protect: true,
        with_op_token: true,
      });
      if (result.status !== 'ready') throw new Error('Expected ready');

      const fullOutput = JSON.stringify(result);
      // The output should reference $OP_TOKEN variable, never a concrete value
      expect(fullOutput).not.toContain('op_service_account_token');
      expect(fullOutput).toContain('$OP_TOKEN');
    });
  });

  // --------------------------------------------------------------------------
  // Input Validation (G003)
  // --------------------------------------------------------------------------

  describe('Input Validation (G003)', () => {
    it('should reject invalid action values', async () => {
      const response = await server.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'gentyr_setup', arguments: { action: 'invalid' } },
      }) as JsonRpcResponse;

      const text = response.result?.content?.[0]?.text ?? '';
      expect(text).toContain('error');
    });

    it('should reject invalid makerkit values', async () => {
      const response = await server.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'gentyr_setup', arguments: { action: 'install', makerkit: 'invalid' } },
      }) as JsonRpcResponse;

      const text = response.result?.content?.[0]?.text ?? '';
      expect(text).toContain('error');
    });

    it('should list the tool via tools/list', async () => {
      const response = await server.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }) as JsonRpcResponse;

      const tools = (response.result as { tools: Array<{ name: string }> }).tools;
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('gentyr_setup');
    });
  });
});
