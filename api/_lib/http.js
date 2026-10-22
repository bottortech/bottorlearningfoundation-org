// HTTP helpers that work with Vercel's Node runtime, the local dev server,
// and plain test doubles (only native req/res features are used).

const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

export class ConfigError extends Error {}

// Database errors from the Supabase layer carry a Postgres error code.
export class DbError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}

export function sendError(res, err) {
  if (err instanceof HttpError) {
    return sendJson(res, err.status, Object.assign({ error: err.message }, err.extra));
  }
  if (err instanceof ConfigError) {
    console.error('[volunteer-api] configuration error:', err.message);
    return sendJson(res, 503, { error: 'The volunteer system is not configured yet. Please try again later.' });
  }
  if (err instanceof DbError) {
    if (err.code === '23P01') return sendJson(res, 409, { error: 'This entry overlaps another hour entry for the same volunteer.' });
    if (err.code === '23505') return sendJson(res, 409, { error: 'A matching record already exists.' });
    if (err.code === 'P0001') return sendJson(res, 403, { error: err.message });
  }
  // Never leak internals (or volunteer data) in error responses.
  console.error('[volunteer-api] unexpected error:', err && err.message);
  return sendJson(res, 500, { error: 'Something went wrong on our end. Please try again.' });
}

export async function readJson(req) {
  const type = String(req.headers['content-type'] || '');
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Requests must be sent as JSON.');
  }

  let body;
  try {
    body = req.body;
  } catch (e) {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
  if (body !== undefined && body !== null && typeof body === 'object') return body;
  if (typeof body === 'string') return parse(body);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'The request is too large.');
    chunks.push(chunk);
  }
  return parse(Buffer.concat(chunks).toString('utf8') || '{}');

  function parse(text) {
    if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'The request is too large.');
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed;
    } catch (e) {
      throw new HttpError(400, 'The request body is not valid JSON.');
    }
  }
}

export function getUrl(req) {
  return new URL(req.url || '/', 'http://localhost');
}

export function lastPathSegment(req) {
  const parts = getUrl(req).pathname.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

// CSRF defense for cookie-authenticated, state-changing requests
// (in addition to SameSite=Strict cookies and the JSON-only body rule).
export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch (e) {
    throw new HttpError(403, 'Cross-site requests are not allowed.');
  }
  if (originHost !== host) throw new HttpError(403, 'Cross-site requests are not allowed.');
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '');
  return forwarded.split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
}

export function assertMethod(req, allowed) {
  if (allowed.indexOf(req.method) === -1) {
    throw new HttpError(405, 'Method not allowed.');
  }
}
