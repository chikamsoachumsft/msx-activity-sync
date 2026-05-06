#!/usr/bin/env node
// CLI entry point for activity-sync
// Checks all 3 auth prerequisites, guides user through setup, then runs sync.
//
// Usage:
//   npx @msx-helper/activity-sync                    # sync today
//   npx @msx-helper/activity-sync --dry-run           # preview only
//   npx @msx-helper/activity-sync --setup             # just run auth setup
//   npx @msx-helper/activity-sync --start 2026-04-01 --end 2026-04-07 --dry-run
//   npx @msx-helper/activity-sync --schedule "0 18 * * 1-5"

import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const CONFIG_DIR = join(HOME, '.activity-sync');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

// ── Defaults ────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  crmUrl: 'https://microsoftsales.crm.dynamics.com',
  tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
  timezone: 'America/Chicago',
};

// ── Utils ───────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function tryExec(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

function spawnInteractive(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

// ── Config ──────────────────────────────────────────────────────

function loadConfig() {
  if (existsSync(CONFIG_FILE)) {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) };
    } catch { /* fall through */ }
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// ── Auth Checks ─────────────────────────────────────────────────

async function checkAzureCli(config) {
  // 1. Check az CLI exists
  const azCmd = process.platform === 'win32' ? 'az.cmd' : 'az';
  const version = tryExec(`${azCmd} version --query "\\"azure-cli\\"" -o tsv`);
  if (!version) {
    return {
      name: 'Azure CLI (CRM)',
      ok: false,
      installed: false,
      error: 'Azure CLI not installed',
      fix: 'Install from https://learn.microsoft.com/cli/azure/install-azure-cli',
    };
  }

  // 2. Check logged in + can get a token for CRM
  const token = tryExec(
    `${azCmd} account get-access-token --resource ${config.crmUrl} --tenant ${config.tenantId} --query accessToken -o tsv`
  );
  if (!token) {
    return {
      name: 'Azure CLI (CRM)',
      ok: false,
      installed: true,
      error: 'Not logged in or token expired',
      fix: `az login --tenant ${config.tenantId}`,
    };
  }

  return { name: 'Azure CLI (CRM)', ok: true, installed: true };
}

async function checkWorkIQ() {
  // WorkIQ stores auth tokens locally. We can check if the binary exists
  // and try a lightweight call to see if auth is cached.
  const hasNpx = tryExec('npx --version');
  if (!hasNpx) {
    return {
      name: 'WorkIQ (Calendar)',
      ok: false,
      installed: false,
      error: 'npx not available',
      fix: 'Install Node.js from https://nodejs.org',
    };
  }

  // Check if WorkIQ has cached auth tokens
  const hasTokens =
    existsSync(join(HOME, '.work-iq-cli', '.workiq.json')) ||
    existsSync(join(HOME, '.work-iq-cli')) ||
    existsSync(join(HOME, '.workiq')) ||
    existsSync(join(HOME, '.microsoft', 'workiq'));

  if (!hasTokens) {
    return {
      name: 'WorkIQ (Calendar)',
      ok: false,
      installed: true,
      error: 'Not authenticated — no cached tokens found',
      fix: 'npx -y @microsoft/workiq ask -q "hello"   (triggers login on first use)',
    };
  }

  return { name: 'WorkIQ (Calendar)', ok: true, installed: true };
}

async function checkCopilotCli() {
  // Check if copilot CLI exists
  const version = tryExec('copilot --version');
  if (!version) {
    return {
      name: 'GitHub Copilot CLI',
      ok: false,
      installed: false,
      error: 'Copilot CLI not installed',
      fix: 'npm install -g @anthropic-ai/claude-code  (or install from https://docs.github.com/copilot/cli)',
    };
  }

  // Check if authenticated — copilot auth status
  const authStatus = tryExec('copilot auth status');
  if (!authStatus || authStatus.includes('not logged in') || authStatus.includes('not authenticated')) {
    return {
      name: 'GitHub Copilot CLI',
      ok: false,
      installed: true,
      error: 'Not authenticated',
      fix: 'copilot auth login',
    };
  }

  return { name: 'GitHub Copilot CLI', ok: true, installed: true };
}

