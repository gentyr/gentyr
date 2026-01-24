# Spec Suite System - Planning Context

## User's Original Request

> Oh and this system needs to be designed with the ~/git/gentyr project at the forefront of considerations, in fact, in might be the case that what should be done is that we design a .md plan and copy it into the gentyr directory and we implement it there. The goal is for this capability to be portable to any project via gentyr.

> Wait there's already a spec scoping system. That's what local specs are. They're mapped to specific files or dirs, etc. This is something different. The pair of global and local specs, let's call it a spec suite, needs to be enforced against a specific set of mapped files. So the project has a superset of specs, the global and local specs that can apply across the whole project, and subsets, where there are local and global sets per subset. So wherever our integrations live in this project, we configure a subset to point at a specific directory pattern (not just a specific directory), so one subset will point to the pattern where the standard api connectors lives, like integrations/<integration name but use a wildcard>/types/standard-api-connector/* - now I dont remember at all how our project structure is set up so pay no attention to that specific path, but there you go, and maybe for the selection system enabling wildcards and such, we should use an industry standard framework if libraries are normally used for that, or if it's normally done with simple built in typescript mechanisms, that's fine too. And we'll have to ensure the system that spawns claude instances (differently for global and local spec enforcement - so review the differences in gentyr) support this system. Design the plan based on the ~/git/gentyr system and copy the plan .md file to the root dir of that project and I'll implement it from there.

---

## Context from Exploration

### What Exists in Gentyr

The compliance-checker.js in gentyr has **dual enforcement modes**:

**GLOBAL ENFORCEMENT** (spec-file-mappings.json):
- Validates mapping file
- Checks specific files against global specs
- Per-file cooldown (7 days default)
- Daily agent cap (22 agents default)
- Uses `spec-file-mappings.json` which maps specs → file glob patterns

**LOCAL ENFORCEMENT** (specs/local/*.md):
- No file mappings required
- Agent explores codebase freely using Glob/Grep
- Per-spec cooldown (7 days default)
- Daily agent cap (3 agents default)
- One agent per spec file

### Current Configuration Files

- `.claude/hooks/compliance-config.json` - Enforcement settings
- `.claude/hooks/spec-file-mappings.json` - Spec → file mappings (uses glob patterns)
- `specs/global/` - Global specs (G001-G020)
- `specs/local/` - Local specs (component specs)

### Key Code Locations

- `/path/to/gentyr/.claude/hooks/compliance-checker.js` - Main enforcement logic (1079 lines)
- `/path/to/gentyr/.claude/hooks/prompts/spec-enforcement.md` - Global enforcement prompt
- `/path/to/gentyr/.claude/hooks/prompts/local-spec-enforcement.md` - Local enforcement prompt

### Pattern Matching

The existing `spec-file-mappings.json` already uses glob patterns:
```json
{
  "G001-no-graceful-fallbacks.md": {
    "files": [
      "apps/backend/src/services/*.ts",
      "integrations/**/src/**/*.ts"
    ]
  }
}
```

Industry standard for glob patterns: `minimatch` (used by npm, tsconfig, .gitignore)

---

## User's Core Concept: Spec Suites

A **spec suite** = pair of (global specs + local specs) that get enforced together against a specific scope.

- **Main Suite**: Project-wide (current behavior)
- **Subset Suites**: Scoped to directory patterns like `integrations/*/frontend-connector/**`

Each suite has:
- Its own global specs (from a specific directory/pattern)
- Its own local specs (from a specific directory/pattern)
- A scope pattern determining which files it applies to

---

# Detailed Design (Draft)

## Objective

Design a **spec suite system** for the gentyr framework that:
1. Allows specs to declare which files/components they apply to
2. Automatically enforces specs only against their scoped files
3. Reduces noise by not checking all specs against all files
4. Is portable to any project using gentyr

**Previous work completed**: specs-browser now supports configurable categories. 8 INT-* specs created with `**Applies To:**` metadata (documentation only, not enforced).

**This plan**: Make the scoping enforceable.

---

## Design: Spec Suite System

### Core Concept

A **spec suite** is a pair of global + local specs that get enforced together against a specific scope.

```
┌─────────────────────────────────────────────────────────────────┐
│  MAIN SUITE (project-wide)                                      │
│  ├── global: specs/global/G*.md                                 │
│  ├── local: specs/local/*.md                                    │
│  └── scope: **/* (entire project)                               │
├─────────────────────────────────────────────────────────────────┤
│  INTEGRATION SUITE: frontend-connector                          │
│  ├── global: specs/integrations/INT-FRONTEND-*.md               │
│  ├── local: (none for this suite)                               │
│  └── scope: integrations/*/frontend-connector/**                │
├─────────────────────────────────────────────────────────────────┤
│  INTEGRATION SUITE: backend-connector                           │
│  ├── global: specs/integrations/INT-BACKEND-*.md                │
│  ├── local: (none for this suite)                               │
│  └── scope: integrations/*/backend-connector/**                 │
└─────────────────────────────────────────────────────────────────┘
```

### Configuration: `suites-config.json`

New configuration file: `.claude/hooks/suites-config.json`

```json
{
  "version": 1,
  "patternLibrary": "minimatch",
  "suites": {
    "main": {
      "description": "Project-wide specs",
      "scope": "**/*",
      "global": {
        "specsDir": "specs/global",
        "pattern": "G*.md"
      },
      "local": {
        "specsDir": "specs/local",
        "pattern": "*.md"
      },
      "enabled": true,
      "priority": 0
    },
    "integration-frontend": {
      "description": "Frontend connector specs",
      "scope": "integrations/*/frontend-connector/**",
      "global": {
        "specsDir": "specs/integrations",
        "pattern": "INT-FRONTEND-*.md"
      },
      "local": null,
      "enabled": true,
      "priority": 10
    },
    "integration-backend": {
      "description": "Backend connector specs",
      "scope": "integrations/*/backend-connector/**",
      "global": {
        "specsDir": "specs/integrations",
        "pattern": "INT-BACKEND-*.md"
      },
      "local": null,
      "enabled": true,
      "priority": 10
    },
    "integration-guide": {
      "description": "Integration guide specs",
      "scope": "integrations/*/guide/**",
      "global": {
        "specsDir": "specs/integrations",
        "pattern": "INT-GUIDE-*.md"
      },
      "local": null,
      "enabled": true,
      "priority": 10
    }
  },
  "enforcement": {
    "global": {
      "maxAgentsPerDay": 22,
      "fileVerificationCooldownDays": 7
    },
    "local": {
      "maxAgentsPerDay": 3,
      "specCooldownDays": 7
    }
  }
}
```

### Suite Resolution Algorithm

When checking a file, determine which suites apply:

```javascript
function getSuitesForFile(filePath, suitesConfig) {
  const matchingSuites = [];

  for (const [suiteId, suite] of Object.entries(suitesConfig.suites)) {
    if (!suite.enabled) continue;

    // Use minimatch for pattern matching
    if (minimatch(filePath, suite.scope)) {
      matchingSuites.push({
        id: suiteId,
        ...suite
      });
    }
  }

  // Sort by priority (lower = higher priority)
  matchingSuites.sort((a, b) => a.priority - b.priority);

  return matchingSuites;
}
```

### Enforcement Flow

#### Global Enforcement (Modified)

```
1. Load suites-config.json
2. For each file needing check:
   a. Determine which suites apply (pattern matching)
   b. For each matching suite:
      - Load specs from suite's global.specsDir matching global.pattern
      - Check file against those specs only
