import { HttpError, json } from './http.js';
import { sha256Base64 } from './auth.js';
import { enforceApiKeyRateLimit, sha256Hex, verifyApiKey } from './api-keys.js';
import { readableMessageText, readableStoredBodies } from './mime.js';
import { checkRateLimit, enforceBodySize, normalizeDomainName, normalizeEmailAddress, normalizeLocalPart as validateLocalPart } from './security.js';

const TOKEN_BYTES = 32;

function requireDb(env) {
  if (!env.DB) throw new HttpError(500, 'database_not_configured', 'D1 database binding DB is required');
  return env.DB;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken(prefix) {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return `${prefix}_${bytesToHex(bytes)}`;
}

function normalizeDomain(domain) {
  return normalizeDomainName(domain);
}

function normalizeLocalPart(value) {
  return validateLocalPart(value);
}

function assertLocalPart(localPart) {
  validateLocalPart(localPart);
}

function randomLocalPart() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) return {};
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

function publicInbox(row) {
  return {
    email: row.address,
    id: row.id,
    address: row.address,
    localPart: row.local_part,
    domain: row.domain,
    status: row.status,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at || null
  };
}

function fromDisplay(row) {
  if (row.from_name && row.from_address) return `${row.from_name} <${row.from_address}>`;
  return row.from_address || row.from_name || 'Unknown sender';
}

function previewText(row) {
  const text = readableMessageText(row).replace(/\s+/g, ' ').trim();
  if (!text) return 'Preview unavailable';
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function publicMessageSummary(row) {
  return {
    id: row.id,
    from: fromDisplay(row),
    subject: row.subject || '',
    preview: previewText(row),
    receivedAt: row.received_at,
    hasAttachments: Boolean(row.has_attachments)
  };
}

function publicAttachment(row) {
  return {
    id: row.id,
    filename: row.filename || row.id,
    contentType: row.content_type || 'application/octet-stream',
    sizeBytes: row.size_bytes || 0,
    contentId: row.content_id || null
  };
}

function isMissingContentIdColumn(error) {
  return /no such column:\s*content_id/i.test(String(error?.message || error || ''));
}

async function listMessageAttachments(db, messageId) {
  try {
    return await all(db.prepare(`
      SELECT id, filename, content_type, size_bytes, content_id, created_at
      FROM attachments
      WHERE message_id = ? AND deleted_at IS NULL
      ORDER BY created_at
    `).bind(messageId));
  } catch (error) {
    if (!isMissingContentIdColumn(error)) throw error;
    const rows = await all(db.prepare(`
      SELECT id, filename, content_type, size_bytes, created_at
      FROM attachments
      WHERE message_id = ? AND deleted_at IS NULL
      ORDER BY created_at
    `).bind(messageId));
    return rows.map((row) => ({ ...row, content_id: null }));
  }
}

function publicMessageDetail(row, attachments = []) {
  const { htmlBody } = readableStoredBodies(row);
  const body = readableMessageText(row);
  return {
    id: row.id,
    from: {
      name: row.from_name || null,
      address: row.from_address || null
    },
    to: row.to_address,
    subject: row.subject || '',
    body,
    bodyType: 'text',
    htmlAvailable: Boolean(htmlBody),
    attachments: attachments.map(publicAttachment),
    receivedAt: row.received_at
  };
}

function shouldIncludeMeta(request) {
  return new URL(request.url).searchParams.get('include') === 'meta';
}

function createInboxResponse(row, { request, token = null, openedExisting = false, actor = null } = {}) {
  if (actor?.type === 'api_key' && !shouldIncludeMeta(request)) {
    return { email: row.address };
  }
  return {
    email: row.address,
    meta: {
      id: row.id,
      localPart: row.local_part,
      domain: row.domain,
      status: row.status,
      lastMessageAt: row.last_message_at || null
    },
    ...(token && actor?.type !== 'api_key' ? { inboxToken: token } : {}),
    ...(openedExisting ? { openedExisting: true } : {})
  };
}

async function first(statement) {
  return await statement.first();
}

async function run(statement) {
  return await statement.run();
}

async function all(statement) {
  const result = await statement.all();
  return result.results || [];
}

async function findDomain(db, config, requestedDomain) {
  if (!requestedDomain) {
    const rows = await all(db.prepare('SELECT id, domain, status, is_verified FROM domains WHERE status = ? AND is_verified = 1 ORDER BY domain').bind('active'));
    const activeByDomain = new Map(rows.map((row) => [String(row.domain || '').toLowerCase(), row]));
    const fallback = config.mailDomains.map((domain) => activeByDomain.get(domain)).find(Boolean);
    if (!fallback) throw new HttpError(404, 'domain_not_found', 'No configured active verified domain is available');
    return fallback;
  }
  const domain = normalizeDomain(requestedDomain);
  if (!config.mailDomains.includes(domain)) {
    throw new HttpError(400, 'unsupported_domain', 'Requested domain is not configured for this Worker');
  }
  const row = await first(db.prepare('SELECT id, domain, status, is_verified FROM domains WHERE lower(domain) = ? AND status = ? AND is_verified = 1').bind(domain, 'active'));
  if (!row) throw new HttpError(404, 'domain_not_found', 'Domain is not active and verified in the database');
  return row;
}

async function authFromBearer(db, token) {
  const sessionHash = await sha256Base64(token);
  const session = await first(db.prepare(`
    SELECT users.id, users.role
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.status = 'active' AND sessions.expires_at > datetime('now') AND users.status = 'active' AND users.deleted_at IS NULL
  `).bind(sessionHash));
  if (session) return { type: 'user', userId: session.id, role: session.role };

  const actor = await verifyApiKey(db, token, 'inboxes:write');
  if (actor) actor.token = token;
  return actor;
}

async function optionalActor(request, db) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  return authFromBearer(db, match[1]);
}

