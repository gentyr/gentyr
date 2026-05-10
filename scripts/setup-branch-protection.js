#!/usr/bin/env node
/**
 * Setup GitHub branch protection rules for the merge chain.
 *
 * Configures required status checks per branch:
 * - preview: requires "CI" check
 * - staging: requires "CI" + "Validate Merge Chain"
 * - main: requires "CI" + "Validate Merge Chain" + "Security Scan"
 *
 * Usage: node scripts/setup-branch-protection.js --path /path/to/project
 *
 * @module scripts/setup-branch-protection
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

/**
 * Parse command-line arguments.
 * @param {string[]} args
 * @returns {{ projectDir: string }}
 */
function parseArgs(args) {
  let projectDir = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' && args[i + 1]) {
      projectDir = path.resolve(args[++i]);
    }
  }
  return { projectDir };
}

/**
 * Detect the GitHub repo slug (owner/repo) from git remote.
 * @param {string} cwd
 * @returns {string|null}
 */
function detectRepoSlug(cwd) {
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10000,
    }).trim();

    // Handle SSH: git@github.com:owner/repo.git
    const sshMatch = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (sshMatch) return sshMatch[1].replace(/\.git$/, '');

    // Handle HTTPS: https://github.com/owner/repo.git
    const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^/.]+)/);
    if (httpsMatch) return httpsMatch[1].replace(/\.git$/, '');

    return null;
  } catch {
    return null;
  }
}

/**
 * Configure branch protection for a single branch.
 * @param {string} slug - owner/repo
 * @param {string} branch
 * @param {string[]} requiredChecks
 */
function configureBranchProtection(slug, branch, requiredChecks, options = {}) {
  const payload = JSON.stringify({
    required_status_checks: {
      strict: true,
      contexts: requiredChecks,
    },
    enforce_admins: options.enforceAdmins || false,
    required_pull_request_reviews: null,
    restrictions: null,
  });

  try {
    execFileSync('gh', [
      'api',
      `repos/${slug}/branches/${branch}/protection`,
      '-X', 'PUT',
      '--input', '-',
    ], {
      input: payload,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    console.log(`  ${GREEN}${branch}${NC}: required checks = [${requiredChecks.join(', ')}]`);
  } catch (err) {
    const stderr = err.stderr || '';
    if (stderr.includes('Branch not found') || stderr.includes('Not Found')) {
      console.log(`  ${YELLOW}${branch}${NC}: branch does not exist yet (skipped)`);
    } else {
      console.log(`  ${YELLOW}${branch}${NC}: failed to configure (${stderr.trim() || err.message})`);
    }
  }
}

function main() {
  const { projectDir } = parseArgs(process.argv.slice(2));

  console.log(`${GREEN}Configuring branch protection...${NC}`);

  const slug = detectRepoSlug(projectDir);
  if (!slug) {
    console.log(`  ${YELLOW}Could not detect GitHub repo slug from git remote (skipped)${NC}`);
    return;
  }

  console.log(`  Repo: ${slug}`);

  configureBranchProtection(slug, 'preview', ['CI']);
  configureBranchProtection(slug, 'staging', ['CI', 'Validate Merge Chain'], { enforceAdmins: true });
  configureBranchProtection(slug, 'main', ['CI', 'Validate Merge Chain', 'Security Scan']);

  console.log(`${GREEN}Branch protection configured.${NC}`);
}

main();
