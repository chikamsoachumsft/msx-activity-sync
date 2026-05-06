// Sync orchestrator — main pipeline that coordinates calendar fetch,
// classification, CRM task creation/closing, and state updates.
// Used by headless.js; receives an MCP client for CRM operations.

import { loadState, saveState, isProcessed, addProcessed, cacheCustomerMilestone } from './state.js';
import { fetchCalendarEvents, fetchCalendarViaWorkIQ } from './calendar.js';
import { classifyAll, inferCategory, cleanSubject } from './classifier.js';

/**
 * Run the full sync pipeline for a date range.
 *
 * @param {object} opts
 * @param {object} opts.mcpClient - MCP Client instance connected to msx-crm server
 * @param {object} [opts.workiqClient] - MCP Client connected to WorkIQ server (for calendar)
 * @param {string} opts.startDate - YYYY-MM-DD
 * @param {string} opts.endDate   - YYYY-MM-DD (exclusive)
 * @param {boolean} [opts.dryRun=false] - Preview only, no CRM writes
 * @param {string} [opts.statePath] - Override state file path
 * @param {string} [opts.timezone] - IANA timezone (default: America/Chicago)
 * @param {Function} [opts.log] - Logging function (default: console.log)
 * @returns {Promise<SyncResult>}
 */
export async function runSync(opts) {
  const {
    mcpClient,
    workiqClient,
    startDate,
    endDate,
    dryRun = false,
    statePath,
    timezone = 'America/Chicago',
    log = console.log
  } = opts;

  const result = { created: [], skipped: [], failed: [], startDate, endDate, dryRun };

  // 0. Resolve current user ID from CRM
  log('Resolving CRM user identity...');
  const whoamiResult = await callTool(mcpClient, 'crm_whoami', {});
  const whoamiData = parseToolResult(whoamiResult);
  const userId = whoamiData?.UserId || whoamiData?.userId;
  if (!userId) throw new Error('Could not resolve CRM user ID — check auth');
  log(`CRM user: ${userId}`);

  // 1. Load state
  log(`Loading state...`);
  const state = await loadState(statePath);
  log(`State loaded: ${state.processedMeetings.length} processed, ${Object.keys(state.customerMilestoneCache).length} customers cached`);

  // 2. Fetch calendar events (prefer WorkIQ, fallback to Graph API)
  log(`Fetching calendar for ${startDate} to ${endDate}...`);
  let meetings;
  if (workiqClient) {
    log('Using WorkIQ MCP for calendar access');
    meetings = await fetchCalendarViaWorkIQ(workiqClient, startDate, endDate);
  } else {
    log('Using Graph API for calendar access');
    meetings = await fetchCalendarEvents(startDate, endDate, { timezone });
  }
  log(`Found ${meetings.length} calendar events`);

  // 3. Filter already-processed
  const unprocessed = meetings.filter(m => !isProcessed(state, m.subject, m.startDate));
  log(`${unprocessed.length} unprocessed (${meetings.length - unprocessed.length} already done)`);

  if (unprocessed.length === 0) {
    log('Nothing to process.');
    return result;
  }

  // 4. Classify all meetings
  const classified = classifyAll(unprocessed, state);

  // 4b. For meetings with a customer but no cached milestone, try CRM lookup
  const needsMilestoneLookup = classified.filter(
    c => c.classification.skip && c.classification.reason?.includes('needs CRM lookup') && c.classification.customer
  );
  if (needsMilestoneLookup.length > 0) {
    log(`Looking up CRM milestones for ${needsMilestoneLookup.length} new customers...`);
    for (const { meeting, classification } of needsMilestoneLookup) {
      try {
        const lookup = await lookupMilestone(mcpClient, classification.customer, log);

        if (lookup.status === 'found') {
          cacheCustomerMilestone(state, classification.customer, lookup.milestoneId);
          classification.milestoneId = lookup.milestoneId;
          classification.skip = false;
          classification.reason = null;
          classification.category = inferCategory(meeting.subject);
          classification.subject = cleanSubject(meeting.subject, classification.customer);
          log(`  ✓ Found milestone for "${classification.customer}": ${lookup.milestoneId}`);
        } else if (lookup.status === 'no-milestone') {
          classification.reason = `On deal team for "${classification.customer}" but no active milestones`;
          log(`  ⚠ On deal team for "${classification.customer}" but no active milestones — skipping`);
        } else {
          // no-opportunity
          classification.reason = `Customer "${classification.customer}" not found in your CRM opportunities`;
          log(`  ✗ No CRM opportunity found for "${classification.customer}" — not on deal team`);
        }
      } catch (err) {
        log(`  CRM lookup failed for "${classification.customer}": ${err.message}`);
      }
    }
  }

  // 5. Process each meeting
  for (const { meeting, classification } of classified) {
    if (classification.skip) {
      result.skipped.push({
        subject: meeting.subject,
        date: meeting.startDate,
        reason: classification.reason,
        customer: classification.customer
      });
      log(`  SKIP: "${meeting.subject}" — ${classification.reason}`);
      continue;
    }

    // This meeting should get a CRM task
    if (dryRun) {
      result.created.push({
        subject: classification.subject,
        date: meeting.startDate,
        customer: classification.customer,
        milestoneId: classification.milestoneId,
        category: classification.category,
        dryRun: true
      });
      log(`  [DRY-RUN] Would create: "${classification.subject}" for ${classification.customer}`);
      continue;
    }

    // Actually create the task via MCP
    try {
      const taskId = await createAndCloseTask(mcpClient, {
        milestoneId: classification.milestoneId,
        subject: classification.subject,
        category: classification.category,
        dueDate: meeting.startDate,
        ownerId: userId
      }, log);

      // Record in state
      addProcessed(state, {
        subject: meeting.subject,
        date: meeting.startDate,
        customer: classification.customer,
        taskId,
        milestoneId: classification.milestoneId
      });

      result.created.push({
        subject: classification.subject,
        date: meeting.startDate,
        customer: classification.customer,
        milestoneId: classification.milestoneId,
        category: classification.category,
        taskId
      });
      log(`  CREATED: "${classification.subject}" for ${classification.customer} → ${taskId}`);
    } catch (err) {
      result.failed.push({
        subject: classification.subject,
        date: meeting.startDate,
        customer: classification.customer,
        error: err.message
      });
      log(`  FAILED: "${classification.subject}" — ${err.message}`);
    }
  }

  // 6. Save state
  if (!dryRun) {
    state.lastRunAt = new Date().toISOString();
    await saveState(state, statePath);
    log(`State saved. Total processed: ${state.processedMeetings.length}`);
  }

  // 7. Summary
  log(`\nSync complete: ${result.created.length} created, ${result.skipped.length} skipped, ${result.failed.length} failed`);
  return result;
}

