import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, PERMISSIONS } from '../api/_lib/permissions.js';
import { ROUTES } from '../api/admin/[resource].js';
import {
  setup, login, admin, call, authHandler, adminHandler, applyHandler, validApplication, courtApplication
} from './helpers.js';

const staff = (role, extra) => Object.assign({ role, active: true }, extra || {});

test('role matrix', () => {
  assert.equal(can(staff('supervisor'), 'hours.verify'), true);
  assert.equal(can(staff('supervisor'), 'applications.review'), false);
  assert.equal(can(staff('supervisor'), 'hours.export'), false);
  assert.equal(can(staff('coordinator'), 'letters.draft'), true);
  assert.equal(can(staff('coordinator'), 'letters.approve'), false);
  assert.equal(can(staff('coordinator'), 'audit.view'), false);
  assert.equal(can(staff('admin'), 'retention.manage'), true);
  assert.equal(can(staff('admin', { active: false }), 'dashboard.view'), false);
  assert.equal(can(staff('nobody'), 'dashboard.view'), false);
});

test('letter approval needs an admin who is a designated, titled signer', () => {
  assert.equal(can(staff('admin'), 'letters.approve'), false);
  assert.equal(can(staff('admin', { can_sign_letters: true }), 'letters.approve'), false);
  assert.equal(can(staff('admin', { can_sign_letters: true, title: 'President' }), 'letters.approve'), true);
});

test('every admin route maps to a known permission', () => {
  for (const [resource, methods] of Object.entries(ROUTES)) {
    for (const [method, r] of Object.entries(methods)) {
      assert.ok(PERMISSIONS[r.permission], resource + ' ' + method + ' uses unknown permission ' + r.permission);
    }
  }
});

test('admin API requires sign-in', async () => {
  await setup();
  for (const resource of Object.keys(ROUTES)) {
    const method = Object.keys(ROUTES[resource])[0];
    const res = await call(adminHandler, { method, url: '/api/admin/' + resource, body: method === 'GET' ? undefined : {} });
    assert.equal(res.statusCode, 401, resource + ' should require auth');
    assert.doesNotMatch(res.body, /Jordan|@/);
  }
});

test('forged or garbage cookies are rejected', async () => {
  await setup();
  const res = await admin('blf_staff_at=forged; blf_staff_rt=forged', 'GET', 'volunteers');
  assert.equal(res.statusCode, 401);
});

test('login sets httpOnly, SameSite=Strict cookies scoped to /api and returns the profile', async () => {
  await setup();
  const res = await call(authHandler, { method: 'POST', url: '/api/auth/login', body: { email: 'admin@test.org', password: 'admin-pass' } });
  assert.equal(res.statusCode, 200);
  for (const c of res.headers['set-cookie']) {
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
    assert.match(c, /Path=\/api/);
  }
  assert.equal(res.json().staff.role, 'admin');
  assert.equal('auth_user_id' in res.json().staff, false);
});

test('wrong password and non-staff accounts cannot sign in', async () => {
  const { ctx } = await setup();
  const bad = await call(authHandler, { method: 'POST', url: '/api/auth/login', body: { email: 'admin@test.org', password: 'nope' } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.headers['set-cookie'], undefined);

  ctx.auth.addUser('random@test.org', 'pw-123456');
  const outsider = await call(authHandler, { method: 'POST', url: '/api/auth/login', body: { email: 'random@test.org', password: 'pw-123456' } });
  assert.equal(outsider.statusCode, 403);
  assert.equal(outsider.headers['set-cookie'], undefined);
});

test('deactivated staff lose access immediately', async () => {
  const { ctx, coordinator } = await setup();
  const cookie = await login('coord@test.org', 'coord-pass');
  assert.equal((await admin(cookie, 'GET', 'dashboard')).statusCode, 200);
  await ctx.repo.update('staff_users', coordinator.id, { active: false });
  assert.equal((await admin(cookie, 'GET', 'dashboard')).statusCode, 403);
});

test('expired access tokens are refreshed using the refresh cookie', async () => {
  const { ctx } = await setup();
  const cookie = await login('admin@test.org', 'admin-pass');
  ctx.auth.expireAccessTokens();
  const res = await admin(cookie, 'GET', 'dashboard');
  assert.equal(res.statusCode, 200);
  assert.ok(res.headers['set-cookie'], 'new cookies should be issued');
});

test('role enforcement on the API', async () => {
  await setup();
  const sup = await login('super@test.org', 'super-pass');
  const coord = await login('coord@test.org', 'coord-pass');
  assert.equal((await admin(sup, 'GET', 'applications')).statusCode, 403);
  assert.equal((await admin(sup, 'POST', 'decision', { body: {} })).statusCode, 403);
  assert.equal((await admin(sup, 'POST', 'assignments', { body: { name: 'x' } })).statusCode, 403);
  assert.equal((await admin(sup, 'GET', 'audit')).statusCode, 403);
  assert.equal((await admin(coord, 'POST', 'approve-letter', { body: {} })).statusCode, 403);
  assert.equal((await admin(coord, 'GET', 'retention')).statusCode, 403);
  assert.equal((await admin(coord, 'GET', 'audit')).statusCode, 403);
});

test('cross-site state-changing requests are blocked', async () => {
  await setup();
  const cookie = await login('admin@test.org', 'admin-pass');
  const res = await call(adminHandler, { method: 'POST', url: '/api/admin/assignments', body: { name: 'x' }, cookie, headers: { origin: 'https://evil.example' } });
  assert.equal(res.statusCode, 403);
});

test('non-JSON bodies are rejected (blocks HTML form CSRF)', async () => {
  await setup();
  const cookie = await login('admin@test.org', 'admin-pass');
  const res = await call(adminHandler, { method: 'POST', url: '/api/admin/assignments', cookie, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.statusCode, 415);
});

test('supervisors see a redacted volunteer record and no pending applicants', async () => {
  const env = await setup();
  const coord = await login('coord@test.org', 'coord-pass');
  await call(applyHandler, { method: 'POST', url: '/api/apply', body: courtApplication() });
  const [court] = await env.ctx.repo.list('volunteers', { eq: { track: 'court_ordered' } });
  await admin(coord, 'POST', 'decision', { body: { volunteer_id: court.id, decision: 'approve' } });
  await admin(coord, 'PATCH', 'volunteers', { query: { id: court.id }, body: { admin_notes: 'Internal note' } });
  await call(applyHandler, { method: 'POST', url: '/api/apply', body: validApplication({ email: 'pending@example.com' }) });

  const sup = await login('super@test.org', 'super-pass');
  const list = (await admin(sup, 'GET', 'volunteers')).json().volunteers;
  assert.equal(list.length, 1);
  assert.equal(list[0].admin_notes, undefined);
  assert.equal(list[0].agency_contact_email, undefined);

  const detail = (await admin(sup, 'GET', 'volunteers', { query: { id: court.id } })).json();
  assert.equal(detail.volunteer.admin_notes, undefined);
  assert.deepEqual(detail.letters, []);
});
