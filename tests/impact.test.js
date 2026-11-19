import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, login, admin, approvedVolunteer } from './helpers.js';
import { combineQualifiers, formatFigure, executiveSummary, resolveRange } from '../api/_lib/services/impact.js';

async function env() {
  const e = await setup();
  e.cookie = await login('admin@test.org', 'admin-pass');
  e.cats = {};
  for (const [i, slug] of ['books', 'clothing', 'electronics', 'educational_supplies', 'other'].entries()) {
    e.cats[slug] = await e.ctx.repo.insert('inventory_categories', { id: randomUUID(), slug, name: slug, sort_order: i, active: true });
  }
  e.event = async (name, date, participation) => (await admin(e.cookie, 'POST', 'impact-events', { body: { name, event_date: date, participation: participation || 'exhibited', confirm_duplicate: true } })).json().event;
  e.count = (eventId, metric, value, qualifier) => admin(e.cookie, 'POST', 'impact-count', { body: { event_id: eventId, metric, value, qualifier: qualifier || 'exact' } });
  e.report = async (query) => (await admin(e.cookie, 'GET', 'impact-report', { query: query || {} })).json();
  e.metric = (report, key) => report.metrics.find((m) => m.key === key);
  return e;
}

test('qualifiers combine conservatively and format honestly', () => {
  assert.equal(combineQualifiers(['exact', 'exact']), 'exact');
  assert.equal(combineQualifiers(['exact', 'minimum']), 'minimum');
  assert.equal(combineQualifiers(['minimum', 'approximate']), 'approximate');
  assert.equal(combineQualifiers(['approximate', 'estimated', 'exact']), 'estimated');
  assert.equal(formatFigure(155, 'approximate', 'count'), 'About 155');
  assert.equal(formatFigure(200, 'minimum', 'count'), '200+');
  assert.equal(formatFigure(120, 'estimated', 'count'), 'Est. 120');
  assert.equal(formatFigure(32.5, 'exact', 'hours'), '32.5');
  assert.equal(formatFigure(2450, 'exact', 'usd'), '$2,450.00');
});

test('event counts roll up with their qualifiers; one value per event and figure', async () => {
  const e = await env();
  const a = await e.event('Library Day', '2026-09-26');
  const b = await e.event('Candyland Career Day', '2026-10-03');
  await e.count(a.id, 'children_served', 30);
  await e.count(b.id, 'children_served', 90, 'estimated');
  const replaced = await e.count(b.id, 'children_served', 95, 'estimated');
  assert.equal(replaced.json().replaced, true);
  const kids = e.metric(await e.report(), 'children_served');
  assert.deepEqual([kids.value, kids.qualifier], [125, 'estimated']);
  assert.equal((await e.ctx.repo.list('event_impact_counts', {})).length, 2);
});

test('books come from inventory; a manual event count is used only where nothing was linked (no double count)', async () => {
  const e = await env();
  const tracked = await e.event('Build-a-thon', '2026-10-10');
  const untracked = await e.event('Old library event', '2026-09-26');
  await admin(e.cookie, 'POST', 'inventory-opening', { body: { category_id: e.cats.books.id, quantity: 100, occurred_on: '2026-09-01' } });
  assert.equal((await admin(e.cookie, 'POST', 'inventory-distribute', { body: { category_id: e.cats.books.id, quantity: 25, occurred_on: '2026-10-10', event_id: tracked.id } })).statusCode, 200);
  assert.equal((await admin(e.cookie, 'POST', 'inventory-distribute', { body: { category_id: e.cats.books.id, quantity: 5, occurred_on: '2026-10-12' } })).statusCode, 200);
  await e.count(tracked.id, 'books_distributed', 999); // ignored: inventory is linked to this event
  await e.count(untracked.id, 'books_distributed', 40, 'approximate');
  const books = e.metric(await e.report(), 'books_distributed');
  assert.deepEqual([books.value, books.qualifier], [70, 'approximate']);
});

test('starting totals: included only when the report covers their whole span, without double counting', async () => {
  const e = await env();
  await admin(e.cookie, 'POST', 'impact-baselines', { body: { metric: 'books_distributed', value: 155, qualifier: 'approximate', period_start: '2026-09-01', as_of: '2026-11-02' } });
  const before = await e.event('Old event', '2026-10-17');
  await e.count(before.id, 'books_distributed', 40, 'approximate'); // already inside the 155
  const after = await e.event('Build-a-thon', '2026-11-21');
  await e.count(after.id, 'books_distributed', 12);

  const all = e.metric(await e.report(), 'books_distributed');
  assert.deepEqual([all.value, all.qualifier], [167, 'approximate'], 'all time = 155 + 12 (the 40 is not counted twice)');
  const year = e.metric(await e.report({ preset: 'year', year: '2026' }), 'books_distributed');
  assert.equal(year.value, 167, 'the full year covers the whole span');
  const partial = e.metric(await e.report({ preset: 'custom', from: '2026-10-01', to: '2026-11-30' }), 'books_distributed');
  assert.equal(partial.value, 52, 'partial span: dated entries only (40 + 12)');
  assert.ok(partial.baseline_skipped, 'the report notes the starting total was left out');
  assert.equal(partial.baseline, null);
});