// ── Auth Setup Flow ─────────────────────────────────────────────

async function runAuthSetup(checks, config) {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    console.log(green('\n✓ All authentication checks passed!\n'));
    return true;
  }

  console.log(yellow(`\n${failed.length} auth issue(s) need to be resolved:\n`));

  for (const check of failed) {
    console.log(`  ${red('✗')} ${bold(check.name)}: ${check.error}`);
    console.log(`    ${dim('Fix:')} ${check.fix}\n`);
  }

  const answer = await ask('Would you like to fix these now? (Y/n) ');
  if (answer.toLowerCase() === 'n') {
    console.log('\nRun again after fixing the auth issues.');
    return false;
  }

  console.log('');

  for (const check of failed) {
    if (check.ok) continue;

    console.log(bold(`── Setting up: ${check.name} ──\n`));

    if (check.name === 'Azure CLI (CRM)') {
      if (!check.installed) {
        console.log('Azure CLI is not installed.');
        console.log(`Install it from: ${yellow('https://learn.microsoft.com/cli/azure/install-azure-cli')}`);
        console.log('After installing, re-run this command.\n');
        await ask('Press Enter to continue...');
        continue;
      }

      console.log(`Running: ${dim(`az login --tenant ${config.tenantId}`)}`);
      console.log('A browser window will open for Microsoft login.\n');
      try {
        const azCmd = process.platform === 'win32' ? 'az.cmd' : 'az';
        await spawnInteractive(azCmd, ['login', '--tenant', config.tenantId]);
        console.log(green('\n✓ Azure CLI authenticated!\n'));
      } catch (err) {
        console.log(red(`\n✗ Azure CLI login failed: ${err.message}\n`));
      }
    }

    if (check.name === 'WorkIQ (Calendar)') {
      // Accept EULA first (required before any query works)
      console.log(`Running: ${dim('npx -y @microsoft/workiq accept-eula')}`);
      try {
        await spawnInteractive('npx', ['-y', '@microsoft/workiq', 'accept-eula']);
      } catch { /* ignore — may already be accepted */ }

      console.log(`\nRunning: ${dim('npx -y @microsoft/workiq ask -q "hello"')}`);
      console.log('This will trigger Microsoft 365 login on first use.\n');
      try {
        await spawnInteractive('npx', ['-y', '@microsoft/workiq', 'ask', '-q', 'hello']);
        console.log(green('\n✓ WorkIQ authenticated!\n'));
      } catch (err) {
        console.log(red(`\n✗ WorkIQ auth failed: ${err.message}\n`));
      }
    }

    if (check.name === 'GitHub Copilot CLI') {
      if (!check.installed) {
        console.log('GitHub Copilot CLI is not installed.');
        console.log(`Install it, then run: ${yellow('copilot auth login')}`);
        console.log('After installing, re-run this command.\n');
        await ask('Press Enter to continue...');
        continue;
      }

      console.log(`Running: ${dim('copilot auth login')}`);
      console.log('A browser window will open for GitHub login.\n');
      try {
        await spawnInteractive('copilot', ['auth', 'login']);
        console.log(green('\n✓ Copilot CLI authenticated!\n'));
      } catch (err) {
        console.log(red(`\n✗ Copilot CLI auth failed: ${err.message}\n`));
      }
    }
  }

  // Re-check after setup
  console.log(dim('\nRe-checking authentication...\n'));
  const reChecks = await runAllChecks(config);
  printAuthStatus(reChecks);
  return reChecks.every((c) => c.ok);
}

async function runAllChecks(config) {
  return [
    await checkAzureCli(config),
    await checkWorkIQ(),
    await checkCopilotCli(),
  ];
}

function printAuthStatus(checks) {
  console.log(bold('Authentication Status:\n'));
  for (const check of checks) {
    const icon = check.ok ? green('✓') : red('✗');
    console.log(`  ${icon} ${check.name}${check.ok ? '' : ` — ${check.error}`}`);
  }
  console.log('');
}