3. Update lastVerified timestamps per suite-file pair
```

#### Local Enforcement (Modified)

```
1. Load suites-config.json
2. For each suite with local specs:
   a. Load specs from suite's local.specsDir matching local.pattern
   b. Agent explores only files matching suite's scope
   c. Per-spec-per-suite cooldown tracking
```

---

## Implementation Plan

### Phase 1: Configuration Schema

**File**: `.claude/hooks/suites-config-schema.json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["version", "suites"],
  "properties": {
    "version": { "type": "integer", "const": 1 },
    "patternLibrary": {
      "type": "string",
      "enum": ["minimatch", "micromatch"],
      "default": "minimatch"
    },
    "suites": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": ["scope"],
        "properties": {
          "description": { "type": "string" },
          "scope": { "type": "string" },
          "global": {
            "type": ["object", "null"],
            "properties": {
              "specsDir": { "type": "string" },
              "pattern": { "type": "string", "default": "*.md" }
            }
          },
          "local": {
            "type": ["object", "null"],
            "properties": {
              "specsDir": { "type": "string" },
              "pattern": { "type": "string", "default": "*.md" }
            }
          },
          "enabled": { "type": "boolean", "default": true },
          "priority": { "type": "integer", "default": 100 }
        }
      }
    },
    "enforcement": {
      "type": "object",
      "properties": {
        "global": { "type": "object" },
        "local": { "type": "object" }
      }
    }
  }
}
```

### Phase 2: Pattern Matching Library

**Decision**: Use `minimatch` (same as npm, tsconfig, .gitignore patterns)

**Installation**: Already a dependency of many Node.js tools, add if missing:
```bash
npm install minimatch
```

**Usage Pattern**:
```javascript
import { minimatch } from 'minimatch';

