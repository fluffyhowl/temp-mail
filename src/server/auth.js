import { HttpError } from './http.js';
import { checkRateLimit, enforceBodySize } from './security.js';

const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 210000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes) {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    output += BASE64_ALPHABET[(triplet >> 18) & 63];
    output += BASE64_ALPHABET[(triplet >> 12) & 63];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(triplet >> 6) & 63] : '=';
    output += index + 2 < bytes.length ? BASE64_ALPHABET[triplet & 63] : '=';
  }
  return output;
}

function base64ToBytes(value) {
  const clean = String(value).replace(/=+$/g, '');
  const bytes = [];
  for (let index = 0; index < clean.length; index += 4) {
    const chunk = clean.slice(index, index + 4).padEnd(4, 'A');
    const n = (BASE64_ALPHABET.indexOf(chunk[0]) << 18)
      | (BASE64_ALPHABET.indexOf(chunk[1]) << 12)
      | (BASE64_ALPHABET.indexOf(chunk[2]) << 6)
      | BASE64_ALPHABET.indexOf(chunk[3]);
    bytes.push((n >> 16) & 255);
    if (index + 2 < clean.length) bytes.push((n >> 8) & 255);
    if (index + 3 < clean.length) bytes.push(n & 255);
  }
  return new Uint8Array(bytes);
}

function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function id(prefix) {
  return `${prefix}_${randomToken(18)}`;
}

function normalizeUsername(username) {
  const value = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(value)) {
    throw new HttpError(400, 'invalid_username', 'Username must be 3-32 lowercase letters, numbers, dots, underscores, or hyphens');
  }
  return value;
}

function requirePassword(password) {
  const value = String(password || '');
  if (value.length < 10 || value.length > 256) {
    throw new HttpError(400, 'invalid_password', 'Password must be between 10 and 256 characters');
  }
  return value;
}

export async function sha256Base64(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToBase64(new Uint8Array(digest));
}

