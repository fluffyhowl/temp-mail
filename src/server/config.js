import { HttpError } from './http.js';

const ACCESS_MODES = new Set(['public', 'private']);
const HASH_STRATEGIES = new Set(['pbkdf2-sha256', 'argon2id-external']);

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function requireSecretPlaceholder(env, name) {
  const value = env[name];
  if (!value || String(value).trim().length < 32) {
    throw new Error(`${name} must be configured as a Worker secret with at least 32 characters`);
  }
  return String(value);
}

function readInteger(env, name, fallback, { min, max }) {
  const raw = env[name] ?? String(fallback);
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readAccessMode(env) {
  const accessMode = String(env.ACCESS_MODE || 'public').trim().toLowerCase();
  if (!ACCESS_MODES.has(accessMode)) {
    throw new Error('ACCESS_MODE must be one of: public, private');
  }
  return accessMode;
}

function readMailDomains(env) {
  const domains = splitCsv(env.MAIL_DOMAINS).map((domain) => domain.toLowerCase());
  if (domains.length === 0) {
    throw new Error('MAIL_DOMAINS must include at least one domain');
  }
  for (const domain of domains) {
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
      throw new Error(`MAIL_DOMAINS contains invalid domain: ${domain}`);
    }
  }
  return domains;
}

function readCorsOrigins(env) {
  const publicOrigins = splitCsv(env.CORS_PUBLIC_ORIGINS);
  const privateOrigins = splitCsv(env.CORS_PRIVATE_ORIGINS);
  const adminOrigins = splitCsv(env.CORS_ADMIN_ORIGINS);
  if (privateOrigins.includes('*') || adminOrigins.includes('*')) {
    throw new Error('CORS_PRIVATE_ORIGINS and CORS_ADMIN_ORIGINS must not contain wildcard origins');
  }
  return { publicOrigins, privateOrigins, adminOrigins };
}

function readAdminBootstrap(env) {
  const strategy = String(env.ADMIN_BOOTSTRAP_HASH_STRATEGY || 'pbkdf2-sha256').trim().toLowerCase();
  if (!HASH_STRATEGIES.has(strategy)) {
    throw new Error('ADMIN_BOOTSTRAP_HASH_STRATEGY must be pbkdf2-sha256 or argon2id-external');
  }
  return {
    secret: requireSecretPlaceholder(env, 'ADMIN_BOOTSTRAP_SECRET'),
    hashStrategy: strategy
  };
}

export function loadConfig(env = {}) {
  return {
    accessMode: readAccessMode(env),
    mailDomains: readMailDomains(env),
    messageRetentionDays: readInteger(env, 'MESSAGE_RETENTION_DAYS', 1, { min: 1, max: 30 }),
    sessionSecret: requireSecretPlaceholder(env, 'SESSION_SECRET'),
    jwtSecret: requireSecretPlaceholder(env, 'JWT_SECRET'),
    adminBootstrap: readAdminBootstrap(env),
    cors: readCorsOrigins(env),
    rateLimits: {
      loginPerMinute: readInteger(env, 'RATE_LIMIT_LOGIN_PER_MINUTE', 5, { min: 1, max: 120 }),
      inboxCreatePerMinute: readInteger(env, 'RATE_LIMIT_INBOX_CREATE_PER_MINUTE', 20, { min: 1, max: 600 }),
      apiPerMinute: readInteger(env, 'RATE_LIMIT_API_PER_MINUTE', 120, { min: 1, max: 6000 }),
      messageReadPerMinute: readInteger(env, 'RATE_LIMIT_MESSAGE_READ_PER_MINUTE', 60, { min: 1, max: 3000 })
    }
  };
}

export function publicConfig(config) {
  return {
    accessMode: config.accessMode,
    mailDomains: config.mailDomains,
    messageRetentionDays: config.messageRetentionDays,
    rateLimits: {
      inboxCreatePerMinute: config.rateLimits.inboxCreatePerMinute,
      apiPerMinute: config.rateLimits.apiPerMinute
    }
  };
}

export function requirePrivateBoundary(config) {
  if (config.accessMode !== 'private') {
    throw new HttpError(404, 'not_found', 'Not found');
  }
  throw new HttpError(401, 'authentication_required', 'Authentication is required for private endpoints');
}
