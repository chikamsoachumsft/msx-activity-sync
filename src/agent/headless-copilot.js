#!/usr/bin/env node
// Option B: GitHub Copilot SDK orchestrated headless runner
// Uses @github/copilot-sdk to let the LLM orchestrate calendar reading +
// CRM task creation via both MCP servers (msx-crm + WorkIQ).
//
// The LLM receives all MCP tools as custom tools and a system prompt with
// the full activity-sync instructions. It decides how to call tools,
// classify meetings, and create tasks — no hardcoded pipeline.
//
// Usage:
//   node src/agent/run.js --mode copilot --start 2026-03-25 --end 2026-03-26 --dry-run
//   node src/agent/run.js --mode copilot --days 7
//   node src/agent/run.js --mode copilot  (defaults to today)

import { CopilotClient, defineTool, approveAll } from '@github/copilot-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const MCP_SERVER_PATH = join(__dirname, '..', 'index.js');

// ── CLI Args ────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { dryRun: false, days: null, start: null, end: null, schedule: null };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--start': opts.start = args[++i]; break;
      case '--end':   opts.end = args[++i]; break;
      case '--days':  opts.days = parseInt(args[++i], 10); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--schedule': opts.schedule = args[++i]; break;
      case '--help':
        console.log(`Usage: node headless-copilot.js [options]
Options:
  --start YYYY-MM-DD   Start date (default: today)
  --end YYYY-MM-DD     End date, exclusive (default: start + 1 day)
  --days N             Number of days from start (overrides --end)
  --dry-run            Preview only, no CRM writes
  --schedule CRON      Run on a cron schedule (e.g. "0 18 * * 1-5" = 6 PM weekdays)`);
        process.exit(0);
    }
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  if (!opts.start) opts.start = todayStr;

  if (opts.days) {
    const d = new Date(opts.start + 'T00:00:00');
    d.setDate(d.getDate() + opts.days);
    opts.end = d.toISOString().slice(0, 10);
  } else if (!opts.end) {
    const d = new Date(opts.start + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    opts.end = d.toISOString().slice(0, 10);
  }

  return opts;
}

// ── MCP Server Connections ──────────────────────────────────────