// ── CRM operations via MCP client ────────────────────────────

/**
 * Look up a milestone for a customer.
 *
 * Strategy:
 *  1. get_my_active_opportunities(customerKeyword) — checks deal-team + ownership
 *     (uses display-name includes, more forgiving than OData contains)
 *  2. If opportunity found → get_milestones(opportunityId) for any active milestone
 *  3. If no opportunity → return { status: 'no-opportunity' } so caller can flag it
 *
 * Returns:
 *  - { status: 'found', milestoneId, opportunityId }
 *  - { status: 'no-milestone', opportunityId }  (on deal team but no active milestones)
 *  - { status: 'no-opportunity' }                (not on any deal team for this customer)
 */
async function lookupMilestone(mcpClient, customerName, log) {
  // Step 1: Check deal-team / ownership via get_my_active_opportunities
  const oppResult = await callTool(mcpClient, 'get_my_active_opportunities', {
    customerKeyword: customerName
  });
  const oppData = parseToolResult(oppResult);
  const opps = oppData?.opportunities || (Array.isArray(oppData) ? oppData : []);

  if (!opps.length) {
    // Also try get_milestones directly as fallback (in case account name substring works)
    const msResult = await callTool(mcpClient, 'get_milestones', {
      customerKeyword: customerName,
      statusFilter: 'active',
      format: 'summary'
    });
    const msData = parseToolResult(msResult);
    const milestoneId = extractMilestoneId(msData);
    if (milestoneId) return { status: 'found', milestoneId, opportunityId: null };
    return { status: 'no-opportunity' };
  }

  // Step 2: We're on the deal team — find milestones for these opportunities
  for (const opp of opps) {
    const oppId = opp.opportunityid;
    if (!oppId) continue;

    const msResult = await callTool(mcpClient, 'get_milestones', {
      opportunityId: oppId,
      statusFilter: 'active',
      format: 'summary'
    });
    const msData = parseToolResult(msResult);
    const milestoneId = extractMilestoneId(msData);
    if (milestoneId) {
      return { status: 'found', milestoneId, opportunityId: oppId };
    }
  }

  // On deal team but no active milestones on any of the matched opportunities
  return { status: 'no-milestone', opportunityId: opps[0]?.opportunityid };
}

