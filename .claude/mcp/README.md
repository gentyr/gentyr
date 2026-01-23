# MCP Servers

This directory contains configuration for MCP (Model Context Protocol) servers used by Claude Code.

## Server Configuration

Configuration is in `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "todo-db": { "command": "node", "args": ["packages/mcp-servers/dist/todo-db/server.js"] },
    "deputy-cto": { "command": "node", "args": ["packages/mcp-servers/dist/deputy-cto/server.js"] },
    "agent-reports": { "command": "node", "args": ["packages/mcp-servers/dist/agent-reports/server.js"] },
    "cto-report": { "command": "node", "args": ["packages/mcp-servers/dist/cto-report/server.js"] },
    "agent-tracker": { "command": "node", "args": ["packages/mcp-servers/dist/agent-tracker/server.js"] },
    "specs-browser": { "command": "node", "args": ["packages/mcp-servers/dist/specs-browser/server.js"] },
    "review-queue": { "command": "node", "args": ["packages/mcp-servers/dist/review-queue/server.js"] },
    "session-events": { "command": "node", "args": ["packages/mcp-servers/dist/session-events/server.js"] }
  }
}
```

## Server Reference

### todo-db
**Purpose**: Task tracking across agent sections

**Database**: `.claude/todo.db`

**Tools**:
| Tool | Description |
|------|-------------|
| `list_tasks` | List tasks with optional section/status filter |
| `get_task` | Get single task by ID |
| `create_task` | Create task in a section |
| `start_task` | Mark task as in-progress |
| `complete_task` | Mark task as completed |
| `delete_task` | Remove task |
| `get_summary` | Task counts by section/status |
| `cleanup` | Remove stale/old tasks |
| `get_completed_since` | Tasks completed within time range |
| `get_sessions_for_task` | Find sessions that completed a task |
| `browse_session` | Read session transcript |

**Sections**: `TEST-WRITER`, `INVESTIGATOR & PLANNER`, `CODE-REVIEWER`, `PROJECT-MANAGER`

---

### deputy-cto
**Purpose**: CTO decision queue and commit approval

**Database**: `.claude/deputy-cto.db`

**Tools**:
| Tool | Description |
|------|-------------|
| `add_question` | Add question/decision for CTO |
| `list_questions` | List pending questions (titles only) |
| `read_question` | Read full question content |
| `answer_question` | Record CTO's answer with `decided_by` |
| `clear_question` | Remove answered question |
| `approve_commit` | Approve pending commit |
| `reject_commit` | Reject commit (blocks future commits) |
| `get_commit_decision` | Check commit approval status |
| `spawn_implementation_task` | Fire-and-forget Claude spawn |
| `get_pending_count` | Quick check for pending items |
| `toggle_autonomous_mode` | Enable/disable autonomous mode |
| `get_autonomous_mode_status` | Check autonomous status |
| `search_cleared_items` | Search past CTO decisions |
| `cleanup_old_records` | Prune old data |

**Decision Tracking**:
The `decided_by` field tracks who made each decision:
- `"cto"` - Human CTO
- `"deputy-cto"` - Autonomous decision

---

### agent-reports
**Purpose**: Agent report triage queue (deputy-cto triages, may escalate to CTO queue)

**Database**: `.claude/agent-reports.db`

**Tools**:
| Tool | Description |
|------|-------------|
| `report_to_deputy_cto` | Submit report for triage (all agents use this) |
| `list_reports` | List reports (titles only) |
| `read_report` | Read full report |
| `acknowledge_report` | Mark report as read |
| `start_triage` | Start triaging (deputy-cto only) |
| `complete_triage` | Complete triage (deputy-cto only) |
| `get_triage_stats` | Triage statistics |
| `get_reports_for_triage` | Pending reports for triage |

**Report Categories**: `architecture`, `security`, `performance`, `breaking-change`, `blocker`, `decision`, `other`

**Priority Levels**: `low`, `normal`, `high`, `critical`

**Flow**: Agent → `report_to_deputy_cto` → Triage Queue → Deputy-CTO → (maybe) CTO Queue

---

### cto-report
**Purpose**: Metrics dashboard for CTO

**Tools**:
| Tool | Description |
|------|-------------|
| `get_report` | Full CTO status report with all metrics |
| `get_session_metrics` | Session activity only |
| `get_task_metrics` | Task completion only |

**Report Contents**:
- Quota status (5-hour, 7-day buckets)
- Token usage (24h)
- Session counts (hook vs user triggered, by hook type)
- Pending items (questions, rejections, reports)
- Task status (by section, completed in period)
- Autonomous mode status

---

### agent-tracker
**Purpose**: Track spawned Claude agents

**Data File**: `.claude/hooks/agent-tracker-history.json`

**Tools**:
| Tool | Description |
|------|-------------|
| `list_spawned_agents` | List agents with optional filters |
| `get_agent_prompt` | Get full prompt for agent |
| `get_agent_session` | Read agent session transcript |
| `get_agent_stats` | Agent statistics |
| `list_sessions` | List all Claude sessions |
| `search_sessions` | Search session content |
| `get_session_summary` | Session summary (tools, messages) |

**Agent Types**: See `.claude/hooks/README.md` for full list

---

### specs-browser
**Purpose**: Read specification files

**Tools**:
| Tool | Description |
|------|-------------|
| `list_specs` | List specs by category |
| `get_spec` | Get full spec content |

**Categories**: `local`, `global`, `reference`

---

### review-queue
**Purpose**: Schema mapping review queue

**Database**: `.claude/review-queue.db`

**Tools**:
| Tool | Description |
|------|-------------|
| `list_pending_reviews` | List mappings needing review |
| `get_review_details` | Get full mapping details |
| `approve_review` | Approve mapping |
| `reject_review` | Reject mapping with reason |
| `get_review_stats` | Queue statistics |

---

### session-events
**Purpose**: Session event logging

**Database**: `.claude/session-events.db`

**Tools**:
| Tool | Description |
|------|-------------|
| `session_events_list` | List events with filters |
| `session_events_get` | Get event details |
| `session_events_expand` | Expand multiple events |
| `session_events_search` | Search event content |
| `session_events_timeline` | Chronological timeline |
| `session_events_record` | Record new event |

---

## Building

```bash
cd packages/mcp-servers
npm run build
```

## Testing

```bash
cd packages/mcp-servers
npm test
```

## Adding a New Server

1. Create directory: `packages/mcp-servers/src/my-server/`
2. Add files:
   - `types.ts` - Zod schemas and interfaces
   - `server.ts` - Server implementation
   - `index.ts` - Re-exports
3. Register in `packages/mcp-servers/src/index.ts`
4. Add to `.mcp.json`
5. Build: `npm run build`
6. Restart Claude Code session

## Database Management

All databases use SQLite with WAL mode:
- Main file: `*.db`
- Write-ahead log: `*.db-wal`
- Shared memory: `*.db-shm`

To reset a database:
```bash
rm .claude/my-server.db*
# Next MCP call recreates with fresh schema
```

## Troubleshooting

### MCP Server Not Loading
1. Check `.mcp.json` syntax
2. Verify dist files exist: `ls packages/mcp-servers/dist/`
3. Rebuild: `cd packages/mcp-servers && npm run build`
4. Restart Claude Code session

### Database Errors
1. Check WAL files aren't corrupted
2. Try removing and recreating: `rm .claude/my-server.db*`
3. Check disk space

### Tool Not Found
1. Verify server is in `.mcp.json`
2. Check tool is exported from server
3. Rebuild MCP servers
