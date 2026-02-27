#!/usr/bin/env node
/**
 * Helper script to invoke icon-processor functions directly.
 * Usage: node icon-runner.cjs <function_name> '<json_args>'
 */
const path = require('path');

async function main() {
  const funcName = process.argv[2];
  const argsJson = process.argv[3] || '{}';
  const args = JSON.parse(argsJson);

  // Dynamic import of the built ESM module
  const mod = await import('./dist/icon-processor/server.js');

  if (!mod[funcName]) {
    console.error(`Unknown function: ${funcName}`);
    console.error('Available:', Object.keys(mod).filter(k => typeof mod[k] === 'function').join(', '));
    process.exit(1);
  }

  const result = await mod[funcName](args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(e => {
  console.error('Error:', e.message || e);
  process.exit(1);
});
