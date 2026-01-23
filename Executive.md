# GENTYR: Governed AI Engineering Teams

## The Problem

AI coding agents hallucinate, cut corners, and make autonomous decisions that undermine code quality. Without governance, they'll disable tests, leave placeholder code, and drift from requirements—all while appearing to work. GENTYR transforms Claude from an unreliable assistant into a managed engineering team with human oversight.

---

## Challenges & Solutions

### Hallucinated Code
*AI writes code that appears functional but contains stubs, mocks, or random number generators masquerading as real implementations.*

- **Spec Enforcement** - Global specification prohibits placeholder code; antipattern hunters detect violations
- **Commit Review Gate** - Deputy-CTO agent reviews every commit, rejects incomplete implementations
- **Code Reviewer Agent** - Dedicated specialist validates implementation completeness before commit

### Quality Sabotage
*To achieve goals faster, AI disables tests, weakens linting rules, or skips verification steps.*

- **Immutable Hooks** - Critical files (pre-commit, eslint config) are root-owned; agents cannot modify them
- **Block-No-Verify Hook** - Intercepts and blocks any attempt to bypass git hooks (--no-verify)
- **Zero-Tolerance Linting** - ESLint runs with --max-warnings 0; any warning blocks commit

### Context Fragmentation
*Different tasks require different expertise, but a single agent can't be expert at everything.*

- **8 Specialized Agents** - Investigator, code-writer, test-writer, code-reviewer, project-manager, deputy-cto, antipattern-hunter, repo-hygiene-expert
- **Agent Prompts** - Each agent has detailed instructions optimized for its domain
- **Task Routing** - Todo system routes tasks to appropriate specialist by section

### Specification Drift
*Without persistent requirements tracking, features drift from intent over multiple sessions.*

- **Specs Directory** - Global specs (G001-G018), local component specs, and reference docs persist across sessions
- **Specs Browser** - All agents can query specifications before implementing
- **Compliance Checker** - Automated enforcement scans code against mapped spec files

### Attention Bandwidth
*Human can only actively monitor 2-3 sessions while background issues accumulate.*

- **Hourly Automation** - Background task runner handles lint fixes, report triage, plan execution
- **CTO Notification Hook** - Every prompt shows status: quota, pending decisions, active tasks
- **Agent Reports Queue** - Issues accumulate in triage queue for batch review

### Autonomous Overreach
*Background agents making critical decisions without human input creates risk.*

- **Deputy-CTO Escalation** - Agents report to deputy-cto, who escalates ambiguous cases to human CTO
- **CTO Decision Queue** - Critical decisions wait for human input before proceeding
- **Emergency Bypass** - Only human can type approval phrase; agents cannot forge authorization

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
┌─────────────────────────────────────────────────────────────────────┐
│                         YOUR PROJECT                                 │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Source Code    │  Tests    │  Specs    │  CLAUDE.md         │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                              ↑                                       │
│                     [Symlinks to Framework]                         │
│                              ↓                                       │
│  ┌─────────────────── .claude/ ─────────────────────────────────┐   │
│  │  Databases (project-specific state)                           │   │
│  │  • todo.db       - Task tracking                              │   │
│  │  • deputy-cto.db - Decisions & approvals                      │   │
│  │  • reports.db    - Agent escalations                          │   │
│  └───────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                              ↓ symlinks
┌─────────────────────────────────────────────────────────────────────┐
│                    GENTYR FRAMEWORK                                  │
│  Shared across ALL projects • Updated once, applies everywhere      │
└─────────────────────────────────────────────────────────────────────┘
```

**Key Point**: Framework updates don't require changes to each project. Project state stays isolated.

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