async function connectMcpServer(name, command, args, env = {}) {
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: `activity-sync-${name}`, version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

// ── Convert MCP Tools → Copilot SDK Tools ───────────────────────

/**
 * Convert a JSON Schema property to a Zod schema.
 * Handles the common types returned by MCP tool schemas.
 */
function jsonSchemaToZod(prop) {
  if (!prop) return z.any();

  switch (prop.type) {
    case 'string':
      if (prop.enum) return z.enum(prop.enum);
      return z.string().describe(prop.description || '');
    case 'number':
    case 'integer':
      return z.number().describe(prop.description || '');
    case 'boolean':
      return z.boolean().describe(prop.description || '');
    case 'array':
      return z.array(prop.items ? jsonSchemaToZod(prop.items) : z.any()).describe(prop.description || '');
    case 'object':
      if (prop.properties) {
        const shape = {};
        for (const [key, val] of Object.entries(prop.properties)) {
          shape[key] = jsonSchemaToZod(val);
        }
        return z.object(shape).passthrough().describe(prop.description || '');
      }
      return z.record(z.any()).describe(prop.description || '');
    default:
      return z.any().describe(prop.description || '');
  }
}

/**
 * Convert all tools from an MCP server into defineTool() instances
 * that proxy calls back to the MCP client.
 */
function mcpToolsToCopilotTools(mcpClient, toolsList, serverPrefix) {
  return toolsList.map(tool => {
    const inputSchema = tool.inputSchema || {};
    const properties = inputSchema.properties || {};
    const required = inputSchema.required || [];

    // Build Zod schema from JSON Schema properties
    const shape = {};
    for (const [key, prop] of Object.entries(properties)) {
      let zodProp = jsonSchemaToZod(prop);
      if (!required.includes(key)) {
        zodProp = zodProp.optional();
      }
      shape[key] = zodProp;
    }

    const toolName = `${serverPrefix}__${tool.name}`;

    return defineTool(toolName, {
      description: `[${serverPrefix}] ${tool.description || tool.name}`,
      parameters: z.object(shape).passthrough(),
      skipPermission: true,
      handler: async (params) => {
        try {
          const result = await mcpClient.callTool({ name: tool.name, arguments: params });
          // MCP returns { content: [{ type, text }] }
          const text = result.content
            ?.filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
          return text || JSON.stringify(result.content);
        } catch (err) {
          return `Error calling ${serverPrefix}.${tool.name}: ${err.message}`;
        }
      },
    });
  });
}

// ── Build System Prompt ─────────────────────────────────────────

function buildSystemPrompt(opts) {
  // Load the instructions
  let instructions = '';
  try {
    instructions = readFileSync(
      join(ROOT, '.github', 'agents', 'activity-sync.instructions.md'),
      'utf8'
    );
  } catch {
    instructions = 'Instructions file not found — proceed with best effort.';
  }

  // Load sync state for context (check ~/.activity-sync/ first, then repo root)
  let stateContext = '';
  const homePath = join(process.env.HOME || process.env.USERPROFILE || '', '.activity-sync', 'sync-state.json');
  const legacyPath = join(ROOT, 'sync-state.json');
  const statePath = existsSync(homePath) ? homePath : legacyPath;
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const customerNames = Object.keys(state.customerMilestoneCache || {});
    const skippedNames = (state.skippedCustomers || []).map(s => s.name || s);
    const processedCount = (state.processedMeetings || []).length;

    stateContext = `
## Current Sync State (from sync-state.json)
- ${processedCount} meetings already processed
- Known customers with milestone IDs: ${customerNames.join(', ') || '(none)'}
- Customers to ALWAYS SKIP: ${skippedNames.join(', ') || '(none)'}
- Customer → Milestone mapping:
${JSON.stringify(state.customerMilestoneCache, null, 2)}
- Recently processed meetings (last 10):
${JSON.stringify((state.processedMeetings || []).slice(-10).map(m => ({ subject: m.subject, date: m.date, customer: m.customer })), null, 2)}

## CRITICAL — Recurring Meeting Rule
Many customer meetings repeat weekly or biweekly (e.g. "PerkinElmer Fortnightly Connect", "James Hardie Weekly Touchpoint").
A meeting is ONLY "ALREADY PROCESSED" if **BOTH the subject AND the exact date** match a sync-state entry.
If the subject matches but the DATE is different, it is a NEW occurrence — create a new task for it!
Example: "PerkinElmer Fortnightly Connect" processed on Apr 2 does NOT mean Apr 16's occurrence is done.

## CRITICAL — Duplicate Prevention (Backfill Safety)
Before creating ANY task on a milestone, you MUST check whether a task already exists on that milestone for the same calendar day as the meeting. This is the **only** reliable way to detect tasks the user logged manually, because manually-logged tasks may have completely different subjects than the calendar meeting (e.g. calendar says "James Hardie Weekly Touchpoint", user logged it as "Weekly check-in with JH").

**Day-bucket rule (USE THIS):**
1. Call \`msx_crm__get_milestone_activities\` with the target milestoneId.
2. From the returned tasks, look at \`scheduledstart\` (or \`scheduledend\`/\`actualstart\` if present). Treat the date portion only — strip the time.
3. If ANY task on that milestone has a scheduledstart date matching the meeting's calendar date — regardless of subject — treat it as **ALREADY EXISTS** and SKIP creation.
4. If the calendar has multiple meetings on the same day for the same milestone (rare), allow creation up to N tasks where N = (calendar meetings on that day) − (existing CRM tasks on that day).

**Output rule:** Items skipped this way go in a SEPARATE bucket called \`alreadyExists\` in your JSON summary — NOT in \`skipped\`. Use Decision **ALREADY EXISTS** in the per-meeting table. Always include the existing task's GUID and CRM link in the row's Reason column so the user can verify.

This rule prevents duplicates when (a) the user manually logged the meeting, (b) a previous backfill already processed it, or (c) someone else on the deal team already logged it.
`;
  } catch {
    stateContext = '\n## Sync State\nCould not load sync-state.json — proceed with caution.\n';
  }

  const action = opts.dryRun
    ? 'PREVIEW ONLY (dry-run) — list what would be created but DO NOT call create_task, update_task, close_task, or execute_all. DO NOT modify sync-state.json. At the end, tell the user: "To execute the actual sync, run the same command without --dry-run".'
    : 'CREATE tasks in CRM using the staged operations pattern: create_task → execute_all → update_task (set times) → execute_all → close_task → execute_all. Then update sync-state.json.';

  // Load open follow-ups for retry
  let followUpContext = '';
  const openFollowUps = loadFollowUps();
  if (openFollowUps.length > 0) {
    followUpContext = `
## Open Follow-Ups — RETRY THESE
The following customer meetings previously failed milestone lookup. Try \`get_my_active_opportunities\` again for each customer.
If you can now find a milestone, create the task (and close it if the meeting is in the past). If still no match, keep in the followUp list.
${opts.dryRun ? 'In dry-run mode, just report whether a milestone would now be found.' : ''}

${openFollowUps.map((item, i) => `${i + 1}. **${item.customer}**: "${item.subject}" (${item.date?.slice(0, 10) || 'unknown date'}) — previous reason: ${item.reason}`).join('\n')}
`;
  }

  return `${instructions}

${stateContext}
${followUpContext}

## Your Task Right Now

Process calendar meetings from **${opts.start}** to **${opts.end}**.
${openFollowUps.length > 0 ? `Also retry the ${openFollowUps.length} open follow-up(s) listed above.` : ''}

**Action**: ${action}

## Tool Naming Convention

Tools are prefixed with their MCP server name:
- \`msx_crm__*\` — CRM tools (e.g. msx_crm__get_milestones, msx_crm__create_task, msx_crm__execute_all)
- \`workiq__*\` — WorkIQ/calendar tools (e.g. workiq__ask_work_iq)

Use \`workiq__ask_work_iq\` to query the calendar. Use \`msx_crm__*\` for all CRM operations.

## Key Constraints
- My timezone is Central Time (America/Chicago)
- Discover your CRM user ID at runtime by calling \`msx_crm__crm_whoami\` — use the returned UserId as ownerId for all CRM operations
- Batch CRM operations: stage all, then execute_all — do NOT execute one-by-one
- Update task times BEFORE closing tasks — closed tasks cannot be updated
- CRM task URL format: https://microsoftsales.crm.dynamics.com/main.aspx?etn=task&id={taskId}&pagetype=entityrecord
- For EVERY created task, include the CRM link in your output using the task GUID returned by execute_all
- If get_my_active_opportunities returns NO results for a customer, do NOT guess a milestone — add it to the "followUp" list instead

## Report Format — MANDATORY — DO NOT SKIP THIS
You MUST produce a COMPLETE numbered table listing EVERY SINGLE meeting returned by WorkIQ — no exceptions, no grouping, no summarizing.
This is the MOST IMPORTANT part of your output. If you skip meetings from the table, the report is INVALID.

| # | Date | Time | Subject | Decision | Reason |
|---|------|------|---------|----------|--------|
| 1 | Apr 7 | 10:30 AM | James Hardie Weekly Touchpoint | CREATED | Customer meeting — milestone found |
| 2 | Apr 7 | 11:00 AM | Functional Mobility Class | SKIPPED | Internal wellness event |
| ... | ... | ... | ... | ... | ... |

Rules:
- Decision must be one of: **CREATED**, **SKIPPED**, **ALREADY EXISTS**, **FOLLOW-UP**, **ALREADY PROCESSED**, or **FAILED**
- **ALREADY EXISTS** = a task already exists in CRM on the same milestone for the same calendar date (day-bucket rule). Include the existing task GUID + link in the Reason column.
- **ALREADY PROCESSED** means BOTH the subject AND the exact calendar date match a sync-state entry. Same subject on a different date = NEW meeting, not a duplicate!
- Every row = one meeting. If WorkIQ returned 40 meetings, the table has 40 rows.
- DO NOT write "Various other internal meetings" or group rows — list each one individually

After the full meeting table, output the JSON summary:
{ created: [{ customer, subject, taskId, link }], skipped: [{ subject, reason }], alreadyExists: [{ customer, subject, date, existingTaskId, existingTaskLink }], failed: [...], followUp: [{ customer, subject, date, reason }] }
`;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ── Persistent Follow-Ups ───────────────────────────────────────

const FOLLOWUPS_DIR = join(process.env.HOME || process.env.USERPROFILE || '', '.activity-sync');
const FOLLOWUPS_FILE = join(FOLLOWUPS_DIR, 'follow-ups.json');

function loadFollowUps() {
  try {
    return JSON.parse(readFileSync(FOLLOWUPS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveFollowUps(items) {
  if (!existsSync(FOLLOWUPS_DIR)) mkdirSync(FOLLOWUPS_DIR, { recursive: true });
  writeFileSync(FOLLOWUPS_FILE, JSON.stringify(items, null, 2), 'utf-8');
}

function updateFollowUps(jsonSummary, opts) {
  const existing = loadFollowUps();

  // Load current customer cache to check what's been resolved
  const homePath = join(FOLLOWUPS_DIR, 'sync-state.json');
  const legacyPath = join(ROOT, 'sync-state.json');
  const statePath = existsSync(homePath) ? homePath : legacyPath;
  let cachedCustomers = new Set();
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    cachedCustomers = new Set(Object.keys(state.customerMilestoneCache || {}).map(k => k.toLowerCase()));
  } catch { /* ignore */ }

  // Remove resolved items: customer now in cache or task was created for them
  const createdCustomers = new Set(
    (jsonSummary?.created || []).map(c => (c.customer || '').toLowerCase())
  );
  const resolved = existing.filter(item => {
    const cust = (item.customer || '').toLowerCase();
    return cachedCustomers.has(cust) || createdCustomers.has(cust);
  });

  let updated = existing.filter(item => {
    const cust = (item.customer || '').toLowerCase();
    return !cachedCustomers.has(cust) && !createdCustomers.has(cust);
  });

  // Add new follow-ups (dedupe by customer + subject + date)
  const newItems = jsonSummary?.followUp || [];
  for (const item of newItems) {
    const key = `${(item.customer || '').toLowerCase()}|${(item.subject || '').toLowerCase()}|${item.date}`;
    const exists = updated.some(u =>
      `${(u.customer || '').toLowerCase()}|${(u.subject || '').toLowerCase()}|${u.date}` === key
    );
    if (!exists) {
      updated.push({ ...item, addedAt: new Date().toISOString(), rangeFrom: opts.start, rangeTo: opts.end });
    }
  }

  saveFollowUps(updated);
  return { all: updated, resolved, newlyAdded: newItems.length };
}

// ── Report Generation ───────────────────────────────────────────

function buildReport(opts, llmOutput, toolLog) {
  const now = new Date();
  const toolsCalled = toolLog.filter(t => t.type === 'call').map(t => t.tool);
  const uniqueTools = [...new Set(toolsCalled)];

  // Try to extract JSON summary from LLM output
  let jsonSummary = null;
  const jsonMatch = llmOutput.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try { jsonSummary = JSON.parse(jsonMatch[1]); } catch { /* ignore */ }
  }

  // Update persistent follow-ups file
  const followUpStatus = updateFollowUps(jsonSummary, opts);

  // Build human action items from the output
  const actionItems = [];
  if (llmOutput.includes('Need User Input') || llmOutput.includes('needsUserInput') || llmOutput.includes('need milestone')) {
    const lines = llmOutput.split('\n');
    for (const line of lines) {
      if (/user input|not in.*cache|need.*milestone|need.*mapping|which customer/i.test(line)) {
        actionItems.push(line.trim().replace(/^[-*•]\s*/, ''));
      }
    }
  }
  if (jsonSummary?.needsUserInput) {
    for (const item of jsonSummary.needsUserInput) {
      actionItems.push(`${item.subject} — ${item.reason}`);
    }
  }
  if (jsonSummary?.followUp) {
    for (const item of jsonSummary.followUp) {
      actionItems.push(`**${item.customer}** — ${item.subject} (${item.date}) — ${item.reason}`);
    }
  }

  // Build master follow-up section
  let masterFollowUp = '';
  if (followUpStatus.all.length > 0) {
    masterFollowUp = `## Master Follow-Up List (${followUpStatus.all.length} open)

These items persist across runs. Resolve by adding the customer-milestone mapping to your sync state, or get added to the deal team.

| # | Customer | Meeting | Date | Reason | Added |
|---|----------|---------|------|--------|-------|
${followUpStatus.all.map((item, i) =>
  `| ${i + 1} | ${item.customer} | ${item.subject} | ${item.date?.slice(0, 10) || 'N/A'} | ${item.reason} | ${item.addedAt?.slice(0, 10) || 'N/A'} |`
).join('\n')}

${followUpStatus.resolved.length > 0 ? `\n**Resolved this run:** ${followUpStatus.resolved.map(r => r.customer).join(', ')}` : ''}

> File: \`~/.activity-sync/follow-ups.json\`
`;
  } else {
    masterFollowUp = `## Master Follow-Up List

No open follow-ups — all customers have been resolved!
${followUpStatus.resolved.length > 0 ? `\n**Resolved this run:** ${followUpStatus.resolved.map(r => r.customer).join(', ')}` : ''}
`;
  }

  const report = `# Activity Sync Report
**Date**: ${now.toISOString()}
**Range**: ${opts.start} → ${opts.end}
**Mode**: ${opts.dryRun ? 'DRY-RUN (preview only)' : 'LIVE'}

---

## Summary

${jsonSummary ? `| Metric | Count |
|--------|-------|
| Tasks Created | ${jsonSummary.created?.length || 0} |
| Already in CRM (skipped) | ${jsonSummary.alreadyExists?.length || 0} |
| Meetings Skipped | ${jsonSummary.skipped?.length || 0} |
| Failures | ${jsonSummary.failed?.length || 0} |
| Follow-Up Required | ${jsonSummary.followUp?.length || 0} |
| Needs Human Action | ${jsonSummary.needsUserInput?.length || actionItems.length} |` : '(No structured summary extracted from LLM output)'}

${jsonSummary?.alreadyExists?.length > 0 ? `## Already Logged in CRM (${jsonSummary.alreadyExists.length})

These meetings had a pre-existing task on the same milestone for the same date. **No new task was created** — review the list to confirm the existing tasks accurately reflect each meeting.

| # | Date | Customer | Calendar Subject | Existing Task |
|---|------|----------|------------------|---------------|
${jsonSummary.alreadyExists.map((item, i) =>
  `| ${i + 1} | ${item.date || 'N/A'} | ${item.customer || 'N/A'} | ${item.subject || 'N/A'} | ${item.existingTaskLink ? `[${(item.existingTaskId || '').slice(0, 8)}…](${item.existingTaskLink})` : (item.existingTaskId || 'N/A')} |`
).join('\n')}

` : ''}
## Human Action Required

${actionItems.length > 0 ? actionItems.map((a, i) => `${i + 1}. ${a}`).join('\n') : 'None — all meetings were handled automatically.'}

${masterFollowUp}

## Tools Used

${uniqueTools.map(t => `- ${t}`).join('\n') || 'None'}
Total tool calls: ${toolsCalled.length}

## Full LLM Output

${llmOutput}

---
*Generated by activity-sync Option B (Copilot SDK) at ${now.toISOString()}*
`;

  return report;
}

function saveReport(reportContent, opts) {
  const reportsDir = join(ROOT, 'reports');
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true });
  }

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const mode = opts.dryRun ? 'preview' : 'sync';
  const filename = `${timestamp}_${mode}_${opts.start}_to_${opts.end}.md`;
  const filepath = join(reportsDir, filename);

  writeFileSync(filepath, reportContent, 'utf-8');
  return filepath;
}

