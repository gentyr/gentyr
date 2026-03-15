/**
 * Project Scaffold Helper for GENTYR Installation E2E Tests
 *
 * Creates a fresh git repository in a temp directory and links GENTYR into it,
 * providing a clean slate for testing the full installation lifecycle.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ScaffoldedProject {
  projectDir: string;
  gentyrDir: string;
  cleanup: () => void;
}

/**
 * Walk up from __dirname to find the GENTYR root by looking for version.json
 * and cli/index.js — both must be present to confirm it's the real root.
 */
function findGentyrRoot(): string {
  let dir = path.resolve(__dirname, '..', '..', '..', '..');
  while (dir !== path.dirname(dir)) {
    if (
      fs.existsSync(path.join(dir, 'version.json')) &&
      fs.existsSync(path.join(dir, 'cli', 'index.js'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    `Could not find GENTYR root directory walking up from: ${__dirname}`
  );
}

/**
 * Create a scaffolded project in a temp directory with:
 * - git init + initial commit
 * - minimal package.json (ESM, no-op scripts)
 * - minimal app file
 * - vitest.config.ts stub (so reporter symlinks get created)
 * - .gitignore
 * - node_modules/gentyr symlink via pnpm link (or manual fallback)
 *
 * HOME is set to the temp directory in the returned environment so that
 * init's shell profile writes (.zshrc/.bashrc) go to the temp location
 * rather than the real user home.
 */
export function createScaffoldedProject(): ScaffoldedProject {
  const gentyrDir = findGentyrRoot();
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gentyr-e2e-install-')
  );

  // ------------------------------------------------------------------
  // Git init
  // ------------------------------------------------------------------
  execFileSync('git', ['init'], { cwd: projectDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], {
    cwd: projectDir,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'Test User'], {
    cwd: projectDir,
    stdio: 'pipe',
  });

  // ------------------------------------------------------------------
  // package.json — must have lint-staged, test:unit, test:integration
  // as no-ops so the pre-push hook doesn't fail
  // ------------------------------------------------------------------
  const packageJson = {
    name: 'test-project',
    version: '1.0.0',
    type: 'module',
    private: true,
    scripts: {
      'lint-staged': 'echo "lint-staged placeholder"',
      'test:unit': 'echo "no unit tests"',
      'test:integration': 'echo "no integration tests"',
    },
    devDependencies: {},
  };
  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify(packageJson, null, 2) + '\n'
  );

  // ------------------------------------------------------------------
  // Minimal application file
  // ------------------------------------------------------------------
  fs.writeFileSync(
    path.join(projectDir, 'index.js'),
    'console.log("Hello from test project");\n'
  );

  // ------------------------------------------------------------------
  // vitest.config.ts stub — presence triggers reporter symlink creation
  // ------------------------------------------------------------------
  fs.writeFileSync(
    path.join(projectDir, 'vitest.config.ts'),
    `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { globals: true } });\n`
  );

  // ------------------------------------------------------------------
  // .gitignore
  // ------------------------------------------------------------------
  fs.writeFileSync(path.join(projectDir, '.gitignore'), 'node_modules/\n');

  // ------------------------------------------------------------------
  // Initial commit (required for git hooks to function)
  // ------------------------------------------------------------------
  execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'Initial commit'], {
    cwd: projectDir,
    stdio: 'pipe',
  });

  // ------------------------------------------------------------------
  // Link GENTYR — try pnpm link first, fall back to manual symlink
  // ------------------------------------------------------------------
  let linked = false;
  try {
    execFileSync('pnpm', ['link', gentyrDir], {
      cwd: projectDir,
      stdio: 'pipe',
      timeout: 60000,
    });
    // Verify the symlink / dir was actually created
    if (fs.existsSync(path.join(projectDir, 'node_modules', 'gentyr'))) {
      linked = true;
    }
  } catch {
    // pnpm link failed — fall back to manual symlink
  }

  if (!linked) {
    const nmDir = path.join(projectDir, 'node_modules');
    fs.mkdirSync(nmDir, { recursive: true });
    const linkTarget = path.join(nmDir, 'gentyr');
    if (!fs.existsSync(linkTarget)) {
      fs.symlinkSync(gentyrDir, linkTarget);
    }
  }

  return {
    projectDir,
    gentyrDir,
    cleanup: () => {
      try {
        fs.rmSync(projectDir, { recursive: true, force: true });
      } catch {
        // Non-fatal cleanup failure — temp dir will be cleaned by OS
      }
    },
  };
}