async function requireBearerActor(request, db) {
  const actor = await optionalActor(request, db);
  if (!actor) throw new HttpError(401, 'authentication_required', 'Authentication is required');
  return actor;
}

function assertPrivacyInspectionAllowed(actor, config) {
  if (config?.privacyLock && actor?.role === 'admin') {
    throw new HttpError(403, 'privacy_lock_enabled', 'Privacy lock is enabled. Inbox and message inspection is disabled.');
  }
}

async function requireActorForCreate(request, db, config) {
  const actor = await optionalActor(request, db);
  if (actor) return actor;
  if (config.accessMode === 'public') return null;
  throw new HttpError(401, 'authentication_required', 'Private mode is enabled. Please sign in to use Temp-Mail.');
}

async function inboxTokenMatches(row, token) {
  if (!row.access_token_hash || !token) return false;
  return (await sha256Hex(token)) === row.access_token_hash;
}

async function requireInboxAccess(request, db, inboxId, config) {
  const actor = await optionalActor(request, db);
  const token = request.headers.get('x-inbox-token') || new URL(request.url).searchParams.get('inboxToken');
  const row = await first(db.prepare(`
    SELECT inboxes.*, domains.domain
    FROM inboxes JOIN domains ON domains.id = inboxes.domain_id
    WHERE inboxes.id = ? AND inboxes.status = 'active' AND inboxes.deleted_at IS NULL
  `).bind(inboxId));
  if (!row) throw new HttpError(404, 'inbox_not_found', 'Inbox not found');
  assertPrivacyInspectionAllowed(actor, config);
  if (row.owner_user_id) {
    if (!actor) throw new HttpError(401, 'sign_in_required', 'Sign in to access this inbox');
    if (row.owner_user_id === actor.userId) return { row, actor };
    throw new HttpError(404, 'inbox_not_found', 'Inbox not found or not accessible');
  }
  if (actor?.userId) {
    if (actor.type === 'api_key') throw new HttpError(404, 'inbox_not_found', 'Inbox not found or not accessible');
    return { row, actor };
  }
  if (config?.accessMode === 'public') return { row, actor };
  if (config?.accessMode === 'private') {
    throw new HttpError(401, 'authentication_required', 'Private mode is enabled. Please sign in to use Temp-Mail.');
  }
  if (await inboxTokenMatches(row, token)) return { row, actor };
  throw new HttpError(403, 'inbox_access_denied', 'Inbox token or owner authentication is required');
}

