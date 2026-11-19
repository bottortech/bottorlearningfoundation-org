import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, login, admin } from './helpers.js';

const SLUGS = ['books', 'clothing', 'electronics', 'educational_supplies', 'other'];

async function env() {
  const e = await setup();
  // Migration 002 seeds these categories in Supabase.
  e.cats = {};
  for (const [i, slug] of SLUGS.entries()) {
    e.cats[slug] = await e.ctx.repo.insert('inventory_categories', { id: randomUUID(), slug, name: slug.replace('_', ' '), sort_order: i, active: true });
  }
  e.cookie = await login('admin@test.org', 'admin-pass');
  e.donor = (await admin(e.cookie, 'POST', 'donors', { body: { name: 'Riverside Book Club', donor_type: 'organization', email: 'club@example.org', phone: '414-555-0100' } })).json().donor;
  return e;
}

const stock = async (e, slug) => (await admin(e.cookie, 'GET', 'inventory')).json().categories.find((c) => c.slug === slug);

function bookGift(e, overrides) {
  return Object.assign({
    donor_id: e.donor.id, received_on: '2026-10-05', donation_type: 'in_kind',
    items: [{ category_id: e.cats.books.id, description: 'Picture books', quantity: 40, estimated_value: '120.00' }],
    request_id: randomUUID()
  }, overrides || {});
}

test('in-kind donation adds items to inventory automatically', async () => {
  const e = await env();
  const res = await admin(e.cookie, 'POST', 'donations', { body: bookGift(e) });
  assert.equal(res.statusCode, 200, res.body);
  const books = await stock(e, 'books');
  assert.equal(books.received, 40);
  assert.equal(books.on_hand, 40);
  const history = (await admin(e.cookie, 'GET', 'inventory-history')).json().transactions;
  assert.equal(history[0].txn_type, 'received');
  assert.equal(history[0].item_description, 'Picture books');
});

test('monetary donation needs an amount and method; restricted gifts need a purpose', async () => {
  const e = await env();
  const bad = await admin(e.cookie, 'POST', 'donations', { body: { donor_id: e.donor.id, received_on: '2026-10-05', donation_type: 'monetary', restriction: 'restricted' } });
  assert.equal(bad.statusCode, 422);
  const errs = bad.json().errors;
  assert.ok(errs.amount && errs.payment_method && errs.restriction_purpose);
  const ok = await admin(e.cookie, 'POST', 'donations', { body: {
    donor_id: e.donor.id, received_on: '2026-10-05', donation_type: 'monetary', amount: '250.00', payment_method: 'check',
    restriction: 'restricted', restriction_purpose: 'Inventor Workshop prototype materials'
  } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().donation.amount, 250);
});

test('anonymous gifts may have no donor; otherwise a donor is required', async () => {
  const e = await env();
  const noDonor = await admin(e.cookie, 'POST', 'donations', { body: bookGift(e, { donor_id: null }) });
  assert.equal(noDonor.statusCode, 422);
  assert.ok(noDonor.json().errors.donor_id);
  const anon = await admin(e.cookie, 'POST', 'donations', { body: bookGift(e, { donor_id: null, is_anonymous: true }) });
  assert.equal(anon.statusCode, 200, anon.body);
  assert.equal(anon.json().donation.is_anonymous, true);
});

test('future dates are refused; historical entries are allowed and flagged', async () => {
  const e = await env();
  assert.equal((await admin(e.cookie, 'POST', 'donations', { body: bookGift(e, { received_on: '2026-12-01' }) })).statusCode, 422);
  const old = await admin(e.cookie, 'POST', 'donations', { body: bookGift(e, { received_on: '2025-06-01', is_historical: true }) });
  assert.equal(old.statusCode, 200);
  assert.equal(old.json().donation.is_historical, true);
});

test('a double-submitted form is saved only once', async () => {
  const e = await env();
  const body = bookGift(e);
  const first = await admin(e.cookie, 'POST', 'donations', { body });
  const second = await admin(e.cookie, 'POST', 'donations', { body });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().repeated, true);
  assert.equal(second.json().donation.id, first.json().donation.id);
  assert.equal((await stock(e, 'books')).on_hand, 40);
});

test('a likely duplicate warns first and can be confirmed as a separate gift', async () => {
  const e = await env();
  await admin(e.cookie, 'POST', 'donations', { body: bookGift(e) });
  const dup = await admin(e.cookie, 'POST', 'donations', { body: bookGift(e) });
  assert.equal(dup.statusCode, 409);
  assert.ok(dup.json().possible_duplicate.id);
  const confirmed = await admin(e.cookie, 'POST', 'donations', { body: bookGift(e, { confirm_duplicate: true }) });
  assert.equal(confirmed.statusCode, 200);
  assert.equal((await stock(e, 'books')).on_hand, 80);
});

