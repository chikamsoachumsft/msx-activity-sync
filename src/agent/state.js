// State store for activity sync — reads/writes sync-state.json
// Schema: { lastRunAt, processedMeetings[], customerMilestoneCache, skippedCustomers[] }
// Default location: ~/.activity-sync/sync-state.json (per-user, not in repo)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = join(homedir(), '.activity-sync');
const DEFAULT_STATE_PATH = join(STATE_DIR, 'sync-state.json');
// Legacy path for backward compat
const LEGACY_STATE_PATH = join(import.meta.dirname, '..', '..', 'sync-state.json');

const EMPTY_STATE = {
  lastRunAt: null,
  processedMeetings: [],
  customerMilestoneCache: {},
  skippedCustomers: []
};

/**
 * Load sync state from disk.
 * Checks ~/.activity-sync/sync-state.json first, then repo-root sync-state.json (legacy).
 * @param {string} [path] - Override path to state file
 * @returns {Promise<object>} The state object
 */
export async function loadState(path) {
  const paths = path ? [path] : [DEFAULT_STATE_PATH, LEGACY_STATE_PATH];
  for (const filePath of paths) {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        lastRunAt: parsed.lastRunAt || null,
        processedMeetings: Array.isArray(parsed.processedMeetings) ? parsed.processedMeetings : [],
        customerMilestoneCache: parsed.customerMilestoneCache || {},
        skippedCustomers: Array.isArray(parsed.skippedCustomers) ? parsed.skippedCustomers : []
      };
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
  }
  return { ...EMPTY_STATE };
}

/**
 * Save sync state to disk.
 * Saves to ~/.activity-sync/sync-state.json (creates dir if needed).
 * @param {object} state - The state object
 * @param {string} [path] - Override path
 */
export async function saveState(state, path) {
  const filePath = path || DEFAULT_STATE_PATH;
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Check if a meeting has already been processed.
 * Uses subject + date as composite key (Graph meeting IDs change across views).
 * @param {object} state - The state object
 * @param {string} subject - Meeting subject
 * @param {string} dateStr - ISO date string (YYYY-MM-DD)
 * @returns {boolean}
 */
export function isProcessed(state, subject, dateStr) {
  return state.processedMeetings.some(
    m => m.subject === subject && m.date === dateStr
  );
}

/**
 * Add a processed meeting to state (does not save to disk).
 * @param {object} state - The state object
 * @param {object} meeting - { subject, date, customer, taskId, milestoneId }
 */
export function addProcessed(state, meeting) {
  state.processedMeetings.push({
    subject: meeting.subject,
    date: meeting.date,
    customer: meeting.customer,
    taskId: meeting.taskId || null,
    milestoneId: meeting.milestoneId || null,
    processedAt: new Date().toISOString()
  });
}

/**
 * Look up a milestone ID for a customer name.
 * @param {object} state
 * @param {string} customerName
 * @returns {string|null} Milestone GUID or null
 */
export function getMilestoneForCustomer(state, customerName) {
  // Exact match first
  if (state.customerMilestoneCache[customerName]) {
    return state.customerMilestoneCache[customerName];
  }
  // Case-insensitive match
  const lower = customerName.toLowerCase();
  for (const [name, id] of Object.entries(state.customerMilestoneCache)) {
    if (name.toLowerCase() === lower) return id;
  }
  return null;
}

/**
 * Check if a customer should be skipped.
 * @param {object} state
 * @param {string} customerName
 * @returns {{ skip: boolean, reason?: string }}
 */
export function isSkippedCustomer(state, customerName) {
  const lower = customerName.toLowerCase();
  const entry = state.skippedCustomers.find(
    s => s.name.toLowerCase() === lower
  );
  return entry ? { skip: true, reason: entry.reason } : { skip: false };
}

/**
 * Add a customer → milestone mapping to the cache (does not save to disk).
 * @param {object} state
 * @param {string} customerName
 * @param {string} milestoneId
 */
export function cacheCustomerMilestone(state, customerName, milestoneId) {
  state.customerMilestoneCache[customerName] = milestoneId;
}
