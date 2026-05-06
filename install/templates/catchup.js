#!/usr/bin/env node
// Catch-up script: runs activity sync for today AND any missed weekdays since last run.
// Path-portable — uses %USERPROFILE% and the repo location passed via REPO_PATH env var.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const stateDir = join(homedir(), '.activity-sync');
const lastRunFile = join(stateDir, 'last-run-date.txt');

const repoPath = process.env.REPO_PATH;
if (!repoPath || !existsSync(repoPath)) {
  console.error('[catchup] REPO_PATH env var not set or invalid: ' + repoPath);
  process.exit(2);
}
const runnerPath = join(repoPath, 'src', 'agent', 'run.js');
const workDir = repoPath;

function toDateStr(d) { return d.toISOString().slice(0, 10); }
function isWeekday(d) { const dow = d.getDay(); return dow >= 1 && dow <= 5; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

const today = new Date();
today.setHours(0, 0, 0, 0);
const todayStr = toDateStr(today);

// Determine first date to process
let startDate = today;
if (existsSync(lastRunFile)) {
  const lastStr = readFileSync(lastRunFile, 'utf-8').trim();
  if (lastStr && /^\d{4}-\d{2}-\d{2}$/.test(lastStr)) {
    const lastDate = new Date(lastStr + 'T00:00:00');
    const candidate = addDays(lastDate, 1);
    if (candidate < today) {
      startDate = candidate;
      console.log('[catchup] Last successful run: ' + lastStr);
    }
  } else {
    startDate = addDays(today, -7);
    console.log('[catchup] No valid last-run-date found, looking back 7 days');
  }
} else {
  startDate = addDays(today, -7);
  console.log('[catchup] No last-run-date file, looking back 7 days');
}

// Collect all weekdays from startDate through today
const dates = [];
let cursor = new Date(startDate);
while (cursor <= today) {
  if (isWeekday(cursor)) dates.push(toDateStr(cursor));
  cursor = addDays(cursor, 1);
}

if (dates.length === 0) {
  console.log('[catchup] No weekdays to process (weekend). Done.');
  process.exit(0);
}

if (dates.length > 1) {
  console.log('[catchup] Catching up ' + dates.length + ' missed days: ' + dates.join(', '));
}

const endStr = toDateStr(addDays(today, 1));
const rangeStart = dates[0];
console.log('[catchup] Running sync for ' + rangeStart + ' → ' + endStr);

try {
  execSync(`node "${runnerPath}" --mode copilot --start ${rangeStart} --end ${endStr}`, {
    cwd: workDir,
    stdio: 'inherit',
    timeout: 10 * 60 * 1000,
  });
  writeFileSync(lastRunFile, todayStr, 'utf-8');
  console.log('[catchup] Success. Updated last-run-date to ' + todayStr);
} catch (err) {
  console.error('[catchup] Sync failed with exit code ' + (err.status || 1));
  process.exitCode = err.status || 1;
}
