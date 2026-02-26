#!/usr/bin/env node
/**
 * Feedback Orchestrator
 *
 * Orchestration logic for the AI User Feedback pipeline.
 * This module is imported by hourly-automation.js when userFeedbackEnabled is true.
 *
 * Pipeline:
 * 1. Check for new staging commits since last feedback run
 * 2. Get changed files from the diff
 * 3. Call user-feedback MCP to determine which personas to trigger
 * 4. Spawn isolated feedback agent sessions via feedback-launcher
 * 5. Track session completion and update run status
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const USER_FEEDBACK_DB = path.join(PROJECT_DIR, '.claude', 'user-feedback.db');

/**
 * Check if user-feedback system is configured (DB exists with personas).
 */
export async function isFeedbackConfigured() {
  if (!fs.existsSync(USER_FEEDBACK_DB)) {
    return false;
  }

  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(USER_FEEDBACK_DB, { readonly: true });
    const count = db.prepare('SELECT COUNT(*) as count FROM personas WHERE enabled = 1').get();
    db.close();
    return count.count > 0;
  } catch {
    return false;
  }
}

/**
 * Get changed files since a given commit SHA.
 * Returns an array of file paths relative to PROJECT_DIR.
 */
export function getChangedFiles(sinceSha) {
  try {
    const output = execSync(`git diff --name-only ${sinceSha}..HEAD`, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: 15000,
      stdio: 'pipe',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get the latest staging commit SHA.
 * Returns null if no staging branch or no commits.
 */
export function getLatestStagingSha() {
  try {
    return execSync('git rev-parse origin/staging 2>/dev/null || git rev-parse HEAD', {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Query user-feedback DB for personas matching changed files.
 * This replicates the get_personas_for_changes MCP tool logic.
 */
export async function getPersonasForChanges(changedFiles) {
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    return { personas: [], features: [] };
  }

  if (!fs.existsSync(USER_FEEDBACK_DB)) {
    return { personas: [], features: [] };
  }

  const db = new Database(USER_FEEDBACK_DB, { readonly: true });

  try {
    // Get all features
    const features = db.prepare('SELECT * FROM features').all();

    // Match changed files against feature patterns
    const affectedFeatureIds = new Set();
    for (const feature of features) {
      const patterns = JSON.parse(feature.file_patterns || '[]');
      for (const pattern of patterns) {
        for (const file of changedFiles) {
          if (globMatch(pattern, file)) {
            affectedFeatureIds.add(feature.id);
            break;
          }
        }
      }
    }

    if (affectedFeatureIds.size === 0) {
      db.close();
      return { personas: [], features: [] };
    }

    // Get personas mapped to affected features
    const featureIdList = Array.from(affectedFeatureIds);
    const placeholders = featureIdList.map(() => '?').join(',');

    const mappings = db.prepare(`
      SELECT DISTINCT p.id, p.name, p.consumption_mode
      FROM persona_features pf
      JOIN personas p ON p.id = pf.persona_id
      WHERE pf.feature_id IN (${placeholders})
        AND p.enabled = 1
    `).all(...featureIdList);

    const matchedFeatures = features
      .filter(f => affectedFeatureIds.has(f.id))
      .map(f => ({ id: f.id, name: f.name }));

    db.close();

    return {
      personas: mappings,
      features: matchedFeatures,
    };
  } catch (err) {
    db.close();
    return { personas: [], features: [] };
  }
}

/**
 * Start a feedback run in the user-feedback DB.
 * Returns { runId, sessions } or null on failure.
 */
export async function startFeedbackRun(triggerType, triggerRef, changedFiles, personaIds, maxConcurrent) {
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    return null;
  }

  const { randomUUID } = await import('crypto');

  const db = new Database(USER_FEEDBACK_DB);
  db.pragma('foreign_keys = ON');

  try {
    const runId = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO feedback_runs (id, trigger_type, trigger_ref, changed_features, personas_triggered, status, max_concurrent, started_at)
      VALUES (?, ?, ?, '[]', ?, 'in_progress', ?, ?)
    `).run(runId, triggerType, triggerRef || null, JSON.stringify(personaIds), maxConcurrent || 3, now);

    const sessions = [];
    for (const personaId of personaIds) {
      const sessionId = randomUUID();
      db.prepare(`
        INSERT INTO feedback_sessions (id, run_id, persona_id, status)
        VALUES (?, ?, ?, 'pending')
      `).run(sessionId, runId, personaId);
      sessions.push({ id: sessionId, persona_id: personaId });
    }

    db.close();
    return { runId, sessions };
  } catch (err) {
    db.close();
    return null;
  }
}

/**
 * Check if a persona ran recently (within cooldownHours).
 */
export async function personaRanRecently(personaId, cooldownHours) {
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    return false;
  }

  if (!fs.existsSync(USER_FEEDBACK_DB)) return false;

  const db = new Database(USER_FEEDBACK_DB, { readonly: true });
  try {
    const cutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000).toISOString();
    const recent = db.prepare(`
      SELECT COUNT(*) as count FROM feedback_sessions
      WHERE persona_id = ? AND started_at > ?
    `).get(personaId, cutoff);
    db.close();
    return recent.count > 0;
  } catch {
    db.close();
    return false;
  }
}

/**
 * Simple glob matching for file patterns.
 * Supports * (any chars except /) and ** (any chars including /).
 */
function globMatch(pattern, filePath) {
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const normalizedPath = filePath.replace(/\\/g, '/');

  let regex = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  regex = `^${regex}$`;

  try {
    return new RegExp(regex).test(normalizedPath);
  } catch {
    return false;
  }
}

/**
 * Run the feedback pipeline.
 * Called by hourly-automation.js when userFeedbackEnabled is true.
 *
 * @param {Function} log - Logging function
 * @param {object} state - State object (read/write lastFeedbackCheck)
 * @param {Function} saveState - State persistence function
 * @param {number} cooldownMs - Cooldown in milliseconds
 * @returns {Promise<{ ran: boolean, personasTriggered: number, reason: string }>}
 */
export async function runFeedbackPipeline(log, state, saveState, cooldownMs) {
  const now = Date.now();
  const timeSinceLastCheck = now - (state.lastFeedbackCheck || 0);

  if (timeSinceLastCheck < cooldownMs) {
    const minutesLeft = Math.ceil((cooldownMs - timeSinceLastCheck) / 60000);
    return { ran: false, personasTriggered: 0, reason: `Cooldown active. ${minutesLeft} minutes left.` };
  }

  // Check if feedback system is configured
  const configured = await isFeedbackConfigured();
  if (!configured) {
    return { ran: false, personasTriggered: 0, reason: 'No enabled personas configured.' };
  }

  // Get latest staging SHA to diff against
  const lastSha = state.lastFeedbackSha || null;
  const currentSha = getLatestStagingSha();

  if (!currentSha) {
    return { ran: false, personasTriggered: 0, reason: 'Could not determine current SHA.' };
  }

  if (lastSha === currentSha) {
    state.lastFeedbackCheck = now;
    saveState(state);
    return { ran: false, personasTriggered: 0, reason: 'No new commits since last check.' };
  }

  // Get changed files
  const changedFiles = lastSha ? getChangedFiles(lastSha) : [];
  if (changedFiles.length === 0 && lastSha) {
    state.lastFeedbackCheck = now;
    state.lastFeedbackSha = currentSha;
    saveState(state);
    return { ran: false, personasTriggered: 0, reason: 'No file changes detected.' };
  }

  log(`Feedback pipeline: ${changedFiles.length} files changed since ${lastSha?.substring(0, 7) || 'initial'}`);

  // Determine which personas to trigger
  const analysis = await getPersonasForChanges(changedFiles);

  if (analysis.personas.length === 0) {
    state.lastFeedbackCheck = now;
    state.lastFeedbackSha = currentSha;
    saveState(state);
    return { ran: false, personasTriggered: 0, reason: 'No personas match the changed files.' };
  }

  // Rate limit: skip personas that ran recently (4h cooldown per persona)
  const eligiblePersonas = [];
  for (const persona of analysis.personas) {
    const recent = await personaRanRecently(persona.id, 4);
    if (!recent) {
      eligiblePersonas.push(persona);
    } else {
      log(`Feedback pipeline: skipping persona "${persona.name}" (ran within 4h)`);
    }
  }

  // Rate limit: max 5 personas per run
  const selectedPersonas = eligiblePersonas.slice(0, 5);

  if (selectedPersonas.length === 0) {
    state.lastFeedbackCheck = now;
    state.lastFeedbackSha = currentSha;
    saveState(state);
    return { ran: false, personasTriggered: 0, reason: 'All matching personas ran recently.' };
  }

  log(`Feedback pipeline: triggering ${selectedPersonas.length} persona(s): ${selectedPersonas.map(p => p.name).join(', ')}`);

  // Start feedback run
  const run = await startFeedbackRun(
    'staging-push',
    currentSha,
    changedFiles,
    selectedPersonas.map(p => p.id),
    3,
  );

  if (!run) {
    return { ran: false, personasTriggered: 0, reason: 'Failed to create feedback run.' };
  }

  // Spawn feedback agents (fire-and-forget via feedback-launcher)
  const { spawnFeedbackAgent, generateMcpConfig, buildPrompt, getPersona, getScenariosForPersona } = await import('./feedback-launcher.js');
  const { randomUUID } = await import('crypto');

  // N+1 pattern: Session 1 is the default free-form session; sessions 2..N+1 are scenario-anchored.
  function buildScenarioPrompt(persona, sessionId, scenario) {
    let prompt = buildPrompt(persona, sessionId, scenario);

    // Prepend the demo pre-step instruction
    const preStep = `
## CRITICAL: Demo Pre-Step (execute FIRST)

Before doing anything else, run the demo scenario to scaffold the app state:

Call: mcp__playwright__run_demo({
  project: "${scenario.playwright_project}",
  test_file: "${scenario.test_file}",
  slow_mo: 0,
  pause_at_end: true
})

Wait for the demo to complete and the browser to pause. Then proceed with
your feedback exploration from the current page state.

`;

    return preStep + prompt;
  }

  const MAX_SCENARIOS_PER_PERSONA = 3;

  let spawned = 0;
  for (const session of run.sessions) {
    try {
      const persona = await getPersona(session.persona_id);
      const mcpConfigPath = generateMcpConfig(session.id, persona);
      const prompt = buildPrompt(persona, session.id);
      spawnFeedbackAgent(mcpConfigPath, prompt, session.id, persona.name);
      spawned++;
      log(`Feedback pipeline: spawned agent for persona "${persona.name}" (session ${session.id})`);

      // Sessions 2..N+1: One per scenario (capped)
      if (persona.consumption_mode === 'gui') {
        const scenarios = await getScenariosForPersona(session.persona_id);
        for (const scenario of scenarios.slice(0, MAX_SCENARIOS_PER_PERSONA)) {
          const scenarioFile = path.join(PROJECT_DIR, scenario.test_file);
          if (!fs.existsSync(scenarioFile)) {
            log(`Feedback: skipping scenario "${scenario.title}" — file missing: ${scenario.test_file}`);
            continue;
          }

          const sId = randomUUID();
          const sMcp = generateMcpConfig(sId, persona);
          const sPrompt = buildScenarioPrompt(persona, sId, scenario);
          spawnFeedbackAgent(sMcp, sPrompt, sId, persona.name);
          spawned++;
          log(`Feedback: spawned scenario "${scenario.title}" for ${persona.name}`);
        }
      }
    } catch (err) {
      log(`Feedback pipeline: failed to spawn agent for session ${session.id}: ${err.message}`);
    }
  }

  // Demo coverage: flag GUI personas with zero scenarios
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(USER_FEEDBACK_DB, { readonly: true });
    const uncovered = db.prepare(`
      SELECT p.name FROM personas p
      WHERE p.enabled = 1 AND p.consumption_mode = 'gui'
        AND p.id NOT IN (SELECT DISTINCT persona_id FROM demo_scenarios WHERE enabled = 1)
    `).all();
    db.close();
    if (uncovered.length > 0) {
      log(`Feedback: ${uncovered.length} GUI persona(s) lack demo scenarios: ${uncovered.map(p => p.name).join(', ')}`);
    }
  } catch { /* non-fatal */ }

  // Update state
  state.lastFeedbackCheck = now;
  state.lastFeedbackSha = currentSha;
  saveState(state);

  return {
    ran: true,
    personasTriggered: spawned,
    reason: `Triggered ${spawned} feedback agent(s) for run ${run.runId}`,
  };
}
