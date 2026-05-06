// Calendar client — fetches meetings from MS Graph /me/calendarView or WorkIQ MCP
// Normalizes output to a common shape for the classifier

import { getGraphToken } from './graph-auth.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ── WorkIQ-based calendar fetch ────────────────────────────────

/**
 * Fetch calendar events via WorkIQ MCP server.
 * Asks WorkIQ for meetings in JSON format and parses the response.
 * @param {object} workiqClient - MCP Client connected to WorkIQ server
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD (exclusive)
 * @returns {Promise<Array<NormalizedMeeting>>}
 */
export async function fetchCalendarViaWorkIQ(workiqClient, startDate, endDate) {
  // Ask WorkIQ for meetings one day at a time to get better structured data
  const allMeetings = [];
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');

  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const dayMeetings = await fetchWorkIQDay(workiqClient, dateStr);
    allMeetings.push(...dayMeetings);
  }

  // For meetings with attendees not resolved, ask WorkIQ for details.
  // Include all meetings where we don't have attendee emails yet,
  // regardless of size — the classifier needs external attendee info
  // to determine if it's a customer meeting.
  const needsResolution = allMeetings.filter(
    m => m.attendees.length === 0 && m.attendeeCount > 0
  );
  if (needsResolution.length > 0) {
    console.log(`[calendar] Resolving attendees for ${needsResolution.length} meetings...`);
    await resolveAttendees(workiqClient, needsResolution);
  }

  return allMeetings;
}

/**
 * Ask WorkIQ for attendee details on specific meetings.
 * Mutates the meeting objects in-place to add attendee data.
 */
async function resolveAttendees(workiqClient, meetings) {
  // Ask about all meetings in one prompt to minimize calls
  const subjects = meetings.map((m, i) => `${i + 1}. "${m.subject}" on ${m.startDate} at ${m.start?.substring(11, 16) || 'unknown'}`).join('\n');

  const question = `For each of these calendar meetings, open the meeting details and list ALL attendee email addresses.

${subjects}

Return ONLY a JSON array (no markdown, no explanation) where each element corresponds to the meeting above:
[
  {
    "index": 1,
    "attendees": [
      { "name": "Full Name", "email": "email@domain.com" }
    ]
  }
]

Rules:
- Return ONLY the JSON array
- If attendee list is truly not available for a meeting, return attendees as []
- Include both required and optional attendees`;

  try {
    const result = await workiqClient.callTool({
      name: 'ask_work_iq',
      arguments: { question },
    });

    const text = result?.content?.find(c => c.type === 'text')?.text || '';
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { response: text }; }
    const response = parsed.response || parsed.raw || text;

    // Extract JSON array
    let arr;
    try { arr = JSON.parse(response); } catch {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) try { arr = JSON.parse(jsonMatch[0]); } catch { /* ignore */ }
    }

    if (!Array.isArray(arr)) {
      console.log('[calendar] Could not parse attendee resolution response');
      return;
    }

    for (const item of arr) {
      const idx = (item.index || 0) - 1;
      if (idx < 0 || idx >= meetings.length) continue;
      const meeting = meetings[idx];
      const attendees = (item.attendees || [])
        .map(a => ({ name: a.name || '', email: (a.email || '').toLowerCase(), type: 'required' }))
        .filter(a => a.email && a.email !== meeting.organizer);

      meeting.attendees = attendees;
      meeting.externalAttendees = attendees.filter(a => !a.email.endsWith('@microsoft.com'));
      meeting.externalCount = meeting.externalAttendees.length;
      if (attendees.length > 0) meeting.attendeeCount = attendees.length;
    }

    console.log(`[calendar] Resolved attendees for ${arr.length} meetings`);
  } catch (err) {
    console.log(`[calendar] Attendee resolution failed: ${err.message}`);
  }
}

/**
 * Fetch meetings for a single day via WorkIQ.
 * Prompts WorkIQ to return strict JSON so parsing is deterministic.
 */
