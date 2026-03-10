// MCP tool definitions — maps CRM operations to MCP tools
// Each tool receives validated params and calls createCrmClient methods

import { z } from 'zod';
import { isValidGuid, normalizeGuid, isValidTpid, sanitizeODataString } from './validation.js';
import { getApprovalQueue } from './approval-queue.js';
import { auditLog } from './audit.js';

// ── Entity allowlist ─────────────────────────────────────────
// Only these Dynamics 365 entity sets may be queried via crm_query
// and crm_get_record.  Purpose-built tools bypass this list because
// they already constrain scope through hard-coded entity paths.
export const ALLOWED_ENTITY_SETS = new Set([
  'accounts',
  'contacts',
  'opportunities',
  'msp_engagementmilestones',
  'msp_dealteams',
  'msp_workloads',
  'tasks',
  'systemusers',
  'transactioncurrencies',
  // Deal team / partner linkage (alternative to msp_dealteams in some orgs)
  'connections',
  'connectionroles',
  // BPF stage name resolution (mcem-stage-identification)
  'processstages',
  // Metadata endpoints (used by get_task_status_options pattern)
  'EntityDefinitions',
]);

/** Check whether an entity set (or entity-set-with-key) is on the allowlist. */
export function isEntityAllowed(entitySet) {
  if (!entitySet || typeof entitySet !== 'string') return false;
  // Strip key suffix: "accounts(guid)" → "accounts"
  const base = entitySet.split('(')[0].split('/')[0];
  return ALLOWED_ENTITY_SETS.has(base);
}

const MILESTONE_SELECT = [
  'msp_engagementmilestoneid',
  'msp_milestonenumber',
  'msp_name',
  '_msp_workloadlkid_value',
  'msp_commitmentrecommendation',
  'msp_milestonecategory',
  'msp_monthlyuse',
  'msp_milestonedate',
  'msp_milestonestatus',
  '_ownerid_value',
  '_msp_opportunityid_value',
  'msp_forecastcommentsjsonfield',
  'msp_forecastcomments',
  'msp_milestoneworkload',
  'msp_deliveryspecifiedfield',
  'msp_milestonepreferredazureregion',
  'msp_milestoneazurecapacitytype'
].join(',');

const OPP_SELECT = [
  'opportunityid', 'name', 'estimatedclosedate',
  'msp_estcompletiondate', 'msp_consumptionconsumedrecurring',
  '_ownerid_value', '_parentaccountid_value', 'msp_salesplay'
].join(',');

const TASK_CATEGORIES = [
  { label: 'Technical Close/Win Plan', value: 606820005 },
  { label: 'Architecture Design Session', value: 861980004 },
  { label: 'Blocker Escalation', value: 861980006 },
  { label: 'Briefing', value: 861980008 },
  { label: 'Consumption Plan', value: 861980007 },
  { label: 'Demo', value: 861980002 },
  { label: 'PoC/Pilot', value: 861980005 },
  { label: 'Workshop', value: 861980001 }
];

// ── Milestone view field picklist options ─────────────────────
// Embedded here so the agent can present options to users without
// a metadata round-trip.  get_milestone_field_options still queries
// live metadata for the full list (especially Azure regions/capacity).

const WORKLOAD_TYPES = [
  { label: 'Azure', value: 861980000 },
  { label: 'Dynamics 365', value: 861980001 },
  { label: 'Security', value: 861980002 },
  { label: 'Modern Work', value: 861980003 }
];

const DELIVERED_BY = [
  { label: 'Customer', value: 606820000 },
  { label: 'Partner', value: 606820001 },
  { label: 'ISD', value: 606820002 },
  { label: 'Microsoft Support', value: 606820003 }
];

const MILESTONE_STATUSES = [
  { label: 'On Track', value: 861980000 },
  { label: 'At Risk', value: 861980001 },
  { label: 'Blocked', value: 861980002 },
  { label: 'Completed', value: 861980003 },
  { label: 'Cancelled', value: 861980004 },
  { label: 'Not Started', value: 861980005 },
  { label: 'Closed as Incomplete', value: 861980007 }
];

const COMMITMENT_RECOMMENDATIONS = [
  { label: 'Uncommitted', value: 861980000 },
  { label: 'Committed', value: 861980001 },
  { label: 'Best Case', value: 861980002 },
  { label: 'Pipeline', value: 861980003 }
];

const MILESTONE_CATEGORIES = [
  { label: 'POC/Pilot', value: 861980000 },
  { label: 'Pre-Production', value: 861980001 },
  { label: 'Production', value: 861980002 }
];

// Common regions — full list (75 options) available via get_milestone_field_options
const PREFERRED_AZURE_REGIONS_COMMON = [
  { label: 'East US - Blue Ridge', value: 861980005 },
  { label: 'East US 2 - Boydton', value: 861980006 },
  { label: 'Central US - Des Moines', value: 861980018 },
  { label: 'West US 2 - Quincy', value: 861980040 },
  { label: 'West US 3 - Phoenix', value: 861980036 },
  { label: 'West Europe - Amsterdam', value: 861980001 },
  { label: 'North Europe - Dublin', value: 861980022 },
  { label: 'Southeast Asia - Singapore', value: 861980046 },
  { label: 'None', value: 861980076 }
];

// Common capacity types — full list (65 options) available via get_milestone_field_options
// NOTE: This is a MultiSelectPicklist — values are comma-separated strings (e.g. "861980081,861980065")
const AZURE_CAPACITY_TYPES_COMMON = [
  { label: 'None', value: 861980000 },
  { label: 'Av2/Dv2/Dv3/Ev3/Dsv3/Esv3 (Intel) (Cores)', value: 861980037 },
  { label: 'Azure SQL Database (Cores or DTUs)', value: 861980065 },
  { label: 'Azure OpenAI Service', value: 861980081 },
  { label: 'Nd H100 V5 (Cores) (Future)', value: 861980080 },
  { label: 'Other', value: 861980032 }
];

/** Resolve a picklist numeric value to "Label (value)" for human-readable output.
 *  For multi-select (comma-separated codes), resolves each code individually. */
function resolvePicklistLabel(options, value) {
  if (value === undefined || value === null) return null;
  // Multi-select: comma-separated string of codes
  if (typeof value === 'string' && value.includes(',')) {
    return value.split(',').map(code => {
      const num = Number(code.trim());
      const match = options.find(o => o.value === num);
      return match ? `${match.label} (${num})` : String(num);
    }).join(', ');
  }
  const num = typeof value === 'string' ? Number(value) : value;
  const match = options.find(o => o.value === num);
  return match ? `${match.label} (${num})` : String(num);
}

/**
 * Resolve a picklist input that may be a numeric code or a human-readable label.
 * Returns the numeric code, or undefined if unresolvable.
 */
function resolveOptionValue(options, input) {
  if (input === undefined || input === null) return undefined;
  // Already a number — validate it exists
  if (typeof input === 'number') {
    return options.some(o => o.value === input) ? input : undefined;
  }
  // String: try numeric parse first
  const asNum = Number(input);
  if (!isNaN(asNum) && options.some(o => o.value === asNum)) return asNum;
  // String label match (case-insensitive)
  const match = options.find(o => o.label.toLowerCase() === String(input).toLowerCase().trim());
  return match ? match.value : undefined;
}

/** Map of CRM payload keys to their picklist arrays for resolution. */
const PICKLIST_MAP = {
  msp_milestoneworkload: WORKLOAD_TYPES,
  msp_deliveryspecifiedfield: DELIVERED_BY,
  msp_milestonepreferredazureregion: PREFERRED_AZURE_REGIONS_COMMON,
  msp_milestoneazurecapacitytype: AZURE_CAPACITY_TYPES_COMMON,
  msp_milestonestatus: MILESTONE_STATUSES,
  msp_commitmentrecommendation: COMMITMENT_RECOMMENDATIONS,
  msp_milestonecategory: MILESTONE_CATEGORIES
};

/** Resolve all picklist fields in a payload to human-readable labels.
 *  Non-picklist and lookup fields are passed through as-is. */
function resolvePayloadLabels(payload) {
  const resolved = {};
  for (const [key, value] of Object.entries(payload)) {
    const picklist = PICKLIST_MAP[key];
    if (picklist && value !== undefined && value !== null) {
      resolved[key] = resolvePicklistLabel(picklist, value);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/** Maximum records crm_query will return via auto-pagination. */
export const CRM_QUERY_MAX_RECORDS = 500;

const text = (content) => ({ content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }] });
const error = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

/** Build a Dynamics 365 deep-link URL to open a record in the browser. */
function buildRecordUrl(crmBaseUrl, entityLogicalName, guid) {
  if (!crmBaseUrl || !entityLogicalName || !guid) return undefined;
  return `${crmBaseUrl}/main.aspx?etn=${entityLogicalName}&id=${guid}&pagetype=entityrecord`;
}

function monthKey(dateValue) {
  if (!dateValue) return null;
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 7);
}

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function fv(record, field) {
  return record[`${field}@OData.Community.Display.V1.FormattedValue`] ?? null;
}

/** Returns ISO date string for (today - days). */
function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

const ACTIVE_STATUSES = new Set(['Not Started', 'On Track', 'In Progress', 'Blocked', 'At Risk']);

/** Derive human-readable commitment label from a milestone record. */
function commitmentLabel(m) {
  return m.msp_commitmentrecommendation === 861980001 ? 'Committed' : 'Uncommitted';
}

function buildMilestoneSummary(milestones, crmBaseUrl) {
  const byStatus = {};
  const byOpportunity = {};
  const byCommitment = { Committed: 0, Uncommitted: 0 };
  for (const m of milestones) {
    const status = fv(m, 'msp_milestonestatus') || 'Unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    const opp = fv(m, '_msp_opportunityid_value') || 'Unknown';
    byOpportunity[opp] = (byOpportunity[opp] || 0) + 1;
    byCommitment[commitmentLabel(m)] += 1;
  }
  return {
    count: milestones.length,
    byStatus,
    byCommitment,
    byOpportunity,
    milestones: milestones.map(m => ({
      ...m,
      status: fv(m, 'msp_milestonestatus'),
      commitment: commitmentLabel(m),
      opportunity: fv(m, '_msp_opportunityid_value'),
      recordUrl: buildRecordUrl(crmBaseUrl, 'msp_engagementmilestone', m.msp_engagementmilestoneid)
    }))
  };
}

