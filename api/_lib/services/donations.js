import { randomUUID } from 'node:crypto';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { can } from '../permissions.js';
import { toCsv } from './hours.js';
import { categoriesBySlugAndId, insertTransaction, onHand, MAX_QUANTITY } from './inventory.js';
import {
  cleanText, cleanMultiline, containsSsn, isUuid, isValidDate, isValidEmail, isValidPhone, todayInOrgTimeZone
} from '../../../js/volunteer-core.js';

export const PAYMENT_METHODS = ['cash', 'check', 'card', 'givebutter', 'bank_transfer', 'other'];
const MAX_AMOUNT = 10000000;
const DOC_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;

function fail(errors) {
  return new HttpError(422, 'Please correct the highlighted fields.', { errors: errors });
}

function money(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT || Math.round(n * 100) !== n * 100) return NaN;
  return n;
}

/* ---------- Donors ---------- */

const CONTACT_FIELDS = ['contact_name', 'email', 'phone', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'notes'];

function redactDonor(donor, staff) {
  if (!donor || can(staff, 'donors.view_contact')) return donor;
  const copy = Object.assign({}, donor);
  CONTACT_FIELDS.forEach(function (f) { delete copy[f]; });
  return copy;
}

function validateDonor(body) {
  const errors = {};
  const v = {
    donor_type: body.donor_type === 'organization' ? 'organization' : 'individual',
    name: cleanText(body.name),
    contact_name: cleanText(body.contact_name) || null,
    email: cleanText(body.email).toLowerCase() || null,
    phone: cleanText(body.phone) || null,
    address_line1: cleanText(body.address_line1) || null,
    address_line2: cleanText(body.address_line2) || null,
    city: cleanText(body.city) || null,
    state: cleanText(body.state) || null,
    postal_code: cleanText(body.postal_code) || null,
    notes: cleanMultiline(body.notes) || null
  };
  if (!v.name) errors.name = 'Enter the donor or organization name.';
  else if (v.name.length > 160) errors.name = 'Name is too long.';
  if (v.email && !isValidEmail(v.email)) errors.email = 'Enter a valid email address.';
  if (v.phone && !isValidPhone(v.phone)) errors.phone = 'Enter a valid phone number with area code.';
  if (v.notes && v.notes.length > 2000) errors.notes = 'Notes are too long.';
  if (v.notes && containsSsn(v.notes)) errors.notes = 'Remove anything that looks like an SSN.';
  [['address_line1', 160], ['address_line2', 160], ['city', 80], ['state', 40], ['postal_code', 20], ['contact_name', 120]].forEach(function (pair) {
    if (v[pair[0]] && v[pair[0]].length > pair[1]) errors[pair[0]] = 'This is too long.';
  });
  return { errors: errors, value: v };
}

export async function listDonors(ctx, staff, query) {
  let rows = await ctx.repo.list('donors', { order: ['name', 'asc'] });
  const q = cleanText(query.q).toLowerCase();
  if (q) rows = rows.filter(function (d) { return (d.name + ' ' + (d.contact_name || '') + ' ' + (d.email || '')).toLowerCase().indexOf(q) !== -1; });
  const donations = await ctx.repo.list('donations', { eq: { status: 'active' } });
  return {
    donors: rows.map(function (d) {
      const mine = donations.filter(function (x) { return x.donor_id === d.id; });
      return Object.assign(redactDonor(d, staff), {
        donation_count: mine.length,
        last_donation_on: mine.map(function (x) { return x.received_on; }).sort().pop() || null
      });
    })
  };
}

export async function createDonor(ctx, staff, body) {
  const { errors, value } = validateDonor(body);
  if (Object.keys(errors).length) throw fail(errors);
  const nowIso = ctx.now().toISOString();
  const donor = await ctx.repo.insert('donors', Object.assign({ id: randomUUID(), created_by: staff.id, created_at: nowIso, updated_at: nowIso }, value));
  await audit(ctx, staff, 'donor.created', 'donor', donor.id, { donor_type: donor.donor_type });
  return { donor: redactDonor(donor, staff) };
}

