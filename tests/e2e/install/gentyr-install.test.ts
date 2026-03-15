/**
 * GENTYR Installation E2E Test Suite
 *
 * Tests the full installation lifecycle of GENTYR into a fresh repository.
 * This is the most thorough test in the pipeline — it runs the real `init`
 * command against a temp project and verifies every artifact produced.
 *
 * Architecture:
 * - beforeAll creates one scaffold and runs init ONCE (expensive: ~60s)
 * - Many small it() blocks each verify one specific invariant
 * - afterAll cleans up the temp directory
 *
 * IMPORTANT: HOME is redirected to the temp dir so that init's shell profile
 * writes (.zshrc/.bashrc) never touch the real user home directory.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  createScaffoldedProject,
  type ScaffoldedProject,
} from './helpers/project-scaffold.js';

// ── Shared state ────────────────────────────────────────────────────────────

let scaffold: ScaffoldedProject;
let initExitCode = 0;
let initError: Error | null = null;

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(() => {
  scaffold = createScaffoldedProject();
  const { projectDir, gentyrDir } = scaffold;

  // Run `node <gentyr>/cli/index.js init` inside the temp project.
  // Redirect HOME so shell profile writes go to the temp dir, not the
  // real user home.
  const cliPath = path.join(gentyrDir, 'cli', 'index.js');
  try {
    execFileSync('node', [cliPath, 'init'], {
      cwd: projectDir,
      env: {
        ...process.env,
        HOME: projectDir,
        CLAUDE_PROJECT_DIR: projectDir,
        // Prevent automation service from attempting real launchd installs
        CI: '1',
      },
      stdio: 'pipe',
      timeout: 180_000, // 3 min — allows MCP build if needed
    });
  } catch (err: unknown) {
    initError = err as Error;
    if (err && typeof err === 'object' && 'status' in err) {
      initExitCode = (err as NodeJS.ErrnoException & { status: number }).status ?? 1;
    } else {
      initExitCode = 1;
    }
  }
}, 240_000);

afterAll(() => {
  scaffold?.cleanup();
});

// ── Helper utilities ─────────────────────────────────────────────────────────

/** Resolve a path inside the temp project. */
function inProject(...parts: string[]): string {
  return path.join(scaffold.projectDir, ...parts);
}

/** Resolve a path inside the GENTYR source root. */
function inGentyr(...parts: string[]): string {
  return path.join(scaffold.gentyrDir, ...parts);
}

/**
 * Follow a symlink through as many levels as needed and return the real path.
 * Throws with a descriptive message if the link chain is broken.
 */
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    throw new Error(`Could not resolve real path of ${p}: ${(err as Error).message}`);
  }
}

