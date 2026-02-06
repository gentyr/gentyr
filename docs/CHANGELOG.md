# GENTYR Framework Changelog

## 2026-02-03 - CTO Approval System for MCP Actions

### Added

**Protected MCP Action Gate**
- New PreToolUse hook: `protected-action-gate.js` - Blocks protected MCP actions until CTO approval
- New UserPromptSubmit hook: `protected-action-approval-hook.js` - Processes CTO approval phrases
- Configuration file: `protected-actions.json.template` - Maps approval phrases to MCP tools
- Approval utilities library: `.claude/hooks/lib/approval-utils.js` - Encryption, code generation, validation

**CLI Utilities**
- `scripts/encrypt-credential.js` - Encrypt credentials for protected-actions.json
- `scripts/generate-protected-actions-spec.js` - Auto-generate spec file from config

**Deputy-CTO MCP Tools**
- `mcp__deputy-cto__list_protections` - List all protected MCP actions and their approval phrases
- `mcp__deputy-cto__get_protected_action_request` - Get details of pending approval request by code

**Setup Script Integration**
- Added `--protect-mcp` flag to setup.sh for protecting MCP action config files
- Protection includes: `protected-actions.json`, `protected-action-approvals.json`

**Agent Instructions**
- Updated `CLAUDE.md.gentyr-section` with CTO-Protected Actions workflow section
- Agents now instructed to stop and wait for CTO approval when actions are blocked

### Security Fixes

**G001 Fail-Closed Compliance**
- Fixed fail-open vulnerability in protected-action-gate.js
- Now properly fails closed when config is missing or invalid
- Added explicit error handling for all edge cases

**Cryptographic Security**
- Replaced weak RNG (Math.random) with crypto.randomBytes for approval code generation
- 6-character codes now use cryptographically secure random values

**Protection Integrity**
- Updated do_unprotect() to include new approval system files
- Ensures uninstall properly removes all protected files

### Changed

**Hook Configuration**
- `.claude/settings.json.template` updated with new hook registrations:
  - PreToolUse: protected-action-gate.js
  - UserPromptSubmit: protected-action-approval-hook.js

### Technical Details

**Approval Workflow:**
1. Agent calls protected MCP action (e.g., production deployment tool)
2. PreToolUse hook blocks the action, generates 6-character code
3. Agent displays: "Action blocked. CTO must type: APPROVE PROD A7X9K2"
4. CTO types approval phrase in chat
5. UserPromptSubmit hook validates phrase and code, creates one-time approval token
6. Agent retries action, PreToolUse hook allows it (one-time use, 5-minute expiry)

**Configuration Schema:**
```json
{
  "protections": [
    {
      "phrase": "APPROVE PROD",
      "encryptedCredential": "...",
      "tools": [
        { "server": "mcp-server", "tool": "deploy_to_production" }
      ]
    }
  ]
}
```

**Files Created (13 total):**
- `.claude/hooks/lib/approval-utils.js` (269 lines)
- `.claude/hooks/protected-action-gate.js` (137 lines)
- `.claude/hooks/protected-action-approval-hook.js` (120 lines)
- `.claude/hooks/protected-actions.json.template` (52 lines)
- `scripts/encrypt-credential.js` (85 lines)
- `scripts/generate-protected-actions-spec.js` (116 lines)
- `.claude/hooks/__tests__/approval-utils.test.js` (231 lines)
- `.claude/hooks/__tests__/protected-action-gate.test.js` (189 lines)
- `.claude/hooks/__tests__/protected-action-approval-hook.test.js` (192 lines)

**Files Modified:**
- `.claude/settings.json.template` (+14 lines)
- `CLAUDE.md.gentyr-section` (+7 lines)
- `packages/mcp-servers/src/deputy-cto/server.ts` (+98 lines)
- `packages/mcp-servers/src/deputy-cto/types.ts` (+23 lines)
- `scripts/setup.sh` (+32 lines)

**Total Changes:** +1565 lines added

### Testing