test('distributions reduce stock and can never exceed what is on hand', async () => {
  const e = await env();
  await admin(e.cookie, 'POST', 'donations', { body: bookGift(e) });
  const ev = (await admin(e.cookie, 'POST', 'program-events', { body: { name: 'Family Build-a-thon', event_date: '2026-10-21', participation: 'exhibited' } })).json().event;
  const tooMany = await admin(e.cookie, 'POST', 'inventory-distribute', { body: { category_id: e.cats.books.id, quantity: 41, occurred_on: '2026-10-21', event_id: ev.id } });
  assert.equal(tooMany.statusCode, 409);
  const ok = await admin(e.cookie, 'POST', 'inventory-distribute', { body: { category_id: e.cats.books.id, quantity: 25, occurred_on: '2026-10-21', event_id: ev.id, request_id: randomUUID() } });
  assert.equal(ok.statusCode, 200, ok.body);
  const books = await stock(e, 'books');
  assert.equal(books.distributed, 25);
  assert.equal(books.on_hand, 15);
  const hist = (await admin(e.cookie, 'GET', 'inventory-history', { query: { category_id: e.cats.books.id } })).json().transactions;
  assert.equal(hist.find((t) => t.txn_type === 'distributed').event_name, 'Family Build-a-thon (2026-10-21)');
});

test('one opening balance per category; corrections need a reason and cannot go negative', async () => {
  const e = await env();
  const open1 = await admin(e.cookie, 'POST', 'inventory-opening', { body: { category_id: e.cats.clothing.id, quantity: 100, occurred_on: '2026-10-01' } });
  assert.equal(open1.statusCode, 200, open1.body);
  const open2 = await admin(e.cookie, 'POST', 'inventory-opening', { body: { category_id: e.cats.clothing.id, quantity: 5, occurred_on: '2026-10-01' } });
  assert.equal(open2.statusCode, 409);

  const noReason = await admin(e.cookie, 'POST', 'inventory-adjust', { body: { category_id: e.cats.clothing.id, quantity: -3, occurred_on: '2026-10-20' } });
  assert.equal(noReason.statusCode, 422);
  const tooFar = await admin(e.cookie, 'POST', 'inventory-adjust', { body: { category_id: e.cats.clothing.id, quantity: -101, occurred_on: '2026-10-20', reason: 'Recount' } });
  assert.equal(tooFar.statusCode, 409);
  const fix = await admin(e.cookie, 'POST', 'inventory-adjust', { body: { category_id: e.cats.clothing.id, quantity: -3, occurred_on: '2026-10-20', reason: 'Recount found 3 damaged items' } });
  assert.equal(fix.statusCode, 200);
  const clothing = await stock(e, 'clothing');
  assert.deepEqual([clothing.opening_balance, clothing.adjustments, clothing.on_hand], [100, -3, 97]);
});

test('voiding a donation reverses its inventory with a correction, unless items were already handed out', async () => {
  const e = await env();
  const d = (await admin(e.cookie, 'POST', 'donations', { body: bookGift(e) })).json().donation;
  const noReason = await admin(e.cookie, 'POST', 'void-donation', { body: { id: d.id } });
  assert.equal(noReason.statusCode, 422);
  const voided = await admin(e.cookie, 'POST', 'void-donation', { body: { id: d.id, reason: 'Entered twice' } });
  assert.equal(voided.statusCode, 200, voided.body);
  assert.equal((await stock(e, 'books')).on_hand, 0);
  const hist = (await admin(e.cookie, 'GET', 'inventory-history')).json().transactions;
  assert.equal(hist.length, 2, 'original entry is kept; a correction is added');

  const d2 = (await admin(e.cookie, 'POST', 'donations', { body: bookGift(e, { request_id: randomUUID(), confirm_duplicate: true }) })).json().donation;
  await admin(e.cookie, 'POST', 'inventory-distribute', { body: { category_id: e.cats.books.id, quantity: 10, occurred_on: '2026-10-20' } });
  const blocked = await admin(e.cookie, 'POST', 'void-donation', { body: { id: d2.id, reason: 'Mistake' } });
  assert.equal(blocked.statusCode, 409);
});