test('volunteer hours count only supervisor-approved entries', async () => {
  const e = await env();
  const coord = await login('coord@test.org', 'coord-pass');
  const { volunteer, assignment } = await approvedVolunteer(e, coord);
  const log = async (date, start, end) => (await admin(coord, 'POST', 'hours', { body: { volunteer_id: volunteer.id, assignment_id: assignment.id, service_date: date, start_time: start, end_time: end, break_minutes: 0, supervisor_name: 'Sam' } })).json().entry;
  const h1 = await log('2026-10-01', '09:00', '11:30');
  await log('2026-10-02', '09:00', '17:00'); // pending — not counted
  await admin(coord, 'POST', 'verify-hours', { body: { id: h1.id, decision: 'approve' } });
  const hours = e.metric(await e.report(), 'volunteer_hours');
  assert.deepEqual([hours.value, hours.unit, hours.qualifier], [2.5, 'hours', 'exact']);
});

test('donations: monetary totals and in-kind gifts pulled from records; amounts hidden without permission', async () => {
  const e = await env();
  const donor = (await admin(e.cookie, 'POST', 'donors', { body: { name: 'A Donor' } })).json().donor;
  await admin(e.cookie, 'POST', 'donations', { body: { donor_id: donor.id, received_on: '2026-10-05', donation_type: 'monetary', amount: '100', payment_method: 'cash' } });
  await admin(e.cookie, 'POST', 'donations', { body: { donor_id: donor.id, received_on: '2026-10-06', donation_type: 'monetary', amount: '50.50', payment_method: 'check' } });
  await admin(e.cookie, 'POST', 'donations', { body: { donor_id: donor.id, received_on: '2026-10-07', donation_type: 'in_kind', items: [{ category_id: e.cats.books.id, description: 'Books', quantity: 30 }] } });
  const r = await e.report();
  assert.deepEqual([e.metric(r, 'monetary_donations').value, e.metric(r, 'monetary_donations').gift_count], [150.5, 2]);
  assert.deepEqual([e.metric(r, 'in_kind_donations').value, e.metric(r, 'in_kind_donations').items_received], [1, 30]);

  await admin(e.cookie, 'POST', 'team-permission', { body: { staff_id: e.coordinator.id, permission: 'impact.view', effect: 'grant' } });
  const coord = await login('coord@test.org', 'coord-pass');
  const theirs = (await admin(coord, 'GET', 'impact-report')).json();
  assert.equal(e.metric(theirs, 'monetary_donations').hidden, true);
  assert.equal(e.metric(theirs, 'monetary_donations').value, null);
  assert.doesNotMatch(theirs.summary.join(' '), /\$/);
});

test('events hosted vs attended come from event records', async () => {
  const e = await env();
  await e.event('Our workshop', '2026-10-10', 'hosted');
  await e.event('Expo', '2026-10-11', 'exhibited');
  await e.event('Partner fair', '2026-10-12', 'partnered');
  const r = await e.report();
  assert.deepEqual([e.metric(r, 'events_hosted').value, e.metric(r, 'events_attended').value, e.metric(r, 'events_total').value], [1, 2, 3]);
});

test('historical events: exact duplicates are reused, same-day events need confirmation', async () => {
  const e = await env();
  const first = (await admin(e.cookie, 'POST', 'impact-events', { body: { name: 'Candyland Career Day', event_date: '2026-10-03', participation: 'exhibited' } })).json().event;
  const again = (await admin(e.cookie, 'POST', 'impact-events', { body: { name: 'candyland career day', event_date: '2026-10-03', participation: 'exhibited' } })).json();
  assert.equal(again.existing, true);
  assert.equal(again.event.id, first.id);
  const other = await admin(e.cookie, 'POST', 'impact-events', { body: { name: 'Candyland', event_date: '2026-10-03', participation: 'exhibited' } });
  assert.equal(other.statusCode, 409);
  assert.ok(other.json().possible_duplicate.length);
  const linked1 = (await admin(e.cookie, 'POST', 'impact-events', { body: { name: 'Family Build-a-thon', event_date: '2026-11-21', participation: 'exhibited', public_event_id: 'family-build-a-thon-2026-11-21' } })).json().event;
  const linked2 = (await admin(e.cookie, 'POST', 'impact-events', { body: { name: 'Build-a-thon (renamed)', event_date: '2026-11-22', participation: 'exhibited', public_event_id: 'family-build-a-thon-2026-11-21' } })).json();
  assert.equal(linked2.event.id, linked1.id, 'a website calendar event is imported only once');
});

