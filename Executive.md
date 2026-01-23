# GENTYR: Autonomous AI Engineering Team
**G**odlike **E**ntity, **N**ot **T**echnically **Y**our **R**eplacement

## The Problem

AI coding agents hallucinate, cut corners, and make autonomous decisions that undermine code quality. Without governance, they'll disable tests, leave placeholder code, and drift from requirements—all while appearing to work. GENTYR transforms Claude from an unreliable assistant into a managed engineering team with human oversight.

---

## 6 Key Challenges & Solutions

### 1. Hallucinated Code
- **Problem**: AI writes code that appears functional but contains stubs, mocks, or random number generators masquerading as real implementations.
- **Solution**: Spec enforcement prohibits placeholder code; commit review gate and code reviewer agent reject incomplete implementations.

### 2. Quality Sabotage
- **Problem**: To achieve goals faster, AI disables tests, weakens linting rules, or skips verification steps.
- **Solution**: Critical config files are root-owned (immutable to agents); hooks block any attempt to bypass verification.

### 3. Context Fragmentation
- **Problem**: Different tasks require different expertise, but a single agent can't be expert at everything.
- **Solution**: 8 specialized agents with domain-optimized prompts; task routing sends work to the right specialist.

### 4. Specification Drift
- **Problem**: Without persistent requirements tracking, features drift from intent over multiple sessions.
- **Solution**: Specs directory persists across sessions; all agents query specs before implementing; compliance checker enforces mappings.

### 5. Attention Bandwidth
- **Problem**: Human can only actively monitor 2-3 sessions while background issues accumulate.
- **Solution**: Hourly automation handles routine tasks; CTO notification hook shows status on every prompt; issues queue for batch review.

### 6. Autonomous Overreach
- **Problem**: Background agents making critical decisions without human input creates risk.
- **Solution**: Deputy-CTO escalates ambiguous cases; critical decisions wait for human input; only humans can authorize emergency bypasses.

---

## Capability Inventory

| Capability | What It Does & Why It Matters |
|------------|-------------------------------|
| **Commit Approval Gate** | Every commit requires deputy-cto review before merge, preventing broken or malicious code from entering the codebase. |
| **Specification Enforcement** | Antipattern hunters scan code against project specs, catching violations before they compound. |
| **Multi-Agent Specialization** | 8 specialized agents ensure each task gets domain expertise rather than generalist guessing. |
| **Task Orchestration** | Cross-agent todo system coordinates work across sessions, preventing duplicate effort and dropped tasks. |
| **CTO Escalation Queue** | Agents bubble up questions and decisions to human CTO rather than guessing wrong. |
| **Emergency Bypass** | Human-only approval mechanism for urgent situations, cryptographically tied to user input. |
| **Background Automation** | Hourly task runner handles lint fixes, report triage, and plan execution without human prompting. |
| **API Quota Management** | Multi-key rotation and usage optimization prevents quota exhaustion mid-task. |
| **Audit Trail** | Every agent spawn, decision, and task completion is logged for accountability. |
| **Framework Separation** | GENTYR installs as symlinks, keeping framework code separate from project code. |

---

## Architecture

```
┌──────────────────────────────────┐      ┌──────────────────────────────────┐
│      GENTYR FRAMEWORK            │      │       YOUR PROJECT               │
│      (central repo)              │      │       (any repo)                 │
│                                  │      │                                  │
│  packages/                       │      │  src/                            │
│   └─ mcp-servers/                │      │  tests/                          │
│       ├─ todo-db                 │      │  specs/                          │
│       ├─ deputy-cto              │      │  CLAUDE.md                       │
│       ├─ specs-browser           │      │                                  │
│       └─ ...                     │      │  .claude/                        │
│                                  │      │   ├─ agents/ ←───────────────────┼──── symlink
│  .claude/                        │      │   ├─ hooks/ ←────────────────────┼──── symlink
│   ├─ agents/   ─────────────────────────┼───→                              │
│   ├─ hooks/    ─────────────────────────┼───→                              │
│   └─ skills/   ─────────────────────────┼───→ skills/ ←────────────────────┼──── symlink
│                                  │      │   │                              │
│                                  │      │   └─ LOCAL DATA (not symlinked)  │
│                                  │      │       ├─ todo.db                 │
│                                  │      │       ├─ deputy-cto.db           │
│                                  │      │       └─ reports.db              │
└──────────────────────────────────┘      └──────────────────────────────────┘

         SHARED CODE                              PROJECT STATE
    (update once, all projects                (isolated per project,
     get changes automatically)                never shared)
```