All new components include comprehensive unit tests:
- approval-utils.test.js: Encryption, code generation, validation
- protected-action-gate.test.js: Hook blocking behavior, fail-closed compliance
- protected-action-approval-hook.test.js: Approval phrase processing, token creation

### Use Cases

**Example 1: Production Deployment**
Protect production deployment tools to require explicit CTO approval before execution.

**Example 2: Database Migrations**
Prevent agents from running migrations without CTO review and approval.

**Example 3: API Key Rotation**
Require CTO approval before rotating production API keys.

### Security Considerations

- Approval codes expire after 5 minutes
- One-time use tokens (cannot be reused)
- Fail-closed design (blocks on any error)
- Credentials encrypted with AES-256-GCM
- Cryptographically secure random code generation

---

## 2026-01-31 - Deputy CTO Task Assignment Feature

### Added

**Deputy CTO Agent: Task Assignment Capability**
- Added `mcp__todo-db__create_task` to deputy-cto allowed tools
- New "Task Assignment" section with urgency-based decision criteria
- Reduces resource usage by queuing non-urgent tasks instead of immediate spawning

**Decision Framework:**
- **Urgent tasks** (immediate spawning via `spawn_implementation_task`):
  - Security issues or vulnerabilities
  - Blocking issues preventing commits
  - Time-sensitive fixes
  - CTO explicitly requests immediate action
- **Non-urgent tasks** (queued via `mcp__todo-db__create_task`):
  - Feature implementation from plans
  - Refactoring work
  - Documentation updates
  - General improvements

### Changed

**`.claude/agents/deputy-cto.md`**
- Added `mcp__todo-db__create_task` to allowedTools
- Updated "Your Powers" section to list both spawn and queue options
- Added "Task Assignment" section with urgency criteria and code examples

**`.claude/commands/deputy-cto.md`**
- Replaced "Spawning Implementation Tasks" section with "Task Assignment"
- Added urgency-based decision criteria
- Added code examples for both immediate spawning and queuing

### Technical Details

The deputy-cto agent now intelligently chooses between:
1. **Immediate spawning** - Fire-and-forget Claude sessions for urgent work
2. **Task queuing** - Adding tasks to todo.db for agent pickup during normal workflow

This reduces unnecessary resource consumption while maintaining responsiveness for critical issues.

### Files Modified

- `.claude/agents/deputy-cto.md` (configuration changes)
- `.claude/commands/deputy-cto.md` (documentation changes)

### Review Status

- Code Reviewer: APPROVED - Changes well-structured, consistent, correct tool usage
- Test Writer: N/A - Markdown configuration files, no executable code

---

## 2026-01-29 - CLAUDE.md Agent Instructions Feature

### Added

**Setup Script: CLAUDE.md Management**
- Automatic injection of agent workflow instructions into target project CLAUDE.md files
- Template file: `CLAUDE.md.gentyr-section` with golden rules and standard workflow
- Smart append/replace logic:
  - Creates CLAUDE.md if it doesn't exist
  - Appends section to existing files
  - Replaces section on re-install (no duplicates)
  - Uses `<!-- GENTYR-FRAMEWORK-START/END -->` markers for idempotency

**Uninstall Cleanup**
- Removes GENTYR section from CLAUDE.md
- Deletes file if empty after removal
- Preserves project-specific content

**Agent Workflow Documentation**
- Golden rules: Never skip agents, always follow order, one agent per role
- Standard sequence: INVESTIGATOR → CODE-WRITER → TEST-WRITER → CODE-REVIEWER → PROJECT-MANAGER → SUMMARY
- CTO reporting guidelines for architecture, security, breaking changes, blockers
- Slash command reference

### Changed

**scripts/setup.sh**
- Added section 8: CLAUDE.md agent instructions injection
- Added CLAUDE.md cleanup in uninstall section
- Skip CLAUDE.md operations if file is write-protected

**README.md**
- Expanded "Custom CLAUDE.md" section with installation behavior details
- Documented template location and content
- Added uninstall behavior explanation

### Files Modified

- `scripts/setup.sh` (+47 lines)
- `CLAUDE.md` (new, 60 lines) - Framework's own CLAUDE.md
- `CLAUDE.md.gentyr-section` (new, 34 lines) - Template for target projects
- `README.md` (+20 lines)
- `docs/CHANGELOG.md` (+35 lines, this entry)

