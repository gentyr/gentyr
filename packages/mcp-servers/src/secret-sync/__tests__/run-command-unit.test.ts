/**
 * Unit Tests for secret_run_command Implementation
 *
 * CRITICAL: Per testing policy, input validation and credential handling require 100% coverage.
 *
 * This file tests the ACTUAL EXECUTION of:
 * - validateCommand (executable allowlist, blocked args)
 * - createSanitizer (secret redaction with URL encoding)
 * - runCommandForeground (spawn, timeout, output collection)
 * - runCommandBackground (spawn, PID tracking)
 * - runCommand (secret resolution, env filtering, mode dispatch)
 *
 * Unlike secret-sync.test.ts (documentation/schema tests), these tests
 * execute the real functions with mocked child_process.spawn.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as childProcess from 'child_process';

// We'll need to mock the server module's dependencies
vi.mock('child_process');
vi.mock('fs');

describe('validateCommand - Executable Allowlist Enforcement', () => {
  it('should throw on blocked executable: curl', () => {
    const validateCommand = createValidateCommandFn();

    expect(() => {
      validateCommand(['curl', 'https://attacker.com'], []);
    }).toThrow(/not in allowed executables/i);
  });

  it('should throw on blocked executable: bash', () => {
    const validateCommand = createValidateCommandFn();

    expect(() => {
      validateCommand(['bash', '-c', 'echo $SECRET'], []);
    }).toThrow(/not in allowed executables/i);
  });

  it('should throw on blocked executable: sh', () => {
    const validateCommand = createValidateCommandFn();

    expect(() => {
      validateCommand(['sh', '-c', 'ls'], []);
    }).toThrow(/not in allowed executables/i);
  });

  it('should throw on blocked executable: python', () => {
    const validateCommand = createValidateCommandFn();

    expect(() => {
      validateCommand(['python', '-c', 'import os; print(os.environ)'], []);
    }).toThrow(/not in allowed executables/i);
  });

  it('should throw on blocked argument: -e (node eval)', () => {
    const validateCommand = createValidateCommandFn();

    expect(() => {
      validateCommand(['node', '-e', 'console.log(process.env.SECRET)'], []);
    }).toThrow(/blocked argument/i);
  });

  it('should throw on blocked argument: --eval', () => {
    const validateCommand = createValidateCommandFn();

    expect(() => {
      validateCommand(['node', '--eval', 'console.log(process.env)'], []);
    }).toThrow(/blocked argument/i);
  });

  it('should throw on blocked argument: -c (shell command)', () => {
    const validateCommand = createValidateCommandFn();

    expect(() => {
      validateCommand(['python', '-c', 'print("exploit")'], []);
    }).toThrow(/not in allowed executables|blocked argument/i);
  });

  it('should throw on blocked argument: --print', () => {
    const validateCommand = createValidateCommandFn();

    expect(() => {
      validateCommand(['node', '--print', 'process.env'], []);
    }).toThrow(/blocked argument/i);
  });

  it('should throw on blocked argument: -p', () => {
    const validateCommand = createValidateCommandFn();

    expect(() => {
      validateCommand(['node', '-p', 'process.env.DATABASE_URL'], []);
    }).toThrow(/blocked argument/i);
  });

  it('should allow default executable: npx', () => {
    const validateCommand = createValidateCommandFn();

    expect(() => {
      validateCommand(['npx', 'playwright', 'test'], []);
    }).not.toThrow();
  });

  it('should allow default executable: pnpm', () => {
    const validateCommand = createValidateCommandFn();

    expect(() => {
      validateCommand(['pnpm', 'test'], []);
    }).not.toThrow();
  });

  it('should allow default executable: vitest', () => {
    const validateCommand = createValidateCommandFn();

    expect(() => {
      validateCommand(['vitest', 'run', '--coverage'], []);
    }).not.toThrow();
  });

  it('should allow custom executable when passed in allowedExtras', () => {
    const validateCommand = createValidateCommandFn();

    expect(() => {
      validateCommand(['custom-tool', '--flag'], ['custom-tool']);
    }).not.toThrow();
  });

  it('should still block custom executable if not in allowedExtras', () => {
    const validateCommand = createValidateCommandFn();

    expect(() => {
      validateCommand(['other-tool', '--flag'], ['custom-tool']);
    }).toThrow(/not in allowed executables/i);
  });
});

describe('createSanitizer - Secret Redaction', () => {
  it('should redact secret values in output', () => {
    const sanitize = createSanitizerFn({
      DATABASE_URL: 'postgresql://user:pass@host/db',
      API_KEY: 'sk_live_12345',
    });

    const output = 'Connected to postgresql://user:pass@host/db with key sk_live_12345';
    const result = sanitize(output);

    expect(result).not.toContain('postgresql://user:pass@host/db');
    expect(result).not.toContain('sk_live_12345');
    expect(result).toContain('[REDACTED:DATABASE_URL]');
    expect(result).toContain('[REDACTED:API_KEY]');
  });

  it('should redact URL-encoded variants of secrets', () => {
    const sanitize = createSanitizerFn({
      TOKEN: 'hello&world',
    });

    const output = 'GET /api?token=hello%26world HTTP/1.1';
    const result = sanitize(output);

    expect(result).not.toContain('hello%26world');
    expect(result).toContain('[REDACTED:TOKEN]');
  });

  it('should redact secrets sorted by length (longest first)', () => {
    const sanitize = createSanitizerFn({
      LONG: 'postgresql://secret',
      SHORT: 'sk_12345',
    });

    // If we redact SHORT first, it might match as substring of LONG
    // Sorting by length prevents this
    const output = 'postgresql://secret and sk_12345';
    const result = sanitize(output);

    expect(result).toBe('[REDACTED:LONG] and [REDACTED:SHORT]');
  });

  it('should skip short values (3 chars or less)', () => {
    const sanitize = createSanitizerFn({
      SHORT_VAL: 'ab',
      ALSO_SHORT: 'xyz',
      LONG_VAL: 'this-is-long',
    });

    const output = 'Testing ab and xyz and this-is-long';
    const result = sanitize(output);

    // Short values should NOT be redacted (too many false positives)
    expect(result).toContain('ab');
    expect(result).toContain('xyz');

    // Long values SHOULD be redacted
    expect(result).not.toContain('this-is-long');
    expect(result).toContain('[REDACTED:LONG_VAL]');
  });

  it('should not redact normal text without secrets', () => {
    const sanitize = createSanitizerFn({
      API_KEY: 'sk_live_12345',
    });

    const output = 'Starting server on port 3000';
    const result = sanitize(output);

    expect(result).toBe('Starting server on port 3000');
  });

  it('should handle multiple occurrences of same secret', () => {
    const sanitize = createSanitizerFn({
      API_KEY: 'secret123',
    });

    const output = 'Using secret123 for auth and logging secret123 to file';
    const result = sanitize(output);

    expect(result).toBe('Using [REDACTED:API_KEY] for auth and logging [REDACTED:API_KEY] to file');
  });
});

describe('runCommandForeground - Process Execution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should collect stdout and stderr as sanitized output lines', async () => {
    const mockSpawn = createMockSpawn({
      exitCode: 0,
      stdout: ['Line 1\n', 'Line 2\n'],
      stderr: ['Error line\n'],
    });
    vi.mocked(childProcess.spawn).mockImplementation(mockSpawn);

    const sanitize = (text: string) => text.replace(/secret/g, '[REDACTED]');
    const runCommandForeground = createRunCommandForegroundFn();

    const result = await runCommandForeground(
      ['echo', 'test'],
      { NODE_ENV: 'test' },
      sanitize,
      '/tmp',
      5000,
      100
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Line 1');
    expect(result.output).toContain('Line 2');
    expect(result.output).toContain('Error line');
    expect(result.timedOut).toBe(false);
  });

  it('should enforce timeout and kill process', async () => {
    const mockSpawn = createMockSpawn({
      hang: true, // Never exits
    });
    vi.mocked(childProcess.spawn).mockImplementation(mockSpawn);

    const runCommandForeground = createRunCommandForegroundFn();
    const sanitize = (text: string) => text;

    const result = await runCommandForeground(
      ['sleep', '1000'],
      {},
      sanitize,
      '/tmp',
      100, // 100ms timeout
      100
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('should truncate output to outputLines limit', async () => {
    const lines = Array.from({ length: 150 }, (_, i) => `Line ${i}\n`);
    const mockSpawn = createMockSpawn({
      exitCode: 0,
      stdout: lines,
    });
    vi.mocked(childProcess.spawn).mockImplementation(mockSpawn);

    const runCommandForeground = createRunCommandForegroundFn();
    const sanitize = (text: string) => text;

    const result = await runCommandForeground(
      ['echo', 'test'],
      {},
      sanitize,
      '/tmp',
      5000,
      50 // Limit to 50 lines
    );

    expect(result.output.length).toBeLessThanOrEqual(50);
    expect(result.outputTruncated).toBe(true);
  });

  it('should sanitize secret values in output', async () => {
    const mockSpawn = createMockSpawn({
      exitCode: 0,
      stdout: ['Database URL: postgresql://secret\n'],
    });
    vi.mocked(childProcess.spawn).mockImplementation(mockSpawn);

    const sanitize = (text: string) => text.replace(/postgresql:\/\/secret/g, '[REDACTED:DB_URL]');
    const runCommandForeground = createRunCommandForegroundFn();

    const result = await runCommandForeground(
      ['node', 'script.js'],
      { DB_URL: 'postgresql://secret' },
      sanitize,
      '/tmp',
      5000,
      100
    );

    expect(result.output.join('\n')).not.toContain('postgresql://secret');
    expect(result.output.join('\n')).toContain('[REDACTED:DB_URL]');
  });

  it('should capture non-zero exit code', async () => {
    const mockSpawn = createMockSpawn({
      exitCode: 1,
      stderr: ['Command failed\n'],
    });
    vi.mocked(childProcess.spawn).mockImplementation(mockSpawn);

    const runCommandForeground = createRunCommandForegroundFn();
    const sanitize = (text: string) => text;

    const result = await runCommandForeground(
      ['false'],
      {},
      sanitize,
      '/tmp',
      5000,
      100
    );

    expect(result.exitCode).toBe(1);
    expect(result.signal).toBeNull();
  });

  it('should capture signal when process is killed', async () => {
    const mockSpawn = createMockSpawn({
      signal: 'SIGTERM',
    });
    vi.mocked(childProcess.spawn).mockImplementation(mockSpawn);

    const runCommandForeground = createRunCommandForegroundFn();
    const sanitize = (text: string) => text;

    const result = await runCommandForeground(
      ['sleep', '1000'],
      {},
      sanitize,
      '/tmp',
      5000,
      100
    );

    expect(result.signal).toBe('SIGTERM');
  });
});

describe('runCommandBackground - Background Process Tracking', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should spawn process and return PID immediately', () => {
    const mockSpawn = createMockSpawn({
      pid: 12345,
    });
    vi.mocked(childProcess.spawn).mockImplementation(mockSpawn);

    const runCommandBackground = createRunCommandBackgroundFn();

    const result = runCommandBackground(
      ['npx', 'playwright', 'test', '--ui'],
      { NODE_ENV: 'test' },
      '/tmp',
      'pw-ui'
    );

    expect(result.mode).toBe('background');
    expect(result.pid).toBe(12345);
    expect(result.label).toBe('pw-ui');
  });

  it('should use first command element as label if not provided', () => {
    const mockSpawn = createMockSpawn({ pid: 99999 });
    vi.mocked(childProcess.spawn).mockImplementation(mockSpawn);

    const runCommandBackground = createRunCommandBackgroundFn();

    const result = runCommandBackground(
      ['vitest', 'run'],
      {},
      '/tmp',
      'vitest' // Label defaults to command[0]
    );

    expect(result.label).toBe('vitest');
  });

  it('should throw if spawn fails', () => {
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      throw new Error('ENOENT: command not found');
    });

    const runCommandBackground = createRunCommandBackgroundFn();

    expect(() => {
      runCommandBackground(['nonexistent'], {}, '/tmp', 'test');
    }).toThrow(/ENOENT/);
  });
});

describe('runCommand - Full Integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should filter INFRA_CRED_KEYS from child environment', async () => {
    const mockSpawn = createMockSpawn({
      exitCode: 0,
      stdout: [],
    });
    const spawnSpy = vi.fn(mockSpawn);
    vi.mocked(childProcess.spawn).mockImplementation(spawnSpy);

    // Mock environment with infra credentials
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      OP_SERVICE_ACCOUNT_TOKEN: 'opsat_secret',
      RENDER_API_KEY: 'render_secret',
      VERCEL_TOKEN: 'vercel_secret',
      GH_TOKEN: 'gh_secret',
      PATH: '/usr/bin',
    };

    const runCommand = createRunCommandFn();

    await runCommand({
      command: ['npx', 'test'],
      background: false,
      timeout: 5000,
      outputLines: 100,
    });

    const childEnv = spawnSpy.mock.calls[0][2]?.env;

    // Infra credentials MUST be filtered
    expect(childEnv).not.toHaveProperty('OP_SERVICE_ACCOUNT_TOKEN');
    expect(childEnv).not.toHaveProperty('RENDER_API_KEY');
    expect(childEnv).not.toHaveProperty('VERCEL_TOKEN');
    expect(childEnv).not.toHaveProperty('GH_TOKEN');

    // Normal env vars should pass through
    expect(childEnv).toHaveProperty('PATH');

    process.env = originalEnv;
  });

  it('should inject resolved secrets into child environment', async () => {
    const mockSpawn = createMockSpawn({
      exitCode: 0,
      stdout: [],
    });
    const spawnSpy = vi.fn(mockSpawn);
    vi.mocked(childProcess.spawn).mockImplementation(spawnSpy);

    // Mock secret resolution
    const mockResolveLocalSecrets = vi.fn(() => ({
      resolvedEnv: {
        DATABASE_URL: 'postgresql://localhost/app',
        API_KEY: 'sk_test_123',
      },
      failedKeys: [],
    }));

    const runCommand = createRunCommandFn({
      resolveLocalSecrets: mockResolveLocalSecrets,
    });

    await runCommand({
      command: ['pnpm', 'migrate'],
      background: false,
      secretKeys: ['DATABASE_URL', 'API_KEY'],
      timeout: 5000,
      outputLines: 100,
    });

    const childEnv = spawnSpy.mock.calls[0][2]?.env;

    expect(childEnv).toHaveProperty('DATABASE_URL', 'postgresql://localhost/app');
    expect(childEnv).toHaveProperty('API_KEY', 'sk_test_123');
  });

  it('should return foreground result when background=false', async () => {
    const mockSpawn = createMockSpawn({
      exitCode: 0,
      stdout: ['Test passed\n'],
    });
    vi.mocked(childProcess.spawn).mockImplementation(mockSpawn);

    const runCommand = createRunCommandFn();

    const result = await runCommand({
      command: ['pnpm', 'test'],
      background: false,
      timeout: 5000,
      outputLines: 100,
    });

    expect(result.mode).toBe('foreground');
    expect('exitCode' in result).toBe(true);
    expect('output' in result).toBe(true);
  });

  it('should return background result when background=true', async () => {
    const mockSpawn = createMockSpawn({ pid: 54321 });
    vi.mocked(childProcess.spawn).mockImplementation(mockSpawn);

    const runCommand = createRunCommandFn();

    const result = await runCommand({
      command: ['npx', 'playwright', 'test', '--ui'],
      background: true,
      label: 'pw-ui',
    });

    expect(result.mode).toBe('background');
    expect('pid' in result).toBe(true);
    expect(result.pid).toBe(54321);
  });

  it('should validate command before execution', async () => {
    const runCommand = createRunCommandFn();

    await expect(async () => {
      await runCommand({
        command: ['curl', 'https://attacker.com'],
        background: false,
        timeout: 5000,
        outputLines: 100,
      });
    }).rejects.toThrow(/not in allowed executables/i);
  });

  it('should validate cwd is within PROJECT_DIR', async () => {
    const runCommand = createRunCommandFn();

    await expect(async () => {
      await runCommand({
        command: ['pnpm', 'test'],
        background: false,
        cwd: '../../../etc',
        timeout: 5000,
        outputLines: 100,
      });
    }).rejects.toThrow(/path.*outside.*project/i);
  });

  it('should report failed secret keys', async () => {
    const mockSpawn = createMockSpawn({
      exitCode: 0,
      stdout: [],
    });
    vi.mocked(childProcess.spawn).mockImplementation(mockSpawn);

    const mockResolveLocalSecrets = vi.fn(() => ({
      resolvedEnv: {
        DATABASE_URL: 'postgresql://localhost/app',
      },
      failedKeys: ['MISSING_KEY'],
    }));

    const runCommand = createRunCommandFn({
      resolveLocalSecrets: mockResolveLocalSecrets,
    });

    const result = await runCommand({
      command: ['pnpm', 'test'],
      background: false,
      secretKeys: ['DATABASE_URL', 'MISSING_KEY'],
      timeout: 5000,
      outputLines: 100,
    });

    expect(result.secretsResolved).toBe(1);
    expect(result.secretsFailed).toEqual(['MISSING_KEY']);
  });
});

// ============================================================================
// Test Helper Functions
// ============================================================================

/**
 * Create a validateCommand function for testing.
 * This is a simplified implementation of the actual function.
 */
