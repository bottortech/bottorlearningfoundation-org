import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateNetMinutes, findOverlap, summarizeHours, formatHours } from '../js/volunteer-core.js';
import { csvCell } from '../api/_lib/services/hours.js';
import { setup, login, admin, approvedVolunteer } from './helpers.js';

test('net minutes subtract breaks', () => {
  assert.deepEqual(calculateNetMinutes('09:00', '12:30', 30), { ok: true, minutes: 180 });
  assert.deepEqual(calculateNetMinutes('09:00', '09:45', ''), { ok: true, minutes: 45 });
});

test('negative, zero, and overnight entries are rejected', () => {
  assert.equal(calculateNetMinutes('12:00', '09:00', 0).ok, false);
  assert.equal(calculateNetMinutes('09:00', '09:00', 0).ok, false);
  assert.equal(calculateNetMinutes('09:00', '10:00', 60).ok, false);
  assert.equal(calculateNetMinutes('09:00', '10:00', -5).ok, false);
  assert.equal(calculateNetMinutes('09:00', '10:00', 1.5).ok, false);
  assert.equal(calculateNetMinutes('25:00', '26:00', 0).ok, false);
});

test('overlap detection ignores rejected/voided entries and adjacent shifts', () => {
  const base = { volunteer_id: 'v1', service_date: '2026-10-01', status: 'approved' };
  const existing = [
    Object.assign({ id: 'a', start_time: '09:00', end_time: '12:00' }, base),
    Object.assign({ id: 'b', start_time: '13:00', end_time: '15:00' }, base, { status: 'rejected' })
  ];
  assert.equal(findOverlap({ volunteer_id: 'v1', service_date: '2026-10-01', start_time: '11:00', end_time: '13:00' }, existing).id, 'a');
  assert.equal(findOverlap({ volunteer_id: 'v1', service_date: '2026-10-01', start_time: '12:00', end_time: '13:30' }, existing), null);
  assert.equal(findOverlap({ volunteer_id: 'v1', service_date: '2026-10-02', start_time: '09:00', end_time: '12:00' }, existing), null);
  assert.equal(findOverlap({ id: 'a', volunteer_id: 'v1', service_date: '2026-10-01', start_time: '09:00', end_time: '11:00' }, existing), null);
});

test('only approved hours count toward verified progress', () => {
  const s = summarizeHours([
    { status: 'approved', net_minutes: 120, service_date: '2026-09-02' },
    { status: 'approved', net_minutes: 90, service_date: '2026-09-01' },
    { status: 'pending', net_minutes: 600, service_date: '2026-09-03' },
    { status: 'rejected', net_minutes: 600, service_date: '2026-09-04' }
  ], 10);
  assert.equal(s.verifiedMinutes, 210);
  assert.equal(s.pendingMinutes, 600);
  assert.equal(s.firstServiceDate, '2026-09-01');
  assert.equal(s.lastServiceDate, '2026-09-02');
  assert.equal(s.percent, 35);
  assert.equal(s.remainingMinutes, 390);
  assert.equal(formatHours(210), '3.50');
});

test('CSV cells are escaped and protected from formula injection', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(null), '');
});

async function hoursEnv() {
  const env = await setup();
  const cookie = await login('coord@test.org', 'coord-pass');
  const { volunteer, assignment } = await approvedVolunteer(env, cookie);
  return Object.assign(env, { cookie, volunteer, assignment });
}

const shift = (env, overrides) => Object.assign({
  volunteer_id: env.volunteer.id, assignment_id: env.assignment.id, service_date: '2026-10-15',
  start_time: '09:00', end_time: '12:00', break_minutes: 15, supervisor_name: 'Sam Supervisor'
}, overrides || {});

test('API: creating an entry computes net minutes server-side and starts pending', async () => {
  const env = await hoursEnv();
  const res = await admin(env.cookie, 'POST', 'hours', { body: shift(env, { net_minutes: 9999 }) });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().entry.net_minutes, 165);
  assert.equal(res.json().entry.status, 'pending');
});

