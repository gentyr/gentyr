<!-- HOOK:GENTYR:session-queue -->
# /session-queue - Session Queue Dashboard

Call `mcp__show__show_session_queue()` to render the session queue status.

Shows:
- Running sessions (count, capacity, PID, elapsed time)
- Queued sessions (priority, lane, wait time)
- 24h throughput statistics (avg wait, completions, top sources)
