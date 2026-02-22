#!/usr/bin/env node
// ARCHIVED: Binary patching replaced by rotation proxy (scripts/rotation-proxy.js).
// Kept as research reference — see CLAUDE.md "Binary Patch Research" section.
// Do not use in production. The rotation proxy handles credential swap at the
// network level, eliminating the need for binary modification.

/**
 * Binary Patch: Claude Code credential memoization (iB/oR) TTL injection.
 *
 * Claude Code caches OAuth credentials in memory via iB = oR(() => { ... }),
 * where oR() is a lazy-singleton memoization wrapper. The cache is only cleared by:
 *   - SRA() — proactive refresh, fires at ~5 min before token expiry
 *   - r6T() — 401 recovery, fires on HTTP 401 response
 *   - XFT() — after saving new OAuth tokens
 *
 * For QUOTA rotation (GENTYR switches to a different account while the old token
 * is still valid), neither mechanism fires. The old token has hours of life left,
 * so SRA() doesn't trigger, and the API returns 429 (not 401) so r6T() doesn't
 * fire either. Result: Claude Code keeps using the old (exhausted) account's
 * cached token until it naturally expires.
 *
 * This script patches the binary to inject a periodic setInterval that calls nLD()
 * every 60 seconds. nLD() clears BOTH cache layers:
 *   - Layer 1: iB.cache?.clear?.() — oR memoization cache
 *   - Layer 2: El() — clears jV (Keychain cache state)
 * After clearing, the next credential read re-fetches from Keychain, picking up
 * any new credentials written by GENTYR's rotation hooks.
 *
 * Usage:
 *   node scripts/patch-credential-cache.js                    # dry-run (default)
 *   node scripts/patch-credential-cache.js --apply            # apply patch
 *   node scripts/patch-credential-cache.js --verify           # check if patched
 *   node scripts/patch-credential-cache.js --restore          # restore from backup
 *   node scripts/patch-credential-cache.js --binary /path     # custom binary path
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const MODE_APPLY = args.includes('--apply');
const MODE_VERIFY = args.includes('--verify');
const MODE_RESTORE = args.includes('--restore');
const MODE_DRY_RUN = !MODE_APPLY && !MODE_VERIFY && !MODE_RESTORE;

const binaryIdx = args.indexOf('--binary');
const customBinary = binaryIdx >= 0 ? args[binaryIdx + 1] : null;

const STATE_DIR = path.join(os.homedir(), '.claude', 'state');
const PATCH_HISTORY_PATH = path.join(STATE_DIR, 'patch-history.json');

// The injection payload is determined at patch time based on detected symbol names.
// It calls the cache-clearing function every 60 seconds.
// Arrow function form defers lookup to callback time (essential).
// Placeholder — resolved by resolveCacheClearFn() before use.
let INJECTION_PAYLOAD = null;
let CACHE_CLEAR_FN = null;

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

function findClaudeBinary() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];

  if (customBinary) {
    try {
      const resolved = fs.realpathSync(customBinary);
      return resolved;
    } catch {
      throw new Error(`Custom binary not found: ${customBinary}`);
    }
  }

  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Candidate doesn't exist, try next
    }
  }

  throw new Error(
    'Could not find Claude Code binary. Checked:\n' +
    candidates.map(c => `  - ${c}`).join('\n') +
    '\nUse --binary to specify path.'
  );
}

// ---------------------------------------------------------------------------
// Pattern search — version-resilient regex patterns
// ---------------------------------------------------------------------------

// Version-resilient patterns: detect structure, not specific symbol names.
// v2.1.34: nLD/iB/oR/El/jV/yW/SRA/r6T
// v2.1.50: aRD/uB/OA/cs/dy/hW/zmA/Yy
const PATTERNS = [
  {
    name: 'cache_clear_fn',
    // The function that clears credential cache + Keychain cache.
    // v2.1.34: function nLD(){iB.cache?.clear?.(),El()}
    // v2.1.50: function aRD(){uB.cache?.clear?.(),cs()}
    regex: /function ([\w$]+)\(\)\{([\w$]+)\.cache\?\.\s*clear\?\.\(\),([\w$]+)\(\)\}/g,
    required: true,
    captures: ['cacheClearFn', 'credentialVar', 'keychainClearFn'],
  },
  {
    name: 'credential_memoized',
    // The memoized OAuth credential reader assignment.
    // v2.1.34: iB=oR(()=>{
    // v2.1.50: uB=OA(()=>{  (followed by claudeAiOauth within ~500 chars)
    regex: /([\w$]+)=([\w$]+)\(\(\)=>\{(?:(?!\}\)\}).){0,500}claudeAiOauth/g,
    required: false,
    captures: ['credentialVar', 'memoWrapper'],
  },
  {
    name: 'credential_cache_clear',
    // Cache invalidation calls (credential var)
    regex: /([\w$]+)\.cache\?\.\s*clear\?\.\(\)/g,
    required: false,
  },
  {
    name: 'keychain_clear_fn',
    // Keychain cache invalidation
    // v2.1.34: function El(){jV=...}
    // v2.1.50: function cs(){dy={data:null,valid:!1}}
    regex: /function ([\w$]+)\(\)\{([\w$]+)=\{data:null/g,
    required: false,
  },
  {
    name: 'keychain_read',
    // The actual keychain/file read
    // v2.1.34: yW().read()
    // v2.1.50: hW().read()
    regex: /([\w$]+)\(\)\.read\(\)/g,
    required: false,
  },
  {
    name: '401_recovery',
    // 401 recovery handler — calls cache clear then checks cached credentials
    // v2.1.34: async function r6T(
    // v2.1.50: async function Yy(T){aRD();
    regex: /async function ([\w$]+)\([\w$]*\)\{([\w$]+)\(\);let [\w$]+=[\w$]+\(\);if\(![\w$]+\?\.refreshToken\)/g,
    required: false,
  },
];

function searchPatterns(source) {
  const results = {};

  for (const pat of PATTERNS) {
    const matches = [];
    let match;
    // Reset regex state
    pat.regex.lastIndex = 0;
    while ((match = pat.regex.exec(source)) !== null) {
      const entry = {
        offset: match.index,
        text: match[0],
      };
      // Capture named groups if defined
      if (pat.captures) {
        entry.captures = {};
        for (let i = 0; i < pat.captures.length; i++) {
          entry.captures[pat.captures[i]] = match[i + 1];
        }
      }
      matches.push(entry);
    }
    results[pat.name] = matches;
  }

  return results;
}

/**
 * Resolve the cache-clearing function name from pattern search results.
 * When multiple cache_clear_fn matches exist, picks the one whose function
 * name appears in the 401 recovery handler (the credential-related one).
 * Sets CACHE_CLEAR_FN and INJECTION_PAYLOAD globals.
 */
