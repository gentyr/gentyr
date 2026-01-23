/**
 * Schema Mapper Hook
 *
 * Triggers when unknown schema fingerprint is encountered during federated search.
 * Spawns federation-mapper agent to analyze and create mappings.
 *
 * ## Trigger Mechanisms
 *
 * This is a CLI-driven hook that can be triggered in several ways:
 *
 * ### 1. Direct CLI Invocation
 *   node schema-mapper-hook.js trigger --platform azure --entity user --samples samples.json
 *
 * ### 2. From Backend Connector Code
 *   ```typescript
 *   import { exec } from 'child_process';
 *   const fingerprint = computeSchemaFingerprint(response.data);
 *   if (!registry.lookup(platform, entity, fingerprint).found) {
 *     exec(`node .claude/hooks/schema-mapper-hook.js trigger --platform ${platform} ...`);
 *   }
 *   ```
 *
 * ### 3. Via HTTP Webhook (requires backend integration)
 *   POST /api/internal/trigger-mapping
 *   { "platform": "azure", "entity": "user", "samples": [...] }
 *
 * ### 4. Via File Watcher (development mode)
 *   Watch packages/federation/src/mappings/requests/*.json for new files
 *   Each file triggers mapping generation for that request
 *
 * ### 5. Via MCP Tool (if exposed as MCP server)
 *   mcp__schema-mapper__trigger_mapping({ platform: "azure", entity: "user", ... })
 *
 * ### 6. Via Claude Code Session
 *   User: "Generate a mapping for Azure users"
 *   Claude: Spawns federation-mapper agent directly via Task tool
 *
 * ## Non-Blocking Review Queue
 *
 * Human reviews are NON-BLOCKING. When review is recommended:
 * 1. Mapping is stored and usable immediately
 * 2. Item added to review queue (review-queue MCP server)
 * 3. User can check/approve/reject at their convenience
 *
 * @see specs/global/G018-schema-mapping.md
 * @see .claude/agents/federation-mapper.md
 * @see .claude/mcp/review-queue-server.js
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { registerSpawn, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { getCooldown } from './config-reader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// G003: ZOD VALIDATION SCHEMAS
// ============================================================================

/**
 * Schema for triggerMapping params (G003 compliance)
 */
const TriggerMappingParamsSchema = z.object({
  platform: z.string().min(1, 'platform is required'),
  entity: z.string().min(1, 'entity is required'),
  fingerprint: z.string().min(1, 'fingerprint is required'),
  sourceSchema: z.record(z.unknown()).optional(),
  sanitizedSamples: z.array(z.unknown()).optional(),
  targetSchema: z.record(z.unknown()).optional(),
  sensitiveFields: z.array(z.string()).optional().default([])
});

