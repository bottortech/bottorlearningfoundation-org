import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, login, admin, call } from './helpers.js';
import publicHandler from '../api/impact.js';
import { DbError } from '../api/_lib/http.js';

async function env() {
  const e = await setup();
  e.cookie = await login('admin@test.org', 'admin-pass');
  e.books = await e.ctx.repo.insert('inventory_categories', { id: randomUUID(), slug: 'books', name: 'Books', sort_order: 1, active: true });
  // The figures already on the website, recorded as starting totals.
  await admin(e.cookie, 'POST', 'impact-baselines', { body: { metric: 'books_distributed', value: 155, qualifier: 'approximate', period_start: '2026-09-01', as_of: '2026-10-02' } });
  await admin(e.cookie, 'POST', 'impact-baselines', { body: { metric: 'table_interactions', value: 200, qualifier: 'minimum', period_start: '2026-10-03', as_of: '2026-10-03' } });
  e.publish = (items, extra) => admin(e.cookie, 'POST', 'public-impact', { body: Object.assign({ items, confirm: true }, extra || {}) });
  e.publicRead = async () => (await call(publicHandler, { method: 'GET', url: '/api/impact' })).json();
  return e;
}

test('nothing published yet: the public endpoint says so and the page keeps its written figures', async () => {
  const e = await env();
  const res = await call(publicHandler, { method: 'GET', url: '/api/impact' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { published: false, items: [] });
});

test('publishing uses record values (starting totals counted once) with qualifiers preserved', async () => {
  const e = await env();
  const ev = (await admin(e.cookie, 'POST', 'impact-events', { body: { name: 'Old event', event_date: '2026-09-26', participation: 'exhibited' } })).json().event;
  await admin(e.cookie, 'POST', 'impact-count', { body: { event_id: ev.id, metric: 'books_distributed', value: 40, qualifier: 'approximate' } }); // inside the 155
  const res = await e.publish([
    { key: 'books_distributed', label: 'Books distributed', detail: 'Nearly 40 Professor WiggleWoo books and about 115 community books' },
    { key: 'table_interactions', label: 'Estimated table interactions' }
  ]);
  assert.equal(res.statusCode, 200, res.body);
  const pub = await e.publicRead();
  assert.equal(pub.published, true);
  assert.equal(pub.as_of, '2026-10-21');
  assert.deepEqual(pub.items.map((i) => [i.key, i.display, i.qualifier, i.section]), [
    ['books_distributed', 'About 155', 'approximate', 'stats'],
    ['table_interactions', '200+', 'minimum', 'engagement']
  ]);
});

test('the public response contains only aggregate display fields', async () => {
  const e = await env();
  await e.publish([{ key: 'books_distributed', label: 'Books distributed' }]);
  const res = await call(publicHandler, { method: 'GET', url: '/api/impact' });
  assert.match(res.headers['cache-control'], /public/);
  assert.match(res.headers['cache-control'], /stale-if-error/);
  const body = res.body;
  for (const banned of ['approved_by', 'admin@test.org', 'Alex', 'staff', 'value"', 'donor', 'email']) {
    assert.ok(!body.includes(banned), 'public response must not include ' + banned);
  }
  assert.deepEqual(Object.keys(res.json().items[0]).sort(), ['detail', 'display', 'key', 'label', 'qualifier', 'section']);
});

test('donation figures and unknown statistics can never be published', async () => {
  const e = await env();
  for (const key of ['monetary_donations', 'in_kind_donations', 'donors', 'everything']) {
    const r = await e.publish([{ key, label: 'x' }]);
    assert.equal(r.statusCode, 422, key);
  }
});

test('public wording can’t include emails, phone numbers, or ID numbers', async () => {
  const e = await env();
  assert.equal((await e.publish([{ key: 'books_distributed', label: 'Books', detail: 'Thanks to jane@example.com' }])).statusCode, 422);
  assert.equal((await e.publish([{ key: 'books_distributed', label: 'Books', detail: 'Call 414-555-0100' }])).statusCode, 422);
  assert.equal((await e.publish([{ key: 'books_distributed', label: 'Books', detail: '123-45-6789' }])).statusCode, 422);
});

test('preview never saves; publishing requires confirmation', async () => {
  const e = await env();
  const pre = await admin(e.cookie, 'POST', 'public-impact', { body: { items: [{ key: 'books_distributed', label: 'Books distributed' }], preview: true } });
  assert.equal(pre.statusCode, 200);
  assert.equal(pre.json().preview.items[0].display, 'About 155');
  assert.equal((await e.publicRead()).published, false);
  assert.equal((await admin(e.cookie, 'POST', 'public-impact', { body: { items: [{ key: 'books_distributed', label: 'Books' }] } })).statusCode, 422);
});

test('updating one statistic leaves the others at their published values; history is kept', async () => {
  const e = await env();
  await e.publish([{ key: 'books_distributed', label: 'Books distributed' }, { key: 'table_interactions', label: 'Estimated table interactions' }]);

  // New activity after the starting totals.
  const ev = (await admin(e.cookie, 'POST', 'impact-events', { body: { name: 'Expo', event_date: '2026-10-15', participation: 'exhibited' } })).json().event;
  await admin(e.cookie, 'POST', 'impact-count', { body: { event_id: ev.id, metric: 'books_distributed', value: 12 } });
  await admin(e.cookie, 'POST', 'impact-count', { body: { event_id: ev.id, metric: 'table_interactions', value: 30 } });

  const overview = (await admin(e.cookie, 'GET', 'public-impact')).json();
  const books = overview.items.find((i) => i.key === 'books_distributed');
  assert.deepEqual([books.display, books.current_display, books.changed], ['About 155', 'About 167', true], 'portal shows unpublished changes');

  await e.publish([{ key: 'books_distributed', label: 'Books distributed', refresh: true }, { key: 'table_interactions', label: 'Estimated table interactions' }]);
  const pub = await e.publicRead();
  assert.deepEqual(pub.items.map((i) => i.display), ['About 167', '200+'], 'only the refreshed statistic changed');

  // Unpublish one statistic.
  await e.publish([{ key: 'books_distributed', label: 'Books distributed' }]);
  assert.deepEqual((await e.publicRead()).items.map((i) => i.key), ['books_distributed']);
  assert.equal((await e.publish([])).statusCode, 422, 'at least one statistic must stay published');

  const history = (await admin(e.cookie, 'GET', 'public-impact')).json().history;
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((h) => h.status), ['published', 'superseded', 'superseded']);
  assert.equal((await e.ctx.repo.list('impact_publications', { eq: { status: 'published' } })).length, 1);
});

