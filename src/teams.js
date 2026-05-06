// Microsoft Teams messaging via Graph API.
// Supports 1:1 chats, group chats, and channel messages.
// Requires delegated Graph permissions: Chat.ReadWrite (1:1/group),
// ChannelMessage.Send (channel). Auth comes from `az` CLI.

import { getGraphToken } from './auth.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DEFAULT_TIMEOUT_MS = 20_000;

async function graphFetch(method, path, { tenantId, body, query } = {}) {
  const token = await getGraphToken({ tenantId });
  const url = new URL(GRAPH_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      method,
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } finally {
    clearTimeout(t);
  }

  let data = null;
  const text = await resp.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`;
    const code = data?.error?.code || '';
    const err = new Error(`Graph ${method} ${path} failed (${resp.status}${code ? ' ' + code : ''}): ${msg}`);
    err.status = resp.status;
    err.code = code;
    err.data = data;
    throw err;
  }
  return data;
}

/** Resolve the calling user (the `me` in delegated calls). */
export async function getMe({ tenantId } = {}) {
  return graphFetch('GET', '/me', {
    tenantId,
    query: { $select: 'id,displayName,userPrincipalName,mail' }
  });
}

/** Resolve a user by UPN, email, or object ID. */
export async function resolveUser(identifier, { tenantId } = {}) {
  if (!identifier) throw new Error('identifier is required');

  // GUID → direct lookup
  const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (guidRe.test(identifier)) {
    return graphFetch('GET', `/users/${identifier}`, {
      tenantId,
      query: { $select: 'id,displayName,userPrincipalName,mail' }
    });
  }

  // UPN / email — Graph accepts UPN directly in /users/{upn}
  const encoded = encodeURIComponent(identifier);
  try {
    return await graphFetch('GET', `/users/${encoded}`, {
      tenantId,
      query: { $select: 'id,displayName,userPrincipalName,mail' }
    });
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  // Fallback: filter by mail
  const result = await graphFetch('GET', '/users', {
    tenantId,
    query: {
      $filter: `mail eq '${identifier.replace(/'/g, "''")}' or userPrincipalName eq '${identifier.replace(/'/g, "''")}'`,
      $select: 'id,displayName,userPrincipalName,mail',
      $top: 5
    }
  });
  if (!result?.value?.length) throw new Error(`User not found: ${identifier}`);
  return result.value[0];
}

/**
 * Create or get a 1:1 chat between the signed-in user and one other user.
 * Graph behavior: POST /chats with two members returns the existing chat
 * if one already exists between those two users (idempotent).
 */
export async function getOrCreateOneOnOneChat(otherUserId, { tenantId } = {}) {
  const body = {
    chatType: 'oneOnOne',
    members: [
      {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: ['owner'],
        'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${otherUserId}')`
      },
      {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: ['owner'],
        'user@odata.bind': `https://graph.microsoft.com/v1.0/me`
      }
    ]
  };
  return graphFetch('POST', '/chats', { tenantId, body });
}

/** Create a group chat with the signed-in user + N other users. */
export async function createGroupChat(otherUserIds, { topic, tenantId } = {}) {
  if (!Array.isArray(otherUserIds) || otherUserIds.length < 2) {
    throw new Error('Group chat requires at least 2 other user IDs');
  }
  const members = [
    {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      roles: ['owner'],
      'user@odata.bind': `https://graph.microsoft.com/v1.0/me`
    },
    ...otherUserIds.map((id) => ({
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      roles: ['owner'],
      'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${id}')`
    }))
  ];
  const body = { chatType: 'group', members };
  if (topic) body.topic = topic;
  return graphFetch('POST', '/chats', { tenantId, body });
}

/** Post a message to an existing chat (1:1 or group). */
export async function sendChatMessage(chatId, { text, html, subject, importance, tenantId } = {}) {
  if (!chatId) throw new Error('chatId is required');
  if (!text && !html) throw new Error('Either text or html message body is required');
  const body = {
    body: html
      ? { contentType: 'html', content: html }
      : { contentType: 'text', content: text }
  };
  if (subject) body.subject = subject;
  if (importance) body.importance = importance; // 'normal' | 'high' | 'urgent'
  return graphFetch('POST', `/chats/${chatId}/messages`, { tenantId, body });
}

/** Post a message to a Teams channel. */
export async function sendChannelMessage(teamId, channelId, { text, html, subject, importance, tenantId } = {}) {
  if (!teamId || !channelId) throw new Error('teamId and channelId are required');
  if (!text && !html) throw new Error('Either text or html message body is required');
  const body = {
    body: html
      ? { contentType: 'html', content: html }
      : { contentType: 'text', content: text }
  };
  if (subject) body.subject = subject;
  if (importance) body.importance = importance;
  return graphFetch('POST', `/teams/${teamId}/channels/${channelId}/messages`, { tenantId, body });
}