export async function updateDonor(ctx, staff, id, body) {
  if (!isUuid(id)) throw new HttpError(400, 'Invalid donor id.');
  const existing = await ctx.repo.get('donors', id);
  if (!existing) throw new HttpError(404, 'Donor not found.');
  if (!can(staff, 'donors.view_contact')) throw new HttpError(403, 'Editing donor details requires access to donor contact information.');
  const { errors, value } = validateDonor(Object.assign({}, existing, body));
  if (Object.keys(errors).length) throw fail(errors);
  const changed = Object.keys(value).filter(function (k) { return String(value[k] || '') !== String(existing[k] || ''); });
  if (!changed.length) throw new HttpError(422, 'No changes to save.');
  value.updated_at = ctx.now().toISOString();
  const donor = await ctx.repo.update('donors', id, value);
  await audit(ctx, staff, 'donor.updated', 'donor', id, { fields: changed });
  return { donor: donor };
}

/* ---------- Donations ---------- */

function redactDonation(d, staff) {
  if (can(staff, 'donors.view_contact')) return d;
  const copy = Object.assign({}, d);
  delete copy.amount;
  delete copy.estimated_value;
  delete copy.payment_method;
  return copy;
}

async function validateDonation(ctx, body, cats) {
  const errors = {};
  const today = todayInOrgTimeZone(ctx.now());
  const v = {
    donor_id: body.donor_id || null,
    is_anonymous: body.is_anonymous === true,
    received_on: cleanText(body.received_on),
    donation_type: body.donation_type,
    amount: null,
    payment_method: null,
    restriction: body.restriction === 'restricted' ? 'restricted' : 'unrestricted',
    restriction_purpose: cleanMultiline(body.restriction_purpose) || null,
    description: cleanMultiline(body.description) || null,
    estimated_value: null,
    notes: cleanMultiline(body.notes) || null,
    is_historical: body.is_historical === true
  };

  if (v.donor_id) {
    if (!isUuid(v.donor_id) || !(await ctx.repo.get('donors', v.donor_id))) errors.donor_id = 'Choose a donor from the list.';
  } else if (!v.is_anonymous) {
    errors.donor_id = 'Choose a donor, or mark the gift as anonymous.';
  }
  if (!isValidDate(v.received_on)) errors.received_on = 'Enter the date the donation was received.';
  else if (v.received_on > today) errors.received_on = 'The date can’t be in the future.';
  if (v.donation_type !== 'monetary' && v.donation_type !== 'in_kind') errors.donation_type = 'Choose money or items.';
  if (v.restriction === 'restricted' && !v.restriction_purpose) errors.restriction_purpose = 'Describe how the donor restricted this gift.';
  if (v.restriction_purpose && v.restriction_purpose.length > 500) errors.restriction_purpose = 'Please shorten this.';
  if (v.description && v.description.length > 1000) errors.description = 'Description is too long.';
  if (v.notes && v.notes.length > 2000) errors.notes = 'Notes are too long.';
  ['description', 'notes'].forEach(function (f) { if (v[f] && containsSsn(v[f])) errors[f] = 'Remove anything that looks like an SSN.'; });

  const items = [];
  if (v.donation_type === 'monetary') {
    const amount = money(body.amount);
    if (amount === null || Number.isNaN(amount) || amount <= 0) errors.amount = 'Enter the amount received (for example 50 or 125.50).';
    else v.amount = amount;
    if (PAYMENT_METHODS.indexOf(body.payment_method) === -1) errors.payment_method = 'Choose how the gift was received.';
    else v.payment_method = body.payment_method;
  } else if (v.donation_type === 'in_kind') {
    const list = Array.isArray(body.items) ? body.items : [];
    if (!list.length) errors.items = 'Add at least one item.';
    list.forEach(function (item, i) {
      const cat = cats.byId.get(item.category_id);
      const desc = cleanText(item.description);
      const qty = Number(item.quantity);
      const value = money(item.estimated_value);
      if (!cat) errors['items.' + i] = 'Item ' + (i + 1) + ': choose a category.';
      else if (!desc) errors['items.' + i] = 'Item ' + (i + 1) + ': describe the item.';
      else if (desc.length > 300) errors['items.' + i] = 'Item ' + (i + 1) + ': description is too long.';
      else if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QUANTITY) errors['items.' + i] = 'Item ' + (i + 1) + ': enter a whole-number quantity.';
      else if (Number.isNaN(value)) errors['items.' + i] = 'Item ' + (i + 1) + ': enter a valid estimated value, or leave it blank.';
      else items.push({ category_id: cat.id, description: desc, quantity: qty, estimated_value: value });
    });
    const total = money(body.estimated_value);
    if (Number.isNaN(total)) errors.estimated_value = 'Enter a valid estimated value, or leave it blank.';
    else v.estimated_value = total;
  }
  return { errors: errors, value: v, items: items };
}