test('editing a donation keeps the change history and inventory dates in step', async () => {
  const e = await env();
  const d = (await admin(e.cookie, 'POST', 'donations', { body: bookGift(e) })).json().donation;
  const res = await admin(e.cookie, 'PATCH', 'donations', { query: { id: d.id }, body: { received_on: '2026-10-04', notes: 'Dropped off at office' } });
  assert.equal(res.statusCode, 200, res.body);
  const hist = (await admin(e.cookie, 'GET', 'inventory-history')).json().transactions;
  assert.equal(hist[0].occurred_on, '2026-10-04');
  const [event] = await e.ctx.repo.list('audit_log', { eq: { action: 'donation.updated' } });
  assert.deepEqual(event.details.fields.sort(), ['notes', 'received_on']);
});

test('without donor-contact access, contact details and amounts are hidden', async () => {
  const e = await env();
  await admin(e.cookie, 'POST', 'donations', { body: { donor_id: e.donor.id, received_on: '2026-10-05', donation_type: 'monetary', amount: '75', payment_method: 'cash' } });
  await admin(e.cookie, 'POST', 'team-permission', { body: { staff_id: e.coordinator.id, permission: 'donations.view', effect: 'grant' } });
  const coord = await login('coord@test.org', 'coord-pass');
  const list = (await admin(coord, 'GET', 'donations')).json().donations;
  assert.equal(list[0].donor_name, 'Riverside Book Club');
  assert.equal('amount' in list[0], false);
  const donors = (await admin(coord, 'GET', 'donors')).json().donors;
  assert.equal(donors[0].email, undefined);
  assert.equal(donors[0].phone, undefined);
  assert.equal((await admin(coord, 'POST', 'donations', { body: bookGift(e) })).statusCode, 403);
  assert.equal((await admin(coord, 'GET', 'inventory')).statusCode, 403);
});

test('a granted inventory recorder can hand out items but not correct counts', async () => {
  const e = await env();
  await admin(e.cookie, 'POST', 'donations', { body: bookGift(e) });
  await admin(e.cookie, 'POST', 'team-permission', { body: { staff_id: e.supervisor.id, permission: 'inventory.record', effect: 'grant' } });
  const sup = await login('super@test.org', 'super-pass');
  assert.equal((await admin(sup, 'POST', 'inventory-distribute', { body: { category_id: e.cats.books.id, quantity: 2, occurred_on: '2026-10-20' } })).statusCode, 200);
  assert.equal((await admin(sup, 'POST', 'inventory-adjust', { body: { category_id: e.cats.books.id, quantity: 2, occurred_on: '2026-10-20', reason: 'x' } })).statusCode, 403);
});

test('supporting documents: type and size are checked; files are opened by short-lived link', async () => {
  const e = await env();
  const d = (await admin(e.cookie, 'POST', 'donations', { body: bookGift(e) })).json().donation;
  const bad = await admin(e.cookie, 'POST', 'donation-document', { body: { donation_id: d.id, file_name: 'x.exe', content_type: 'application/x-msdownload', data: 'AAAA' } });
  assert.equal(bad.statusCode, 422);
  const pdf = Buffer.from('%PDF-1.4 test receipt').toString('base64');
  const up = await admin(e.cookie, 'POST', 'donation-document', { body: { donation_id: d.id, file_name: 'receipt.pdf', content_type: 'application/pdf', data: pdf } });
  assert.equal(up.statusCode, 200, up.body);
  const detail = (await admin(e.cookie, 'GET', 'donations', { query: { id: d.id } })).json();
  assert.equal(detail.documents.length, 1);
  assert.equal('storage_path' in detail.documents[0], false);
  const link = (await admin(e.cookie, 'GET', 'donation-document-link', { query: { id: up.json().document.id } })).json();
  assert.equal(link.expires_in, 60);
  assert.equal(e.ctx.storage.files.size, 1);
});

test('CSV exports require the export permission', async () => {
  const e = await env();
  await admin(e.cookie, 'POST', 'donations', { body: bookGift(e) });
  const csv = await admin(e.cookie, 'GET', 'donations-export');
  assert.equal(csv.statusCode, 200);
  assert.match(csv.body, /Riverside Book Club,No,In-kind,unrestricted,,40 books/);
  assert.match((await admin(e.cookie, 'GET', 'inventory-export')).body, /Received,40,Picture books/);
  const coord = await login('coord@test.org', 'coord-pass');
  assert.equal((await admin(coord, 'GET', 'donations-export')).statusCode, 403);
});

test('every change is in the activity log without donor names or contact details', async () => {
  const e = await env();
  await admin(e.cookie, 'POST', 'donations', { body: bookGift(e) });
  const events = await e.ctx.repo.list('audit_log', {});
  const actions = events.map((x) => x.action);
  assert.ok(actions.includes('donor.created') && actions.includes('donation.created'));
  assert.doesNotMatch(JSON.stringify(events.map((x) => x.details)), /Riverside|club@example/);
});
