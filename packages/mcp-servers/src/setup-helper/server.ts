#!/usr/bin/env node
/**
 * Setup Helper MCP Server
 *
 * Generates GENTYR framework setup commands dynamically with absolute paths.
 * Two-phase interaction: returns structured questions for AskUserQuestion,
 * then generates exact shell commands once options are resolved.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import { resolveFrameworkDir } from '../shared/resolve-framework.js';
import {
  GentyrSetupArgsSchema,
  type Action,
  type GentyrSetupArgs,
  type SetupResponse,
  type DetectedState,
  type Question,
  type NeedsInputResponse,
  type ReadyResponse,
  type OverviewResponse,
  type OverviewAction,
} from './types.js';

// ============================================================================
// Path Resolution
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Compiled server lives at: <framework>/packages/mcp-servers/dist/setup-helper/server.js
// Walk up: setup-helper/ -> dist/ -> mcp-servers/ -> packages/ -> <framework>
const FRAMEWORK_DIR = path.resolve(__dirname, '..', '..', '..', '..');

const PROJECT_DIR = path.resolve(
  process.env.CLAUDE_PROJECT_DIR || process.cwd()
);

// ============================================================================
// State Detection
// ============================================================================

function detectState(projectPath: string): DetectedState {
  const protectionState = path.join(projectPath, '.claude', 'protection-state.json');
  const mcpJson = path.join(projectPath, '.mcp.json');

  let isInstalled = false;
  try {
    isInstalled = resolveFrameworkDir(projectPath) !== null;
  } catch (err) {
    process.stderr.write(`[setup-helper] Failed to check framework installation: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  let isProtected = false;
  if (fs.existsSync(protectionState)) {
    try {
      const state = JSON.parse(fs.readFileSync(protectionState, 'utf8'));
      isProtected = state.protected === true;
    } catch (err) {
      process.stderr.write(`[setup-helper] Failed to read protection state: ${err instanceof Error ? err.message : String(err)}\n`);
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
    } catch (err) {
      process.stderr.write(`[setup-helper] Failed to parse .mcp.json: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  return {
    is_installed: isInstalled,
    is_protected: isProtected,
    has_mcp_json: hasMcpJson,
    has_op_token: hasOpToken,
    framework_path: FRAMEWORK_DIR,
    project_path: projectPath,
  };
}

// ============================================================================
// Phase 0: Overview (no action provided)
// ============================================================================

function handleOverview(projectPath: string): OverviewResponse {
  const state = detectState(projectPath);

  const actions: OverviewAction[] = [
    {
      action: 'install',
      description: 'Fresh install of GENTYR framework with symlinks, MCP servers, hooks, and automation service.',
      requires_sudo: false,
    },
    {
      action: 'uninstall',
      description: 'Remove GENTYR from project (symlinks, hooks, .mcp.json). Preserves runtime state (.claude/*.db).',
      requires_sudo: true,
    },
    {
      action: 'reinstall',
      description: 'Full cycle: unprotect -> install -> protect. Use when upgrading or fixing broken state.',
      requires_sudo: true,
    },
    {
      action: 'protect',
      description: 'Enable file protection on existing installation. Makes critical files root-owned.',
      requires_sudo: true,
    },
    {
      action: 'unprotect',
      description: 'Disable file protection. Use before making manual changes to protected files.',
      requires_sudo: true,
    },
    {
      action: 'status',
      description: 'Check automation service status (launchd/systemd timer).',
      requires_sudo: false,
    },
    {
      action: 'scaffold',
      description: 'Create a new project from GENTYR templates (package.json, specs, integrations).',
      requires_sudo: false,
    },
  ];

  let message = 'GENTYR Setup Helper - Available actions.\n\n';
  if (state.is_installed) {
    message += `GENTYR is INSTALLED at ${state.project_path}.\n`;
    message += `Protection: ${state.is_protected ? 'ENABLED' : 'DISABLED'}.\n`;
    message += `OP Token: ${state.has_op_token ? 'configured' : 'NOT configured'}.\n\n`;
    message += 'Recommended: reinstall (to upgrade), protect/unprotect, status.';
  } else {
    message += `GENTYR is NOT installed at ${state.project_path}.\n\n`;
    message += 'Recommended: install or scaffold.';
  }

  return {
    status: 'overview',
    message,
    detected_state: state,
    actions,
  };
}

// ============================================================================
// Phase 1: Questions (action provided, options incomplete)
// ============================================================================

const ACTION_DESCRIPTIONS: Record<Action, string> = {
  install: 'Install GENTYR framework into your project.',
  uninstall: 'Remove GENTYR from your project.',
  reinstall: 'Reinstall GENTYR (unprotect -> install -> protect).',
  protect: 'Enable file protection on your project.',
  unprotect: 'Disable file protection on your project.',
  status: 'Check automation service status.',
  scaffold: 'Create a new project from GENTYR templates.',
};

function handleQuestions(
  action: Action,
  args: GentyrSetupArgs,
  projectPath: string,
): NeedsInputResponse {
  const questions: Question[] = [];

  // All actions need project_path if not resolved
  if (!args.project_path && !process.env.CLAUDE_PROJECT_DIR) {
    questions.push({
      question: 'What is the absolute path to your project?',
      header: 'Project path',
      param_name: 'project_path',
      required: true,
      options: [
        {
          label: projectPath,
          description: 'Current working directory',
        },
      ],
    });
  }

  switch (action) {
    case 'install': {
      if (args.protect === undefined) {
        questions.push({
          question: 'Do you want to enable file protection?',
          header: 'Protection',
          param_name: 'protect',
          required: false,
          options: [
            {
              label: 'Yes (Recommended)',
              description: 'Makes critical files root-owned to prevent agent bypass. Requires sudo.',
            },
            {
              label: 'No',
              description: 'Development only. Files remain user-owned and modifiable by agents.',
            },
          ],
        });
      }
      if (args.with_op_token === undefined) {
        questions.push({
          question: 'Do you have a 1Password service account token to configure?',
          header: '1Password',
          param_name: 'with_op_token',
          required: false,
          options: [
            {
              label: 'Yes',
              description: 'Include a secure token entry step. The token is entered directly in your terminal, never exposed to Claude.',
            },
            {
              label: 'Skip for now',
              description: 'Configure later with /setup-gentyr.',
            },
          ],
        });
      }
      if (args.makerkit === undefined) {
        questions.push({
          question: 'Makerkit integration mode?',
          header: 'Makerkit',
          param_name: 'makerkit',
          required: false,
          options: [
            { label: 'auto (Recommended)', description: 'Auto-detect Makerkit in project.' },
            { label: 'force', description: 'Force enable Makerkit integration.' },
            { label: 'skip', description: 'Skip Makerkit integration entirely.' },
          ],
        });
      }
      if (args.protect_mcp === undefined) {
        questions.push({
          question: 'Enable MCP server protection?',
          header: 'MCP protection',
          param_name: 'protect_mcp',
          required: false,
          options: [
            {
              label: 'Yes',
              description: 'Configure protected MCP actions (credential isolation, CTO approval gates).',
            },
            {
              label: 'No',
              description: 'Skip MCP protection setup. Can be added later with --protect-mcp --reconfigure.',
            },
          ],
        });
      }
      break;
    }

    case 'reinstall': {
      if (args.with_op_token === undefined) {
        questions.push({
          question: 'Do you have a 1Password service account token to configure?',
          header: '1Password',
          param_name: 'with_op_token',
          required: false,
          options: [
            { label: 'Yes', description: 'Include a secure token entry step.' },
            { label: 'Skip', description: 'Re-use existing token if present.' },
          ],
        });
      }
      if (args.makerkit === undefined) {
        questions.push({
          question: 'Makerkit integration mode?',
          header: 'Makerkit',
          param_name: 'makerkit',
          required: false,
          options: [
            { label: 'auto (Recommended)', description: 'Auto-detect (default).' },
            { label: 'force', description: 'Force enable.' },
            { label: 'skip', description: 'Skip entirely.' },
          ],
        });
      }
      break;
    }

    // uninstall, protect, unprotect, status, scaffold: only need project_path
    default:
      break;
  }

  return {
    status: 'needs_input',
    action,
    description: ACTION_DESCRIPTIONS[action],
    questions,
  };
}

// ============================================================================
// Phase 2: Command Generation
// ============================================================================

/**
 * Shell-quote a path value for safe interpolation into commands.
 * Wraps in double quotes and escapes any embedded double quotes.
 */
