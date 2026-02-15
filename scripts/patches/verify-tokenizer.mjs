#!/usr/bin/env node
/**
 * Standalone verification of the tokenize-first approach.
 * Tests that the new tokenizer correctly handles operators inside/outside quotes.
 */
import path from 'path';

const OPERATOR_TOKENS = new Set(['|', '||', '&&', ';']);
const FILE_READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'strings', 'xxd', 'hexdump', 'base64', 'open', 'source', 'bat', 'nl']);
const FILE_COPY_COMMANDS = new Set(['cp', 'mv']);

function tokenize(str) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  const chars = [...str];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = i + 1 < chars.length ? chars[i + 1] : '';
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\' && !inSingle) { escaped = true; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) { current += ch; continue; }
    if (ch === ' ' || ch === '\t') { if (current) { tokens.push(current); current = ''; } continue; }
    if (ch === '|') { if (current) { tokens.push(current); current = ''; } if (next === '|') { tokens.push('||'); i++; } else { tokens.push('|'); } continue; }
    if (ch === '&' && next === '&') { if (current) { tokens.push(current); current = ''; } tokens.push('&&'); i++; continue; }
    if (ch === ';') { if (current) { tokens.push(current); current = ''; } tokens.push(';'); continue; }
    if (ch === '>') { if (current) { tokens.push(current); current = ''; } if (next === '>') { tokens.push('>>'); i++; } else { tokens.push('>'); } continue; }
    if (ch === '<') { if (current) { tokens.push(current); current = ''; } tokens.push('<'); continue; }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function splitOnOperators(tokens) {
  const groups = [[]];
  for (const token of tokens) {
    if (OPERATOR_TOKENS.has(token)) { groups.push([]); } else { groups[groups.length - 1].push(token); }
  }
  return groups;
}

function extractFilePathsFromCommand(command) {
  const paths = [];
  const allTokens = tokenize(command);
  const subCommands = splitOnOperators(allTokens);
  for (const tokens of subCommands) {
    if (tokens.length === 0) continue;
    const cmd = path.basename(tokens[0]);
    if (FILE_READ_COMMANDS.has(cmd) || FILE_COPY_COMMANDS.has(cmd)) {
      for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.startsWith('-') && !token.startsWith('./') && !token.startsWith('../')) continue;
        if (token === '>' || token === '>>') { i++; continue; }
        if (token && !token.startsWith('$')) paths.push(token);
      }
    }
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '<' && i + 1 < tokens.length) paths.push(tokens[i + 1]);
    }
  }
  return paths;
}

const BLOCKED_BASENAMES = new Set([
  '.env', '.env.local', '.env.production', '.env.staging',
  '.env.development', '.env.test', '.credentials.json',
]);
const BLOCKED_SUFFIXES = ['.claude/protection-key', '.mcp.json'];
const BLOCKED_PATTERN = /\.env(\.[a-z]+)?$/i;

function isBlocked(fp) {
  const resolved = path.resolve(fp);
  const basename = path.basename(resolved);
  if (BLOCKED_BASENAMES.has(basename)) return true;
  const normalized = resolved.replace(/\\/g, '/');
  for (const suffix of BLOCKED_SUFFIXES) { if (normalized.endsWith(suffix)) return true; }
  if (BLOCKED_PATTERN.test(resolved)) return true;
  return false;
}

let passed = 0;
let failed = 0;

function test(desc, command, expectBlocked) {
  const paths = extractFilePathsFromCommand(command);
  const blocked = paths.some(p => isBlocked(p));
  const status = blocked === expectBlocked ? 'PASS' : 'FAIL';
  if (status === 'PASS') passed++;
  else failed++;
  console.log(`${status}: ${desc}`);
  if (status === 'FAIL') {
    console.log(`  paths=${JSON.stringify(paths)} expected=${expectBlocked ? 'blocked' : 'allowed'}`);
  }
}

console.log('=== EXISTING TESTS (regression check) ===');
test('cat protected-file', 'cat .env', true);
test('head protected-json', 'head .mcp.json', true);
test('tail protection-key', 'tail .claude/protection-key', true);
test('cp protected-file', 'cp .env /tmp/stolen', true);
test('mv protected-file', 'mv .env.local backup.txt', true);
test('cat with flags', 'cat -n .env', true);
test('input redirection', 'grep secret < .env', true);
test('pipe to grep', 'cat .env | grep TOKEN', true);
test('&& chain', 'cat .env && echo done', true);
test('cat non-protected (pass)', 'cat README.md', false);
test('echo (pass)', 'echo hello world', false);
test('single-quoted path', "cat '.env'", true);
test('double-quoted path', 'cat ".env"', true);
test('absolute path', 'cat /etc/.env', true);
test('relative path', 'cat ../../.env', true);
test('output redirect (pass)', 'cat README.md > .env', false);
test('complex pipeline', 'cat .env | grep TOKEN | head -n 5', true);
test('semicolon chain', 'ls -la; cat .env', true);
test('&& with cp', 'mkdir tmp && cp .env tmp/', true);
test('|| chain', 'cat .env.local || cat .env', true);

console.log('\n=== NEW TOKENIZE-FIRST TESTS ===');
test('pipe in double quotes (pass)', 'cat "file with | pipe.txt"', false);
test('semicolons in single quotes', "cat 'path;with;semicolons/.env'", true);
test('&& outside, quoted path', 'cat ".env" && echo done', true);
test('|| inside quotes (pass)', 'cat "a || b.txt"', false);
test('&& inside quotes (pass)', 'cat "a && b.txt"', false);
test('input redirect via token', 'grep secret < .env', true);

console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
