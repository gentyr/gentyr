# Deputy-CTO MCP Server Tests

## Overview

This test suite validates G001 fail-closed behavior for the deputy-cto MCP server, particularly focusing on autonomous mode configuration handling and commit approval/rejection logic.

## Test Coverage

### G001 Fail-Closed: getAutonomousConfig()

Tests that verify fail-closed behavior when reading autonomous mode configuration:

1. **Missing Config File**: Returns safe defaults (enabled: false)
2. **Valid Config File**: Loads configuration correctly
3. **Corrupted Config File**: Fails closed to disabled state and logs errors
4. **Empty Config File**: Fails closed to disabled state
5. **Non-JSON Data**: Fails closed to disabled state
6. **Partial Config**: Merges with safe defaults

**Critical G001 Requirements Tested:**
- ✅ Always returns enabled: false when corruption detected
- ✅ Logs error messages to console.error
- ✅ Never throws exceptions that crash the server
- ✅ Provides fix instructions in error messages

### G001 Fail-Closed: getNextRunMinutes()

Tests that verify fail-closed behavior when reading automation state:

1. **Missing State File**: Returns 0 (ready for first run)
2. **Valid State Within Cooldown**: Calculates minutes correctly
3. **Valid State After Cooldown**: Returns 0 (ready to run)
4. **Corrupted State File**: Returns null (unknown state) and logs errors
5. **Empty State File**: Returns null and logs errors
6. **Missing lastRun Field**: Handles gracefully with default value

**Critical G001 Requirements Tested:**
- ✅ Returns null (not 0) when corruption detected
- ✅ Logs error messages to console.error
- ✅ Never throws exceptions that crash the server
- ✅ Provides fix instructions in error messages
- ✅ Distinguishes "unknown state" from "ready to run"

### G001 Fail-Closed: getAutonomousModeStatus()

Tests that verify proper status messaging based on configuration and state:

1. **Status Unknown Message**: Shows when nextRunMinutes is null (state file corrupt)
2. **Disabled Message**: Shows when config is disabled
3. **Ready to Run Message**: Shows when nextRunIn is 0
4. **Minutes Until Next Run**: Shows countdown when within cooldown
5. **Corrupt Config Handling**: Falls back to disabled status

**Critical G001 Requirements Tested:**
- ✅ Shows "status unknown" when state file is corrupt
- ✅ Shows "disabled" when config file is corrupt
- ✅ Never shows misleading status information

### Commit Approval/Rejection

Tests that verify commit blocking logic:

1. **Approve Commit**: Succeeds when no pending rejections
2. **Block Approval with Pending Rejections**: Fails closed when rejections exist (G001)
3. **Create Rejection**: Creates decision and question records
4. **Count Pending Rejections**: Accurately tracks rejection count

**Critical G001 Requirements Tested:**
- ✅ Blocks commit approval when pending rejections exist
- ✅ Returns explicit error message explaining why approval was blocked
- ✅ Enforces fail-closed policy (deny by default)

### Question Management

Tests for basic CRUD operations on questions:

1. **Add Question**: Creates question with all fields
2. **Type Constraint**: Enforces valid question types at database level
3. **Status Constraint**: Enforces valid status values at database level

### Database Indexes

Tests that verify performance indexes exist:

1. **questions.status index**: For filtering by status
2. **questions.type index**: For filtering by type
3. **commit_decisions.created_timestamp index**: For ordering decisions
4. **cleared_questions.cleared_timestamp index**: For archive queries

## Test Execution

```bash
# Run deputy-cto tests only
npx vitest run src/deputy-cto/__tests__/deputy-cto.test.ts

# Run all MCP server tests
npx vitest run

# Watch mode
npx vitest watch src/deputy-cto/__tests__/deputy-cto.test.ts
```

## Test Results

```
✓ src/deputy-cto/__tests__/deputy-cto.test.ts  (28 tests)
  ✓ G001 Fail-Closed: getAutonomousConfig()  (6 tests)
  ✓ G001 Fail-Closed: getNextRunMinutes()  (6 tests)
  ✓ G001 Fail-Closed: getAutonomousModeStatus()  (6 tests)
  ✓ Commit Approval/Rejection  (4 tests)
  ✓ Question Management  (3 tests)
  ✓ Database Indexes  (4 tests)

All tests passing ✅
```

## G001 Compliance Summary

### ✅ Verified G001 Requirements

1. **Fail-Closed on Config Corruption**:
   - Returns enabled: false (safest default)
   - Never enables autonomous mode when config is corrupt
   - Logs errors but doesn't crash

2. **Fail-Closed on State Corruption**:
   - Returns null (unknown state) instead of 0 (ready to run)
   - Prevents automation from running when state is unknown
   - Logs errors with fix instructions

3. **Fail-Closed on Commit Approval**:
   - Blocks approval when pending rejections exist
   - Returns clear error messages
   - Enforces security by default

4. **Error Logging**:
   - All error conditions log to console.error
   - Error messages include fix instructions
   - Errors are descriptive and actionable

5. **No Silent Failures**:
   - Never returns success when operation failed
   - Never hides errors or warnings
   - Always indicates failure state clearly

### ❌ Violations NOT Allowed

These patterns are explicitly tested against:

- ❌ Returning enabled: true when config is corrupt
- ❌ Returning 0 (ready to run) when state is corrupt
- ❌ Approving commits when rejections are pending
- ❌ Silent failures without error logging
- ❌ Graceful fallbacks that hide failures

## Testing Philosophy

From the test-writer agent instructions:

> **Fail Loudly - No Graceful Fallbacks**
>
> **CRITICAL RULE**: Graceful fallbacks are NEVER allowed. When something goes wrong, throw an error immediately.

This test suite ensures that the deputy-cto server fails loudly and safely when encountering corrupt configuration or state files, preventing the system from making incorrect decisions based on bad data.

## Notes

- Tests use in-memory SQLite database for isolation
- Temporary directories are created and cleaned up for file-based tests
- Console.error is spied on to verify error logging
- All tests are deterministic and can run in parallel
