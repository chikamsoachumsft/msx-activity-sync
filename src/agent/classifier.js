// Meeting classifier — determines if a meeting is customer-facing,
// which customer, and what CRM task category to assign.
// Mirrors the classification logic from the VS Code agent instructions.

import { getMilestoneForCustomer, isSkippedCustomer } from './state.js';

// ── Skip patterns ────────────────────────────────────────────
// Meetings matching these patterns are always skipped (internal/non-customer)

const SKIP_SUBJECT_PATTERNS = [
  /zero.?to.?agents/i,
  /mfm\s*(software)?\s*(se)?\s*[-–—]?\s*(business)?\s*scrum/i,
  /(?<!onsite\s*)office\s*hours(?!.*(?:onsite|customer))/i,  // internal office hours (not customer onsite)
  /stand.?up/i,
  /1[:\s]*1\b/i,          // 1:1 meetings
  /all.?hands/i,
  /team\s*sync/i,
  /pod\s*(sync|standup|meeting)/i,
  /level\s*up/i,
  /brown\s*bag/i,
  /lunch\s*(&|and)\s*learn/i,
  /show\s*(&|and|n)\s*tell/i,
  /how\s+i\s+built\s+it/i,
  /showcase/i,
  /hackathon/i,
  /sprint\s*(review|retro|planning)/i,
  /ooo|out\s*of\s*office/i,
  /focus\s*time/i,
  /block/i,
  /no\s*meeting/i,
  /tentative/i,
  /cancelled/i,
];

// Org-wide events (high attendee count, no external attendees)
const ORG_WIDE_THRESHOLD = 50;

// ── Category mapping ─────────────────────────────────────────
const CATEGORY_CODES = {
  BRIEFING: 861980008,
  WORKSHOP: 861980001,
  DEMO: 861980002,
  POC_PILOT: 861980005,
  INTERNAL: 861980012
};

const CATEGORY_SUBJECT_HINTS = [
  { pattern: /workshop/i, code: CATEGORY_CODES.WORKSHOP },
  { pattern: /demo\b/i, code: CATEGORY_CODES.DEMO },
  { pattern: /poc|pilot|proof\s*of\s*concept/i, code: CATEGORY_CODES.POC_PILOT },
  { pattern: /onsite|office\s*hours/i, code: CATEGORY_CODES.WORKSHOP },
  { pattern: /architecture|design\s*session|ads/i, code: CATEGORY_CODES.WORKSHOP },
  { pattern: /roadmap|planning|kickoff|kick.off/i, code: CATEGORY_CODES.BRIEFING },
  { pattern: /briefing|prep|review|sync|check.in/i, code: CATEGORY_CODES.BRIEFING },
];

/**
 * Classify a single meeting.
 * @param {import('./calendar.js').NormalizedMeeting} meeting
 * @param {object} state - sync state (for customer cache + skip list)
 * @returns {ClassificationResult}
 */
export function classifyMeeting(meeting, state) {
  const subject = meeting.subject || '';

  // 1. Check subject skip patterns
  for (const pattern of SKIP_SUBJECT_PATTERNS) {
    if (pattern.test(subject)) {
      return { skip: true, reason: `Subject matches skip pattern: ${pattern}`, customer: null, milestoneId: null, category: null };
    }
  }

  // 2. Try to match a customer FIRST (before org-wide check)
  //    A meeting with "UPS" in the subject should not be auto-skipped
  //    just because it has 200+ attendees.
  const customerMatch = matchCustomer(meeting, state);

  // 3. Check if org-wide event — but only if no customer was matched
  if (!customerMatch && meeting.attendeeCount >= ORG_WIDE_THRESHOLD && meeting.externalCount === 0) {
    return { skip: true, reason: `Org-wide event (${meeting.attendeeCount} attendees, 0 external)`, customer: null, milestoneId: null, category: null };
  }

  if (!customerMatch) {
    // No customer identified — skip if purely internal (0 external attendees)
    if (meeting.externalCount === 0) {
      return { skip: true, reason: 'No external attendees, no customer match', customer: null, milestoneId: null, category: null };
    }
    // Has external attendees but no known customer — flag for manual review
    return {
      skip: true,
      reason: 'External attendees present but no known customer match — needs manual review',
      customer: null,
      milestoneId: null,
      category: null
    };
  }

  // 4. Check if customer is on skip list
  const skipCheck = isSkippedCustomer(state, customerMatch.name);
  if (skipCheck.skip) {
    return { skip: true, reason: `Customer "${customerMatch.name}" is skipped: ${skipCheck.reason}`, customer: customerMatch.name, milestoneId: null, category: null };
  }

  // 5. Look up milestone
  const milestoneId = getMilestoneForCustomer(state, customerMatch.name);
  if (!milestoneId) {
    return {
      skip: true,
      reason: `Customer "${customerMatch.name}" has no cached milestone — needs CRM lookup`,
      customer: customerMatch.name,
      milestoneId: null,
      category: null
    };
  }

  // 6. Determine category
  const category = inferCategory(subject);

  return {
    skip: false,
    reason: null,
    customer: customerMatch.name,
    milestoneId,
    category,
    subject: cleanSubject(subject, customerMatch.name)
  };
}

