# Enforce Local Specification Compliance - ODIN System

You are enforcing compliance with a local specification for the ODIN trading system.

## Your Assignment

**Specification**: {{SPEC_NAME}}
**Spec File Path**: `{{SPEC_PATH}}`

## Specification Content

```markdown
{{SPEC_CONTENT}}
```

## Instructions

Your task is to find the most relevant files in the codebase that should comply with this specification, then ensure they meet ALL requirements.

### What You Must Do

1. **Identify relevant files** - Use Glob/Grep to find files that should comply with this spec (up to 10 files)
2. **Read and analyze files** - Understand what they do and how they're structured
3. **Identify ALL violations** - Check against every rule in the spec
4. **Get code-reviewer recommendation** - BEFORE fixing, ask code-reviewer if we should fix code OR update spec
5. **Apply recommended fix** - Either update code OR update spec based on recommendation
6. **Add/update tests** - If code was changed, ensure tests cover the fixed code paths
7. **Verify compliance** - Double-check all fixes are correct

### CRITICAL: Finding Relevant Files (Rate Limit: 10 Files Max)

**You have freedom to explore the codebase** to find files that should comply with this spec, but you are limited to checking **up to 10 files maximum** per run to stay within rate limits.

**Exploration Strategy**:

1. **Start Broad**: Use `Glob` to search by file patterns (e.g., `**/*Orchestrator*.js`)
2. **Narrow Down**: Use `Grep` to search by content patterns (e.g., class names, function signatures)
3. **Prioritize**: Read file names/paths to identify the most critical files
4. **Select Wisely**: Choose up to 10 files that are most likely to have violations

**Examples**:
- THOR.md spec → search for `Thor*`, `VirtualClock`, `InterceptionManager`
- BARDE.md spec → search for `Barde*`, `UniversalStopLossManager`, `paper_trading*`
- OVERSEER.md spec → search for `Overseer*`, `ML*`, `ensemble*`

**Priority Guidelines**:
- Core implementation files > utility/helper files
- Files that directly implement spec requirements > tangentially related files
- Files with high complexity > simple configuration files

**Important**: Focus on quality over quantity. It's better to thoroughly check 10 critical files than to superficially check 20 files.

### CRITICAL: Spec vs Code Decision

**BEFORE changing any code**, run the code-reviewer sub-agent to determine the correct action:

- **If spec is outdated**: Update the spec to match the intentional code behavior
- **If code is wrong**: Fix the code to match the spec

The code-reviewer will analyze whether:
1. The code pattern is intentional and the spec is outdated
2. The code depends on specific patterns (e.g., ID formats parsed by other code)
3. Changing code would break other parts of the system
4. The spec needs clarification or exceptions added

**Go with the code-reviewer's recommendation, even if that means updating the spec rather than the code.**

### Critical Rules (from CLAUDE.md)

In addition to the spec requirements, you MUST enforce these global invariants:

- **NO GRACEFUL FALLBACKS** - Fail hard and loud when something doesn't meet specification
- **NO MOCKS IN PRODUCTION CODE** - No `isMockMode`, `MOCK_MODE`, `mockMode`, `isSimulation` checks in `src/**/*.js`
- **MONETARY PRECISION** - All monetary values rounded to 2 decimal places (float dollars OK)
- **ISO 8601 TIMESTAMPS** - All timestamps in ISO 8601 format
- **UNIQUE IDENTIFIERS** - UUIDs v4 preferred, but timestamp-based IDs acceptable if code parses them
- **FAIL-HARD ON MISSING DATA** - Never silently return null/undefined/empty when data is expected

**Note**: These rules have documented exceptions in `specs/global/CORE-INVARIANTS.md`. Check the spec for acceptable patterns before flagging violations.

## Workflow

Use the standard sub-agent sequence per CLAUDE.md. The key difference here is that you explore the codebase to find relevant files, and code-reviewer runs BEFORE code-writer to decide the fix approach.

### 1. Investigator (batch up to 3)

**Task**: Find files that should comply with this spec, then identify ALL violations.

**Phase 1 - Discovery**:
- Use Glob to search for files by name patterns
- Use Grep to search for files by content patterns
- Read files to assess relevance to the spec
- Build a list of files that MUST comply

**Phase 2 - Violation Detection**:
- For each relevant file, check against ALL spec requirements
- Document violations with line numbers, code snippets, rules violated

**Output**:
- List of relevant files found
- For each file, list of violations with:
  - Line numbers
  - Code snippets
  - Rule violated
  - Severity (critical/high/medium/low)
  - Suggested fix

**Important**: Be thorough in discovery. Don't miss files that should comply.

### 2. Code-Reviewer (DECISION PHASE - batch up to 3)

**Task**: For each identified violation, determine the correct fix approach.

**Analysis for each violation**:
1. Is this code pattern intentional? (Check commit history, related code)
2. Does other code depend on this pattern? (e.g., ID parsing, data formats)
3. Would changing this code break other parts of the system?
4. Is the spec outdated or missing an exception?

**Decision for each violation**:
- **FIX_CODE**: The code is wrong, fix it to match the spec
- **UPDATE_SPEC**: The code is correct, update the spec to document the pattern
- **ADD_EXCEPTION**: The code has a valid reason, add an exception to the spec

**Output**: For each violation, provide:
- Decision: FIX_CODE / UPDATE_SPEC / ADD_EXCEPTION
- Reasoning: Why this is the correct approach
- Impact: What would change with each option

**Important**: Your recommendation will be followed. Be thorough in your analysis.

### 3. Code-Writer (batch up to 3)