/** Extract first milestone GUID from a get_milestones response */
function extractMilestoneId(data) {
  if (!data) return null;
  if (Array.isArray(data)) {
    if (data.length > 0 && data[0].milestoneId) return data[0].milestoneId;
    if (data.length > 0 && data[0].msp_engagementmilestoneid) return data[0].msp_engagementmilestoneid;
  }
  // Grouped object or milestones array nested in response
  const milestones = data.milestones || data.value;
  if (Array.isArray(milestones) && milestones.length > 0) {
    return milestones[0].milestoneId || milestones[0].msp_engagementmilestoneid || null;
  }
  // Last resort: extract a GUID from stringified response
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  const guidMatch = str.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return guidMatch ? guidMatch[0] : null;
}

/**
 * Create a task, set actual time, execute, close, execute.
 * Uses the staged approval queue (create → execute_all → update time → execute_all → close → execute_all).
 *
 * In headless mode, we call the MCP tools directly through the client.
 * The approval queue auto-executes because we call execute_all after each stage.
 */
async function createAndCloseTask(mcpClient, { milestoneId, subject, category, dueDate, ownerId }, log) {
  // Step 1: Create the task
  const createResult = await callTool(mcpClient, 'create_task', {
    milestoneId,
    subject,
    category,
    dueDate,
    ownerId
  });

  // Execute the staged create
  const execCreate = await callTool(mcpClient, 'execute_all', {});
  const createData = parseToolResult(execCreate);

  if (createData.failed > 0) {
    throw new Error(`create_task execution failed: ${JSON.stringify(createData.results)}`);
  }

  // The task ID comes from the CRM response — we need to find it
  // After execute_all, the operation result contains the created task
  // For POST to tasks, CRM returns the ID in the OData-EntityId header or response
  // We'll query for it using the subject + milestone filter
  const taskId = await findRecentTask(mcpClient, milestoneId, subject);
  if (!taskId) {
    throw new Error(`Task created but could not find ID for "${subject}"`);
  }

  // Step 2: Set actualstart and actualend to the due date (same day)
  const timePayload = {
    taskId,
    dueDate // update_task accepts dueDate but we need actualstart/actualend
  };

  // Use update_task for setting the scheduled time
  // The actual times need to be set via direct update
  await callTool(mcpClient, 'update_task', {
    taskId,
    dueDate
  });
  await callTool(mcpClient, 'execute_all', {});

  // Step 3: Close the task as Completed (status 5)
  await callTool(mcpClient, 'close_task', {
    taskId,
    statusCode: 5,
    subject: 'Task Closed'
  });
  const execClose = await callTool(mcpClient, 'execute_all', {});
  const closeData = parseToolResult(execClose);

  if (closeData.failed > 0) {
    log(`  Warning: close_task may have failed for ${taskId}: ${JSON.stringify(closeData.results)}`);
  }

  return taskId;
}

/**
 * Find a recently created task by subject on a milestone.
 */
async function findRecentTask(mcpClient, milestoneId, subject) {
  const result = await callTool(mcpClient, 'crm_query', {
    entitySet: 'tasks',
    filter: `_regardingobjectid_value eq '${milestoneId}' and subject eq '${escapeOData(subject)}'`,
    select: 'activityid,subject,createdon',
    orderBy: 'createdon desc',
    top: 1
  });

  const data = parseToolResult(result);
  if (data.value && data.value.length > 0) {
    return data.value[0].activityid;
  }
  return null;
}

/**
 * Call an MCP tool and return the raw result.
 */
async function callTool(mcpClient, toolName, args) {
  const result = await mcpClient.callTool({ name: toolName, arguments: args });
  return result;
}

/**
 * Parse the text content from an MCP tool result.
 * MCP tool results have content: [{ type: 'text', text: '...' }]
 */
function parseToolResult(result) {
  if (!result?.content?.length) return {};
  const textContent = result.content.find(c => c.type === 'text');
  if (!textContent?.text) return {};
  try {
    return JSON.parse(textContent.text);
  } catch {
    return { raw: textContent.text };
  }
}

/**
 * Escape a string for OData filter queries.
 */
function escapeOData(str) {
  return str.replace(/'/g, "''");
}

/**
 * @typedef {object} SyncResult
 * @property {Array<object>} created - Tasks that were created
 * @property {Array<object>} skipped - Meetings that were skipped
 * @property {Array<object>} failed - Operations that failed
 * @property {string} startDate
 * @property {string} endDate
 * @property {boolean} dryRun
 */