function resolveCacheClearFn(results) {
  const candidates = results.cache_clear_fn;
  if (!candidates || candidates.length === 0) {
    throw new Error('Cannot determine cache-clearing function name from patterns');
  }

  let chosen = candidates[0];

  // If multiple matches, narrow by checking which function name appears in 401 recovery
  if (candidates.length > 1 && results['401_recovery']?.length > 0) {
    const recoveryText = results['401_recovery'][0].text;
    for (const c of candidates) {
      const fnName = c.captures?.cacheClearFn;
      if (fnName && recoveryText.includes(fnName + '()')) {
        chosen = c;
        break;
      }
    }
  }

  if (!chosen?.captures?.cacheClearFn) {
    throw new Error('Cannot determine cache-clearing function name from patterns');
  }

  CACHE_CLEAR_FN = chosen.captures.cacheClearFn;
  INJECTION_PAYLOAD = `;setInterval(()=>{${CACHE_CLEAR_FN}()},6e4)`;
  // Store the chosen match for injection point calculation
  chosen._chosen = true;
  return CACHE_CLEAR_FN;
}

/**
 * Get the chosen cache_clear_fn match (the one marked by resolveCacheClearFn).
 */
function getChosenCacheClearMatch(results) {
  return results.cache_clear_fn.find(m => m._chosen) || results.cache_clear_fn[0];
}

// ---------------------------------------------------------------------------
// Injection point discovery
// ---------------------------------------------------------------------------

/**
 * Find the end of the cache-clearing function definition.
 *
 * v2.1.34: function nLD(){iB.cache?.clear?.(),El()}
 * v2.1.50: function aRD(){uB.cache?.clear?.(),cs()}
 * We find the opening brace after the function and match to its closing brace.
 * The injection goes right after the closing brace, still inside the
 * enclosing module factory scope where the cache variables are accessible.
 */
function findInjectionPoint(source, nldOffset) {
  // Find the opening brace of the function body
  const openBrace = source.indexOf('{', nldOffset);
  if (openBrace === -1) {
    throw new Error(`Cannot find opening brace for nLD at offset ${nldOffset}`);
  }

  // Walk forward matching braces to find the end of the function
  let depth = 0;
  let i = openBrace;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        // i is the closing brace of the nLD function body.
        // Injection point is right after this closing brace.
        return i + 1;
      }
    }
    i++;
  }

  throw new Error(`Cannot find closing brace for nLD function starting at offset ${openBrace}`);
}

