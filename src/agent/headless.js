#!/usr/bin/env node
// Headless entry point — spawns the msx-crm MCP server as a child process,
// connects as an MCP Client, runs the sync pipeline, and exits.
// Used by all runner approaches (Windows Task, GitHub Actions, ADO, etc.)

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSync } from './sync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = join(__dirname, '..', 'index.js');

/**
 * Parse CLI arguments.
 * Usage: node headless.js [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--dry-run] [--days N]
 *
 * Defaults:
 *   --start: today
 *   --end:   today + 1 day
 *   --days:  1 (overrides --end if both specified)
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { dryRun: false, days: null, start: null, end: null };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--start':
        opts.start = args[++i];
        break;
      case '--end':
        opts.end = args[++i];
        break;
      case '--days':
        opts.days = parseInt(args[++i], 10);
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--help':
        console.log(`Usage: node headless.js [options]
Options:
  --start YYYY-MM-DD   Start date (default: today)
  --end YYYY-MM-DD     End date, exclusive (default: start + 1 day)
  --days N             Number of days from start (overrides --end)
  --dry-run            Preview only, no CRM writes`);
        process.exit(0);
    }
  }

  // Resolve dates
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  if (!opts.start) opts.start = todayStr;

  if (opts.days) {
    const startDate = new Date(opts.start + 'T00:00:00');
    startDate.setDate(startDate.getDate() + opts.days);
    opts.end = startDate.toISOString().slice(0, 10);
  } else if (!opts.end) {
    const startDate = new Date(opts.start + 'T00:00:00');
    startDate.setDate(startDate.getDate() + 1);
    opts.end = startDate.toISOString().slice(0, 10);
  }

  return opts;
}

/**
 * Spawn the MCP server and connect as a client.
 * @returns {{ client: Client, transport: StdioClientTransport }}
 */
async function connectToMcpServer() {
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [MCP_SERVER_PATH],
    env: {
      ...process.env,
      // Forward any MSX_ env vars
    }
  });

  const client = new Client({
    name: 'activity-sync-headless',
    version: '1.0.0'
  });

  await client.connect(transport);
  return { client, transport };
}

/**
 * Spawn the WorkIQ MCP server and connect as a client.
 * Uses cached tokens from previous interactive auth.
 * @returns {{ client: Client, transport: StdioClientTransport }}
 */
async function connectToWorkIQ() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@microsoft/workiq', 'mcp'],
    env: { ...process.env },
  });

  const client = new Client({
    name: 'activity-sync-workiq',
    version: '1.0.0',
  });

  await client.connect(transport);
  return { client, transport };
}

async function main() {
  const opts = parseArgs(process.argv);
  const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

  log(`Activity Sync — Headless Mode`);
  log(`Range: ${opts.start} → ${opts.end}${opts.dryRun ? ' [DRY-RUN]' : ''}`);

  let client, transport, workiqClient, workiqTransport;
  try {
    // 1. Connect to msx-crm MCP server
    log('Connecting to msx-crm MCP server...');
    ({ client, transport } = await connectToMcpServer());
    const tools = await client.listTools();
    log(`msx-crm connected (${tools.tools.length} tools).`);

    // 2. Connect to WorkIQ MCP server (for calendar)
    log('Connecting to WorkIQ MCP server...');
    ({ client: workiqClient, transport: workiqTransport } = await connectToWorkIQ());
    const wiqTools = await workiqClient.listTools();
    log(`WorkIQ connected (${wiqTools.tools.length} tools).`);

    // 3. Run sync pipeline
    const result = await runSync({
      mcpClient: client,
      workiqClient,
      startDate: opts.start,
      endDate: opts.end,
      dryRun: opts.dryRun,
      timezone: 'America/Chicago',
      log
    });

    // 4. Output summary as JSON (for runners to parse)
    const summary = {
      success: true,
      startDate: result.startDate,
      endDate: result.endDate,
      dryRun: result.dryRun,
      created: result.created.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
      details: {
        created: result.created,
        skipped: result.skipped,
        failed: result.failed
      }
    };

    console.log('\n' + JSON.stringify(summary, null, 2));

    // Exit with code based on failures
    process.exitCode = result.failed.length > 0 ? 1 : 0;
  } catch (err) {
    log(`FATAL: ${err.message}`);
    console.error(err.stack);

    console.log('\n' + JSON.stringify({
      success: false,
      error: err.message,
      startDate: opts.start,
      endDate: opts.end
    }));

    process.exitCode = 2;
  } finally {
    // 5. Disconnect and shutdown MCP servers
    if (workiqClient) {
      try { await workiqClient.close(); } catch { /* ignore */ }
    }
    if (workiqTransport) {
      try { await workiqTransport.close(); } catch { /* ignore */ }
    }
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
    if (transport) {
      try { await transport.close(); } catch { /* ignore */ }
    }
  }
}

main();