async function fetchWorkIQDay(workiqClient, dateStr) {
  const question = `List ALL my meetings on ${dateStr}.

Return ONLY a JSON array (no markdown, no explanation, no code fences) with this exact schema for each meeting:
[
  {
    "subject": "exact meeting title",
    "startTime": "h:mm AM/PM",
    "endTime": "h:mm AM/PM",
    "cancelled": false,
    "organizerName": "Full Name",
    "organizerEmail": "email@domain.com",
    "attendeeCount": 0,
    "attendees": [
      { "name": "Full Name", "email": "email@domain.com" }
    ]
  }
]

Rules:
- Return ONLY the JSON array, nothing else
- If attendee list is not available, set attendees to [] and put the count in attendeeCount
- Include ALL meetings, even personal ones
- Use exact subject lines from the calendar`;

  const result = await workiqClient.callTool({
    name: 'ask_work_iq',
    arguments: { question },
  });

  const text = result?.content?.find(c => c.type === 'text')?.text || '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { response: text };
  }
  const response = parsed.response || parsed.raw || text;

  console.log(`[calendar] WorkIQ response (${response.length} chars)`);

  // Try to parse as JSON array directly
  const meetings = tryParseJsonMeetings(response, dateStr);
  if (meetings) return meetings;

  // WorkIQ wrapped it in markdown or text — extract JSON from response
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    const extracted = tryParseJsonMeetings(jsonMatch[0], dateStr);
    if (extracted) return extracted;
  }

  // Last resort: fall back to markdown parser
  console.log('[calendar] JSON parse failed, falling back to markdown parser');
  return parseWorkIQMarkdown(response, dateStr);
}

/**
 * Parse a JSON array of meetings from WorkIQ into NormalizedMeeting objects.
 * Returns null if the string isn't valid JSON.
 */