**How it works:**
1. Install GENTYR once on your machine
2. Run install script in any project → creates symlinks to GENTYR's agents, hooks, and skills
3. Claude Code in that project now uses GENTYR's governance
4. Each project maintains its own databases (tasks, decisions, reports)

### MCP Servers (10 Tool APIs)
- **todo-db** - Task tracking and cross-agent coordination
- **deputy-cto** - Decision queue and approval management
- **agent-reports** - Escalation and issue reporting
- **specs-browser** - Specification lookup and compliance queries
- **review-queue** - Code review tracking and status
- **agent-tracker** - Agent spawn monitoring and audit trail
- **session-events** - Session lifecycle and state management
- **cto-report** - Executive status report generation
- **cto-reports** - Historical report storage and retrieval
- **gentyr-dashboard** - System-wide activity visualization

### Specialized Agents (8 Domain Experts)
- **investigator** - Root cause analysis and debugging
- **code-writer** - Implementation with spec compliance
- **test-writer** - Test coverage and validation
- **code-reviewer** - Pre-commit quality review
- **project-manager** - Task coordination and prioritization
- **deputy-cto** - Escalation filtering and CTO briefings
- **antipattern-hunter** - Spec violation detection
- **repo-hygiene-expert** - Architecture and dead code analysis

### Automation Hooks (16 Event Handlers)
- **pre-commit-review** - Triggers deputy-cto review before commits
- **block-no-verify** - Prevents git hook bypass attempts
- **compliance-checker** - Scans code against spec mappings
- **antipattern-hunter-hook** - Detects spec violations on file changes
- **cto-notification-hook** - Displays status on every prompt
- **hourly-automation** - Background task execution
- **api-key-watcher** - Quota monitoring and key rotation
- **usage-optimizer** - API cost optimization
- **agent-tracker** - Logs all agent spawns
- **plan-executor** - Runs approved implementation plans
- **todo-maintenance** - Task list cleanup and updates
- **bypass-approval-hook** - Emergency bypass authorization
- **stop-continue-hook** - Session interruption handling
- **mapping-validator** - Spec-to-code mapping verification
- **schema-mapper-hook** - Automatic spec mapping suggestions
- **config-reader** - Centralized configuration access

---

## Protection Model

Critical hooks are root-owned, making them immutable to AI agents. Only human CTO can:

- Approve emergency bypasses
- Modify commit review logic
- Disable protections

This creates a trust hierarchy where agents operate within boundaries they cannot modify.

---

## Activity Dashboard (`/gentyr`)

The `/gentyr` command provides real-time visibility into the entire GENTYR system. Here's an example with representative data:

