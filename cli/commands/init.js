/**
 * gentyr init - First-time project setup
 *
 * Replaces the install mode of setup.sh. Expects node_modules/gentyr to already
 * exist (via `pnpm link ~/git/gentyr`).
 *
 * @module commands/init
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveFrameworkDir, resolveFrameworkRelative, detectInstallModel } from '../lib/resolve-framework.js';

/** Validate OP token format (alphanumeric + dashes/underscores, no shell metacharacters). */
const SAFE_OP_TOKEN_RE = /^[a-zA-Z0-9_-]{10,}$/;
function isValidOpToken(token) {
  return typeof token === 'string' && SAFE_OP_TOKEN_RE.test(token);
}
import { createDirectorySymlinks, createAgentSymlinks, createReporterSymlinks } from '../lib/symlinks.js';
import { generateMcpJson, mergeSettings, updateClaudeMd, updateGitignore } from '../lib/config-gen.js';
import { buildState, writeState, getFrameworkAgents } from '../lib/state.js';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

/**
 * Parse command-line arguments.
 * @param {string[]} args
 */
function parseArgs(args) {
  const opts = { opToken: '', makerkit: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--op-token' && args[i + 1]) {
      opts.opToken = args[++i];
    } else if (args[i] === '--makerkit') {
      opts.makerkit = 'force';
    } else if (args[i] === '--no-makerkit') {
      opts.makerkit = 'skip';
    }
  }
  return opts;
}

/**
 * Pre-create runtime state files so they exist (user-owned) before protection.
 * @param {string} projectDir
 */
function preCreateStateFiles(projectDir) {
  const claudeDir = path.join(projectDir, '.claude');
  const stateDir = path.join(claudeDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  // JSON state files
  const jsonFiles = [
    path.join(stateDir, 'agent-tracker-history.json'),
    path.join(stateDir, 'antipattern-hunter-state.json'),
    path.join(stateDir, 'schema-mapper-state.json'),
    path.join(stateDir, 'usage-snapshots.json'),
    path.join(claudeDir, 'hourly-automation-state.json'),
    path.join(claudeDir, 'plan-executor-state.json'),
    path.join(claudeDir, 'bypass-approval-token.json'),
    path.join(claudeDir, 'commit-approval-token.json'),
    path.join(claudeDir, 'protection-state.json'),
    path.join(claudeDir, 'protected-action-approvals.json'),
  ];

  for (const file of jsonFiles) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '{}');
  }

  // Autonomous mode with defaults
  const autoMode = path.join(claudeDir, 'autonomous-mode.json');
  if (!fs.existsSync(autoMode)) {
    fs.writeFileSync(autoMode, JSON.stringify({
      enabled: true,
      claudeMdRefactorEnabled: true,
      lintCheckerEnabled: true,
      taskRunnerEnabled: true,
      previewPromotionEnabled: true,
      stagingPromotionEnabled: true,
      stagingHealthMonitorEnabled: true,
      productionHealthMonitorEnabled: true,
      standaloneAntipatternHunterEnabled: true,
      standaloneComplianceCheckerEnabled: true,
      productManagerEnabled: false,
    }, null, 2) + '\n');
  }

  // Vault mappings
  const vaultMappings = path.join(claudeDir, 'vault-mappings.json');
  if (!fs.existsSync(vaultMappings)) {
    fs.writeFileSync(vaultMappings, '{"provider": "1password", "mappings": {}}');
    console.log('  Created vault-mappings.json (configure via /setup-gentyr)');
  }

  // SQLite database files (must exist before protection)
  const dbFiles = [
    path.join(claudeDir, 'todo.db'),
    path.join(claudeDir, 'deputy-cto.db'),
    path.join(claudeDir, 'cto-reports.db'),
    path.join(claudeDir, 'session-events.db'),
  ];

  for (const db of dbFiles) {
    if (!fs.existsSync(db)) fs.writeFileSync(db, '');
    if (!fs.existsSync(db + '-shm')) fs.writeFileSync(db + '-shm', '');
    if (!fs.existsSync(db + '-wal')) fs.writeFileSync(db + '-wal', '');
  }

  // Automation config
  const autoConfig = path.join(stateDir, 'automation-config.json');
  if (!fs.existsSync(autoConfig)) {
    fs.writeFileSync(autoConfig, JSON.stringify({
      version: 1,
      defaults: {
        hourly_tasks: 55, triage_check: 5, antipattern_hunter: 360,
        schema_mapper: 1440, lint_checker: 30, todo_maintenance: 15,
        task_runner: 60, triage_per_item: 60,
      },
      effective: {
        hourly_tasks: 55, triage_check: 5, antipattern_hunter: 360,
        schema_mapper: 1440, lint_checker: 30, todo_maintenance: 15,
        task_runner: 60, triage_per_item: 60,
      },
      adjustment: {
        factor: 1.0, last_updated: null,
        constraining_metric: null, projected_at_reset: null,
      },
    }, null, 2) + '\n');
  }
}

