# Hook Patterns

Standard patterns for implementing hooks in the GENTYR.

## Hook Types

| Type | Blocking | Exit Code Matters | Use Case |
|------|----------|-------------------|----------|
| Pre-commit | Yes | Yes (non-zero blocks) | Lint, review |
| Post-commit | No | No | Background tasks |
| SessionStart | Partial | Yes for errors | Setup, notifications |
| UserPromptSubmit | Yes | Yes | Validation, routing |
| Stop | No | No | Cleanup, continue prompts |

## File Structure

```
.claude/hooks/
├── your-hook.js           # Hook implementation
├── your-hook-state.json   # Persistent state (gitignored)
├── prompts/
│   └── your-hook.md       # Prompt template (if spawning Claude)
└── __tests__/
    └── your-hook.test.js  # Tests
```

## Basic Hook Pattern

```javascript
#!/usr/bin/env node
/**
 * Hook Name - Brief description
 *
 * Type: [SessionStart|UserPromptSubmit|Stop|Pre-commit|Post-commit]
 * Blocking: [Yes|No]
 */

const fs = require('fs');
const path = require('path');

// F001: Always use CLAUDE_PROJECT_DIR
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Configuration
const CONFIG = {
  STATE_FILE: path.join(PROJECT_DIR, '.claude/hooks/your-hook-state.json'),
  // other config
};

// State management
function loadState() {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, 'utf8'));
    }
  } catch (error) {
    // F004: Log errors loudly
    console.error('[your-hook] Failed to load state:', error.message);
  }
  return { /* default state */ };
}

function saveState(state) {
  try {
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('[your-hook] Failed to save state:', error.message);
    // Don't throw - state save failure shouldn't crash the hook
  }
}

// Main logic
async function main() {
  try {
    const state = loadState();

    // Your hook logic here

    saveState(state);

    // For blocking hooks: exit 0 = allow, exit 1 = block
    process.exit(0);
  } catch (error) {
    // F004: Fail loud
    console.error('[your-hook] FATAL:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
```

## Spawning Claude Pattern

```javascript
const { spawn } = require('child_process');

function spawnClaude(prompt, options = {}) {
  const args = [
    '--dangerously-skip-permissions',
    '-p', prompt,
  ];

  // Prevent hook chains - spawned sessions shouldn't trigger more hooks
  const env = {
    ...process.env,
    CLAUDE_SPAWNED_SESSION: 'true',
  };

  if (options.fireAndForget) {
    // Non-blocking spawn
    const child = spawn('claude', args, {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
    console.log(`[hook-name] Spawned Claude session (fire-and-forget)`);
  } else {
    // Blocking spawn
    const child = spawn('claude', args, {
      stdio: 'inherit',
      env,
    });
    return new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Claude exited with code ${code}`));
      });
    });
  }
}
```

## Cooldown Pattern

```javascript
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

function shouldRun(state, key) {
  const lastRun = state.lastRuns?.[key];
  if (!lastRun) return true;

  const elapsed = Date.now() - new Date(lastRun).getTime();
  return elapsed >= COOLDOWN_MS;
}

function recordRun(state, key) {
  state.lastRuns = state.lastRuns || {};
  state.lastRuns[key] = new Date().toISOString();
}
```

## Output for Claude Code

Hooks communicate with Claude Code via stdout:

```javascript
// For SessionStart hooks - shown to user
console.log('Hook message shown in session');

// For UserPromptSubmit - can modify/block
console.log(JSON.stringify({
  decision: 'block', // or 'allow'
  reason: 'Why this prompt was blocked',
}));

// For Stop hooks - suggest continue prompt
console.log(JSON.stringify({
  continue: true,
  prompt: 'Continue with the next task...',
}));
```

## Error Handling (F004 Compliant)

```javascript
// CORRECT - Log and fail
try {
  riskyOperation();
} catch (error) {
  console.error(`[hook-name] ERROR: ${error.message}`);
  console.error(error.stack);
  process.exit(1); // For blocking hooks
}

// CORRECT - Log and continue (only for non-critical operations)
try {
  optionalOperation();
} catch (error) {
  console.error(`[hook-name] Warning: ${error.message}`);
  // Continue - but the error was logged
}

// WRONG - Silent swallow
try {
  operation();
} catch (error) {
  // Never do this
}
```

## Testing Pattern

```javascript
// __tests__/your-hook.test.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('your-hook', () => {
  let testDir;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
    fs.mkdirSync(path.join(testDir, '.claude/hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should exit 0 on success', () => {
    const result = execSync(`node your-hook.js`, {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, CLAUDE_PROJECT_DIR: testDir },
    });
    // If we get here, exit code was 0
  });

  it('should exit 1 on error', () => {
    expect(() => {
      execSync(`node your-hook.js --invalid`, {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, CLAUDE_PROJECT_DIR: testDir },
      });
    }).toThrow();
  });
});
```