// ---------------------------------------------------------------------------
// Patch detection (for --verify)
// ---------------------------------------------------------------------------

// Match any version of the injection: setInterval(()=>{FUNCNAME()},6e4)
const PATCH_SIGNATURE_REGEX = /setInterval\(\(\)=>\{([\w$]+)\(\)\},6e4\)/;

function isPatchPresent(source) {
  return PATCH_SIGNATURE_REGEX.test(source);
}

function findPatchSignature(source) {
  const m = source.match(PATCH_SIGNATURE_REGEX);
  return m ? { text: m[0], fn: m[1], index: source.indexOf(m[0]) } : null;
}

// ---------------------------------------------------------------------------
// Backup management
// ---------------------------------------------------------------------------

function getBackupPath(binaryPath) {
  return binaryPath + '.bak';
}

function createBackup(binaryPath) {
  const backupPath = getBackupPath(binaryPath);

  if (fs.existsSync(backupPath)) {
    // Verify backup matches original size (don't overwrite a good backup with a patched binary)
    const origSize = fs.statSync(binaryPath).size;
    const backupSize = fs.statSync(backupPath).size;

    // If backup is same size, it was taken from a clean binary — keep it
    if (origSize === backupSize) {
      console.log(`Backup already exists (${backupPath}), sizes match — keeping existing backup.`);
      return backupPath;
    }

    // If backup is different size, the binary was already patched when previous backup was taken,
    // OR the backup is from a clean version. We need to be careful here.
    // If the current binary appears unpatched, this is a fresh backup opportunity.
    const currentBuffer = fs.readFileSync(binaryPath);
    if (!isPatchPresent(currentBuffer.toString('latin1'))) {
      console.log(`Replacing stale backup (size mismatch: binary=${origSize}, backup=${backupSize}).`);
      fs.copyFileSync(binaryPath, backupPath);
      return backupPath;
    }

    // Current binary is patched and backup has different size — backup is likely from clean version.
    // Keep the existing backup since it's probably the clean one.
    console.log(`Binary appears patched; keeping existing backup as clean reference.`);
    return backupPath;
  }

  fs.copyFileSync(binaryPath, backupPath);
  console.log(`Created backup: ${backupPath}`);
  return backupPath;
}

// ---------------------------------------------------------------------------
// Code signing
// ---------------------------------------------------------------------------