async function findPossibleDuplicate(ctx, v, items) {
  const sameDay = await ctx.repo.list('donations', { eq: { received_on: v.received_on, donation_type: v.donation_type, status: 'active' } });
  const candidates = sameDay.filter(function (d) { return (d.donor_id || null) === (v.donor_id || null); });
  for (const d of candidates) {
    if (v.donation_type === 'monetary' && Number(d.amount) === Number(v.amount)) return d;
    if (v.donation_type === 'in_kind') {
      const theirs = await ctx.repo.list('donation_items', { eq: { donation_id: d.id } });
      const key = function (list) { return list.map(function (i) { return i.category_id + ':' + i.quantity; }).sort().join('|'); };
      if (key(theirs) === key(items)) return d;
    }
  }
  return null;
}

export async function createDonation(ctx, staff, body) {
  if (body.request_id) {
    if (!isUuid(body.request_id)) throw new HttpError(400, 'Invalid request id.');
    const repeat = await ctx.repo.list('donations', { eq: { request_id: body.request_id }, limit: 1 });
    if (repeat.length) return { donation: redactDonation(repeat[0], staff), repeated: true };
  }
  const cats = await categoriesBySlugAndId(ctx);
  const { errors, value, items } = await validateDonation(ctx, body, cats);
  if (Object.keys(errors).length) throw fail(errors);

  if (body.confirm_duplicate !== true) {
    const dup = await findPossibleDuplicate(ctx, value, items);
    if (dup) {
      throw new HttpError(409, 'This looks like a donation that’s already recorded: same donor, date, and ' +
        (value.donation_type === 'monetary' ? 'amount' : 'items') + '. Check the list, or confirm it’s a separate gift.', {
        possible_duplicate: { id: dup.id, received_on: dup.received_on, created_at: dup.created_at }
      });
    }
  }

  const nowIso = ctx.now().toISOString();
  const donation = await ctx.repo.insert('donations', Object.assign({
    id: randomUUID(), status: 'active', void_reason: null, request_id: body.request_id || null,
    created_by: staff.id, created_at: nowIso, updated_at: nowIso
  }, value));

  // Items and their inventory entries. If anything fails part-way, undo it
  // so a donation is never half-recorded.
  const created = { items: [], txns: [] };
  try {
    for (const item of items) {
      const row = await ctx.repo.insert('donation_items', Object.assign({ id: randomUUID(), donation_id: donation.id }, item));
      created.items.push(row);
      const txn = await insertTransaction(ctx, staff, {
        category_id: item.category_id, txn_type: 'received', quantity: item.quantity, occurred_on: value.received_on,
        donation_item_id: row.id, is_historical: value.is_historical
      });
      created.txns.push(txn);
    }
  } catch (err) {
    for (const t of created.txns) await ctx.repo.remove('inventory_transactions', { eq: { id: t.id } }).catch(function () {});
    for (const i of created.items) await ctx.repo.remove('donation_items', { eq: { id: i.id } }).catch(function () {});
    await ctx.repo.remove('donations', { eq: { id: donation.id } }).catch(function () {});
    throw err;
  }

  await audit(ctx, staff, 'donation.created', 'donation', donation.id, {
    donation_type: donation.donation_type, items: items.length, is_historical: donation.is_historical, anonymous: donation.is_anonymous
  });
  return { donation: redactDonation(donation, staff), items: created.items };
}

