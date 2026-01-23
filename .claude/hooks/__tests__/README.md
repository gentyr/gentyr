# Hook Tests

This directory contains tests for Claude Code hooks that implement critical automation and security features.

## Running Tests

```bash
# Run all tests
node --test .claude/hooks/__tests__/*.test.js

# Run specific test file
node --test .claude/hooks/__tests__/pre-commit-review.test.js
node --test .claude/hooks/__tests__/cto-notification-hook.test.js

# Run with detailed output
node --test --test-reporter=spec .claude/hooks/__tests__/*.test.js
```

## Test Files

### `pre-commit-review.test.js`
Tests for the pre-commit hook that implements G001 fail-closed behavior for commit approval via deputy-cto review.

### `cto-notification-hook.test.js`
Tests for the UserPromptSubmit hook that displays CTO status, validates bug fixes for path sanitization and JSON parsing.

## Test Coverage

### CTO Notification Hook Tests (`cto-notification-hook.test.js`)

#### Path Sanitization (Security)
- **Bug Fix**: Changed from `/\//g` to `/[^a-zA-Z0-9]/g` to sanitize ALL non-alphanumeric characters
- **Security**: Prevents path traversal attacks via project directory names
- **Validates**:
  - Regex pattern replaces all non-alphanumeric characters with dashes
  - Leading dash is stripped to prevent flag injection
  - Final path prepends dash for Claude Code directory structure

#### JSON Parsing (Data Integrity)
- **Bug Fix**: Parse `{ agents: [...] }` structure, not direct array
- **Bug Fix**: Convert ISO timestamp strings to milliseconds for comparison
- **Validates**:
  - Correct extraction of `data.agents` array
  - Timestamp conversion via `new Date(entry.timestamp).getTime()`
  - Proper comparison of timestamps against 24-hour window

#### Additional Coverage
- Database path constants (agent-reports.db vs old cto-reports.db)
- G001 fail-closed for critical operations (getDeputyCtoCounts)
- Graceful error handling for non-critical metrics
- ES module structure validation
- All required constants and functions defined

### Pre-Commit Review Hook Tests (`pre-commit-review.test.js`)

#### G001 Fail-Closed Behavior Tests

These tests validate that the hook BLOCKS commits (exits with code 1) when:

1. **better-sqlite3 module is unavailable** - Critical dependency missing
2. **Database query errors occur** - hasPendingRejections() encounters errors
3. **Pending rejections exist** - Previous commit was rejected and not yet addressed
4. **Git command errors occur** - getStagedDiff() fails to read staged changes
5. **No decision is made within timeout** - Deputy-CTO review times out without decision
6. **Review spawning fails** - Error spawning deputy-cto agent

### Emergency Bypass Tests

- Validates `SKIP_DEPUTY_CTO_REVIEW=1` allows commits through
- Ensures the bypass only works when set to exactly "1"

### Normal Operation Tests

- No staged files → commit allowed (nothing to review)
- Valid staged files → proceeds to deputy-cto review
- Approved decision → commit allowed (exit 0)
- Rejected decision → commit blocked (exit 1)

### Helper Function Tests

Tests for internal functions:
- `getStagedDiff()` - Git diff extraction with truncation and error handling
- `hasPendingRejections()` - Database query with error handling
- `clearPreviousDecision()` - Non-blocking cleanup operation
- `getCommitDecision()` - Decision retrieval with error handling

### G001 Compliance Summary Tests

High-level validation:
- At least 6 fail-closed exit points exist
- Emergency bypass documented in multiple error messages
- G001 spec explicitly mentioned
- Approval logic exists
- Timeout constants are reasonable
- Return structures are consistent

## Test Philosophy

These tests follow the test-writer agent's philosophy:

1. **Validate Structure, Not Performance** - Tests verify behavior and structure, not timing or accuracy
2. **Fail Loudly** - No graceful fallbacks; errors must be obvious
3. **Never Make Tests Easier** - Tests are strict; code must be fixed to pass
4. **Code Structure Validation** - Some behaviors are hard to test in isolation, so we validate the code structure exists

## Test Framework

Uses Node's built-in test runner (`node:test`) rather than Jest or Vitest, since:
- No external dependencies required
- Perfect for standalone script testing
- Native ES modules support
- Built-in assertion library

## G001 Compliance

All tests validate G001 fail-closed behavior:
> When the security system encounters an error, it MUST fail in a secure state (blocking the action) rather than allowing potentially dangerous operations to proceed.

Every error path in `pre-commit-review.js` blocks commits by default. The only exception is the documented emergency bypass (`SKIP_DEPUTY_CTO_REVIEW=1`), which is intentionally difficult to use and clearly warns about emergency-only usage.
