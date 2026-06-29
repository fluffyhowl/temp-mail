const baseJsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...baseJsonHeaders,
      ...(init.headers || {})
    }
  });
}

export function errorJson(error, corsHeaders = {}) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'internal_error';
  const message = error instanceof HttpError ? error.message : 'Internal server error';
  return json({ error: { code, message } }, { status, headers: corsHeaders });
}

export function methodNotAllowed(allowed) {
  return new HttpError(405, 'method_not_allowed', `Method not allowed. Use ${allowed.join(', ')}.`);
}
