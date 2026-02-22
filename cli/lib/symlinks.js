/**
 * Symlink creation helpers for GENTYR installation.
 *
 * @module symlinks
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Create a symlink, replacing existing if it points to a different target.
 * If a real directory exists at the link path, backs it up.
 *
 * @param {string} target - Symlink target (relative path)
 * @param {string} linkPath - Absolute path where the symlink should be created
 * @param {object} [opts]
 * @param {boolean} [opts.quiet] - Suppress log output
 * @returns {boolean} true if a new symlink was created
 */
export function safeSymlink(target, linkPath, opts = {}) {
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const existing = fs.readlinkSync(linkPath);
      if (existing === target) return false; // already correct
      fs.unlinkSync(linkPath);
    } else if (stat.isDirectory()) {
      const backupPath = linkPath + '.backup';
      if (!opts.quiet) console.log(`  Moving existing ${path.basename(linkPath)}/ to ${path.basename(linkPath)}.backup/`);
      fs.renameSync(linkPath, backupPath);
    } else {
      fs.unlinkSync(linkPath);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  fs.symlinkSync(target, linkPath);
  return true;
}

/**
 * Create directory symlinks for standard GENTYR shared resources.
 *
 * @param {string} projectDir - Absolute path to the target project
 * @param {string} frameworkRel - Relative framework path ('node_modules/gentyr' or '.claude-framework')
 */
export function createDirectorySymlinks(projectDir, frameworkRel) {
  const claudeDir = path.join(projectDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const dirLinks = [
    { name: 'commands', target: `../${frameworkRel}/.claude/commands` },
    { name: 'hooks', target: `../${frameworkRel}/.claude/hooks` },
    { name: 'mcp', target: `../${frameworkRel}/.claude/mcp` },
    { name: 'docs', target: `../${frameworkRel}/docs/shared` },
  ];

  for (const { name, target } of dirLinks) {
    const linkPath = path.join(claudeDir, name);
    if (safeSymlink(target, linkPath)) {
      console.log(`  Symlink: .claude/${name}`);
    } else {
      console.log(`  Symlink: .claude/${name} (already correct)`);
    }
  }
}

/**
 * Create individual agent file symlinks.
 *
 * @param {string} projectDir - Absolute path to the target project
 * @param {string} frameworkRel - Relative framework path
 * @param {string[]} agents - List of agent filenames (e.g. ['investigator.md', ...])
 * @param {object} [opts]
 * @param {boolean} [opts.preserveProjectAgents] - Don't overwrite non-symlink agents
 */
export function createAgentSymlinks(projectDir, frameworkRel, agents, opts = {}) {
  const agentsDir = path.join(projectDir, '.claude', 'agents');

  // Handle legacy directory symlink
  try {
    const stat = fs.lstatSync(agentsDir);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(agentsDir);
      console.log('  Removed legacy agents directory symlink');
    }
  } catch {}

  fs.mkdirSync(agentsDir, { recursive: true });

  // Back up conflicting project-specific agent files
  if (opts.preserveProjectAgents) {
    for (const agent of agents) {
      const agentPath = path.join(agentsDir, agent);
      try {
        const stat = fs.lstatSync(agentPath);
        if (!stat.isSymbolicLink()) {
          const backupDir = path.join(projectDir, '.claude', 'agents.backup');
          fs.mkdirSync(backupDir, { recursive: true });
          fs.renameSync(agentPath, path.join(backupDir, agent));
          console.log(`  Backed up existing ${agent}`);
        }
      } catch {}
    }
  }

  let created = 0;
  for (const agent of agents) {
    const target = `../../${frameworkRel}/.claude/agents/${agent}`;
    const linkPath = path.join(agentsDir, agent);
    safeSymlink(target, linkPath, { quiet: true });
    created++;
  }
  console.log(`  Symlink: .claude/agents/ (${created} framework agents)`);
}

/**
 * Create reporter symlinks for test frameworks.
 *
 * @param {string} projectDir - Absolute path to the target project
 * @param {string} frameworkRel - Relative framework path
 */