async function applyTaskFilter(crmClient, milestones, mode) {
  if (!milestones.length) return milestones;
  const msIds = milestones.map(m => m.msp_engagementmilestoneid).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < msIds.length; i += 25) chunks.push(msIds.slice(i, i + 25));
  const taskMatches = new Set();
  for (const chunk of chunks) {
    const tf = chunk.map(id => `_regardingobjectid_value eq '${id}'`).join(' or ');
    const taskResult = await crmClient.requestAllPages('tasks', {
      query: { $filter: tf, $select: '_regardingobjectid_value' }
    });
    if (taskResult.ok && taskResult.data?.value) {
      for (const t of taskResult.data.value) taskMatches.add(t._regardingobjectid_value);
    }
  }
  if (mode === 'without-tasks') {
    return milestones.filter(m => !taskMatches.has(m.msp_engagementmilestoneid));
  }
  return milestones.filter(m => taskMatches.has(m.msp_engagementmilestoneid));
}

const INLINE_TASK_SELECT = 'activityid,subject,scheduledend,statuscode,statecode,_ownerid_value,description,msp_taskcategory,_regardingobjectid_value';

/** Fetch tasks for a list of milestone IDs and return them as a flat array. */
async function fetchTasksForMilestones(crmClient, msIds) {
  if (!msIds.length) return [];
  const chunks = [];
  for (let i = 0; i < msIds.length; i += 25) chunks.push(msIds.slice(i, i + 25));
  const allTasks = [];
  for (const chunk of chunks) {
    const tf = chunk.map(id => `_regardingobjectid_value eq '${id}'`).join(' or ');
    const taskResult = await crmClient.requestAllPages('tasks', {
      query: { $filter: tf, $select: INLINE_TASK_SELECT, $orderby: 'createdon desc' }
    });
    if (taskResult.ok && taskResult.data?.value) allTasks.push(...taskResult.data.value);
  }
  return allTasks;
}

/** Batch-fetch tasks and embed them as a `tasks` array on each milestone record. */
async function embedTasksOnMilestones(crmClient, milestones) {
  if (!milestones.length) return milestones;
  const msIds = milestones.map(m => m.msp_engagementmilestoneid).filter(Boolean);
  const allTasks = await fetchTasksForMilestones(crmClient, msIds);
  const byMilestone = {};
  for (const t of allTasks) {
    const msId = t._regardingobjectid_value;
    if (!byMilestone[msId]) byMilestone[msId] = [];
    byMilestone[msId].push(t);
  }
  return milestones.map(m => ({
    ...m,
    tasks: byMilestone[m.msp_engagementmilestoneid] || []
  }));
}

/**
 * Register all CRM tools on an McpServer instance.
 */
