import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, admin, approvedVolunteer, call, applyHandler, courtApplication } from './helpers.js';
import { buildLetterDocument, formatLongDate } from '../api/_lib/services/letters.js';
import { ORG } from '../api/_lib/org.js';

async function letterEnv() {
  const env = await setup();
  const coord = await login('coord@test.org', 'coord-pass');
  const adminCookie = await login('admin@test.org', 'admin-pass');
  const { volunteer, assignment } = await approvedVolunteer(env, coord);
  const log = async (date, start, end, approve) => {
    const e = (await admin(coord, 'POST', 'hours', { body: {
      volunteer_id: volunteer.id, assignment_id: assignment.id, service_date: date, start_time: start, end_time: end, break_minutes: 0, supervisor_name: 'Sam'
    } })).json().entry;
    if (approve) await admin(coord, 'POST', 'verify-hours', { body: { id: e.id, decision: 'approve' } });
    return e;
  };
  return Object.assign(env, { coord, adminCookie, volunteer, assignment, log });
}

test('a letter cannot be drafted without supervisor-approved hours', async () => {
  const env = await letterEnv();
  await env.log('2026-10-01', '09:00', '12:00', false);
  const res = await admin(env.coord, 'POST', 'letters', { body: { volunteer_id: env.volunteer.id } });
  assert.equal(res.statusCode, 422);
});

test('drafts include only approved hours and the correct date range', async () => {
  const env = await letterEnv();
  await env.log('2026-09-05', '09:00', '12:00', true);
  await env.log('2026-10-01', '13:00', '14:30', true);
  await env.log('2026-10-10', '09:00', '17:00', false); // pending — must not count
  const letter = (await admin(env.coord, 'POST', 'letters', { body: { volunteer_id: env.volunteer.id } })).json().letter;
  assert.equal(letter.status, 'draft');
  assert.equal(letter.total_minutes, 270);
  assert.equal(letter.entry_count, 2);
  assert.equal(letter.first_service_date, '2026-09-05');
  assert.equal(letter.last_service_date, '2026-10-01');
  assert.equal(letter.signer_name, null);
  assert.match(letter.letter_number, /^BLF-VL-2026-[0-9A-F]{6}$/);
});

test('only an authorized signer can approve, after confirming review', async () => {
  const env = await letterEnv();
  await env.log('2026-09-05', '09:00', '12:00', true);
  const letter = (await admin(env.coord, 'POST', 'letters', { body: { volunteer_id: env.volunteer.id } })).json().letter;

  assert.equal((await admin(env.coord, 'POST', 'approve-letter', { body: { id: letter.id, confirm_reviewed: true } })).statusCode, 403);
  assert.equal((await admin(env.adminCookie, 'POST', 'approve-letter', { body: { id: letter.id } })).statusCode, 422);

  const ok = await admin(env.adminCookie, 'POST', 'approve-letter', { body: { id: letter.id, confirm_reviewed: true } });
  assert.equal(ok.statusCode, 200, ok.body);
  const approved = ok.json().letter;
  assert.equal(approved.status, 'approved');
  assert.equal(approved.signer_name, 'Alex Admin');
  assert.equal(approved.signer_title, 'President');
  assert.equal(approved.issue_date, '2026-10-21');
  assert.equal(approved.approved_by, env.admin.id);

  assert.equal((await admin(env.adminCookie, 'POST', 'approve-letter', { body: { id: letter.id, confirm_reviewed: true } })).statusCode, 409);
});

test('an admin without signer designation cannot approve', async () => {
  const env = await letterEnv();
  await env.ctx.repo.update('staff_users', env.admin.id, { can_sign_letters: false });
  await env.log('2026-09-05', '09:00', '12:00', true);
  const letter = (await admin(env.coord, 'POST', 'letters', { body: { volunteer_id: env.volunteer.id } })).json().letter;
  assert.equal((await admin(env.adminCookie, 'POST', 'approve-letter', { body: { id: letter.id, confirm_reviewed: true } })).statusCode, 403);
});