**Task**: Apply the recommended fixes from the code-reviewer.

**For FIX_CODE decisions**:
- Make minimal changes (only what's needed to fix violations)
- Preserve existing functionality
- Follow existing code style
- Add comments explaining non-obvious changes

**For UPDATE_SPEC or ADD_EXCEPTION decisions**:
- Edit the spec file at `{{SPEC_PATH}}` (provided in assignment above)
- Add clear documentation of the exception or pattern
- Include rationale for why this is acceptable

**Important**: Do NOT introduce new violations while fixing old ones. Double-check your changes.

### 4. Test-Writer (ONLY if code was changed - batch up to 3)

**Task**: Ensure tests cover any code changes made.

**When to run**:
- ALWAYS run if FIX_CODE was applied to any violation
- SKIP if only spec updates were made (no code changes)

**Requirements**:
- Add new tests if needed to cover fixes
- Update existing tests if they break
- Ensure tests verify spec compliance
- Follow test patterns in existing test files

**Important**: Tests should verify the spec requirements, not just that code doesn't crash.

### 5. Code-Reviewer (FINAL REVIEW - batch up to 3)

**Task**: Review all changes for correctness.

**Check**:
- ✅ All violations addressed per the decision phase recommendations
- ✅ No new violations introduced
- ✅ Tests pass and cover code changes (if any)
- ✅ Spec updates are clear and accurate (if any)
- ✅ No unintended side effects

**Important**: Be critical. If something looks wrong, flag it and have code-writer fix it.

### 6. Project-Manager (MANDATORY, ALWAYS LAST)

**Task**: Document all changes in the session report.

**Include**:
- Summary of files found that should comply
- Summary of violations found across all files
- For each violation: decision made (FIX_CODE/UPDATE_SPEC/ADD_EXCEPTION)
- Summary of code fixes applied
- Summary of spec updates made
- Test changes made (if any)
- Any remaining issues or concerns

**Important**: NEVER run project-manager in parallel. It must always be the final step.

## Batching Example

If you find 3 relevant files with 2 violations each (6 total violations):

- **Round 1**: 3 investigators identify relevant files + violations in files 1-3
- **Round 2**: 3 investigators identify violations in remaining files (if needed)
- **Round 3**: 3 code-reviewers analyze violations 1-3 (DECISION PHASE - FIX_CODE/UPDATE_SPEC/ADD_EXCEPTION)
- **Round 4**: 3 code-reviewers analyze violations 4-6 (DECISION PHASE)
- **Round 5**: 3 code-writers apply fixes for violations 1-3 (code OR spec, per reviewer decision)
- **Round 6**: 3 code-writers apply fixes for violations 4-6 (code OR spec, per reviewer decision)
- **Round 7**: 3 test-writers add/update tests (ONLY for FIX_CODE decisions)
- **Round 8**: 3 code-reviewers review all changes (FINAL REVIEW)
- **Round 9**: 1 project-manager documents everything (LAST, NEVER PARALLEL)

**Key Change**: Code-reviewer runs TWICE - once to decide the approach (step 3-4), and once to verify the changes (step 8).

## Output Format

Provide a compliance report at the end:

```
## Compliance Report: {{SPEC_NAME}}

### Exploration Phase

**Files Found**: [TOTAL COUNT]
**Files Checked**: [COUNT] (max 10 due to rate limits)

**Search Patterns Used**:
- Glob: [patterns]
- Grep: [keywords]

**Selected Files** (checked):
1. [path] - [reason for selection]
2. [path] - [reason for selection]
...

**Files Not Checked** (if total > 10):
- [path] - [reason for lower priority]
- ...

### Total Violations Found: [COUNT]

#### File: [path/to/file1.js]

**Violation 1**: [Rule ID] [Brief description]
- Location: Line [N]
- Code: `[snippet]`
- Severity: [critical/high/medium/low]
- Decision: FIX_CODE / UPDATE_SPEC / ADD_EXCEPTION
- Reasoning: [Why this decision was made]
- Status: RESOLVED / NEEDS_MANUAL_REVIEW

**Violation 2**: ...

#### File: [path/to/file2.js]

...

### Code Changes Made

- [File path]: [Description of code fix]
- [Impact on codebase]

### Spec Changes Made

- [Spec file]: [What was updated/added]
- [Reasoning for spec change]

### Tests Added/Modified (if any code was changed)

- [Test file]: [What was added/changed]
- [Coverage impact]

### Status: COMPLIANT / NEEDS_MANUAL_REVIEW

**Final Assessment**: [Brief statement on compliance status across all checked files]

**Remaining Issues**: [Any issues that couldn't be auto-fixed]

**Recommendation**: [If files not checked, recommend re-running compliance check on them]
```

## Important Notes

- **This is a TRADING SYSTEM** - Mistakes can cost money. Be thorough.
- **Rate limit: 10 files max** - Choose the most critical files for checking
- **You have freedom to explore** - Use Glob/Grep to find relevant files, but prioritize wisely
- **Quality over quantity** - Better to thoroughly check 10 critical files than superficially check 20
- **Spec updates are valid fixes** - If code is correct and spec is outdated, update the spec
- **Code-reviewer decides** - Follow the code-reviewer's recommendation for each violation
- **Test-writer follows code changes** - Always run test-writer after code is modified
- **Fail hard** - Per CLAUDE.md, never use graceful fallbacks or silent failures
- **NEVER run project-manager in parallel** - It must always be the final step
- **Document everything** - Future maintainers need to understand what changed and why
- **Document unchecked files** - If more than 10 relevant files found, list the ones not checked
