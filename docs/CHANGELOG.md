# GENTYR Framework Changelog

## 2026-01-24 - Spec Suite System

### Added

**MCP Server: specs-browser**
- 8 new MCP tools for spec and suite management:
  - `createSpec` - Create new specification files
  - `editSpec` - Edit existing specifications
  - `deleteSpec` - Delete specifications
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

### Known Issues

**Test Coverage Gap:**
- 8 new MCP tools need Vitest tests
- compliance-checker.js has no test coverage
- Issue reported to deputy-cto for triage

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
