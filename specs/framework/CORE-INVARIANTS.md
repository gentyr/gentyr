# Framework Core Invariants

These invariants apply to all code within the GENTYR. They extend (not replace) the host repository's global specs.

## Invariant Index

| ID | Name | Severity |
|----|------|----------|
| F001 | Path Resolution via CLAUDE_PROJECT_DIR | Critical |
| F002 | MCP Server Zod Validation | Critical |
| F003 | Agent Task Tracking | Required |
| F004 | Hook Fail-Loud Error Handling | Critical |
| F005 | Framework Portability | Required |

---

## F001: Path Resolution via CLAUDE_PROJECT_DIR

**All file paths in hooks and MCP servers MUST be resolved relative to `CLAUDE_PROJECT_DIR`.**

### Rationale
The framework is installed as a submodule/subdirectory. Hardcoded paths break when the framework is used in different projects.

### Correct Pattern
```javascript
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const dbPath = path.join(projectDir, '.claude', 'todo.db');
```

### Violation Pattern
```javascript
// WRONG - hardcoded path
const dbPath = '/home/user/myproject/.claude/todo.db';

// WRONG - relative to script location
const dbPath = path.join(__dirname, '../../.claude/todo.db');
```

---

## F002: MCP Server Zod Validation

**All MCP server tool inputs MUST be validated with Zod schemas.**

### Rationale
MCP servers receive untrusted input from the Claude API. Validation prevents injection attacks and ensures type safety.

### Correct Pattern
```typescript
const CreateTaskSchema = z.object({
  section: z.enum(['TEST-WRITER', 'CODE-REVIEWER', ...]),
  title: z.string().min(1).max(500),
  description: z.string().optional(),
});

// In tool handler
const parsed = CreateTaskSchema.safeParse(args);
if (!parsed.success) {
  return { error: `Validation failed: ${parsed.error.message}` };
}
```

### Violation Pattern
```typescript
// WRONG - no validation
function createTask(args: any) {
  db.run(`INSERT INTO tasks (title) VALUES (?)`, [args.title]);
}
```

---

## F003: Agent Task Tracking

**Agents MUST use MCP todo-db tools to track their work.**

### Rationale
Task tracking provides visibility into agent activity and enables coordination between agents.

### Required Behavior
1. Create tasks before starting work
2. Mark tasks `in_progress` when starting
3. Mark tasks `completed` when done
4. Only one task `in_progress` at a time per agent

### Agent Definitions Must Include
```markdown
## Task Tracking
This agent uses the `todo-db` MCP server for task management.
- Section: YOUR-SECTION-NAME
- Creates tasks for: [list of task types]
```

---

## F004: Hook Fail-Loud Error Handling

**Hooks MUST fail loudly with clear error messages. Silent error swallowing is forbidden.**

### Rationale
Per G001 (fail-closed), errors must be visible. Silent failures hide bugs and create false confidence.

### Correct Pattern
```javascript
try {
  const result = riskyOperation();
} catch (error) {
  console.error(`[hook-name] FATAL: ${error.message}`);
  console.error(error.stack);
  process.exit(1); // Non-zero exit for blocking hooks
}
```

### For Non-Blocking Hooks
```javascript
try {
  const result = riskyOperation();
} catch (error) {
  // Still log loudly, but don't block
  console.error(`[hook-name] ERROR: ${error.message}`);
  console.error(error.stack);
  // Continue or exit 0 only if explicitly designed as non-blocking
}
```

### Violation Pattern
```javascript
// WRONG - silent swallow
try {
  riskyOperation();
} catch (error) {
  // do nothing
}

// WRONG - silent fallback
try {
  return getData();
} catch {
  return []; // Hides the error
}
```

---

## F005: Framework Portability

**Framework code MUST NOT contain project-specific references.**

### Rationale
The framework is designed to be portable across projects. Project-specific code belongs in the host repository.

### Prohibited in Framework
- References to specific project names (e.g., "Context Unifier", "AcmeIntegrate")
- Hardcoded API endpoints or credentials
- Project-specific file paths
- Business logic specific to one project

### Allowed
- Generic patterns and utilities
- Configurable behaviors via environment variables
- Extension points for project customization