export async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey('raw', encoder.encode(requirePassword(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return {
    hash: bytesToBase64(new Uint8Array(bits)),
    salt: bytesToBase64(salt),
    algorithm: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS
  };
}

export async function verifyPassword(password, user) {
  if (!user || user.password_algorithm !== 'PBKDF2-SHA256') return false;
  const salt = base64ToBytes(user.password_salt);
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(password || '')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: user.password_iterations }, key, 256);
  return bytesToBase64(new Uint8Array(bits)) === user.password_hash;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

function requireDb(env) {
  if (!env.DB) throw new HttpError(500, 'database_not_configured', 'D1 database binding DB is required');
  return env.DB;
}

async function findUserByUsername(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL').bind(username).first();
}

async function findUserById(db, userId) {
  return db.prepare('SELECT id, username, role, status, created_at, updated_at, disabled_at, last_login_at FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first();
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    disabledAt: user.disabled_at || null,
    lastLoginAt: user.last_login_at || null
  };
}

async function createUser(db, { username, password, role = 'member' }) {
  const normalized = normalizeUsername(username);
  if (!['admin', 'member'].includes(role)) throw new HttpError(400, 'invalid_role', 'Role must be admin or member');
  const existing = await findUserByUsername(db, normalized);
  if (existing) throw new HttpError(409, 'username_exists', 'Username already exists');
  const passwordRecord = await hashPassword(password);
  const userId = id('usr');
  await db.prepare(`INSERT INTO users (id, username, role, password_hash, password_salt, password_algorithm, password_iterations)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(userId, normalized, role, passwordRecord.hash, passwordRecord.salt, passwordRecord.algorithm, passwordRecord.iterations).run();
  return findUserById(db, userId);
}

async function issueSession(db, user, request) {
  const token = randomToken(36);
  const sessionId = id('ses');
  const tokenHash = await sha256Base64(token);
  const tokenPrefix = token.slice(0, 12);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  const userAgent = request.headers.get('user-agent') || '';
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, token_prefix, user_agent_hash, ip_hash, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(sessionId, user.id, tokenHash, tokenPrefix, await sha256Base64(userAgent), await sha256Base64(ip), expiresAt).run();
  await db.prepare('UPDATE users SET last_login_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?').bind(user.id).run();
  return { token, expiresAt };
}

function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

export async function requireUser(request, env) {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, 'authentication_required', 'Authentication is required');
  const db = requireDb(env);
  const tokenHash = await sha256Base64(token);
  const row = await db.prepare(`SELECT u.id, u.username, u.role, u.status, u.created_at, u.updated_at, u.disabled_at, u.last_login_at, s.id AS session_id
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.status = 'active' AND s.expires_at > datetime('now') AND u.deleted_at IS NULL`).bind(tokenHash).first();
  if (!row || row.status !== 'active') throw new HttpError(401, 'authentication_required', 'Authentication is required');
  await db.prepare('UPDATE sessions SET last_used_at = datetime(\'now\') WHERE id = ?').bind(row.session_id).run();
  return row;
}

export async function requireRole(request, env, role) {
  const user = await requireUser(request, env);
  if (user.role !== role) throw new HttpError(403, 'forbidden', 'Insufficient role');
  return user;
}

export async function bootstrapAdmin(request, env, config) {
  await enforceBodySize(request);
  const db = requireDb(env);
  const secret = request.headers.get('x-admin-bootstrap-secret');
  if (!secret || secret !== config.adminBootstrap.secret) throw new HttpError(403, 'bootstrap_forbidden', 'Invalid admin bootstrap secret');
  const body = await readJson(request);
  const adminCount = await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND deleted_at IS NULL").first();
  if (Number(adminCount?.count || 0) > 0) throw new HttpError(409, 'admin_exists', 'Admin user already exists');
  const user = await createUser(db, { username: body.username, password: body.password, role: 'admin' });
  return { user: publicUser(user) };
}

export async function login(request, env) {
  await enforceBodySize(request);
  await checkRateLimit(env, { request, action: 'login', limit: Number(env.RATE_LIMIT_LOGIN_PER_MINUTE || 5), subjectType: 'ip' });
  const db = requireDb(env);
  const body = await readJson(request);
  const username = normalizeUsername(body.username);
  const user = await findUserByUsername(db, username);
  if (!user || user.status !== 'active' || !(await verifyPassword(body.password, user))) {
    throw new HttpError(401, 'invalid_credentials', 'Invalid username or password');
  }
  const session = await issueSession(db, user, request);
  return { token: session.token, expiresAt: session.expiresAt, user: publicUser(user) };
}

export async function logout(request, env) {
  const token = bearerToken(request);
  if (!token) return { ok: true };
  const db = requireDb(env);
  await db.prepare("UPDATE sessions SET status = 'revoked', revoked_at = datetime('now') WHERE token_hash = ?").bind(await sha256Base64(token)).run();
  return { ok: true };
}

export async function listUsers(_request, env) {
  const db = requireDb(env);
  const result = await db.prepare('SELECT id, username, role, status, created_at, updated_at, disabled_at, last_login_at FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC').all();
  return { users: (result.results || []).map(publicUser) };
}

export async function adminCreateUser(request, env) {
  await enforceBodySize(request);
  const body = await readJson(request);
  const user = await createUser(requireDb(env), { username: body.username, password: body.password, role: body.role || 'member' });
  return { user: publicUser(user) };
}

export async function adminResetPassword(request, env, userId) {
  await enforceBodySize(request);
  const body = await readJson(request);
  const passwordRecord = await hashPassword(body.password);
  await requireDb(env).prepare(`UPDATE users SET password_hash = ?, password_salt = ?, password_algorithm = ?, password_iterations = ?, password_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`)
    .bind(passwordRecord.hash, passwordRecord.salt, passwordRecord.algorithm, passwordRecord.iterations, userId).run();
  return { ok: true };
}

async function findManageableUserById(db, userId) {
  const user = await db.prepare('SELECT id, username, role, status FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first();
  if (!user) throw new HttpError(404, 'user_not_found', 'User not found');
  return user;
}

async function countOtherActiveAdmins(db, userId) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL AND id != ?").bind(userId).first();
  return Number(row?.count || 0);
}

export async function adminDisableUser(_request, env, userId, adminUser) {
  const db = requireDb(env);
  const user = await findManageableUserById(db, userId);
  if (adminUser?.id === user.id) {
    throw new HttpError(400, 'self_disable_forbidden', 'You cannot disable your own admin account');
  }
  if (user.role === 'admin' && user.status === 'active' && (await countOtherActiveAdmins(db, user.id)) < 1) {
    throw new HttpError(409, 'last_admin_required', 'At least one active admin must remain');
  }
  await db.prepare("UPDATE users SET status = 'disabled', disabled_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").bind(userId).run();
  await db.prepare("UPDATE sessions SET status = 'revoked', revoked_at = datetime('now') WHERE user_id = ? AND status = 'active'").bind(userId).run();
  return { ok: true };
}

export async function adminEnableUser(_request, env, userId) {
  const db = requireDb(env);
  await findManageableUserById(db, userId);
  await db.prepare("UPDATE users SET status = 'active', disabled_at = NULL, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").bind(userId).run();
  return { ok: true };
}
