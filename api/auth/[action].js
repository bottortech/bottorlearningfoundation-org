// /api/auth/login | /api/auth/session | /api/auth/logout — staff sign-in.
import {
  HttpError, assertMethod, assertSameOrigin, clientIp, lastPathSegment, readJson, sendError, sendJson
} from '../_lib/http.js';
import { getContext } from '../_lib/context.js';
import { audit } from '../_lib/audit.js';
import { permissionsFor } from '../_lib/permissions.js';
import { checkThrottle } from '../_lib/throttle.js';
import {
  clearedCookies, findActiveStaff, publicStaffProfile, readSessionTokens, requireStaff, sessionCookies
} from '../_lib/session.js';
import { cleanText, isValidEmail } from '../../js/volunteer-core.js';

function sessionPayload(staff) {
  return { staff: publicStaffProfile(staff), permissions: permissionsFor(staff) };
}

async function login(req, res, ctx) {
  assertMethod(req, ['POST']);
  assertSameOrigin(req);
  const body = await readJson(req);
  const email = cleanText(body.email).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  if (!isValidEmail(email) || !password) throw new HttpError(422, 'Enter your email and password.');

  await checkThrottle(ctx, 'login:' + clientIp(req), {
    limit: 10, windowMs: 15 * 60 * 1000, message: 'Too many sign-in attempts. Please wait 15 minutes and try again.'
  });

  const result = await ctx.auth.signIn(email, password);
  if (!result) {
    await audit(ctx, null, 'auth.login_failed', 'staff_user', null, {});
    throw new HttpError(401, 'Email or password is incorrect.');
  }
  const staff = await findActiveStaff(ctx, result.user.id);
  if (!staff) {
    await audit(ctx, null, 'auth.login_denied', 'staff_user', null, {});
    throw new HttpError(403, 'This account does not have dashboard access. Contact an administrator.');
  }

  res.setHeader('Set-Cookie', sessionCookies(result.session, ctx.config.secureCookies));
  await audit(ctx, staff, 'auth.login', 'staff_user', staff.id, {});
  sendJson(res, 200, sessionPayload(staff));
}

async function session(req, res, ctx) {
  assertMethod(req, ['GET']);
  const staff = await requireStaff(req, res, ctx);
  sendJson(res, 200, sessionPayload(staff));
}

async function logout(req, res, ctx) {
  assertMethod(req, ['POST']);
  assertSameOrigin(req);
  const tokens = readSessionTokens(req);
  if (tokens.accessToken && ctx.auth.signOut) await ctx.auth.signOut(tokens.accessToken);
  res.setHeader('Set-Cookie', clearedCookies(ctx.config.secureCookies));
  sendJson(res, 200, { ok: true });
}

const ACTIONS = { login: login, session: session, logout: logout };

export default async function handler(req, res) {
  try {
    const action = ACTIONS[lastPathSegment(req)];
    if (!action) throw new HttpError(404, 'Not found.');
    const ctx = await getContext();
    await action(req, res, ctx);
  } catch (err) {
    sendError(res, err);
  }
}
