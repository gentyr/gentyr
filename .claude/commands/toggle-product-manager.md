<!-- HOOK:GENTYR:toggle-product-manager -->
# /toggle-product-manager - Enable/Disable Product Market Fit Analysis

Read the current state from `.claude/autonomous-mode.json` field `productManagerEnabled`.

## If currently DISABLED:
1. Show explanation: "Product-market-fit analysis adds a product-manager agent that researches your competitive landscape, buyer personas, pricing models, and user sentiment. It integrates with the persona/feedback system."
2. Ask: "Enable product-market-fit analysis?"
3. If yes:
   - Read `.claude/autonomous-mode.json`, set `productManagerEnabled: true`, write back
   - Copy the product-manager agent: create symlink at `.claude/agents/product-manager.md` pointing to `../../node_modules/gentyr/.claude/agents/product-manager.md`
   - Inform the user that changes are saved and they should restart Claude Code manually for the agent to take effect

## If currently ENABLED:
1. Ask: "Disable product-market-fit analysis? The agent will be removed but your analysis data in `.claude/state/product-manager.db` will be preserved."
2. If yes:
   - Read `.claude/autonomous-mode.json`, set `productManagerEnabled: false`, write back
   - Remove `.claude/agents/product-manager.md` symlink
   - Inform the user that changes are saved and they should restart Claude Code manually for the change to take effect