function codesign(binaryPath) {
  if (process.platform !== 'darwin') {
    console.log('Not on macOS — skipping codesign.');
    return;
  }

  console.log('Re-signing binary with ad-hoc signature...');
  try {
    execFileSync('codesign', ['--force', '--sign', '-', binaryPath], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: 'pipe',
    });
    console.log('Codesign succeeded.');
  } catch (err) {
    throw new Error(`Codesign failed: ${err.stderr || err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Post-patch verification
// ---------------------------------------------------------------------------

function verifyBinaryWorks(binaryPath) {
  console.log('Verifying binary works...');
  try {
    const output = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: 'pipe',
    });
    console.log(`Binary output: ${output.trim()}`);
    return true;
  } catch (err) {
    throw new Error(`Binary verification failed: ${err.stderr || err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Patch history recording
// ---------------------------------------------------------------------------

function loadPatchHistory() {
  try {
    return JSON.parse(fs.readFileSync(PATCH_HISTORY_PATH, 'utf8'));
  } catch {
    return { patches: [] };
  }
}

function savePatchHistory(history) {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  fs.writeFileSync(PATCH_HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
}

function recordPatch(entry) {
  const history = loadPatchHistory();
  history.patches.push({
    timestamp: new Date().toISOString(),
    ...entry,
  });
  savePatchHistory(history);
}

// ---------------------------------------------------------------------------
// Mode: --dry-run (default)
// ---------------------------------------------------------------------------

function runDryRun(binaryPath) {
  console.log('=== Credential Cache Patch — DRY RUN ===');
  console.log(`Binary: ${binaryPath}`);
  const stat = fs.statSync(binaryPath);
  console.log(`Size: ${(stat.size / 1024 / 1024).toFixed(1)} MB (${stat.size} bytes)`);
  console.log('');

  console.log('Reading binary...');
  const buffer = fs.readFileSync(binaryPath);
  const source = buffer.toString('latin1');
  console.log(`Read ${buffer.length} bytes.`);
  console.log('');

  // Check if already patched
  if (isPatchPresent(source)) {
    console.log('STATUS: Binary is already PATCHED (setInterval injection detected).');
    console.log('');
  }

  // Pattern search
  console.log('=== Pattern Search ===');
  const results = searchPatterns(source);
  let found = 0;
  let total = 0;

  for (const pat of PATTERNS) {
    total++;
    const matches = results[pat.name];
    if (matches.length > 0) {
      found++;
      console.log(`  ${pat.name}: ${matches.length} match(es)`);
      for (const m of matches.slice(0, 3)) {
        console.log(`    offset=${m.offset} (0x${m.offset.toString(16)}): ${m.text.slice(0, 80)}`);
      }
    } else {
      const tag = pat.required ? 'REQUIRED' : 'optional';
      console.log(`  ${pat.name}: NO MATCHES [${tag}]`);
    }
  }
  console.log('');

  // Check required patterns
  const missingRequired = PATTERNS.filter(p => p.required && results[p.name].length === 0);
  if (missingRequired.length > 0) {
    console.error('ERROR: Missing required patterns:');
    for (const p of missingRequired) {
      console.error(`  - ${p.name}: ${p.regex}`);
    }
    process.exit(1);
  }

  // Resolve cache-clearing function name and build payload
  const fnName = resolveCacheClearFn(results);
  console.log(`  Cache-clearing function: ${fnName}`);
  console.log('');

  // Determine injection point
  const fnMatch = getChosenCacheClearMatch(results);
  const injectionOffset = findInjectionPoint(source, fnMatch.offset);
  const contextBefore = source.slice(Math.max(0, injectionOffset - 60), injectionOffset);
  const contextAfter = source.slice(injectionOffset, injectionOffset + 60);

  console.log('=== Injection Plan ===');
  console.log(`  ${fnName}() found at offset: ${fnMatch.offset} (0x${fnMatch.offset.toString(16)})`);
  console.log(`  Injection point (after ${fnName} body): ${injectionOffset} (0x${injectionOffset.toString(16)})`);
  console.log(`  Payload: ${INJECTION_PAYLOAD}`);
  console.log(`  Payload size: ${INJECTION_PAYLOAD.length} bytes`);
  console.log(`  Strategy: text insertion (file grows by ${INJECTION_PAYLOAD.length} bytes)`);
  console.log(`  Context before: ...${contextBefore.slice(-40)}`);
  console.log(`  Context after:  ${contextAfter.slice(0, 40)}...`);
  console.log('');

  console.log('=== Summary ===');
  console.log(`  Patterns found: ${found}/${total}`);
  console.log(`  Status: READY — run with --apply to patch`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. node scripts/patch-credential-cache.js --apply');
  console.log('  2. node scripts/patch-credential-cache.js --verify');
}

// ---------------------------------------------------------------------------
// Mode: --apply
// ---------------------------------------------------------------------------

function runApply(binaryPath) {
  console.log('=== Credential Cache Patch — APPLY ===');
  console.log(`Binary: ${binaryPath}`);
  console.log('');

  // Read source
  const buffer = fs.readFileSync(binaryPath);
  const source = buffer.toString('latin1');

  // Check if already patched
  if (isPatchPresent(source)) {
    console.log('Binary is already patched. Nothing to do.');
    console.log('Use --verify to confirm, or --restore to revert.');
    process.exit(0);
  }

  // Verify required patterns exist
  const results = searchPatterns(source);
  const missingRequired = PATTERNS.filter(p => p.required && results[p.name].length === 0);
  if (missingRequired.length > 0) {
    console.error('ERROR: Missing required patterns — cannot patch:');
    for (const p of missingRequired) {
      console.error(`  - ${p.name}`);
    }
    process.exit(1);
  }

  // Resolve cache-clearing function name and build payload
  const fnName = resolveCacheClearFn(results);
  console.log(`Cache-clearing function: ${fnName}`);

  // Create backup BEFORE patching
  const backupPath = createBackup(binaryPath);
  console.log('');

  // Find injection point
  const fnMatch = results.cache_clear_fn[0];
  const injectionOffset = findInjectionPoint(source, fnMatch.offset);

  console.log(`Injecting ${INJECTION_PAYLOAD.length} bytes after ${fnName} function (offset ${injectionOffset})...`);

  // Perform binary insertion (latin1 offsets = byte offsets)
  const patchedBuffer = Buffer.concat([
    buffer.subarray(0, injectionOffset),
    Buffer.from(INJECTION_PAYLOAD, 'ascii'),
    buffer.subarray(injectionOffset),
  ]);

  // Write patched binary
  fs.writeFileSync(binaryPath, patchedBuffer);
  const newSize = fs.statSync(binaryPath).size;
  console.log(`Wrote patched binary (${newSize} bytes, grew by ${INJECTION_PAYLOAD.length}).`);

  // Re-sign
  codesign(binaryPath);

  // Verify
  verifyBinaryWorks(binaryPath);

  // Record to patch history
  recordPatch({
    action: 'apply',
    binary: binaryPath,
    backup: backupPath,
    injectionOffset,
    payloadSize: INJECTION_PAYLOAD.length,
    originalSize: buffer.length,
    patchedSize: patchedBuffer.length,
    cacheClearFn: CACHE_CLEAR_FN,
    fnOffset: fnMatch.offset,
  });

  console.log('');
  console.log('PATCHED successfully.');
  console.log(`Backup at: ${backupPath}`);
  console.log(`History at: ${PATCH_HISTORY_PATH}`);
}

// ---------------------------------------------------------------------------
// Mode: --verify
// ---------------------------------------------------------------------------

function runVerify(binaryPath) {
  console.log('=== Credential Cache Patch — VERIFY ===');
  console.log(`Binary: ${binaryPath}`);
  console.log('');

  const buffer = fs.readFileSync(binaryPath);
  const source = buffer.toString('latin1');

  const sig = findPatchSignature(source);
  if (sig) {
    console.log(`PATCHED — injection found at offset ${sig.index} (0x${sig.index.toString(16)})`);
    console.log(`  Function: ${sig.fn}()`);

    // Show surrounding context
    const before = source.slice(Math.max(0, sig.index - 40), sig.index);
    const after = source.slice(sig.index + sig.text.length, sig.index + sig.text.length + 40);
    console.log(`  Context: ...${before.slice(-30)}[INJECTION]${after.slice(0, 30)}...`);

    // Verify cache-clearing function still exists
    const results = searchPatterns(source);
    if (results.cache_clear_fn.length > 0) {
      const fn = results.cache_clear_fn[0];
      console.log(`  Cache-clear function: ${fn.captures?.cacheClearFn || 'detected'} at offset ${fn.offset}`);
    } else {
      console.error('  WARNING: Cache-clearing function not found — patch may be broken');
    }

    // Check backup exists
    const backupPath = getBackupPath(binaryPath);
    if (fs.existsSync(backupPath)) {
      const backupSize = fs.statSync(backupPath).size;
      const currentSize = fs.statSync(binaryPath).size;
      console.log(`  Backup: ${backupPath} (${backupSize} bytes, delta: ${currentSize - backupSize})`);
    } else {
      console.log('  Backup: NOT FOUND');
    }
  } else {
    console.log('NOT_PATCHED — no injection signature found.');

    // Check if patterns are present (binary is valid but unpatched)
    const results = searchPatterns(source);
    const cacheFn = results.cache_clear_fn;
    if (cacheFn.length > 0) {
      const fn = cacheFn[0];
      console.log(`  Cache-clear function: ${fn.captures?.cacheClearFn || 'detected'} at offset ${fn.offset} — binary is patchable.`);
    } else {
      console.log('  Cache-clearing function NOT FOUND — binary may have different structure.');
    }
  }
}

// ---------------------------------------------------------------------------
// Mode: --restore
// ---------------------------------------------------------------------------

function runRestore(binaryPath) {
  console.log('=== Credential Cache Patch — RESTORE ===');
  console.log(`Binary: ${binaryPath}`);
  console.log('');

  const backupPath = getBackupPath(binaryPath);
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup not found: ${backupPath}\nCannot restore without backup.`);
  }

  const backupSize = fs.statSync(backupPath).size;
  const currentSize = fs.statSync(binaryPath).size;

  console.log(`Current binary: ${currentSize} bytes`);
  console.log(`Backup: ${backupSize} bytes`);
  console.log('');

  // Verify backup is actually clean
  const backupBuffer = fs.readFileSync(backupPath);
  if (isPatchPresent(backupBuffer.toString('latin1'))) {
    throw new Error('Backup file is also patched — cannot restore from a patched backup.');
  }

  // Restore
  console.log('Restoring from backup...');
  fs.copyFileSync(backupPath, binaryPath);
  console.log('Restored.');

  // Re-sign
  codesign(binaryPath);

  // Verify
  verifyBinaryWorks(binaryPath);

  // Record
  recordPatch({
    action: 'restore',
    binary: binaryPath,
    backup: backupPath,
    restoredSize: backupSize,
    previousSize: currentSize,
  });

  console.log('');
  console.log('RESTORED successfully.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const binaryPath = findClaudeBinary();

  if (MODE_VERIFY) {
    runVerify(binaryPath);
  } else if (MODE_RESTORE) {
    runRestore(binaryPath);
  } else if (MODE_APPLY) {
    runApply(binaryPath);
  } else {
    runDryRun(binaryPath);
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
