import { HttpError, json } from './http.js';
import { sha256Base64 } from './auth.js';
import { enforceApiKeyRateLimit, sha256Hex, verifyApiKey } from './api-keys.js';
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
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `mail-${bytesToHex(bytes)}`;
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
    id: row.id,
    address: row.address,
    localPart: row.local_part,
    domain: row.domain,
    status: row.status,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at || null
  };
}

function publicMessage(row) {
  return {
    id: row.id,
    fromName: row.from_name || null,
    fromAddress: row.from_address || null,
    toAddress: row.to_address,
    subject: row.subject || '',
    textBody: row.text_body || null,
    htmlBody: row.html_body || null,
    sizeBytes: row.size_bytes,
    hasAttachments: Boolean(row.has_attachments),
    isRead: Boolean(row.is_read),
    receivedAt: row.received_at
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
  const fallback = config.mailDomains[0];
  const domain = normalizeDomain(requestedDomain || fallback);
  if (!config.mailDomains.includes(domain)) {
    throw new HttpError(400, 'unsupported_domain', 'Requested domain is not configured for this Worker');
  }
  const row = await first(db.prepare('SELECT id, domain, status FROM domains WHERE lower(domain) = ? AND status = ?').bind(domain, 'active'));
  if (!row) throw new HttpError(404, 'domain_not_found', 'Domain is not active in the database');
  return row;
}

async function authFromBearer(db, token) {
  const sessionHash = await sha256Base64(token);
  const session = await first(db.prepare(`
    SELECT users.id, users.role
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.status = 'active' AND sessions.expires_at > datetime('now') AND users.status = 'active'
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

async function requireActorForCreate(request, db, config) {
  const actor = await optionalActor(request, db);
  if (actor) return actor;
  if (config.accessMode === 'public') return null;
  throw new HttpError(401, 'authentication_required', 'Private mode requires a logged-in user or valid scoped API key to create inboxes');
}

async function inboxTokenMatches(row, token) {
  if (!row.access_token_hash || !token) return false;
  return (await sha256Hex(token)) === row.access_token_hash;
}

async function requireInboxAccess(request, db, inboxId) {
  const actor = await optionalActor(request, db);
  const token = request.headers.get('x-inbox-token') || new URL(request.url).searchParams.get('inboxToken');
  const row = await first(db.prepare(`
    SELECT inboxes.*, domains.domain
    FROM inboxes JOIN domains ON domains.id = inboxes.domain_id
    WHERE inboxes.id = ? AND inboxes.status = 'active'
  `).bind(inboxId));
  if (!row) throw new HttpError(404, 'inbox_not_found', 'Inbox not found');
  if (actor?.userId && row.owner_user_id && actor.userId === row.owner_user_id) return { row, actor };
  if (await inboxTokenMatches(row, token)) return { row, actor };
  throw new HttpError(403, 'inbox_access_denied', 'Inbox token or owner authentication is required');
}

export async function listDomains(request, env, config) {
  const db = requireDb(env);
  const rows = await all(db.prepare('SELECT domain, status FROM domains WHERE status = ? ORDER BY domain').bind('active'));
  const domains = rows.map((row) => row.domain).filter((domain) => config.mailDomains.includes(domain));
  return json({ domains }, { headers: request.responseHeaders });
}

export async function createInbox(request, env, config) {
  const db = requireDb(env);
  const body = await readJson(request);
  const actor = await requireActorForCreate(request, db, config);
  await enforceBodySize(request);
  await checkRateLimit(env, { request, action: 'inbox_create', limit: config.rateLimits.inboxCreatePerMinute, subjectType: actor?.type === 'api_key' ? 'api_key' : actor?.userId ? 'user' : 'ip', subject: actor?.token || actor?.userId });
  if (actor?.type === 'api_key') await enforceApiKeyRateLimit(request, env, actor.token);
  const domain = await findDomain(db, config, body.domain);
  if (body.address) normalizeEmailAddress(body.address);
  const localPart = body.localPart || body.address ? normalizeLocalPart(body.localPart || String(body.address).split('@')[0]) : randomLocalPart();
  assertLocalPart(localPart);
  const address = `${localPart}@${domain.domain}`;
  const existing = await first(db.prepare('SELECT id FROM inboxes WHERE lower(address) = lower(?) AND status != ?').bind(address, 'deleted'));
  if (existing) throw new HttpError(409, 'inbox_exists', 'Inbox address already exists');
  const token = randomToken('inbox');
  const tokenHash = await sha256Hex(token);
  const id = makeId('inbox');
  await run(db.prepare(`
    INSERT INTO inboxes (id, domain_id, owner_user_id, address, local_part, access_token_hash, access_token_prefix)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, domain.id, actor?.userId || null, address, localPart, tokenHash, token.slice(0, 18)));
  const row = await first(db.prepare(`SELECT inboxes.*, domains.domain FROM inboxes JOIN domains ON domains.id = inboxes.domain_id WHERE inboxes.id = ?`).bind(id));
  return json({ inbox: publicInbox(row), inboxToken: token }, { status: 201, headers: request.responseHeaders });
}

export async function listMessages(request, env) {
  await checkRateLimit(env, { request, action: 'message_list', limit: Number(env.RATE_LIMIT_MESSAGE_READ_PER_MINUTE || 60), subjectType: 'ip' });
  const db = requireDb(env);
  const inboxId = new URL(request.url).pathname.split('/')[3];
  await requireInboxAccess(request, db, inboxId);
  const rows = await all(db.prepare(`
    SELECT id, from_name, from_address, to_address, subject, size_bytes, has_attachments, is_read, received_at
    FROM messages WHERE inbox_id = ? AND deleted_at IS NULL ORDER BY received_at DESC LIMIT 100
  `).bind(inboxId));
  return json({ messages: rows.map(publicMessage) }, { headers: request.responseHeaders });
}

async function getMessageWithAccess(request, db, messageId) {
  const message = await first(db.prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL').bind(messageId));
  if (!message) throw new HttpError(404, 'message_not_found', 'Message not found');
  const access = await requireInboxAccess(request, db, message.inbox_id);
  return { message, inbox: access.row };
}

export async function viewMessage(request, env) {
  await checkRateLimit(env, { request, action: 'message_view', limit: Number(env.RATE_LIMIT_MESSAGE_READ_PER_MINUTE || 60), subjectType: 'ip' });
  const db = requireDb(env);
  const messageId = new URL(request.url).pathname.split('/')[3];
  const { message } = await getMessageWithAccess(request, db, messageId);
  await run(db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').bind(message.id));
  const attachments = await all(db.prepare('SELECT id, filename, content_type, size_bytes, created_at FROM attachments WHERE message_id = ? AND deleted_at IS NULL ORDER BY created_at').bind(message.id));
  return json({ message: publicMessage({ ...message, is_read: 1 }), attachments }, { headers: request.responseHeaders });
}

export async function deleteMessage(request, env) {
  const db = requireDb(env);
  const messageId = new URL(request.url).pathname.split('/')[3];
  const { message } = await getMessageWithAccess(request, db, messageId);
  await run(db.prepare('UPDATE messages SET deleted_at = datetime(\'now\') WHERE id = ?').bind(message.id));
  await run(db.prepare('UPDATE attachments SET deleted_at = datetime(\'now\') WHERE message_id = ?').bind(message.id));
  return json({ ok: true }, { headers: request.responseHeaders });
}

export async function viewMessageSource(request, env) {
  await checkRateLimit(env, { request, action: 'message_source', limit: Number(env.RATE_LIMIT_MESSAGE_READ_PER_MINUTE || 60), subjectType: 'ip' });
  const db = requireDb(env);
  const messageId = new URL(request.url).pathname.split('/')[3];
  const { message } = await getMessageWithAccess(request, db, messageId);
  return new Response(message.raw_source || '', {
    headers: { 'content-type': 'message/rfc822; charset=utf-8', 'cache-control': 'no-store', ...(request.responseHeaders || {}) }
  });
}

export async function viewAttachment(request, env) {
  await checkRateLimit(env, { request, action: 'attachment_download', limit: Number(env.RATE_LIMIT_MESSAGE_READ_PER_MINUTE || 60), subjectType: 'ip' });
  const db = requireDb(env);
  const parts = new URL(request.url).pathname.split('/');
  const messageId = parts[3];
  const attachmentId = parts[5];
  await getMessageWithAccess(request, db, messageId);
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
