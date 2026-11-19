import { randomUUID } from 'node:crypto';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { toCsv } from './hours.js';
import { cleanText, cleanMultiline, isUuid, isValidDate, todayInOrgTimeZone } from '../../../js/volunteer-core.js';

// Inventory is a ledger: stock on hand is always the sum of transactions,
// so totals and history can never disagree.

export const MAX_QUANTITY = 100000;
export const PARTICIPATION = ['hosted', 'exhibited', 'attended', 'partnered'];

function fail(errors) {
  return new HttpError(422, 'Please correct the highlighted fields.', { errors: errors });
}

export async function categoriesBySlugAndId(ctx) {
  const rows = await ctx.repo.list('inventory_categories', { order: ['sort_order', 'asc'] });
  return { list: rows, byId: new Map(rows.map(function (c) { return [c.id, c]; })) };
}

export async function onHand(ctx, categoryId) {
  const txns = await ctx.repo.list('inventory_transactions', { eq: { category_id: categoryId } });
  return txns.reduce(function (t, x) { return t + Number(x.quantity); }, 0);
}

function validQuantity(value, errors, field) {
  const q = Number(value);
  if (!Number.isInteger(q) || q <= 0 || q > MAX_QUANTITY) {
    errors[field || 'quantity'] = 'Enter a whole number between 1 and ' + MAX_QUANTITY.toLocaleString() + '.';
    return null;
  }
  return q;
}

function validDate(value, errors, today) {
  if (!isValidDate(value)) { errors.occurred_on = 'Enter a valid date.'; return null; }
  if (value > today) { errors.occurred_on = 'The date can’t be in the future.'; return null; }
  return value;
}

async function loadCategory(ctx, id) {
  if (!isUuid(id)) throw fail({ category_id: 'Choose a category.' });
  const cat = await ctx.repo.get('inventory_categories', id);
  if (!cat) throw fail({ category_id: 'Choose a category.' });
  return cat;
}

// Same request submitted twice (double-click, retry) returns the first result.
async function existingRequest(ctx, requestId) {
  if (!requestId) return null;
  if (!isUuid(requestId)) throw new HttpError(400, 'Invalid request id.');
  const rows = await ctx.repo.list('inventory_transactions', { eq: { request_id: requestId }, limit: 1 });
  return rows[0] || null;
}

export async function insertTransaction(ctx, staff, row) {
  return ctx.repo.insert('inventory_transactions', Object.assign({
    id: randomUUID(),
    donation_item_id: null,
    event_id: null,
    reason: null,
    notes: null,
    is_historical: false,
    request_id: null,
    created_by: staff.id,
    created_at: ctx.now().toISOString()
  }, row));
}

/* ---------- Summary & history ---------- */

export async function inventorySummary(ctx) {
  const [cats, txns] = await Promise.all([
    categoriesBySlugAndId(ctx),
    ctx.repo.list('inventory_transactions', {})
  ]);
  const totals = cats.list.map(function (c) {
    const mine = txns.filter(function (t) { return t.category_id === c.id; });
    const sum = function (type) {
      return mine.filter(function (t) { return t.txn_type === type; }).reduce(function (a, t) { return a + Number(t.quantity); }, 0);
    };
    const opening = sum('opening_balance');
    const received = sum('received');
    const distributed = -sum('distributed');
    const adjustments = sum('adjustment');
    return {
      category_id: c.id, slug: c.slug, name: c.name,
      opening_balance: opening, received: received, distributed: distributed, adjustments: adjustments,
      on_hand: opening + received - distributed + adjustments,
      has_opening_balance: mine.some(function (t) { return t.txn_type === 'opening_balance'; })
    };
  });
  const all = totals.reduce(function (a, t) {
    return { received: a.received + t.received + t.opening_balance, distributed: a.distributed + t.distributed, on_hand: a.on_hand + t.on_hand };
  }, { received: 0, distributed: 0, on_hand: 0 });
  return { categories: totals, totals: all };
}

