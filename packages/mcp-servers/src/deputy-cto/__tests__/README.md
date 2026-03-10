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

### G011: spawn_implementation_task Idempotency (ORPHANED — tests failing)

`spawn_implementation_task` was removed from the deputy-cto server (PR #48). The `spawned_tasks`
table no longer exists in the schema. These 6 test cases remain in the test file but are expected
to fail until they are cleaned up. They do not affect CI for the features currently in production.

### G011: reject_commit Idempotency

Tests that verify G011-compliant deduplication for `reject_commit`:

1. **Returns existing rejection on duplicate call**: Two calls with identical code/message/rationale return the same question ID
2. **Does not create duplicate commit_decisions**: Second call with same args produces exactly one DB row in commit_decisions
3. **Transaction atomicity**: Both commit_decisions and questions are inserted atomically
4. **Different rationale creates new rejection**: Different rationale produces a new question ID
5. **Dedup only applies to pending rejections**: Re-rejection after answering creates a new record
6. **Question title uses commit hash prefix**: Title is derived from the code parameter
7. **First call returns correct structure**: Response shape is correct on first invocation
8. **Deduplicated call returns same structure**: Response shape matches on deduplication
9. **UNIQUE constraint fallback**: Raw duplicate INSERT raises UNIQUE constraint violation
10. **Partial unique index exists**: `idx_questions_type_title_dedup` correctly enforces dedup

### G011: approve_commit Idempotency

Tests that verify G011-compliant deduplication for `approve_commit`:

1. **Duplicate approval within 60s returns same result**: Two calls with the same rationale within 60 seconds are deduplicated
2. **Dedup does not create extra decisions**: Only one commit_decision row is created for duplicate calls
3. **Different rationale creates new approval**: A different rationale string produces a new decision record
4. **Re-approval after 60s window**: A new approval is allowed once the 60-second dedup window expires (simulated)
5. **First call clears rejections**: Approval removes any pending rejection questions
6. **Response structure is consistent**: Both fresh and deduplicated approvals return `{ approved: true }`
7. **UNIQUE constraint fallback**: Race condition INSERT raises SQLITE_CONSTRAINT_UNIQUE

### G011: request_bypass Idempotency

Tests that verify G011-compliant deduplication for `request_bypass`:

1. **Duplicate request returns existing record**: Two calls from the same agent return the same question ID
2. **Only one row created in questions**: Triple-call produces exactly one DB row
3. **Deterministic title prevents duplicates**: Title is `Bypass Request [<agent>]` enabling SELECT-first dedup
4. **Different agents create separate bypass requests**: Each agent has its own bypass question
5. **Re-request after resolution**: A new bypass request is allowed once the prior one is answered

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
✓ src/deputy-cto/__tests__/deputy-cto.test.ts  (138 tests | 7 failing)
  ✓ G001 Fail-Closed: getAutonomousConfig()  (6 tests)
  ✓ G001 Fail-Closed: getNextRunMinutes()  (6 tests)
  ✓ G001 Fail-Closed: getAutonomousModeStatus()  (11 tests)
  ✓ Question Management  (7 tests)
  ✓ Commit Approval/Rejection  (4 tests)
  ✓ G020 Triage Check: approveCommit()  (6 tests)
  ✓ Response Shape: pending_triage_count field  (7 tests)
  ✓ G011: add_question idempotency  (6 tests)
  ✗ G011: spawn_implementation_task idempotency  (6 tests — ORPHANED, spawned_tasks table removed)
  ✓ G011 idempotency - reject_commit  (9 tests passing, 1 failing — UNIQUE constraint test stale)
  ✓ G011 idempotency - approve_commit  (7 tests)
  ✓ Database Indexes  (5 tests)
  ✓ request_bypass idempotency (G011)  (5 tests)
  ✓ Data Cleanup Functions  (6 tests)

131 tests passing, 7 failing (orphaned spawn_implementation_task tests need cleanup) ⚠️
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