```
================================================================================================================
                                    G E N T Y R   D A S H B O A R D
                               Godlike Entity, Not Technically Your Replacement
================================================================================================================
 Generated: 2026-01-23 14:32:05                                                         Period: Last 24 hours
================================================================================================================

+-----------------------------------+-------------------------------------------+
| SYSTEM HEALTH                     | QUOTA STATUS                              |
+-----------------------------------+-------------------------------------------+
| Autonomous Mode: ENABLED          | 5-hour  [========  ] 78% (resets 2.3h)    |
| Protection:      PROTECTED        | 7-day   [======    ] 58% (resets 4.2d)    |
| Next Automation: lint-check (12m) | Sonnet  [===       ] 29% (resets 4.2d)    |
+-----------------------------------+-------------------------------------------+

+-----------------------------------------------------------------------------------------------+
| AGENT ACTIVITY (24h)                                                                          |
+-----------------------------------------------------------------------------------------------+
| Total Spawns: 47 (24h) / 312 (7d) / 1,847 (all time)                                          |
|                                                                                               |
| By Type:                               By Hook:                                               |
|   task-runner-investigator .. 12         hourly-automation ...... 28                          |
|   deputy-cto-review ........ 8           pre-commit-review ...... 15                          |
|   antipattern-hunter ....... 6           compliance-checker ..... 4                           |
|   lint-fixer ............... 5           antipattern-hunter ..... 0                           |
|   code-reviewer ............ 4                                                                |
|   todo-processing .......... 3                                                                |
|                                                                                               |
| Recent:                                                                                       |
|   * 14:12 lint-fixer - Fixing 8 lint errors in src/components                                 |
|   * 13:45 deputy-cto-review - Triaging 3 pending CTO reports                                  |
|   * 13:30 task-runner-investigator - Investigating auth flow bug                              |
+-----------------------------------------------------------------------------------------------+

+-----------------------------------------------------------------------------------------------+
| HOOK EXECUTIONS (24h)                                                                         |
+-----------------------------------------------------------------------------------------------+
| Total: 156 executions | Success Rate: 94.2%                                                   |
|                                                                                               |
| Hook                    Total  Success  Fail  Skip   Avg Time                                 |
| -----------------------+------+--------+------+------+----------                              |
| pre-commit-review         45       43      2     0      1.2s                                  |
| hourly-automation         24       24      0     0      8.5s                                  |
| api-key-watcher           48       48      0     0      0.3s                                  |
| compliance-checker         8        6      2     0     45.2s                                  |
| todo-maintenance          31       30      1     0      0.8s                                  |
|                                                                                               |
| Recent Failures:                                                                              |
|   * 10:45 pre-commit-review - MCP timeout after 30s                                           |
|   * 09:12 compliance-checker - Spec file HEIMDALL.md not found                                |
+-----------------------------------------------------------------------------------------------+

+-----------------------------------+-------------------------------------------+
| TASK PIPELINE                     | CTO QUEUE                                 |
+-----------------------------------+-------------------------------------------+
| Pending: 12 | In Progress: 3      | Pending Questions: 2                      |
| Completed (24h): 28               | Rejections: 1                             |
| Stale (>30min): 0                 | Pending Reports: 0                        |
|                                   |                                           |
| By Section:          P | I | C    | COMMITS: ALLOWED                          |
|   CODE-REVIEWER      3 | 1 | 8    |                                           |
|   INVESTIGATOR       4 | 1 | 10   | Recent Escalations:                       |
|   TEST-WRITER        2 | 0 | 5    |   * Security: SQL injection risk in API   |
|   PROJECT-MANAGER    3 | 1 | 5    |   * Decision: Redis vs in-memory cache    |
+-----------------------------------+-------------------------------------------+

+-----------------------------------------------------------------------------------------------+
| TOKEN USAGE (24h)                                                                             |
+-----------------------------------------------------------------------------------------------+
| Input: 2.4M | Output: 890K | Cache Read: 12.1M | Cache Write: 450K                            |
| Total: 15.8M tokens | Cache Hit Rate: 83.4%                                                   |
|                                                                                               |
| Sessions: 47 task-triggered | 12 user-triggered | 59 total                                    |
+-----------------------------------------------------------------------------------------------+

+-----------------------------------+-------------------------------------------+
| API KEY HEALTH                    | COMPLIANCE CHECKER                        |
+-----------------------------------+-------------------------------------------+
| Active Key: 3f8a92b1...           | Global Agents Today: 4 / 22               |
| Total: 3 | Usable: 3 | Exhaust: 0 | Local Agents Today: 1 / 3                 |
| Rotation Events (24h): 2          | Last Run: 6h ago                          |
|                                   |                                           |
| Key        5h    7d    Status     | Files Needing Check: 12                   |
| 3f8a...    78%   58%   active     |                                           |
| 9bc4...    45%   32%   standby    |                                           |
| 2de7...    12%   89%   standby    |                                           |
+-----------------------------------+-------------------------------------------+

================================================================================================================
 Run /cto-report for detailed metrics | /deputy-cto for interactive briefing
================================================================================================================
```

**Key Metrics Explained:**
- **System Health** - Shows if autonomous mode is running and critical files are protected
- **Quota Status** - Real-time API usage with reset timers to prevent mid-task exhaustion
- **Agent Activity** - Which specialized agents are working and what triggered them
- **Hook Executions** - Success rate and performance of automation hooks
- **Task Pipeline** - Cross-session task coordination status by specialist type
- **CTO Queue** - Items awaiting human decision (blocks commits when non-empty)
- **Token Usage** - Cost visibility with cache efficiency metrics
- **API Key Health** - Multi-key rotation status for quota resilience
- **Compliance** - Spec enforcement activity and pending verifications