// Check if file matches scope
function fileMatchesScope(filePath, scopePattern) {
  return minimatch(filePath, scopePattern, {
    dot: true,  // Match dotfiles
    matchBase: false  // Require full path match
  });
}

// Examples:
fileMatchesScope('integrations/azure/frontend-connector/src/index.ts',
                 'integrations/*/frontend-connector/**')
// → true

fileMatchesScope('packages/connectors/src/client.ts',
                 'integrations/*/frontend-connector/**')
// → false
```

### Phase 3: Compliance Checker Modifications

**File**: `.claude/hooks/compliance-checker.js`

#### 3.1 Add Suite Loading

```javascript
import { minimatch } from 'minimatch';

const SUITES_CONFIG_PATH = path.join(projectDir, '.claude/hooks/suites-config.json');

function loadSuitesConfig() {
  try {
    return JSON.parse(fs.readFileSync(SUITES_CONFIG_PATH, 'utf8'));
  } catch {
    // Fall back to legacy behavior if no suites config
    return null;
  }
}

function getSuitesForFile(filePath, suitesConfig) {
  if (!suitesConfig) return null;

  const matchingSuites = [];
  for (const [suiteId, suite] of Object.entries(suitesConfig.suites)) {
    if (!suite.enabled) continue;
    if (minimatch(filePath, suite.scope, { dot: true })) {
      matchingSuites.push({ id: suiteId, ...suite });
    }
  }

  return matchingSuites.sort((a, b) => a.priority - b.priority);
}
```

#### 3.2 Modify Global Enforcement

```javascript
function runGlobalEnforcement(args) {
  const suitesConfig = loadSuitesConfig();

  if (suitesConfig) {
    return runSuiteBasedGlobalEnforcement(args, suitesConfig);
  } else {
    return runLegacyGlobalEnforcement(args); // Current behavior
  }
}

function runSuiteBasedGlobalEnforcement(args, suitesConfig) {
  // For each file in the codebase:
  // 1. Find matching suites
  // 2. For each suite, load its global specs
  // 3. Check file against suite's specs only
  // 4. Track cooldown per suite-file-spec tuple
}
```

#### 3.3 Modify Local Enforcement

```javascript
function runLocalEnforcement(args) {
  const suitesConfig = loadSuitesConfig();

  if (suitesConfig) {
    return runSuiteBasedLocalEnforcement(args, suitesConfig);
  } else {
    return runLegacyLocalEnforcement(args); // Current behavior
  }
}

function runSuiteBasedLocalEnforcement(args, suitesConfig) {
  // For each suite with local specs:
  // 1. Load specs from suite.local.specsDir matching suite.local.pattern
  // 2. Spawn agent with scope constraint (only explore suite.scope)
  // 3. Track cooldown per suite-spec pair
}
```

### Phase 4: Prompt Template Modifications

**File**: `.claude/hooks/prompts/spec-enforcement.md`

Add scope awareness:

```markdown
## Enforcement Scope

