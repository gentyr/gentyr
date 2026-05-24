#!/usr/bin/env node
/**
 * PostToolUse Hook: CTO Alignment Spec Review
 *
 * Fires on mcp__agent-tracker__update_cto_alignment_goal_progress.
 *
 * When an update transitions a goal from <100 to 100 (transitioned_to_complete=true
 * in the response), inject additionalContext instructing user-alignment to review
 * the global and local specifications and decide whether any need to be created,
 * edited, or removed to maintain long-term alignment with the now-completed goal.
 *
 * PostToolUse hooks MUST exit 0 (the tool already ran). Fail-open on any error.
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin });
let data = '';
rl.on('line', (l) => { data += l; });
rl.on('close', () => {
  try {
    const hookInput = JSON.parse(data);
    const toolName = hookInput.tool_name || '';

    // Only act on our specific tool. The matcher in settings.json should already
    // narrow this, but check defensively in case the hook is invoked broadly.
    if (!toolName.endsWith('update_cto_alignment_goal_progress')) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const resp = hookInput.tool_response;
    const parsed = typeof resp === 'string' ? safeParse(resp) : resp;

    if (!parsed || parsed.transitioned_to_complete !== true) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const goalId = parsed.id || '<unknown>';
    const title = parsed.short_title || '<untitled>';

    const lines = [
      'CTO ALIGNMENT GOAL REACHED 100% — SPEC REVIEW REQUIRED',
      '',
      `Goal: ${title}`,
      `ID:   ${goalId}`,
      '',
      'Before completing your work, perform a spec review pass:',
      '',
      '1. Call mcp__agent-tracker__get_cto_alignment_goal({ goal_id: "' + goalId + '" })',
      '   to re-read the full verbatim CTO text behind this goal.',
      '',
      '2. Call mcp__specs-browser__list_specs to enumerate existing GLOBAL and LOCAL',
      '   specifications. Also call list_suites for suite context.',
      '',
      '3. For each existing spec relevant to this goal, decide:',
      '     - Does an existing spec ALREADY codify the goal? -> no change needed',
      '     - Would an existing spec be more accurate if edited? -> propose edit_spec',
      '     - Is there NO spec covering this goal? -> propose create_spec',
      '     - Has a prior spec been invalidated by this goal? -> propose delete_spec',
      '   Spec writes go through the protected-action-gate -> CTO approval flow;',
      '   you do not need to (and cannot) commit them yourself.',
      '',
      '4. When the spec review is complete, close the loop by calling',
      '   mcp__agent-tracker__update_cto_alignment_goal_progress({',
      '     goal_id: "' + goalId + '",',
      '     spec_review_outcome: "specs_proposed" | "no_changes_needed"',
      '   })',
      '',
      'This is part of the CTO Alignment Tracking workflow — completed goals must',
      'feed back into the living specs so long-term alignment is preserved.',
    ];

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: lines.join('\n'),
      },
    }));
    process.exit(0);
  } catch {
    // PostToolUse hooks must never block
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