test('date ranges: presets resolve correctly', () => {
  assert.deepEqual(resolveRange({ preset: 'month' }, '2026-11-18'), { preset: 'month', from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(resolveRange({ preset: 'quarter' }, '2026-11-18'), { preset: 'quarter', from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(resolveRange({ preset: 'year', year: '2025' }, '2026-11-18'), { preset: 'year', year: '2025', from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(resolveRange({}, '2026-11-18'), { preset: 'all', from: null, to: null });
  assert.throws(() => resolveRange({ preset: 'custom', from: '2026-12-01', to: '2026-01-01' }, '2026-11-18'));
});

test('monthly trend and year-over-year comparison', async () => {
  const e = await env();
  const a = await e.event('2025 event', '2025-10-04');
  const b = await e.event('2026 event', '2026-10-03');
  const c = await e.event('2026 event 2', '2026-11-05');
  await e.count(a.id, 'children_served', 40);
  await e.count(b.id, 'children_served', 50);
  await e.count(c.id, 'children_served', 10, 'estimated');
  const trend = (await admin(e.cookie, 'GET', 'impact-trend', { query: { metric: 'children_served', from: '2026-09-01', to: '2026-11-30' } })).json();
  assert.deepEqual(trend.months.map((m) => [m.month, m.value, m.qualifier]), [['2026-09', 0, 'exact'], ['2026-10', 50, 'exact'], ['2026-11', 10, 'estimated']]);
  const yoy = (await admin(e.cookie, 'GET', 'impact-yoy', { query: { year: '2026' } })).json();
  const row = yoy.rows.find((r) => r.key === 'children_served');
  assert.deepEqual([row.previous.value, row.current.value, row.change_pct, row.current.qualifier], [40, 60, 50, 'estimated']);
});

test('annual goals show progress for the year', async () => {
  const e = await env();
  const ev = await e.event('Library Day', '2026-09-26');
  await e.count(ev.id, 'children_served', 60);
  assert.equal((await admin(e.cookie, 'POST', 'impact-goals', { body: { goal_year: 2026, metric: 'children_served', target: 0 } })).statusCode, 422);
  await admin(e.cookie, 'POST', 'impact-goals', { body: { goal_year: 2026, metric: 'children_served', target: 200 } });
  await admin(e.cookie, 'POST', 'impact-goals', { body: { goal_year: 2026, metric: 'children_served', target: 240 } }); // update, not duplicate
  const goals = (await admin(e.cookie, 'GET', 'impact-goals', { query: { year: '2026' } })).json().goals;
  assert.equal(goals.length, 1);
  assert.deepEqual([goals[0].value, goals[0].target, goals[0].percent], [60, 240, 25]);
  const report = await e.report({ preset: 'year', year: '2026' });
  assert.equal(report.goals[0].percent, 25);
});

test('executive summary uses only recorded figures, keeps qualifiers, and labels engagements', () => {
  const m = (key, value, qualifier, unit, extra) => Object.assign({ key, value, qualifier, unit: unit || 'count', has_data: true }, extra || {});
  const text = executiveSummary([
    m('children_served', 120, 'estimated'), m('books_distributed', 155, 'approximate'), m('clothing_distributed', 100, 'exact'),
    m('events_attended', 4, 'exact'), m('table_interactions', 200, 'minimum'), m('volunteer_hours', 12.5, 'exact', 'hours'),
    { key: 'monetary_donations', value: null, hidden: true, has_data: false, unit: 'usd', qualifier: 'exact' }
  ], { preset: 'year', from: '2026-01-01', to: '2026-12-31' }).join(' ');
  assert.match(text, /From January 1, 2026 to December 31, 2026/);
  assert.match(text, /took part in 4 events, serving an estimated 120 children/);
  assert.match(text, /about 155 books and 100 clothing items/);
  assert.match(text, /200\+ table interactions\. Interactions and plays count engagements, not individual people\./);
  assert.match(text, /12\.5 supervisor-verified hours/);
  assert.doesNotMatch(text, /families|monetary|\$/);
});

test('permissions: viewing, recording, goals, and export are separate', async () => {
  const e = await env();
  const coord = await login('coord@test.org', 'coord-pass');
  assert.equal((await admin(coord, 'GET', 'impact-report')).statusCode, 403);
  await admin(e.cookie, 'POST', 'team-permission', { body: { staff_id: e.coordinator.id, permission: 'impact.view', effect: 'grant' } });
  assert.equal((await admin(coord, 'GET', 'impact-report')).statusCode, 200);
  assert.equal((await admin(coord, 'POST', 'impact-events', { body: { name: 'x', event_date: '2026-10-01', participation: 'hosted' } })).statusCode, 403);
  assert.equal((await admin(coord, 'POST', 'impact-goals', { body: { goal_year: 2026, metric: 'children_served', target: 5 } })).statusCode, 403);
  assert.equal((await admin(coord, 'GET', 'impact-export')).statusCode, 403);
  const csv = await admin(e.cookie, 'GET', 'impact-export', { query: { preset: 'year', year: '2026' } });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.body, /Figure,Value,Count type,Includes starting total,Source/);
});