function tryParseJsonMeetings(str, dateStr) {
  let arr;
  try {
    arr = JSON.parse(str);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;

  return arr
    .filter(m => !m.cancelled)
    .map(m => {
      const subject = (m.subject || '(No subject)').trim();
      const start = parseTimeToISO(dateStr, m.startTime || '');
      const end = parseTimeToISO(dateStr, m.endTime || '');
      const organizer = (m.organizerEmail || '').toLowerCase() || (m.organizerName || '').toLowerCase() || null;

      const attendees = (m.attendees || []).map(a => ({
        name: a.name || '',
        email: (a.email || '').toLowerCase(),
        type: 'required'
      })).filter(a => a.email);

      const externalAttendees = attendees.filter(
        a => !a.email.endsWith('@microsoft.com')
      );

      return {
        id: `workiq-${dateStr}-${subject.replace(/\W+/g, '-').substring(0, 50)}`,
        subject,
        start,
        end,
        startDate: dateStr,
        isAllDay: false,
        organizer,
        attendees,
        externalAttendees,
        attendeeCount: m.attendeeCount || attendees.length,
        externalCount: externalAttendees.length
      };
    });
}

/**
 * Fallback markdown parser — used only if WorkIQ ignores the JSON prompt.
 * Handles numbered headings (### N. or ### N)) with various time/organizer formats.
 */
function parseWorkIQMarkdown(response, dateStr) {
  const meetings = [];
  const text = response.replace(/\\n/g, '\n');

  // Split on numbered headings: ### 1. or ### 1) or ## 1.
  const blocks = text.split(/(?=#{2,4}\s*\d+[.)]\s)/);

  for (const block of blocks) {
    if (!block.trim()) continue;

    // Extract subject
    let subjectMatch = block.match(/#{2,4}\s*\d+[.)]\s*\*\*(.+?)\*\*/);
    if (!subjectMatch) subjectMatch = block.match(/#{2,4}\s*\d+[.)]\s*(.+?)(?:\n|$)/);
    if (!subjectMatch) continue;
    const subject = subjectMatch[1].trim();

    // Extract times — try multiple formats
    let start = null, end = null;

    // "**Start:** 10:00 AM" + "**End:** 11:00 AM"
    const sm = block.match(/\*\*Start:?\*\*\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    const em = block.match(/\*\*End:?\*\*\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    if (sm && em) { start = parseTimeToISO(dateStr, sm[1]); end = parseTimeToISO(dateStr, em[1]); }

    // "**Start / End:** 10:00 AM – 11:00 AM"
    if (!start) {
      const cm = block.match(/\*\*Start\s*\/\s*End:?\*\*\s*(\d{1,2}:\d{2}\s*(?:AM|PM))\s*[-–\u2013]\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
      if (cm) { start = parseTimeToISO(dateStr, cm[1]); end = parseTimeToISO(dateStr, cm[2]); }
    }

    // Inline "10:00 AM – 11:00 AM"
    if (!start) {
      const im = block.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))\s*[-–\u2013]\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
      if (im) { start = parseTimeToISO(dateStr, im[1]); end = parseTimeToISO(dateStr, im[2]); }
    }

    // Skip cancelled
    if (/\*\*Cancelled:?\*\*\s*(Yes|true)/i.test(block) || /\bcancell?ed\b/i.test(subject)) continue;

    // Organizer email
    let organizer = null;
    const oe = block.match(/\*\*Organizer\s*Email:?\*\*\s*([\w.+-]+@[\w.-]+\.\w+)/i)
      || block.match(/[-\s]*Email:\s*([\w.+-]+@[\w.-]+\.\w+)/i);
    if (oe) { organizer = oe[1].toLowerCase(); }
    if (!organizer) {
      const on = block.match(/\*?\*?Organizer:?\*?\*?\s*([^\n*]+)/i);
      if (on) {
        const t = on[1].trim().replace(/\*\*/g, '');
        const e = t.match(/[\w.+-]+@[\w.-]+\.\w+/);
        organizer = e ? e[0].toLowerCase() : t.toLowerCase();
      }
    }

    // Attendees
    const countMatch = block.match(/(\d+)\s*(?:invitees?|attendees?|participants?)/i);
    const attendeeCount = countMatch ? parseInt(countMatch[1], 10) : 0;
    const attendees = [];
    for (const m of block.matchAll(/\b([\w.+-]+@[\w.-]+\.\w+)\b/g)) {
      const email = m[1].toLowerCase();
      if (email !== organizer) attendees.push({ name: '', email, type: 'required' });
    }
    const externalAttendees = attendees.filter(a => !a.email.endsWith('@microsoft.com'));

    meetings.push({
      id: `workiq-${dateStr}-${subject.replace(/\W+/g, '-').substring(0, 50)}`,
      subject, start, end, startDate: dateStr, isAllDay: false, organizer,
      attendees, externalAttendees,
      attendeeCount: attendeeCount || attendees.length,
      externalCount: externalAttendees.length
    });
  }

  return meetings;
}

/**
 * Parse "3:00 PM" or "10:30 AM" into ISO datetime string for a given date.
 */
function parseTimeToISO(dateStr, timeStr) {
  const match = timeStr.trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = match[3].toUpperCase();

  if (ampm === 'PM' && hours !== 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;

  return `${dateStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
}

/**
 * Fetch calendar events from MS Graph for a date range.
 * @param {string} startDate - ISO date string (YYYY-MM-DD)
 * @param {string} endDate   - ISO date string (YYYY-MM-DD), exclusive end
 * @param {object} [opts]
 * @param {string} [opts.tenantId]
 * @param {string} [opts.token] - Pre-fetched token (skips az CLI call)
 * @param {string} [opts.timezone] - IANA timezone (default: America/Chicago)
 * @returns {Promise<Array<NormalizedMeeting>>}
 */
export async function fetchCalendarEvents(startDate, endDate, opts = {}) {
  const token = opts.token || await getGraphToken({ tenantId: opts.tenantId });
  const tz = opts.timezone || 'America/Chicago';

  // Build calendarView URL with time bounds
  const startDateTime = `${startDate}T00:00:00`;
  const endDateTime = `${endDate}T00:00:00`;

  const params = new URLSearchParams({
    startDateTime,
    endDateTime,
    $select: 'id,subject,start,end,attendees,organizer,isAllDay,isCancelled',
    $orderby: 'start/dateTime',
    $top: '100'
  });

  const url = `${GRAPH_BASE}/me/calendarView?${params}`;
  const allEvents = [];
  let nextLink = url;

  while (nextLink) {
    const response = await fetch(nextLink, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: `outlook.timezone="${tz}"`
      }
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Graph calendarView failed (${response.status}): ${body}`);
    }

    const data = await response.json();
    if (data.value) allEvents.push(...data.value);
    nextLink = data['@odata.nextLink'] || null;
  }

  return allEvents
    .filter(e => !e.isCancelled)
    .map(normalizeEvent);
}

/**
 * Normalize a Graph calendar event to our common shape.
 * @param {object} event - Raw Graph event
 * @returns {NormalizedMeeting}
 */
function normalizeEvent(event) {
  const attendees = (event.attendees || []).map(a => ({
    name: a.emailAddress?.name || '',
    email: (a.emailAddress?.address || '').toLowerCase(),
    type: a.type || 'required' // required | optional | resource
  }));

  const externalAttendees = attendees.filter(
    a => a.email && !a.email.endsWith('@microsoft.com')
  );

  return {
    id: event.id,
    subject: event.subject || '(No subject)',
    start: event.start?.dateTime || null,
    end: event.end?.dateTime || null,
    startDate: event.start?.dateTime?.slice(0, 10) || null,
    isAllDay: event.isAllDay || false,
    organizer: event.organizer?.emailAddress?.address?.toLowerCase() || null,
    attendees,
    externalAttendees,
    attendeeCount: attendees.length,
    externalCount: externalAttendees.length
  };
}

/**
 * @typedef {object} NormalizedMeeting
 * @property {string} id
 * @property {string} subject
 * @property {string|null} start - ISO datetime
 * @property {string|null} end - ISO datetime
 * @property {string|null} startDate - YYYY-MM-DD
 * @property {boolean} isAllDay
 * @property {string|null} organizer - email
 * @property {Array<{name:string, email:string, type:string}>} attendees
 * @property {Array<{name:string, email:string, type:string}>} externalAttendees
 * @property {number} attendeeCount
 * @property {number} externalCount
 */
