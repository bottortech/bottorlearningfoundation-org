import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, login, admin, call, applyHandler, validApplication, courtApplication, approvedVolunteer, NOW
} from './helpers.js';
import { AGREEMENT_VERSION } from '../js/volunteer-agreement.js';
import { youthClearance } from '../api/_lib/services/volunteers.js';

const apply = (body, opts) => call(applyHandler, Object.assign({ method: 'POST', url: '/api/apply', body }, opts || {}));

test('a valid application is stored as pending with an agreement acknowledgment', async () => {
  const { ctx } = await setup();
  const res = await apply(validApplication());
  assert.equal(res.statusCode, 201, res.body);
  assert.match(res.json().reference, /^BLF-[0-9A-F]{8}$/);

  const [v] = await ctx.repo.list('volunteers', {});
  assert.equal(v.status, 'pending');
  assert.equal(v.screening_status, 'not_started');
  assert.equal(v.supervision_required, true);
  const [ack] = await ctx.repo.list('agreement_acknowledgments', {});
  assert.equal(ack.volunteer_id, v.id);
  assert.equal(ack.agreement_version, AGREEMENT_VERSION);
  assert.equal(ack.acknowledged_at, NOW);
  assert.equal(ack.typed_name, 'Jordan Rivera');

  const [event] = await ctx.repo.list('audit_log', { eq: { action: 'application.submitted' } });
  assert.doesNotMatch(JSON.stringify(event.details), /Jordan|example\.com/);
});

test('the response never echoes stored personal data', async () => {
  await setup();
  const res = await apply(validApplication());
  assert.doesNotMatch(res.body, /Jordan|555|example\.com/);
});

test('validation errors are returned per field', async () => {
  await setup();
  const res = await apply(validApplication({ email: 'bad' }));
  assert.equal(res.statusCode, 422);
  assert.ok(res.json().errors.email);
});

test('honeypot submissions look successful but are not stored', async () => {
  const { ctx } = await setup();
  const res = await apply(validApplication({ website: 'http://spam.example' }));
  assert.equal(res.statusCode, 201);
  assert.equal((await ctx.repo.list('volunteers', {})).length, 0);
});

test('forms submitted instantly are rejected', async () => {
  const { ctx } = await setup();
  const res = await apply(validApplication({ form_started_at: Date.parse(NOW) - 500 }));
  assert.equal(res.statusCode, 422);
  assert.equal((await ctx.repo.list('volunteers', {})).length, 0);
});

test('submissions are rate-limited per connection', async () => {
  await setup();
  for (let i = 0; i < 5; i++) {
    const r = await apply(validApplication({ email: 'p' + i + '@example.com' }));
    assert.equal(r.statusCode, 201);
  }
  const blocked = await apply(validApplication({ email: 'p9@example.com' }));
  assert.equal(blocked.statusCode, 429);
  const other = await apply(validApplication({ email: 'p10@example.com' }), { ip: '10.0.0.2' });
  assert.equal(other.statusCode, 201);
});

test('duplicate pending applications are refused', async () => {
  await setup();
  assert.equal((await apply(validApplication())).statusCode, 201);
  assert.equal((await apply(validApplication({ email: 'JORDAN.rivera@example.com' }))).statusCode, 409);
});

