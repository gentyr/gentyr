#!/usr/bin/env node
/**
 * Programmatic Feedback MCP Server
 *
 * Provides CLI, API, and SDK interaction tools that let AI feedback agents
 * test applications programmatically from a real user's perspective.
 *
 * Tools are filtered based on FEEDBACK_MODE environment variable:
 * - 'cli': Only CLI tools (cli_run, cli_run_interactive)
 * - 'api': Only API tools (api_request, api_graphql)
 * - 'sdk': Only SDK tools (sdk_eval, sdk_list_exports)
 * - 'all': All tools (default)
 *
 * Environment Variables:
 * - FEEDBACK_MODE: Which tools to expose ('cli', 'api', 'sdk', 'all')
 * - FEEDBACK_CLI_COMMAND: CLI binary command (required for CLI mode)
 * - FEEDBACK_API_BASE_URL: API base URL (required for API mode)
 * - FEEDBACK_SDK_PACKAGES: Comma-separated allowed packages (required for SDK mode)
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import { execFile, spawn } from 'child_process';
import { URL, fileURLToPath } from 'url';
import * as path from 'path';
import { type AnyToolHandler } from '../shared/server.js';
import { AuditedMcpServer } from '../shared/audited-server.js';
import { evaluateInSandbox } from './sandbox.js';
import {
  CliRunArgsSchema,
  CliRunInteractiveArgsSchema,
  ApiRequestArgsSchema,
  ApiGraphqlArgsSchema,
  SdkEvalArgsSchema,
  SdkListExportsArgsSchema,
  type CliRunArgs,
  type CliRunInteractiveArgs,
  type ApiRequestArgs,
  type ApiGraphqlArgs,
  type SdkEvalArgs,
  type SdkListExportsArgs,
  type CliRunResult,
  type CliRunInteractiveResult,
  type ApiRequestResult,
  type ApiGraphqlResult,
  type SdkEvalResult,
  type SdkListExportsResult,
  type ErrorResult,
} from './types.js';

// ============================================================================
// Configuration Interface
// ============================================================================

export interface ProgrammaticFeedbackConfig {
  feedbackMode: 'cli' | 'api' | 'sdk' | 'all';
  cliCommand?: string;
  apiBaseUrl?: string;
  sdkPackages?: string[];
  auditSessionId: string;
  auditPersonaName?: string;
  auditDbPath?: string;
}

// ============================================================================
// Server Factory Function
// ============================================================================

export function createProgrammaticFeedbackServer(config: ProgrammaticFeedbackConfig): AuditedMcpServer {
  // ============================================================================
  // CLI Tools
  // ============================================================================

  /**
   * Parse CLI command into command + base args
   */
  function parseCliCommand(): { command: string; baseArgs: string[] } {
    const cliCommand = config.cliCommand || '';
    const parts = cliCommand.trim().split(/\s+/);
    if (parts.length === 0) {
      throw new Error('cliCommand is empty');
    }
    return {
      command: parts[0],
      baseArgs: parts.slice(1),
    };
  }

  /**
   * Execute CLI with arguments
   */
  async function cliRun(args: CliRunArgs): Promise<CliRunResult | ErrorResult> {
    if (!config.cliCommand) {
      return { error: 'cliCommand not configured' };
    }

    try {
      const { command, baseArgs } = parseCliCommand();
      const allArgs = [...baseArgs, ...args.args];

      return await new Promise<CliRunResult>((resolve) => {
        let completed = false;
        let timeoutHandle: NodeJS.Timeout | null = null;

        const child = execFile(command, allArgs, {
          timeout: args.timeout,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          encoding: 'utf8',
        }, (error, stdout, stderr) => {
          if (!completed) {
            completed = true;
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }

            const exitCode = error?.code !== undefined && typeof error.code === 'number'
              ? error.code
              : (error ? 1 : 0);

            const timedOut = error?.killed === true;

            resolve({
              stdout: stdout || '',
              stderr: stderr || '',
              exitCode,
              timedOut: timedOut || undefined,
            });
          }
        });

        // Additional timeout handler
        timeoutHandle = setTimeout(() => {
          if (!completed) {
            completed = true;
            child.kill();
            resolve({
              stdout: '',
              stderr: 'Timeout exceeded',
              exitCode: -1,
              timedOut: true,
            });
          }
        }, args.timeout);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `CLI execution failed: ${message}` };
    }
  }

  /**
   * Execute interactive CLI with input lines
   */
  async function cliRunInteractive(args: CliRunInteractiveArgs): Promise<CliRunInteractiveResult | ErrorResult> {
    if (!config.cliCommand) {
      return { error: 'cliCommand not configured' };
    }

    try {
      const { command, baseArgs } = parseCliCommand();
      const allArgs = [...baseArgs, ...args.args];

      return await new Promise<CliRunInteractiveResult>((resolve) => {
        let completed = false;
        let timeoutHandle: NodeJS.Timeout | null = null;
        let output = '';

        const child = spawn(command, allArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Collect stdout + stderr
        child.stdout.on('data', (data) => {
          output += data.toString();
        });

        child.stderr.on('data', (data) => {
          output += data.toString();
        });

        // Write input lines
        for (const line of args.input_lines) {
          child.stdin.write(line + '\n');
        }
        child.stdin.end();

        // Handle exit
        child.on('exit', (code) => {
          if (!completed) {
            completed = true;
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
            resolve({
              output,
              exitCode: code ?? -1,
            });
          }
        });

        // Handle errors
        child.on('error', (err) => {
          if (!completed) {
            completed = true;
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
            resolve({
              output: output + '\nError: ' + err.message,
              exitCode: -1,
            });
          }
        });

        // Timeout
        timeoutHandle = setTimeout(() => {
          if (!completed) {
            completed = true;
            child.kill();
            resolve({
              output: output + '\nTimeout exceeded',
              exitCode: -1,
              timedOut: true,
            });
          }
        }, args.timeout);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Interactive CLI execution failed: ${message}` };
    }
  }

  // ============================================================================
  // API Tools
  // ============================================================================

  /**
   * Validate that request path stays within base URL
   */
  function validateApiUrl(path: string): { valid: boolean; fullUrl?: string; error?: string } {
    const apiBaseUrl = config.apiBaseUrl || '';

    try {
      // Normalize path
      const normalizedPath = path.startsWith('/') ? path : '/' + path;

      // Construct full URL
      const baseUrl = new URL(apiBaseUrl);
      const fullUrl = new URL(normalizedPath, baseUrl);

      // Validate: protocol, host, and port must match
      if (fullUrl.protocol !== baseUrl.protocol ||
          fullUrl.host !== baseUrl.host) {
        return {
          valid: false,
          error: `URL must stay within base URL ${apiBaseUrl}`,
        };
      }

      return {
        valid: true,
        fullUrl: fullUrl.toString(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        valid: false,
        error: `Invalid URL: ${message}`,
      };
    }
  }

  /**
   * Make HTTP API request
   */
  async function apiRequest(args: ApiRequestArgs): Promise<ApiRequestResult | ErrorResult> {
    if (!config.apiBaseUrl) {
      return { error: 'apiBaseUrl not configured' };
    }

    // Validate URL
    const urlValidation = validateApiUrl(args.path);
    if (!urlValidation.valid) {
      return { error: urlValidation.error || 'Invalid URL' };
    }

    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), args.timeout);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...args.headers,
      };

      const fetchOptions: RequestInit = {
        method: args.method,
        headers,
        signal: controller.signal,
      };

      if (args.body && (args.method === 'POST' || args.method === 'PUT' || args.method === 'PATCH')) {
        fetchOptions.body = JSON.stringify(args.body);
      }

      const response = await fetch(urlValidation.fullUrl!, fetchOptions);
      clearTimeout(timeoutHandle);

      // Parse response body
      const contentType = response.headers.get('content-type') || '';
      let body: unknown;
      if (contentType.includes('application/json')) {
        body = await response.json();
      } else {
        body = await response.text();
      }

      // Convert headers to plain object
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return {
        status: response.status,
        headers: responseHeaders,
        body,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Check if timeout
      if (message.includes('aborted')) {
        return {
          status: 0,
          headers: {},
          body: null,
          timedOut: true,
        };
      }

      return { error: `API request failed: ${message}` };
    }
  }

  /**
   * Execute GraphQL query
   */
  async function apiGraphql(args: ApiGraphqlArgs): Promise<ApiGraphqlResult | ErrorResult> {
    if (!config.apiBaseUrl) {
      return { error: 'apiBaseUrl not configured' };
    }

    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), args.timeout);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...args.headers,
      };

      const body = {
        query: args.query,
        variables: args.variables || {},
      };

      // Construct GraphQL endpoint
      const graphqlPath = '/graphql';
      const urlValidation = validateApiUrl(graphqlPath);
      if (!urlValidation.valid) {
        return { error: urlValidation.error || 'Invalid GraphQL URL' };
      }

      const response = await fetch(urlValidation.fullUrl!, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutHandle);

      const result = await response.json() as { data?: unknown; errors?: unknown[] };

      return {
        data: result.data || null,
        errors: result.errors,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Check if timeout
      if (message.includes('aborted')) {
        return {
          data: null,
          errors: [{ message: 'Request timed out' }],
          timedOut: true,
        };
      }

      return { error: `GraphQL request failed: ${message}` };
    }
  }

  // ============================================================================
  // SDK Tools
  // ============================================================================

  /**
   * Execute code in sandbox
   */
  async function sdkEval(args: SdkEvalArgs): Promise<SdkEvalResult | ErrorResult> {
    const sdkPackages = config.sdkPackages || [];

    if (sdkPackages.length === 0) {
      return { error: 'sdkPackages not configured' };
    }

    try {
      const result = await evaluateInSandbox(args.code, sdkPackages, args.timeout);

      if ('error' in result) {
        return { error: result.error };
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Sandbox execution failed: ${message}` };
    }
  }

  /**
   * List exports from SDK package
   */
  async function sdkListExports(args: SdkListExportsArgs): Promise<SdkListExportsResult | ErrorResult> {
    const sdkPackages = config.sdkPackages || [];

    if (sdkPackages.length === 0) {
      return { error: 'sdkPackages not configured' };
    }

    const packageName = args.package_name || sdkPackages[0];

    if (!sdkPackages.includes(packageName)) {
      return {
        error: `Package "${packageName}" not in allowed packages: ${sdkPackages.join(', ')}`,
      };
    }

    try {
      // Use dynamic import to load the package
      const module = await import(packageName);
      const exports = Object.keys(module).sort();

      return {
        package_name: packageName,
        exports,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to list exports: ${message}` };
    }
  }

  // ============================================================================
  // Server Setup
  // ============================================================================

  const allTools: AnyToolHandler[] = [
    // CLI tools
    {
      name: 'cli_run',
      description: 'Execute the project CLI with arguments. NO shell metacharacters - args are passed directly to execFile.',
      schema: CliRunArgsSchema,
      handler: cliRun,
    },
    {
      name: 'cli_run_interactive',
      description: 'Execute interactive CLI session with stdin input lines. For CLIs with menus/wizards.',
      schema: CliRunInteractiveArgsSchema,
      handler: cliRunInteractive,
    },
    // API tools
    {
      name: 'api_request',
      description: 'Make HTTP request to the project API. Path is prepended with FEEDBACK_API_BASE_URL and must stay within base domain.',
      schema: ApiRequestArgsSchema,
      handler: apiRequest,
    },
    {
      name: 'api_graphql',
      description: 'Execute GraphQL query/mutation. Posts to FEEDBACK_API_BASE_URL/graphql.',
      schema: ApiGraphqlArgsSchema,
      handler: apiGraphql,
    },
    // SDK tools
    {
      name: 'sdk_eval',
      description: 'Execute code snippet in sandboxed Node.js worker. Only configured SDK packages are importable. No fs, child_process, net, os, path.',
      schema: SdkEvalArgsSchema,
      handler: sdkEval,
    },
    {
      name: 'sdk_list_exports',
      description: 'List public exports from the configured SDK package.',
      schema: SdkListExportsArgsSchema,
      handler: sdkListExports,
    },
  ];

  // Filter tools based on feedbackMode
  let tools: AnyToolHandler[] = [];

  if (config.feedbackMode === 'all') {
    tools = allTools;
  } else if (config.feedbackMode === 'cli') {
    tools = allTools.filter(t => t.name.startsWith('cli_'));
  } else if (config.feedbackMode === 'api') {
    tools = allTools.filter(t => t.name.startsWith('api_'));
  } else if (config.feedbackMode === 'sdk') {
    tools = allTools.filter(t => t.name.startsWith('sdk_'));
  }

  return new AuditedMcpServer({
    name: 'programmatic-feedback',
    version: '1.0.0',
    tools,
    auditSessionId: config.auditSessionId,
    auditPersonaName: config.auditPersonaName,
    auditDbPath: config.auditDbPath,
  });
}

// ============================================================================
// Auto-start when run as a process (not when imported by tests)
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const config: ProgrammaticFeedbackConfig = {
    feedbackMode: (process.env['FEEDBACK_MODE'] || 'all') as ProgrammaticFeedbackConfig['feedbackMode'],
    cliCommand: process.env['FEEDBACK_CLI_COMMAND'] || '',
    apiBaseUrl: process.env['FEEDBACK_API_BASE_URL'] || '',
    sdkPackages: (process.env['FEEDBACK_SDK_PACKAGES'] || '').split(',').map(p => p.trim()).filter(Boolean),
    auditSessionId: process.env['FEEDBACK_SESSION_ID'] || '',
    auditPersonaName: process.env['FEEDBACK_PERSONA_NAME'],
    auditDbPath: undefined,
  };

  const server = createProgrammaticFeedbackServer(config);

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  server.start();
}