// ============================================================================
// CONFIGURATION
// ============================================================================

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const CONFIG = {
  // Cooldown period in hours before re-analyzing same schema (dynamic from config)
  COOLDOWN_HOURS: getCooldown('schema_mapper', 1440) / 60, // config is in minutes, convert to hours

  // State file for tracking cooldowns (writable, in project's .claude/state/)
  STATE_FILE: path.join(PROJECT_DIR, '.claude', 'state', 'schema-mapper-state.json'),

  // Prompt template file (read-only, resolves through symlink to framework)
  PROMPT_TEMPLATE: path.join(__dirname, 'prompts', 'schema-mapper.md'),

  // Project root
  PROJECT_ROOT: PROJECT_DIR,

  // Registry path
  REGISTRY_PATH: path.join(PROJECT_DIR, 'packages', 'federation', 'src', 'registry'),

  // Daily agent spawn limit
  DAILY_AGENT_LIMIT: 10,

  // Confidence threshold for auto-approval
  CONFIDENCE_THRESHOLD: 0.7
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

function readState() {
  // File doesn't exist - use default (OK per G001)
  if (!fs.existsSync(CONFIG.STATE_FILE)) {
    return {
      cooldowns: {},
      dailySpawns: {},
      lastCleanup: null
    };
  }

  // File exists - must read successfully or throw (G001: no silent corruption)
  try {
    return JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[schema-mapper] State file corrupted at ${CONFIG.STATE_FILE}: ${message}. Delete file to reset.`);
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error(`[schema-mapper] Failed to write state: ${err.message}`);
  }
}

function getSchemaKey(platform, entity, fingerprint) {
  return `${platform}:${entity}:${fingerprint}`;
}

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

// ============================================================================
// COOLDOWN MANAGEMENT
// ============================================================================

function isOnCooldown(platform, entity, fingerprint) {
  const state = readState();
  const key = getSchemaKey(platform, entity, fingerprint);
  const cooldownTime = state.cooldowns[key];

  if (!cooldownTime) {
    return false;
  }

  const cooldownDate = new Date(cooldownTime);
  const now = new Date();
  const hoursSince = (now.getTime() - cooldownDate.getTime()) / (1000 * 60 * 60);

  return hoursSince < CONFIG.COOLDOWN_HOURS;
}

function setCooldown(platform, entity, fingerprint) {
  const state = readState();
  const key = getSchemaKey(platform, entity, fingerprint);
  state.cooldowns[key] = new Date().toISOString();
  writeState(state);
}

function checkDailyLimit() {
  const state = readState();
  const today = getTodayKey();
  const todaySpawns = state.dailySpawns[today] || 0;
  return todaySpawns < CONFIG.DAILY_AGENT_LIMIT;
}

function incrementDailySpawns() {
  const state = readState();
  const today = getTodayKey();
  state.dailySpawns[today] = (state.dailySpawns[today] || 0) + 1;

  // Cleanup old daily counts (keep last 7 days)
  const keys = Object.keys(state.dailySpawns).sort();
  while (keys.length > 7) {
    delete state.dailySpawns[keys.shift()];
  }

  writeState(state);
}

function cleanupOldCooldowns() {
  const state = readState();
  const now = new Date();
  const cutoff = CONFIG.COOLDOWN_HOURS * 2 * 60 * 60 * 1000; // 2x cooldown period

  let cleaned = 0;
  for (const key of Object.keys(state.cooldowns)) {
    const cooldownTime = new Date(state.cooldowns[key]);
    if (now.getTime() - cooldownTime.getTime() > cutoff) {
      delete state.cooldowns[key];
      cleaned++;
    }
  }

  if (cleaned > 0) {
    state.lastCleanup = now.toISOString();
    writeState(state);
    console.log(`[schema-mapper] Cleaned up ${cleaned} expired cooldowns`);
  }
}

// ============================================================================
// PROMPT GENERATION
// ============================================================================

function loadPromptTemplate() {
  // File doesn't exist - use default (OK per G001)
  if (!fs.existsSync(CONFIG.PROMPT_TEMPLATE)) {
    console.log(`[schema-mapper] Using default prompt template (${CONFIG.PROMPT_TEMPLATE} not found)`);
    return getDefaultPromptTemplate();
  }

  // File exists - must read successfully or throw (G001: no silent fallback)
  try {
    return fs.readFileSync(CONFIG.PROMPT_TEMPLATE, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[schema-mapper] Failed to read prompt template at ${CONFIG.PROMPT_TEMPLATE}: ${message}`);
  }
}

function getDefaultPromptTemplate() {
  return `# Schema Mapping Request

You are the federation-mapper agent. Your task is to create a TypeScript mapping function that transforms platform-specific data into the unified schema.

## Request Details

**Platform:** {{platform}}
**Entity:** {{entity}}
**Schema Fingerprint:** {{fingerprint}}

## Source Schema

\`\`\`json
{{sourceSchema}}
\`\`\`

## Sanitized Sample Data

\`\`\`json
{{sanitizedSamples}}
\`\`\`

## Target Unified Schema

\`\`\`json
{{targetSchema}}
\`\`\`

## Sensitive Fields Detected

{{sensitiveFields}}

## Your Task

1. Analyze the source schema and samples
2. Create field mappings with confidence scores
3. Generate the TypeScript mapping function
4. Identify edge cases and warnings
5. Request test-writer agent to create tests

Output the mapping code to: \`packages/federation/src/mappings/{{platform}}/{{entity}}.ts\`

Remember:
- Follow G018 spec requirements
- Pure functions only, no side effects
- Handle null/undefined gracefully (but don't silently swallow errors)
- Throw descriptive errors for missing required fields
`;
}