test('court-ordered applicants: stored with target hours; court approval recorded separately', async () => {
  const { ctx } = await setup();
  assert.equal((await apply(courtApplication())).statusCode, 201);
  const [v] = await ctx.repo.list('volunteers', {});
  assert.equal(v.track, 'court_ordered');
  assert.equal(v.target_hours, 40);
  assert.equal(v.court_reported_status, 'pending');
  assert.equal(v.court_approval_status, 'not_recorded');

  const cookie = await login('coord@test.org', 'coord-pass');
  const res = await admin(cookie, 'POST', 'court-approval', { body: { volunteer_id: v.id, status: 'approved', notes: 'Confirmed by phone with Officer Lee' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().volunteer.court_approval_status, 'approved');
  assert.ok(res.json().volunteer.court_approval_recorded_at);
});

test('approving and declining applications', async () => {
  const { ctx } = await setup();
  await apply(validApplication());
  await apply(validApplication({ email: 'two@example.com' }));
  const [a, b] = await ctx.repo.list('volunteers', { order: ['email', 'asc'] });
  const cookie = await login('coord@test.org', 'coord-pass');

  const noReason = await admin(cookie, 'POST', 'decision', { body: { volunteer_id: a.id, decision: 'decline' } });
  assert.equal(noReason.statusCode, 422);
  const declined = await admin(cookie, 'POST', 'decision', { body: { volunteer_id: a.id, decision: 'decline', reason: 'No current openings' } });
  assert.equal(declined.json().volunteer.status, 'declined');
  const approved = await admin(cookie, 'POST', 'decision', { body: { volunteer_id: b.id, decision: 'approve' } });
  assert.equal(approved.json().volunteer.status, 'approved');
  const again = await admin(cookie, 'POST', 'decision', { body: { volunteer_id: b.id, decision: 'decline', reason: 'x' } });
  assert.equal(again.statusCode, 409);
});

test('youth-facing assignments require cleared screening before placement', async () => {
  const env = await setup();
  const cookie = await login('coord@test.org', 'coord-pass');
  await apply(validApplication());
  const [v] = await env.ctx.repo.list('volunteers', {});
  await admin(cookie, 'POST', 'decision', { body: { volunteer_id: v.id, decision: 'approve' } });
  const youth = (await admin(cookie, 'POST', 'assignments', { body: { name: 'Inventor Workshop Classroom', youth_facing: true, requires_supervision: false } })).json().assignment;
  assert.equal(youth.requires_supervision, true, 'youth-facing work is always supervised');

  const blocked = await admin(cookie, 'POST', 'placements', { body: { volunteer_id: v.id, assignment_id: youth.id, supervisor_name: 'Sam' } });
  assert.equal(blocked.statusCode, 422);
  assert.ok(blocked.json().reasons.length >= 2);

  await admin(cookie, 'PATCH', 'volunteers', { query: { id: v.id }, body: { screening_status: 'cleared', background_check_status: 'cleared', background_check_expires_on: '2028-01-01' } });
  const ok = await admin(cookie, 'POST', 'placements', { body: { volunteer_id: v.id, assignment_id: youth.id, supervisor_name: 'Sam' } });
  assert.equal(ok.statusCode, 200, ok.body);

  // Losing clearance automatically ends youth-facing placements.
  const downgraded = await admin(cookie, 'PATCH', 'volunteers', { query: { id: v.id }, body: { background_check_status: 'expired' } });
  assert.equal(downgraded.json().ended_youth_placements, 1);
});

test('youth clearance rules', () => {
  const base = { status: 'approved', screening_status: 'cleared', background_check_status: 'cleared' };
  assert.equal(youthClearance(base, '2026-10-21').cleared, true);
  assert.equal(youthClearance(Object.assign({}, base, { background_check_status: 'not_required' }), '2026-10-21').cleared, true);
  assert.equal(youthClearance(Object.assign({}, base, { background_check_expires_on: '2026-10-01' }), '2026-10-21').cleared, false);
  assert.equal(youthClearance(Object.assign({}, base, { screening_status: 'in_progress' }), '2026-10-21').cleared, false);
});

test('background check reference refuses SSN-like values', async () => {
  const env = await setup();
  const cookie = await login('coord@test.org', 'coord-pass');
  const { volunteer } = await approvedVolunteer(env, cookie);
  const res = await admin(cookie, 'PATCH', 'volunteers', { query: { id: volunteer.id }, body: { background_check_reference: '123-45-6789' } });
  assert.equal(res.statusCode, 422);
});

test('retention: only records past the retention window can be purged, with confirmation', async () => {
  const env = await setup();
  const cookie = await login('admin@test.org', 'admin-pass');
  await apply(validApplication());
  const [v] = await env.ctx.repo.list('volunteers', {});
  await admin(cookie, 'POST', 'decision', { body: { volunteer_id: v.id, decision: 'decline', reason: 'Not a fit' } });

  assert.equal((await admin(cookie, 'GET', 'retention')).json().eligible.length, 0);
  const early = await admin(cookie, 'POST', 'retention', { body: { volunteer_ids: [v.id], confirm: 'PURGE' } });
  assert.equal(early.statusCode, 409);

  env.ctx.setNow('2027-11-01T12:00:00Z');
  assert.equal((await admin(cookie, 'GET', 'retention')).json().eligible.length, 1);
  assert.equal((await admin(cookie, 'POST', 'retention', { body: { volunteer_ids: [v.id] } })).statusCode, 422);
  const purged = await admin(cookie, 'POST', 'retention', { body: { volunteer_ids: [v.id], confirm: 'PURGE' } });
  assert.equal(purged.json().purged, 1);
  assert.equal((await env.ctx.repo.list('volunteers', {})).length, 0);
  assert.equal((await env.ctx.repo.list('agreement_acknowledgments', {})).length, 0);
});
