<!-- HOOK:GENTYR:product-manager -->
# /product-manager - Product Market Fit Analysis

Manage the product-market-fit (PMF) analysis pipeline. This command shows current analysis status and provides options to initiate, view, run, or report on the analysis.

## Step 1: Show Current Status

Call `mcp__product-manager__get_analysis_status()` and display:
- Overall status (not_started / pending_approval / approved / in_progress / completed)
- Section progress: show each section with a check mark (populated) or circle (empty)
- If completed: show compliance stats (mapped/total pain points)

## Step 2: Present Options Based on Status

### If status is `not_started`:
Present these options:
1. **Initiate analysis** - Call `mcp__product-manager__initiate_analysis({initiated_by: "human"})`, then report to deputy-CTO via `mcp__agent-reports__report_to_deputy_cto({title: "PMF Analysis Initiated", category: "decision", priority: "high", content: "A product-market-fit analysis has been initiated and requires your approval. Call mcp__product-manager__approve_analysis to approve."})`

### If status is `pending_approval`:
Show message: "Analysis is awaiting CTO approval. The deputy-CTO will approve during the next triage cycle."
Option: **Approve now** (if CTO is running this command) - Call `mcp__product-manager__approve_analysis({approved_by: "human"})`

### If status is `approved` or `in_progress`:
Present these options:
1. **View section** - Ask which section (1-6), then call `mcp__product-manager__read_section({section: N})`
2. **Run full pipeline** - Call `mcp__product-manager__clear_and_respawn({initiated_by: "human"})` to wipe and create tasks for all 6 sections
3. **Regenerate markdown** - Call `mcp__product-manager__regenerate_md()`
4. **Finalize analysis** (only when all 6 sections are populated) - Call `mcp__product-manager__complete_analysis({completed_by: "human"})` to validate and mark analysis as completed

### If status is `completed`:
Present all options above plus:
4. **Persona compliance** - Call `mcp__product-manager__get_compliance_report()` and display results
5. **List unmapped pain points** - Call `mcp__product-manager__list_pain_points({unmapped_only: true})`
