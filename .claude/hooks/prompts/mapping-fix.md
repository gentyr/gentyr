# Fix Spec-File Mappings - Compliance Checker

You are fixing the `spec-file-mappings.json` file for the ODIN compliance checker system.

## Problem

The spec-file-mappings.json file has validation errors that must be fixed before the compliance enforcer can run.

## Validation Errors

```
{{VALIDATION_ERRORS}}
```

## Current Mapping File Content

```json
{{CURRENT_MAPPINGS}}
```

## Required Schema

```json
{{SCHEMA_CONTENT}}
```

## Required Specs

Every spec in this list MUST have an entry in the mappings file:

{{REQUIRED_SPECS_LIST}}

## Instructions

1. **Read the validation errors carefully** - Understand each error before making changes
2. **Fix each error in the mapping file** - Address all critical errors
3. **Ensure the JSON is valid** - Proper syntax, no trailing commas
4. **Ensure every required spec has an entry** with:
   - `description`: Brief explanation (10+ chars)
   - `priority`: One of "critical", "high", "medium", "low"
   - `files`: Array of file objects with `path` (must start with "src/" and end with ".js") and `lastVerified` (ISO timestamp or null)
   - `rationale`: Explanation of why these files are mapped (20+ chars)
5. **Update `totalMappedFiles`** to reflect the sum of all files across all specs
6. **Update `lastReviewed`** to current ISO timestamp
7. **Update `lastReviewedBy`** to "claude-mapping-fixer"

## Agent Limit - CRITICAL

**The total number of files across ALL specs must not exceed {{MAX_AGENTS}}.**

- Current count: {{CURRENT_AGENT_COUNT}}
- Limit: {{MAX_AGENTS}}
- Excess: {{EXCESS_COUNT}}

If the current count exceeds the limit, you MUST remove at least {{EXCESS_COUNT}} files to bring the total under the limit.

**Prioritize removing:**
- Files from low-priority specs
- Files unlikely to have violations
- Duplicate or redundant coverage
- Peripheral files that don't directly implement spec requirements

## Workflow

Use the standard sub-agent sequence per CLAUDE.md:

1. **Investigator**: Analyze the errors and understand what needs fixing. Read the current mapping file, schema, and errors.

2. **Code-Writer**: Edit `.claude/hooks/spec-file-mappings.json` to fix all errors. Ensure:
   - All required specs are present
   - All file paths are valid (start with "src/", end with ".js")
   - Total file count is within limit
   - JSON is syntactically correct
   - All required fields are present

3. **Test-Writer**: Skip (no tests for JSON config)

4. **Code-Reviewer**: Verify the fixed file:
   - Valid JSON syntax
   - All required specs present
   - Total file count ≤ {{MAX_AGENTS}}
   - All required fields present
   - `totalMappedFiles` matches actual count

5. **Project-Manager** (MANDATORY, ALWAYS LAST): Document the fixes made in the session report

## Important Notes

- **NEVER run project-manager in parallel** - It must always be the final step
- **DO NOT add files without careful consideration** - Each file = 1 Claude agent = token cost
- **Be conservative** - Only map files with HIGH probability of spec violations
- **Fail hard if you cannot fix** - Per CLAUDE.md, never use graceful fallbacks
