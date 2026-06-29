function matchOrigin(origin, allowedOrigins) {
  if (!origin) return null;
  if (allowedOrigins.includes('*')) return '*';
  return allowedOrigins.includes(origin) ? origin : null;
}

export function corsHeaders(request, config, boundary) {
  const origin = request.headers.get('origin');
  const allowed = boundary === 'admin'
    ? config.cors.adminOrigins
    : boundary === 'private'
      ? config.cors.privateOrigins
      : config.cors.publicOrigins;
  const allowedOrigin = matchOrigin(origin, allowed);
  if (!allowedOrigin) return {};
  return {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-inbox-token, x-admin-bootstrap-secret',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
}

export function preflight(request, config, boundary) {
  if (request.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(request, config, boundary) });
}
