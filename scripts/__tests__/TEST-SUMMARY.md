# Scripts Test Summary

## Test Suite: setup-check.test.js

**Status:** ✅ All tests passing (32/32)
**Framework:** Node's built-in test runner (`node:test`)
**Runtime:** ~2 seconds

### Coverage Summary

| Category | Coverage | Details |
|----------|----------|---------|
| Code Structure | 100% | ES module validation, CREDENTIALS registry, required functions |
| JSON Schema | 100% | All output fields validated, type checking |
| Graceful Degradation | 100% | Missing dependencies, corrupted files, partial config |
| Edge Cases | 100% | Deduplication, environment variables, identifiers |
| Live Integration | Opportunistic | 1Password CLI when available |

### Test Results

```
✔ setup-check.js - Code Structure (7 tests)
  ✔ should be a valid ES module
  ✔ should have shebang for direct execution
  ✔ should define CREDENTIALS registry
  ✔ should define CREDENTIALS with required fields
  ✔ should have both secret and identifier types
  ✔ should define all required functions
  ✔ should call main() at end of script

✔ checkGentyrInstalled() (2 tests)
  ✔ should return true when .claude-framework exists as directory
  ✔ should return false when .claude-framework does not exist

✔ readVaultMappings() (2 tests)
  ✔ should return exists: true when vault-mappings.json present
  ✔ should return exists: false when vault-mappings.json missing

✔ JSON Output Schema (5 tests)
  ✔ should output valid JSON to stdout
  ✔ should include all required top-level fields
  ✔ should include summary statistics
  ✔ should include credential details for all registered credentials
  ✔ should include credential metadata fields

✔ Graceful Degradation (5 tests)
  ✔ should handle missing GENTYR installation
  ✔ should handle missing vault-mappings.json
  ✔ should handle partially configured mappings
  ✔ should set opCliAvailable: false when op CLI not in PATH
  ✔ should handle corrupted vault-mappings.json

✔ GITHUB_TOKEN / GITHUB_PAT Deduplication (1 test)
  ✔ should cache op:// path checks to avoid redundant calls

✔ Edge Cases (3 tests)
  ✔ should use CLAUDE_PROJECT_DIR environment variable
  ✔ should fall back to process.cwd() when CLAUDE_PROJECT_DIR not set
  ✔ should handle secrets with null opPath (identifiers)

✔ Summary Calculation Logic (3 tests)
  ✔ should count secretsConfigured correctly
  ✔ should count identifiersConfigured correctly
  ✔ should set requiresOpAuth when op available but not authenticated

✔ Documentation and Metadata (4 tests)
  ✔ should have JSDoc header with description
  ✔ should document output format in header
  ✔ should document usage in header
  ✔ should use process.stdout.write for JSON output

ℹ tests 32
ℹ suites 9
ℹ pass 32
ℹ fail 0
```

### Test Strategy

**Structure Validation:**
- Regex matching on source code to verify constants and functions exist
- Validates ES module imports/exports
- Checks JSDoc documentation completeness

**Behavior Validation:**
- Creates temporary project directories with controlled states
- Executes script and parses JSON output
- Validates output schema and calculations
- Tests all code paths (missing files, corrupted data, etc.)

**No Mocking Approach:**
- Tests real graceful degradation instead of mocking `execFileSync`
- Simpler, faster, more valuable than complex mocks
- Real-world testing when op CLI available (opportunistic)

### Key Test Utilities

```javascript
createTestProject(options)
  - Creates temporary project directory with configurable state
  - Options: withGentyr, withVaultMappings, mappings
  - Automatic cleanup in finally blocks

runSetupCheck(projectDir, env)
  - Executes setup-check.js with specific project directory
  - Supports additional environment variables
  - Parses JSON output and validates schema
```

### Maintenance Notes

**When to update tests:**
- New credentials added to CREDENTIALS registry → Add assertions
- JSON output schema changes → Update schema validation tests
- New summary calculations → Add calculation tests
- New graceful degradation behavior → Add degradation tests

**Test isolation:**
- All tests use temporary directories
- No dependency on actual GENTYR installation
- No dependency on 1Password state
- Tests clean up in finally blocks

### Running the Tests

```bash
# Run setup-check tests only
node --test scripts/__tests__/setup-check.test.js

# Run all tests (hooks + scripts)
node --test .claude/hooks/__tests__/*.test.js scripts/__tests__/*.test.js

# Verbose output
node --test --test-reporter=spec scripts/__tests__/setup-check.test.js
```

### Related Documentation

- [`README.md`](./README.md) - Test overview and philosophy
- [`TESTING-DECISION.md`](./TESTING-DECISION.md) - Why we chose this testing approach
- [`../.claude/hooks/__tests__/`](../../.claude/hooks/__tests__/) - Hook tests (similar pattern)

---

**Last Updated:** 2025-02-09
**Test Framework:** Node.js v20+ built-in test runner
**Status:** All tests passing ✅