async function requireInboxAddressAccess(request, db, address, config) {
  const actor = await optionalActor(request, db);
  const normalizedAddress = normalizeEmailAddress(address);
  const row = await first(db.prepare(`
    SELECT inboxes.*, domains.domain
    FROM inboxes JOIN domains ON domains.id = inboxes.domain_id
    WHERE lower(inboxes.address) = lower(?) AND inboxes.status = 'active' AND inboxes.deleted_at IS NULL
  `).bind(normalizedAddress));
  if (!row) throw new HttpError(404, 'inbox_not_found', 'Inbox not found or not accessible');
  assertPrivacyInspectionAllowed(actor, config);
  if (row.owner_user_id) {
    if (!actor) throw new HttpError(401, 'sign_in_required', 'Sign in to access this inbox');
    if (row.owner_user_id === actor.userId) return { row, actor };
    throw new HttpError(404, 'inbox_not_found', 'Inbox not found or not accessible');
  }
  if (config?.accessMode === 'public' && actor?.type !== 'api_key') return { row, actor };
  if (!actor && config?.accessMode === 'private') {
    throw new HttpError(401, 'authentication_required', 'Private mode is enabled. Please sign in to use Temp-Mail.');
  }
  throw new HttpError(404, 'inbox_not_found', 'Inbox not found or not accessible');
}

async function handleExistingInbox(request, config, existing, actor) {
  if (existing.status === 'active' && !existing.owner_user_id && config.accessMode === 'public' && actor?.type !== 'api_key') {
    return json(createInboxResponse(existing, { request, openedExisting: true, actor }), { headers: request.responseHeaders });
  }
  if (existing.status === 'active' && actor?.userId && existing.owner_user_id === actor.userId) {
    return json(createInboxResponse(existing, { request, openedExisting: true, actor }), { headers: request.responseHeaders });
  }
  throw new HttpError(409, 'address_unavailable', 'Address is unavailable. Try another address');
}

export async function listDomains(request, env, config) {
  const db = requireDb(env);
  const rows = await all(db.prepare('SELECT domain, status FROM domains WHERE status = ? AND is_verified = 1 ORDER BY domain').bind('active'));
  const activeDomains = new Map(rows.map((row) => [String(row.domain || '').toLowerCase(), row.domain]));
  const domains = config.mailDomains.map((domain) => activeDomains.get(domain)).filter(Boolean);
  return json({ domains }, { headers: request.responseHeaders });
}