export function registerTools(server, crmClient) {
  /** Lazily get the CRM base URL for deep-link generation. */
  const getCrmBase = () => crmClient.getCrmUrl?.() || null;

  // ── crm_whoami ──────────────────────────────────────────────
  server.tool(
    'crm_whoami',
    'Validate CRM access and return the current user identity (UserId, name).',
    {},
    async () => {
      const result = await crmClient.request('WhoAmI');
      if (!result.ok) return error(`WhoAmI failed: ${result.data?.message || result.status}`);
      return text(result.data);
    }
  );

  // ── crm_query ───────────────────────────────────────────────
  server.tool(
    'crm_query',
    `Execute a read-only OData GET against an allowed Dynamics 365 entity set. Supports $filter, $select, $orderby, $top, $expand. Auto-paginates up to ${CRM_QUERY_MAX_RECORDS} records. Allowed entity sets: ${[...ALLOWED_ENTITY_SETS].join(', ')}.`,
    {
      entitySet: z.string().describe('Entity set name, e.g. "opportunities", "accounts", "msp_engagementmilestones"'),
      filter: z.string().optional().describe('OData $filter expression'),
      select: z.string().optional().describe('Comma-separated field names for $select'),
      orderby: z.string().optional().describe('OData $orderby expression'),
      top: z.number().optional().describe('Maximum number of records to return'),
      expand: z.string().optional().describe('OData $expand expression')
    },
    async ({ entitySet, filter, select, orderby, top, expand }) => {
      if (!entitySet) return error('entitySet is required');

      if (!isEntityAllowed(entitySet)) {
        auditLog({ tool: 'crm_query', entitySet, blocked: true, reason: 'entity not in allowlist' });
        return error(
          `Entity set "${entitySet}" is not in the allowed list. ` +
          `Permitted entity sets: ${[...ALLOWED_ENTITY_SETS].join(', ')}. ` +
          `If you need access to this entity, add it to ALLOWED_ENTITY_SETS in tools.js.`
        );
      }

      const query = {};
      if (filter) query.$filter = filter;
      if (select) query.$select = select;
      if (orderby) query.$orderby = orderby;
      if (top) query.$top = String(Math.min(top, CRM_QUERY_MAX_RECORDS));
      if (expand) query.$expand = expand;

      const result = await crmClient.requestAllPages(entitySet, { query, maxRecords: CRM_QUERY_MAX_RECORDS });
      if (!result.ok) return error(`Query failed (${result.status}): ${result.data?.message}`);

      const records = result.data?.value || (result.data ? [result.data] : []);
      auditLog({ tool: 'crm_query', entitySet, params: { filter, select, top }, recordCount: records.length });
      return text({ count: records.length, value: records });
    }
  );

  // ── crm_get_record ──────────────────────────────────────────
  server.tool(
    'crm_get_record',
    `Retrieve a single Dynamics 365 record by entity set and GUID. Allowed entity sets: ${[...ALLOWED_ENTITY_SETS].join(', ')}.`,
    {
      entitySet: z.string().describe('Entity set name, e.g. "opportunities", "accounts"'),
      id: z.string().describe('Record GUID'),
      select: z.string().optional().describe('Comma-separated field names for $select')
    },
    async ({ entitySet, id, select }) => {
      if (!entitySet) return error('entitySet is required');

      if (!isEntityAllowed(entitySet)) {
        auditLog({ tool: 'crm_get_record', entitySet, blocked: true, reason: 'entity not in allowlist' });
        return error(
          `Entity set "${entitySet}" is not in the allowed list. ` +
          `Permitted entity sets: ${[...ALLOWED_ENTITY_SETS].join(', ')}. ` +
          `If you need access to this entity, add it to ALLOWED_ENTITY_SETS in tools.js.`
        );
      }

      const normalized = normalizeGuid(id);
      if (!isValidGuid(normalized)) return error('Invalid GUID');
      const query = {};
      if (select) query.$select = select;
      const result = await crmClient.request(`${entitySet}(${normalized})`, { query });
      if (!result.ok) return error(`Get record failed (${result.status}): ${result.data?.message}`);
      auditLog({ tool: 'crm_get_record', entitySet, recordCount: 1 });
      return text(result.data);
    }
  );

  // ── list_opportunities ──────────────────────────────────────
  server.tool(
    'list_opportunities',
    'List open opportunities for one or more account IDs or by customer name keyword. Returns opportunity name, dates, owner, solution play.',
    {
      accountIds: z.array(z.string()).optional().describe('Array of Dynamics 365 account GUIDs'),
      customerKeyword: z.string().optional().describe('Customer name keyword — resolves matching accounts internally'),
      includeCompleted: z.boolean().optional().default(false).describe('Include opportunities past their estimated completion date (default: false)')
    },
    async ({ accountIds, customerKeyword, includeCompleted }) => {
      let resolvedIds = accountIds ? accountIds.map(normalizeGuid).filter(isValidGuid) : [];

      // Resolve customerKeyword → account GUIDs
      if (!resolvedIds.length && customerKeyword) {
        const sanitized = sanitizeODataString(customerKeyword.trim());
        const acctResult = await crmClient.requestAllPages('accounts', {
          query: { $filter: `contains(name,'${sanitized}')`, $select: 'accountid,name', $top: '50' }
        });
        const matchedAccounts = acctResult.ok ? (acctResult.data?.value || []) : [];
        if (!matchedAccounts.length) {
          return text({ count: 0, opportunities: [], matchedAccounts: [], message: `No accounts found matching '${customerKeyword}'` });
        }
        resolvedIds = matchedAccounts.map(a => a.accountid);
      }

      if (!resolvedIds.length) return error('Provide accountIds array or customerKeyword');

      // Chunk into groups of 25 to keep filter URL manageable
      const chunks = [];
      for (let i = 0; i < resolvedIds.length; i += 25) chunks.push(resolvedIds.slice(i, i + 25));

      const allOpps = [];
      for (const chunk of chunks) {
        let filter = `(${chunk.map(id => `_parentaccountid_value eq '${id}'`).join(' or ')}) and statecode eq 0`;
        if (!includeCompleted) {
          filter += ` and msp_estcompletiondate ge ${daysAgo(30)}`;
        }
        const result = await crmClient.requestAllPages('opportunities', {
          query: { $filter: filter, $select: OPP_SELECT, $orderby: 'name' }
        });
        if (result.ok && result.data?.value) allOpps.push(...result.data.value);
      }

      return text({ count: allOpps.length, opportunities: allOpps.map(o => ({ ...o, recordUrl: buildRecordUrl(getCrmBase(), 'opportunity', o.opportunityid) })) });
    }
  );

  // ── get_milestones ──────────────────────────────────────────
  server.tool(
    'get_milestones',
    'Get engagement milestones scoped by customer name, opportunity name/GUID, milestoneId, milestone number, or owner. Always requires a scoping parameter — never returns all milestones unscoped. Resolves customer/opportunity keywords to GUIDs internally — no need to call list_opportunities first. Supports batch opportunityIds, status/keyword filtering, task-presence filtering, and inline task embedding.',
    {
      customerKeyword: z.string().optional().describe('Customer name keyword — resolves accounts → opportunities → milestones in one call'),
      opportunityKeyword: z.string().optional().describe('Opportunity name keyword — resolves matching opportunities → milestones in one call'),
      opportunityId: z.string().optional().describe('Opportunity GUID to list milestones for'),
      opportunityIds: z.array(z.string()).optional().describe('Array of opportunity GUIDs for batch milestone retrieval'),
      milestoneNumber: z.string().optional().describe('Milestone number to search for, e.g. "7-123456789"'),
      milestoneId: z.string().optional().describe('Direct milestone GUID lookup'),
      ownerId: z.string().optional().describe('Owner system user GUID to list milestones for'),
      mine: z.boolean().optional().describe('When explicitly set to true, returns milestones owned by the authenticated CRM user. Must be set explicitly — does NOT default to true. Prefer customerKeyword, opportunityKeyword, or opportunityId for narrower scoping.'),
      statusFilter: z.enum(['active', 'all']).optional().describe('Filter by status: active = Not Started/On Track/Blocked/At Risk'),
      keyword: z.string().optional().describe('Case-insensitive keyword filter across milestone name, opportunity, and workload'),
      format: z.enum(['full', 'summary']).optional().describe('Response format: full (default) or summary (grouped compact output)'),
      taskFilter: z.enum(['all', 'with-tasks', 'without-tasks']).optional().describe('Filter milestones by task presence'),
      includeTasks: z.boolean().optional().describe('When true, embeds linked tasks inline on each milestone (avoids separate get_milestone_activities call). Default: false')
    },
    async ({ customerKeyword, opportunityKeyword, opportunityId, opportunityIds, milestoneNumber, milestoneId, ownerId, mine, statusFilter, keyword, format, taskFilter: taskFilterParam, includeTasks }) => {
      // Direct GUID lookup
      if (milestoneId) {
        const nid = normalizeGuid(milestoneId);
        if (!isValidGuid(nid)) return error('Invalid milestoneId GUID');
        const result = await crmClient.request(`msp_engagementmilestones(${nid})`, {
          query: { $select: MILESTONE_SELECT }
        });
        if (!result.ok) return error(`Milestone lookup failed (${result.status}): ${result.data?.message}`);
        const milestone = { ...result.data, commitment: commitmentLabel(result.data), recordUrl: buildRecordUrl(getCrmBase(), 'msp_engagementmilestone', nid) };
        if (includeTasks) {
          milestone.tasks = await fetchTasksForMilestones(crmClient, [nid]);
        }
        return text(milestone);
      }

      // Resolve customerKeyword → opportunity GUIDs
      let resolvedOppIds = null;
      if (customerKeyword) {
        const sanitized = sanitizeODataString(customerKeyword.trim());
        const acctResult = await crmClient.requestAllPages('accounts', {
          query: { $filter: `contains(name,'${sanitized}')`, $select: 'accountid,name', $top: '50' }
        });
        const accounts = acctResult.ok ? (acctResult.data?.value || []) : [];
        if (!accounts.length) {
          return text({ count: 0, milestones: [], message: `No accounts found matching '${customerKeyword}'` });
        }
        const acctIds = accounts.map(a => a.accountid);
        const cutoff = daysAgo(30);
        const acctChunks = [];
        for (let i = 0; i < acctIds.length; i += 25) acctChunks.push(acctIds.slice(i, i + 25));
        const allOpps = [];
        for (const chunk of acctChunks) {
          const acctFilter = `(${chunk.map(id => `_parentaccountid_value eq '${id}'`).join(' or ')}) and statecode eq 0 and msp_estcompletiondate ge ${cutoff}`;
          const oppResult = await crmClient.requestAllPages('opportunities', {
            query: { $filter: acctFilter, $select: 'opportunityid,name', $orderby: 'name' }
          });
          if (oppResult.ok && oppResult.data?.value) allOpps.push(...oppResult.data.value);
        }
        if (!allOpps.length) {
          return text({ count: 0, milestones: [], message: `No active opportunities found for customer '${customerKeyword}'` });
        }
        resolvedOppIds = allOpps.map(o => o.opportunityid);
      }

      // Resolve opportunityKeyword → opportunity GUIDs
      if (!resolvedOppIds && opportunityKeyword) {
        const sanitized = sanitizeODataString(opportunityKeyword.trim());
        const cutoff = daysAgo(30);
        const oppResult = await crmClient.requestAllPages('opportunities', {
          query: {
            $filter: `contains(name,'${sanitized}') and statecode eq 0 and msp_estcompletiondate ge ${cutoff}`,
            $select: 'opportunityid,name',
            $orderby: 'name',
            $top: '50'
          }
        });
        const opps = oppResult.ok ? (oppResult.data?.value || []) : [];
        if (!opps.length) {
          return text({ count: 0, milestones: [], message: `No active opportunities found matching '${opportunityKeyword}'` });
        }
        resolvedOppIds = opps.map(o => o.opportunityid);
      }

      // If keyword resolution produced opportunity IDs, merge with explicit opportunityIds
      if (resolvedOppIds) {
        const merged = resolvedOppIds;
        if (opportunityIds?.length) merged.push(...opportunityIds);
        if (opportunityId) merged.push(opportunityId);
        opportunityIds = merged;
        opportunityId = undefined;
      }

      let filter;
      if (milestoneNumber) {
        const sanitized = sanitizeODataString(milestoneNumber.trim());
        filter = `msp_milestonenumber eq '${sanitized}'`;
      } else if (opportunityIds?.length) {
        const validIds = opportunityIds.map(normalizeGuid).filter(isValidGuid);
        if (!validIds.length) return error('No valid opportunity GUIDs in opportunityIds');
        const chunks = [];
        for (let i = 0; i < validIds.length; i += 25) chunks.push(validIds.slice(i, i + 25));
        const allMilestones = [];
        for (const chunk of chunks) {
          const chunkFilter = chunk.map(id => `_msp_opportunityid_value eq '${id}'`).join(' or ');
          const chunkResult = await crmClient.requestAllPages('msp_engagementmilestones', {
            query: { $filter: chunkFilter, $select: MILESTONE_SELECT, $orderby: 'msp_milestonedate' }
          });
          if (chunkResult.ok && chunkResult.data?.value) allMilestones.push(...chunkResult.data.value);
        }
        let milestones = allMilestones;
        if (statusFilter === 'active') {
          milestones = milestones.filter(m => ACTIVE_STATUSES.has(fv(m, 'msp_milestonestatus')));
        }
        if (keyword) {
          const kw = keyword.toLowerCase();
          milestones = milestones.filter(m =>
            (m.msp_name || '').toLowerCase().includes(kw) ||
            (fv(m, '_msp_opportunityid_value') || '').toLowerCase().includes(kw) ||
            (fv(m, '_msp_workloadlkid_value') || '').toLowerCase().includes(kw)
          );
        }
        if (taskFilterParam && taskFilterParam !== 'all') {
          milestones = await applyTaskFilter(crmClient, milestones, taskFilterParam);
        }
        if (includeTasks) {
          milestones = await embedTasksOnMilestones(crmClient, milestones);
        }
        if (format === 'summary') return text(buildMilestoneSummary(milestones, getCrmBase()));
        return text({ count: milestones.length, milestones: milestones.map(m => ({ ...m, commitment: commitmentLabel(m), recordUrl: buildRecordUrl(getCrmBase(), 'msp_engagementmilestone', m.msp_engagementmilestoneid) })) });
      } else if (opportunityId) {
        const nid = normalizeGuid(opportunityId);
        if (!isValidGuid(nid)) return error('Invalid opportunityId GUID');
        filter = `_msp_opportunityid_value eq '${nid}'`;
      } else if (ownerId) {
        const nid = normalizeGuid(ownerId);
        if (!isValidGuid(nid)) return error('Invalid ownerId GUID');
        filter = `_ownerid_value eq '${nid}'`;
      } else if (mine === true) {
        const whoAmI = await crmClient.request('WhoAmI');
        if (!whoAmI.ok || !whoAmI.data?.UserId) {
          return error(`Unable to resolve current CRM user for milestone lookup (${whoAmI.status}): ${whoAmI.data?.message || 'WhoAmI failed'}`);
        }
        const nid = normalizeGuid(whoAmI.data.UserId);
        filter = `_ownerid_value eq '${nid}'`;
      } else {
        return error('Scoping required: provide customerKeyword, opportunityKeyword, opportunityId, opportunityIds, milestoneNumber, milestoneId, ownerId, or mine=true. Unscoped milestone queries are not allowed.');
      }

      const result = await crmClient.requestAllPages('msp_engagementmilestones', {
        query: { $filter: filter, $select: MILESTONE_SELECT, $orderby: 'msp_milestonedate' }
      });
      if (!result.ok) return error(`Get milestones failed (${result.status}): ${result.data?.message}`);
      let milestones = result.data?.value || [];

      // Post-query filters
      if (statusFilter === 'active') {
        milestones = milestones.filter(m => ACTIVE_STATUSES.has(fv(m, 'msp_milestonestatus')));
      }
      if (keyword) {
        const kw = keyword.toLowerCase();
        milestones = milestones.filter(m =>
          (m.msp_name || '').toLowerCase().includes(kw) ||
          (fv(m, '_msp_opportunityid_value') || '').toLowerCase().includes(kw) ||
          (fv(m, '_msp_workloadlkid_value') || '').toLowerCase().includes(kw)
        );
      }
      if (taskFilterParam && taskFilterParam !== 'all') {
        milestones = await applyTaskFilter(crmClient, milestones, taskFilterParam);
      }
      if (includeTasks) {
        milestones = await embedTasksOnMilestones(crmClient, milestones);
      }
      if (format === 'summary') return text(buildMilestoneSummary(milestones, getCrmBase()));
      return text({ count: milestones.length, milestones: milestones.map(m => ({ ...m, commitment: commitmentLabel(m), recordUrl: buildRecordUrl(getCrmBase(), 'msp_engagementmilestone', m.msp_engagementmilestoneid) })) });
    }
  );

  // ── get_my_active_opportunities ─────────────────────────────
  server.tool(
    'get_my_active_opportunities',
    'Returns active opportunities where you are the owner or on the deal team (via msp_dealteams entity). Falls back to milestone-ownership heuristic if msp_dealteams is unavailable. Optionally filter by customer name.',
    {
      customerKeyword: z.string().optional().describe('Case-insensitive customer name filter')
    },
    async ({ customerKeyword }) => {
      const whoAmI = await crmClient.request('WhoAmI');
      if (!whoAmI.ok || !whoAmI.data?.UserId) {
        return error(`Unable to resolve current CRM user (${whoAmI.status}): ${whoAmI.data?.message || 'WhoAmI failed'}`);
      }
      const userId = normalizeGuid(whoAmI.data.UserId);

      // 1. Owned opportunities (exclude completion dates > 30 days ago)
      const cutoff = daysAgo(30);
      const ownedResult = await crmClient.requestAllPages('opportunities', {
        query: { $filter: `_ownerid_value eq '${userId}' and statecode eq 0 and msp_estcompletiondate ge ${cutoff}`, $select: OPP_SELECT, $orderby: 'name' }
      });
      const ownedOpps = (ownedResult.ok ? ownedResult.data?.value : []) || [];
      const ownedIds = new Set(ownedOpps.map(o => o.opportunityid));

      // 2. Discover deal-team opps via explicit deal-team membership
      const dealTeamOppIds = [];
      const dealTeamResult = await crmClient.requestAllPages('msp_dealteams', {
        query: {
          $filter: `_msp_dealteamuserid_value eq '${userId}' and statecode eq 0`,
          $select: '_msp_parentopportunityid_value'
        }
      });

      if (dealTeamResult.ok && dealTeamResult.data?.value) {
        for (const row of dealTeamResult.data.value) {
          const oppId = row._msp_parentopportunityid_value;
          if (oppId && !ownedIds.has(oppId) && !dealTeamOppIds.includes(oppId)) dealTeamOppIds.push(oppId);
        }
      } else {
        // Fallback: infer deal-team involvement via milestone ownership
        const msResult = await crmClient.requestAllPages('msp_engagementmilestones', {
          query: { $filter: `_ownerid_value eq '${userId}'`, $select: '_msp_opportunityid_value' }
        });
        if (msResult.ok && msResult.data?.value) {
          for (const m of msResult.data.value) {
            const oppId = m._msp_opportunityid_value;
            if (oppId && !ownedIds.has(oppId) && !dealTeamOppIds.includes(oppId)) dealTeamOppIds.push(oppId);
          }
        }
      }

      // 3. Fetch deal-team opportunities
      let dealTeamOpps = [];
      if (dealTeamOppIds.length) {
        const dtFilter = dealTeamOppIds.map(id => `opportunityid eq '${id}'`).join(' or ');
        const dtResult = await crmClient.requestAllPages('opportunities', {
          query: { $filter: `(${dtFilter}) and statecode eq 0 and msp_estcompletiondate ge ${cutoff}`, $select: OPP_SELECT, $orderby: 'name' }
        });
        if (dtResult.ok && dtResult.data?.value) dealTeamOpps = dtResult.data.value;
      }

      // 4. Combine and tag
      const base = getCrmBase();
      let opportunities = [
        ...ownedOpps.map(o => ({
          ...o,
          customer: fv(o, '_parentaccountid_value') || null,
          relationship: 'owner',
          recordUrl: buildRecordUrl(base, 'opportunity', o.opportunityid)
        })),
        ...dealTeamOpps.map(o => ({
          ...o,
          customer: fv(o, '_parentaccountid_value') || null,
          relationship: 'deal-team',
          recordUrl: buildRecordUrl(base, 'opportunity', o.opportunityid)
        }))
      ];

      // 5. Filter by customerKeyword
      if (customerKeyword) {
        const kw = customerKeyword.toLowerCase();
        opportunities = opportunities.filter(o => (o.customer || '').toLowerCase().includes(kw));
      }

      return text({ count: opportunities.length, opportunities });
    }
  );

  // ── create_milestone ───────────────────────────────────────
  server.tool(
    'create_milestone',
    'Create an engagement milestone linked to an opportunity. Supports date, monthly use, status, category, commitment, owner, workload, comments, workload type, delivered by, preferred Azure region, and Azure capacity type.',
    {
      opportunityId: z.string().describe('Opportunity GUID to link the milestone to'),
      name: z.string().describe('Milestone name/title'),
      milestoneDate: z.string().describe('Required. Milestone date in YYYY-MM-DD format'),
      monthlyUse: z.number().describe('Required. Monthly use value'),
      milestoneCategory: z.number().describe(`Required. Milestone category: ${MILESTONE_CATEGORIES.map(o => `${o.value}=${o.label}`).join(', ')}`),
      commitmentRecommendation: z.number().optional().describe(`Commitment recommendation: ${COMMITMENT_RECOMMENDATIONS.map(o => `${o.value}=${o.label}`).join(', ')}`),
      milestoneStatus: z.union([z.number(), z.string()]).optional().describe(`Milestone status (name or code): ${MILESTONE_STATUSES.map(o => `${o.label}=${o.value}`).join(', ')}`),
      workloadId: z.string().describe('Required. Workload GUID (lookup) — use _msp_workloadlkid_value from an existing milestone on the same opportunity, or query msp_workloads by msp_name'),
      ownerId: z.string().optional().describe('System user GUID to assign as owner. Defaults to current user if omitted'),
      transactionCurrencyId: z.string().optional().describe('Transaction currency GUID'),
      forecastComments: z.string().optional().describe('Forecast comments text'),
      workloadType: z.number().optional().describe(`Required for milestone view. Workload Type: ${WORKLOAD_TYPES.map(o => `${o.value}=${o.label}`).join(', ')}.`),
      deliveredBy: z.number().optional().describe(`Required for milestone view. Delivered By: ${DELIVERED_BY.map(o => `${o.value}=${o.label}`).join(', ')}.`),
      preferredAzureRegion: z.number().optional().describe(`Required for milestone view. Preferred Azure Region. Common values: ${PREFERRED_AZURE_REGIONS_COMMON.map(o => `${o.value}=${o.label}`).join(', ')}. Use get_milestone_field_options(field:"preferredAzureRegion") for the full list of 75 regions.`),
      azureCapacityType: z.string().optional().describe(`Required for milestone view. Azure Capacity Type (MultiSelectPicklist — pass comma-separated codes for multiple, e.g. "861980081,861980065"). Common values: ${AZURE_CAPACITY_TYPES_COMMON.map(o => `${o.value}=${o.label}`).join(', ')}. Use get_milestone_field_options(field:"azureCapacityType") for the full list of 65 types.`)
    },
    async ({
      opportunityId,
      name,
      milestoneDate,
      monthlyUse,
      milestoneCategory,
      commitmentRecommendation,
      milestoneStatus,
      workloadId,
      ownerId,
      transactionCurrencyId,
      forecastComments,
      workloadType,
      deliveredBy,
      preferredAzureRegion,
      azureCapacityType
    }) => {
      const oppNid = normalizeGuid(opportunityId);
      if (!isValidGuid(oppNid)) return error('Invalid opportunityId GUID');
      if (!name) return error('name is required');

      // Validate required fields — must be explicitly provided
      const missingViewFields = [];
      if (!milestoneDate) missingViewFields.push('milestoneDate');
      if (monthlyUse === undefined) missingViewFields.push('monthlyUse');
      if (milestoneCategory === undefined) missingViewFields.push('milestoneCategory');
      if (!workloadId) missingViewFields.push('workloadId');
      if (workloadType === undefined) missingViewFields.push('workloadType');
      if (deliveredBy === undefined) missingViewFields.push('deliveredBy');
      if (preferredAzureRegion === undefined) missingViewFields.push('preferredAzureRegion');
      if (azureCapacityType === undefined) missingViewFields.push('azureCapacityType');
      if (missingViewFields.length) {
        const fieldHints = {
          milestoneDate: 'YYYY-MM-DD format',
          monthlyUse: 'numeric value (e.g. 1000)',
          milestoneCategory: '861980002=Production, 861980000=POC/Pilot',
          workloadId: 'Workload GUID — use _msp_workloadlkid_value from an existing milestone on the same opportunity, or query msp_workloads by msp_name',
          workloadType: WORKLOAD_TYPES.map(o => `${o.value}=${o.label}`).join(', '),
          deliveredBy: DELIVERED_BY.map(o => `${o.value}=${o.label}`).join(', '),
          preferredAzureRegion: PREFERRED_AZURE_REGIONS_COMMON.map(o => `${o.value}=${o.label}`).join(', ') + ' (common — use get_milestone_field_options for full list)',
          azureCapacityType: AZURE_CAPACITY_TYPES_COMMON.map(o => `${o.value}=${o.label}`).join(', ') + ' (common — use get_milestone_field_options for full list)'
        };
        const details = missingViewFields.map(f => `  - ${f}: ${fieldHints[f]}`).join('\n');
        return error(
          `Missing required milestone view fields: ${missingViewFields.join(', ')}. ` +
          'These fields are mandatory for the milestone to display correctly in the opportunity milestone view.\n' +
          'Available values:\n' + details
        );
      }

      const oppLookup = await crmClient.request(`opportunities(${oppNid})`, {
        query: { $select: 'name' }
      });
      if (!oppLookup.ok) {
        return error(`Opportunity lookup failed (${oppLookup.status}): ${oppLookup.data?.message || 'not found'}`);
      }
      const opportunityName = oppLookup.data?.name || null;

      const payload = {
        msp_name: name,
        'msp_OpportunityId@odata.bind': `/opportunities(${oppNid})`
      };

      // Required fields — validated above, always present
      payload.msp_milestonedate = milestoneDate;
      payload.msp_monthlyuse = monthlyUse;
      payload.msp_milestonecategory = milestoneCategory;

      if (commitmentRecommendation !== undefined) payload.msp_commitmentrecommendation = commitmentRecommendation;
      if (milestoneStatus !== undefined) {
        const resolved = resolveOptionValue(MILESTONE_STATUSES, milestoneStatus);
        if (resolved === undefined) return error(`Invalid milestoneStatus "${milestoneStatus}". Valid: ${MILESTONE_STATUSES.map(o => `${o.label} (${o.value})`).join(', ')}`);
        payload.msp_milestonestatus = resolved;
      }
      if (forecastComments !== undefined) payload.msp_forecastcomments = forecastComments;

      // Required milestone view fields — validated above, always present
      payload.msp_milestoneworkload = workloadType;
      payload.msp_deliveryspecifiedfield = deliveredBy;
      payload.msp_milestonepreferredazureregion = preferredAzureRegion;
      payload.msp_milestoneazurecapacitytype = azureCapacityType;

      const workloadNid = normalizeGuid(workloadId);
      if (!isValidGuid(workloadNid)) return error('Invalid workloadId GUID');
      payload['msp_WorkloadlkId@odata.bind'] = `/msp_workloads(${workloadNid})`;

      if (ownerId) {
        const ownerNid = normalizeGuid(ownerId);
        if (!isValidGuid(ownerNid)) return error('Invalid ownerId GUID');
        payload['ownerid@odata.bind'] = `/systemusers(${ownerNid})`;
      }

      if (transactionCurrencyId) {
        const currencyNid = normalizeGuid(transactionCurrencyId);
        if (!isValidGuid(currencyNid)) return error('Invalid transactionCurrencyId GUID');
        payload['transactioncurrencyid@odata.bind'] = `/transactioncurrencies(${currencyNid})`;
      }

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'create_milestone',
        entitySet: 'msp_engagementmilestones',
        method: 'POST',
        payload,
        beforeState: null,
        description: `Create milestone "${name}" on opportunity ${opportunityName || oppNid}`
      });

      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        identity: {
          opportunityId: oppNid,
          opportunityName
        },
        fieldSummary: resolvePayloadLabels(payload),
        payload,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`
      });
    }
  );

  // ── create_task ─────────────────────────────────────────────
  server.tool(
    'create_task',
    'Create a task linked to an engagement milestone. Optionally specify category, subject, due date, and owner.',
    {
      milestoneId: z.string().describe('Engagement milestone GUID to link the task to'),
      subject: z.string().describe('Task subject/title'),
      category: z.number().optional().describe(`Task category code. Valid values: ${TASK_CATEGORIES.map(c => `${c.value} (${c.label})`).join(', ')}`),
      dueDate: z.string().optional().describe('Due date in YYYY-MM-DD format'),
      ownerId: z.string().optional().describe('System user GUID to assign as owner'),
      description: z.string().optional().describe('Task description')
    },
    async ({ milestoneId, subject, category, dueDate, ownerId, description }) => {
      const nid = normalizeGuid(milestoneId);
      if (!isValidGuid(nid)) return error('Invalid milestoneId GUID');
      if (!subject) return error('subject is required');

      const payload = {
        subject,
        'regardingobjectid_msp_engagementmilestone@odata.bind': `/msp_engagementmilestones(${nid})`
      };
      if (category !== undefined) payload.msp_taskcategory = category;
      if (dueDate) payload.scheduledend = dueDate;
      if (description) payload.description = description;
      if (ownerId) {
        const ownerNid = normalizeGuid(ownerId);
        if (!isValidGuid(ownerNid)) return error('Invalid ownerId GUID');
        payload['ownerid@odata.bind'] = `/systemusers(${ownerNid})`;
      }

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'create_task',
        entitySet: 'tasks',
        method: 'POST',
        payload,
        beforeState: null,
        description: `Create task "${subject}" on milestone ${nid}`
      });
      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        payload,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`
      });
    }
  );

  // ── update_task ─────────────────────────────────────────────
  server.tool(
    'update_task',
    'Update fields on an existing task (subject, due date, description, status).',
    {
      taskId: z.string().describe('Task GUID'),
      subject: z.string().optional().describe('New subject'),
      dueDate: z.string().optional().describe('New due date YYYY-MM-DD'),
      description: z.string().optional().describe('New description'),
      statusCode: z.number().optional().describe('New status code')
    },
    async ({ taskId, subject, dueDate, description, statusCode }) => {
      const nid = normalizeGuid(taskId);
      if (!isValidGuid(nid)) return error('Invalid taskId GUID');
      const payload = {};
      if (subject !== undefined) payload.subject = subject;
      if (dueDate !== undefined) payload.scheduledend = dueDate;
      if (description !== undefined) payload.description = description;
      if (statusCode !== undefined) payload.statuscode = statusCode;
      if (Object.keys(payload).length === 0) return error('No fields to update');

      // Fetch before-state for diff preview
      const before = await crmClient.request(`tasks(${nid})`, {
        query: { $select: Object.keys(payload).join(',') }
      });

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_task',
        entitySet: `tasks(${nid})`,
        method: 'PATCH',
        payload,
        beforeState: before.ok ? before.data : null,
        description: `Update task ${nid}: ${Object.keys(payload).join(', ')}`
      });
      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        before: op.beforeState,
        after: payload,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`
      });
    }
  );

  // ── close_task ──────────────────────────────────────────────
  server.tool(
    'close_task',
    'Close a task using the CloseTask action (with fallback to bound Close endpoint).',
    {
      taskId: z.string().describe('Task GUID'),
      statusCode: z.number().describe('Status code for the closure (e.g. 5 = Completed, 6 = Cancelled)'),
      subject: z.string().optional().describe('Close subject (defaults to "Task Closed")')
    },
    async ({ taskId, statusCode, subject }) => {
      const nid = normalizeGuid(taskId);
      if (!isValidGuid(nid)) return error('Invalid taskId GUID');
      if (statusCode === undefined) return error('statusCode is required');

      // Fetch before-state
      const before = await crmClient.request(`tasks(${nid})`, {
        query: { $select: 'subject,statuscode,statecode' }
      });

      // Stage with CloseTask action as primary strategy
      const closePayload = {
        TaskClose: {
          subject: subject || 'Task Closed',
          'activityid@odata.bind': `/tasks(${nid})`
        },
        Status: statusCode
      };

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'close_task',
        entitySet: 'CloseTask',
        method: 'POST',
        payload: closePayload,
        beforeState: before.ok ? before.data : null,
        description: `Close task ${nid} with status ${statusCode}`
      });
      // Attach fallback info for executor
      op.fallbackEntitySet = `tasks(${nid})/Microsoft.Dynamics.CRM.Close`;
      op.fallbackPayload = { Status: statusCode };

      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        before: op.beforeState,
        statusCode,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`
      });
    }
  );

  // ── update_milestone ────────────────────────────────────────
  server.tool(
    'update_milestone',
    'Update fields on an engagement milestone. Only fields you provide will be changed — all other fields are preserved. Supports name, date, monthly use, status, category, commitment, workload, owner, currency, comments, workload type, delivered by, preferred Azure region, and Azure capacity type.',
    {
      milestoneId: z.string().describe('Engagement milestone GUID'),
      name: z.string().optional().describe('New milestone name/title (cannot be empty)'),
      milestoneDate: z.string().optional().describe('New milestone date YYYY-MM-DD'),
      monthlyUse: z.number().optional().describe('New monthly use value'),
      milestoneCategory: z.number().optional().describe(`Milestone category: ${MILESTONE_CATEGORIES.map(o => `${o.value}=${o.label}`).join(', ')}`),
      commitmentRecommendation: z.number().optional().describe(`Commitment recommendation: ${COMMITMENT_RECOMMENDATIONS.map(o => `${o.value}=${o.label}`).join(', ')}`),
      milestoneStatus: z.union([z.number(), z.string()]).optional().describe(`Milestone status (name or code): ${MILESTONE_STATUSES.map(o => `${o.label}=${o.value}`).join(', ')}`),
      workloadId: z.string().optional().describe('New workload GUID (use null to clear)'),
      ownerId: z.string().optional().describe('New owner system user GUID'),
      transactionCurrencyId: z.string().optional().describe('New transaction currency GUID'),
      forecastComments: z.string().optional().describe('Forecast comments text'),
      workloadType: z.number().optional().describe(`Workload Type: ${WORKLOAD_TYPES.map(o => `${o.value}=${o.label}`).join(', ')}`),
      deliveredBy: z.number().optional().describe(`Delivered By: ${DELIVERED_BY.map(o => `${o.value}=${o.label}`).join(', ')}`),
      preferredAzureRegion: z.number().optional().describe(`Preferred Azure Region. Common: ${PREFERRED_AZURE_REGIONS_COMMON.map(o => `${o.value}=${o.label}`).join(', ')}. Full list via get_milestone_field_options.`),
      azureCapacityType: z.string().optional().describe(`Azure Capacity Type (MultiSelectPicklist — comma-separated codes). Common: ${AZURE_CAPACITY_TYPES_COMMON.map(o => `${o.value}=${o.label}`).join(', ')}. Full list via get_milestone_field_options.`)
    },
    async ({ milestoneId, name, milestoneDate, monthlyUse, milestoneCategory, commitmentRecommendation, milestoneStatus, workloadId, ownerId, transactionCurrencyId, forecastComments, workloadType, deliveredBy, preferredAzureRegion, azureCapacityType }) => {
      const nid = normalizeGuid(milestoneId);
      if (!isValidGuid(nid)) return error('Invalid milestoneId GUID');

      // Guard: name must not be blanked
      if (name !== undefined && !name.trim()) return error('name cannot be empty — omit the field to keep the existing name');

      const payload = {};
      if (name !== undefined) payload.msp_name = name;
      if (milestoneDate !== undefined) payload.msp_milestonedate = milestoneDate;
      if (monthlyUse !== undefined) payload.msp_monthlyuse = monthlyUse;
      if (milestoneCategory !== undefined) payload.msp_milestonecategory = milestoneCategory;
      if (commitmentRecommendation !== undefined) payload.msp_commitmentrecommendation = commitmentRecommendation;
      if (milestoneStatus !== undefined) {
        const resolved = resolveOptionValue(MILESTONE_STATUSES, milestoneStatus);
        if (resolved === undefined) return error(`Invalid milestoneStatus "${milestoneStatus}". Valid: ${MILESTONE_STATUSES.map(o => `${o.label} (${o.value})`).join(', ')}`);
        payload.msp_milestonestatus = resolved;
      }
      if (forecastComments !== undefined) payload.msp_forecastcomments = forecastComments;
      if (workloadType !== undefined) payload.msp_milestoneworkload = workloadType;
      if (deliveredBy !== undefined) payload.msp_deliveryspecifiedfield = deliveredBy;
      if (preferredAzureRegion !== undefined) payload.msp_milestonepreferredazureregion = preferredAzureRegion;
      if (azureCapacityType !== undefined) payload.msp_milestoneazurecapacitytype = azureCapacityType;

      if (workloadId !== undefined) {
        if (workloadId) {
          const workloadNid = normalizeGuid(workloadId);
          if (!isValidGuid(workloadNid)) return error('Invalid workloadId GUID');
          payload['msp_WorkloadlkId@odata.bind'] = `/msp_workloads(${workloadNid})`;
        } else {
          payload['msp_WorkloadlkId@odata.bind'] = null;
        }
      }

      if (ownerId !== undefined) {
        const ownerNid = normalizeGuid(ownerId);
        if (!isValidGuid(ownerNid)) return error('Invalid ownerId GUID');
        payload['ownerid@odata.bind'] = `/systemusers(${ownerNid})`;
      }

      if (transactionCurrencyId !== undefined) {
        const currencyNid = normalizeGuid(transactionCurrencyId);
        if (!isValidGuid(currencyNid)) return error('Invalid transactionCurrencyId GUID');
        payload['transactioncurrencyid@odata.bind'] = `/transactioncurrencies(${currencyNid})`;
      }

      if (Object.keys(payload).length === 0) return error('No fields to update');

      // Fetch full milestone record for identity verification + before-state
      const fullRecord = await crmClient.request(`msp_engagementmilestones(${nid})`, {
        query: { $select: MILESTONE_SELECT }
      });
      if (!fullRecord.ok) {
        return error(`Milestone ${nid} not found or inaccessible (${fullRecord.status}): ${fullRecord.data?.message || 'lookup failed'}`);
      }

      const record = fullRecord.data;
      const milestoneNumber = record.msp_milestonenumber || null;
      const milestoneName = record.msp_name || null;
      const milestoneOppId = record._msp_opportunityid_value || null;
      const milestoneOwnerId = record._ownerid_value || null;
      const opportunityName = fv(record, '_msp_opportunityid_value') || null;

      // Ownership verification: ensure current user owns milestone or is on deal team
      const whoAmI = await crmClient.request('WhoAmI');
      if (whoAmI.ok && whoAmI.data?.UserId) {
        const currentUserId = normalizeGuid(whoAmI.data.UserId);
        const isOwner = milestoneOwnerId && normalizeGuid(milestoneOwnerId) === currentUserId;

        if (!isOwner && milestoneOppId) {
          // Check if user owns the opportunity or any milestones under it
          const oppResult = await crmClient.request(`opportunities(${normalizeGuid(milestoneOppId)})`, {
            query: { $select: '_ownerid_value' }
          });
          const oppOwnerId = oppResult.ok ? normalizeGuid(oppResult.data?._ownerid_value || '') : '';
          const isOppOwner = oppOwnerId === currentUserId;

          if (!isOppOwner) {
            const teamCheck = await crmClient.requestAllPages('msp_engagementmilestones', {
              query: {
                $filter: `_msp_opportunityid_value eq '${normalizeGuid(milestoneOppId)}' and _ownerid_value eq '${currentUserId}'`,
                $select: 'msp_engagementmilestoneid',
                $top: '1'
              }
            });
            const isOnDealTeam = teamCheck.ok && teamCheck.data?.value?.length > 0;
            if (!isOnDealTeam) {
              return error(
                `Ownership check failed: milestone ${milestoneNumber || nid} ("${milestoneName || 'unknown'}") ` +
                `under opportunity "${opportunityName || milestoneOppId}" is not owned by you and you are not on the deal team. ` +
                `Verify you have the correct milestone ID.`
              );
            }
          }
        } else if (!isOwner && !milestoneOppId) {
          return error(
            `Ownership check failed: milestone ${milestoneNumber || nid} is not owned by you ` +
            `and has no linked opportunity for deal-team verification.`
          );
        }
      }

      // Build before-state limited to fields being changed
      const before = {};
      for (const key of Object.keys(payload)) {
        before[key] = record[key] ?? null;
      }

      // Identity metadata for pre-execution verification
      const identity = {
        milestoneNumber,
        milestoneName,
        opportunityId: milestoneOppId,
        opportunityName,
      };

      const humanDesc = `Update milestone ${milestoneNumber || nid}` +
        (milestoneName ? ` ("${milestoneName}")` : '') +
        (opportunityName ? ` on "${opportunityName}"` : '') +
        `: ${Object.keys(payload).join(', ')}`;

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_milestone',
        entitySet: `msp_engagementmilestones(${nid})`,
        method: 'PATCH',
        payload,
        beforeState: before,
        description: humanDesc
      });
      // Attach identity for execution-time re-verification
      op.identity = identity;

      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        identity,
        before: resolvePayloadLabels(before),
        after: resolvePayloadLabels(payload),
        payload,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`
      });
    }
  );

  // ── list_accounts_by_tpid ───────────────────────────────────
  server.tool(
    'list_accounts_by_tpid',
    'Find accounts by MS Top Parent ID (TPID). Returns account GUIDs and names.',
    {
      tpids: z.array(z.string()).describe('Array of TPID values (numeric strings)')
    },
    async ({ tpids }) => {
      if (!tpids?.length) return error('At least one TPID is required');
      const valid = tpids.filter(isValidTpid);
      if (!valid.length) return error('No valid TPIDs provided');

      const filter = valid.map(t => `msp_mstopparentid eq '${sanitizeODataString(t)}'`).join(' or ');
      const result = await crmClient.requestAllPages('accounts', {
        query: {
          $filter: filter,
          $select: 'accountid,name,msp_mstopparentid',
          $orderby: 'name'
        }
      });
      if (!result.ok) return error(`Account lookup failed (${result.status}): ${result.data?.message}`);
      const accounts = result.data?.value || [];
      return text({ count: accounts.length, accounts });
    }
  );

  // ── get_milestone_field_options ─────────────────────────────
  server.tool(
    'get_milestone_field_options',
    'Retrieve available picklist options for milestone fields from Dynamics 365 metadata. Use before create_milestone to discover valid values for required fields.',
    {
      field: z.enum(['workloadType', 'deliveredBy', 'preferredAzureRegion', 'azureCapacityType']).describe('Which milestone picklist field to retrieve options for')
    },
    async ({ field }) => {
      const fieldMap = {
        workloadType: 'msp_milestoneworkload',
        deliveredBy: 'msp_deliveryspecifiedfield',
        preferredAzureRegion: 'msp_milestonepreferredazureregion',
        azureCapacityType: 'msp_milestoneazurecapacitytype'
      };
      const logicalName = fieldMap[field];
      const result = await crmClient.request(
        `EntityDefinitions(LogicalName='msp_engagementmilestone')/Attributes(LogicalName='${logicalName}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata`,
        { query: { $select: 'LogicalName', $expand: 'OptionSet($select=Options)' } }
      );
      if (!result.ok) return error(`Metadata query failed (${result.status}): ${result.data?.message}`);

      const options = result.data?.OptionSet?.Options || [];
      const parsed = options
        .map(o => ({
          value: o?.Value,
          label: o?.Label?.UserLocalizedLabel?.Label || o?.Label?.LocalizedLabels?.[0]?.Label || ''
        }))
        .filter(o => Number.isInteger(o.value) && o.label);
      return text({ field, logicalName, options: parsed });
    }
  );

  // ── get_task_status_options ─────────────────────────────────
  server.tool(
    'get_task_status_options',
    'Retrieve available task status/statuscode options from Dynamics 365 metadata.',
    {},
    async () => {
      const result = await crmClient.request(
        "EntityDefinitions(LogicalName='task')/Attributes(LogicalName='statuscode')/Microsoft.Dynamics.CRM.StatusAttributeMetadata",
        { query: { $select: 'LogicalName', $expand: 'OptionSet($select=Options)' } }
      );
      if (!result.ok) return error(`Metadata query failed (${result.status}): ${result.data?.message}`);

      const options = result.data?.OptionSet?.Options || [];
      const parsed = options
        .map(o => ({
          value: o?.Value,
          label: o?.Label?.UserLocalizedLabel?.Label || o?.Label?.LocalizedLabels?.[0]?.Label || '',
          stateCode: o?.State
        }))
        .filter(o => Number.isInteger(o.value) && o.label);
      return text(parsed);
    }
  );

  // ── get_milestone_activities ────────────────────────────────
  server.tool(
    'get_milestone_activities',
    'List tasks/activities linked to one or more engagement milestones. Supports batch retrieval via milestoneIds array.',
    {
      milestoneId: z.string().optional().describe('Single engagement milestone GUID'),
      milestoneIds: z.array(z.string()).optional().describe('Array of milestone GUIDs for batch retrieval')
    },
    async ({ milestoneId, milestoneIds }) => {
      // Batch mode
      if (milestoneIds?.length) {
        const validIds = milestoneIds.map(normalizeGuid).filter(isValidGuid);
        if (!validIds.length) return error('No valid milestone GUIDs in milestoneIds');
        const chunks = [];
        for (let i = 0; i < validIds.length; i += 25) chunks.push(validIds.slice(i, i + 25));
        const allTasks = [];
        for (const chunk of chunks) {
          const batchFilter = chunk.map(id => `_regardingobjectid_value eq '${id}'`).join(' or ');
          const batchResult = await crmClient.requestAllPages('tasks', {
            query: {
              $filter: batchFilter,
              $select: 'activityid,subject,scheduledend,statuscode,statecode,_ownerid_value,description,msp_taskcategory,_regardingobjectid_value',
              $orderby: 'createdon desc'
            }
          });
          if (batchResult.ok && batchResult.data?.value) allTasks.push(...batchResult.data.value);
        }
        // Group by milestone and add recordUrls
        const base = getCrmBase();
        const byMilestone = {};
        for (const t of allTasks) {
          const msId = t._regardingobjectid_value;
          if (!byMilestone[msId]) byMilestone[msId] = [];
          byMilestone[msId].push({ ...t, recordUrl: buildRecordUrl(base, 'task', t.activityid) });
        }
        return text({ count: allTasks.length, byMilestone });
      }

      // Single mode (backward-compatible)
      if (!milestoneId) return error('Provide milestoneId or milestoneIds');
      const nid = normalizeGuid(milestoneId);
      if (!isValidGuid(nid)) return error('Invalid milestoneId GUID');

      const filter = `_regardingobjectid_value eq '${nid}'`;
      const result = await crmClient.requestAllPages('tasks', {
        query: {
          $filter: filter,
          $select: 'activityid,subject,scheduledend,statuscode,statecode,_ownerid_value,description,msp_taskcategory',
          $orderby: 'createdon desc'
        }
      });
      if (!result.ok) return error(`Get activities failed (${result.status}): ${result.data?.message}`);
      const tasks = (result.data?.value || []).map(t => ({ ...t, recordUrl: buildRecordUrl(getCrmBase(), 'task', t.activityid) }));
      return text({ count: tasks.length, tasks });
    }
  );

  // ── find_milestones_needing_tasks ───────────────────────────
  server.tool(
    'find_milestones_needing_tasks',
    'Composite tool: resolves customer keywords → accounts → opportunities → milestones, then identifies milestones without linked tasks.',
    {
      customerKeywords: z.array(z.string()).describe('Array of customer name keywords to search'),
      statusFilter: z.enum(['active', 'all']).optional().describe('Milestone status filter (default: active)')
    },
    async ({ customerKeywords, statusFilter = 'active' }) => {
      if (!customerKeywords?.length) return error('At least one customerKeyword is required');

      const customers = [];
      let totalNeedingTasks = 0;

      for (const keyword of customerKeywords) {
        const sanitized = sanitizeODataString(keyword.trim());

        // 1. Resolve accounts
        const acctResult = await crmClient.requestAllPages('accounts', {
          query: { $filter: `contains(name,'${sanitized}')`, $select: 'accountid,name', $top: '50' }
        });
        const accounts = acctResult.ok ? (acctResult.data?.value || []) : [];
        if (!accounts.length) {
          customers.push({ customer: keyword, error: 'No matching accounts found', milestonesNeedingTasks: 0, milestones: [] });
          continue;
        }

        // 2. Get opportunities for matched accounts
        const acctIds = accounts.map(a => a.accountid);
        const acctFilter = acctIds.map(id => `_parentaccountid_value eq '${id}'`).join(' or ');
        const oppResult = await crmClient.requestAllPages('opportunities', {
          query: { $filter: `(${acctFilter}) and statecode eq 0`, $select: OPP_SELECT, $orderby: 'name' }
        });
        const opps = oppResult.ok ? (oppResult.data?.value || []) : [];
        if (!opps.length) {
          customers.push({ customer: keyword, milestonesNeedingTasks: 0, milestones: [], accounts: accounts.map(a => a.name) });
          continue;
        }

        // 3. Get milestones for opportunities
        const oppIds = opps.map(o => o.opportunityid);
        const oppFilter = oppIds.map(id => `_msp_opportunityid_value eq '${id}'`).join(' or ');
        const msResult = await crmClient.requestAllPages('msp_engagementmilestones', {
          query: { $filter: oppFilter, $select: MILESTONE_SELECT, $orderby: 'msp_milestonedate' }
        });
        let milestones = msResult.ok ? (msResult.data?.value || []) : [];

        // Apply status filter
        if (statusFilter === 'active') {
          milestones = milestones.filter(m => ACTIVE_STATUSES.has(fv(m, 'msp_milestonestatus')));
        }

        if (!milestones.length) {
          customers.push({ customer: keyword, milestonesNeedingTasks: 0, milestones: [] });
          continue;
        }

        // 4. Batch task check
        const msIds = milestones.map(m => m.msp_engagementmilestoneid);
        const taskFilter = msIds.map(id => `_regardingobjectid_value eq '${id}'`).join(' or ');
        const taskResult = await crmClient.requestAllPages('tasks', {
          query: { $filter: taskFilter, $select: '_regardingobjectid_value' }
        });
        const taskMsIds = new Set();
        if (taskResult.ok && taskResult.data?.value) {
          for (const t of taskResult.data.value) taskMsIds.add(t._regardingobjectid_value);
        }

        const needingTasks = milestones.filter(m => !taskMsIds.has(m.msp_engagementmilestoneid));
        totalNeedingTasks += needingTasks.length;

        customers.push({
          customer: keyword,
          milestonesNeedingTasks: needingTasks.length,
          totalMilestones: milestones.length,
          milestones: needingTasks.map(m => ({
            id: m.msp_engagementmilestoneid,
            number: m.msp_milestonenumber,
            name: m.msp_name,
            status: fv(m, 'msp_milestonestatus'),
            commitment: commitmentLabel(m),
            date: toIsoDate(m.msp_milestonedate),
            opportunity: fv(m, '_msp_opportunityid_value'),
            workload: fv(m, '_msp_workloadlkid_value'),
            recordUrl: buildRecordUrl(getCrmBase(), 'msp_engagementmilestone', m.msp_engagementmilestoneid)
          }))
        });
      }

      return text({ totalMilestonesNeedingTasks: totalNeedingTasks, customers });
    }
  );

  // ── view_milestone_timeline ─────────────────────────────────
  server.tool(
    'view_milestone_timeline',
    'Return timeline-friendly milestone events for a user or opportunity, with render hints for Copilot UI.',
    {
      ownerId: z.string().optional().describe('System user GUID to filter milestone owner'),
      opportunityId: z.string().optional().describe('Opportunity GUID to filter milestones'),
      fromDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      toDate: z.string().optional().describe('End date (YYYY-MM-DD)')
    },
    async ({ ownerId, opportunityId, fromDate, toDate }) => {
      if (!ownerId && !opportunityId) {
        return error('Provide ownerId or opportunityId');
      }

      const filters = [];
      if (ownerId) {
        const ownerNid = normalizeGuid(ownerId);
        if (!isValidGuid(ownerNid)) return error('Invalid ownerId GUID');
        filters.push(`_ownerid_value eq '${ownerNid}'`);
      }

      if (opportunityId) {
        const oppNid = normalizeGuid(opportunityId);
        if (!isValidGuid(oppNid)) return error('Invalid opportunityId GUID');
        filters.push(`_msp_opportunityid_value eq '${oppNid}'`);
      }

      if (fromDate) filters.push(`msp_milestonedate ge ${sanitizeODataString(fromDate)}`);
      if (toDate) filters.push(`msp_milestonedate le ${sanitizeODataString(toDate)}`);

      const result = await crmClient.requestAllPages('msp_engagementmilestones', {
        query: {
          $filter: filters.join(' and '),
          $select: 'msp_engagementmilestoneid,msp_milestonenumber,msp_name,msp_milestonestatus,msp_commitmentrecommendation,msp_milestonedate,msp_monthlyuse,_msp_opportunityid_value',
          $orderby: 'msp_milestonedate asc'
        }
      });
      if (!result.ok) return error(`Timeline query failed (${result.status}): ${result.data?.message}`);

      const milestones = result.data?.value || [];
      const oppIds = [...new Set(milestones.map(m => m._msp_opportunityid_value).filter(Boolean))];
      const opportunityNames = {};

      for (const id of oppIds) {
        const opp = await crmClient.request(`opportunities(${id})`, { query: { $select: 'name' } });
        if (opp.ok && opp.data?.name) opportunityNames[id] = opp.data.name;
      }

      const base = getCrmBase();
      const events = milestones.map(m => ({
        id: m.msp_engagementmilestoneid,
        date: toIsoDate(m.msp_milestonedate),
        title: m.msp_name,
        milestoneNumber: m.msp_milestonenumber,
        status: m['msp_milestonestatus@OData.Community.Display.V1.FormattedValue'] ?? m.msp_milestonestatus,
        commitment: commitmentLabel(m),
        monthlyUse: m.msp_monthlyuse ?? null,
        opportunityId: m._msp_opportunityid_value ?? null,
        opportunityName: opportunityNames[m._msp_opportunityid_value] ?? null,
        recordUrl: buildRecordUrl(base, 'msp_engagementmilestone', m.msp_engagementmilestoneid)
      }));

      return text({
        count: events.length,
        events,
        renderHints: {
          view: 'timeline',
          defaultSort: { field: 'date', direction: 'asc' },
          dateField: 'date',
          titleField: 'title',
          laneField: 'opportunityName',
          statusField: 'status'
        }
      });
    }
  );

  // ── view_opportunity_cost_trend ────────────────────────────
  server.tool(
    'view_opportunity_cost_trend',
    'Return monthly cost/consumption trend points for an opportunity with chart/table render hints.',
    {
      opportunityId: z.string().describe('Opportunity GUID'),
      includeMilestones: z.boolean().optional().describe('Include milestone monthly-use points (default true)')
    },
    async ({ opportunityId, includeMilestones = true }) => {
      const oppNid = normalizeGuid(opportunityId);
      if (!isValidGuid(oppNid)) return error('Invalid opportunityId GUID');

      const opportunityResult = await crmClient.request(`opportunities(${oppNid})`, {
        query: {
          $select: 'opportunityid,name,estimatedclosedate,msp_estcompletiondate,msp_consumptionconsumedrecurring'
        }
      });
      if (!opportunityResult.ok) {
        return error(`Opportunity lookup failed (${opportunityResult.status}): ${opportunityResult.data?.message}`);
      }

      const opportunity = opportunityResult.data || {};
      const byMonth = new Map();

      if (includeMilestones) {
        const milestoneResult = await crmClient.requestAllPages('msp_engagementmilestones', {
          query: {
            $filter: `_msp_opportunityid_value eq '${oppNid}'`,
            $select: 'msp_milestonedate,msp_monthlyuse,msp_name,msp_milestonenumber',
            $orderby: 'msp_milestonedate asc'
          }
        });
        if (!milestoneResult.ok) {
          return error(`Milestone trend query failed (${milestoneResult.status}): ${milestoneResult.data?.message}`);
        }

        for (const milestone of milestoneResult.data?.value || []) {
          const key = monthKey(milestone.msp_milestonedate);
          const amount = Number(milestone.msp_monthlyuse ?? 0);
          if (!key || Number.isNaN(amount)) continue;
          byMonth.set(key, (byMonth.get(key) || 0) + amount);
        }
      }

      const points = [...byMonth.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([month, planned]) => ({ month, plannedMonthlyUse: planned }));

      const totalPlanned = points.reduce((sum, point) => sum + point.plannedMonthlyUse, 0);
      const consumedRecurring = Number(opportunity.msp_consumptionconsumedrecurring ?? 0);

      return text({
        opportunity: {
          id: opportunity.opportunityid,
          name: opportunity.name,
          estimatedCloseDate: toIsoDate(opportunity.estimatedclosedate),
          estimatedCompletionDate: toIsoDate(opportunity.msp_estcompletiondate),
          consumedRecurring
        },
        points,
        kpis: {
          consumedRecurring,
          totalPlannedMonthlyUse: totalPlanned,
          latestPlannedMonthlyUse: points.length ? points[points.length - 1].plannedMonthlyUse : 0
        },
        renderHints: {
          view: 'timeseries',
          xField: 'month',
          yFields: ['plannedMonthlyUse'],
          currency: 'USD',
          defaultChart: 'line',
          showTable: true
        }
      });
    }
  );

  // ── view_staged_changes_diff ───────────────────────────────
  server.tool(
    'view_staged_changes_diff',
    'Build a render-friendly before/after diff table from staged write payloads.',
    {
      before: z.object({}).passthrough().describe('Current values object (before)'),
      after: z.object({}).passthrough().describe('Proposed values object (after)'),
      context: z.string().optional().describe('Optional context label (e.g. operation ID)')
    },
    async ({ before, after, context }) => {
      const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
      const rows = keys
        .map((field) => {
          const beforeValue = before?.[field] ?? null;
          const afterValue = after?.[field] ?? null;
          const beforeText = beforeValue === null ? null : String(beforeValue);
          const afterText = afterValue === null ? null : String(afterValue);

          if (beforeText === afterText) return null;

          let changeType = 'updated';
          if (beforeValue === null && afterValue !== null) changeType = 'added';
          if (beforeValue !== null && afterValue === null) changeType = 'removed';

          return {
            field,
            before: beforeValue,
            after: afterValue,
            changeType
          };
        })
        .filter(Boolean);

      return text({
        context: context || null,
        summary: {
          changedFieldCount: rows.length
        },
        rows,
        renderHints: {
          view: 'diffTable',
          columns: ['field', 'before', 'after', 'changeType'],
          emphasisField: 'changeType'
        }
      });
    }
  );

  // ── list_pending_operations ──────────────────────────────────
  server.tool(
    'list_pending_operations',
    'List all staged CRM write operations awaiting human approval.',
    {},
    async () => {
      const queue = getApprovalQueue();
      const pending = queue.listPending();
      return text({
        count: pending.length,
        operations: pending.map(op => ({
          id: op.id,
          type: op.type,
          description: op.description,
          stagedAt: op.stagedAt,
          expiresIn: Math.max(0, Math.round((op.expiresAt - Date.now()) / 1000)) + 's',
          before: op.beforeState,
          after: op.payload,
        })),
      });
    }
  );

  // ── execute_operation ──────────────────────────────────────
  server.tool(
    'execute_operation',
    'Approve and execute a single staged CRM write operation by ID.',
    {
      id: z.string().describe('Operation ID (e.g. "OP-1")')
    },
    async ({ id }) => {
      const queue = getApprovalQueue();
      // approve() expects 'pending'; also accept 'approved' (orphaned from a failed batch)
      let op = queue.approve(id);
      if (!op) {
        const existing = queue.get(id);
        if (existing && existing.status === 'approved') {
          op = existing; // resume orphaned approved op
        } else {
          return error(`Operation ${id} not found, already executed, or expired.`);
        }
      }

      // Pre-execution integrity check for milestone updates
      if (op.type === 'update_milestone' && op.identity?.milestoneNumber) {
        const recheck = await crmClient.request(op.entitySet, {
          query: { $select: 'msp_milestonenumber,msp_name,_msp_opportunityid_value' }
        });
        if (!recheck.ok) {
          queue.markFailed(id, 'Pre-execution verification failed: milestone no longer accessible');
          return error(`${id} aborted: milestone no longer accessible (${recheck.status}). The record may have been deleted.`);
        }
        const currentNumber = recheck.data?.msp_milestonenumber;
        if (currentNumber && currentNumber !== op.identity.milestoneNumber) {
          queue.markFailed(id, `Milestone number mismatch: expected ${op.identity.milestoneNumber}, got ${currentNumber}`);
          return error(
            `${id} aborted: milestone identity mismatch. ` +
            `Expected milestone number ${op.identity.milestoneNumber} but record at this GUID is ${currentNumber}. ` +
            `This may indicate the wrong milestone was targeted.`
          );
        }
      }

      // Execute against CRM
      let result;
      if (op.type === 'close_task') {
        // Try primary CloseTask action, fallback to bound Close
        result = await crmClient.request(op.entitySet, { method: op.method, body: op.payload });
        if (!result.ok && result.status !== 204 && op.fallbackEntitySet) {
          result = await crmClient.request(op.fallbackEntitySet, { method: 'POST', body: op.fallbackPayload });
        }
      } else {
        result = await crmClient.request(op.entitySet, { method: op.method, body: op.payload });
      }

      if (result.ok || result.status === 204) {
        queue.markExecuted(id, result.data);
        return text({ success: true, executed: id, type: op.type, description: op.description });
      }

      queue.markFailed(id, result.data?.message);
      return error(`Execution of ${id} failed (${result.status}): ${result.data?.message}`);
    }
  );

  // ── execute_all ────────────────────────────────────────────
  server.tool(
    'execute_all',
    'Approve and execute ALL pending staged operations in sequence.',
    {},
    async () => {
      const queue = getApprovalQueue();
      const pending = queue.listPending();
      if (!pending.length) return text({ executed: 0, message: 'No pending operations.' });

      const results = [];
      for (const op of pending) {
        try {
          const approved = queue.approve(op.id);
          if (!approved) {
            results.push({ id: op.id, success: false, reason: 'expired or missing' });
            continue;
          }

          // Pre-execution integrity check for milestone updates
          if (op.type === 'update_milestone' && op.identity?.milestoneNumber) {
            const recheck = await crmClient.request(op.entitySet, {
              query: { $select: 'msp_milestonenumber,msp_name,_msp_opportunityid_value' }
            });
            if (!recheck.ok) {
              queue.markFailed(op.id, 'Pre-execution verification failed: milestone no longer accessible');
              results.push({ id: op.id, success: false, reason: 'milestone no longer accessible' });
              continue;
            }
            const currentNumber = recheck.data?.msp_milestonenumber;
            if (currentNumber && currentNumber !== op.identity.milestoneNumber) {
              queue.markFailed(op.id, `Milestone number mismatch: expected ${op.identity.milestoneNumber}, got ${currentNumber}`);
              results.push({ id: op.id, success: false, reason: `identity mismatch: expected ${op.identity.milestoneNumber}, got ${currentNumber}` });
              continue;
            }
          }

          let result;
          if (op.type === 'close_task') {
            result = await crmClient.request(op.entitySet, { method: op.method, body: op.payload });
            if (!result.ok && result.status !== 204 && op.fallbackEntitySet) {
              result = await crmClient.request(op.fallbackEntitySet, { method: 'POST', body: op.fallbackPayload });
            }
          } else {
            result = await crmClient.request(op.entitySet, { method: op.method, body: op.payload });
          }

          if (result.ok || result.status === 204) {
            queue.markExecuted(op.id, result.data);
            results.push({ id: op.id, success: true });
          } else {
            queue.markFailed(op.id, result.data?.message);
            results.push({ id: op.id, success: false, reason: result.data?.message });
          }
        } catch (err) {
          results.push({ id: op.id, success: false, reason: err?.message || 'unexpected error' });
        }
      }

      const executed = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      return text({ executed, failed, results });
    }
  );

  // ── cancel_operation ───────────────────────────────────────
  server.tool(
    'cancel_operation',
    'Cancel/reject a single staged operation by ID. No CRM changes are made.',
    {
      id: z.string().describe('Operation ID (e.g. "OP-1")')
    },
    async ({ id }) => {
      const queue = getApprovalQueue();
      const op = queue.reject(id);
      if (!op) return error(`Operation ${id} not found or already processed.`);
      return text({ cancelled: id, type: op.type, description: op.description });
    }
  );

  // ── cancel_all ─────────────────────────────────────────────
  server.tool(
    'cancel_all',
    'Cancel/reject ALL pending staged operations. No CRM changes are made.',
    {},
    async () => {
      const queue = getApprovalQueue();
      const rejected = queue.rejectAll();
      return text({
        cancelled: rejected.length,
        operations: rejected.map(op => ({ id: op.id, type: op.type, description: op.description })),
      });
    }
  );

  // ── crm_auth_status ─────────────────────────────────────────
  server.tool(
    'crm_auth_status',
    'Check authentication status — shows current user, expiry, CRM URL.',
    {},
    async () => {
      const authResult = await crmClient.request('WhoAmI');
      if (!authResult.ok) return error(`Not authenticated: ${authResult.data?.message || authResult.status}`);
      return text({
        authenticated: true,
        userId: authResult.data?.UserId,
        businessUnitId: authResult.data?.BusinessUnitId,
        organizationId: authResult.data?.OrganizationId
      });
    }
  );
}