/**
 * Install husky hooks.
 * @param {string} projectDir
 * @param {string} frameworkDir
 */
function installHuskyHooks(projectDir, frameworkDir) {
  const huskyDir = path.join(projectDir, '.husky');
  fs.mkdirSync(huskyDir, { recursive: true });

  for (const hook of ['pre-commit', 'post-commit', 'pre-push']) {
    const src = path.join(frameworkDir, 'husky', hook);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(huskyDir, hook));
      fs.chmodSync(path.join(huskyDir, hook), 0o755);
      console.log(`  Installed .husky/${hook}`);
    }
  }

  // Set git hooks path
  try {
    execFileSync('git', ['config', '--local', 'core.hooksPath', '.husky'], { cwd: projectDir, stdio: 'pipe' });
    console.log('  Set core.hooksPath = .husky');
  } catch {}
}

/**
 * Build framework dependencies and MCP servers.
 * @param {string} frameworkDir
 */
function buildDependencies(frameworkDir) {
  console.log(`\n${YELLOW}Installing hook dependencies...${NC}`);
  try {
    execFileSync('npm', ['install', '--no-fund', '--no-audit'], { cwd: frameworkDir, stdio: 'pipe', timeout: 120000 });
    console.log('  Hook dependencies ready');
  } catch (err) {
    console.log(`  ${YELLOW}Warning: npm install failed: ${err.message}${NC}`);
  }

  console.log(`\n${YELLOW}Building MCP servers...${NC}`);
  const mcpDir = path.join(frameworkDir, 'packages', 'mcp-servers');
  try {
    execFileSync('npm', ['install', '--no-fund', '--no-audit'], { cwd: mcpDir, stdio: 'pipe', timeout: 120000 });
    console.log('  Dependencies installed');
    execFileSync('npm', ['run', 'build'], { cwd: mcpDir, stdio: 'pipe', timeout: 120000 });
    console.log('  TypeScript built');
  } catch (err) {
    console.log(`  ${YELLOW}Warning: MCP server build failed: ${err.message}${NC}`);
  }
}

/**
 * Set up specs directory structure.
 * @param {string} projectDir
 */
function setupSpecs(projectDir) {
  if (fs.existsSync(path.join(projectDir, 'specs'))) {
    console.log('  specs/ directory already exists');
    return;
  }

  for (const sub of ['global', 'local', 'reference']) {
    fs.mkdirSync(path.join(projectDir, 'specs', sub), { recursive: true });
  }

  const coreInvariants = `# Core Invariants

## G001: Fail-Closed Error Handling
All error handling must fail-closed. Never fail-open.

## G003: Input Validation
Validate all external input with Zod schemas.

## G004: No Hardcoded Credentials
Never commit credentials, API keys, or secrets.
`;
  fs.writeFileSync(path.join(projectDir, 'specs', 'global', 'CORE-INVARIANTS.md'), coreInvariants);
  console.log('  Created specs/ directory structure');
}

/**
 * Set up shell profile OP token integration.
 * @param {string} opToken
 */