export async function listDonations(ctx, staff, query) {
  const filter = { eq: {}, gte: {}, lte: {}, order: ['received_on', 'desc'] };
  if (query.from) { if (!isValidDate(query.from)) throw new HttpError(400, 'Invalid start date.'); filter.gte.received_on = query.from; }
  if (query.to) { if (!isValidDate(query.to)) throw new HttpError(400, 'Invalid end date.'); filter.lte.received_on = query.to; }
  if (query.donation_type) filter.eq.donation_type = query.donation_type;
  if (query.status) filter.eq.status = query.status;
  if (query.donor_id) { if (!isUuid(query.donor_id)) throw new HttpError(400, 'Invalid donor.'); filter.eq.donor_id = query.donor_id; }

  const donations = await ctx.repo.list('donations', filter);
  const ids = donations.map(function (d) { return d.id; });
  const donorIds = Array.from(new Set(donations.map(function (d) { return d.donor_id; }).filter(Boolean)));
  const [items, donors, cats, acks] = await Promise.all([
    ids.length ? ctx.repo.list('donation_items', { in: { donation_id: ids } }) : [],
    donorIds.length ? ctx.repo.list('donors', { in: { id: donorIds } }) : [],
    categoriesBySlugAndId(ctx),
    ids.length ? ctx.repo.list('donor_acknowledgments', { in: { donation_id: ids } }) : []
  ]);
  const donorMap = new Map(donors.map(function (d) { return [d.id, d]; }));

  return {
    donations: donations.map(function (d) {
      const mine = items.filter(function (i) { return i.donation_id === d.id; });
      const ack = acks.filter(function (a) { return a.donation_id === d.id && a.status !== 'void'; })[0];
      return Object.assign(redactDonation(d, staff), {
        donor_name: d.donor_id ? (donorMap.get(d.donor_id) || {}).name || '' : '',
        item_count: mine.reduce(function (t, i) { return t + i.quantity; }, 0),
        item_summary: mine.map(function (i) { return i.quantity + ' ' + ((cats.byId.get(i.category_id) || {}).name || '').toLowerCase(); }).join(', '),
        acknowledgment_status: ack ? ack.status : null
      });
    })
  };
}

export async function getDonation(ctx, staff, id) {
  if (!isUuid(id)) throw new HttpError(400, 'Invalid donation id.');
  const donation = await ctx.repo.get('donations', id);
  if (!donation) throw new HttpError(404, 'Donation not found.');
  const [items, docs, cats, donor, acks] = await Promise.all([
    ctx.repo.list('donation_items', { eq: { donation_id: id } }),
    ctx.repo.list('donation_documents', { eq: { donation_id: id }, order: ['uploaded_at', 'desc'] }),
    categoriesBySlugAndId(ctx),
    donation.donor_id ? ctx.repo.get('donors', donation.donor_id) : null,
    ctx.repo.list('donor_acknowledgments', { eq: { donation_id: id }, order: ['generated_at', 'desc'] })
  ]);
  const showValues = can(staff, 'donors.view_contact');
  return {
    donation: redactDonation(donation, staff),
    donor: redactDonor(donor, staff),
    items: items.map(function (i) {
      const out = Object.assign({}, i, { category_name: (cats.byId.get(i.category_id) || {}).name || '' });
      if (!showValues) delete out.estimated_value;
      return out;
    }),
    documents: docs.map(function (d) { return { id: d.id, file_name: d.file_name, content_type: d.content_type, size_bytes: d.size_bytes, uploaded_at: d.uploaded_at }; }),
    acknowledgments: acks.map(function (a) { return { id: a.id, letter_number: a.letter_number, status: a.status, sent_on: a.sent_on, sent_method: a.sent_method }; })
  };
}