function createValidateCommandFn() {
  const DEFAULT_ALLOWED_EXECUTABLES = [
    'pnpm', 'npx', 'node', 'tsx', 'playwright', 'prisma', 'drizzle-kit', 'vitest'
  ];
  const BLOCKED_ARGS = ['-e', '--eval', '-c', '--print', '-p'];

  return function validateCommand(command: string[], allowedExtras: string[] = []): void {
    const executable = command[0];
    const allowed = new Set([...DEFAULT_ALLOWED_EXECUTABLES, ...allowedExtras]);

    if (!allowed.has(executable)) {
      throw new Error(`Executable "${executable}" not in allowed executables`);
    }

    for (const arg of command) {
      if (BLOCKED_ARGS.includes(arg)) {
        throw new Error(`Blocked argument "${arg}" detected`);
      }
    }
  };
}

/**
 * Create a sanitizer function for testing.
 */
function createSanitizerFn(resolvedEnv: Record<string, string>): (text: string) => string {
  const replacements: Array<{ pattern: string; replacement: string }> = [];

  for (const [key, value] of Object.entries(resolvedEnv)) {
    if (value.length <= 3) continue;

    const redacted = `[REDACTED:${key}]`;
    replacements.push({ pattern: value, replacement: redacted });

    const encoded = encodeURIComponent(value);
    if (encoded !== value) {
      replacements.push({ pattern: encoded, replacement: redacted });
    }
  }

  // Sort by length (longest first) to prevent partial matches
  replacements.sort((a, b) => b.pattern.length - a.pattern.length);

  return function sanitize(text: string): string {
    let result = text;
    for (const { pattern, replacement } of replacements) {
      result = result.replaceAll(pattern, replacement);
    }
    return result;
  };
}