function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function generateCommand(
  action: Action,
  args: GentyrSetupArgs,
  projectPath: string,
): ReadyResponse {
  const targetPath = args.project_path ? path.resolve(args.project_path) : projectPath;
  const quotedPath = shellQuote(targetPath);
  const warnings: string[] = [];
  const nextSteps: string[] = [];
  const commands: string[] = [];
  let requiresSudo = false;

  const setupScript = path.join(FRAMEWORK_DIR, 'scripts', 'setup.sh');
  const reinstallScript = path.join(FRAMEWORK_DIR, 'scripts', 'reinstall.sh');
  const automationScript = path.join(FRAMEWORK_DIR, 'scripts', 'setup-automation-service.sh');

  // Helper: build OP token three-step commands
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
      if (args.protect) {
        parts.push('sudo');
        requiresSudo = true;
      }
      parts.push(setupScript);
      parts.push('--path', quotedPath);
      if (args.protect) parts.push('--protect');
      if (args.makerkit === 'force') parts.push('--makerkit');
      if (args.makerkit === 'skip') parts.push('--no-makerkit');
      if (args.protect_mcp) parts.push('--protect-mcp');

      const baseCommand = parts.join(' ');

      if (args.with_op_token) {
        addOpTokenCommands(baseCommand);
      } else {
        commands.push(baseCommand);
      }

      if (requiresSudo) {
        warnings.push('Requires sudo - you will be prompted for your password.');
      }
      nextSteps.push('Start a new Claude Code session to pick up MCP server changes.');
      nextSteps.push('Run /setup-gentyr to configure credentials interactively.');
      break;
    }

    case 'uninstall': {
      requiresSudo = true;
      commands.push(`sudo ${setupScript} --path ${quotedPath} --uninstall`);
      warnings.push('Requires sudo - will auto-unprotect if currently protected.');
      warnings.push('Removes symlinks, hooks, and .mcp.json. Runtime state (.claude/*.db) is preserved.');
      nextSteps.push('Start a new Claude Code session.');
      break;
    }

    case 'reinstall': {
      requiresSudo = true;
      const parts: string[] = ['sudo', reinstallScript, '--path', quotedPath];
      if (args.makerkit === 'force') parts.push('--makerkit');
      if (args.makerkit === 'skip') parts.push('--no-makerkit');

      const baseCommand = parts.join(' ');

      if (args.with_op_token) {
        addOpTokenCommands(baseCommand);
      } else {
        commands.push(baseCommand);
      }

      warnings.push('Requires sudo - performs unprotect -> install -> protect cycle.');
      nextSteps.push('Start a new Claude Code session.');
      nextSteps.push('Run /setup-gentyr to configure credentials.');
      break;
    }

    case 'protect': {
      requiresSudo = true;
      commands.push(`sudo ${setupScript} --path ${quotedPath} --protect-only`);
      warnings.push('Requires sudo - makes critical files root-owned.');
      break;
    }

    case 'unprotect': {
      requiresSudo = true;
      commands.push(`sudo ${setupScript} --path ${quotedPath} --unprotect-only`);
      warnings.push('Requires sudo - restores user ownership of protected files.');
      nextSteps.push('Re-protect after making changes with the protect action.');
      break;
    }

    case 'status': {
      commands.push(`${automationScript} status --path ${quotedPath}`);
      break;
    }

    case 'scaffold': {
      commands.push(`${setupScript} --scaffold --path ${quotedPath}`);
      warnings.push('This is interactive - will prompt for project name, GitHub org, domain, etc.');
      nextSteps.push(`After scaffolding, install GENTYR: ${setupScript} --path ${quotedPath}`);
      break;
    }
  }

  return {
    status: 'ready',
    commands,
    requires_sudo: requiresSudo,
    explanation: ACTION_DESCRIPTIONS[action],
    warnings,
    next_steps: nextSteps,
  };
}