const EDITABLE = ['donor_id', 'is_anonymous', 'received_on', 'amount', 'payment_method', 'restriction', 'restriction_purpose', 'description', 'estimated_value', 'notes', 'is_historical'];

/** Edit details. Items can't be edited here: void and re-enter, or record an inventory correction. */
export async function updateDonation(ctx, staff, id, body) {
  if (!isUuid(id)) throw new HttpError(400, 'Invalid donation id.');
  const existing = await ctx.repo.get('donations', id);
  if (!existing) throw new HttpError(404, 'Donation not found.');
  if (existing.status === 'void') throw new HttpError(409, 'Voided donations can’t be edited.');
  if (('amount' in body || 'estimated_value' in body || 'payment_method' in body) && !can(staff, 'donors.view_contact')) {
    throw new HttpError(403, 'Changing amounts requires access to donor contact details and amounts.');
  }
  const merged = Object.assign({}, existing, { items: [] });
  EDITABLE.forEach(function (k) { if (k in body) merged[k] = body[k]; });
  if (existing.donation_type === 'in_kind') merged.items = [{ category_id: '_', description: '_', quantity: 1 }];

  const cats = await categoriesBySlugAndId(ctx);
  cats.byId.set('_', { id: '_' });
  const { errors, value } = await validateDonation(ctx, Object.assign({}, merged, { donation_type: existing.donation_type }), cats);
  if (Object.keys(errors).length) throw fail(errors);

  const changed = EDITABLE.filter(function (k) { return String(value[k] == null ? '' : value[k]) !== String(existing[k] == null ? '' : existing[k]); });
  if (!changed.length) throw new HttpError(422, 'No changes to save.');
  const patch = { updated_at: ctx.now().toISOString() };
  changed.forEach(function (k) { patch[k] = value[k]; });
  const donation = await ctx.repo.update('donations', id, patch);

  // Keep the received-date of inventory entries in step with the donation.
  if (patch.received_on) {
    const items = await ctx.repo.list('donation_items', { eq: { donation_id: id } });
    for (const item of items) {
      const txns = await ctx.repo.list('inventory_transactions', { eq: { donation_item_id: item.id } });
      for (const t of txns) await ctx.repo.update('inventory_transactions', t.id, { occurred_on: patch.received_on });
    }
  }
  await audit(ctx, staff, 'donation.updated', 'donation', id, { fields: changed });
  return { donation: redactDonation(donation, staff) };
}

/** Void a donation. Items it added to inventory are removed with a correction entry. */
export async function voidDonation(ctx, staff, body) {
  if (!isUuid(body.id)) throw new HttpError(400, 'Invalid donation id.');
  const donation = await ctx.repo.get('donations', body.id);
  if (!donation) throw new HttpError(404, 'Donation not found.');
  if (donation.status === 'void') throw new HttpError(409, 'This donation is already void.');
  const reason = cleanMultiline(body.reason);
  if (!reason) throw fail({ reason: 'Explain why this donation is being voided.' });

  const items = await ctx.repo.list('donation_items', { eq: { donation_id: donation.id } });
  const byCategory = {};
  items.forEach(function (i) { byCategory[i.category_id] = (byCategory[i.category_id] || 0) + i.quantity; });
  const cats = await categoriesBySlugAndId(ctx);
  for (const catId of Object.keys(byCategory)) {
    const available = await onHand(ctx, catId);
    if (available < byCategory[catId]) {
      throw new HttpError(409, 'Some of these ' + ((cats.byId.get(catId) || {}).name || 'items').toLowerCase() +
        ' have already been distributed, so voiding would make inventory negative. Record an inventory correction instead.');
    }
  }
  const today = todayInOrgTimeZone(ctx.now());
  for (const catId of Object.keys(byCategory)) {
    await insertTransaction(ctx, staff, {
      category_id: catId, txn_type: 'adjustment', quantity: -byCategory[catId], occurred_on: today,
      reason: 'Donation voided: ' + reason
    });
  }
  const updated = await ctx.repo.update('donations', donation.id, { status: 'void', void_reason: reason, updated_at: ctx.now().toISOString() });
  await audit(ctx, staff, 'donation.voided', 'donation', donation.id, { items_reversed: items.length });
  return { donation: redactDonation(updated, staff) };
}

