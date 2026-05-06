// Graph API authentication
// Strategy: MSAL device code (with Calendars.Read) → az CLI fallback
// MSAL is required for calendar access since az CLI's built-in app
// doesn't have Calendars.Read consent in the Microsoft tenant.

import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createMsalAuth } from './msal-auth.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const GRAPH_RESOURCE = 'https://graph.microsoft.com';
const DEFAULT_TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';

// Resolve az CLI path (mirrors src/auth.js logic)
let _azCliPath;
const getAzureCliCommand = () => {
  if (_azCliPath) return _azCliPath;
  if (process.platform === 'win32') { _azCliPath = 'az.cmd'; return _azCliPath; }

  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const candidates = [
    `${home}/miniconda3/bin/az`, `${home}/anaconda3/bin/az`,
    '/opt/homebrew/bin/az', '/usr/local/bin/az', '/usr/bin/az'
  ];
  for (const p of candidates) {
    if (existsSync(p)) { _azCliPath = p; return _azCliPath; }
  }

  const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash'].filter(Boolean);
  for (const sh of shells) {
    try {
      const resolved = execSync(`${sh} -ilc "command -v az"`, {
        encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      if (resolved && existsSync(resolved)) { _azCliPath = resolved; return _azCliPath; }
    } catch { /* try next */ }
  }

  _azCliPath = 'az';
  return _azCliPath;
};

/**
 * Get a Graph API access token.
 * Strategy: MSAL (device code + cached refresh token) → az CLI fallback.
 *
 * @param {object} [opts]
 * @param {string} [opts.tenantId]
 * @param {string} [opts.clientId] - Entra app client ID (or GRAPH_CLIENT_ID env var)
 * @param {Function} [opts.log] - Logger
 * @returns {Promise<string>} Bearer token
 */
export async function getGraphToken({ tenantId, clientId, log } = {}) {
  const tenant = tenantId || process.env.MSX_TENANT_ID || DEFAULT_TENANT;

  // Try MSAL first (has Calendars.Read)
  const msalClientId = clientId || process.env.GRAPH_CLIENT_ID;
  if (msalClientId) {
    try {
      const msal = createMsalAuth({ clientId: msalClientId, tenantId: tenant, log });
      return await msal.acquireToken();
    } catch (err) {
      (log || console.log)(`MSAL auth failed: ${err.message}, falling back to az CLI...`);
    }
  }

  // Fallback: az CLI (may lack calendar scopes)
  return getGraphTokenViaCli(tenant);
}

/**
 * Get a Graph API access token via az CLI (fallback).
 * @param {string} tenant
 * @returns {Promise<string>} Bearer token
 */
function getGraphTokenViaCli(tenant) {
  return new Promise((resolve, reject) => {
    const args = [
      'account', 'get-access-token',
      '--resource', GRAPH_RESOURCE,
      '--tenant', tenant,
      '--query', 'accessToken',
      '-o', 'tsv'
    ];

    const proc = spawn(getAzureCliCommand(), args, {
      shell: process.platform === 'win32',
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let completed = false;

    const timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        proc.kill();
        reject(new Error('Azure CLI timed out fetching Graph token.'));
      }
    }, DEFAULT_TIMEOUT_MS);

    const cleanup = () => { clearTimeout(timeoutId); completed = true; };

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', err => {
      cleanup();
      if (err.code === 'ENOENT') {
        reject(new Error('Azure CLI not found. Install: https://learn.microsoft.com/cli/azure/install-azure-cli'));
      } else {
        reject(new Error(`Failed to run Azure CLI: ${err.message}`));
      }
    });

    proc.on('close', code => {
      cleanup();
      if (code === 0) {
        const token = stdout.trim();
        if (token) resolve(token);
        else reject(new Error('Azure CLI returned empty Graph token'));
      } else {
        if (stderr.includes('AADSTS') || stderr.includes('login')) {
          reject(new Error(`Azure CLI session expired. Run: az login --tenant ${tenant}`));
        } else {
          reject(new Error(`Azure CLI error: ${stderr || 'Unknown error'}`));
        }
      }
    });
  });
}