function generatePrompt(params) {
  const {
    platform,
    entity,
    fingerprint,
    sourceSchema,
    sanitizedSamples,
    targetSchema,
    sensitiveFields
  } = params;

  let template = loadPromptTemplate();

  template = template
    .replace(/\{\{platform\}\}/g, platform)
    .replace(/\{\{entity\}\}/g, entity)
    .replace(/\{\{fingerprint\}\}/g, fingerprint)
    .replace(/\{\{sourceSchema\}\}/g, JSON.stringify(sourceSchema, null, 2))
    .replace(/\{\{sanitizedSamples\}\}/g, JSON.stringify(sanitizedSamples, null, 2))
    .replace(/\{\{targetSchema\}\}/g, JSON.stringify(targetSchema, null, 2))
    .replace(
      /\{\{sensitiveFields\}\}/g,
      sensitiveFields.length > 0
        ? sensitiveFields.map(f => `- \`${f}\``).join('\n')
        : 'None detected'
    );

  return template;
}

// ============================================================================
// AGENT SPAWNING
// ============================================================================

function spawnFederationMapper(prompt, metadata) {
  const agentId = registerSpawn({
    type: AGENT_TYPES.FEDERATION_MAPPER,
    hookType: HOOK_TYPES.SCHEMA_MAPPER,
    description: `Schema mapping: ${metadata.platform}/${metadata.entity} (fingerprint: ${metadata.fingerprint.substring(0, 8)})`,
    prompt,
    metadata,
    projectDir: CONFIG.PROJECT_ROOT
  });

  console.log(`[schema-mapper] Spawning federation-mapper agent (${agentId})`);
  console.log(`[schema-mapper] Platform: ${metadata.platform}, Entity: ${metadata.entity}`);
  console.log(`[schema-mapper] Fingerprint: ${metadata.fingerprint}`);

  // Use --output-format stream-json to get real-time structured output via pipes
  const claude = spawn('claude', ['-p', prompt, '--output-format', 'stream-json'], {
    cwd: CONFIG.PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });

  claude.stdout.on('data', (data) => {
    console.log(`[federation-mapper] ${data.toString()}`);
  });

  claude.stderr.on('data', (data) => {
    console.error(`[federation-mapper] ${data.toString()}`);
  });

  claude.on('close', (code) => {
    console.log(`[schema-mapper] federation-mapper agent exited with code ${code}`);
  });

  claude.on('error', (err) => {
    console.error(`[schema-mapper] Failed to spawn claude: ${err.message}`);
    console.error(`[schema-mapper] Ensure 'claude' CLI is installed and in PATH`);
  });

  // Detach so hook can exit
  claude.unref();

  return agentId;
}

// ============================================================================
// MAIN TRIGGER FUNCTION
// ============================================================================