export async function inventoryHistory(ctx, staff, query) {
  const filter = { eq: {}, gte: {}, lte: {}, order: ['occurred_on', 'desc'] };
  if (query.category_id) {
    if (!isUuid(query.category_id)) throw new HttpError(400, 'Invalid category.');
    filter.eq.category_id = query.category_id;
  }
  if (query.from) { if (!isValidDate(query.from)) throw new HttpError(400, 'Invalid start date.'); filter.gte.occurred_on = query.from; }
  if (query.to) { if (!isValidDate(query.to)) throw new HttpError(400, 'Invalid end date.'); filter.lte.occurred_on = query.to; }

  const [txns, cats, events, staffRows] = await Promise.all([
    ctx.repo.list('inventory_transactions', filter),
    categoriesBySlugAndId(ctx),
    ctx.repo.list('program_events', {}),
    ctx.repo.list('staff_users', {})
  ]);
  const itemIds = txns.map(function (t) { return t.donation_item_id; }).filter(Boolean);
  const items = itemIds.length ? await ctx.repo.list('donation_items', { in: { id: itemIds } }) : [];
  const itemMap = new Map(items.map(function (i) { return [i.id, i]; }));
  const eventMap = new Map(events.map(function (e) { return [e.id, e]; }));
  const staffMap = new Map(staffRows.map(function (s) { return [s.id, s.full_name]; }));

  // Newest first; same-day entries by when they were recorded.
  txns.sort(function (a, b) {
    return a.occurred_on === b.occurred_on ? (a.created_at < b.created_at ? 1 : -1) : (a.occurred_on < b.occurred_on ? 1 : -1);
  });

  return {
    transactions: txns.map(function (t) {
      const item = itemMap.get(t.donation_item_id);
      const ev = eventMap.get(t.event_id);
      return Object.assign({}, t, {
        category_name: (cats.byId.get(t.category_id) || {}).name || '',
        item_description: item ? item.description : null,
        donation_id: item ? item.donation_id : null,
        event_name: ev ? ev.name + ' (' + ev.event_date + ')' : null,
        recorded_by_name: staffMap.get(t.created_by) || ''
      });
    })
  };
}

export async function exportInventoryCsv(ctx, staff, query) {
  const { transactions } = await inventoryHistory(ctx, staff, query);
  const TYPE = { opening_balance: 'Opening balance', received: 'Received', distributed: 'Distributed', adjustment: 'Correction' };
  const rows = transactions.map(function (t) {
    return [t.occurred_on, t.category_name, TYPE[t.txn_type] || t.txn_type, t.quantity, t.item_description || '', t.event_name || '',
      t.reason || '', t.notes || '', t.is_historical ? 'Yes' : 'No', t.recorded_by_name, t.created_at];
  });
  await audit(ctx, staff, 'inventory.exported', 'inventory_transaction', null, { rows: rows.length });
  return {
    csv: toCsv([['Date', 'Category', 'Type', 'Quantity (+in / -out)', 'Item', 'Event', 'Reason', 'Notes', 'Historical entry', 'Recorded by', 'Recorded at']].concat(rows)),
    filename: 'inventory-history-' + todayInOrgTimeZone(ctx.now()) + '.csv'
  };
}

/* ---------- Opening balances, distributions, corrections ---------- */

export async function setOpeningBalance(ctx, staff, body) {
  const errors = {};
  const cat = await loadCategory(ctx, body.category_id);
  const quantity = validQuantity(body.quantity, errors);
  const date = validDate(body.occurred_on, errors, todayInOrgTimeZone(ctx.now()));
  if (Object.keys(errors).length) throw fail(errors);

  const existing = await ctx.repo.list('inventory_transactions', { eq: { category_id: cat.id, txn_type: 'opening_balance' }, limit: 1 });
  if (existing.length) {
    throw new HttpError(409, cat.name + ' already has an opening balance. Use a correction to change the count.');
  }
  const txn = await insertTransaction(ctx, staff, {
    category_id: cat.id, txn_type: 'opening_balance', quantity: quantity, occurred_on: date,
    notes: cleanMultiline(body.notes) || null, is_historical: true
  });
  await audit(ctx, staff, 'inventory.opening_balance', 'inventory_transaction', txn.id, { category: cat.slug, quantity: quantity });
  return { transaction: txn };
}

