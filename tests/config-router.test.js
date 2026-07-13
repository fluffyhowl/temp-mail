import assert from 'node:assert/strict';
import { loadConfig, publicConfig } from '../src/server/config.js';
import { handleApi } from '../src/server/router.js';
import { handleInboundEmail } from '../src/server/email.js';
import { cleanupExpiredMessages } from '../src/server/jobs.js';

const secret = '0123456789abcdef0123456789abcdef';

function env(overrides = {}) {
  return {
    ACCESS_MODE: 'public',
    MAIL_DOMAINS: 'rdhx.email, mail.rdhx.email',
    MESSAGE_RETENTION_DAYS: '1',
    SESSION_SECRET: secret,
    JWT_SECRET: `${secret}jwt`,
    ADMIN_BOOTSTRAP_SECRET: `${secret}admin`,
    CORS_PUBLIC_ORIGINS: '*',
    CORS_PRIVATE_ORIGINS: 'https://app.rdhx.email',
    CORS_ADMIN_ORIGINS: 'https://admin.rdhx.email',
    RATE_LIMIT_LOGIN_PER_MINUTE: '5',
    RATE_LIMIT_INBOX_CREATE_PER_MINUTE: '20',
    RATE_LIMIT_API_PER_MINUTE: '120',
    RATE_LIMIT_MESSAGE_READ_PER_MINUTE: '60',
    ...overrides
  };
}

function makeDb() {
  const state = {
    domains: [{ id: 'domain_1', domain: 'rdhx.email', status: 'active', is_verified: 1 }],
    inboxes: [],
    messages: [],
    attachments: [],
    settings: [],
    rateLimits: []
  };
  function statement(sql) {
    let params = [];
    return {
      bind(...values) { params = values; return this; },
      async first() {
        if (sql.includes('FROM domains WHERE lower(domain)')) return state.domains.find((row) => row.domain === params[0] && row.status === params[1] && row.is_verified === 1) || null;
        if (sql.includes('FROM app_settings WHERE key')) return state.settings.find((row) => row.key === params[0]) || null;
        if (sql.includes('SELECT id FROM inboxes WHERE lower(address)')) return state.inboxes.find((row) => row.address.toLowerCase() === String(params[0]).toLowerCase() && row.status !== params[1]) || null;
        if (sql.includes('FROM inboxes JOIN domains') && sql.includes('WHERE lower(inboxes.address)')) {
          const inbox = state.inboxes.find((row) => row.address.toLowerCase() === String(params[0]).toLowerCase() && row.status === 'active' && !row.deleted_at);
          const domain = inbox && state.domains.find((row) => row.id === inbox.domain_id);
          return inbox ? { ...inbox, domain: domain?.domain || 'rdhx.email' } : null;
        }
        if (sql.includes('FROM inboxes JOIN domains') && sql.includes('WHERE inboxes.id')) {
          const inbox = state.inboxes.find((row) => row.id === params[0] && (!sql.includes("inboxes.status = 'active'") || row.status === 'active'));
          const domain = inbox && state.domains.find((row) => row.id === inbox.domain_id);
          return inbox ? { ...inbox, domain: domain?.domain || 'rdhx.email' } : null;
        }
        if (sql.includes('SELECT * FROM messages WHERE id')) return state.messages.find((row) => row.id === params[0] && !row.deleted_at) || null;
        if (sql.includes('SELECT * FROM attachments WHERE id')) return state.attachments.find((row) => row.id === params[0] && row.message_id === params[1] && !row.deleted_at) || null;
        if (sql.startsWith('SELECT request_count, blocked_until FROM rate_limits')) return state.rateLimits.find((row) => row.bucket_key === params[0] && row.window_start === params[1]) || null;
        return null;
      },
      async all() {
        if (sql.includes('FROM domains WHERE status')) return { results: state.domains.filter((row) => row.status === params[0] && (!sql.includes('is_verified = 1') || row.is_verified === 1)) };
        if (sql.includes('FROM messages WHERE inbox_id')) return { results: state.messages.filter((row) => row.inbox_id === params[0] && !row.deleted_at) };
        if (sql.includes('FROM attachments WHERE message_id')) return { results: state.attachments.filter((row) => row.message_id === params[0] && !row.deleted_at) };
        return { results: [] };
      },
      async run() {
        if (sql.includes('INSERT INTO inboxes')) {
          state.inboxes.push({ id: params[0], domain_id: params[1], owner_user_id: params[2], address: params[3], local_part: params[4], access_token_hash: params[5], access_token_prefix: params[6], status: 'active', created_at: '2026-06-28 00:00:00', last_message_at: null });
        }
        if (sql.startsWith('INSERT INTO app_settings')) {
          const existing = state.settings.find((row) => row.key === 'access_mode');
          if (existing) existing.value = params[0];
          else state.settings.push({ key: 'access_mode', value: params[0] });
        }
        if (sql.includes('UPDATE messages SET is_read')) {
          const message = state.messages.find((row) => row.id === params[0]);
          if (message) message.is_read = 1;
        }
        if (sql.includes('UPDATE messages SET deleted_at')) {
          const message = state.messages.find((row) => row.id === params[0]);
          if (message) message.deleted_at = '2026-06-28 00:00:00';
        }
        if (sql.startsWith('INSERT INTO rate_limits')) {
          const [id, bucket_key, subject_type, subject_hash, action, window_start, window_seconds, request_count, blocked_until] = params;
          state.rateLimits.push({ id, bucket_key, subject_type, subject_hash, action, window_start, window_seconds, request_count, blocked_until });
        }
        if (sql.startsWith('UPDATE rate_limits SET request_count')) {
          const [request_count, blocked_until, bucket_key, window_start] = params;
          const row = state.rateLimits.find((item) => item.bucket_key === bucket_key && item.window_start === window_start);
          if (row) Object.assign(row, { request_count, blocked_until });
        }
        return { success: true };
      }
    };
  }
  return { state, prepare: statement };
}

class MemoryDb {
  constructor() {
    this.users = [];
    this.sessions = [];
    this.domains = [{ id: 'domain_1', domain: 'rdhx.email', status: 'active', is_verified: 1 }];
    this.inboxes = [];
    this.messages = [];
    this.attachments = [];
    this.apiKeys = [];
    this.settings = [];
    this.rateLimits = [];
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }
}

class MemoryStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, ' ').trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    const sql = this.sql;
    if (sql.startsWith('SELECT * FROM users WHERE username')) return this.db.users.find((user) => user.username === this.values[0] && !user.deleted_at) || null;
    if (sql.includes('FROM app_settings WHERE key')) return this.db.settings.find((row) => row.key === this.values[0]) || null;
    if (sql.startsWith('SELECT id, username, role, status') && sql.includes('WHERE id = ?')) return this.db.users.find((user) => user.id === this.values[0] && !user.deleted_at) || null;
    if (sql.includes('COUNT(*) AS count FROM users')) return { count: this.db.users.filter((user) => user.role === 'admin' && !user.deleted_at).length };
    if (sql.startsWith('SELECT u.id, u.username')) {
      const session = this.db.sessions.find((item) => item.token_hash === this.values[0] && item.status === 'active' && new Date(item.expires_at) > new Date());
      if (!session) return null;
      const user = this.db.users.find((item) => item.id === session.user_id && !item.deleted_at);
      if (!user) return null;
      return { ...user, session_id: session.id };
    }
    if (sql.includes('FROM domains WHERE lower(domain)')) return this.db.domains.find((row) => row.domain === this.values[0] && row.status === this.values[1] && row.is_verified === 1) || null;
    if (sql.includes('SELECT id FROM inboxes WHERE lower(address)')) return this.db.inboxes.find((row) => row.address.toLowerCase() === String(this.values[0]).toLowerCase() && row.status !== this.values[1]) || null;
    if (sql.includes('FROM sessions JOIN users')) {
      const session = this.db.sessions.find((item) => item.token_hash === this.values[0] && item.status === 'active' && new Date(item.expires_at) > new Date());
      if (!session) return null;
      const user = this.db.users.find((item) => item.id === session.user_id && item.status === 'active' && !item.deleted_at);
      return user ? { id: user.id, role: user.role } : null;
    }
    if (sql.startsWith('SELECT api_keys.id, api_keys.status, api_keys.scopes')) {
      const key = this.db.apiKeys.find((item) => item.id === this.values[0]);
      const owner = key && this.db.users.find((user) => user.id === key.owner_user_id);
      return key ? { id: key.id, status: key.status, scopes: key.scopes, owner_status: owner?.status || null, owner_deleted_at: owner?.deleted_at || null } : null;
    }
    if (sql.includes('SELECT api_keys.*, users.username AS owner_username') && sql.includes('WHERE api_keys.id')) {
      const key = this.db.apiKeys.find((item) => item.id === this.values[0]);
      const owner = key && this.db.users.find((user) => user.id === key.owner_user_id);
      return key ? { ...key, owner_username: owner?.username || null } : null;
    }
    if (sql.includes('FROM api_keys')) return this.db.apiKeys.find((key) => key.key_hash === this.values[0] && key.status === 'active') || null;
    if (sql.startsWith('SELECT request_count, blocked_until FROM rate_limits')) return this.db.rateLimits.find((row) => row.bucket_key === this.values[0] && row.window_start === this.values[1]) || null;
    if (sql.startsWith('SELECT id, username, role, status FROM users')) return this.db.users.find((user) => user.id === this.values[0] && !user.deleted_at) || null;
    if (sql.includes('FROM inboxes JOIN domains') && sql.includes('WHERE lower(inboxes.address)')) {
      const inbox = this.db.inboxes.find((row) => row.address.toLowerCase() === String(this.values[0]).toLowerCase() && row.status === 'active' && !row.deleted_at);
      const domain = inbox && this.db.domains.find((row) => row.id === inbox.domain_id);
      return inbox ? { ...inbox, domain: domain?.domain || 'rdhx.email' } : null;
    }
    if (sql.includes('FROM inboxes JOIN domains') && sql.includes('WHERE inboxes.id')) {
      const inbox = this.db.inboxes.find((row) => row.id === this.values[0] && (!sql.includes("inboxes.status = 'active'") || row.status === 'active'));
      const domain = inbox && this.db.domains.find((row) => row.id === inbox.domain_id);
      return inbox ? { ...inbox, domain: domain?.domain || 'rdhx.email' } : null;
    }
    if (sql.includes('SELECT * FROM messages WHERE id')) return this.db.messages.find((row) => row.id === this.values[0] && !row.deleted_at) || null;
    if (sql.startsWith('SELECT inboxes.id, inboxes.address')) {
      const inbox = this.db.inboxes.find((row) => row.local_part === this.values[0] && row.status === 'active' && !row.deleted_at);
      return inbox ? { ...inbox, domain_status: 'active' } : null;
    }
    throw new Error(`Unhandled first SQL: ${sql}`);
  }

  async all() {
    if (this.sql.includes('FROM domains WHERE status')) {
      return { results: this.db.domains.filter((row) => row.status === this.values[0] && (!this.sql.includes('is_verified = 1') || row.is_verified === 1)) };
    }
    if (this.sql.startsWith('SELECT id, username, role, status')) {
      return { results: this.db.users.filter((user) => !user.deleted_at).map((user) => ({ ...user })) };
    }
    if (this.sql.includes('SELECT api_keys.*, users.username AS owner_username')) {
      return { results: this.db.apiKeys.map((key) => ({ ...key, owner_username: this.db.users.find((user) => user.id === key.owner_user_id)?.username || null })) };
    }
    if (this.sql.includes('FROM inboxes JOIN domains') && this.sql.includes('WHERE inboxes.owner_user_id')) {
      return { results: this.db.inboxes.filter((row) => row.owner_user_id === this.values[0] && row.status === 'active' && !row.deleted_at).map((row) => ({ ...row, domain: this.db.domains.find((domain) => domain.id === row.domain_id)?.domain || 'rdhx.email' })) };
    }
    if (this.sql.includes('FROM messages WHERE inbox_id')) {
      return { results: this.db.messages.filter((row) => row.inbox_id === this.values[0] && !row.deleted_at) };
    }
    if (this.sql.startsWith('SELECT id FROM messages')) {
      return { results: this.db.messages.filter((message) => new Date(message.received_at) < new Date('2026-06-27T00:00:00Z')).map((message) => ({ id: message.id })) };
    }
    throw new Error(`Unhandled all SQL: ${this.sql}`);
  }

  async run() {
    const sql = this.sql;
    if (sql.startsWith('INSERT INTO users')) {
      const [id, username, role, password_hash, password_salt, password_algorithm, password_iterations] = this.values;
      this.db.users.push({ id, username, role, password_hash, password_salt, password_algorithm, password_iterations, status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), disabled_at: null, deleted_at: null, last_login_at: null });
      return { success: true };
    }
    if (sql.startsWith('INSERT INTO sessions')) {
      const [id, user_id, token_hash, token_prefix, user_agent_hash, ip_hash, expires_at] = this.values;
      this.db.sessions.push({ id, user_id, token_hash, token_prefix, user_agent_hash, ip_hash, status: 'active', expires_at, revoked_at: null, last_used_at: null });
      return { success: true };
    }
    if (sql.startsWith('UPDATE users SET last_login_at')) return { success: true };
    if (sql.startsWith('UPDATE sessions SET last_used_at')) return { success: true };
    if (sql.startsWith('UPDATE api_keys SET last_used_at')) return { success: true };
    if (sql.startsWith('INSERT INTO app_settings')) {
      const existing = this.db.settings.find((row) => row.key === 'access_mode');
      if (existing) existing.value = this.values[0];
      else this.db.settings.push({ key: 'access_mode', value: this.values[0] });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.startsWith('INSERT INTO api_keys')) {
      const [id, owner_user_id, created_by_user_id, name, key_hash, key_prefix, scopes] = this.values;
      this.db.apiKeys.push({ id, owner_user_id, created_by_user_id, name, key_hash, key_prefix, scopes, status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_used_at: null, expires_at: null, revoked_at: null });
      return { success: true };
    }
    if (sql.startsWith('UPDATE api_keys SET key_hash')) {
      const [key_hash, key_prefix, scopes, id] = this.values;
      const key = this.db.apiKeys.find((item) => item.id === id);
      Object.assign(key, { key_hash, key_prefix, scopes, status: 'active', revoked_at: null, updated_at: new Date().toISOString() });
      return { success: true, meta: { changes: key ? 1 : 0 } };
    }
    if (sql.startsWith('UPDATE api_keys SET status = \'revoked\'')) {
      const key = this.db.apiKeys.find((item) => item.id === this.values[0]);
      if (key) Object.assign(key, { status: 'revoked', revoked_at: new Date().toISOString() });
      return { success: true, meta: { changes: key ? 1 : 0 } };
    }
    if (sql.startsWith('INSERT INTO rate_limits')) {
      const [id, bucket_key, subject_type, subject_hash, action, window_start, window_seconds, request_count, blocked_until] = this.values;
      this.db.rateLimits.push({ id, bucket_key, subject_type, subject_hash, action, window_start, window_seconds, request_count, blocked_until });
      return { success: true };
    }
    if (sql.startsWith('UPDATE rate_limits SET request_count')) {
      const [request_count, blocked_until, bucket_key, window_start] = this.values;
      const row = this.db.rateLimits.find((item) => item.bucket_key === bucket_key && item.window_start === window_start);
      if (row) Object.assign(row, { request_count, blocked_until });
      return { success: true };
    }
    if (sql.includes('INSERT INTO inboxes')) {
      this.db.inboxes.push({ id: this.values[0], domain_id: this.values[1], owner_user_id: this.values[2], address: this.values[3], local_part: this.values[4], access_token_hash: this.values[5], access_token_prefix: this.values[6], status: 'active', created_at: new Date().toISOString(), last_message_at: null });
      return { success: true };
    }
    if (sql.startsWith('INSERT INTO messages')) {
      const [id, inbox_id, provider_message_id, from_name, from_address, to_address, subject, text_body, html_body, raw_source, size_bytes, has_attachments] = this.values;
      this.db.messages.push({ id, inbox_id, provider_message_id, from_name, from_address, to_address, subject, text_body, html_body, raw_source, size_bytes, has_attachments, received_at: new Date().toISOString(), deleted_at: null });
      return { success: true };
    }
    if (sql.startsWith('INSERT INTO attachments')) {
      const [id, message_id, filename, content_type, size_bytes, content_base64, content_sha256] = this.values;
      this.db.attachments.push({ id, message_id, filename, content_type, size_bytes, content_base64, content_sha256, created_at: new Date().toISOString(), deleted_at: null });
      return { success: true };
    }
    if (sql.startsWith('UPDATE inboxes SET last_message_at')) {
      const inbox = this.db.inboxes.find((item) => item.id === this.values[0]);
      if (inbox) inbox.last_message_at = new Date().toISOString();
      return { success: true };
    }
    if (sql.startsWith('DELETE FROM attachments WHERE message_id')) {
      this.db.attachments = this.db.attachments.filter((attachment) => attachment.message_id !== this.values[0]);
      return { success: true };
    }
    if (sql.startsWith('DELETE FROM messages WHERE id')) {
      this.db.messages = this.db.messages.filter((message) => message.id !== this.values[0]);
      return { success: true };
    }
    if (sql.startsWith('UPDATE sessions SET status = \'revoked\'')) {
      for (const session of this.db.sessions) if (session.token_hash === this.values[0] || session.user_id === this.values[0]) session.status = 'revoked';
      return { success: true };
    }
    if (sql.startsWith('UPDATE users SET password_hash')) {
      const [password_hash, password_salt, password_algorithm, password_iterations, id] = this.values;
      const user = this.db.users.find((item) => item.id === id);
      Object.assign(user, { password_hash, password_salt, password_algorithm, password_iterations });
      return { success: true };
    }
    if (sql.startsWith('UPDATE users SET status = \'disabled\'')) {
      const user = this.db.users.find((item) => item.id === this.values[0]);
      if (user) Object.assign(user, { status: 'disabled', disabled_at: new Date().toISOString() });
      return { success: true };
    }
    throw new Error(`Unhandled run SQL: ${sql}`);
  }
}

