#!/usr/bin/env node
/**
 * Generate Protected Actions Spec
 *
 * Reads protected-actions.json and generates a spec file at
 * specs/reference/PROTECTED-ACTIONS.md for agent discovery.
 *
 * Usage:
 *   node scripts/generate-protected-actions-spec.js [--path /project]
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';

// ============================================================================
// Configuration
// ============================================================================

let PROJECT_DIR = process.cwd();

// Parse --path argument
const pathIndex = process.argv.indexOf('--path');
if (pathIndex !== -1 && process.argv[pathIndex + 1]) {
  PROJECT_DIR = path.resolve(process.argv[pathIndex + 1]);
}

const PROTECTED_ACTIONS_PATH = path.join(PROJECT_DIR, '.claude', 'hooks', 'protected-actions.json');
const SPEC_OUTPUT_PATH = path.join(PROJECT_DIR, 'specs', 'reference', 'PROTECTED-ACTIONS.md');

// ============================================================================
// Main
// ============================================================================

function main() {
  // Check if config exists
  if (!fs.existsSync(PROTECTED_ACTIONS_PATH)) {
    console.log('No protected-actions.json found. Skipping spec generation.');
    return;
  }

  // Read config
  let config;
  try {
    config = JSON.parse(fs.readFileSync(PROTECTED_ACTIONS_PATH, 'utf8'));
  } catch (err) {
    console.error(`Error reading protected-actions.json: ${err.message}`);
    process.exit(1);
  }

  const servers = config.servers || {};
  const serverCount = Object.keys(servers).length;

  if (serverCount === 0) {
    console.log('No protected servers configured. Skipping spec generation.');
    return;
  }

  // Generate spec content
  const now = new Date().toISOString();
  let content = `# Protected Actions Specification

> Auto-generated from protected-actions.json
> Last updated: ${now}

## Overview

This document lists all MCP actions that require CTO approval before execution.
When you call a protected action without approval, it will be blocked and you'll
receive a 6-character approval code.

## Approval Workflow

1. **Call protected action** → Blocked with code (e.g., \`A7X9K2\`)
2. **Stop and inform CTO** → Display the approval message
3. **CTO types approval** → e.g., \`APPROVE PROD A7X9K2\`
4. **Retry the action** → Succeeds (one-time use, 5-minute expiry)

## Protected Servers

`;

  // Add each server
  for (const [serverName, serverConfig] of Object.entries(servers)) {
    const tools = serverConfig.tools === '*' ? 'All tools' : serverConfig.tools.join(', ');
    const protection = serverConfig.protection || 'approval-only';

    content += `### ${serverName}

| Property | Value |
|----------|-------|
| **Protection** | ${protection} |
| **Approval Phrase** | \`${serverConfig.phrase}\` |
| **Protected Tools** | ${tools} |
${serverConfig.description ? `| **Description** | ${serverConfig.description} |` : ''}

**To approve:** CTO types \`${serverConfig.phrase} <CODE>\`

---

`;
  }

  // Add usage section
  content += `## Agent Instructions

### Before calling protected actions:
- Use \`mcp__deputy-cto__list_protections()\` to see what's protected
- Be prepared for the action to be blocked

### When action is blocked:
1. Note the 6-character code in the error message
2. Inform the CTO: "Please type: \`{PHRASE} {CODE}\`"
3. **DO NOT retry until CTO confirms approval**
4. After CTO types approval, retry the action

### Checking request status:
- Use \`mcp__deputy-cto__get_protected_action_request({ code: "XXXXXX" })\`
- Status will be "pending" or "approved"

## Security Notes

- **One-time use**: Each approval code can only be used once
- **5-minute expiry**: Approvals expire if not used
- **Human-only**: Only CTO keyboard input can approve (agents cannot forge)
- **Credential isolation**: For \`credential-isolated\` servers, credentials are encrypted and only decrypted upon approval
`;

  // Ensure directory exists
  const specDir = path.dirname(SPEC_OUTPUT_PATH);
  if (!fs.existsSync(specDir)) {
    fs.mkdirSync(specDir, { recursive: true });
  }

  // Write spec file
  fs.writeFileSync(SPEC_OUTPUT_PATH, content);
  console.log(`Generated: ${SPEC_OUTPUT_PATH}`);
  console.log(`Protected servers: ${serverCount}`);
}

main();