// ── Initial Setup (first run) ───────────────────────────────────

async function firstTimeSetup() {
  console.log(bold('\n🔧 First-time setup\n'));

  const config = { ...DEFAULT_CONFIG };

  // Timezone
  const tz = await ask(`Timezone [${config.timezone}]: `);
  if (tz.trim()) config.timezone = tz.trim();

  // CRM URL
  const crmUrl = await ask(`CRM URL [${config.crmUrl}]: `);
  if (crmUrl.trim()) config.crmUrl = crmUrl.trim();

  // Tenant ID
  const tenant = await ask(`Azure Tenant ID [${config.tenantId}]: `);
  if (tenant.trim()) config.tenantId = tenant.trim();

  saveConfig(config);
  console.log(green(`\nConfig saved to ${CONFIG_FILE}\n`));

  return config;
}

// ── Main ────────────────────────────────────────────────────────

// ── Scheduled Task (Windows Task Scheduler) ─────────────────────

function getNodePath() {
  try {
    return execSync('where node', { encoding: 'utf-8' }).trim().split('\n')[0].trim();
  } catch {
    return 'node';
  }
}

function installSchedule(timeStr) {
  // Parse time like "18:00" or "6:00PM"
  let hour, minute;
  const match24 = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  const match12 = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (match24) {
    hour = parseInt(match24[1], 10);
    minute = parseInt(match24[2], 10);
  } else if (match12) {
    hour = parseInt(match12[1], 10);
    minute = parseInt(match12[2], 10);
    if (match12[3].toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (match12[3].toUpperCase() === 'AM' && hour === 12) hour = 0;
  } else {
    console.log(red('Invalid time format. Use HH:MM (24h) or H:MMAM/PM'));
    console.log(dim('  Examples: 18:00, 6:00PM, 17:30'));
    process.exit(1);
  }

  const timeFormatted = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const nodePath = getNodePath();
  const runnerPath = join(__dirname, 'run.js');  // bypass cli.js auth prompts
  const workDir = join(__dirname, '..', '..');
  const taskName = 'ActivitySync-DailyRun';
  const logFile = join(CONFIG_DIR, 'scheduled-run.log');

  // Create a wrapper script that calls run.js directly (no interactive auth prompts)
  // It tracks the last successful run date and catches up missed days automatically
  const wrapperPath = join(CONFIG_DIR, 'scheduled-run.cmd');
  const lastRunFile = join(CONFIG_DIR, 'last-run-date.txt');
  const catchupScript = join(CONFIG_DIR, 'catchup.js');

  // Create the catch-up Node script — figures out missed days and runs for each
  const catchupContent = `#!/usr/bin/env node
// Catch-up script: runs activity sync for today AND any missed weekdays since last run
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const lastRunFile = ${JSON.stringify(lastRunFile)};
const runnerPath = ${JSON.stringify(runnerPath)};
const workDir = ${JSON.stringify(workDir)};

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
  if (lastStr && /^\\d{4}-\\d{2}-\\d{2}$/.test(lastStr)) {
    const lastDate = new Date(lastStr + 'T00:00:00');
    // Start from the day after the last successful run
    const candidate = addDays(lastDate, 1);
    if (candidate < today) {
      startDate = candidate;
      console.log('[catchup] Last successful run: ' + lastStr);
    }
  } else {
    // Empty or invalid — look back 7 days to catch up
    startDate = addDays(today, -7);
    console.log('[catchup] No valid last-run-date found, looking back 7 days');
  }
} else {
  // No file at all — look back 7 days
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

// Run sync for the full range (startDate → today+1)
const endStr = toDateStr(addDays(today, 1));
const rangeStart = dates[0];
console.log('[catchup] Running sync for ' + rangeStart + ' → ' + endStr);

try {
  execSync(\`node "\${runnerPath}" --mode copilot --start \${rangeStart} --end \${endStr}\`, {
    cwd: workDir,
    stdio: 'inherit',
    timeout: 10 * 60 * 1000, // 10 min timeout
  });
  // Only update last-run on success
  writeFileSync(lastRunFile, todayStr, 'utf-8');
  console.log('[catchup] Success. Updated last-run-date to ' + todayStr);
} catch (err) {
  console.error('[catchup] Sync failed with exit code ' + (err.status || 1));
  process.exitCode = err.status || 1;
}
`;

  const wrapperContent = `@echo off
echo ===== Activity Sync Run: %date% %time% ===== >> "${logFile}"
cd /d "${workDir}"
"${nodePath}" "${catchupScript}" >> "${logFile}" 2>&1
echo Exit code: %errorlevel% >> "${logFile}"
echo. >> "${logFile}"
`;

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(catchupScript, catchupContent, 'utf-8');
  writeFileSync(wrapperPath, wrapperContent, 'utf-8');

  // Use PowerShell Register-ScheduledTask for advanced features:
  //   - StartWhenAvailable: if the laptop was asleep at 4:30 PM, run when it wakes
  //   - Logon trigger: separate task that fires 2 min after login
  //   - catchup.js is idempotent: if today's already done, it exits instantly

  // Task 1: Weekday daily trigger (no admin needed)
  const dailyTask = `${taskName}`;
  const dailyCmd = `schtasks /create /tn "${dailyTask}" /tr "${wrapperPath}" /sc weekly /d MON,TUE,WED,THU,FRI /st ${timeFormatted} /f`;

  // Task 2: Logon trigger via XML (supports StartWhenAvailable + logon)
  const logonTask = `${taskName}-Logon`;
  const xmlPath = join(CONFIG_DIR, 'logon-task.xml');
  const escapedWrapperXml = wrapperPath.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const xmlContent = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT2M</Delay>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartIfOnBatteries>true</AllowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
  </Settings>
  <Actions>
    <Exec>
      <Command>${escapedWrapperXml}</Command>
    </Exec>
  </Actions>
</Task>`;
  writeFileSync(xmlPath, xmlContent, 'utf-16le');

  console.log(bold('\nInstalling daily schedule...\n'));
  console.log(`  Task 1:     ${dailyTask} — weekdays at ${timeFormatted}`);
  console.log(`  Task 2:     ${logonTask} — at logon (2-min delay)`);
  console.log(`  Catch-up:   Auto-syncs missed days when laptop wakes`);
  console.log(`  Log file:   ${logFile}`);
  console.log(`  Wrapper:    ${wrapperPath}`);
  console.log(`  Catchup:    ${catchupScript}\n`);

  let ok = true;
  // Install daily trigger
  try {
    execSync(dailyCmd, { stdio: 'pipe' });
    console.log(green(`  ✓ Daily trigger installed (${timeFormatted} weekdays)`));
  } catch (err) {
    console.log(red(`  ✗ Daily trigger failed`));
    ok = false;
  }

  // Install logon trigger
  try {
    execSync(`schtasks /create /tn "${logonTask}" /xml "${xmlPath}" /f`, { stdio: 'pipe' });
    console.log(green(`  ✓ Logon trigger installed (2-min after login)`));
  } catch {
    // Logon trigger may need admin — try without it
    console.log(yellow(`  ⚠ Logon trigger needs admin — skipped (daily trigger still works)`));
    console.log(dim(`    To add: run as admin → node src/agent/cli.js install-schedule ${timeStr}`));
  }

  if (ok) {
    console.log(green('\n✓ Scheduled task installed!\n'));
    console.log('  How it works:');
    console.log(`  ${dim('•')} Laptop on at ${timeFormatted}?  → Runs at ${timeFormatted}`);
    console.log(`  ${dim('•')} Laptop asleep at ${timeFormatted}? → Catches up next run`);
    console.log(`  ${dim('•')} Laptop off all day?    → Runs 2 min after you log in`);
    console.log(`  ${dim('•')} Off for multiple days?  → Catches up ALL missed weekdays`);
    console.log('');
    console.log(dim(`Check logs:    node src/agent/cli.js schedule-status`));
    console.log(dim(`Remove:        node src/agent/cli.js uninstall-schedule`));
  }
}

function uninstallSchedule() {
  const taskName = 'ActivitySync-DailyRun';
  console.log(bold(`\nRemoving scheduled tasks...\n`));
  for (const name of [taskName, `${taskName}-Logon`]) {
    try {
      execSync(`schtasks /delete /tn "${name}" /f`, { stdio: 'pipe' });
      console.log(green(`  ✓ Removed: ${name}`));
    } catch {
      console.log(dim(`  - ${name} (not found)`));
    }
  }

  // Clean up generated files
  for (const file of ['scheduled-run.cmd', 'catchup.js', 'last-run-date.txt', 'register-task.ps1', 'logon-task.xml']) {
    const p = join(CONFIG_DIR, file);
    if (existsSync(p)) {
      try { writeFileSync(p, '', 'utf-8'); } catch { /* ignore */ }
    }
  }
  console.log(dim('\n  Support files cleared.'));
  console.log('');
}

function showScheduleStatus() {
  const taskName = 'ActivitySync-DailyRun';
  const lastRunFile = join(CONFIG_DIR, 'last-run-date.txt');

  console.log(bold('\nSchedule Status:\n'));

  // Show last successful sync date
  if (existsSync(lastRunFile)) {
    const lastDate = readFileSync(lastRunFile, 'utf-8').trim();
    const today = new Date().toISOString().slice(0, 10);
    const daysBehind = Math.floor((new Date(today) - new Date(lastDate)) / 86400000);
    if (daysBehind === 0) {
      console.log(green(`  Last sync: ${lastDate} (today — up to date)`));
    } else if (daysBehind === 1) {
      console.log(yellow(`  Last sync: ${lastDate} (yesterday — will catch up next run)`));
    } else {
      console.log(red(`  Last sync: ${lastDate} (${daysBehind} days ago — will catch up next run)`));
    }
  } else {
    console.log(yellow('  Last sync: never'));
  }

  // Show task scheduler info
  try {
    const output = execSync(`schtasks /query /tn "${taskName}" /fo LIST /v`, { encoding: 'utf-8' });
    const fields = ['Status', 'Next Run Time', 'Last Run Time', 'Last Result'];
    for (const field of fields) {
      const match = output.match(new RegExp(`${field}:\\s*(.+)`, 'i'));
      if (match) console.log(`  ${field}: ${match[1].trim()}`);
    }
  } catch {
    console.log(yellow('  Task: not registered'));
    console.log(dim('  Install with: node src/agent/cli.js install-schedule 18:00'));
  }

  // Show last few log lines
  const logFile = join(CONFIG_DIR, 'scheduled-run.log');
  if (existsSync(logFile)) {
    const log = readFileSync(logFile, 'utf-8');
    const lines = log.trim().split('\n');
    const last = lines.slice(-12).join('\n');
    console.log(dim(`\n  Recent log (${logFile}):`));
    console.log(dim(last));
  }
  console.log('');
}

// ── Add/Remove Customer Mapping ─────────────────────────────────

function getStatePath() {
  const homePath = join(CONFIG_DIR, 'sync-state.json');
  const legacyPath = join(__dirname, '..', '..', 'sync-state.json');
  return existsSync(homePath) ? homePath : legacyPath;
}

function addCustomerMapping(customerName, milestoneId) {
  const statePath = getStatePath();
  let state = {};
  try {
    state = JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch { /* start fresh */ }

  if (!state.customerMilestoneCache) state.customerMilestoneCache = {};
  state.customerMilestoneCache[customerName] = milestoneId;
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  console.log(green(`✓ Added: "${customerName}" → ${milestoneId}`));
  console.log(dim(`  Saved to: ${statePath}`));

  // Also remove from follow-ups if present
  const followUpsPath = join(CONFIG_DIR, 'follow-ups.json');
  if (existsSync(followUpsPath)) {
    try {
      const followUps = JSON.parse(readFileSync(followUpsPath, 'utf-8'));
      const filtered = followUps.filter(f => (f.customer || '').toLowerCase() !== customerName.toLowerCase());
      if (filtered.length < followUps.length) {
        writeFileSync(followUpsPath, JSON.stringify(filtered, null, 2), 'utf-8');
        console.log(green(`✓ Removed "${customerName}" from follow-ups (${followUps.length - filtered.length} item(s))`));
      }
    } catch { /* ignore */ }
  }
}

function listCustomerMappings() {
  const statePath = getStatePath();
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    const cache = state.customerMilestoneCache || {};
    const entries = Object.entries(cache);
    if (entries.length === 0) {
      console.log(yellow('No customer-milestone mappings found.'));
      return;
    }
    console.log(bold(`\nCustomer → Milestone Mappings (${entries.length}):\n`));
    for (const [name, id] of entries) {
      console.log(`  ${name} → ${id}`);
    }
    console.log('');
  } catch {
    console.log(yellow('No sync state found.'));
  }
}

function listFollowUps() {
  const followUpsPath = join(CONFIG_DIR, 'follow-ups.json');
  if (!existsSync(followUpsPath)) {
    console.log(yellow('No follow-ups file found.'));
    return;
  }
  try {
    const items = JSON.parse(readFileSync(followUpsPath, 'utf-8'));
    if (items.length === 0) {
      console.log(green('No open follow-ups!'));
      return;
    }
    console.log(bold(`\nOpen Follow-Ups (${items.length}):\n`));
    for (const [i, item] of items.entries()) {
      console.log(`  ${i + 1}. ${bold(item.customer)} — ${item.subject} (${item.date?.slice(0, 10) || 'N/A'})`);
      console.log(`     ${dim(item.reason)}`);
    }
    console.log('');
  } catch {
    console.log(yellow('Could not read follow-ups file.'));
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Handle subcommands that don't need auth
  if (args[0] === 'add-customer') {
    const name = args[1];
    const milestoneId = args[2];
    if (!name || !milestoneId) {
      console.log(red('Usage: activity-sync add-customer "<Customer Name>" <milestoneId>'));
      process.exit(1);
    }
    addCustomerMapping(name, milestoneId);
    process.exit(0);
  }

  if (args[0] === 'list-customers') {
    listCustomerMappings();
    process.exit(0);
  }

  if (args[0] === 'list-followups') {
    listFollowUps();
    process.exit(0);
  }

  if (args[0] === 'install-schedule') {
    const time = args[1] || '18:00';
    installSchedule(time);
    process.exit(0);
  }

  if (args[0] === 'uninstall-schedule') {
    uninstallSchedule();
    process.exit(0);
  }

  if (args[0] === 'schedule-status') {
    showScheduleStatus();
    process.exit(0);
  }

  const isSetupOnly = args.includes('--setup');

  console.log(bold('\n📋 Activity Sync — CRM Calendar Agent\n'));

  // Load or create config
  let config;
  if (!existsSync(CONFIG_FILE)) {
    config = await firstTimeSetup();
  } else {
    config = loadConfig();
  }

  // Check all auth
  console.log(dim('Checking authentication...\n'));
  const checks = await runAllChecks(config);
  printAuthStatus(checks);

  const allOk = checks.every((c) => c.ok);

  if (!allOk) {
    const ready = await runAuthSetup(checks, config);
    if (!ready) {
      rl.close();
      process.exit(1);
    }
  }

  rl.close();

  if (isSetupOnly) {
    console.log(green('Setup complete! Run without --setup to sync.\n'));
    process.exit(0);
  }

  // Forward to the actual runner
  // Remove --setup if present, pass everything else through
  const forwardArgs = args.filter((a) => a !== '--setup');

  // Default to copilot mode
  if (!forwardArgs.includes('--mode')) {
    forwardArgs.unshift('--mode', 'copilot');
  }

  console.log(dim(`Starting sync...\n`));

  const runScript = join(__dirname, 'run.js');
  try {
    execSync(`node "${runScript}" ${forwardArgs.join(' ')}`, {
      cwd: join(__dirname, '..', '..'),
      stdio: 'inherit',
    });
  } catch (err) {
    process.exitCode = err.status || 1;
  }
}

main().catch((err) => {
  console.error(red(`Fatal: ${err.message}`));
  process.exit(1);
});