test('API: overlapping entries are refused', async () => {
  const env = await hoursEnv();
  await admin(env.cookie, 'POST', 'hours', { body: shift(env) });
  const res = await admin(env.cookie, 'POST', 'hours', { body: shift(env, { start_time: '11:00', end_time: '13:00', break_minutes: 0 }) });
  assert.equal(res.statusCode, 409);
});

test('API: hours require an assignment placement', async () => {
  const env = await hoursEnv();
  const other = (await admin(env.cookie, 'POST', 'assignments', { body: { name: 'Book Drive' } })).json().assignment;
  const res = await admin(env.cookie, 'POST', 'hours', { body: shift(env, { assignment_id: other.id }) });
  assert.equal(res.statusCode, 422);
});

test('API: staff cannot verify their own volunteer hours', async () => {
  const env = await hoursEnv();
  const entry = (await admin(env.cookie, 'POST', 'hours', { body: shift(env) })).json().entry;
  // Link the coordinator account to this volunteer record.
  await env.ctx.repo.update('staff_users', env.coordinator.id, { volunteer_id: env.volunteer.id });
  const self = await admin(env.cookie, 'POST', 'verify-hours', { body: { id: entry.id, decision: 'approve' } });
  assert.equal(self.statusCode, 403);

  const supCookie = await login('super@test.org', 'super-pass');
  const ok = await admin(supCookie, 'POST', 'verify-hours', { body: { id: entry.id, decision: 'approve' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().entry.status, 'approved');
  assert.equal(ok.json().entry.verified_by, env.supervisor.id);
});

test('API: rejecting hours requires a note', async () => {
  const env = await hoursEnv();
  const entry = (await admin(env.cookie, 'POST', 'hours', { body: shift(env) })).json().entry;
  const res = await admin(env.cookie, 'POST', 'verify-hours', { body: { id: entry.id, decision: 'reject' } });
  assert.equal(res.statusCode, 422);
});

test('API: corrections keep history and send approved entries back for re-verification', async () => {
  const env = await hoursEnv();
  const entry = (await admin(env.cookie, 'POST', 'hours', { body: shift(env) })).json().entry;
  await admin(env.cookie, 'POST', 'verify-hours', { body: { id: entry.id, decision: 'approve' } });

  const noReason = await admin(env.cookie, 'PATCH', 'hours', { query: { id: entry.id }, body: { end_time: '13:00' } });
  assert.equal(noReason.statusCode, 422);

  const fixed = await admin(env.cookie, 'PATCH', 'hours', { query: { id: entry.id }, body: { end_time: '13:00', reason: 'Stayed late for cleanup' } });
  assert.equal(fixed.statusCode, 200, fixed.body);
  assert.equal(fixed.json().entry.status, 'pending');
  assert.equal(fixed.json().entry.net_minutes, 225);
  assert.equal(fixed.json().entry.verified_by, null);

  const history = (await admin(env.cookie, 'GET', 'hour-history', { query: { id: entry.id } })).json();
  assert.equal(history.revisions.length, 1);
  assert.equal(history.revisions[0].previous.end_time, '12:00');
  assert.equal(history.revisions[0].previous.status, 'approved');
});

test('API: CSV export includes entries and requires export permission', async () => {
  const env = await hoursEnv();
  await admin(env.cookie, 'POST', 'hours', { body: shift(env, { notes: '=cmd' }) });
  const res = await admin(env.cookie, 'GET', 'hours-export');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.body, /Jordan Rivera,Event Setup,2026-10-15,09:00,12:00,15,2.75/);
  assert.match(res.body, /'=cmd/);

  const supCookie = await login('super@test.org', 'super-pass');
  assert.equal((await admin(supCookie, 'GET', 'hours-export')).statusCode, 403);
});
