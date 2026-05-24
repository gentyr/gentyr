<!-- HOOK:GENTYR:debate -->
# /debate — Toggle Investigator Adversarial-Debate Flow

Controls whether the `investigator` sub-agent runs its adversarial-debate flow
(defender + challenger + judge) on non-trivial investigations.

This flow roughly doubles latency and triples token cost per non-trivial
investigation but produces more rigorous root-cause analysis. Use `/debate off`
to disable it project-wide when token budget is tight or the team is iterating
quickly on small fixes. Use `/tokens 7d debate` to see exactly how much it costs.

## Reliability model

The toggle is enforced at three layers — only the third (the hook) is the
ground truth:

1. **Guidance** (`agents/investigator.md`) — the agent checks the toggle and
   skips the debate cleanly when off. Saves Task calls but is not enforced.
2. **Orchestration** (`session-briefing.js`) — when off, the briefing shows a
   one-line `[DEBATE MODE: OFF]` notice so the CTO sees state at session start.
3. **Enforcement** (`.claude/hooks/debate-mode-guard.js`) — a root-owned
   PreToolUse hook denies any `Task` call with `subagent_type: "investigator"`
   AND a `DEBATE_ROLE:` marker in its prompt when the toggle is off. The agent
   literally cannot spawn debate sub-agents when disabled.

Toggling takes effect on the next Task call — no session restart, no
`npx gentyr sync` required.

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Arguments

`/debate [on|off]`

| Argument | Behavior |
|----------|---------|
| (bare)   | Show current state. |
| `on`     | Enable the adversarial-debate flow. |
| `off`    | Disable the adversarial-debate flow. |

## Workflow (for the assistant)

1. Parse the argument.

2. **Bare invocation** (no arg) — call `mcp__agent-tracker__get_debate_mode()`
   and render:
   ```
   Debate mode: ENABLED   (default — state file absent)
     Investigator runs defender + challenger + judge on non-trivial investigations.
     Run /debate off to disable.
   ```
   Or when disabled:
   ```
   Debate mode: DISABLED  (set 2026-05-24T14:30:00Z by cto)
     debate-mode-guard.js denies debate Task calls. Investigations proceed without debate.
     Run /debate on to re-enable.
   ```
   Stop.

3. **`on` argument** — call `mcp__agent-tracker__set_debate_mode({ enabled: true })`
   and render:
   ```
   Debate mode: ENABLED

   The investigator will run the adversarial-debate flow (defender + challenger + judge)
   on non-trivial investigations. The complexity-triage step in the investigator
   workflow decides which investigations qualify — trivial fixes skip debate
   regardless of this toggle.

   To measure cost: /tokens 7d debate
   ```
   Stop.

4. **`off` argument** — call `mcp__agent-tracker__set_debate_mode({ enabled: false })`
   and render:
   ```
   Debate mode: DISABLED

   The investigator will skip the debate flow on all investigations. If an
   investigator tries to spawn a defender/challenger/judge sub-agent anyway,
   the debate-mode-guard.js hook will deny the Task call.

   To re-enable: /debate on
   ```
   Stop.

5. If the MCP tool returns an `error` field (e.g. spawned-session block), render
   the error verbatim and stop.

## Notes

- The state file is at `.claude/state/debate-mode.json`. When absent, the
  default is `enabled: true`.
- Spawned sessions cannot toggle debate mode — `set_debate_mode` returns an
  error when `CLAUDE_SPAWNED_SESSION=true`. Only interactive CTO sessions
  may toggle.
- The recursion guard inside debate sub-agents (the `DEBATE_ROLE:` check at
  the top of `agents/investigator.md`) is independent of this toggle. A
  debate sub-agent always skips its own debate cycle regardless of state.
