import { createApiKeyRecord, normalizeScopes, WRITE_SCOPE } from './api-keys.js';
import { HttpError } from './http.js';
import { enforceBodySize } from './security.js';

const REASON_MAX_LENGTH = 500;

function requireDb(env) {
  if (!env.DB) throw new HttpError(500, 'database_not_configured', 'D1 database binding DB is required');
  return env.DB;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

function normalizeRequestedScope(scope) {
  return normalizeScopes([scope])[0];
}

function publicScope(scope) {
  return scope === 'inboxes:*' ? WRITE_SCOPE : scope;
}

function normalizeReason(value, field = 'reason') {
  const reason = String(value || '').trim();
  if (reason.length < 1 || reason.length > REASON_MAX_LENGTH) {
    throw new HttpError(400, `invalid_${field}`, `${field === 'rejection_reason' ? 'Rejection reason' : 'Reason'} must be 1-${REASON_MAX_LENGTH} characters`);
  }
  return reason;
}

function publicRequest(row) {
  return {
    id: row.id,
    requesterUserId: row.requester_user_id,
    requesterUsername: row.requester_username || null,
    requesterRole: row.requester_role || null,
    requestedScope: publicScope(row.requested_scope),
    reason: row.reason,
    status: row.status,
    rejectionReason: row.rejection_reason || null,
    reviewedByUserId: row.reviewed_by_user_id || null,
    reviewedByUsername: row.reviewed_by_username || null,
    reviewedAt: row.reviewed_at || null,
    fulfilledApiKeyId: row.fulfilled_api_key_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function requestById(db, requestId) {
  return db.prepare(`SELECT requests.*, requester.username AS requester_username, requester.role AS requester_role,
      reviewer.username AS reviewed_by_username
    FROM api_key_requests requests
    JOIN users requester ON requester.id = requests.requester_user_id
    LEFT JOIN users reviewer ON reviewer.id = requests.reviewed_by_user_id
    WHERE requests.id = ?`).bind(requestId).first();
}

async function updatePendingRequest(db, requestId, values, errorMessage) {
  const result = await db.prepare(values.sql).bind(...values.bindings, requestId).run();
  if (result.meta?.changes === 0) {
    const existing = await requestById(db, requestId);
    if (!existing) throw new HttpError(404, 'api_key_request_not_found', 'API key request not found');
    throw new HttpError(409, 'api_key_request_not_pending', errorMessage);
  }
  return publicRequest(await requestById(db, requestId));
}

export async function createMyApiKeyRequest(request, env, user) {
  await enforceBodySize(request);
  const db = requireDb(env);
  const body = await readJson(request);
  const requestedScope = normalizeRequestedScope(body.requestedScope || body.scope);
  const reason = normalizeReason(body.reason);
  const id = makeId('akr');
  await db.prepare(`INSERT INTO api_key_requests (id, requester_user_id, requested_scope, reason)
    VALUES (?, ?, ?, ?)`).bind(id, user.id, requestedScope, reason).run();
  return { request: publicRequest(await requestById(db, id)) };
}

export async function listMyApiKeyRequests(_request, env, user) {
  const result = await requireDb(env).prepare(`SELECT requests.*, requester.username AS requester_username, requester.role AS requester_role,
      reviewer.username AS reviewed_by_username
    FROM api_key_requests requests
    JOIN users requester ON requester.id = requests.requester_user_id
    LEFT JOIN users reviewer ON reviewer.id = requests.reviewed_by_user_id
    WHERE requests.requester_user_id = ?
    ORDER BY requests.created_at DESC`).bind(user.id).all();
  return { requests: (result.results || []).map(publicRequest) };
}

export async function generateMyApiKeyFromRequest(_request, env, user, requestId) {
  const db = requireDb(env);
  const existing = await db.prepare(`SELECT id, requested_scope, status, fulfilled_api_key_id
    FROM api_key_requests
    WHERE id = ? AND requester_user_id = ?`).bind(requestId, user.id).first();
  if (!existing) throw new HttpError(404, 'api_key_request_not_found', 'API key request not found');
  if (existing.status !== 'approved' || existing.fulfilled_api_key_id) {
    throw new HttpError(409, 'api_key_request_not_approved', 'Only approved unfulfilled requests can generate an API key');
  }

  const reserved = await db.prepare(`UPDATE api_key_requests
    SET status = 'fulfilled', updated_at = datetime('now')
    WHERE id = ? AND requester_user_id = ? AND status = 'approved' AND fulfilled_api_key_id IS NULL`).bind(requestId, user.id).run();
  if (reserved.meta?.changes === 0) {
    throw new HttpError(409, 'api_key_request_not_approved', 'Only approved unfulfilled requests can generate an API key');
  }

  const payload = await createApiKeyRecord(db, {
    ownerUserId: user.id,
    createdByUserId: user.id,
    name: `Requested key ${requestId.slice(-8)}`,
    scopes: [publicScope(existing.requested_scope)]
  });

  await db.prepare("UPDATE api_key_requests SET fulfilled_api_key_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(payload.apiKey.id, requestId).run();
  return { request: publicRequest(await requestById(db, requestId)), apiKey: payload.apiKey, key: payload.key };
}

export async function listAdminApiKeyRequests(_request, env) {
  const result = await requireDb(env).prepare(`SELECT requests.*, requester.username AS requester_username, requester.role AS requester_role,
      reviewer.username AS reviewed_by_username
    FROM api_key_requests requests
    JOIN users requester ON requester.id = requests.requester_user_id
    LEFT JOIN users reviewer ON reviewer.id = requests.reviewed_by_user_id
    ORDER BY requests.created_at DESC`).all();
  return { requests: (result.results || []).map(publicRequest) };
}

export async function approveApiKeyRequest(_request, env, adminUser, requestId) {
  const db = requireDb(env);
  return {
    request: await updatePendingRequest(db, requestId, {
      sql: `UPDATE api_key_requests
        SET status = 'approved', reviewed_by_user_id = ?, reviewed_at = datetime('now'), rejection_reason = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'`,
      bindings: [adminUser.id]
    }, 'Only pending API key requests can be approved')
  };
}

export async function rejectApiKeyRequest(request, env, adminUser, requestId) {
  await enforceBodySize(request);
  const db = requireDb(env);
  const body = await readJson(request);
  const rejectionReason = normalizeReason(body.rejectionReason || body.reason, 'rejection_reason');
  return {
    request: await updatePendingRequest(db, requestId, {
      sql: `UPDATE api_key_requests
        SET status = 'rejected', rejection_reason = ?, reviewed_by_user_id = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'`,
      bindings: [rejectionReason, adminUser.id]
    }, 'Only pending API key requests can be rejected')
  };
}