/**
 * Batch-classify an array of meetings.
 * @param {Array<import('./calendar.js').NormalizedMeeting>} meetings
 * @param {object} state
 * @returns {Array<{meeting: object, classification: ClassificationResult}>}
 */
export function classifyAll(meetings, state) {
  return meetings.map(meeting => ({
    meeting,
    classification: classifyMeeting(meeting, state)
  }));
}

// ── Customer matching ────────────────────────────────────────

/**
 * Try to identify a customer from meeting subject and attendees.
 * @param {import('./calendar.js').NormalizedMeeting} meeting
 * @param {object} state
 * @returns {{ name: string, source: string } | null}
 */
function matchCustomer(meeting, state) {
  const subject = meeting.subject || '';
  const customerNames = Object.keys(state.customerMilestoneCache);
  const skippedNames = state.skippedCustomers.map(s => s.name);
  const allNames = [...customerNames, ...skippedNames];

  // Strategy 1: Customer name appears in subject (known customers)
  for (const name of allNames) {
    // Word-boundary match to avoid partial matches (e.g., "AT" in "ATLAS")
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(subject)) {
      return { name, source: 'subject' };
    }
  }

  // Strategy 2: External attendee email domain matches a customer
  // Build domain → customer map from known customer names
  const domainMap = buildDomainMap(allNames);
  for (const attendee of meeting.externalAttendees) {
    const domain = attendee.email.split('@')[1];
    if (domain && domainMap[domain]) {
      return { name: domainMap[domain], source: 'attendee-email' };
    }
  }

  // Strategy 3: Extract NEW customer name from subject patterns
  // Patterns: "GitHub + Customer | Topic", "Microsoft & Customer Dinner",
  //           "Customer + GitHub | ...", "Customer & Microsoft ..."
  const extracted = extractCustomerFromSubject(subject);
  if (extracted) {
    return { name: extracted, source: 'subject-inferred' };
  }

  return null;
}

/**
 * Extract a potential customer name from meeting subject patterns.
 * Recognizes patterns like:
 *   "GitHub + UPS | Commercials"  → "UPS"
 *   "GitHub & UPS Dinner"         → "UPS"
 *   "Microsoft + Contoso | Demo"  → "Contoso"
 *   "UPS & GitHub Workshop"       → "UPS"
 *   "UPS + Microsoft | ADS"       → "UPS"
 * Returns the inferred customer name or null.
 */
function extractCustomerFromSubject(subject) {
  // Remove common prefixes like "FW:", "RE:", "[EXTERNAL]"
  const cleaned = subject
    .replace(/^\[EXTERNAL\]\s*/i, '')
    .replace(/^(RE|FW|FWD):\s*/i, '')
    .replace(/^Agenda Added\s*[-–—:]\s*/i, '')
    .replace(/^Save the Date\s*[-–—:]\s*/i, '')
    .trim();

  const MS_NAMES = ['Microsoft', 'GitHub', 'MSFT', 'MS'];
  const msPattern = MS_NAMES.join('|');

  // Pattern: "MSName + Customer | Topic" or "MSName & Customer Topic"
  const patterns = [
    // "GitHub + Customer | Topic" or "GitHub + Customer - Topic"
    new RegExp(`(?:${msPattern})\\s*[+&]\\s*(.+?)\\s*[|\\-–—]`, 'i'),
    // "GitHub & Customer Word" (no separator — take 1-3 words after &)
    new RegExp(`(?:${msPattern})\\s*[+&]\\s*([A-Z][\\w.-]+(?:\\s+[A-Z][\\w.-]+){0,2})`, 'i'),
    // Reverse: "Customer + GitHub | Topic" 
    new RegExp(`(.+?)\\s*[+&]\\s*(?:${msPattern})\\s*[|\\-–—]`, 'i'),
    // Reverse: "Customer & GitHub Word"
    new RegExp(`([A-Z][\\w.-]+(?:\\s+[A-Z][\\w.-]+){0,2})\\s*[+&]\\s*(?:${msPattern})`, 'i'),
  ];

  for (const pattern of patterns) {
    const m = cleaned.match(pattern);
    if (!m) continue;
    let candidate = m[1].trim();
    // Strip common event-type suffixes: "UPS Dinner" → "UPS", "Delta Workshop" → "Delta"
    candidate = candidate
      .replace(/\s+(Dinner|Lunch|Breakfast|Meeting|Workshop|Demo|Briefing|Session|Call|Sync|Review|Event|Onsite|Visit|Kickoff|Check-?in)$/i, '')
      .trim();
    // Reject if candidate is itself a Microsoft name or too short
    if (MS_NAMES.some(n => n.toLowerCase() === candidate.toLowerCase())) continue;
    if (candidate.length < 2) continue;
    // Reject common false positives
    if (/^(the|our|your|this|that|team|all|new|save|date|agenda)/i.test(candidate)) continue;
    return candidate;
  }

  return null;
}