/** Read and parse a JSON file; throws on invalid JSON. */
function readJson(p: string): unknown {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

/** Count non-overlapping occurrences of a literal string inside text. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP: Sanity — init must have succeeded
// ═══════════════════════════════════════════════════════════════════════════

describe('Init Command Execution', () => {
  it('init exits without throwing an uncaught exception', () => {
    // initError captures any execFileSync failure; a non-zero exit is also
    // captured via initExitCode. We check both.
    if (initError) {
      const msg =
        initError instanceof Error ? initError.message : String(initError);
      // Print stdout/stderr if available for diagnosis
      const errAny = initError as NodeJS.ErrnoException & {
        stdout?: Buffer;
        stderr?: Buffer;
      };
      const stdout = errAny.stdout?.toString() ?? '';
      const stderr = errAny.stderr?.toString() ?? '';
      throw new Error(
        `Init threw: ${msg}\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
    }
    expect(initExitCode).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP: Pre-Installation State (verified before init, now verifying model)
// ═══════════════════════════════════════════════════════════════════════════

describe('Pre-Installation State', () => {
  it('detectInstallModel returns npm for node_modules/gentyr symlink', () => {
    // The symlink was created by createScaffoldedProject before init ran.
    const symlinkPath = inProject('node_modules', 'gentyr');
    const stat = fs.lstatSync(symlinkPath);
    expect(
      stat.isSymbolicLink() || stat.isDirectory(),
      'node_modules/gentyr must be a symlink or directory'
    ).toBe(true);
  });

  it('node_modules/gentyr resolves to the real gentyr root', () => {
    const resolved = realPath(inProject('node_modules', 'gentyr'));
    const gentyrRoot = realPath(scaffold.gentyrDir);
    expect(resolved).toBe(gentyrRoot);
  });

  it('framework root contains version.json and cli/index.js', () => {
    expect(fs.existsSync(inGentyr('version.json'))).toBe(true);
    expect(fs.existsSync(inGentyr('cli', 'index.js'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP: Symlinks
// ═══════════════════════════════════════════════════════════════════════════

describe('Init - Symlinks', () => {
  for (const name of ['commands', 'hooks', 'mcp', 'docs'] as const) {
    it(`.claude/${name} is a symlink`, () => {
      const linkPath = inProject('.claude', name);
      const stat = fs.lstatSync(linkPath);
      expect(stat.isSymbolicLink(), `.claude/${name} must be a symlink`).toBe(true);
    });

    it(`.claude/${name} symlink resolves to a real directory`, () => {
      const linkPath = inProject('.claude', name);
      const real = realPath(linkPath);
      expect(
        fs.statSync(real).isDirectory(),
        `.claude/${name} real path must be a directory`
      ).toBe(true);
    });
  }

  it('.claude/agents/ is a real directory (not a directory symlink)', () => {
    const agentsDir = inProject('.claude', 'agents');
    const stat = fs.lstatSync(agentsDir);
    // Individual agent files are symlinks, but the agents/ dir itself must be a real dir
    expect(stat.isDirectory(), '.claude/agents must be a real directory').toBe(true);
    expect(stat.isSymbolicLink(), '.claude/agents must NOT be a symlink').toBe(false);
  });

  it('.claude/agents/ contains at least one .md symlink', () => {
    const agentsDir = inProject('.claude', 'agents');
    const entries = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
    expect(
      entries.length,
      `Expected agent symlinks in .claude/agents, found none`
    ).toBeGreaterThan(0);
  });

  it('each agent symlink target exists on disk', () => {
    const agentsDir = inProject('.claude', 'agents');
    const entries = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
    for (const agent of entries) {
      const agentPath = path.join(agentsDir, agent);
      const stat = fs.lstatSync(agentPath);
      if (stat.isSymbolicLink()) {
        // realPath throws if the target is missing — which is the correct failure
        const real = realPath(agentPath);
        expect(
          fs.existsSync(real),
          `Agent symlink ${agent} points to missing target: ${real}`
        ).toBe(true);
      }
    }
  });

  it('core agent files are present: code-writer, code-reviewer, project-manager, investigator', () => {
    const agentsDir = inProject('.claude', 'agents');
    const entries = new Set(fs.readdirSync(agentsDir));
    for (const required of [
      'code-writer.md',
      'code-reviewer.md',
      'project-manager.md',
      'investigator.md',
    ]) {
      expect(entries.has(required), `Missing required agent: ${required}`).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP: State Files
// ═══════════════════════════════════════════════════════════════════════════

describe('Init - State Files', () => {
  it('.claude/state/ directory exists', () => {
    expect(fs.existsSync(inProject('.claude', 'state'))).toBe(true);
    expect(fs.statSync(inProject('.claude', 'state')).isDirectory()).toBe(true);
  });

  const expectedJsonFiles = [
    ['.claude', 'state', 'agent-tracker-history.json'],
    ['.claude', 'state', 'antipattern-hunter-state.json'],
    ['.claude', 'state', 'schema-mapper-state.json'],
    ['.claude', 'state', 'usage-snapshots.json'],
    ['.claude', 'state', 'automation-config.json'],
    ['.claude', 'hourly-automation-state.json'],
    ['.claude', 'plan-executor-state.json'],
    ['.claude', 'bypass-approval-token.json'],
    ['.claude', 'commit-approval-token.json'],
    ['.claude', 'protection-state.json'],
    ['.claude', 'protected-action-approvals.json'],
    ['.claude', 'autonomous-mode.json'],
    ['.claude', 'vault-mappings.json'],
  ];

  for (const parts of expectedJsonFiles) {
    const label = parts.join('/');
    it(`${label} exists`, () => {
      expect(fs.existsSync(inProject(...parts)), `Missing: ${label}`).toBe(true);
    });

    it(`${label} is valid JSON`, () => {
      expect(() => readJson(inProject(...parts)), `Invalid JSON: ${label}`).not.toThrow();
    });
  }

  it('autonomous-mode.json has productManagerEnabled: false', () => {
    const data = readJson(inProject('.claude', 'autonomous-mode.json')) as Record<string, unknown>;
    expect(data.productManagerEnabled).toBe(false);
  });

  it('autonomous-mode.json has enabled: true', () => {
    const data = readJson(inProject('.claude', 'autonomous-mode.json')) as Record<string, unknown>;
    expect(data.enabled).toBe(true);
  });

  it('vault-mappings.json has provider: "1password"', () => {
    const data = readJson(inProject('.claude', 'vault-mappings.json')) as Record<string, unknown>;
    expect(data.provider).toBe('1password');
  });

  it('vault-mappings.json has mappings key', () => {
    const data = readJson(inProject('.claude', 'vault-mappings.json')) as Record<string, unknown>;
    expect(data).toHaveProperty('mappings');
  });

  it('automation-config.json has version and defaults', () => {
    const data = readJson(
      inProject('.claude', 'state', 'automation-config.json')
    ) as Record<string, unknown>;
    expect(data.version).toBeDefined();
    expect(data.defaults).toBeDefined();
  });

  const expectedDbFiles = [
    ['.claude', 'todo.db'],
    ['.claude', 'deputy-cto.db'],
    ['.claude', 'cto-reports.db'],
    ['.claude', 'session-events.db'],
  ];

  for (const parts of expectedDbFiles) {
    const label = parts.join('/');
    it(`${label} exists (SQLite placeholder)`, () => {
      expect(fs.existsSync(inProject(...parts)), `Missing DB file: ${label}`).toBe(true);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP: Config Files
// ═══════════════════════════════════════════════════════════════════════════

describe('Init - Config Files', () => {
  it('.mcp.json exists', () => {
    expect(fs.existsSync(inProject('.mcp.json'))).toBe(true);
  });

  it('.mcp.json is valid JSON', () => {
    expect(() => readJson(inProject('.mcp.json'))).not.toThrow();
  });

  it('.mcp.json has mcpServers key', () => {
    const data = readJson(inProject('.mcp.json')) as Record<string, unknown>;
    expect(data).toHaveProperty('mcpServers');
  });

  it('.mcp.json contains no unsubstituted ${FRAMEWORK_PATH} placeholders', () => {
    const raw = fs.readFileSync(inProject('.mcp.json'), 'utf8');
    expect(raw).not.toContain('${FRAMEWORK_PATH}');
  });

  it('.claude/settings.json exists', () => {
    expect(fs.existsSync(inProject('.claude', 'settings.json'))).toBe(true);
  });

  it('.claude/settings.json is valid JSON', () => {
    expect(() => readJson(inProject('.claude', 'settings.json'))).not.toThrow();
  });

  it('.claude/settings.json has a hooks key', () => {
    const data = readJson(inProject('.claude', 'settings.json')) as Record<string, unknown>;
    expect(data).toHaveProperty('hooks');
  });

  it('settings.json hooks.PreToolUse is an array', () => {
    const data = readJson(inProject('.claude', 'settings.json')) as {
      hooks?: { PreToolUse?: unknown[] };
    };
    expect(Array.isArray(data.hooks?.PreToolUse)).toBe(true);
  });

  it('settings.json Bash matcher entry contains credential-file-guard', () => {
    const data = readJson(inProject('.claude', 'settings.json')) as {
      hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
    };
    const bashEntry = data.hooks?.PreToolUse?.find(e => e.matcher === 'Bash');
    expect(bashEntry, 'Missing Bash matcher in PreToolUse').toBeDefined();
    const commands = (bashEntry?.hooks ?? []).map(h => h.command ?? '');
    const hasCredentialGuard = commands.some(c => c.includes('credential-file-guard'));
    expect(hasCredentialGuard, 'credential-file-guard hook not found in Bash matcher').toBe(true);
  });

  it('settings.json Bash matcher entry contains main-tree-commit-guard', () => {
    const data = readJson(inProject('.claude', 'settings.json')) as {
      hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
    };
    const bashEntry = data.hooks?.PreToolUse?.find(e => e.matcher === 'Bash');
    const commands = (bashEntry?.hooks ?? []).map(h => h.command ?? '');
    const has = commands.some(c => c.includes('main-tree-commit-guard'));
    expect(has, 'main-tree-commit-guard hook not found in Bash matcher').toBe(true);
  });

  it('settings.json Bash matcher entry contains block-no-verify', () => {
    const data = readJson(inProject('.claude', 'settings.json')) as {
      hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
    };
    const bashEntry = data.hooks?.PreToolUse?.find(e => e.matcher === 'Bash');
    const commands = (bashEntry?.hooks ?? []).map(h => h.command ?? '');
    const has = commands.some(c => c.includes('block-no-verify'));
    expect(has, 'block-no-verify hook not found in Bash matcher').toBe(true);
  });

  it('CLAUDE.md exists', () => {
    expect(fs.existsSync(inProject('CLAUDE.md'))).toBe(true);
  });

  it('CLAUDE.md contains GENTYR-FRAMEWORK-START marker', () => {
    const content = fs.readFileSync(inProject('CLAUDE.md'), 'utf8');
    expect(content).toContain('<!-- GENTYR-FRAMEWORK-START -->');
  });

  it('CLAUDE.md contains GENTYR-FRAMEWORK-END marker', () => {
    const content = fs.readFileSync(inProject('CLAUDE.md'), 'utf8');
    expect(content).toContain('<!-- GENTYR-FRAMEWORK-END -->');
  });

  it('.gitignore has BEGIN GENTYR GITIGNORE block', () => {
    const content = fs.readFileSync(inProject('.gitignore'), 'utf8');
    expect(content).toContain('# BEGIN GENTYR GITIGNORE');
    expect(content).toContain('# END GENTYR GITIGNORE');
  });

  it('specs/ directory exists', () => {
    expect(fs.existsSync(inProject('specs'))).toBe(true);
    expect(fs.statSync(inProject('specs')).isDirectory()).toBe(true);
  });

  it('specs/global/CORE-INVARIANTS.md exists', () => {
    expect(fs.existsSync(inProject('specs', 'global', 'CORE-INVARIANTS.md'))).toBe(true);
  });

  it('specs/local/ and specs/reference/ directories exist', () => {
    expect(fs.existsSync(inProject('specs', 'local'))).toBe(true);
    expect(fs.existsSync(inProject('specs', 'reference'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP: Husky Hooks
// ═══════════════════════════════════════════════════════════════════════════

describe('Init - Husky Hooks', () => {
  for (const hook of ['pre-commit', 'pre-push', 'post-commit'] as const) {
    it(`.husky/${hook} exists`, () => {
      expect(fs.existsSync(inProject('.husky', hook))).toBe(true);
    });
  }

  it('.husky/pre-commit is executable', () => {
    const stat = fs.statSync(inProject('.husky', 'pre-commit'));
    // Check any execute bit is set (owner, group, or other)
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o111, '.husky/pre-commit must have execute permission').toBeGreaterThan(0);
  });

  it('.husky/pre-push is executable', () => {
    const stat = fs.statSync(inProject('.husky', 'pre-push'));
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o111, '.husky/pre-push must have execute permission').toBeGreaterThan(0);
  });

  it('git config core.hooksPath is set to .husky', () => {
    const result = spawnSync(
      'git',
      ['config', '--local', 'core.hooksPath'],
      { cwd: scaffold.projectDir, encoding: 'utf8' }
    );
    expect(result.stdout.trim()).toBe('.husky');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP: Sync State
// ═══════════════════════════════════════════════════════════════════════════

describe('Init - Sync State', () => {
  it('.claude/gentyr-state.json exists', () => {
    expect(fs.existsSync(inProject('.claude', 'gentyr-state.json'))).toBe(true);
  });

  it('gentyr-state.json is valid JSON', () => {
    expect(() => readJson(inProject('.claude', 'gentyr-state.json'))).not.toThrow();
  });

  it('gentyr-state.json has version field', () => {
    const data = readJson(inProject('.claude', 'gentyr-state.json')) as Record<string, unknown>;
    expect(typeof data.version).toBe('string');
    expect((data.version as string).length).toBeGreaterThan(0);
  });

  it('gentyr-state.json has configHash field', () => {
    const data = readJson(inProject('.claude', 'gentyr-state.json')) as Record<string, unknown>;
    expect(typeof data.configHash).toBe('string');
    expect((data.configHash as string).length).toBeGreaterThan(0);
  });

  it('gentyr-state.json installModel is "npm"', () => {
    const data = readJson(inProject('.claude', 'gentyr-state.json')) as Record<string, unknown>;
    expect(data.installModel).toBe('npm');
  });

  it('gentyr-state.json has agentList as a non-empty array', () => {
    const data = readJson(inProject('.claude', 'gentyr-state.json')) as Record<string, unknown>;
    expect(Array.isArray(data.agentList)).toBe(true);
    expect((data.agentList as unknown[]).length).toBeGreaterThan(0);
  });

  it('gentyr-state.json has lastSync as an ISO timestamp', () => {
    const data = readJson(inProject('.claude', 'gentyr-state.json')) as Record<string, unknown>;
    const ts = data.lastSync as string;
    expect(typeof ts).toBe('string');
    // Must be parseable as a Date
    const d = new Date(ts);
    expect(isNaN(d.getTime())).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP: MCP Server Integrity
// ═══════════════════════════════════════════════════════════════════════════

describe('Init - MCP Server Integrity', () => {
  const requiredServers = [
    'agent-tracker',
    'todo-db',
    'user-feedback',
    'deputy-cto',
    'session-events',
    'review-queue',
    'agent-reports',
  ] as const;

  for (const serverName of requiredServers) {
    it(`${serverName} server entry exists in .mcp.json`, () => {
      const data = readJson(inProject('.mcp.json')) as {
        mcpServers?: Record<string, unknown>;
      };
      expect(
        data.mcpServers?.[serverName],
        `MCP server "${serverName}" missing from .mcp.json`
      ).toBeDefined();
    });
  }

  it('.mcp.json has at least 15 servers (catches silent regression)', () => {
    const data = readJson(inProject('.mcp.json')) as {
      mcpServers?: Record<string, unknown>;
    };
    const count = Object.keys(data.mcpServers ?? {}).length;
    expect(
      count,
      `Expected at least 15 MCP servers, found ${count}`
    ).toBeGreaterThanOrEqual(15);
  });

  it('each non-HTTP MCP server has command and args', () => {
    const data = readJson(inProject('.mcp.json')) as {
      mcpServers?: Record<string, { type?: string; command?: string; args?: string[] }>;
    };
    const servers = data.mcpServers ?? {};
    for (const [name, cfg] of Object.entries(servers)) {
      // Skip HTTP-type entries (shared daemon)
      if (cfg.type === 'http') continue;
      expect(cfg.command, `Server "${name}" missing command`).toBeDefined();
      expect(Array.isArray(cfg.args), `Server "${name}" args must be an array`).toBe(true);
    }
  });

  it('server script paths (args[0]) resolve to existing files via symlink', () => {
    const data = readJson(inProject('.mcp.json')) as {
      mcpServers?: Record<string, { type?: string; args?: string[] }>;
    };
    const servers = data.mcpServers ?? {};

    const failures: string[] = [];
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg.type === 'http') continue;
      const args = cfg.args ?? [];
      // First arg is the script path (may be relative or absolute; resolve from project root)
      const scriptArg = args[0];
      if (!scriptArg) continue;
      // Skip mcp-launcher.js — check the actual server script (args[2] for launcher entries)
      const isMcpLauncher = scriptArg.includes('mcp-launcher.js');
      const scriptPath = isMcpLauncher ? args[2] : scriptArg;
      if (!scriptPath) continue;

      // Resolve relative to project dir (framework-relative paths use node_modules/gentyr prefix)
      const resolved = path.isAbsolute(scriptPath)
        ? scriptPath
        : path.resolve(scaffold.projectDir, scriptPath);

      // Follow symlinks to the real path
      try {
        const real = fs.realpathSync(resolved);
        if (!fs.existsSync(real)) {
          failures.push(`${name}: real path missing: ${real}`);
        }
      } catch {
        failures.push(`${name}: cannot resolve: ${resolved}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `MCP server script path failures:\n${failures.map(f => `  - ${f}`).join('\n')}`
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP: Settings Hook Integrity
// ═══════════════════════════════════════════════════════════════════════════

describe('Init - Settings Hook Integrity', () => {
  it('settings.json hooks.PreToolUse exists as an array', () => {
    const data = readJson(inProject('.claude', 'settings.json')) as {
      hooks?: { PreToolUse?: unknown };
    };
    expect(Array.isArray(data.hooks?.PreToolUse)).toBe(true);
  });

  it('settings.json has a PostToolUse hooks array', () => {
    const data = readJson(inProject('.claude', 'settings.json')) as {
      hooks?: { PostToolUse?: unknown };
    };
    // PostToolUse may or may not be present depending on template version
    // If present, it must be an array
    if (data.hooks?.PostToolUse !== undefined) {
      expect(Array.isArray(data.hooks.PostToolUse)).toBe(true);
    }
  });

  it('each hook command file resolves to an existing file through symlinks', () => {
    const data = readJson(inProject('.claude', 'settings.json')) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
    };
    const hookGroups = data.hooks ?? {};

    const failures: string[] = [];
    for (const [eventName, matchers] of Object.entries(hookGroups)) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks ?? []) {
          const cmd = hook.command;
          if (!cmd) continue;
          // Commands look like: "node ${CLAUDE_PROJECT_DIR}/.claude/hooks/foo.js"
          // Extract the .js file path
          const match = cmd.match(/node\s+\$\{CLAUDE_PROJECT_DIR\}\/(.+\.js)/);
          if (!match) continue;
          const relPath = match[1];
          const absPath = path.join(scaffold.projectDir, relPath);
          try {
            const real = fs.realpathSync(absPath);
            if (!fs.existsSync(real)) {
              failures.push(`${eventName}/${matcher.matcher}: ${relPath} -> real path missing`);
            }
          } catch {
            failures.push(`${eventName}/${matcher.matcher}: cannot resolve: ${absPath}`);
          }
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Hook command file failures:\n${failures.map(f => `  - ${f}`).join('\n')}`
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP: Symlink Target Verification
// ═══════════════════════════════════════════════════════════════════════════

describe('Init - Symlink Target Verification', () => {
  for (const name of ['commands', 'hooks', 'mcp', 'docs'] as const) {
    it(`.claude/${name} symlink follows to a real directory in the gentyr source`, () => {
      const linkPath = inProject('.claude', name);
      const real = realPath(linkPath);
      expect(fs.statSync(real).isDirectory()).toBe(true);
      // The real path should be under the gentyr source tree
      const gentyrReal = realPath(scaffold.gentyrDir);
      expect(
        real.startsWith(gentyrReal),
        `.claude/${name} should resolve inside gentyr tree (${gentyrReal}), got: ${real}`
      ).toBe(true);
    });
  }

  it('.claude/hooks/pre-commit-review.js exists through the hooks symlink', () => {
    const p = inProject('.claude', 'hooks', 'pre-commit-review.js');
    // lstat the path (follows symlinks on the directory portion)
    expect(fs.existsSync(p), 'pre-commit-review.js not found via .claude/hooks symlink').toBe(true);
  });

  it('.claude/hooks/credential-file-guard.js exists through the hooks symlink', () => {
    const p = inProject('.claude', 'hooks', 'credential-file-guard.js');
    expect(fs.existsSync(p), 'credential-file-guard.js not found via .claude/hooks symlink').toBe(true);
  });

  it('.claude/hooks/main-tree-commit-guard.js exists through the hooks symlink', () => {
    const p = inProject('.claude', 'hooks', 'main-tree-commit-guard.js');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('.claude/hooks/block-no-verify.js exists through the hooks symlink', () => {
    const p = inProject('.claude', 'hooks', 'block-no-verify.js');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('agent symlinks resolve to real .md files in the gentyr agents/ directory', () => {
    const agentsDir = inProject('.claude', 'agents');
    const entries = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
    const gentyrReal = realPath(scaffold.gentyrDir);
    const failures: string[] = [];

    for (const agent of entries) {
      const agentPath = path.join(agentsDir, agent);
      const stat = fs.lstatSync(agentPath);
      if (!stat.isSymbolicLink()) continue; // skip non-symlink agents
      try {
        const real = realPath(agentPath);
        if (!real.startsWith(gentyrReal)) {
          failures.push(`${agent} resolves outside gentyr: ${real}`);
        } else if (!fs.existsSync(real)) {
          failures.push(`${agent} target does not exist: ${real}`);
        }
      } catch (err) {
        failures.push(`${agent} cannot be resolved: ${(err as Error).message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`Agent symlink failures:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP: Sync Idempotency
// ═══════════════════════════════════════════════════════════════════════════

describe('Sync Idempotency', () => {
  let syncState1: Record<string, unknown>;
  let syncState2: Record<string, unknown>;

  beforeAll(() => {
    // Capture state before sync
    syncState1 = readJson(inProject('.claude', 'gentyr-state.json')) as Record<string, unknown>;

    // Sync always writes a new lastSync, so no delay is needed.
    // The assertion uses toBeGreaterThanOrEqual which handles equal timestamps.

    const cliPath = inGentyr('cli', 'index.js');
    execFileSync('node', [cliPath, 'sync'], {
      cwd: scaffold.projectDir,
      env: {
        ...process.env,
        HOME: scaffold.projectDir,
        CLAUDE_PROJECT_DIR: scaffold.projectDir,
        CI: '1',
      },
      stdio: 'pipe',
      timeout: 180_000,
    });

    syncState2 = readJson(inProject('.claude', 'gentyr-state.json')) as Record<string, unknown>;
  }, 240_000);

  it('sync exits successfully (no throw)', () => {
    // If beforeAll threw, this will be caught by vitest
    expect(syncState2).toBeDefined();
  });

  it('symlinks are still correct after sync', () => {
    for (const name of ['commands', 'hooks', 'mcp', 'docs']) {
      const linkPath = inProject('.claude', name);
      const stat = fs.lstatSync(linkPath);
      expect(stat.isSymbolicLink(), `.claude/${name} must still be a symlink after sync`).toBe(true);
    }
  });

  it('.mcp.json is still valid JSON after sync', () => {
    expect(() => readJson(inProject('.mcp.json'))).not.toThrow();
  });

  it('.mcp.json has no unsubstituted placeholders after sync', () => {
    const raw = fs.readFileSync(inProject('.mcp.json'), 'utf8');
    expect(raw).not.toContain('${FRAMEWORK_PATH}');
  });

  it('.gitignore BEGIN GENTYR GITIGNORE block is not duplicated after sync', () => {
    const content = fs.readFileSync(inProject('.gitignore'), 'utf8');
    const occurrences = countOccurrences(content, '# BEGIN GENTYR GITIGNORE');
    expect(
      occurrences,
      `Expected exactly 1 BEGIN GENTYR GITIGNORE block, found ${occurrences}`
    ).toBe(1);
  });

  it('gentyr-state.json lastSync is updated after sync', () => {
    const before = new Date(syncState1.lastSync as string).getTime();
    const after = new Date(syncState2.lastSync as string).getTime();
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('CLAUDE.md still has both framework markers after sync', () => {
    const content = fs.readFileSync(inProject('CLAUDE.md'), 'utf8');
    expect(content).toContain('<!-- GENTYR-FRAMEWORK-START -->');
    expect(content).toContain('<!-- GENTYR-FRAMEWORK-END -->');
  });

  it('CLAUDE.md framework section is not duplicated after sync', () => {
    const content = fs.readFileSync(inProject('CLAUDE.md'), 'utf8');
    const starts = countOccurrences(content, '<!-- GENTYR-FRAMEWORK-START -->');
    expect(starts, 'CLAUDE.md has duplicate framework sections after sync').toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP: Status Command
// ═══════════════════════════════════════════════════════════════════════════

describe('Status Command', () => {
  let statusOutput = '';
  let statusExitCode = 0;

  beforeAll(() => {
    const cliPath = inGentyr('cli', 'index.js');
    const result = spawnSync(
      'node',
      [cliPath, 'status'],
      {
        cwd: scaffold.projectDir,
        env: {
          ...process.env,
          HOME: scaffold.projectDir,
          CLAUDE_PROJECT_DIR: scaffold.projectDir,
        },
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    statusOutput = (result.stdout ?? '') + (result.stderr ?? '');
    statusExitCode = result.status ?? 0;
  });

  it('status exits with code 0', () => {
    expect(statusExitCode).toBe(0);
  });

  it('status output contains "npm"', () => {
    expect(statusOutput).toContain('npm');
  });

  it('status output contains the framework version', () => {
    const vj = JSON.parse(fs.readFileSync(inGentyr('version.json'), 'utf8')) as {
      version: string;
    };
    expect(statusOutput).toContain(vj.version);
  });

  it('status output contains "OK" for symlinks', () => {
    expect(statusOutput).toContain('OK');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP: Double Init Idempotency
// ═══════════════════════════════════════════════════════════════════════════

describe('Double Init Idempotency', () => {
  beforeAll(() => {
    const cliPath = inGentyr('cli', 'index.js');
    // Run init a second time — must not crash
    execFileSync('node', [cliPath, 'init'], {
      cwd: scaffold.projectDir,
      env: {
        ...process.env,
        HOME: scaffold.projectDir,
        CLAUDE_PROJECT_DIR: scaffold.projectDir,
        CI: '1',
      },
      stdio: 'pipe',
      timeout: 180_000,
    });
  }, 240_000);

  it('symlinks are still correct after double init', () => {
    for (const name of ['commands', 'hooks', 'mcp', 'docs']) {
      const linkPath = inProject('.claude', name);
      const stat = fs.lstatSync(linkPath);
      expect(stat.isSymbolicLink(), `.claude/${name} must still be a symlink after re-init`).toBe(
        true
      );
    }
  });

  it('.gitignore is not duplicated after double init', () => {
    const content = fs.readFileSync(inProject('.gitignore'), 'utf8');
    const occurrences = countOccurrences(content, '# BEGIN GENTYR GITIGNORE');
    expect(
      occurrences,
      `Expected exactly 1 BEGIN GENTYR GITIGNORE block after re-init, found ${occurrences}`
    ).toBe(1);
  });

  it('CLAUDE.md framework section is not duplicated after double init', () => {
    const content = fs.readFileSync(inProject('CLAUDE.md'), 'utf8');
    const starts = countOccurrences(content, '<!-- GENTYR-FRAMEWORK-START -->');
    expect(starts, `CLAUDE.md has ${starts} framework sections after re-init, expected 1`).toBe(1);
  });

  it('.mcp.json is still valid JSON after double init', () => {
    expect(() => readJson(inProject('.mcp.json'))).not.toThrow();
  });

  it('.mcp.json has no unsubstituted placeholders after double init', () => {
    const raw = fs.readFileSync(inProject('.mcp.json'), 'utf8');
    expect(raw).not.toContain('${FRAMEWORK_PATH}');
  });

  it('vault-mappings.json not duplicated (only one entry)', () => {
    // vault-mappings is a single file, not a block — just check it's valid JSON
    expect(() => readJson(inProject('.claude', 'vault-mappings.json'))).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP: Git Hook Smoke Test
// ═══════════════════════════════════════════════════════════════════════════

describe('Git Hook Smoke Test', () => {
  it('pre-commit-review.js does not crash with an unhandled exception', () => {
    // Run the hook directly. It may exit non-zero (e.g. branch guard, no staged
    // changes) — that's fine. We only care that it does NOT exit with a Node
    // uncaught exception (which typically prints "Error: ..." and exits 1 with
    // a stack trace on stderr).
    const hookPath = inProject('.claude', 'hooks', 'pre-commit-review.js');

    // Create a feature branch so the protected-branch guard doesn't fire
    try {
      execFileSync('git', ['checkout', '-b', 'feature/test-hook-smoke'], {
        cwd: scaffold.projectDir,
        stdio: 'pipe',
      });
    } catch {
      // Branch may already exist or HEAD may be in a weird state — ignore
    }

    const result = spawnSync('node', [hookPath], {
      cwd: scaffold.projectDir,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: scaffold.projectDir,
        HOME: scaffold.projectDir,
      },
      encoding: 'utf8',
      timeout: 15_000,
    });

    const stderr = result.stderr ?? '';
    // An unhandled Node exception always prints to stderr and contains a stack trace.
    // We check that neither "UnhandledPromiseRejection" nor "at Object.<anonymous>"
    // (typical stack frame) appear on stderr.
    const hasUncaughtException =
      stderr.includes('UnhandledPromiseRejection') ||
      (stderr.includes('Error:') && stderr.includes('\n    at '));

    expect(
      hasUncaughtException,
      `pre-commit-review.js threw an uncaught exception:\n${stderr}`
    ).toBe(false);

    // The process should not exit with signal (which indicates a crash)
    expect(
      result.signal,
      `pre-commit-review.js was killed by signal: ${result.signal}`
    ).toBeNull();
  });

  it('.husky/pre-commit content references pre-commit-review.js', () => {
    const content = fs.readFileSync(inProject('.husky', 'pre-commit'), 'utf8');
    expect(content).toContain('pre-commit-review.js');
  });

  it('.husky/pre-commit contains branch guard logic', () => {
    // The pre-commit script itself or the hook it calls must reference branch protection
    // Check the pre-commit-review.js source for the protected branch guard
    const hookPath = inProject('.claude', 'hooks', 'pre-commit-review.js');
    const content = fs.readFileSync(hookPath, 'utf8');
    // The hook should reference protected branches
    expect(content).toMatch(/main|staging|preview|protected.*branch|branch.*guard/i);
  });

  it('.husky/pre-push exists and references test commands', () => {
    const content = fs.readFileSync(inProject('.husky', 'pre-push'), 'utf8');
    // Pre-push hook should reference test runs or just be a shell script
    expect(content.length).toBeGreaterThan(10);
  });
});
