# Spec: Reduce Tool-Call Chains for Milestone Lookup

**Status:** Draft  
**Date:** 2026-03-06  
**Problem:** Agents routinely need 2–4 chained tool calls to answer "show me milestones for [customer/opportunity]". Each call is a round-trip through the model → MCP → CRM pipeline, adding latency and token cost.

---

## Current Call Chains (Observed)

### Chain A: "Milestones for a customer" (3–4 calls)
```
1. list_opportunities({ customerKeyword: "Contoso" })  →  opportunity GUIDs
2. get_milestones({ opportunityId: "<guid1>" })         →  milestones for opp 1
3. get_milestones({ opportunityId: "<guid2>" })         →  milestones for opp 2
   ... repeat per opportunity
```
**Calls: 1 + N** (where N = number of matching opportunities)

### Chain B: "Milestones for a customer" with batch (2 calls)
```
1. list_opportunities({ customerKeyword: "Contoso" })           →  opportunity GUIDs
2. get_milestones({ opportunityIds: ["<guid1>", "<guid2>"] })   →  all milestones
```
**Calls: 2** (best case — requires agent to know about `opportunityIds` param)

### Chain C: "Milestones for my opportunities" (2–3 calls)
```
1. get_my_active_opportunities()                              →  opportunity GUIDs
2. get_milestones({ opportunityIds: [...] })                  →  all milestones
```
**Calls: 2**

### Chain D: "Milestones + their tasks" (3+ calls)
```
1. list_opportunities({ customerKeyword: "Contoso" })           →  GUIDs
2. get_milestones({ opportunityIds: [...] })                    →  milestones
3. get_milestone_activities({ milestoneIds: [...] })            →  tasks
```
**Calls: 3**

### Chain E: Agent struggles / retries (observed in screenshot)
```
1. get_milestones(...)        →  didn't get what it wanted
2. get_milestones(...)        →  retry with different params
3. get_milestones(...)        →  another attempt
4. crm_query(...)             →  falls back to raw OData
```
**Calls: 4** (wasted retries due to unclear param surface)

---

## Root Causes

1. **Name → GUID gap.** `get_milestones` requires a GUID (`opportunityId`). Agents must first call `list_opportunities` or `get_my_active_opportunities` to resolve names to GUIDs. This is the #1 source of extra calls.

2. **No customer-level milestone retrieval.** There's no single tool that accepts a customer name and returns milestones. `find_milestones_needing_tasks` does the full chain internally but is specialized (only returns milestones *without* tasks).

3. **Tasks require a separate tool.** After getting milestones, agents often need tasks too. That's always a follow-up `get_milestone_activities` call.

4. **Stale instruction docs create confusion.** The `crm-query-strategy.instructions.md` incorrectly states that `opportunityIds`, `statusFilter`, `taskFilter`, and `format` don't exist on `get_milestones` — but they do in the actual code. This causes agents to skip efficient batch paths and fall back to `crm_query`.

---

## Proposed Changes

### Option A: Add `customerKeyword` to `get_milestones` (Recommended)

Extend the existing `get_milestones` tool with a `customerKeyword` parameter that internally resolves Customer name → Accounts → Opportunities → Milestones in one tool call.

#### New Parameters

| Parameter | Type | Description |
|---|---|---|
| `customerKeyword` | `string?` | Customer name keyword. Resolves accounts → opportunities → milestones internally. |
| `opportunityKeyword` | `string?` | Opportunity name keyword. Searches opportunities by name → milestones. |
| `includeTasks` | `boolean?` | When `true`, embeds linked tasks inline on each milestone (avoids follow-up `get_milestone_activities` call). Default: `false`. |

#### Resolution Logic (added to existing handler)

```
if customerKeyword provided:
  1. accounts = crm.query(accounts, contains(name, customerKeyword))
  2. opportunities = crm.query(opportunities, _parentaccountid_value in accountIds, statecode=0)
  3. milestones = crm.query(milestones, _msp_opportunityid_value in oppIds)
  4. Apply existing statusFilter/keyword/taskFilter post-processing
  5. If includeTasks: batch-fetch tasks and embed on each milestone

if opportunityKeyword provided:
  1. opportunities = crm.query(opportunities, contains(name, keyword), statecode=0)
  2. milestones = crm.query(milestones, _msp_opportunityid_value in oppIds)
  3. (same post-processing)
```

#### Before/After Call Counts

| Scenario | Before | After |
|---|---|---|
| Milestones for customer "Contoso" | 2–4 calls | **1 call** |
| Milestones for opp named "Azure Migration" | 2 calls | **1 call** |
| Milestones + tasks for a customer | 3–4 calls | **1 call** |
| Milestones by opportunity GUID | 1 call | 1 call (unchanged) |
| My milestones | 1 call | 1 call (unchanged) |

