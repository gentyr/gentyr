#!/usr/bin/env node
/**
 * Merge/Remove GENTYR hooks from settings.json
 *
 * Usage:
 *   node merge-settings.js install <project-settings> <gentyr-template>
 *   node merge-settings.js uninstall <project-settings>
 *
 * GENTYR hooks are identified by commands containing ".claude/hooks/"
 */

const fs = require('fs');
const path = require('path');

const MODE = process.argv[2];
const PROJECT_SETTINGS = process.argv[3];
const GENTYR_TEMPLATE = process.argv[4];

// Pattern to identify GENTYR-managed hooks
const GENTYR_HOOK_PATTERN = /\.claude\/hooks\//;

function isGentyrHook(hook) {
  return hook.command && GENTYR_HOOK_PATTERN.test(hook.command);
}

function loadJson(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveJson(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n');
}

function mergeHookArrays(existing, gentyr) {
  // Remove any existing GENTYR hooks first
  const projectHooks = (existing || []).filter(entry => {
    if (!entry.hooks) return true;
    entry.hooks = entry.hooks.filter(h => !isGentyrHook(h));
    return entry.hooks.length > 0 || entry.matcher !== '';
  });

  // Add GENTYR hooks
  for (const gentyrEntry of (gentyr || [])) {
    // Find matching entry by matcher
    let found = projectHooks.find(e => e.matcher === gentyrEntry.matcher);
    if (!found) {
      found = { matcher: gentyrEntry.matcher, hooks: [] };
      projectHooks.push(found);
    }
    // Add GENTYR hooks to this entry
    for (const hook of (gentyrEntry.hooks || [])) {
      if (isGentyrHook(hook)) {
        // Check for duplicate by command
        const exists = found.hooks.some(h => h.command === hook.command);
        if (!exists) {
          found.hooks.push(hook);
        }
      }
    }
  }

  return projectHooks;
}

function removeGentyrHooks(existing) {
  if (!existing) return [];

  return existing.map(entry => {
    if (!entry.hooks) return entry;
    return {
      ...entry,
      hooks: entry.hooks.filter(h => !isGentyrHook(h))
    };
  }).filter(entry => entry.hooks && entry.hooks.length > 0);
}

function install() {
  if (!GENTYR_TEMPLATE) {
    console.error('Usage: merge-settings.js install <project-settings> <gentyr-template>');
    process.exit(1);
  }

  const template = loadJson(GENTYR_TEMPLATE);
  if (!template) {
    console.error(`Cannot read template: ${GENTYR_TEMPLATE}`);
    process.exit(1);
  }

  // Load existing or create new
  let settings = loadJson(PROJECT_SETTINGS) || {};

  // Merge hooks for each hook type (dynamically from template)
  const hookTypes = Object.keys(template.hooks || {});

  for (const hookType of hookTypes) {
    if (template.hooks[hookType]) {
      settings.hooks = settings.hooks || {};
      settings.hooks[hookType] = mergeHookArrays(
        settings.hooks[hookType],
        template.hooks[hookType]
      );
    }
  }

  // Preserve all other settings from project, add any new top-level keys from template
  for (const key of Object.keys(template)) {
    if (key !== 'hooks' && !(key in settings)) {
      settings[key] = template[key];
    }
  }

  saveJson(PROJECT_SETTINGS, settings);
  console.log('  Merged GENTYR hooks into settings.json');
}

function uninstall() {
  const settings = loadJson(PROJECT_SETTINGS);
  if (!settings) {
    console.log('  No settings.json found');
    return;
  }

  if (!settings.hooks) {
    console.log('  No hooks in settings.json');
    return;
  }

  // Iterate over all hook types in settings (dynamically)
  const hookTypes = Object.keys(settings.hooks);
  let removed = 0;

  for (const hookType of hookTypes) {
    if (settings.hooks[hookType]) {
      const before = JSON.stringify(settings.hooks[hookType]);
      settings.hooks[hookType] = removeGentyrHooks(settings.hooks[hookType]);
      if (JSON.stringify(settings.hooks[hookType]) !== before) {
        removed++;
      }
      // Remove empty hook type arrays
      if (settings.hooks[hookType].length === 0) {
        delete settings.hooks[hookType];
      }
    }
  }

  // Remove hooks object if empty
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  saveJson(PROJECT_SETTINGS, settings);
  console.log(`  Removed GENTYR hooks from settings.json (${removed} hook types modified)`);
}

// Main
if (MODE === 'install') {
  install();
} else if (MODE === 'uninstall') {
  uninstall();
} else {
  console.error('Usage: merge-settings.js <install|uninstall> <project-settings> [gentyr-template]');
  process.exit(1);
}
