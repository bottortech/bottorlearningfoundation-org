import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, login, admin } from './helpers.js';
import { buildAcknowledgmentDocument } from '../api/_lib/services/acknowledgments.js';

// A tiny valid 1x1 PNG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c6360000002000105fe02fea70000000049454e44ae426082', 'hex').toString('base64');

async function env() {
  const e = await setup();
  e.cookie = await login('admin@test.org', 'admin-pass');
  e.books = await e.ctx.repo.insert('inventory_categories', { id: randomUUID(), slug: 'books', name: 'Books', sort_order: 1, active: true });
  e.donor = (await admin(e.cookie, 'POST', 'donors', { body: {
    name: 'Jordan Rivera', email: 'jordan@example.com', address_line1: '100 Main St', city: 'Milwaukee', state: 'WI', postal_code: '53212'
  } })).json().donor;
  e.org = (await admin(e.cookie, 'POST', 'donors', { body: { name: 'Riverside Book Club', donor_type: 'organization', contact_name: 'Pat Lee' } })).json().donor;
  e.cash = (await admin(e.cookie, 'POST', 'donations', { body: {
    donor_id: e.donor.id, received_on: '2026-10-05', donation_type: 'monetary', amount: '250', payment_method: 'check',
    restriction: 'restricted', restriction_purpose: 'Inventor Workshop prototype materials'
  } })).json().donation;
  e.books_gift = (await admin(e.cookie, 'POST', 'donations', { body: {
    donor_id: e.org.id, received_on: '2025-12-01', donation_type: 'in_kind', is_historical: true,
    items: [{ category_id: e.books.id, description: 'Picture books', quantity: 40, estimated_value: '120' }], estimated_value: '120'
  } })).json().donation;
  return e;
}

const draft = (e, donationId, extra) => admin(e.cookie, 'POST', 'acknowledgments', { body: Object.assign({ donation_id: donationId, special_source: 'none', goods_services: 'none' }, extra || {}) });
const view = async (e, id) => (await admin(e.cookie, 'GET', 'acknowledgments', { query: { id } })).json();

test('monetary letter: facts from the record, restriction, 501(c)(3) + EIN, and no-goods-or-services statement', async () => {
  const e = await env();
  const res = await draft(e, e.cash.id);
  assert.equal(res.statusCode, 200, res.body);
  const doc = (await view(e, res.json().acknowledgment.id)).document;
  assert.equal(doc.salutation, 'Dear Jordan Rivera,');
  assert.deepEqual(doc.recipient.address_lines, ['100 Main St', 'Milwaukee, WI 53212']);
  assert.ok(doc.details.some(([k, v]) => k === 'Amount' && v === '$250.00'));
  assert.ok(doc.details.some(([k, v]) => k === 'Date received' && v === 'October 5, 2026'));
  assert.equal(doc.restrictionLine, 'As you requested, your gift is designated for Inventor Workshop prototype materials.');
  assert.match(doc.taxParagraphs.join(' '), /Section 501\(c\)\(3\).*EIN 41-3321544/);
  assert.match(doc.taxParagraphs.join(' '), /No goods or services were provided/);
  assert.equal(doc.issueDate, null, 'drafts have no issue date');
});

test('in-kind letter describes the items and never states their value', async () => {
  const e = await env();
  const id = (await draft(e, e.books_gift.id)).json().acknowledgment.id;
  const data = await view(e, id);
  const doc = data.document;
  assert.equal(doc.salutation, 'Dear Pat Lee,');
  assert.deepEqual(doc.items, [{ description: 'Picture books', quantity: 40, category: 'Books' }]);
  assert.equal(doc.details.some(([k]) => k === 'Amount'), false);
  assert.match(doc.taxParagraphs.join(' '), /does not state their value/);
  assert.doesNotMatch(JSON.stringify(doc), /120/, 'the internal estimate never appears on the letter');
});

test('goods or services received: description required, and finalizing is blocked until the value is entered', async () => {
  const e = await env();
  assert.equal((await draft(e, e.cash.id, { goods_services: 'provided' })).statusCode, 422);
  const id = (await draft(e, e.cash.id, { goods_services: 'provided', goods_services_description: 'two gala dinner tickets' })).json().acknowledgment.id;
  assert.match((await view(e, id)).document.taxParagraphs.join(' '), /\[VALUE NEEDED\]/);
  const blocked = await admin(e.cookie, 'POST', 'finalize-acknowledgment', { body: { id, confirm_reviewed: true } });
  assert.equal(blocked.statusCode, 422);
  await admin(e.cookie, 'PATCH', 'acknowledgments', { query: { id }, body: { goods_services_value: '80' } });
  const text = (await view(e, id)).document.taxParagraphs.join(' ');
  assert.match(text, /two gala dinner tickets, with an estimated fair market value of \$80\.00/);
  assert.match(text, /limited to the amount by which your contribution exceeds/);
});

