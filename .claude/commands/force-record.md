# /force-record - Force Video Recording on Next Demo

Call `mcp__playwright__force_record_next_demo({})`.

Report the result message to the user. The next demo launched via any demo
command (`/demo-interactive`, `/demo-autonomous`, `/demo-all`, `/demo-bulk`,
`/demo-session`, or direct `run_demo`/`run_demo_batch` tool call) will record
video regardless of staleness settings.