test('approval is refused if verified hours changed after drafting', async () => {
  const env = await letterEnv();
  await env.log('2026-09-05', '09:00', '12:00', true);
  const letter = (await admin(env.coord, 'POST', 'letters', { body: { volunteer_id: env.volunteer.id } })).json().letter;
  await env.log('2026-09-06', '09:00', '10:00', true);
  const res = await admin(env.adminCookie, 'POST', 'approve-letter', { body: { id: letter.id, confirm_reviewed: true } });
  assert.equal(res.statusCode, 409);
});

test('approved letters can only be voided by a signer, with a reason', async () => {
  const env = await letterEnv();
  await env.log('2026-09-05', '09:00', '12:00', true);
  const letter = (await admin(env.coord, 'POST', 'letters', { body: { volunteer_id: env.volunteer.id } })).json().letter;
  await admin(env.adminCookie, 'POST', 'approve-letter', { body: { id: letter.id, confirm_reviewed: true } });
  assert.equal((await admin(env.coord, 'POST', 'void-letter', { body: { id: letter.id, reason: 'x' } })).statusCode, 403);
  assert.equal((await admin(env.adminCookie, 'POST', 'void-letter', { body: { id: letter.id } })).statusCode, 422);
  assert.equal((await admin(env.adminCookie, 'POST', 'void-letter', { body: { id: letter.id, reason: 'Issued in error' } })).json().letter.status, 'void');
});

test('letter document: draft has no signer or issue date; approved shows typed signer only', () => {
  const volunteer = { first_name: 'Jordan', last_name: 'Rivera', track: 'general' };
  const base = { letter_number: 'BLF-VL-2026-ABC123', total_minutes: 270, entry_count: 2, first_service_date: '2026-09-05', last_service_date: '2026-10-01' };

  const draft = buildLetterDocument(Object.assign({ status: 'draft' }, base), volunteer, ORG);
  assert.equal(draft.isDraft, true);
  assert.equal(draft.signer, null);
  assert.equal(draft.issueDate, null);
  assert.match(draft.paragraphs[0], /Jordan Rivera completed 4\.50 hours of volunteer service with Bottor Learning Foundation between September 5, 2026 and October 1, 2026\./);

  const approved = buildLetterDocument(Object.assign({ status: 'approved', issue_date: '2026-10-21', signer_name: 'Alex Admin', signer_title: 'President' }, base), volunteer, ORG);
  assert.deepEqual(approved.signer, { name: 'Alex Admin', title: 'President' });
  assert.equal(approved.issueDate, 'October 21, 2026');
  assert.equal(JSON.stringify(approved).includes('signature_image'), false);
  assert.ok(approved.paragraphs.some((p) => p.includes(ORG.email) && p.includes('BLF-VL-2026-ABC123')));
});

test('court-ordered letters disclaim court recognition and name the agency', () => {
  const doc = buildLetterDocument(
    { status: 'approved', letter_number: 'N', total_minutes: 600, entry_count: 3, first_service_date: '2026-09-01', last_service_date: '2026-09-01', issue_date: '2026-10-21', signer_name: 'A', signer_title: 'B' },
    { first_name: 'Casey', last_name: 'Morgan', track: 'court_ordered', agency_name: 'County Program' },
    ORG
  );
  assert.match(doc.subject, /Community Service Hours — Casey Morgan/);
  assert.match(doc.paragraphs[0], /10\.00 hours of community service .* on September 1, 2026/);
  assert.ok(doc.paragraphs.some((p) => /determined by the court or supervising agency \(County Program\)/.test(p)));
});

test('the letter view API returns the document and approval capability', async () => {
  const env = await letterEnv();
  await call(applyHandler, { method: 'POST', url: '/api/apply', body: courtApplication() });
  await env.log('2026-09-05', '09:00', '12:00', true);
  const letter = (await admin(env.coord, 'POST', 'letters', { body: { volunteer_id: env.volunteer.id } })).json().letter;
  const asCoord = (await admin(env.coord, 'GET', 'letters', { query: { id: letter.id } })).json();
  assert.equal(asCoord.can_approve, false);
  assert.equal(asCoord.document.isDraft, true);
  const asAdmin = (await admin(env.adminCookie, 'GET', 'letters', { query: { id: letter.id } })).json();
  assert.equal(asAdmin.can_approve, true);
  assert.equal(formatLongDate('2026-01-09'), 'January 9, 2026');
});