// ── Scheduler ───────────────────────────────────────────────────

function parseCron(cronExpr) {
  // Simple cron parser for: minute hour dayOfMonth month dayOfWeek
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression: "${cronExpr}" — need 5 fields (min hour dom month dow)`);
  return { minute: parts[0], hour: parts[1], dom: parts[2], month: parts[3], dow: parts[4] };
}

function cronFieldMatches(field, value) {
  if (field === '*') return true;
  // Handle ranges: 1-5
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  // Handle lists: 1,3,5
  if (field.includes(',')) {
    return field.split(',').map(Number).includes(value);
  }
  // Handle step: */5
  if (field.startsWith('*/')) {
    return value % parseInt(field.slice(2), 10) === 0;
  }
  return parseInt(field, 10) === value;
}

function cronMatches(cron, date) {
  return cronFieldMatches(cron.minute, date.getMinutes())
    && cronFieldMatches(cron.hour, date.getHours())
    && cronFieldMatches(cron.dom, date.getDate())
    && cronFieldMatches(cron.month, date.getMonth() + 1)
    && cronFieldMatches(cron.dow, date.getDay());
}

function msUntilNextMinute() {
  const now = new Date();
  return (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
}

async function runScheduled(opts) {
  const cron = parseCron(opts.schedule);
  const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

  log(`Activity Sync — Scheduled Mode`);
  log(`Schedule: "${opts.schedule}" (cron)`);
  log(`Mode: ${opts.dryRun ? 'DRY-RUN' : 'LIVE'}`);
  log('Waiting for next trigger...');

  const check = async () => {
    const now = new Date();
    if (cronMatches(cron, now)) {
      log('⏰ Cron triggered — starting sync run...');
      // Set start/end to today for scheduled runs
      const todayStr = now.toISOString().slice(0, 10);
      const runOpts = { ...opts, start: todayStr, end: null, days: null, schedule: null };
      // Recompute end date
      const d = new Date(todayStr + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      runOpts.end = d.toISOString().slice(0, 10);

      try {
        await runOnce(runOpts);
      } catch (err) {
        log(`Run failed: ${err.message}`);
      }
      log('Run complete. Waiting for next trigger...');
    }
  };

  // Check every minute at the top of the minute
  const tick = () => {
    check();
    setTimeout(tick, msUntilNextMinute());
  };
  setTimeout(tick, msUntilNextMinute());

  // Keep process alive
  process.on('SIGINT', () => {
    log('Scheduler stopped.');
    process.exit(0);
  });
}

// ── Main Entry Point ────────────────────────────────────────────

async function runOnce(opts) {
  const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

  log('Activity Sync — Copilot SDK Mode');
  log(`Range: ${opts.start} → ${opts.end}${opts.dryRun ? ' [DRY-RUN]' : ''}`);

  let crmClient, crmTransport, wiqClient, wiqTransport, copilotClient;

  try {
    // 1. Connect to MCP servers
    log('Connecting to msx-crm MCP server...');
    ({ client: crmClient, transport: crmTransport } = await connectMcpServer(
      'msx-crm', process.execPath, [MCP_SERVER_PATH]
    ));
    const crmTools = await crmClient.listTools();
    log(`msx-crm connected (${crmTools.tools.length} tools)`);

    log('Connecting to WorkIQ MCP server...');
    ({ client: wiqClient, transport: wiqTransport } = await connectMcpServer(
      'workiq', 'npx', ['-y', '@microsoft/workiq@0.4.0', 'mcp']
    ));
    const wiqTools = await wiqClient.listTools();
    log(`WorkIQ connected (${wiqTools.tools.length} tools)`);

    // 2. Convert MCP tools to Copilot SDK tools
    log('Registering tools with Copilot SDK...');
    const allTools = [
      ...mcpToolsToCopilotTools(crmClient, crmTools.tools, 'msx_crm'),
      ...mcpToolsToCopilotTools(wiqClient, wiqTools.tools, 'workiq'),
    ];
    log(`Registered ${allTools.length} tools`);

    // 3. Build system prompt
    const systemPrompt = buildSystemPrompt(opts);

    // 4. Create Copilot SDK client + session
    log('Starting Copilot SDK client...');
    copilotClient = new CopilotClient();
    await copilotClient.start();

    const session = await copilotClient.createSession({
      model: 'claude-sonnet-4',
      systemMessage: {
        mode: 'replace',
        content: systemPrompt,
      },
      tools: allTools,
      onPermissionRequest: approveAll,
      infiniteSessions: { enabled: false },
    });

    // 5. Stream events for visibility + collect tool log for report
    const toolLog = [];
    session.on('tool.execution_start', (event) => {
      const name = event.data?.toolName || '?';
      const input = truncate(JSON.stringify(event.data?.input), 120);
      log(`  → tool: ${name}(${input})`);
      toolLog.push({ type: 'call', tool: name, input: event.data?.input, ts: new Date().toISOString() });
    });
    session.on('tool.execution_complete', (event) => {
      const result = event.data?.output || event.data?.result || '';
      const name = event.data?.toolName || '?';
      log(`  ← ${name}: ${truncate(typeof result === 'string' ? result : JSON.stringify(result), 200)}`);
      toolLog.push({ type: 'result', tool: name, ts: new Date().toISOString() });
    });

    // 6. Send the task prompt and wait for the LLM to finish
    const taskPrompt = opts.dryRun
      ? `Preview (dry-run) my calendar meetings from ${opts.start} to ${opts.end}. Show what tasks would be created but do NOT create anything.`
      : `Sync my calendar meetings from ${opts.start} to ${opts.end}. Create tasks in CRM for customer meetings.`;

    log(`Sending prompt to LLM: "${taskPrompt}"`);
    log('───────────────── LLM Output ─────────────────');

    const response = await session.sendAndWait(
      { prompt: taskPrompt },
      600_000 // 10 minute timeout
    );

    const llmOutput = response?.data?.content || '(no response)';
    console.log('\n' + llmOutput);

    log('───────────────── End LLM Output ──────────────');

    // 7. Save report
    const report = buildReport(opts, llmOutput, toolLog);
    const reportPath = saveReport(report, opts);
    log(`Report saved: ${reportPath}`);

    // 7b. Emit a high-visibility banner for "ALREADY EXISTS" duplicates
    //     so the scheduled-run.log shows them prominently (not just the report).
    try {
      const m = llmOutput.match(/```json\s*([\s\S]*?)```/);
      const summary = m ? JSON.parse(m[1]) : null;
      const dupes = summary?.alreadyExists || [];
      if (dupes.length > 0) {
        log('');
        log('============================================================');
        log(`  ${dupes.length} meeting(s) ALREADY LOGGED IN CRM — review these:`);
        log('============================================================');
        dupes.forEach((d, i) => {
          log(`  ${i + 1}. [${d.date || '?'}] ${d.customer || '?'} — "${d.subject || '?'}"`);
          if (d.existingTaskLink) log(`     existing task: ${d.existingTaskLink}`);
          else if (d.existingTaskId) log(`     existing task id: ${d.existingTaskId}`);
        });
        log('============================================================');
        log('');
      }
    } catch { /* best-effort banner */ }

    log('Copilot SDK session completed.');

    await session.disconnect();
  } catch (err) {
    log(`FATAL: ${err.message}`);
    console.error(err.stack);
    process.exitCode = 2;
  } finally {
    // Cleanup
    if (copilotClient) {
      try { await copilotClient.stop(); } catch { /* ignore */ }
    }
    if (wiqClient) {
      try { await wiqClient.close(); } catch { /* ignore */ }
    }
    if (wiqTransport) {
      try { await wiqTransport.close(); } catch { /* ignore */ }
    }
    if (crmClient) {
      try { await crmClient.close(); } catch { /* ignore */ }
    }
    if (crmTransport) {
      try { await crmTransport.close(); } catch { /* ignore */ }
    }
  }
}

function main() {
  const opts = parseArgs(process.argv);

  if (opts.schedule) {
    runScheduled(opts);
  } else {
    // Resolve dates for single run
    const todayStr = new Date().toISOString().slice(0, 10);
    if (!opts.start) opts.start = todayStr;
    if (opts.days) {
      const d = new Date(opts.start + 'T00:00:00');
      d.setDate(d.getDate() + opts.days);
      opts.end = d.toISOString().slice(0, 10);
    } else if (!opts.end) {
      const d = new Date(opts.start + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      opts.end = d.toISOString().slice(0, 10);
    }
    runOnce(opts);
  }
}

main();