### Technical Details

**Idempotency:**
- Section markers ensure re-installs replace old section instead of appending duplicates
- Sed-based removal using marker comments

**Protection Integration:**
- Setup skips CLAUDE.md if write-protected (post-protection state)
- Uninstall skips cleanup if write-protected

### Use Case

Before this feature, each project needed manual CLAUDE.md creation with agent workflow instructions. Now the framework automatically provides:
- Consistent agent workflow across all projects
- Up-to-date best practices for multi-agent coordination
- Standardized CTO reporting conventions

Projects can still add custom instructions above/below the framework section.

---

## 2026-01-24 - Spec Suite System

### Added

**MCP Server: specs-browser**
- 9 new MCP tools for spec and suite management:
  - `createSpec` - Create new specification files
  - `editSpec` - Edit existing specifications
  - `deleteSpec` - Delete specifications
  - `get_specs_for_file` - Get all applicable specs for a file (main + subspecs)
  - `listSuites` - List all configured spec suites
  - `getSuite` - Get suite configuration details
  - `createSuite` - Create new spec suite
  - `editSuite` - Modify suite configuration
  - `deleteSuite` - Remove spec suite

**Compliance Checker**
- Suite-based enforcement system
- Pattern matching for file scoping using glob patterns
- `loadSuitesConfig()` - Load suite configuration
- `getSuitesForFile()` - Determine applicable suites for a file
- `getAllApplicableSpecs()` - Collect specs from matching suites (global)
- `getAllExploratorySpecs()` - Collect specs from matching suites (local)
- `matchesGlob()` - Simple glob pattern matcher

**Configuration**
- New config file: `.claude/hooks/suites-config.json`
- Suite schema with scope, priority, and enabled flags
- Backward compatibility with legacy enforcement

**Documentation**
- Comprehensive spec suites section in `.claude/hooks/README.md`
- Session documentation: `docs/sessions/2026-01-24-spec-suite-implementation.md`
- Updated README.md with spec suite examples

### Changed

**Compliance Prompts**
- `spec-enforcement.md` - Added optional Suite Context section
- `local-spec-enforcement.md` - Added Suite Context and Scope Constraint sections

**README.md**
- Updated Specification Enforcement section with suite examples
- Updated specs-browser description to include CRUD operations
- Updated MCP tools examples

### Technical Details

**Files Modified (7 total):**
- `.claude/hooks/README.md` (+89 lines)
- `.claude/hooks/compliance-checker.js` (+382 lines major refactor)
- `.claude/hooks/prompts/local-spec-enforcement.md` (+24 lines)
- `.claude/hooks/prompts/spec-enforcement.md` (+9 lines)
- `README.md` (+34 lines)
- `packages/mcp-servers/src/specs-browser/server.ts` (+442 lines)
- `packages/mcp-servers/src/specs-browser/types.ts` (+232 lines)

**Total Changes:** +1101 lines, -111 lines

### Verification

- TypeScript build: ✓ Passed
- JavaScript syntax check: ✓ Passed
- Code review: ✓ No violations
- Vitest tests: ✓ 51 tests passing

### Testing

**specs-browser/__tests__/specs-browser.test.ts**
- Fixed test cleanup issue in Suite Management describe block
- Added `afterEach` to remove `.claude` directory created during tests
- All 51 tests now pass consistently across test runs
- Root cause: Missing cleanup caused directory persistence across runs

### Architecture

Spec suites allow projects to:
1. Group related specifications (global + local)
2. Scope specs to specific file patterns using glob syntax
3. Reduce enforcement noise by checking only relevant specs
4. Configure priority when multiple suites match

Example use case: Integration-specific specs only check integration files, not the entire codebase.

### Backward Compatibility

Fully backward compatible:
- Legacy behavior if suites-config.json doesn't exist
- Existing spec-file-mappings.json still supported
- No breaking changes to existing workflows

---

## Previous Releases

See git history for pre-2026-01-24 changes.