export function createReporterSymlinks(projectDir, frameworkRel) {
  const reportersDir = path.join(projectDir, '.claude', 'reporters');
  fs.mkdirSync(reportersDir, { recursive: true });

  const reporters = [
    { config: 'jest.config', name: 'jest-failure-reporter.js' },
    { config: 'vitest.config', name: 'vitest-failure-reporter.js' },
    { config: 'playwright.config', name: 'playwright-failure-reporter.js' },
  ];

  for (const { config, name } of reporters) {
    // Check for config file with various extensions
    const extensions = ['.js', '.ts', '.mjs'];
    const hasConfig = extensions.some(ext =>
      fs.existsSync(path.join(projectDir, config + ext))
    );
    if (hasConfig) {
      const target = `../../${frameworkRel}/.claude/hooks/reporters/${name}`;
      const linkPath = path.join(reportersDir, name);
      safeSymlink(target, linkPath, { quiet: true });
      console.log(`  Symlink: .claude/reporters/${name}`);
    }
  }

  // Monorepo package reporters
  const packagesDir = path.join(projectDir, 'packages');
  if (fs.existsSync(packagesDir)) {
    try {
      for (const pkg of fs.readdirSync(packagesDir)) {
        const pkgDir = path.join(packagesDir, pkg);
        const hasVitest = ['.js', '.ts', '.mjs'].some(ext =>
          fs.existsSync(path.join(pkgDir, 'vitest.config' + ext))
        );
        if (hasVitest) {
          const pkgReporters = path.join(pkgDir, '.claude', 'reporters');
          fs.mkdirSync(pkgReporters, { recursive: true });
          const target = `../../../../${frameworkRel}/.claude/hooks/reporters/vitest-failure-reporter.js`;
          safeSymlink(target, path.join(pkgReporters, 'vitest-failure-reporter.js'), { quiet: true });
          console.log(`  Symlink: packages/${pkg}/.claude/reporters/vitest-failure-reporter.js`);
        }
      }
    } catch {}
  }
}

/**
 * Remove all GENTYR symlinks from a project.
 *
 * @param {string} projectDir - Absolute path to the target project
 * @param {string[]} agents - List of framework agent filenames
 */
export function removeSymlinks(projectDir, agents) {
  const claudeDir = path.join(projectDir, '.claude');

  // Remove directory symlinks
  for (const name of ['commands', 'hooks', 'mcp', 'docs']) {
    const linkPath = path.join(claudeDir, name);
    try {
      if (fs.lstatSync(linkPath).isSymbolicLink()) {
        fs.unlinkSync(linkPath);
        console.log(`  Removed: .claude/${name}`);
      }
    } catch {}

    // Restore backups
    const backupPath = linkPath + '.backup';
    if (fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, linkPath);
      console.log(`  Restored backup: .claude/${name}`);
    }
  }

  // Remove agent symlinks
  const agentsDir = path.join(claudeDir, 'agents');
  try {
    if (fs.lstatSync(agentsDir).isSymbolicLink()) {
      // Legacy directory symlink
      fs.unlinkSync(agentsDir);
      console.log('  Removed: .claude/agents (legacy directory symlink)');
    } else {
      let removed = 0;
      for (const agent of agents) {
        const agentPath = path.join(agentsDir, agent);
        try {
          if (fs.lstatSync(agentPath).isSymbolicLink()) {
            fs.unlinkSync(agentPath);
            removed++;
          }
        } catch {}
      }
      if (removed > 0) console.log(`  Removed: ${removed} framework agent symlinks`);

      // Remove dir if empty
      try {
        const remaining = fs.readdirSync(agentsDir);
        if (remaining.length === 0) {
          fs.rmdirSync(agentsDir);
          console.log('  Removed empty .claude/agents/');
        } else {
          console.log(`  Preserved: ${remaining.length} project-specific agent(s)`);
        }
      } catch {}
    }
  } catch {}

  // Restore agent backups
  const agentBackup = path.join(claudeDir, 'agents.backup');
  if (fs.existsSync(agentBackup)) {
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const file of fs.readdirSync(agentBackup)) {
      fs.renameSync(path.join(agentBackup, file), path.join(agentsDir, file));
    }
    try { fs.rmdirSync(agentBackup); } catch {}
    console.log('  Restored agents from backup');
  }

  // Remove reporters
  const reportersDir = path.join(claudeDir, 'reporters');
  if (fs.existsSync(reportersDir)) {
    fs.rmSync(reportersDir, { recursive: true });
    console.log('  Removed: .claude/reporters/');
  }

  // Remove monorepo package reporters
  const packagesDir = path.join(projectDir, 'packages');
  if (fs.existsSync(packagesDir)) {
    try {
      for (const pkg of fs.readdirSync(packagesDir)) {
        const pkgReporters = path.join(packagesDir, pkg, '.claude', 'reporters');
        if (fs.existsSync(pkgReporters)) {
          fs.rmSync(pkgReporters, { recursive: true });
          console.log(`  Removed: packages/${pkg}/.claude/reporters/`);
        }
      }
    } catch {}
  }
}
