import { HttpError } from './http.js';

const ACCESS_COOKIE = 'blf_staff_at';
const REFRESH_COOKIE = 'blf_staff_rt';
// Staff must sign in again at least this often, even with a valid refresh token.
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

export function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(function (part) {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    if (!key) return;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch (e) {
      out[key] = '';
    }
  });
  return out;
}

function cookie(name, value, maxAge, secure) {
  return [
    name + '=' + encodeURIComponent(value),
    'Path=/api',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + maxAge,
    secure ? 'Secure' : ''
  ].filter(Boolean).join('; ');
}

export function sessionCookies(session, secure) {
  const accessAge = Math.min(Number(session.expires_in) || 3600, SESSION_MAX_AGE_SECONDS);
  return [
    cookie(ACCESS_COOKIE, session.access_token, accessAge, secure),
    cookie(REFRESH_COOKIE, session.refresh_token, SESSION_MAX_AGE_SECONDS, secure)
  ];
}

export function clearedCookies(secure) {
  return [cookie(ACCESS_COOKIE, '', 0, secure), cookie(REFRESH_COOKIE, '', 0, secure)];
}

export function readSessionTokens(req) {
  const cookies = parseCookies(req.headers.cookie);
  return { accessToken: cookies[ACCESS_COOKIE] || null, refreshToken: cookies[REFRESH_COOKIE] || null };
}

export async function findActiveStaff(ctx, authUserId) {
  const rows = await ctx.repo.list('staff_users', { eq: { auth_user_id: authUserId, active: true }, limit: 1 });
  return rows[0] || null;
}

/**
 * Resolve the signed-in staff member, refreshing an expired access token
 * when possible. Throws 401 (not signed in) or 403 (not staff).
 */
export async function requireStaff(req, res, ctx) {
  const tokens = readSessionTokens(req);
  let user = tokens.accessToken ? await ctx.auth.getUser(tokens.accessToken) : null;

  if (!user && tokens.refreshToken) {
    const refreshed = await ctx.auth.refresh(tokens.refreshToken);
    if (refreshed) {
      user = refreshed.user;
      res.setHeader('Set-Cookie', sessionCookies(refreshed.session, ctx.config.secureCookies));
    }
  }
  if (!user) throw new HttpError(401, 'Please sign in to continue.');

  const staff = await findActiveStaff(ctx, user.id);
  if (!staff) throw new HttpError(403, 'This account does not have dashboard access.');
  return staff;
}

export function publicStaffProfile(staff) {
  return {
    id: staff.id,
    full_name: staff.full_name,
    email: staff.email,
    role: staff.role,
    title: staff.title || null,
    can_sign_letters: staff.can_sign_letters === true
  };
}