You are checking file `{{FILE_PATH}}` against spec `{{SPEC_NAME}}`.

**Suite**: {{SUITE_ID}}
**Scope Pattern**: {{SUITE_SCOPE}}

This spec only applies to files matching the scope pattern. Other files outside
this scope should be checked by different suites.
```

**File**: `.claude/hooks/prompts/local-spec-enforcement.md`

Add scope constraint:

```markdown
## Scope Constraint

You are enforcing spec `{{SPEC_NAME}}` from suite `{{SUITE_ID}}`.

**CRITICAL**: Only explore files matching this pattern:
```
{{SUITE_SCOPE}}
```

Do NOT check files outside this scope. Use Glob with this pattern to find
relevant files:
```bash
Glob("{{SUITE_SCOPE}}")
```
```

### Phase 5: State Tracking

**File**: `.claude/hooks/suites-state.json`

Track cooldowns per suite:

```json
{
  "version": 1,
  "suites": {
    "main": {
      "global": {
        "files": {
          "src/index.ts": {
            "G001.md": { "lastVerified": "2024-01-23T10:00:00Z" },
            "G003.md": { "lastVerified": "2024-01-20T10:00:00Z" }
          }
        }
      },
      "local": {
        "specs": {
          "ACTION-EXECUTOR.md": { "lastRun": "2024-01-22T10:00:00Z" }
        }
      }
    },
    "integration-frontend": {
      "global": {
        "files": {
          "integrations/azure/frontend-connector/src/index.ts": {
            "INT-FRONTEND-CONNECTOR.md": { "lastVerified": "2024-01-23T10:00:00Z" }
          }
        }
      }
    }
  }
}
```

---

## Migration Path

### Backward Compatibility

1. **If `suites-config.json` doesn't exist**: Use legacy behavior (current system)
2. **If `suites-config.json` exists**: Use suite-based enforcement
3. **Migration command**: `node compliance-checker.js --migrate-to-suites`

### Migration Steps for Projects

1. Create `.claude/hooks/suites-config.json` with main suite pointing to current specs
2. Add subset suites for component-specific specs
3. Run `--migrate-to-suites` to convert state files
4. Remove legacy `spec-file-mappings.json` (now embedded in suites)

---

## Project-Specific Example (x_test)

### Example `suites-config.json` for x_test

```json
{
  "version": 1,
  "patternLibrary": "minimatch",
  "suites": {
    "main": {
      "description": "Project-wide invariants",
      "scope": "**/*",
      "global": {
        "specsDir": "specs/global",
        "pattern": "G*.md"
      },
      "local": {
        "specsDir": "specs/local",
        "pattern": "*.md",
        "exclude": ["INTEGRATION-STRUCTURE.md"]
      },
      "enabled": true,
      "priority": 0
    },
    "integration-structure": {
      "description": "Integration directory structure",
      "scope": "integrations/**/*",
      "global": null,
      "local": {
        "specsDir": "specs/local",
        "pattern": "INTEGRATION-STRUCTURE.md"
      },
      "enabled": true,
      "priority": 5
    },
    "frontend-connector": {
      "description": "Frontend connector implementation",
      "scope": "integrations/*/frontend-connector/**",
      "global": {
        "specsDir": "specs/integrations",
        "pattern": "INT-FRONTEND-*.md"
      },
      "local": null,
      "enabled": true,
      "priority": 10
    },
    "backend-connector": {
      "description": "Backend connector implementation",
      "scope": "integrations/*/backend-connector/**",
      "global": {
        "specsDir": "specs/integrations",
        "pattern": "INT-BACKEND-*.md"
      },
      "local": null,
      "enabled": true,
      "priority": 10
    },
    "guide": {
      "description": "Integration guide and automation",
      "scope": "integrations/*/guide/**",
      "global": {
        "specsDir": "specs/integrations",
        "pattern": "INT-GUIDE-*.md"
      },
      "local": null,
      "enabled": true,
      "priority": 10
    },
    "capabilities": {
      "description": "Capability definitions",
      "scope": "integrations/*/*/src/capabilities/**",
      "global": {
        "specsDir": "specs/integrations",
        "pattern": "INT-CAPABILITIES.md"
      },
      "local": null,
      "enabled": true,
      "priority": 20
    },
    "interceptors": {
      "description": "Network interceptors",
      "scope": "integrations/*/frontend-connector/src/interceptors/**",
      "global": {
        "specsDir": "specs/integrations",
        "pattern": "INT-INTERCEPTORS.md"
      },
      "local": null,
      "enabled": true,
      "priority": 20
    }
  },
  "enforcement": {
    "global": {
      "maxAgentsPerDay": 25,
      "fileVerificationCooldownDays": 7
    },
    "local": {
      "maxAgentsPerDay": 5,
      "specCooldownDays": 7
    }
  }
}
```

---

## Critical Files to Modify

### Gentyr Framework (`/path/to/gentyr/`)

| File | Change |
|------|--------|
| `.claude/hooks/compliance-checker.js` | Add suite loading, pattern matching, suite-based enforcement |
| `.claude/hooks/suites-config-schema.json` | NEW - JSON schema for validation |
| `.claude/hooks/prompts/spec-enforcement.md` | Add suite context variables |
| `.claude/hooks/prompts/local-spec-enforcement.md` | Add scope constraint |
| `package.json` | Add `minimatch` dependency if not present |

### Project Configuration (created by each project)

| File | Description |
|------|-------------|
| `.claude/hooks/suites-config.json` | Suite definitions and enforcement settings |
| `.claude/hooks/suites-state.json` | Per-suite cooldown tracking (auto-created) |

---

## Verification Plan

### 1. Unit Tests

```bash
cd packages/mcp-servers
npm test -- --grep "suite"
```

Test cases:
- Suite loading with valid config
- Suite loading with missing config (fallback to legacy)
- Pattern matching with various glob patterns
- Suite resolution for files matching multiple suites
- Priority ordering of suites

### 2. Integration Test

```bash
# Dry run to show what would be checked
node .claude/hooks/compliance-checker.js --dry-run