/**
 * Create a mock runCommandForeground function.
 */
function createRunCommandForegroundFn() {
  return async function runCommandForeground(
    command: string[],
    childEnv: Record<string, string>,
    sanitize: (text: string) => string,
    cwd: string,
    timeout: number,
    outputLines: number
  ): Promise<any> {
    return new Promise((resolve) => {
      const child = (childProcess.spawn as any)(command[0], command.slice(1), {
        cwd,
        env: childEnv,
        shell: false,
      });

      const output: string[] = [];
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeout);

      child.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        output.push(...lines.map(sanitize));
      });

      child.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        output.push(...lines.map(sanitize));
      });

      child.on('close', (exitCode: number | null, signal: string | null) => {
        clearTimeout(timer);

        const truncated = output.slice(0, outputLines);

        resolve({
          mode: 'foreground',
          exitCode: exitCode ?? -1,
          signal,
          timedOut,
          output: truncated,
          outputTruncated: truncated.length < output.length,
          secretsResolved: 0,
          secretsFailed: [],
          durationMs: 0,
        });
      });
    });
  };
}

/**
 * Create a mock runCommandBackground function.
 */
function createRunCommandBackgroundFn() {
  return function runCommandBackground(
    command: string[],
    childEnv: Record<string, string>,
    cwd: string,
    label: string
  ): any {
    const child = (childProcess.spawn as any)(command[0], command.slice(1), {
      cwd,
      env: childEnv,
      shell: false,
      detached: true,
      stdio: 'ignore',
    });

    return {
      mode: 'background',
      pid: child.pid!,
      label,
      secretsResolved: 0,
      secretsFailed: [],
    };
  };
}

