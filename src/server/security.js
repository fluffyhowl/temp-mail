import { HttpError } from './http.js';

const encoder = new TextEncoder();
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ADDRESS_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const SIZE_LIMITS = Object.freeze({
  jsonBodyBytes: 16 * 1024,
  rawEmailBytes: 512 * 1024,
  messageBodyBytes: 256 * 1024,
  attachmentBytes: 128 * 1024,
  attachmentsPerMessage: 5
});

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value || '')));
  return bytesToHex(new Uint8Array(digest));
}

export function normalizeDomainName(domain) {
  const value = String(domain || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(value)) throw new HttpError(400, 'invalid_domain', 'Domain must be a valid DNS hostname');
  return value;
}

export function normalizeEmailAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  if (!ADDRESS_RE.test(value)) throw new HttpError(400, 'invalid_email_address', 'Email address format is invalid');
  return value;
}

export function normalizeLocalPart(value) {
  const localPart = String(value || '').trim().toLowerCase();
  if (!LOCAL_PART_RE.test(localPart)) {
    throw new HttpError(400, 'invalid_local_part', 'Inbox name must be 1-64 lowercase letters, numbers, dots, dashes, or underscores and cannot start or end with punctuation');
  }
  return localPart;
}

export function requestIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export function bearerSubject(request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].slice(0, 32) : null;
}

export async function enforceBodySize(request, maxBytes = SIZE_LIMITS.jsonBodyBytes) {
  const length = request.headers.get('content-length');
  if (length && Number(length) > maxBytes) throw new HttpError(413, 'payload_too_large', `Request body must be ${maxBytes} bytes or smaller`);
}

export function assertTextSize(value, maxBytes, code) {
  if (encoder.encode(String(value || '')).byteLength > maxBytes) {
    throw new HttpError(413, code, `Content must be ${maxBytes} bytes or smaller`);
  }
}

export async function checkRateLimit(env, { request, action, limit, windowSeconds = 60, subjectType = 'ip', subject }) {
  if (!env.DB) throw new HttpError(500, 'database_not_configured', 'D1 database binding DB is required');
  const rawSubject = subject || (subjectType === 'ip' ? requestIp(request) : bearerSubject(request) || requestIp(request));
  const subjectHash = await sha256Hex(rawSubject);
  const windowStartMs = Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000;
  const windowStart = new Date(windowStartMs).toISOString();
  const bucketKey = `${action}:${subjectType}:${subjectHash}`;
  const id = `rl_${await sha256Hex(`${bucketKey}:${windowStart}`)}`;

  const existing = await env.DB.prepare('SELECT request_count, blocked_until FROM rate_limits WHERE bucket_key = ? AND window_start = ?')
    .bind(bucketKey, windowStart).first();
  if (existing?.blocked_until && new Date(existing.blocked_until) > new Date()) {
    throw new HttpError(429, 'rate_limited', 'Too many requests; retry after the current rate-limit window');
  }
  const nextCount = Number(existing?.request_count || 0) + 1;
  if (existing) {
    await env.DB.prepare("UPDATE rate_limits SET request_count = ?, blocked_until = ?, updated_at = datetime('now') WHERE bucket_key = ? AND window_start = ?")
      .bind(nextCount, nextCount > limit ? new Date(windowStartMs + windowSeconds * 1000).toISOString() : null, bucketKey, windowStart).run();
  } else {
    await env.DB.prepare('INSERT INTO rate_limits (id, bucket_key, subject_type, subject_hash, action, window_start, window_seconds, request_count, blocked_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, bucketKey, subjectType, subjectHash, action, windowStart, windowSeconds, nextCount, null).run();
  }
  if (nextCount > limit) throw new HttpError(429, 'rate_limited', 'Too many requests; retry after the current rate-limit window');
  return { remaining: Math.max(0, limit - nextCount), limit, windowSeconds };
}