test('only administrators can publish; viewers can see the overview', async () => {
  const e = await env();
  await admin(e.cookie, 'POST', 'team-permission', { body: { staff_id: e.coordinator.id, permission: 'impact.view', effect: 'grant' } });
  assert.equal((await admin(e.cookie, 'POST', 'team-permission', { body: { staff_id: e.coordinator.id, permission: 'impact.publish', effect: 'grant' } })).statusCode, 422);
  const coord = await login('coord@test.org', 'coord-pass');
  assert.equal((await admin(coord, 'GET', 'public-impact')).statusCode, 200);
  assert.equal((await admin(coord, 'POST', 'public-impact', { body: { items: [{ key: 'books_distributed', label: 'B' }], confirm: true } })).statusCode, 403);
  const actions = (await e.ctx.repo.list('audit_log', {})).map((a) => a.action);
  assert.equal(actions.includes('impact.published'), false);
  await e.publish([{ key: 'books_distributed', label: 'Books' }]);
  assert.ok((await e.ctx.repo.list('audit_log', {})).some((a) => a.action === 'impact.published'));
});

test('if the database is unavailable the public endpoint fails cleanly (the page falls back)', async () => {
  const e = await env();
  e.ctx.repo.list = async () => { throw new DbError('connection refused', 'ECONNREFUSED'); };
  const res = await call(publicHandler, { method: 'GET', url: '/api/impact' });
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(res.body, /connection refused/);
});
