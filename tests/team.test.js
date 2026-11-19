import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, permissionsFor, ADMIN_ONLY, PERMISSIONS } from '../api/_lib/permissions.js';
import { setup, login, admin } from './helpers.js';

const NEW_PERMISSIONS = [
  'donations.view', 'donations.manage', 'donors.view_contact', 'inventory.view', 'inventory.record',
  'inventory.adjust', 'impact.view', 'impact.record', 'impact.goals', 'impact.publish',
  'acknowledgments.view', 'acknowledgments.manage', 'records.export', 'permissions.manage'
];

test('existing role access is unchanged and new permissions start admin-only', () => {
  const coordinator = { role: 'coordinator', active: true };
  const supervisor = { role: 'supervisor', active: true };
  assert.deepEqual(permissionsFor(coordinator).sort(), [
    'applications.review', 'assignments.manage', 'assignments.view', 'court.record', 'dashboard.view',
    'hours.correct', 'hours.export', 'hours.record', 'hours.verify', 'hours.view', 'letters.draft',
    'letters.view', 'volunteers.manage', 'volunteers.view'
  ]);
  assert.deepEqual(permissionsFor(supervisor).sort(), [
    'assignments.view', 'dashboard.view', 'hours.record', 'hours.verify', 'hours.view', 'volunteers.view'
  ]);
  for (const p of NEW_PERMISSIONS) {
    assert.equal(can({ role: 'admin', active: true }, p), true, 'admin should have ' + p);
    assert.equal(can(coordinator, p), false, 'coordinator should not have ' + p);
  }
});

test('per-person overrides grant and revoke single permissions', () => {
  const volunteer = { role: 'supervisor', active: true, permission_overrides: { 'inventory.record': 'grant', 'hours.verify': 'revoke' } };
  assert.equal(can(volunteer, 'inventory.record'), true);
  assert.equal(can(volunteer, 'inventory.adjust'), false);
  assert.equal(can(volunteer, 'hours.verify'), false);
  assert.equal(can(volunteer, 'hours.record'), true);
});

test('admin-only permissions ignore overrides', () => {
  for (const p of ADMIN_ONLY) {
    assert.ok(PERMISSIONS[p], p + ' exists');
    assert.equal(can({ role: 'coordinator', active: true, permission_overrides: { [p]: 'grant' } }, p), false, p + ' cannot be granted');
  }
  assert.equal(can({ role: 'admin', active: true, permission_overrides: { 'permissions.manage': 'revoke' } }, 'permissions.manage'), true);
});

test('API: only administrators can view and change permissions', async () => {
  await setup();
  const coord = await login('coord@test.org', 'coord-pass');
  assert.equal((await admin(coord, 'GET', 'team')).statusCode, 403);
  assert.equal((await admin(coord, 'POST', 'team-permission', { body: {} })).statusCode, 403);
});

test('API: granting a permission takes effect on the person’s next request, and is audited', async () => {
  const env = await setup();
  const adminCookie = await login('admin@test.org', 'admin-pass');
  const sup = await login('super@test.org', 'super-pass');
  assert.equal((await admin(sup, 'GET', 'applications')).statusCode, 403);

  const res = await admin(adminCookie, 'POST', 'team-permission', { body: { staff_id: env.supervisor.id, permission: 'applications.review', effect: 'grant' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().member.permissions['applications.review'].allowed, true);
  assert.equal(res.json().member.permissions['applications.review'].source, 'grant');
  assert.equal((await admin(sup, 'GET', 'applications')).statusCode, 200);

  const [event] = await env.ctx.repo.list('audit_log', { eq: { action: 'permission.grant' } });
  assert.equal(event.entity_id, env.supervisor.id);
  assert.deepEqual(event.details, { permission: 'applications.review' });

  // Back to the role default.
  await admin(adminCookie, 'POST', 'team-permission', { body: { staff_id: env.supervisor.id, permission: 'applications.review', effect: 'default' } });
  assert.equal((await admin(sup, 'GET', 'applications')).statusCode, 403);
  assert.equal((await env.ctx.repo.list('staff_permission_grants', {})).length, 0);
});

test('API: revoking removes a role default for one person only', async () => {
  const env = await setup();
  const adminCookie = await login('admin@test.org', 'admin-pass');
  const coord = await login('coord@test.org', 'coord-pass');
  await admin(adminCookie, 'POST', 'team-permission', { body: { staff_id: env.coordinator.id, permission: 'hours.export', effect: 'revoke' } });
  assert.equal((await admin(coord, 'GET', 'hours-export')).statusCode, 403);
  assert.equal((await admin(adminCookie, 'GET', 'hours-export')).statusCode, 200);
});

test('API: admin-only and unknown permissions are refused', async () => {
  const env = await setup();
  const adminCookie = await login('admin@test.org', 'admin-pass');
  for (const permission of ['permissions.manage', 'letters.approve', 'impact.publish', 'retention.manage']) {
    const r = await admin(adminCookie, 'POST', 'team-permission', { body: { staff_id: env.coordinator.id, permission, effect: 'grant' } });
    assert.equal(r.statusCode, 422, permission);
  }
  const self = await admin(adminCookie, 'POST', 'team-permission', { body: { staff_id: env.admin.id, permission: 'permissions.manage', effect: 'revoke' } });
  assert.equal(self.statusCode, 422);
  const unknown = await admin(adminCookie, 'POST', 'team-permission', { body: { staff_id: env.coordinator.id, permission: 'everything', effect: 'grant' } });
  assert.equal(unknown.statusCode, 422);
});

test('API: team list shows everyone with effective access, without auth ids', async () => {
  await setup();
  const adminCookie = await login('admin@test.org', 'admin-pass');
  const data = (await admin(adminCookie, 'GET', 'team')).json();
  assert.equal(data.members.length, 3);
  assert.ok(data.catalog.find((p) => p.key === 'inventory.record'));
  assert.equal(JSON.stringify(data).includes('auth_user_id'), false);
  const sup = data.members.find((m) => m.role === 'supervisor');
  assert.equal(sup.permissions['hours.verify'].allowed, true);
  assert.equal(sup.permissions['donations.view'].allowed, false);
});

test('session payload includes granted permissions for the portal menu', async () => {
  const env = await setup();
  const adminCookie = await login('admin@test.org', 'admin-pass');
  await admin(adminCookie, 'POST', 'team-permission', { body: { staff_id: env.supervisor.id, permission: 'inventory.record', effect: 'grant' } });
  const { call, authHandler } = await import('./helpers.js');
  const sup = await login('super@test.org', 'super-pass');
  const res = await call(authHandler, { method: 'GET', url: '/api/auth/session', cookie: sup });
  assert.ok(res.json().permissions.includes('inventory.record'));
});

test('sign-in still works if migration 002 has not been run yet', async () => {
  const env = await setup();
  const { DbError } = await import('../api/_lib/http.js');
  const list = env.ctx.repo.list.bind(env.ctx.repo);
  env.ctx.repo.list = async (table, query) => {
    if (table === 'staff_permission_grants') throw new DbError("Could not find the table 'public.staff_permission_grants'", 'PGRST205');
    return list(table, query);
  };
  const coord = await login('coord@test.org', 'coord-pass');
  assert.equal((await admin(coord, 'GET', 'applications')).statusCode, 200);
});