export async function recordDistribution(ctx, staff, body) {
  const repeat = await existingRequest(ctx, body.request_id);
  if (repeat) return { transaction: repeat, repeated: true };

  const errors = {};
  const cat = await loadCategory(ctx, body.category_id);
  const quantity = validQuantity(body.quantity, errors);
  const today = todayInOrgTimeZone(ctx.now());
  const date = validDate(body.occurred_on, errors, today);
  let eventId = null;
  if (body.event_id) {
    if (!isUuid(body.event_id) || !(await ctx.repo.get('program_events', body.event_id))) errors.event_id = 'Choose an event from the list.';
    else eventId = body.event_id;
  }
  const notes = cleanMultiline(body.notes);
  if (notes.length > 1000) errors.notes = 'Notes are too long.';
  if (Object.keys(errors).length) throw fail(errors);

  const available = await onHand(ctx, cat.id);
  if (quantity > available) {
    throw new HttpError(409, 'Only ' + available + ' ' + cat.name.toLowerCase() + ' on hand. If the count is off, record a correction first.');
  }

  const txn = await insertTransaction(ctx, staff, {
    category_id: cat.id, txn_type: 'distributed', quantity: -quantity, occurred_on: date, event_id: eventId,
    notes: notes || null, is_historical: date < today && body.is_historical === true, request_id: body.request_id || null
  });
  await audit(ctx, staff, 'inventory.distributed', 'inventory_transaction', txn.id, { category: cat.slug, quantity: quantity, event_id: eventId });
  return { transaction: txn };
}

export async function recordAdjustment(ctx, staff, body) {
  const repeat = await existingRequest(ctx, body.request_id);
  if (repeat) return { transaction: repeat, repeated: true };

  const errors = {};
  const cat = await loadCategory(ctx, body.category_id);
  const change = Number(body.quantity);
  if (!Number.isInteger(change) || change === 0 || Math.abs(change) > MAX_QUANTITY) {
    errors.quantity = 'Enter a whole number: positive to add items, negative to remove them.';
  }
  const date = validDate(body.occurred_on, errors, todayInOrgTimeZone(ctx.now()));
  const reason = cleanMultiline(body.reason);
  if (!reason) errors.reason = 'Explain why the count is being corrected.';
  else if (reason.length > 1000) errors.reason = 'Reason is too long.';
  if (Object.keys(errors).length) throw fail(errors);

  if (change < 0) {
    const available = await onHand(ctx, cat.id);
    if (available + change < 0) throw new HttpError(409, 'Only ' + available + ' on hand; a correction can’t take ' + cat.name.toLowerCase() + ' below zero.');
  }
  const txn = await insertTransaction(ctx, staff, {
    category_id: cat.id, txn_type: 'adjustment', quantity: change, occurred_on: date, reason: reason, request_id: body.request_id || null
  });
  await audit(ctx, staff, 'inventory.adjusted', 'inventory_transaction', txn.id, { category: cat.slug, quantity: change });
  return { transaction: txn };
}

/* ---------- Program events (where items were distributed) ---------- */

export async function listProgramEvents(ctx) {
  return { events: await ctx.repo.list('program_events', { order: ['event_date', 'desc'] }) };
}

export async function createProgramEvent(ctx, staff, body) {
  const errors = {};
  const name = cleanText(body.name);
  if (!name) errors.name = 'Enter the event name.';
  else if (name.length > 200) errors.name = 'Name is too long.';
  if (!isValidDate(body.event_date)) errors.event_date = 'Enter a valid date.';
  if (PARTICIPATION.indexOf(body.participation) === -1) errors.participation = 'Choose hosted, exhibited, attended, or partnered.';
  const location = cleanText(body.location);
  if (location.length > 300) errors.location = 'Location is too long.';
  if (Object.keys(errors).length) throw fail(errors);

  const dup = await ctx.repo.list('program_events', { eq: { name: name, event_date: body.event_date }, limit: 1 });
  if (dup.length) return { event: dup[0], existing: true };

  const nowIso = ctx.now().toISOString();
  const ev = await ctx.repo.insert('program_events', {
    id: randomUUID(), name: name, event_date: body.event_date, participation: body.participation,
    location: location || null, public_event_id: cleanText(body.public_event_id) || null,
    notes: cleanMultiline(body.notes) || null, created_by: staff.id, created_at: nowIso, updated_at: nowIso
  });
  await audit(ctx, staff, 'program_event.created', 'program_event', ev.id, { event_date: ev.event_date });
  return { event: ev };
}