/**
 * Build a map of likely email domains to customer names.
 * Heuristic: lowercase the company name, strip common suffixes.
 */
function buildDomainMap(customerNames) {
  const map = {};
  for (const name of customerNames) {
    // Generate likely domain: "James Hardie" → "jameshardie.com"
    const cleaned = name.toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[^a-z0-9]/g, '');
    if (cleaned.length >= 2) {
      map[`${cleaned}.com`] = name;
    }

    // Also try hyphenated: "James Hardie" → "james-hardie.com"
    const hyphenated = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (hyphenated !== cleaned) {
      map[`${hyphenated}.com`] = name;
    }
  }

  // Add known overrides for tricky domains
  const overrides = {
    'hyatt.com': 'Hyatt',
    'chamberlaingroup.com': 'Chamberlain',
    'cfindustries.com': 'CF Industries',
    'jameshardie.com': 'James Hardie',
    'atlasairworldwide.com': 'Atlas Air',
    'atlasair.com': 'Atlas Air',
    'tesla.com': 'Tesla',
    'copart.com': 'Copart',
    'johnsoncontrols.com': 'JCI',
    'jci.com': 'JCI',
    'jeld-wen.com': 'JELD-WEN',
    'jeldwen.com': 'JELD-WEN',
    'zurnelkay.com': 'Zurn',
    'zurn.com': 'Zurn',
    'amtrak.com': 'Amtrak',
    'corteva.com': 'Corteva',
    'eagle.org': 'ABS',
    'absgroup.com': 'ABS',
    'axalta.com': 'Axalta',
    'generac.com': 'Generac',
    'vgpholdings.com': 'VGP Holdings',
    'harley-davidson.com': 'Harley-Davidson',
    'selinc.com': 'SEL',
    'nordson.com': 'Nordson',
    'kirby.com': 'Kirby Corporation',
    'deluxe.com': 'Deluxe',
    'perkinelmer.com': 'PerkinElmer',
    'te.com': 'TE Connectivity',
    'seaboardcorp.com': 'Seaboard',
    'ups.com': 'UPS',
    'unitedparcel.com': 'UPS'
  };

  Object.assign(map, overrides);
  return map;
}

// ── Category inference ───────────────────────────────────────

export function inferCategory(subject) {
  for (const { pattern, code } of CATEGORY_SUBJECT_HINTS) {
    if (pattern.test(subject)) return code;
  }
  // Default: Briefing for customer meetings
  return CATEGORY_CODES.BRIEFING;
}

// ── Subject cleaning ─────────────────────────────────────────

export function cleanSubject(subject, customerName) {
  // Remove common prefixes
  let cleaned = subject
    .replace(/^\[EXTERNAL\]\s*/i, '')
    .replace(/^(RE|FW|FWD):\s*/i, '')
    .trim();
  return cleaned;
}

/**
 * @typedef {object} ClassificationResult
 * @property {boolean} skip - Whether to skip this meeting
 * @property {string|null} reason - Why skipped (or null if not skipped)
 * @property {string|null} customer - Customer name
 * @property {string|null} milestoneId - CRM milestone GUID
 * @property {number|null} category - Task category code
 * @property {string} [subject] - Cleaned subject (only if not skipped)
 */