async function triggerMapping(params) {
  // G003: Validate params with Zod schema
  const validationResult = TriggerMappingParamsSchema.safeParse(params);
  if (!validationResult.success) {
    const errors = validationResult.error.errors
      .map(e => `${e.path.join('.')}: ${e.message}`)
      .join(', ');
    throw new Error(`[schema-mapper] Invalid params: ${errors}`);
  }

  const {
    platform,
    entity,
    fingerprint,
    sourceSchema,
    sanitizedSamples,
    targetSchema,
    sensitiveFields
  } = validationResult.data;

  // Check cooldown
  if (isOnCooldown(platform, entity, fingerprint)) {
    console.log(`[schema-mapper] Schema ${fingerprint} is on cooldown, skipping`);
    return { triggered: false, reason: 'cooldown' };
  }

  // Check daily limit
  if (!checkDailyLimit()) {
    console.log(`[schema-mapper] Daily agent limit reached, skipping`);
    return { triggered: false, reason: 'daily_limit' };
  }

  // Generate prompt
  const prompt = generatePrompt({
    platform,
    entity,
    fingerprint,
    sourceSchema: sourceSchema || {},
    sanitizedSamples: sanitizedSamples || [],
    targetSchema: targetSchema || {},
    sensitiveFields
  });

  // Set cooldown before spawning
  setCooldown(platform, entity, fingerprint);
  incrementDailySpawns();

  // Spawn agent
  const agentId = spawnFederationMapper(prompt, {
    platform,
    entity,
    fingerprint,
    sensitiveFields,
    hasSensitiveFields: sensitiveFields.length > 0
  });

  return {
    triggered: true,
    agentId,
    fingerprint
  };
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'trigger': {
      // Parse args
      const params = {};
      for (let i = 1; i < args.length; i += 2) {
        const key = args[i].replace('--', '');
        const value = args[i + 1];
        if (key === 'samples' && value) {
          try {
            const content = fs.readFileSync(value, 'utf8');
            params.sanitizedSamples = JSON.parse(content);
          } catch (err) {
            console.error(`Failed to read samples file: ${err.message}`);
            process.exit(1);
          }
        } else if (key === 'source-schema' && value) {
          try {
            const content = fs.readFileSync(value, 'utf8');
            params.sourceSchema = JSON.parse(content);
          } catch (err) {
            console.error(`Failed to read source schema file: ${err.message}`);
            process.exit(1);
          }
        } else if (key === 'target-schema' && value) {
          try {
            const content = fs.readFileSync(value, 'utf8');
            params.targetSchema = JSON.parse(content);
          } catch (err) {
            console.error(`Failed to read target schema file: ${err.message}`);
            process.exit(1);
          }
        } else if (key === 'sensitive-fields' && value) {
          params.sensitiveFields = value.split(',');
        } else {
          params[key] = value;
        }
      }

      const result = await triggerMapping(params);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'check-cooldown': {
      let platform, entity, fingerprint;
      for (let i = 1; i < args.length; i += 2) {
        const key = args[i].replace('--', '');
        const value = args[i + 1];
        if (key === 'platform') platform = value;
        if (key === 'entity') entity = value;
        if (key === 'fingerprint') fingerprint = value;
      }

      if (!platform || !entity || !fingerprint) {
        console.error('Required: --platform, --entity, --fingerprint');
        process.exit(1);
      }

      const onCooldown = isOnCooldown(platform, entity, fingerprint);
      console.log(JSON.stringify({ onCooldown }));
      break;
    }

    case 'cleanup': {
      cleanupOldCooldowns();
      console.log('Cleanup complete');
      break;
    }

    case 'stats': {
      const state = readState();
      const today = getTodayKey();
      console.log(JSON.stringify({
        activeCooldowns: Object.keys(state.cooldowns).length,
        todaySpawns: state.dailySpawns[today] || 0,
        dailyLimit: CONFIG.DAILY_AGENT_LIMIT,
        lastCleanup: state.lastCleanup
      }, null, 2));
      break;
    }

    default:
      console.log(`
Schema Mapper Hook

Usage:
  node schema-mapper-hook.js trigger --platform <platform> --entity <entity> --fingerprint <fp> [options]
  node schema-mapper-hook.js check-cooldown --platform <platform> --entity <entity> --fingerprint <fp>
  node schema-mapper-hook.js cleanup
  node schema-mapper-hook.js stats

Trigger Options:
  --samples <file>         JSON file with sanitized sample data
  --source-schema <file>   JSON file with inferred source schema
  --target-schema <file>   JSON file with target unified schema
  --sensitive-fields <csv> Comma-separated list of sensitive field paths
      `);
  }
}

main().catch(err => {
  console.error(`[schema-mapper] Error: ${err.message}`);
  process.exit(1);
});

export { triggerMapping, isOnCooldown, checkDailyLimit };
