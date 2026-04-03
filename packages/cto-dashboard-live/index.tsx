#!/usr/bin/env node
/**
 * GENTYR Live CTO Dashboard
 *
 * Usage:
 *   node dist/index.js            # Live data from CLAUDE_PROJECT_DIR
 *   node dist/index.js --mock     # Mock data for testing
 */

import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

const args = process.argv.slice(2);
const mock = args.includes('--mock');

const { waitUntilExit } = render(
  <App mock={mock} />,
  { exitOnCtrlC: true }
);

waitUntilExit().then(() => {
  process.exit(0);
});