function setupShellOpToken(opToken) {
  if (!opToken) return;

  if (!isValidOpToken(opToken)) {
    console.log(`  ${YELLOW}Warning: OP token contains invalid characters, skipping shell sync${NC}`);
    return;
  }

  const home = process.env.HOME || '';
  const profiles = [path.join(home, '.zshrc'), path.join(home, '.bashrc')];
  const profile = profiles.find(p => fs.existsSync(p));

  if (!profile) {
    console.log(`  ${YELLOW}No .zshrc or .bashrc found, skipping OP shell sync${NC}`);
    return;
  }

  let content = fs.readFileSync(profile, 'utf8');

  // Remove existing managed block
  content = content.replace(/# BEGIN GENTYR OP[\s\S]*?# END GENTYR OP\n?/g, '');
  // Remove legacy unmanaged exports
  content = content.replace(/^export OP_SERVICE_ACCOUNT_TOKEN=.*\n?/gm, '');
  content = content.replace(/^# 1Password Service Account Token\n?/gm, '');

  // Write managed block
  content += `\n# BEGIN GENTYR OP
# 1Password Service Account Token (managed by GENTYR — do not edit manually)
export OP_SERVICE_ACCOUNT_TOKEN="${opToken}"
# END GENTYR OP\n`;

  fs.writeFileSync(profile, content);
  console.log(`  Synced OP_SERVICE_ACCOUNT_TOKEN to ${profile}`);
}

/**
 * Set up rotation proxy shell integration.
 */
function setupProxyShellIntegration() {
  const home = process.env.HOME || '';
  const profiles = [path.join(home, '.zshrc'), path.join(home, '.bashrc')];
  const profile = profiles.find(p => fs.existsSync(p));

  if (!profile) {
    console.log(`  ${YELLOW}No .zshrc or .bashrc found, skipping shell integration${NC}`);
    return;
  }

  const content = fs.readFileSync(profile, 'utf8');
  if (content.includes('# BEGIN GENTYR PROXY')) {
    console.log(`  Proxy env already in ${profile}`);
    return;
  }

  const block = `
# BEGIN GENTYR PROXY
# Rotation proxy for transparent credential rotation (added by GENTYR)
if curl -sf http://localhost:18080/__health > /dev/null 2>&1; then
  export HTTPS_PROXY=http://localhost:18080
  export HTTP_PROXY=http://localhost:18080
  export NO_PROXY=localhost,127.0.0.1
  export NODE_EXTRA_CA_CERTS="$HOME/.claude/proxy-certs/ca.pem"
fi
# END GENTYR PROXY
`;

  fs.appendFileSync(profile, block);
  console.log(`  Added proxy env to ${profile} (guarded by health check)`);
}

/**
 * Set up automation service.
 * @param {string} frameworkDir
 * @param {string} projectDir
 * @param {string} opToken
 */
function setupAutomationService(frameworkDir, projectDir, opToken) {
  const script = path.join(frameworkDir, 'scripts', 'setup-automation-service.sh');
  if (!fs.existsSync(script)) {
    console.log(`  ${YELLOW}setup-automation-service.sh not found, skipping.${NC}`);
    return;
  }

  const args = ['setup', '--path', projectDir];
  if (opToken) args.push('--op-token', opToken);

  try {
    execFileSync(script, args, { stdio: 'inherit', timeout: 60000 });
  } catch {
    console.log(`  ${YELLOW}Automation service setup failed (non-fatal)${NC}`);
  }
}

/**
 * Generate proxy certificates.
 * @param {string} frameworkDir
 */
function generateProxyCerts(frameworkDir) {
  const script = path.join(frameworkDir, 'scripts', 'generate-proxy-certs.sh');
  if (fs.existsSync(script)) {
    try {
      execFileSync(script, [], { stdio: 'inherit', timeout: 30000 });
    } catch {
      console.log(`  ${YELLOW}Cert generation failed (non-fatal)${NC}`);
    }
  }
}

export default async function init(args) {
  const opts = parseArgs(args);
  const projectDir = process.cwd();

  // Verify framework is linked
  const model = detectInstallModel(projectDir);
  if (!model) {
    console.error(`${RED}Error: GENTYR not found in this project.${NC}`);
    console.error('');
    console.error('To install via npm link:');
    console.error(`  cd ${projectDir}`);
    console.error('  pnpm link ~/git/gentyr');
    console.error('  npx gentyr init');
    process.exit(1);
  }

  const frameworkDir = resolveFrameworkDir(projectDir);
  const frameworkRel = resolveFrameworkRelative(projectDir);
  const agents = getFrameworkAgents(frameworkDir);

  console.log(`${GREEN}Installing GENTYR...${NC}`);
  console.log(`  Model: ${model === 'npm' ? 'node_modules/gentyr (npm)' : '.claude-framework (legacy)'}`);
  console.log('');

  // 1. Symlinks
  console.log(`${YELLOW}Setting up .claude/ directory...${NC}`);
  preCreateStateFiles(projectDir);
  createDirectorySymlinks(projectDir, frameworkRel);
  createAgentSymlinks(projectDir, frameworkRel, agents, { preserveProjectAgents: true });

  // Handle conditional product-manager agent
  const autoMode = path.join(projectDir, '.claude', 'autonomous-mode.json');
  let pmEnabled = false;
  try {
    pmEnabled = JSON.parse(fs.readFileSync(autoMode, 'utf8')).productManagerEnabled === true;
  } catch {}
  const pmPath = path.join(projectDir, '.claude', 'agents', 'product-manager.md');
  if (pmEnabled) {
    const pmTarget = `../../${frameworkRel}/.claude/agents/product-manager.md`;
    try { fs.symlinkSync(pmTarget, pmPath); } catch {}
    console.log('  Symlink: product-manager.md (enabled)');
  } else {
    try { fs.unlinkSync(pmPath); } catch {}
    console.log('  Skipped: product-manager.md (not enabled)');
  }

  // 2. Settings + TESTING.md
  console.log(`\n${YELLOW}Setting up settings.json...${NC}`);
  mergeSettings(projectDir, frameworkDir);

  const testingMdSrc = path.join(frameworkDir, 'TESTING.md');
  const testingMdDst = path.join(projectDir, '.claude', 'TESTING.md');
  try {
    if (fs.existsSync(testingMdSrc)) {
      fs.copyFileSync(testingMdSrc, testingMdDst);
      console.log('  Copied TESTING.md -> .claude/TESTING.md');
    }
  } catch {
    console.log(`  ${YELLOW}Skipped TESTING.md (not writable)${NC}`);
  }

  // 3. MCP config
  console.log(`\n${YELLOW}Generating .mcp.json...${NC}`);
  generateMcpJson(projectDir, frameworkDir, frameworkRel, { opToken: opts.opToken });

  // 3c. Shell profile OP token
  if (opts.opToken) {
    console.log(`\n${YELLOW}Syncing OP_SERVICE_ACCOUNT_TOKEN to shell profile...${NC}`);
    setupShellOpToken(opts.opToken);
  }

  // 4. Husky hooks
  console.log(`\n${YELLOW}Setting up husky hooks...${NC}`);
  installHuskyHooks(projectDir, frameworkDir);

  // 5. Build dependencies
  buildDependencies(frameworkDir);

  // 5b. Generate op-secrets.conf
  const servicesJson = path.join(projectDir, '.claude', 'config', 'services.json');
  if (fs.existsSync(servicesJson)) {
    console.log(`\n${YELLOW}Generating op-secrets.conf...${NC}`);
    try {
      const config = JSON.parse(fs.readFileSync(servicesJson, 'utf8'));
      const local = config?.secrets?.local || {};
      const entries = Object.entries(local);
      if (entries.length > 0) {
        const confFile = config?.local?.confFile || 'op-secrets.conf';
        if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(confFile)) {
          const lines = [
            '# Auto-generated by GENTYR setup',
            '# Contains op:// references only — NOT resolved secret values.',
            `# Generated: ${new Date().toISOString()}`,
            '',
            ...entries.map(([k, v]) => `${k}=${v}`),
            '',
          ];
          fs.writeFileSync(path.join(projectDir, confFile), lines.join('\n'));
          console.log(`  Generated ${confFile} (${entries.length} references)`);
        }
      }
    } catch {}
  }

  // 5c. Proxy certificates
  console.log(`\n${YELLOW}Setting up rotation proxy certificates...${NC}`);
  generateProxyCerts(frameworkDir);

  // 6. Automation service
  console.log(`\n${YELLOW}Setting up automation service...${NC}`);
  setupAutomationService(frameworkDir, projectDir, opts.opToken);

  // 6d. Rotation proxy shell integration
  console.log(`\n${YELLOW}Setting up rotation proxy shell integration...${NC}`);
  setupProxyShellIntegration();

  // 7. Gitignore
  console.log(`\n${YELLOW}Updating .gitignore...${NC}`);
  updateGitignore(projectDir);

  // 7b. Specs directory
  console.log(`\n${YELLOW}Checking specs directory...${NC}`);
  setupSpecs(projectDir);

  // 8. Test failure reporters
  console.log(`\n${YELLOW}Configuring test failure reporters...${NC}`);
  createReporterSymlinks(projectDir, frameworkRel);

  // 9. CLAUDE.md
  console.log(`\n${YELLOW}Updating CLAUDE.md...${NC}`);
  updateClaudeMd(projectDir, frameworkDir);

  // 11. Write sync state
  const state = buildState(frameworkDir, model);
  writeState(projectDir, state);

  // Done
  console.log('');
  console.log(`${GREEN}========================================${NC}`);
  console.log(`${GREEN}GENTYR installed!${NC}`);
  console.log(`${GREEN}========================================${NC}`);
  console.log('');
  console.log(`Framework version: ${state.version}`);
  console.log(`Install model: ${model === 'npm' ? 'node_modules/gentyr' : '.claude-framework'}`);
}
