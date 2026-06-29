import { corsHeaders, preflight } from './cors.js';
import { loadConfig, publicConfig, requirePrivateBoundary } from './config.js';
import { errorJson, HttpError, json, methodNotAllowed } from './http.js';
import { createInbox, deleteMessage, listDomains, listMessages, viewAttachment, viewMessage, viewMessageSource } from './inboxes.js';
import { adminCreateUser, adminDisableUser, adminEnableUser, adminResetPassword, bootstrapAdmin, listUsers, login, logout, requireRole } from './auth.js';
import { createApiKey, listApiKeys, resetApiKey, revokeApiKey } from './api-keys.js';

function routeBoundary(pathname) {
  if (pathname.startsWith('/api/admin/')) return 'admin';
  if (pathname.startsWith('/api/private/')) return 'private';
  return 'public';
}

function assertMethod(request, allowed) {
  if (!allowed.includes(request.method)) {
    throw methodNotAllowed(allowed);
  }
}

async function dispatch(request, config) {
  const url = new URL(request.url);
  const boundary = routeBoundary(url.pathname);
  request.responseHeaders = corsHeaders(request, config, boundary);
  const options = preflight(request, config, boundary);
  if (options) return options;

  if (url.pathname === '/api/health') {
    assertMethod(request, ['GET']);
    return json({ ok: true, service: 'rdhx-email' }, { headers: corsHeaders(request, config, 'public') });
  }

  if (url.pathname === '/api/config') {
    assertMethod(request, ['GET']);
    return json(publicConfig(config), { headers: corsHeaders(request, config, 'public') });
  }

  if (url.pathname === '/api/domains') {
    assertMethod(request, ['GET']);
    return listDomains(request, config.env, config);
  }

  if (url.pathname === '/api/inboxes') {
    assertMethod(request, ['POST']);
    return createInbox(request, config.env, config);
  }

  if (/^\/api\/inboxes\/[^/]+\/messages$/.test(url.pathname)) {
    assertMethod(request, ['GET']);
    return listMessages(request, config.env);
  }

  if (/^\/api\/messages\/[^/]+$/.test(url.pathname)) {
    assertMethod(request, ['GET', 'DELETE']);
    return request.method === 'DELETE' ? deleteMessage(request, config.env) : viewMessage(request, config.env);
  }

  if (/^\/api\/messages\/[^/]+\/source$/.test(url.pathname)) {
    assertMethod(request, ['GET']);
    return viewMessageSource(request, config.env);
  }

  if (/^\/api\/messages\/[^/]+\/attachments\/[^/]+$/.test(url.pathname)) {
    assertMethod(request, ['GET']);
    return viewAttachment(request, config.env);
  }

  if (url.pathname === '/api/auth/bootstrap-admin') {
    assertMethod(request, ['POST']);
    return json(await bootstrapAdmin(request, config.env, config), { status: 201, headers: corsHeaders(request, config, 'admin') });
  }

  if (url.pathname === '/api/auth/login') {
    assertMethod(request, ['POST']);
    return json(await login(request, config.env), { headers: corsHeaders(request, config, 'public') });
  }

  if (url.pathname === '/api/auth/logout') {
    assertMethod(request, ['POST']);
    return json(await logout(request, config.env), { headers: corsHeaders(request, config, boundary) });
  }

  if (url.pathname === '/api/admin/users') {
    await requireRole(request, config.env, 'admin');
    if (request.method === 'GET') return json(await listUsers(request, config.env), { headers: corsHeaders(request, config, 'admin') });
    if (request.method === 'POST') return json(await adminCreateUser(request, config.env), { status: 201, headers: corsHeaders(request, config, 'admin') });
    throw methodNotAllowed(['GET', 'POST']);
  }

  if (url.pathname === '/api/admin/api-keys') {
    const admin = await requireRole(request, config.env, 'admin');
    if (request.method === 'GET') return json(await listApiKeys(request, config.env), { headers: corsHeaders(request, config, 'admin') });
    if (request.method === 'POST') return json(await createApiKey(request, config.env, admin), { status: 201, headers: corsHeaders(request, config, 'admin') });
    throw methodNotAllowed(['GET', 'POST']);
  }

  const apiKeyResetMatch = /^\/api\/admin\/api-keys\/([^/]+)\/reset$/.exec(url.pathname);
  if (apiKeyResetMatch) {
    assertMethod(request, ['POST']);
    await requireRole(request, config.env, 'admin');
    return json(await resetApiKey(request, config.env, apiKeyResetMatch[1]), { headers: corsHeaders(request, config, 'admin') });
  }

  const apiKeyRevokeMatch = /^\/api\/admin\/api-keys\/([^/]+)\/revoke$/.exec(url.pathname);
  if (apiKeyRevokeMatch) {
    assertMethod(request, ['POST']);
    await requireRole(request, config.env, 'admin');
    return json(await revokeApiKey(request, config.env, apiKeyRevokeMatch[1]), { headers: corsHeaders(request, config, 'admin') });
  }

  const resetMatch = /^\/api\/admin\/users\/([^/]+)\/reset-password$/.exec(url.pathname);
  if (resetMatch) {
    assertMethod(request, ['POST']);
    await requireRole(request, config.env, 'admin');
    return json(await adminResetPassword(request, config.env, resetMatch[1]), { headers: corsHeaders(request, config, 'admin') });
  }

  const disableMatch = /^\/api\/admin\/users\/([^/]+)\/disable$/.exec(url.pathname);
  if (disableMatch) {
    assertMethod(request, ['POST']);
    const admin = await requireRole(request, config.env, 'admin');
    return json(await adminDisableUser(request, config.env, disableMatch[1], admin), { headers: corsHeaders(request, config, 'admin') });
  }

  const enableMatch = /^\/api\/admin\/users\/([^/]+)\/enable$/.exec(url.pathname);
  if (enableMatch) {
    assertMethod(request, ['POST']);
    await requireRole(request, config.env, 'admin');
    return json(await adminEnableUser(request, config.env, enableMatch[1]), { headers: corsHeaders(request, config, 'admin') });
  }

  if (url.pathname === '/api/private/ping') {
    assertMethod(request, ['GET']);
    requirePrivateBoundary(config);
  }

  if (url.pathname === '/api/admin/ping') {
    assertMethod(request, ['GET']);
    throw new HttpError(401, 'admin_authentication_required', 'Admin authentication is required');
  }

  throw new HttpError(404, 'not_found', 'Not found');
}

export async function handleApi(request, env) {
  const config = loadConfig(env);
  config.env = env;
  const boundary = routeBoundary(new URL(request.url).pathname);
  try {
    return await dispatch(request, config);
  } catch (error) {
    return errorJson(error, corsHeaders(request, config, boundary));
  }
}