export async function exportDonationsCsv(ctx, staff, query) {
  const { donations } = await listDonations(ctx, staff, query);
  const amounts = can(staff, 'donors.view_contact');
  const header = ['Received', 'Donor', 'Anonymous', 'Type', 'Restriction', 'Restriction purpose', 'Items']
    .concat(amounts ? ['Amount', 'Payment method', 'Estimated value (internal)'] : [])
    .concat(['Description', 'Historical entry', 'Status', 'Acknowledgment']);
  const rows = donations.map(function (d) {
    return [d.received_on, d.donor_name, d.is_anonymous ? 'Yes' : 'No', d.donation_type === 'monetary' ? 'Monetary' : 'In-kind',
      d.restriction, d.restriction_purpose || '', d.item_summary]
      .concat(amounts ? [d.amount == null ? '' : Number(d.amount).toFixed(2), d.payment_method || '', d.estimated_value == null ? '' : Number(d.estimated_value).toFixed(2)] : [])
      .concat([d.description || '', d.is_historical ? 'Yes' : 'No', d.status, d.acknowledgment_status || 'Not started']);
  });
  await audit(ctx, staff, 'donations.exported', 'donation', null, { rows: rows.length });
  return { csv: toCsv([header].concat(rows)), filename: 'donations-' + todayInOrgTimeZone(ctx.now()) + '.csv' };
}

/* ---------- Supporting documents ---------- */

export async function uploadDocument(ctx, staff, body) {
  if (!isUuid(body.donation_id)) throw new HttpError(400, 'Invalid donation id.');
  const donation = await ctx.repo.get('donations', body.donation_id);
  if (!donation) throw new HttpError(404, 'Donation not found.');
  const ext = DOC_TYPES[body.content_type];
  if (!ext) throw fail({ file: 'Upload a PDF, JPG, PNG, or WebP file.' });
  const fileName = cleanText(body.file_name).replace(/[^\w.\- ()]/g, '_').slice(0, 200) || ('document.' + ext);
  if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(body.data)) throw fail({ file: 'The file could not be read.' });
  const buffer = Buffer.from(body.data, 'base64');
  if (!buffer.length) throw fail({ file: 'The file is empty.' });
  if (buffer.length > MAX_DOCUMENT_BYTES) throw fail({ file: 'Files must be 3 MB or smaller.' });

  const path = donation.id + '/' + randomUUID() + '.' + ext;
  await ctx.storage.upload(path, buffer, body.content_type);
  const doc = await ctx.repo.insert('donation_documents', {
    id: randomUUID(), donation_id: donation.id, storage_path: path, file_name: fileName,
    content_type: body.content_type, size_bytes: buffer.length, uploaded_by: staff.id, uploaded_at: ctx.now().toISOString()
  });
  await audit(ctx, staff, 'donation.document_uploaded', 'donation', donation.id, { document_id: doc.id, size_bytes: buffer.length });
  return { document: { id: doc.id, file_name: doc.file_name, content_type: doc.content_type, size_bytes: doc.size_bytes, uploaded_at: doc.uploaded_at } };
}

export async function documentLink(ctx, staff, id) {
  if (!isUuid(id)) throw new HttpError(400, 'Invalid document id.');
  const doc = await ctx.repo.get('donation_documents', id);
  if (!doc) throw new HttpError(404, 'Document not found.');
  const url = await ctx.storage.signedUrl(doc.storage_path, 60);
  await audit(ctx, staff, 'donation.document_opened', 'donation', doc.donation_id, { document_id: doc.id });
  return { url: url, expires_in: 60 };
}
