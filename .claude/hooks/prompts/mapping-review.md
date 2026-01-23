# Review Spec-File Mappings - Compliance Checker

You are reviewing the `spec-file-mappings.json` file for the ODIN compliance checker system.

## Current Status

The mapping file is **VALID** and passes all validation checks. Your task is to review whether the mappings are optimal and make improvements if needed.

## Current Mapping File

```json
{{CURRENT_MAPPINGS}}
```

## Agent Budget

| Metric | Value |
|--------|-------|
| Current Total Files | {{CURRENT_AGENT_COUNT}} |
| Maximum Allowed | {{MAX_AGENTS}} |
| Utilization | {{UTILIZATION_PERCENT}}% |
| Remaining Budget | {{REMAINING_BUDGET}} files |

## Per-Spec Breakdown

{{SPEC_BREAKDOWN_TABLE}}

## Your Task

Review the mappings with a **CONSERVATIVE** approach. Each mapped file spawns a Claude agent, which costs tokens.

### 1. Remove Files That Shouldn't Be Mapped

Look for:
- **Files unlikely to violate the spec** - Stable, well-tested, rarely-changing files
- **Low-risk or peripheral files** - Files that don't directly implement spec requirements
- **Duplicates** - Files already covered by other specs
- **Test files or fixtures** - Should not be in src/ anyway

### 2. Add Files That Should Be Mapped (Only if Clearly Needed)

Only add files if:
- **Known violators** - Check CLAUDE.md for Bug #145-148 mentions
- **Core components** - Files that directly implement spec requirements
- **Historical violations** - Files that have had compliance issues before
- **High-risk files** - Complex files likely to violate architectural constraints

### 3. Prioritize High-Impact Mappings

- **Critical/high priority specs** should have key files mapped
- **Low priority specs** might need fewer files
- Focus on files with HIGH probability of violations

## Conservative Guidance - READ THIS CAREFULLY

- **Lean toward FEWER entries**, not more
- **Each file = 1 Claude agent = significant token cost**
- **Only map files with HIGH probability of spec violations**
- **Peripheral or rarely-changing files can often be skipped**
- **When in doubt, DON'T add a file**
- **The goal is PRECISION, not COVERAGE** - We want to catch violations efficiently, not check everything

## Spec Reference

For reference, here are the specs and their key concerns:

| Spec | Key Concerns |
|------|--------------|
| **BARDE.md** | Paper trading, conservative bias (1% worse fills), 4 stop-loss types, object pooling, lock-free queues |
| **HEIMDALL.md** | 7 sensors, pre-flight tests, health monitoring, Thor integration, hourly reports |
| **HUGINN.md** | 75% confidence threshold, capital recycling ($10K per strategy), position lifecycle, REPLACES old veto system |
| **OVERSEER.md** | 150-dim feature vectors, [-1,1] normalization, 3-model ensemble, trains on strategy paper trades |
| **UNDERSEER.md** | 10 variations, fitness=(avgPnL*0.7 + winRate*0.3), 7-day cycles, 28-day epochs |
| **THOR.md** | 1:1 production parity, API interception, NO VirtualClock in production code, monkey-patching pattern |
| **SIGNALS.md** | 3-layer system (Asset→Position→Strategy), namespace isolation, fail-hard on missing signals |
| **CORE-INVARIANTS.md** | No mocks in production, fail-hard (no fallbacks), money as integers, ISO timestamps, UUIDs v4 |

## Known Violators (from CLAUDE.md)

These files are **CONFIRMED** violators and should be mapped to CORE-INVARIANTS.md:

- `src/money-management/core/MoneyManager.js` (Bug #145 - has `isMockMode`)
- `src/orchestration/scheduling/StrategyScheduler.js` (Bug #146 - has `isMockMode`)
- `src/orchestration/resource-management/ResourceManager.js` (Bug #147 - has `isMockMode`)
- `src/services/HistoricalDataCache.js` (Bug #148 - has `isMockMode`)

## Math Check - REQUIRED

Before finalizing, calculate:
- **New total file count** = sum of all files across all specs
- **Ensure new total ≤ {{MAX_AGENTS}}**
- **Report the delta** - How many files added/removed

## Output Format

After your review, if changes are needed:

1. Update the mapping file
2. Update `totalMappedFiles` to the new count
3. Update `lastReviewed` to current ISO timestamp
4. Update `lastReviewedBy` to "claude-mapping-reviewer"
5. Document all changes in your final report

## Workflow

Use the standard sub-agent sequence per CLAUDE.md. If there are multiple changes to make, batch agents (up to 3 at a time):

1. **Investigator** (batch up to 3):
   - Explore the codebase to understand which files are most relevant
   - Check for known violations in CLAUDE.md
   - Analyze current mappings for appropriateness
   - Identify files to add/remove

2. **Code-Writer** (batch up to 3):
   - Update `.claude/hooks/spec-file-mappings.json` with your changes
   - Update `totalMappedFiles` to reflect actual count
   - Update `lastReviewed` to current ISO timestamp
   - Update `lastReviewedBy` to "claude-mapping-reviewer"

3. **Test-Writer**: Skip (no tests for JSON config)

4. **Code-Reviewer** (batch up to 3):
   - Verify the updated file is valid JSON
   - Verify file count is accurate and within limit
   - Verify all paths start with "src/" and end with ".js"
   - Verify all required fields are present

5. **Project-Manager** (MANDATORY, ALWAYS LAST):
   - Document all changes in session report
   - List files removed with reasons
   - List files added with reasons
   - Report net change in file count

## Important Notes

- **NEVER run project-manager in parallel** - It must always be the final step
- **Be conservative** - Removing a file is often better than adding one
- **Each file has a cost** - Only add files with clear, compelling reasons
- **The system has 315 source files** - We cannot check them all
- **Current utilization: {{UTILIZATION_PERCENT}}%** - Is this appropriate? Consider reducing if high.
