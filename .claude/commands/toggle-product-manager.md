<!-- HOOK:GENTYR:toggle-product-manager -->
# /toggle-product-manager - Enable/Disable Product Market Fit Analysis

Read the current state from `.claude/autonomous-mode.json` field `productManagerEnabled`.

## If currently DISABLED:
1. Show explanation: "Product-market-fit analysis adds a product-manager agent that researches your competitive landscape, buyer personas, pricing models, and user sentiment. It integrates with the persona/feedback system."
2. Ask: "Enable product-market-fit analysis?"
3. If yes:
   - Read `.claude/autonomous-mode.json`, set `productManagerEnabled: true`, write back
   - Copy the product-manager agent: create symlink at `.claude/agents/product-manager.md` pointing to `../../.claude-framework/.claude/agents/product-manager.md`
   - Call `mcp__session-restart__session_restart({ confirm: true })` to restart with updated agent registration

## If currently ENABLED:
1. Ask: "Disable product-market-fit analysis? The agent will be removed but your analysis data in product-manager.db will be preserved."
2. If yes:
   - Read `.claude/autonomous-mode.json`, set `productManagerEnabled: false`, write back
   - Remove `.claude/agents/product-manager.md` symlink
   - Call `mcp__session-restart__session_restart({ confirm: true })` to restart with updated registration
