import { HttpError } from './http.js';
import { checkRateLimit, enforceBodySize } from './security.js';

const KEY_BYTES = 32;
const ALLOWED_SCOPES = new Set(['inboxes:write', 'inboxes:*']);

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

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function randomApiKey() {
  const bytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  return `rdhx_${bytesToHex(bytes)}`;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

function normalizeName(name) {
  const value = String(name || '').trim();
  if (value.length < 1 || value.length > 80) throw new HttpError(400, 'invalid_name', 'API key name must be 1-80 characters');
  return value;
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) throw new HttpError(400, 'invalid_scopes', 'At least one scope is required');
  const unique = [...new Set(scopes.map((scope) => String(scope || '').trim()).filter(Boolean))];
  if (unique.length === 0 || unique.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    throw new HttpError(400, 'invalid_scopes', 'Unsupported API key scope');
  }
  return unique;
}

function publicKey(row) {
  let scopes = [];
  try { scopes = JSON.parse(row.scopes || '[]'); } catch { scopes = []; }
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username || null,
    ownerStatus: row.owner_status || null,
    createdByUserId: row.created_by_user_id || null,
    name: row.name,
    prefix: row.key_prefix,
    scopes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at || null,
    expiresAt: row.expires_at || null,
    revokedAt: row.revoked_at || null
  };
}

async function ensureActiveOwner(db, userId) {
  const user = await db.prepare('SELECT id, username, role, status FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first();
  if (!user || user.status !== 'active') throw new HttpError(404, 'owner_not_found', 'API key owner must be an active user');
  return user;
}

export async function createApiKey(request, env, adminUser) {
  await enforceBodySize(request);
  const db = requireDb(env);
  const body = await readJson(request);
  const owner = await ensureActiveOwner(db, body.ownerUserId);
  const scopes = normalizeScopes(body.scopes);
  const key = randomApiKey();
  const prefix = key.slice(0, 14);
  const id = makeId('ak');
  await db.prepare(`INSERT INTO api_keys (id, owner_user_id, created_by_user_id, name, key_hash, key_prefix, scopes)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, owner.id, adminUser.id, normalizeName(body.name || `${owner.username} automation`), await sha256Hex(key), prefix, JSON.stringify(scopes)).run();
  const row = await db.prepare(`SELECT api_keys.*, users.username AS owner_username, users.status AS owner_status FROM api_keys JOIN users ON users.id = api_keys.owner_user_id WHERE api_keys.id = ?`).bind(id).first();
  return { apiKey: publicKey(row), key };
}

export async function listApiKeys(_request, env) {
  const result = await requireDb(env).prepare(`SELECT api_keys.*, users.username AS owner_username, users.status AS owner_status FROM api_keys JOIN users ON users.id = api_keys.owner_user_id ORDER BY api_keys.created_at DESC`).all();
  return { apiKeys: (result.results || []).map(publicKey) };
}

export async function resetApiKey(_request, env, keyId) {
  const db = requireDb(env);
  const existing = await db.prepare(`SELECT api_keys.id, api_keys.status, users.status AS owner_status, users.deleted_at AS owner_deleted_at
    FROM api_keys JOIN users ON users.id = api_keys.owner_user_id
    WHERE api_keys.id = ?`).bind(keyId).first();
  if (!existing) throw new HttpError(404, 'api_key_not_found', 'API key not found');
  if (existing.status !== 'active') {
    throw new HttpError(409, 'api_key_not_active', 'Only active API keys can be reset');
  }
  if (existing.owner_status !== 'active' || existing.owner_deleted_at) {
    throw new HttpError(404, 'owner_not_found', 'API key owner must be an active user');
  }
  const key = randomApiKey();
  const result = await db.prepare("UPDATE api_keys SET key_hash = ?, key_prefix = ?, updated_at = datetime('now') WHERE id = ? AND status = 'active'")
    .bind(await sha256Hex(key), key.slice(0, 14), keyId).run();
  if (result.meta?.changes === 0) {
    throw new HttpError(409, 'api_key_not_active', 'Only active API keys can be reset');
  }
  const row = await db.prepare(`SELECT api_keys.*, users.username AS owner_username, users.status AS owner_status FROM api_keys JOIN users ON users.id = api_keys.owner_user_id WHERE api_keys.id = ?`).bind(keyId).first();
  return { apiKey: publicKey(row), key };
}

export async function revokeApiKey(_request, env, keyId) {
  const result = await requireDb(env).prepare(`UPDATE api_keys SET status = 'revoked', revoked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(keyId).run();
  if (result.meta?.changes === 0) throw new HttpError(404, 'api_key_not_found', 'API key not found');
  return { ok: true };
}

export async function verifyApiKey(db, token, requiredScope) {
  const key = await db.prepare(`SELECT api_keys.id, api_keys.owner_user_id, api_keys.scopes
    FROM api_keys JOIN users ON users.id = api_keys.owner_user_id
    WHERE api_keys.key_hash = ?
      AND api_keys.status = 'active'
      AND (api_keys.expires_at IS NULL OR api_keys.expires_at > datetime('now'))
      AND users.status = 'active'
      AND users.deleted_at IS NULL`).bind(await sha256Hex(token)).first();
  if (!key) return null;
  let scopes = [];
  try { scopes = JSON.parse(key.scopes || '[]'); } catch { scopes = []; }
  if (requiredScope && !scopes.includes(requiredScope) && !scopes.includes('inboxes:*')) {
    throw new HttpError(403, 'insufficient_scope', 'API key is missing required scope');
  }
  await db.prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?').bind(key.id).run();
  return { type: 'api_key', apiKeyId: key.id, userId: key.owner_user_id, role: 'member', scopes };
}

export async function enforceApiKeyRateLimit(request, env, token) {
  return checkRateLimit(env, { request, action: 'api_key_use', limit: Number(env.RATE_LIMIT_API_PER_MINUTE || 120), subjectType: 'api_key', subject: token });
}
