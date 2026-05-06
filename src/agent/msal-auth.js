// MSAL interactive browser authentication for Graph API
// Uses @azure/msal-node with a file-based token cache for persistent sessions.
// First run: opens system browser for interactive login (satisfies Conditional Access).
// Subsequent runs: silently acquires token from cached refresh token (~90 day lifetime).

import { PublicClientApplication, LogLevel } from '@azure/msal-node';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────────
// Override via env vars or pass to createMsalAuth()
const DEFAULT_CLIENT_ID = process.env.GRAPH_CLIENT_ID || '';
const DEFAULT_TENANT_ID = process.env.MSX_TENANT_ID || '72f988bf-86f1-41af-91ab-2d7cd011db47';
const DEFAULT_CACHE_PATH = join(__dirname, '..', '..', '.msal-cache.json');

const GRAPH_SCOPES = ['https://graph.microsoft.com/Calendars.Read'];

/**
 * Create an MSAL auth instance with device code flow support.
 *
 * @param {object} [opts]
 * @param {string} [opts.clientId] - Entra app registration client ID
 * @param {string} [opts.tenantId] - Tenant ID
 * @param {string} [opts.cachePath] - Path to persist token cache
 * @param {Function} [opts.log] - Logger function
 * @returns {object} { acquireToken, clearCache }
 */
export function createMsalAuth(opts = {}) {
  const clientId = opts.clientId || DEFAULT_CLIENT_ID;
  const tenantId = opts.tenantId || DEFAULT_TENANT_ID;
  const cachePath = opts.cachePath || DEFAULT_CACHE_PATH;
  const log = opts.log || console.log;

  if (!clientId) {
    throw new Error(
      'GRAPH_CLIENT_ID is not set. Register an Entra ID app with Calendars.Read permission ' +
      'and set the GRAPH_CLIENT_ID environment variable. See src/agent/README-auth.md for steps.'
    );
  }

  const msalConfig = {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`
    },
    system: {
      loggerOptions: {
        logLevel: LogLevel.Warning,
        loggerCallback: (_level, message) => {
          if (message.includes('Error')) log(`[MSAL] ${message}`);
        }
      }
    }
  };

  const pca = new PublicClientApplication(msalConfig);

  // ── Token cache persistence ──────────────────────────────
  // MSAL Node's in-memory cache is populated from/saved to a JSON file.

  async function loadCache() {
    try {
      const data = await readFile(cachePath, 'utf-8');
      pca.getTokenCache().deserialize(data);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // No cache file yet — first run
    }
  }

  async function saveCache() {
    const data = pca.getTokenCache().serialize();
    await writeFile(cachePath, data, 'utf-8');
  }

  /**
   * Acquire a Graph API token with Calendars.Read scope.
   * Tries silent acquisition first (cached refresh token), falls back to interactive browser.
   *
   * @returns {Promise<string>} Bearer access token
   */
  async function acquireToken() {
    await loadCache();

    // Try silent acquisition from cache
    const accounts = await pca.getTokenCache().getAllAccounts();
    if (accounts.length > 0) {
      try {
        const result = await pca.acquireTokenSilent({
          account: accounts[0],
          scopes: GRAPH_SCOPES
        });
        await saveCache();
        return result.accessToken;
      } catch {
        // Silent failed (token expired, refresh token revoked) — proceed to interactive
        log('Cached token expired, initiating interactive browser login...');
      }
    }

    // Interactive browser flow — opens system browser (satisfies Conditional Access)
    log('');
    log('='.repeat(60));
    log('  GRAPH AUTHENTICATION REQUIRED');
    log('  A browser window will open for you to sign in.');
    log('  After signing in, return here — the token will be cached.');
    log('='.repeat(60));
    log('');

    const result = await pca.acquireTokenInteractive({
      scopes: GRAPH_SCOPES,
      openBrowser: async (url) => {
        // Open the URL in the default system browser
        const { exec } = await import('node:child_process');
        const cmd = process.platform === 'win32' ? `start "" "${url}"`
          : process.platform === 'darwin' ? `open "${url}"`
          : `xdg-open "${url}"`;
        exec(cmd);
      },
      successTemplate: '<h1>Authentication successful!</h1><p>You can close this window and return to the terminal.</p>',
      errorTemplate: '<h1>Authentication failed</h1><p>Error: {{error}}</p>'
    });

    await saveCache();
    log('Authentication successful. Token cached for future runs.');
    return result.accessToken;
  }

  /**
   * Clear the persisted token cache (forces re-authentication on next run).
   */
  async function clearCache() {
    try {
      await writeFile(cachePath, '{}', 'utf-8');
      log('Token cache cleared.');
    } catch { /* ignore */ }
  }

  return { acquireToken, clearCache };
}