test('special gift sources (DAF, IRA, etc.) get a thank-you without tax wording', async () => {
  const e = await env();
  const id = (await draft(e, e.cash.id, { special_source: 'daf' })).json().acknowledgment.id;
  assert.deepEqual((await view(e, id)).document.taxParagraphs, []);
});

test('drafts are editable; gift facts are not, and track the donation record until finalized', async () => {
  const e = await env();
  const id = (await draft(e, e.cash.id)).json().acknowledgment.id;
  const edit = await admin(e.cookie, 'PATCH', 'acknowledgments', { query: { id }, body: { salutation: 'Dear Jordan,', postscript: 'See you at the Expo!', amount: 9999 } });
  assert.equal(edit.statusCode, 200, edit.body);
  let doc = (await view(e, id)).document;
  assert.equal(doc.salutation, 'Dear Jordan,');
  assert.equal(doc.postscript, 'See you at the Expo!');
  assert.ok(doc.details.some(([k, v]) => k === 'Amount' && v === '$250.00'), 'amount cannot be edited in the letter');

  // Correcting the donation record flows into the draft.
  await admin(e.cookie, 'PATCH', 'donations', { query: { id: e.cash.id }, body: { amount: '275' } });
  doc = (await view(e, id)).document;
  assert.ok(doc.details.some(([k, v]) => k === 'Amount' && v === '$275.00'));

  // Empty required wording is refused.
  assert.equal((await admin(e.cookie, 'PATCH', 'acknowledgments', { query: { id }, body: { opening: '' } })).statusCode, 422);
});

test('finalizing requires the admin signer, confirmation, freezes the letter, and sets the issue date', async () => {
  const e = await env();
  const id = (await draft(e, e.cash.id)).json().acknowledgment.id;
  await admin(e.cookie, 'POST', 'team-permission', { body: { staff_id: e.coordinator.id, permission: 'acknowledgments.manage', effect: 'grant' } });
  const coord = await login('coord@test.org', 'coord-pass');
  assert.equal((await admin(coord, 'POST', 'finalize-acknowledgment', { body: { id, confirm_reviewed: true } })).statusCode, 403);
  assert.equal((await admin(e.cookie, 'POST', 'finalize-acknowledgment', { body: { id } })).statusCode, 422);

  const ok = await admin(e.cookie, 'POST', 'finalize-acknowledgment', { body: { id, confirm_reviewed: true } });
  assert.equal(ok.statusCode, 200, ok.body);
  const data = await view(e, id);
  assert.equal(data.acknowledgment.status, 'ready');
  assert.equal(data.document.issueDate, 'October 21, 2026');
  assert.deepEqual([data.document.signer.name, data.document.signer.title], ['Alex Admin', 'President']);
  assert.equal(data.signature_data_url, null, 'no digital signature unless chosen: space for a handwritten one');

  // Frozen: editing is refused, and later record changes don't alter it.
  assert.equal((await admin(e.cookie, 'PATCH', 'acknowledgments', { query: { id }, body: { salutation: 'Hi' } })).statusCode, 409);
  await admin(e.cookie, 'PATCH', 'donations', { query: { id: e.cash.id }, body: { amount: '300' } });
  assert.ok((await view(e, id)).document.details.some(([k, v]) => k === 'Amount' && v === '$250.00'));
});