async function api(path, overrides = {}, requestInit = {}) {
  return handleApi(new Request(`https://worker.test${path}`, requestInit), env(overrides));
}

async function apiWithDb(path, db, overrides = {}, requestInit = {}) {
  return handleApi(new Request(`https://worker.test${path}`, requestInit), env({ DB: db, ...overrides }));
}

async function jsonApi(db, path, body, token, overrides = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return handleApi(new Request(`https://worker.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), env({ DB: db, ...overrides }));
}

{
  const config = loadConfig(env({ ACCESS_MODE: 'public' }));
  assert.equal(config.accessMode, 'public');
  assert.deepEqual(config.mailDomains, ['rdhx.email', 'mail.rdhx.email']);
  assert.equal(config.messageRetentionDays, 1);
}

{
  const config = loadConfig(env({ ACCESS_MODE: 'private' }));
  assert.equal(config.accessMode, 'private');
}

{
  const config = loadConfig(env({ PRIVACY_LOCK: 'true' }));
  assert.equal(config.privacyLock, true);
  assert.equal(publicConfig(config).privacyLock, true);
}

assert.throws(() => loadConfig(env({ ACCESS_MODE: 'owner' })), /ACCESS_MODE must be one of/);
assert.throws(() => loadConfig(env({ CORS_ADMIN_ORIGINS: '*' })), /must not contain wildcard/);

{
  const response = await api('/api/config');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, publicConfig(loadConfig(env())));
  assert.equal(JSON.stringify(body).includes(secret), false);
}

{
  const response = await api('/api/admin/ping', {}, { headers: { origin: 'https://evil.test' } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
}

{
  const response = await api('/api/admin/ping', {}, { headers: { origin: 'https://admin.rdhx.email' } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://admin.rdhx.email');
}

{
  const response = await api('/api/private/ping', { ACCESS_MODE: 'private' }, { headers: { origin: 'https://evil.test' } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
}

{
  const db = makeDb();
  db.state.domains.push(
    { id: 'domain_2', domain: 'mail.rdhx.email', status: 'active', is_verified: 1 },
    { id: 'domain_disabled', domain: 'disabled.rdhx.email', status: 'disabled', is_verified: 1 },
    { id: 'domain_unverified', domain: 'unverified.rdhx.email', status: 'active', is_verified: 0 },
    { id: 'domain_external', domain: 'external.example', status: 'active', is_verified: 1 }
  );
  const response = await apiWithDb('/api/domains', db);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).domains, ['rdhx.email', 'mail.rdhx.email']);
}

{
  const db = makeDb();
  const response = await apiWithDb('/api/inboxes', db, {}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localPart: 'task-six' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.ok(body.inbox.id.startsWith('inbox_'));
  assert.equal(body.inbox.address, 'task-six@rdhx.email');
  assert.equal(body.inbox.localPart, 'task-six');
  assert.equal(body.inbox.domain, 'rdhx.email');
  assert.ok(body.inboxToken.startsWith('inbox_'));
  assert.equal(db.state.inboxes[0].deleted_at, undefined);
}

{
  const db = makeDb();
  db.state.domains.unshift({ id: 'domain_disabled', domain: 'inactive.test', status: 'disabled', is_verified: 1 });
  const response = await apiWithDb('/api/inboxes', db, { MAIL_DOMAINS: 'inactive.test,rdhx.email' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.ok(body.inbox.id.startsWith('inbox_'));
  assert.match(body.inbox.address, /^[a-f0-9]{12}@rdhx\.email$/);
  assert.match(body.inbox.localPart, /^[a-f0-9]{12}$/);
  assert.equal(body.inbox.domain, 'rdhx.email');
}

{
  const db = makeDb();
  db.state.domains.push({ id: 'domain_2', domain: 'mail.rdhx.email', status: 'active', is_verified: 1 });
  const randomDefault = await apiWithDb('/api/inboxes', db, { MAIL_DOMAINS: 'rdhx.email,mail.rdhx.email' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(randomDefault.status, 201);
  const randomDefaultBody = await randomDefault.json();
  assert.match(randomDefaultBody.inbox.address, /^[a-f0-9]{12}@rdhx\.email$/);
  assert.equal(randomDefaultBody.inbox.domain, 'rdhx.email');

  const randomSelected = await apiWithDb('/api/inboxes', db, { MAIL_DOMAINS: 'rdhx.email,mail.rdhx.email' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'mail.rdhx.email' }) });
  assert.equal(randomSelected.status, 201);
  const randomSelectedBody = await randomSelected.json();
  assert.match(randomSelectedBody.inbox.address, /^[a-f0-9]{12}@mail\.rdhx\.email$/);
  assert.equal(randomSelectedBody.inbox.domain, 'mail.rdhx.email');

  const customSelected = await apiWithDb('/api/inboxes', db, { MAIL_DOMAINS: 'rdhx.email,mail.rdhx.email' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localPart: 'demo', domain: 'mail.rdhx.email' }) });
  assert.equal(customSelected.status, 201);
  const customSelectedBody = await customSelected.json();
  assert.equal(customSelectedBody.inbox.address, 'demo@mail.rdhx.email');
  assert.equal(customSelectedBody.inbox.localPart, 'demo');
  assert.equal(customSelectedBody.inbox.domain, 'mail.rdhx.email');
}

{
  const db = makeDb();
  const unconfigured = await apiWithDb('/api/inboxes', db, {}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'external.example' }) });
  assert.equal(unconfigured.status, 400);
  assert.equal((await unconfigured.json()).error.code, 'unsupported_domain');

  db.state.domains.push({ id: 'domain_disabled', domain: 'disabled.rdhx.email', status: 'disabled', is_verified: 1 });
  const disabled = await apiWithDb('/api/inboxes', db, { MAIL_DOMAINS: 'rdhx.email,disabled.rdhx.email' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'disabled.rdhx.email' }) });
  assert.equal(disabled.status, 404);
  assert.equal((await disabled.json()).error.code, 'domain_not_found');

  db.state.domains.push({ id: 'domain_unverified', domain: 'unverified.rdhx.email', status: 'active', is_verified: 0 });
  const unverified = await apiWithDb('/api/inboxes', db, { MAIL_DOMAINS: 'rdhx.email,unverified.rdhx.email' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'unverified.rdhx.email' }) });
  assert.equal(unverified.status, 404);
  assert.equal((await unverified.json()).error.code, 'domain_not_found');
}

{
  const db = makeDb();
  const response = await apiWithDb('/api/inboxes', db, { ACCESS_MODE: 'private' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localPart: 'blocked' }) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'authentication_required');
}

{
  const db = makeDb();
  const create = await apiWithDb('/api/inboxes', db, {}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localPart: 'messages' }) });
  const created = await create.json();
  db.state.messages.push({ id: 'msg_1', inbox_id: created.inbox.id, from_name: 'Sender', from_address: 'sender@example.com', to_address: created.inbox.address, subject: 'Hello', text_body: 'Body', html_body: null, raw_source: 'Subject: Hello\n\nBody', size_bytes: 20, has_attachments: 0, is_read: 0, received_at: '2026-06-28 00:00:00' });
  const denied = await apiWithDb(`/api/inboxes/${created.inbox.id}/messages`, db);
  assert.equal(denied.status, 403);
  const listed = await apiWithDb(`/api/inboxes/${created.inbox.id}/messages`, db, {}, { headers: { 'x-inbox-token': created.inboxToken } });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).messages.length, 1);
  const source = await apiWithDb('/api/messages/msg_1/source', db, {}, { headers: { 'x-inbox-token': created.inboxToken } });
  assert.equal(source.status, 200);
  assert.equal(await source.text(), 'Subject: Hello\n\nBody');
  const deleted = await apiWithDb('/api/messages/msg_1', db, {}, { method: 'DELETE', headers: { 'x-inbox-token': created.inboxToken } });
  assert.equal(deleted.status, 200);
  assert.ok(db.state.messages[0].deleted_at);
}

console.log('config-router tests passed');

{
  const db = new MemoryDb();
  const bootstrap = await handleApi(new Request('https://worker.test/api/auth/bootstrap-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-bootstrap-secret': `${secret}admin` },
    body: JSON.stringify({ username: 'admin-user', password: 'correct-password' })
  }), env({ DB: db }));
  assert.equal(bootstrap.status, 201);

  const wrong = await jsonApi(db, '/api/auth/login', { username: 'admin-user', password: 'wrong-password' });
  assert.equal(wrong.status, 401);

  const adminLogin = await jsonApi(db, '/api/auth/login', { username: 'admin-user', password: 'correct-password' });
  assert.equal(adminLogin.status, 200);
  const adminToken = (await adminLogin.json()).token;

  const createMember = await jsonApi(db, '/api/admin/users', { username: 'member-user', password: 'member-password', role: 'member' }, adminToken);
  assert.equal(createMember.status, 201);
  const memberId = (await createMember.json()).user.id;

  const memberLogin = await jsonApi(db, '/api/auth/login', { username: 'member-user', password: 'member-password' });
  assert.equal(memberLogin.status, 200);
  const memberToken = (await memberLogin.json()).token;

  const memberAdminAttempt = await handleApi(new Request('https://worker.test/api/admin/users', { headers: { authorization: `Bearer ${memberToken}` } }), env({ DB: db }));
  assert.equal(memberAdminAttempt.status, 403);

  const disable = await jsonApi(db, `/api/admin/users/${memberId}/disable`, {}, adminToken);
  assert.equal(disable.status, 200);

  const disabledLogin = await jsonApi(db, '/api/auth/login', { username: 'member-user', password: 'member-password' });
  assert.equal(disabledLogin.status, 401);
}

console.log('auth user-role tests passed');

{
  const db = new MemoryDb();
  await handleApi(new Request('https://worker.test/api/auth/bootstrap-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-bootstrap-secret': `${secret}admin` },
    body: JSON.stringify({ username: 'settings-admin', password: 'correct-password' })
  }), env({ DB: db }));

  const adminLogin = await jsonApi(db, '/api/auth/login', { username: 'settings-admin', password: 'correct-password' });
  const adminToken = (await adminLogin.json()).token;

  const settings = await handleApi(new Request('https://worker.test/api/admin/settings', { headers: { authorization: `Bearer ${adminToken}` } }), env({ DB: db }));
  assert.equal(settings.status, 200);
  assert.deepEqual((await settings.json()).settings, { accessMode: 'public', privacyLock: false });

  const updated = await jsonApi(db, '/api/admin/settings/access-mode', { accessMode: 'private' }, adminToken);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).settings.accessMode, 'private');
  assert.deepEqual(db.settings, [{ key: 'access_mode', value: 'private' }]);

  const config = await apiWithDb('/api/config', db);
  assert.equal((await config.json()).accessMode, 'private');

  const unauthenticatedCreate = await apiWithDb('/api/inboxes', db, {}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localPart: 'settings-private' }) });
  assert.equal(unauthenticatedCreate.status, 401);
  assert.equal((await unauthenticatedCreate.json()).error.message, 'Private mode is enabled. Please sign in to use Temp-Mail.');

  const invalid = await jsonApi(db, '/api/admin/settings/access-mode', { accessMode: 'owner' }, adminToken);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'invalid_access_mode');
}

console.log('admin settings access-mode tests passed');

{
  const db = new MemoryDb();
  const created = await apiWithDb('/api/inboxes', db, { PRIVACY_LOCK: 'true' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localPart: 'privacy-public' }) });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  db.messages.push({ id: 'msg_privacy', inbox_id: createdBody.inbox.id, from_name: 'Sender', from_address: 'sender@example.com', to_address: createdBody.inbox.address, subject: 'Privacy', text_body: 'Body', html_body: null, raw_source: 'Subject: Privacy\n\nBody', size_bytes: 20, has_attachments: 0, is_read: 0, received_at: new Date().toISOString(), deleted_at: null });

  await handleApi(new Request('https://worker.test/api/auth/bootstrap-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-bootstrap-secret': `${secret}admin` },
    body: JSON.stringify({ username: 'privacy-admin', password: 'correct-password' })
  }), env({ DB: db, PRIVACY_LOCK: 'true' }));
  const adminLogin = await jsonApi(db, '/api/auth/login', { username: 'privacy-admin', password: 'correct-password' }, null, { PRIVACY_LOCK: 'true' });
  const adminToken = (await adminLogin.json()).token;

  const adminList = await apiWithDb('/api/inboxes', db, { PRIVACY_LOCK: 'true' }, { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(adminList.status, 403);
  assert.equal((await adminList.json()).error.code, 'privacy_lock_enabled');

  const adminMessages = await apiWithDb(`/api/inboxes/${createdBody.inbox.id}/messages`, db, { PRIVACY_LOCK: 'true' }, { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(adminMessages.status, 403);
  assert.equal((await adminMessages.json()).error.code, 'privacy_lock_enabled');

  const publicMessages = await apiWithDb(`/api/inboxes/${createdBody.inbox.id}/messages`, db, { PRIVACY_LOCK: 'true' }, { headers: { 'x-inbox-token': createdBody.inboxToken } });
  assert.equal(publicMessages.status, 200);
  assert.equal((await publicMessages.json()).messages.length, 1);
}

console.log('privacy lock tests passed');

{
  const db = new MemoryDb();
  const bootstrap = await handleApi(new Request('https://worker.test/api/auth/bootstrap-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-bootstrap-secret': `${secret}admin` },
    body: JSON.stringify({ username: 'integration-admin', password: 'correct-password' })
  }), env({ DB: db, ACCESS_MODE: 'private' }));
  assert.equal(bootstrap.status, 201);

  const adminLogin = await jsonApi(db, '/api/auth/login', { username: 'integration-admin', password: 'correct-password' }, null, { ACCESS_MODE: 'private' });
  assert.equal(adminLogin.status, 200);
  const adminToken = (await adminLogin.json()).token;

  const createMember = await jsonApi(db, '/api/admin/users', { username: 'integration-member', password: 'member-password', role: 'member' }, adminToken, { ACCESS_MODE: 'private' });
  assert.equal(createMember.status, 201);

  const memberLogin = await jsonApi(db, '/api/auth/login', { username: 'integration-member', password: 'member-password' }, null, { ACCESS_MODE: 'private' });
  assert.equal(memberLogin.status, 200);
  const memberToken = (await memberLogin.json()).token;

  const unauthenticated = await apiWithDb('/api/inboxes', db, { ACCESS_MODE: 'private' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localPart: 'private-blocked' }) });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error.code, 'authentication_required');

  const created = await jsonApi(db, '/api/inboxes', { localPart: 'private-member' }, memberToken, { ACCESS_MODE: 'private' });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.inbox.address, 'private-member@rdhx.email');
  assert.equal(db.inboxes[0].owner_user_id, db.users.find((user) => user.username === 'integration-member').id);

  const ownedList = await apiWithDb('/api/inboxes', db, { ACCESS_MODE: 'private' }, { headers: { authorization: `Bearer ${memberToken}` } });
  assert.equal(ownedList.status, 200);
  assert.deepEqual((await ownedList.json()).inboxes.map((inbox) => inbox.id), [body.inbox.id]);

  db.messages.push({ id: 'msg_owned', inbox_id: body.inbox.id, from_name: 'Sender', from_address: 'sender@example.com', to_address: body.inbox.address, subject: 'Owned', text_body: 'Body', html_body: null, raw_source: 'Subject: Owned\n\nBody', size_bytes: 20, has_attachments: 0, is_read: 0, received_at: new Date().toISOString(), deleted_at: null });
  const messagesById = await apiWithDb(`/api/inboxes/${body.inbox.id}/messages`, db, { ACCESS_MODE: 'private' }, { headers: { authorization: `Bearer ${memberToken}` } });
  assert.equal(messagesById.status, 200);
  assert.equal((await messagesById.json()).messages.length, 1);
  const messagesByAddress = await apiWithDb(`/api/messages?address=${encodeURIComponent(body.inbox.address)}`, db, { ACCESS_MODE: 'private' }, { headers: { authorization: `Bearer ${memberToken}` } });
  assert.equal(messagesByAddress.status, 200);
  const addressBody = await messagesByAddress.json();
  assert.equal(addressBody.inbox.address, body.inbox.address);
  assert.equal(addressBody.messages.length, 1);

  const publicMessagesByAddress = await apiWithDb(`/api/messages?address=${encodeURIComponent(body.inbox.address)}`, db, { ACCESS_MODE: 'private' });
  assert.equal(publicMessagesByAddress.status, 401);
  assert.equal((await publicMessagesByAddress.json()).error.code, 'sign_in_required');
  const tokenMessagesById = await apiWithDb(`/api/inboxes/${body.inbox.id}/messages`, db, { ACCESS_MODE: 'private' }, { headers: { 'x-inbox-token': body.inboxToken } });
  assert.equal(tokenMessagesById.status, 401);

  await jsonApi(db, '/api/admin/users', { username: 'other-member', password: 'member-password', role: 'member' }, adminToken, { ACCESS_MODE: 'private' });
  const otherLogin = await jsonApi(db, '/api/auth/login', { username: 'other-member', password: 'member-password' }, null, { ACCESS_MODE: 'private' });
  const otherToken = (await otherLogin.json()).token;
  const otherMessagesByAddress = await apiWithDb(`/api/messages?address=${encodeURIComponent(body.inbox.address)}`, db, { ACCESS_MODE: 'private' }, { headers: { authorization: `Bearer ${otherToken}` } });
  assert.equal(otherMessagesByAddress.status, 404);
  const otherMessagesById = await apiWithDb(`/api/inboxes/${body.inbox.id}/messages`, db, { ACCESS_MODE: 'private' }, { headers: { authorization: `Bearer ${otherToken}` } });
  assert.equal(otherMessagesById.status, 404);
}

console.log('auth inbox integration tests passed');

{
  const db = new MemoryDb();
  await handleApi(new Request('https://worker.test/api/auth/bootstrap-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-bootstrap-secret': `${secret}admin` },
    body: JSON.stringify({ username: 'key-admin', password: 'correct-password' })
  }), env({ DB: db, ACCESS_MODE: 'private' }));

  const adminLogin = await jsonApi(db, '/api/auth/login', { username: 'key-admin', password: 'correct-password' }, null, { ACCESS_MODE: 'private' });
  const adminToken = (await adminLogin.json()).token;
  const createMember = await jsonApi(db, '/api/admin/users', { username: 'key-member', password: 'member-password', role: 'member' }, adminToken, { ACCESS_MODE: 'private' });
  const member = (await createMember.json()).user;
  const memberLogin = await jsonApi(db, '/api/auth/login', { username: 'key-member', password: 'member-password' }, null, { ACCESS_MODE: 'private' });
  const memberToken = (await memberLogin.json()).token;

  const memberCreate = await jsonApi(db, '/api/admin/api-keys', { ownerUserId: member.id, name: 'denied', scopes: ['inboxes:write'] }, memberToken, { ACCESS_MODE: 'private' });
  assert.equal(memberCreate.status, 403);

  const created = await jsonApi(db, '/api/admin/api-keys', { ownerUserId: member.id, name: 'automation' }, adminToken, { ACCESS_MODE: 'private' });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.ok(createdBody.key.startsWith('rdhx_'));
  assert.equal(createdBody.apiKey.prefix, createdBody.key.slice(0, 14));
  assert.equal(db.apiKeys[0].key_hash.length, 64);
  assert.equal(JSON.stringify(db.apiKeys).includes(createdBody.key), false);

  const listed = await handleApi(new Request('https://worker.test/api/admin/api-keys', { headers: { authorization: `Bearer ${adminToken}` } }), env({ DB: db, ACCESS_MODE: 'private' }));
  assert.equal(listed.status, 200);
  const listText = await listed.text();
  assert.equal(listText.includes(createdBody.key), false);
  const listBody = JSON.parse(listText);
  assert.equal(listBody.apiKeys[0].ownerUsername, 'key-member');
  assert.deepEqual(listBody.apiKeys[0].scopes, ['inboxes:write']);

  const apiCreate = await jsonApi(db, '/api/inboxes', { localPart: 'api-key-ok' }, createdBody.key, { ACCESS_MODE: 'private' });
  assert.equal(apiCreate.status, 201);
  const apiCreateBody = await apiCreate.json();
  const apiOwnedList = await apiWithDb('/api/inboxes', db, { ACCESS_MODE: 'private' }, { headers: { authorization: `Bearer ${createdBody.key}` } });
  assert.equal(apiOwnedList.status, 200);
  assert.deepEqual((await apiOwnedList.json()).inboxes.map((inbox) => inbox.id), [apiCreateBody.inbox.id]);
  db.messages.push({ id: 'msg_api_owned', inbox_id: apiCreateBody.inbox.id, from_name: 'Sender', from_address: 'sender@example.com', to_address: apiCreateBody.inbox.address, subject: 'API owned', text_body: 'Body', html_body: null, raw_source: 'Subject: API owned\n\nBody', size_bytes: 20, has_attachments: 0, is_read: 0, received_at: new Date().toISOString(), deleted_at: null });
  const apiMessagesByAddress = await apiWithDb(`/api/messages?address=${encodeURIComponent(apiCreateBody.inbox.address)}`, db, { ACCESS_MODE: 'private' }, { headers: { authorization: `Bearer ${createdBody.key}` } });
  assert.equal(apiMessagesByAddress.status, 200);
  assert.equal((await apiMessagesByAddress.json()).messages.length, 1);

  const invalidScope = await jsonApi(db, '/api/admin/api-keys', { ownerUserId: member.id, name: 'bad-scope', scopes: ['inboxes:*'] }, adminToken, { ACCESS_MODE: 'private' });
  assert.equal(invalidScope.status, 400);
  const invalidScopeBody = await invalidScope.json();
  assert.equal(invalidScopeBody.error.code, 'invalid_scopes');

  const legacy = await jsonApi(db, '/api/admin/api-keys', { ownerUserId: member.id, name: 'legacy', scopes: ['inboxes:write'] }, adminToken, { ACCESS_MODE: 'private' });
  assert.equal(legacy.status, 201);
  const legacyBody = await legacy.json();
  db.apiKeys.find((key) => key.id === legacyBody.apiKey.id).scopes = JSON.stringify(['inboxes:*']);
  const legacyUse = await jsonApi(db, '/api/inboxes', { localPart: 'api-key-legacy' }, legacyBody.key, { ACCESS_MODE: 'private' });
  assert.equal(legacyUse.status, 201);
  const legacyList = await handleApi(new Request('https://worker.test/api/admin/api-keys', { headers: { authorization: `Bearer ${adminToken}` } }), env({ DB: db, ACCESS_MODE: 'private' }));
  const legacyListBody = await legacyList.json();
  assert.deepEqual(legacyListBody.apiKeys.find((key) => key.id === legacyBody.apiKey.id).scopes, ['inboxes:write']);
  const resetLegacy = await jsonApi(db, `/api/admin/api-keys/${legacyBody.apiKey.id}/reset`, {}, adminToken, { ACCESS_MODE: 'private' });
  assert.equal(resetLegacy.status, 200);
  const resetLegacyBody = await resetLegacy.json();
  assert.deepEqual(resetLegacyBody.apiKey.scopes, ['inboxes:write']);
  assert.deepEqual(JSON.parse(db.apiKeys.find((key) => key.id === legacyBody.apiKey.id).scopes), ['inboxes:write']);

  const missingScope = await jsonApi(db, '/api/admin/api-keys', { ownerUserId: member.id, name: 'missing-scope', scopes: ['inboxes:write'] }, adminToken, { ACCESS_MODE: 'private' });
  const missingScopeBody = await missingScope.json();
  db.apiKeys.find((key) => key.id === missingScopeBody.apiKey.id).scopes = JSON.stringify([]);
  const noScope = await jsonApi(db, '/api/inboxes', { localPart: 'api-key-denied' }, missingScopeBody.key, { ACCESS_MODE: 'private' });
  assert.equal(noScope.status, 403);

  const revoke = await jsonApi(db, `/api/admin/api-keys/${createdBody.apiKey.id}/revoke`, {}, adminToken, { ACCESS_MODE: 'private' });
  assert.equal(revoke.status, 200);
  const revokedUse = await jsonApi(db, '/api/inboxes', { localPart: 'api-key-revoked' }, createdBody.key, { ACCESS_MODE: 'private' });
  assert.equal(revokedUse.status, 401);
}

console.log('api key admin and scoped automation tests passed');

{
  const db = new MemoryDb();
  await handleApi(new Request('https://worker.test/api/auth/bootstrap-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-bootstrap-secret': `${secret}admin` },
    body: JSON.stringify({ username: 'limit-admin', password: 'correct-password' })
  }), env({ DB: db, RATE_LIMIT_LOGIN_PER_MINUTE: '1' }));
  const firstLogin = await jsonApi(db, '/api/auth/login', { username: 'limit-admin', password: 'bad-password' }, null, { RATE_LIMIT_LOGIN_PER_MINUTE: '1' });
  assert.equal(firstLogin.status, 401);
  const secondLogin = await jsonApi(db, '/api/auth/login', { username: 'limit-admin', password: 'bad-password' }, null, { RATE_LIMIT_LOGIN_PER_MINUTE: '1' });
  assert.equal(secondLogin.status, 429);

  const inboxDb = new MemoryDb();
  const createOne = await apiWithDb('/api/inboxes', inboxDb, { RATE_LIMIT_INBOX_CREATE_PER_MINUTE: '1' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localPart: 'limited-one' }) });
  assert.equal(createOne.status, 201);
  const createTwo = await apiWithDb('/api/inboxes', inboxDb, { RATE_LIMIT_INBOX_CREATE_PER_MINUTE: '1' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localPart: 'limited-two' }) });
  assert.equal(createTwo.status, 429);

  const apiDb = new MemoryDb();
  await handleApi(new Request('https://worker.test/api/auth/bootstrap-admin', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-bootstrap-secret': `${secret}admin` }, body: JSON.stringify({ username: 'rl-admin', password: 'correct-password' }) }), env({ DB: apiDb, ACCESS_MODE: 'private' }));
  const adminLogin = await jsonApi(apiDb, '/api/auth/login', { username: 'rl-admin', password: 'correct-password' }, null, { ACCESS_MODE: 'private' });
  const adminToken = (await adminLogin.json()).token;
  const memberResponse = await jsonApi(apiDb, '/api/admin/users', { username: 'rl-member', password: 'member-password', role: 'member' }, adminToken, { ACCESS_MODE: 'private' });
  const member = (await memberResponse.json()).user;
  const keyResponse = await jsonApi(apiDb, '/api/admin/api-keys', { ownerUserId: member.id, name: 'limited', scopes: ['inboxes:write'] }, adminToken, { ACCESS_MODE: 'private' });
  const key = (await keyResponse.json()).key;
  assert.equal((await jsonApi(apiDb, '/api/inboxes', { localPart: 'api-limit-one' }, key, { ACCESS_MODE: 'private', RATE_LIMIT_API_PER_MINUTE: '1' })).status, 201);
  assert.equal((await jsonApi(apiDb, '/api/inboxes', { localPart: 'api-limit-two' }, key, { ACCESS_MODE: 'private', RATE_LIMIT_API_PER_MINUTE: '1' })).status, 429);

  const messageDb = makeDb();
  const created = await apiWithDb('/api/inboxes', messageDb, {}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localPart: 'message-limit' }) });
  const createdBody = await created.json();
  messageDb.state.messages.push({ id: 'msg_limit', inbox_id: createdBody.inbox.id, from_address: 'sender@example.com', to_address: createdBody.inbox.address, subject: 'Limited', size_bytes: 10, has_attachments: 0, is_read: 0, received_at: '2026-06-28 00:00:00' });
  assert.equal((await apiWithDb(`/api/inboxes/${createdBody.inbox.id}/messages`, messageDb, { RATE_LIMIT_MESSAGE_READ_PER_MINUTE: '1' }, { headers: { 'x-inbox-token': createdBody.inboxToken } })).status, 200);
  assert.equal((await apiWithDb(`/api/inboxes/${createdBody.inbox.id}/messages`, messageDb, { RATE_LIMIT_MESSAGE_READ_PER_MINUTE: '1' }, { headers: { 'x-inbox-token': createdBody.inboxToken } })).status, 429);

  const cors = await api('/api/admin/ping', {}, { headers: { origin: 'https://admin.rdhx.email' } });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'https://admin.rdhx.email');
  assert.notEqual(cors.headers.get('access-control-allow-origin'), '*');
}

console.log('security rate-limit and CORS tests passed');

function mailMessage({ to = 'inbound@rdhx.email', from = 'Sender <sender@example.com>', subject = 'Inbound hello', body = 'Stored body' } = {}) {
  const raw = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, 'Message-ID: <test-message@example.com>', '', body].join('\r\n');
  let rejected = null;
  return {
    to,
    from,
    raw: new Blob([raw]),
    headers: new Headers({ from, to, subject, 'message-id': '<test-message@example.com>' }),
    setReject(reason) { rejected = reason; },
    get rejected() { return rejected; }
  };
}

{
  const db = new MemoryDb();
  db.inboxes.push({ id: 'inbox_active', domain_id: 'domain_1', owner_user_id: null, address: 'inbound@rdhx.email', local_part: 'inbound', access_token_hash: 'hash', access_token_prefix: 'inbox_token', status: 'active', created_at: new Date().toISOString(), last_message_at: null });
  const message = mailMessage();
  const stored = await handleInboundEmail(message, env({ DB: db }), loadConfig(env({ DB: db })));
  assert.ok(stored.id.startsWith('msg_'));
  assert.equal(db.messages.length, 1);
  assert.equal(db.messages[0].inbox_id, 'inbox_active');
  assert.equal(db.messages[0].subject, 'Inbound hello');
  assert.equal(db.messages[0].raw_source.includes('Stored body'), true);
  assert.equal(db.inboxes[0].last_message_at !== null, true);
}

{
  const db = new MemoryDb();
  const unknown = mailMessage({ to: 'missing@rdhx.email' });
  await assert.rejects(() => handleInboundEmail(unknown, env({ DB: db }), loadConfig(env({ DB: db }))), /unknown, disabled, or deleted/);
  assert.equal(unknown.rejected, 'Recipient inbox is unknown, disabled, or deleted');
  db.inboxes.push({ id: 'inbox_disabled', domain_id: 'domain_1', owner_user_id: null, address: 'disabled@rdhx.email', local_part: 'disabled', status: 'disabled', created_at: new Date().toISOString(), last_message_at: null });
  const disabled = mailMessage({ to: 'disabled@rdhx.email' });
  await assert.rejects(() => handleInboundEmail(disabled, env({ DB: db }), loadConfig(env({ DB: db }))), /unknown, disabled, or deleted/);
}

{
  const db = new MemoryDb();
  db.inboxes.push({ id: 'inbox_keep', domain_id: 'domain_1', owner_user_id: null, address: 'cleanup@rdhx.email', local_part: 'cleanup', status: 'active', created_at: '2026-06-20T00:00:00Z', last_message_at: null });
  db.messages.push({ id: 'old_msg', inbox_id: 'inbox_keep', received_at: '2026-06-20T00:00:00Z', raw_source: 'old raw' });
  db.messages.push({ id: 'new_msg', inbox_id: 'inbox_keep', received_at: '2026-06-28T00:00:00Z', raw_source: 'new raw' });
  db.attachments.push({ id: 'old_att', message_id: 'old_msg', content_base64: 'b2xk' });
  db.attachments.push({ id: 'new_att', message_id: 'new_msg', content_base64: 'bmV3' });
  const result = await cleanupExpiredMessages(env({ DB: db }), loadConfig(env({ DB: db, MESSAGE_RETENTION_DAYS: '1' })));
  assert.equal(result.messagesDeleted, 1);
  assert.deepEqual(db.messages.map((message) => message.id), ['new_msg']);
  assert.deepEqual(db.attachments.map((attachment) => attachment.id), ['new_att']);
  assert.equal(db.inboxes.length, 1);
  assert.equal(db.inboxes[0].id, 'inbox_keep');
}

console.log('email inbound and cleanup tests passed');