# Run with suites-config.json
node .claude/hooks/compliance-checker.js --status
```

### 3. Manual Verification

1. Create `suites-config.json` in x_test
2. Run `--dry-run` to verify correct suite matching
3. Check that integration files only match integration suites
4. Check that project-wide files match main suite + any applicable subset suites

---

## Out of Scope

- UI/dashboard for suite configuration
- Real-time IDE integration
- Automatic suite generation from codebase analysis
- Suite inheritance (child suites extending parent suites)

---

## Implementation Order

1. **Phase 1**: Add `minimatch` dependency, create schema
2. **Phase 2**: Add suite loading to compliance-checker.js
3. **Phase 3**: Implement `getSuitesForFile()` with pattern matching
4. **Phase 4**: Modify global enforcement to use suites
5. **Phase 5**: Modify local enforcement to use suites
6. **Phase 6**: Update prompt templates with scope variables
7. **Phase 7**: Add state tracking for suite-based cooldowns
8. **Phase 8**: Add migration command and backward compatibility
9. **Phase 9**: Create example `suites-config.json` for x_test
10. **Phase 10**: Update documentation

---

## Summary

This plan extends the existing compliance system with a **suite-based approach**:

- **Suites** group global + local specs that apply to a directory pattern
- **Pattern matching** uses industry-standard `minimatch` (same as npm, tsconfig)
- **Backward compatible** - legacy behavior if no `suites-config.json`
- **Portable** - framework feature, projects configure via JSON

When checking a file like `integrations/azure/frontend-connector/src/index.ts`:
1. Main suite applies (G001-G020 global specs)
2. `frontend-connector` suite applies (INT-FRONTEND-* specs)
3. `capabilities` suite applies if file is in `capabilities/` subdirectory
4. Agent enforces only the specs from matching suites

This reduces noise by ensuring component-specific specs only check component-specific files.

---

## TODO: Continue Planning

1. Review the design above and refine as needed
2. Determine how suites interact when a file matches multiple suites
3. Decide on agent budget allocation across suites
4. Consider whether specs should be deduplicated across suites