// ============================================================================
// Main Handler
// ============================================================================

function handleSetup(args: GentyrSetupArgs): SetupResponse {
  const projectPath = args.project_path
    ? path.resolve(args.project_path)
    : PROJECT_DIR;

  // Phase 0: No action -> overview
  if (!args.action) {
    return handleOverview(projectPath);
  }

  const action = args.action;

  // Simple actions only need project_path
  const simpleActions: Action[] = ['uninstall', 'protect', 'unprotect', 'status', 'scaffold'];
  if (simpleActions.includes(action)) {
    if (!args.project_path && !process.env.CLAUDE_PROJECT_DIR) {
      return handleQuestions(action, args, projectPath);
    }
    return generateCommand(action, args, projectPath);
  }

  // install/reinstall: check if user has provided any options beyond just the action
  const hasProjectPath = Boolean(args.project_path || process.env.CLAUDE_PROJECT_DIR);
  const hasAnyOption = args.protect !== undefined ||
    args.with_op_token !== undefined ||
    args.makerkit !== undefined ||
    args.protect_mcp !== undefined;

  if (!hasProjectPath || !hasAnyOption) {
    return handleQuestions(action, args, projectPath);
  }

  return generateCommand(action, args, projectPath);
}

// ============================================================================
// Tool Definition & Server
// ============================================================================

const TOOL_DESCRIPTION = `ALWAYS use this tool instead of manually constructing setup.sh commands or grepping for GENTYR scripts. This generates correct commands with absolute paths for any GENTYR framework operation: install, uninstall, reinstall, protect, unprotect, status, or scaffold.

Three-phase workflow:
1. No arguments → overview of actions and detected state. Present to user with AskUserQuestion.
2. Action only (e.g. action="unprotect") → returns questions if options are needed. Present via AskUserQuestion, then re-call with answers mapped to param_name fields.
3. Action + options → returns exact shell command(s) to run. Present to user.

For OP token commands, instruct the user to run in their terminal (not through Claude) so the token stays private.`;

const tools: AnyToolHandler[] = [
  {
    name: 'gentyr_setup',
    description: TOOL_DESCRIPTION,
    schema: GentyrSetupArgsSchema,
    handler: handleSetup,
  },
];

const server = new McpServer({
  name: 'setup-helper',
  version: '1.0.0',
  tools,
});

server.start();