test('digital signature: only valid PNG/JPG, applied only when chosen, and frozen per letter', async () => {
  const e = await env();
  const id = (await draft(e, e.cash.id)).json().acknowledgment.id;
  assert.equal((await admin(e.cookie, 'POST', 'finalize-acknowledgment', { body: { id, confirm_reviewed: true, use_signature: true } })).statusCode, 422, 'no signature uploaded yet');
  assert.equal((await admin(e.cookie, 'POST', 'signature', { body: { content_type: 'image/png', data: Buffer.from('not an image').toString('base64') } })).statusCode, 422);
  assert.equal((await admin(e.cookie, 'POST', 'signature', { body: { content_type: 'image/png', data: PNG } })).statusCode, 200);
  assert.equal((await admin(e.cookie, 'GET', 'signature')).json().has_signature, true);

  const ok = await admin(e.cookie, 'POST', 'finalize-acknowledgment', { body: { id, confirm_reviewed: true, use_signature: true } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.match((await view(e, id)).signature_data_url, /^data:image\/png;base64,/);

  // Removing the signature later doesn't change an issued letter.
  await admin(e.cookie, 'POST', 'signature', { body: { remove: true } });
  assert.match((await view(e, id)).signature_data_url, /^data:image\/png;base64,/);

  const coord = await login('coord@test.org', 'coord-pass');
  assert.equal((await admin(coord, 'GET', 'signature')).statusCode, 403);
});

test('sent tracking: only finalized letters, with date and method; history is kept', async () => {
  const e = await env();
  const id = (await draft(e, e.cash.id)).json().acknowledgment.id;
  assert.equal((await admin(e.cookie, 'POST', 'acknowledgment-sent', { body: { id, sent_on: '2026-10-20', sent_method: 'mail' } })).statusCode, 409);
  await admin(e.cookie, 'POST', 'finalize-acknowledgment', { body: { id, confirm_reviewed: true } });
  assert.equal((await admin(e.cookie, 'POST', 'acknowledgment-sent', { body: { id, sent_on: '2026-10-20', sent_method: 'pigeon' } })).statusCode, 422);
  const sent = await admin(e.cookie, 'POST', 'acknowledgment-sent', { body: { id, sent_on: '2026-10-20', sent_method: 'mail' } });
  assert.equal(sent.statusCode, 200);
  const list = (await admin(e.cookie, 'GET', 'acknowledgments')).json();
  const letter = list.letters.find((l) => l.id === id);
  assert.deepEqual([letter.status, letter.sent_on, letter.sent_method], ['sent', '2026-10-20', 'mail']);
  const actions = (await e.ctx.repo.list('audit_log', {})).map((a) => a.action);
  for (const a of ['acknowledgment.drafted', 'acknowledgment.finalized', 'acknowledgment.sent_recorded']) assert.ok(actions.includes(a), a);
});

test('one live letter per donation; void (with reason) to start over', async () => {
  const e = await env();
  const id = (await draft(e, e.cash.id)).json().acknowledgment.id;
  const again = await draft(e, e.cash.id);
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().acknowledgment_id, id);
  assert.equal((await admin(e.cookie, 'POST', 'void-acknowledgment', { body: { id } })).statusCode, 422);
  assert.equal((await admin(e.cookie, 'POST', 'void-acknowledgment', { body: { id, reason: 'Wrong greeting' } })).statusCode, 200);
  assert.equal((await draft(e, e.cash.id)).statusCode, 200);
});

test('pending list: donations without a letter, including historical ones; anonymous gifts with no donor cannot be addressed', async () => {
  const e = await env();
  const anon = (await admin(e.cookie, 'POST', 'donations', { body: { donor_id: null, is_anonymous: true, received_on: '2026-10-06', donation_type: 'monetary', amount: '20', payment_method: 'cash' } })).json().donation;
  let list = (await admin(e.cookie, 'GET', 'acknowledgments')).json();
  assert.equal(list.pending.length, 3);
  assert.ok(list.pending.find((p) => p.donation_id === e.books_gift.id).is_historical);
  assert.equal(list.pending.find((p) => p.donation_id === anon.id).can_generate, false);
  assert.equal((await draft(e, anon.id)).statusCode, 422);

  await draft(e, e.cash.id);
  list = (await admin(e.cookie, 'GET', 'acknowledgments')).json();
  assert.equal(list.pending.length, 2);
  const overview = (await admin(e.cookie, 'GET', 'dashboard')).json().foundation.acknowledgments;
  assert.deepEqual([overview.not_started, overview.drafts, overview.ready_to_send], [2, 1, 0]);
});

test('letter document never claims legal sufficiency', () => {
  const doc = buildAcknowledgmentDocument({
    letter_number: 'BLF-DA-2026-ABC123', status: 'ready',
    content: {
      recipient: { name: 'A', address_lines: [] }, facts: { donation_type: 'monetary', received_on: '2026-10-01', amount: 10, items: [], restriction_purpose: null },
      tax: { special_source: 'none', goods_services: 'none' }, wording: { salutation: 'Dear A,', opening: 'Thanks', closing: 'Bye', postscript: '' },
      signer: { name: 'Byron Brown', title: 'President' }, issue_date: '2026-10-02'
    }
  });
  assert.doesNotMatch(JSON.stringify(doc), /meets|satisf|complies|IRS requirement/i);
  assert.equal(doc.issueDate, 'October 2, 2026');
});
