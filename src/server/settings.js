import { normalizeAccessMode } from './config.js';
import { HttpError } from './http.js';
import { enforceBodySize } from './security.js';

function requireDb(env) {
  if (!env.DB) throw new HttpError(500, 'database_not_configured', 'D1 database binding DB is required');
  return env.DB;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

export function publicSettings(config) {
  return {
    accessMode: config.accessMode,
    privacyLock: Boolean(config.privacyLock)
  };
}

export async function updateAccessMode(request, env) {
  await enforceBodySize(request);
  const db = requireDb(env);
  const body = await readJson(request);
  const accessMode = normalizeAccessMode(body.accessMode || body.mode);
  await db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('access_mode', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).bind(accessMode).run();
  return { accessMode };
}