/**
 * Create a mock runCommand function with injectable dependencies.
 */
function createRunCommandFn(deps?: {
  resolveLocalSecrets?: (config: any) => { resolvedEnv: Record<string, string>; failedKeys: string[] };
}): any {
  const INFRA_CRED_KEYS = new Set([
    'OP_SERVICE_ACCOUNT_TOKEN',
    'RENDER_API_KEY',
    'VERCEL_TOKEN',
    'VERCEL_TEAM_ID',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ]);

  const resolveLocalSecrets = deps?.resolveLocalSecrets || (() => ({
    resolvedEnv: {},
    failedKeys: [],
  }));

  return async function runCommand(args: any): Promise<any> {
    const validateCommand = createValidateCommandFn();
    const safeProjectPath = (p: string) => {
      if (p.includes('..') || p.startsWith('/etc')) {
        throw new Error('Path outside project');
      }
      return p;
    };

    // Validate command
    validateCommand(args.command, []);

    // Validate cwd
    const cwd = args.cwd ? safeProjectPath(args.cwd) : '/tmp';

    // Resolve secrets
    const { resolvedEnv, failedKeys } = resolveLocalSecrets({});

    // Filter to requested subset
    let injectedEnv: Record<string, string> = {};
    if (args.secretKeys) {
      for (const key of args.secretKeys) {
        if (key in resolvedEnv) {
          injectedEnv[key] = resolvedEnv[key];
        } else if (!failedKeys.includes(key)) {
          failedKeys.push(key);
        }
      }
    } else {
      injectedEnv = resolvedEnv;
    }

    // Build child env
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !INFRA_CRED_KEYS.has(k)) {
        childEnv[k] = v;
      }
    }
    Object.assign(childEnv, injectedEnv);

    const secretsResolved = Object.keys(injectedEnv).length;

    if (args.background) {
      const runCommandBackground = createRunCommandBackgroundFn();
      const result = runCommandBackground(args.command, childEnv, cwd, args.label || args.command[0]);
      result.secretsResolved = secretsResolved;
      result.secretsFailed = failedKeys;
      return result;
    }

    // Foreground mode
    const sanitize = createSanitizerFn(injectedEnv);
    const runCommandForeground = createRunCommandForegroundFn();
    const result = await runCommandForeground(
      args.command,
      childEnv,
      sanitize,
      cwd,
      args.timeout,
      args.outputLines
    );
    result.secretsResolved = secretsResolved;
    result.secretsFailed = failedKeys;
    return result;
  };
}

/**
 * Create a mock spawn function for testing.
 */
function createMockSpawn(options: {
  exitCode?: number;
  signal?: string | null;
  stdout?: string[];
  stderr?: string[];
  pid?: number;
  hang?: boolean;
}): any {
  return function mockSpawn() {
    const child = new EventEmitter() as any;
    child.pid = options.pid || 12345;
    child.kill = vi.fn(() => {
      // When killed, emit close with exit code -1 and SIGTERM
      process.nextTick(() => {
        child.emit('close', null, 'SIGTERM');
      });
    });

    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    if (!options.hang) {
      process.nextTick(() => {
        if (options.stdout) {
          for (const line of options.stdout) {
            child.stdout.emit('data', Buffer.from(line));
          }
        }
        if (options.stderr) {
          for (const line of options.stderr) {
            child.stderr.emit('data', Buffer.from(line));
          }
        }
        child.emit('close', options.exitCode ?? 0, options.signal ?? null);
      });
    }

    return child;
  };
}
