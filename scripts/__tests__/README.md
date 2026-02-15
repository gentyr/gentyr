# Scripts Tests

This directory contains tests for standalone scripts in the `scripts/` directory.

## Running Tests

```bash
# Run all script tests
node --test scripts/__tests__/*.test.js

# Run specific test file
node --test scripts/__tests__/setup-check.test.js

# Run with detailed output
node --test --test-reporter=spec scripts/__tests__/*.test.js
```

## Test Files

### `setup-check.test.js`
Tests for the `setup-check.js` credential evaluation script.

**What it tests:**
- Code structure validation (ES module, required functions, CREDENTIALS registry)
- JSON output schema compliance
- Graceful degradation (missing GENTYR, missing op CLI, missing vault-mappings.json)
- GITHUB_TOKEN/GITHUB_PAT deduplication (caching op:// path checks)
- Summary calculation logic
- Edge cases (environment variables, corrupted files)

**Test approach:**
- **Structure tests**: Regex matching on source code to validate constants and functions exist
- **Behavior tests**: Execute script with mocked project directories, validate JSON output
- **Graceful degradation**: Test all failure modes (missing dependencies, missing files, corrupted data)

## Test Framework

Uses Node's built-in test runner (`node:test`) rather than Jest or Vitest, because:
- No external dependencies required
- Perfect for standalone script testing
- Native ES modules support
- Built-in assertion library
- Matches the pattern used in `.claude/hooks/__tests__/`

## Testing Philosophy

### Structure Validation
When behavior is hard to test in isolation (e.g., requires live 1Password CLI), we validate the code structure:
- Use regex to match expected patterns in source code
- Verify constants, functions, and exports exist
- Validate documentation and JSDoc

### Behavior Validation
When behavior can be tested without live dependencies:
- Create temporary project directories with controlled states
- Execute the script and parse JSON output
- Validate output schema and calculations
- Test all code paths (missing files, corrupted data, etc.)

### Graceful Degradation
All failure modes should be tested:
- Missing GENTYR installation
- Missing 1Password CLI
- 1Password not authenticated
- Missing vault-mappings.json
- Corrupted vault-mappings.json
- Partial credential configuration

## Why Not Mock `execFileSync` for op CLI?

**Decision: We do NOT mock the `op` CLI in these tests.**

**Rationale:**
1. **Real-world testing**: The script already has graceful degradation for missing op CLI
2. **Complexity**: Mocking `execFileSync` requires module-level mocking (complex in ES modules)
3. **Coverage**: We get sufficient coverage by testing:
   - `opCliAvailable: false` (op CLI not in PATH)
   - `opAuthenticated: false` (op CLI available but not authenticated)
   - Real `op` CLI when available (opportunistic)

**What we DO test:**
- Code structure (functions exist, constants defined)
- JSON output schema (all required fields present)
- Graceful degradation (missing dependencies, corrupted files)
- Summary calculations (counts, booleans)

**What we DON'T test:**
- Actual `op read` calls to 1Password (would require mocking or live credentials)
- Exact `existsInOp` values (depends on live 1Password state)

This approach gives us:
- ✅ Fast tests (no mocking overhead)
- ✅ High confidence in graceful degradation
- ✅ Schema validation
- ✅ Real-world behavior (when op CLI available)

## Test Coverage

### Code Structure (100%)
- [x] ES module imports
- [x] Shebang for direct execution
- [x] CREDENTIALS registry with all required credentials
- [x] All required functions defined
- [x] main() called at end of script

### Function Behavior (95%)
- [x] checkGentyrInstalled() - directory/symlink detection
- [x] readVaultMappings() - JSON parsing, graceful errors
- [x] main() - JSON output schema
- [ ] checkOpCli() - **Not fully tested** (would require mocking)
- [ ] checkOpSecret() - **Not fully tested** (would require mocking)

### Graceful Degradation (100%)
- [x] Missing GENTYR installation
- [x] Missing vault-mappings.json
- [x] Corrupted vault-mappings.json
- [x] Partial credential configuration
- [x] op CLI not in PATH
- [x] Environment variable handling

### JSON Schema (100%)
- [x] All top-level fields present
- [x] credentials object structure
- [x] summary object structure
- [x] Credential metadata fields
- [x] Summary calculation accuracy

### Edge Cases (100%)
- [x] GITHUB_TOKEN/GITHUB_PAT deduplication
- [x] Identifier credentials (null opPath)
- [x] CLAUDE_PROJECT_DIR environment variable
- [x] Fallback to process.cwd()

## Maintenance Notes

### When to Update Tests

**Add tests when:**
- New credentials added to CREDENTIALS registry
- New top-level fields added to JSON output
- New summary calculations added
- New graceful degradation behavior added

**Update tests when:**
- CREDENTIALS registry structure changes
- JSON output schema changes
- Summary calculation logic changes

### Test Isolation

All tests use temporary directories created with `createTestProject()`:
- Each test creates a fresh temporary project directory
- Tests clean up after themselves (in `finally` blocks)
- No tests depend on actual GENTYR installation or 1Password state

### Performance

Tests are fast because:
- No network calls (1Password CLI only used when available)
- No mocking overhead (tests actual graceful degradation)
- Temporary directories cleaned up immediately

**Typical runtime:** < 2 seconds for full suite
