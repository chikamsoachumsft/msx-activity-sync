#!/usr/bin/env node
// Runner dispatcher — invokes Option A (code-driven) or Option B (Copilot CLI)
// Usage:
//   node src/agent/run.js [--mode code|copilot] [--start ...] [--end ...] [--dry-run]
//
// Default mode: code (Option A)

import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
let mode = 'code';

// Extract --mode from args
const modeIdx = args.indexOf('--mode');
if (modeIdx !== -1) {
  mode = args[modeIdx + 1] || 'code';
  args.splice(modeIdx, 2); // Remove --mode and its value
}

const script = mode === 'copilot'
  ? join(__dirname, 'headless-copilot.js')
  : join(__dirname, 'headless.js');

console.log(`[run] Mode: ${mode} → ${mode === 'copilot' ? 'headless-copilot.js' : 'headless.js'}`);
console.log(`[run] Args: ${args.join(' ') || '(none)'}`);
console.log('');

try {
  execSync(`node "${script}" ${args.join(' ')}`, {
    cwd: join(__dirname, '..', '..'),
    stdio: 'inherit',
  });
} catch (err) {
  process.exitCode = err.status || 1;
}