export async function createInbox(request, env, config) {
  const db = requireDb(env);
  const body = await readJson(request);
  const actor = await requireActorForCreate(request, db, config);
  await enforceBodySize(request);
  await checkRateLimit(env, { request, action: 'inbox_create', limit: config.rateLimits.inboxCreatePerMinute, subjectType: actor?.type === 'api_key' ? 'api_key' : actor?.userId ? 'user' : 'ip', subject: actor?.token || actor?.userId });
  if (actor?.type === 'api_key') await enforceApiKeyRateLimit(request, env, actor.token);
  let requestedDomain = body.domain;
  let addressLocalPart = null;
  if (body.address) {
    const normalizedAddress = normalizeEmailAddress(body.address);
    const [local, domain] = normalizedAddress.split('@');
    if (body.domain && normalizeDomain(body.domain) !== domain) {
      throw new HttpError(400, 'address_domain_mismatch', 'Address domain must match the requested domain');
    }
    requestedDomain = requestedDomain || domain;
    addressLocalPart = local;
  }
  const domain = await findDomain(db, config, requestedDomain);
  if (body.localPart && addressLocalPart && normalizeLocalPart(body.localPart) !== addressLocalPart) {
    throw new HttpError(400, 'address_local_part_mismatch', 'Address local part must match localPart');
  }
  const localPart = body.localPart ? normalizeLocalPart(body.localPart) : addressLocalPart || randomLocalPart();
  assertLocalPart(localPart);
  const address = `${localPart}@${domain.domain}`;
  const existing = await first(db.prepare(`
    SELECT inboxes.*, domains.domain
    FROM inboxes JOIN domains ON domains.id = inboxes.domain_id
    WHERE lower(inboxes.address) = lower(?) AND inboxes.status != ?
  `).bind(address, 'deleted'));
  if (existing) return handleExistingInbox(request, config, existing, actor);
  const token = randomToken('inbox');
  const tokenHash = await sha256Hex(token);
  const id = makeId('inbox');
  await run(db.prepare(`
    INSERT INTO inboxes (id, domain_id, owner_user_id, address, local_part, access_token_hash, access_token_prefix)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, domain.id, actor?.userId || null, address, localPart, tokenHash, token.slice(0, 18)));
  const row = await first(db.prepare(`SELECT inboxes.*, domains.domain FROM inboxes JOIN domains ON domains.id = inboxes.domain_id WHERE inboxes.id = ?`).bind(id));
  return json(createInboxResponse(row, { request, token, actor }), { status: 201, headers: request.responseHeaders });
}

export async function listInboxes(request, env, config) {
  const db = requireDb(env);
  const actor = await requireBearerActor(request, db);
  assertPrivacyInspectionAllowed(actor, config);
  const rows = await all(db.prepare(`
    SELECT inboxes.*, domains.domain
    FROM inboxes JOIN domains ON domains.id = inboxes.domain_id
    WHERE inboxes.owner_user_id = ? AND inboxes.status = 'active' AND inboxes.deleted_at IS NULL
    ORDER BY inboxes.created_at DESC
  `).bind(actor.userId));
  if (actor.type === 'api_key' && !shouldIncludeMeta(request)) {
    return json({ emails: rows.map((row) => row.address) }, { headers: request.responseHeaders });
  }
  return json({ emails: rows.map((row) => row.address), inboxes: rows.map(publicInbox) }, { headers: request.responseHeaders });
}

export async function listMessages(request, env, config) {
  await checkRateLimit(env, { request, action: 'message_list', limit: Number(env.RATE_LIMIT_MESSAGE_READ_PER_MINUTE || 60), subjectType: 'ip' });
  const db = requireDb(env);
  const inboxId = new URL(request.url).pathname.split('/')[3];
  await requireInboxAccess(request, db, inboxId, config);
  const rows = await all(db.prepare(`
    SELECT id, from_name, from_address, to_address, subject, text_body, html_body, raw_source, size_bytes, has_attachments, is_read, received_at
    FROM messages WHERE inbox_id = ? AND deleted_at IS NULL ORDER BY received_at DESC LIMIT 100
  `).bind(inboxId));
  return json({ messages: rows.map(publicMessageSummary) }, { headers: request.responseHeaders });
}

export async function listMessagesByAddress(request, env, config) {
  await checkRateLimit(env, { request, action: 'message_list', limit: Number(env.RATE_LIMIT_MESSAGE_READ_PER_MINUTE || 60), subjectType: 'ip' });
  const db = requireDb(env);
  const address = new URL(request.url).searchParams.get('address');
  if (!address) throw new HttpError(400, 'address_required', 'address query parameter is required');
  const { row } = await requireInboxAddressAccess(request, db, address, config);
  const rows = await all(db.prepare(`
    SELECT id, from_name, from_address, to_address, subject, text_body, html_body, raw_source, size_bytes, has_attachments, is_read, received_at
    FROM messages WHERE inbox_id = ? AND deleted_at IS NULL ORDER BY received_at DESC LIMIT 100
  `).bind(row.id));
  return json({ email: row.address, inbox: publicInbox(row), messages: rows.map(publicMessageSummary) }, { headers: request.responseHeaders });
}

async function getMessageWithAccess(request, db, messageId, config) {
  const message = await first(db.prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL').bind(messageId));
  if (!message) throw new HttpError(404, 'message_not_found', 'Message not found');
  const access = await requireInboxAccess(request, db, message.inbox_id, config);
  return { message, inbox: access.row, actor: access.actor };
}

export async function viewMessage(request, env, config) {
  await checkRateLimit(env, { request, action: 'message_view', limit: Number(env.RATE_LIMIT_MESSAGE_READ_PER_MINUTE || 60), subjectType: 'ip' });
  const db = requireDb(env);
  const messageId = new URL(request.url).pathname.split('/')[3];
  const { message } = await getMessageWithAccess(request, db, messageId, config);
  await run(db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').bind(message.id));
  const attachments = await listMessageAttachments(db, message.id);
  return json(publicMessageDetail({ ...message, is_read: 1 }, attachments), { headers: request.responseHeaders });
}

export async function viewMessageHtml(request, env, config) {
  await checkRateLimit(env, { request, action: 'message_html', limit: Number(env.RATE_LIMIT_MESSAGE_READ_PER_MINUTE || 60), subjectType: 'ip' });
  const db = requireDb(env);
  const messageId = new URL(request.url).pathname.split('/')[3];
  const { message } = await getMessageWithAccess(request, db, messageId, config);
  const { htmlBody } = readableStoredBodies(message);
  if (!htmlBody) throw new HttpError(404, 'html_not_available', 'HTML body is not available for this message');
  return new Response(htmlBody, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(request.responseHeaders || {}) }
  });
}

export async function deleteMessage(request, env, config) {
  const db = requireDb(env);
  const messageId = new URL(request.url).pathname.split('/')[3];
  const { message, inbox, actor } = await getMessageWithAccess(request, db, messageId, config);
  const token = request.headers.get('x-inbox-token') || new URL(request.url).searchParams.get('inboxToken');
  if (!actor?.userId && !(await inboxTokenMatches(inbox, token))) {
    throw new HttpError(403, 'message_delete_denied', 'Inbox token or owner authentication is required to delete messages');
  }
  await run(db.prepare('UPDATE messages SET deleted_at = datetime(\'now\') WHERE id = ?').bind(message.id));
  await run(db.prepare('UPDATE attachments SET deleted_at = datetime(\'now\') WHERE message_id = ?').bind(message.id));
  return json({ ok: true }, { headers: request.responseHeaders });
}

export async function viewMessageSource(request, env, config) {
  await checkRateLimit(env, { request, action: 'message_source', limit: Number(env.RATE_LIMIT_MESSAGE_READ_PER_MINUTE || 60), subjectType: 'ip' });
  const db = requireDb(env);
  const messageId = new URL(request.url).pathname.split('/')[3];
  const { message, actor } = await getMessageWithAccess(request, db, messageId, config);
  if (!actor?.userId || actor.type === 'api_key') {
    throw new HttpError(403, 'message_source_denied', 'Raw source is available only to authenticated dashboard users');
  }
  return new Response(message.raw_source || '', {
    headers: { 'content-type': 'message/rfc822; charset=utf-8', 'cache-control': 'no-store', ...(request.responseHeaders || {}) }
  });
}

export async function viewAttachment(request, env, config) {
  await checkRateLimit(env, { request, action: 'attachment_download', limit: Number(env.RATE_LIMIT_MESSAGE_READ_PER_MINUTE || 60), subjectType: 'ip' });
  const db = requireDb(env);
  const parts = new URL(request.url).pathname.split('/');
  const messageId = parts[3];
  const attachmentId = parts[5];
  await getMessageWithAccess(request, db, messageId, config);
  const attachment = await first(db.prepare('SELECT * FROM attachments WHERE id = ? AND message_id = ? AND deleted_at IS NULL').bind(attachmentId, messageId));
  if (!attachment) throw new HttpError(404, 'attachment_not_found', 'Attachment not found');
  const bytes = attachment.content_base64 ? Uint8Array.from(atob(attachment.content_base64), (char) => char.charCodeAt(0)) : new Uint8Array();
  return new Response(bytes, {
    headers: {
      'content-type': attachment.content_type || 'application/octet-stream',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${String(attachment.filename || attachment.id).replaceAll('"', '')}"`,
      ...(request.responseHeaders || {})
    }
  });
}