#### Payload Shape (with `includeTasks: true`)

```json
{
  "count": 5,
  "milestones": [
    {
      "msp_engagementmilestoneid": "...",
      "msp_name": "SQL DB for AI-based Intelligence app",
      "msp_milestonestatus": 861980000,
      "status": "On Track",
      "commitment": "Uncommitted",
      "msp_milestonedate": "2027-01-31",
      "msp_monthlyuse": 3000,
      "opportunity": "Contoso Azure Modernization",
      "_msp_opportunityid_value": "...",
      "tasks": [
        {
          "activityid": "...",
          "subject": "Architecture review",
          "scheduledend": "2027-01-15",
          "statuscode": 2,
          "status": "In Progress"
        }
      ]
    }
  ]
}
```

When `includeTasks` is `false` (default), the `tasks` key is omitted — no extra CRM call.

---

### Option B: New Composite Tool `get_opportunity_with_milestones` (Alternative)

A dedicated tool that returns opportunity details + milestones + optional tasks in one call. Cleaner separation but adds to the tool count.

```
get_opportunity_with_milestones({
  customerKeyword?: string,
  opportunityKeyword?: string,
  opportunityId?: string,
  statusFilter?: 'active' | 'all',
  includeTasks?: boolean
})
```

Returns:
```json
{
  "opportunities": [
    {
      "opportunityid": "...",
      "name": "Contoso Azure Modernization",
      "milestones": [
        { "...milestone fields...", "tasks": [ "...if includeTasks..." ] }
      ]
    }
  ]
}
```

**Pros:** Clear single-purpose tool; groups milestones under their parent opportunity.  
**Cons:** Adds another tool to an already-large surface (22 tools). Agent now has to decide between this and `get_milestones`.

---

### Supplementary Fix: Update Stale Instructions

Regardless of which option is chosen, `crm-query-strategy.instructions.md` must be corrected:

**Current (wrong):**
> `get_milestones` does NOT support: `opportunityIds` (plural), `statusFilter`, `taskFilter`, or `format`. Use `crm_query` instead.

**Corrected:**
> `get_milestones` supports: `opportunityIds` (plural array, batch mode), `statusFilter` ('active'|'all'), `keyword`, `taskFilter` ('all'|'with-tasks'|'without-tasks'), and `format` ('full'|'summary').

This alone would eliminate some of the retry/fallback behavior in Chain E.

---

## Recommendation

**Go with Option A** — extend `get_milestones` with `customerKeyword`, `opportunityKeyword`, and `includeTasks`. Rationale:

1. **No new tools.** Agents already know `get_milestones`. Adding parameters is cheaper than adding tools.
2. **Follows existing patterns.** `list_opportunities` already accepts `customerKeyword` and resolves internally. `find_milestones_needing_tasks` already chains customer → milestones internally.
3. **Backward compatible.** All existing parameters continue to work identically.
4. **Maximum call reduction.** Goes from 2–4 calls to 1 for the most common workflows.
5. **`includeTasks` is opt-in.** Default `false` keeps payloads lean; agents only request tasks when needed.

Plus the instruction doc fix to correct the stale "params don't exist" guidance.

---

## Implementation Scope

| Item | Effort | Files |
|---|---|---|
| Add `customerKeyword` resolution to `get_milestones` | Small | `mcp/msx/src/tools.js` |
| Add `opportunityKeyword` resolution to `get_milestones` | Small | `mcp/msx/src/tools.js` |
| Add `includeTasks` inline embedding | Small | `mcp/msx/src/tools.js` |
| Update tool description string | Trivial | `mcp/msx/src/tools.js` |
| Fix `crm-query-strategy.instructions.md` | Trivial | `.github/instructions/crm-query-strategy.instructions.md` |
| Fix `crm-entity-schema.instructions.md` | Trivial | `.github/instructions/crm-entity-schema.instructions.md` |
| Add/update tests | Small | `mcp/msx/src/__tests__/tools.test.js` |

---

## Open Questions

1. **Should `customerKeyword` results include the resolved opportunity details in the response?** (e.g., opportunity name/GUID for grouping) — The current `format: 'summary'` groups by opportunity name already, which covers this.

2. **Payload size guardrails.** If a customer has 10 opportunities × 50 milestones each × tasks, the response could be large. Should we enforce a `$top` cap or truncate with a "use more specific filters" message?

3. **Should `get_my_active_opportunities` also gain a `includeMilestones` flag?** This would eliminate Chain C (my opps + their milestones = 1 call instead of 2). Lower priority — the GUID batch path already works in 2 calls.

4. **Deprecation of `find_milestones_needing_tasks`?** With `customerKeyword` + `taskFilter: 'without-tasks'` on `get_milestones`, this tool becomes redundant. Should we deprecate or keep it as a convenience alias?
