import { randomUUID } from 'node:crypto';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { can } from '../permissions.js';
import { toCsv } from './hours.js';
import { PARTICIPATION } from './inventory.js';
import { formatLongDate } from './letters.js';
import { cleanMultiline, cleanText, isUuid, isValidDate, todayInOrgTimeZone } from '../../../js/volunteer-core.js';

// Community impact reporting. Figures are pulled from existing records
// wherever possible (inventory, approved volunteer hours, donations, events);
// only what can't be derived is entered per event. Every figure carries a
// qualifier so estimates never read as exact counts.

export const QUALIFIERS = ['exact', 'approximate', 'estimated', 'minimum'];

// key, label, unit, where it comes from, whether a starting total may be recorded.
export const METRICS = [
  { key: 'children_served', label: 'Children served', unit: 'count', source: 'Event counts', baseline: true },
  { key: 'families_served', label: 'Families served', unit: 'count', source: 'Event counts', baseline: true },
  { key: 'attendance', label: 'Event attendance', unit: 'count', source: 'Event counts', baseline: true },
  { key: 'game_participants', label: 'Educational game participants', unit: 'count', source: 'Event counts', baseline: true },
  { key: 'table_interactions', label: 'Table interactions', unit: 'count', source: 'Event counts', baseline: true, engagement: true },
  { key: 'activity_plays', label: 'Tablet activity plays', unit: 'count', source: 'Event counts', baseline: true, engagement: true },
  { key: 'books_distributed', label: 'Books distributed', unit: 'count', source: 'Inventory (or event counts)', baseline: true },
  { key: 'clothing_distributed', label: 'Clothing items distributed', unit: 'count', source: 'Inventory (or event counts)', baseline: true },
  { key: 'supplies_distributed', label: 'Educational supplies distributed', unit: 'count', source: 'Inventory', baseline: true },
  { key: 'other_items_distributed', label: 'Other items distributed', unit: 'count', source: 'Inventory (or event counts)', baseline: true },
  { key: 'events_total', label: 'Events held or attended', unit: 'count', source: 'Events', baseline: true },
  { key: 'events_hosted', label: 'Events hosted', unit: 'count', source: 'Events', baseline: false },
  { key: 'events_attended', label: 'Events attended or exhibited at', unit: 'count', source: 'Events', baseline: false },
  { key: 'volunteer_hours', label: 'Verified volunteer hours', unit: 'hours', source: 'Approved volunteer hours', baseline: false },
  { key: 'monetary_donations', label: 'Monetary donations received', unit: 'usd', source: 'Donations', baseline: false, sensitive: true },
  { key: 'in_kind_donations', label: 'In-kind donations received', unit: 'count', source: 'Donations', baseline: false }
];
const METRIC = new Map(METRICS.map(function (m) { return [m.key, m]; }));
export const EVENT_COUNT_METRICS = ['attendance', 'children_served', 'families_served', 'game_participants', 'table_interactions', 'activity_plays',
  'books_distributed', 'clothing_distributed', 'other_items_distributed'];

// Inventory categories feeding each distribution metric. When an event has
// items linked in inventory, those win; a manual event count is used only
// for events with no linked inventory in that category.
const INVENTORY_METRICS = {
  books_distributed: ['books'],
  clothing_distributed: ['clothing'],
  supplies_distributed: ['educational_supplies'],
  other_items_distributed: ['electronics', 'other']
};

function fail(errors) {
  return new HttpError(422, 'Please correct the highlighted fields.', { errors: errors });
}

/** Combine qualifiers: any estimate makes the total estimated, and so on. */
export function combineQualifiers(list) {
  if (list.indexOf('estimated') !== -1) return 'estimated';
  if (list.indexOf('approximate') !== -1) return 'approximate';
  if (list.indexOf('minimum') !== -1) return 'minimum';
  return 'exact';
}

export function formatFigure(value, qualifier, unit) {
  if (value === null || value === undefined) return '—';
  const n = unit === 'usd'
    ? '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : unit === 'hours' ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })
      : Number(value).toLocaleString('en-US');
  if (qualifier === 'approximate') return 'About ' + n;
  if (qualifier === 'estimated') return 'Est. ' + n;
  if (qualifier === 'minimum') return n + '+';
  return n;
}

const inRange = function (date, range) {
  return (!range.from || date >= range.from) && (!range.to || date <= range.to);
};

/* ---------- Loading ---------- */

async function loadAll(ctx) {
  const [events, counts, txns, cats, hours, donations, items, baselines] = await Promise.all([
    ctx.repo.list('program_events', {}),
    ctx.repo.list('event_impact_counts', {}),
    ctx.repo.list('inventory_transactions', { eq: { txn_type: 'distributed' } }),
    ctx.repo.list('inventory_categories', {}),
    ctx.repo.list('hour_entries', { eq: { status: 'approved' } }),
    ctx.repo.list('donations', { eq: { status: 'active' } }),
    ctx.repo.list('donation_items', {}),
    ctx.repo.list('impact_baselines', {})
  ]);
  const slugById = new Map(cats.map(function (c) { return [c.id, c.slug]; }));
  const activeDonationIds = new Set(donations.map(function (d) { return d.id; }));
  return {
    events: events,
    eventById: new Map(events.map(function (e) { return [e.id, e]; })),
    counts: counts,
    distributions: txns.map(function (t) { return Object.assign({}, t, { slug: slugById.get(t.category_id) }); }),
    hours: hours,
    donations: donations,
    items: items.filter(function (i) { return activeDonationIds.has(i.donation_id); }),
    baselines: new Map(baselines.map(function (b) { return [b.metric, b]; }))
  };
}

/* ---------- Computing figures ---------- */

// Raw dated entries for a metric: [{ date, value, qualifier, event_id? }]
function entriesFor(key, data) {
  const out = [];
  const eventDate = function (id) { return (data.eventById.get(id) || {}).event_date; };
  if (INVENTORY_METRICS[key]) {
    const slugs = INVENTORY_METRICS[key];
    const linked = new Set();
    data.distributions.filter(function (t) { return slugs.indexOf(t.slug) !== -1; }).forEach(function (t) {
      if (t.event_id) linked.add(t.event_id);
      out.push({ date: t.occurred_on, value: -Number(t.quantity), qualifier: 'exact', event_id: t.event_id || null });
    });
    data.counts.filter(function (c) { return c.metric === key && !linked.has(c.event_id) && eventDate(c.event_id); }).forEach(function (c) {
      out.push({ date: eventDate(c.event_id), value: c.value, qualifier: c.qualifier, event_id: c.event_id });
    });
    return out;
  }
  if (EVENT_COUNT_METRICS.indexOf(key) !== -1) {
    data.counts.filter(function (c) { return c.metric === key && eventDate(c.event_id); }).forEach(function (c) {
      out.push({ date: eventDate(c.event_id), value: c.value, qualifier: c.qualifier, event_id: c.event_id });
    });
    return out;
  }
  if (key === 'events_total' || key === 'events_hosted' || key === 'events_attended') {
    data.events.forEach(function (e) {
      const hosted = e.participation === 'hosted';
      if (key === 'events_total' || (key === 'events_hosted') === hosted) out.push({ date: e.event_date, value: 1, qualifier: 'exact', event_id: e.id });
    });
    return out;
  }
  if (key === 'volunteer_hours') {
    data.hours.forEach(function (h) { out.push({ date: h.service_date, value: Number(h.net_minutes) / 60, qualifier: 'exact' }); });
    return out;
  }
  if (key === 'monetary_donations') {
    data.donations.filter(function (d) { return d.donation_type === 'monetary'; }).forEach(function (d) {
      out.push({ date: d.received_on, value: Number(d.amount), qualifier: 'exact', gift: true });
    });
    return out;
  }
  if (key === 'in_kind_donations') {
    data.donations.filter(function (d) { return d.donation_type === 'in_kind'; }).forEach(function (d) {
      out.push({ date: d.received_on, value: 1, qualifier: 'exact', gift: true });
    });
    return out;
  }
  return out;
}

/**
 * One metric over a range. A starting total (baseline) is included only when
 * the range covers its whole span; entries inside that span are then skipped.
 */
function computeMetric(key, data, range, staff) {
  const meta = METRIC.get(key);
  if (meta.sensitive && staff && !can(staff, 'donors.view_contact')) {
    return { key: key, label: meta.label, unit: meta.unit, value: null, hidden: true, qualifier: 'exact', has_data: false };
  }
  let entries = entriesFor(key, data).filter(function (e) { return inRange(e.date, range); });
  const base = data.baselines.get(key);
  let baselineUsed = null;
  let baselineSkipped = null;
  if (base) {
    const start = base.period_start || null;
    const coversWhole = (!range.from || (start && range.from <= start)) && (!range.to || range.to >= base.as_of);
    if (coversWhole) {
      entries = entries.filter(function (e) { return e.date > base.as_of || (start && e.date < start); });
      baselineUsed = { value: base.value, qualifier: base.qualifier, period_start: start, as_of: base.as_of };
    } else if (!range.to || range.to >= (start || '0000')) {
      if (!range.from || range.from <= base.as_of) baselineSkipped = { period_start: start, as_of: base.as_of };
    }
  }
  const qualifiers = entries.map(function (e) { return e.qualifier; });
  let value = entries.reduce(function (t, e) { return t + e.value; }, 0);
  if (baselineUsed) { value += baselineUsed.value; qualifiers.push(baselineUsed.qualifier); }
  if (meta.unit === 'hours') value = Math.round(value * 100) / 100;
  if (meta.unit === 'usd') value = Math.round(value * 100) / 100;
  const result = {
    key: key, label: meta.label, unit: meta.unit, value: value, qualifier: combineQualifiers(qualifiers),
    has_data: entries.length > 0 || !!baselineUsed, baseline: baselineUsed, baseline_skipped: baselineSkipped,
    engagement: !!meta.engagement
  };
  if (key === 'monetary_donations') result.gift_count = entries.length;
  if (key === 'in_kind_donations') {
    const ids = new Set(data.donations.filter(function (d) { return d.donation_type === 'in_kind' && inRange(d.received_on, range); }).map(function (d) { return d.id; }));
    result.items_received = data.items.filter(function (i) { return ids.has(i.donation_id); }).reduce(function (t, i) { return t + i.quantity; }, 0);
  }
  return result;
}

export function resolveRange(query, today) {
  const year = today.slice(0, 4);
  const month = today.slice(0, 7);
  const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  const lastDay = function (y, m) { return new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate(); };
  switch (query.preset) {
    case 'month': return { preset: 'month', from: month + '-01', to: month + '-' + String(lastDay(year, today.slice(5, 7))).padStart(2, '0') };
    case 'quarter': {
      const sm = q * 3 + 1;
      const em = sm + 2;
      return { preset: 'quarter', from: year + '-' + String(sm).padStart(2, '0') + '-01', to: year + '-' + String(em).padStart(2, '0') + '-' + lastDay(year, em) };
    }
    case 'year': {
      const y = /^\d{4}$/.test(query.year || '') ? query.year : year;
      return { preset: 'year', year: y, from: y + '-01-01', to: y + '-12-31' };
    }
    case 'custom': {
      if (!isValidDate(query.from) || !isValidDate(query.to)) throw new HttpError(422, 'Choose a start and end date.');
      if (query.from > query.to) throw new HttpError(422, 'The start date must be before the end date.');
      return { preset: 'custom', from: query.from, to: query.to };
    }
    default: return { preset: 'all', from: null, to: null };
  }
}

export async function impactReport(ctx, staff, query) {
  const today = todayInOrgTimeZone(ctx.now());
  const range = resolveRange(query, today);
  const data = await loadAll(ctx);
  const metrics = METRICS.map(function (m) { return computeMetric(m.key, data, range, staff); });

  const events = data.events.filter(function (e) { return inRange(e.event_date, range); })
    .sort(function (a, b) { return a.event_date < b.event_date ? 1 : -1; })
    .map(function (e) { return eventSummary(e, data); });

  const goals = range.preset === 'year' ? await goalProgress(ctx, staff, range.year, data) : [];
  return {
    range: range, generated_on: today, metrics: metrics, events: events, goals: goals,
    summary: executiveSummary(metrics, range)
  };
}

function eventSummary(e, data) {
  const one = { from: e.event_date, to: e.event_date };
  const scoped = Object.assign({}, data, {
    events: [e], counts: data.counts.filter(function (c) { return c.event_id === e.id; }),
    distributions: data.distributions.filter(function (t) { return t.event_id === e.id; }), baselines: new Map()
  });
  const figures = {};
  EVENT_COUNT_METRICS.concat(['supplies_distributed']).forEach(function (k) {
    const r = computeMetric(k, scoped, one, null);
    if (r.has_data) figures[k] = { value: r.value, qualifier: r.qualifier };
  });
  return { id: e.id, name: e.name, event_date: e.event_date, participation: e.participation, location: e.location, public_event_id: e.public_event_id, figures: figures };
}

/* ---------- Trend & comparisons ---------- */

export async function impactTrend(ctx, staff, query) {
  const metric = METRIC.get(query.metric);
  if (!metric) throw new HttpError(422, 'Choose a figure to chart.');
  const today = todayInOrgTimeZone(ctx.now());
  let from = query.from;
  let to = query.to;
  if (!isValidDate(from) || !isValidDate(to)) {
    const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 12, 1));
    from = d.toISOString().slice(0, 7) + '-01';
    to = today;
  }
  const data = await loadAll(ctx);
  data.baselines = new Map(); // starting totals aren't split by month
  const months = [];
  let cursor = from.slice(0, 7);
  while (cursor <= to.slice(0, 7) && months.length < 120) {
    const [y, m] = cursor.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = computeMetric(metric.key, data, { from: cursor + '-01', to: cursor + '-' + String(last).padStart(2, '0') }, staff);
    months.push({ month: cursor, value: r.value, qualifier: r.qualifier, has_data: r.has_data });
    const next = new Date(Date.UTC(y, m, 1));
    cursor = next.toISOString().slice(0, 7);
  }
  return { metric: { key: metric.key, label: metric.label, unit: metric.unit }, months: months, hidden: !!(metric.sensitive && !can(staff, 'donors.view_contact')) };
}

export async function yearOverYear(ctx, staff, query) {
  const today = todayInOrgTimeZone(ctx.now());
  const year = /^\d{4}$/.test(query.year || '') ? Number(query.year) : Number(today.slice(0, 4));
  const data = await loadAll(ctx);
  const ranges = [{ from: (year - 1) + '-01-01', to: (year - 1) + '-12-31' }, { from: year + '-01-01', to: year + '-12-31' }];
  return {
    year: year,
    rows: METRICS.map(function (m) {
      const prev = computeMetric(m.key, data, ranges[0], staff);
      const cur = computeMetric(m.key, data, ranges[1], staff);
      return {
        key: m.key, label: m.label, unit: m.unit, hidden: !!cur.hidden,
        previous: { value: prev.value, qualifier: prev.qualifier, has_data: prev.has_data },
        current: { value: cur.value, qualifier: cur.qualifier, has_data: cur.has_data },
        change_pct: prev.has_data && cur.has_data && prev.value > 0 ? Math.round((cur.value - prev.value) / prev.value * 100) : null
      };
    })
  };
}

/* ---------- Goals ---------- */

async function goalProgress(ctx, staff, year, data) {
  const goals = await ctx.repo.list('impact_goals', { eq: { goal_year: Number(year) } });
  const range = { from: year + '-01-01', to: year + '-12-31' };
  return goals.filter(function (g) { return METRIC.has(g.metric); }).map(function (g) {
    const r = computeMetric(g.metric, data, range, staff);
    return {
      id: g.id, metric: g.metric, label: METRIC.get(g.metric).label, unit: METRIC.get(g.metric).unit, target: g.target, notes: g.notes,
      value: r.value, qualifier: r.qualifier, hidden: !!r.hidden,
      percent: r.value === null ? null : Math.min(100, Math.round(r.value / g.target * 100))
    };
  });
}

export async function listGoals(ctx, staff, query) {
  const year = /^\d{4}$/.test(query.year || '') ? query.year : todayInOrgTimeZone(ctx.now()).slice(0, 4);
  return { year: Number(year), goals: await goalProgress(ctx, staff, year, await loadAll(ctx)) };
}

export async function setGoal(ctx, staff, body) {
  const year = Number(body.goal_year);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw fail({ goal_year: 'Choose a year.' });
  if (!METRIC.has(body.metric)) throw fail({ metric: 'Choose a figure.' });
  const existing = (await ctx.repo.list('impact_goals', { eq: { goal_year: year, metric: body.metric }, limit: 1 }))[0];
  if (body.remove === true) {
    if (existing) await ctx.repo.remove('impact_goals', { eq: { id: existing.id } });
    await audit(ctx, staff, 'impact.goal_removed', 'impact_goal', existing ? existing.id : null, { year: year, metric: body.metric });
    return { removed: true };
  }
  const target = Number(body.target);
  if (!Number.isFinite(target) || target <= 0 || target > 100000000) throw fail({ target: 'Enter a target greater than zero.' });
  const notes = cleanMultiline(body.notes) || null;
  const row = { goal_year: year, metric: body.metric, target: Math.round(target), notes: notes, set_by: staff.id, updated_at: ctx.now().toISOString() };
  const saved = existing ? await ctx.repo.update('impact_goals', existing.id, row) : await ctx.repo.insert('impact_goals', Object.assign({ id: randomUUID() }, row));
  await audit(ctx, staff, 'impact.goal_set', 'impact_goal', saved.id, { year: year, metric: body.metric, target: row.target });
  return { goal: saved };
}

/* ---------- Starting totals (figures kept before the portal) ---------- */

export async function listBaselines(ctx) {
  const rows = await ctx.repo.list('impact_baselines', {});
  return {
    metrics: METRICS.filter(function (m) { return m.baseline; }).map(function (m) { return { key: m.key, label: m.label }; }),
    baselines: rows.map(function (b) { return Object.assign({}, b, { label: (METRIC.get(b.metric) || {}).label || b.metric }); })
  };
}

export async function setBaseline(ctx, staff, body) {
  const meta = METRIC.get(body.metric);
  if (!meta || !meta.baseline) throw fail({ metric: 'Choose a figure that can have a starting total.' });
  const existing = (await ctx.repo.list('impact_baselines', { eq: { metric: body.metric }, limit: 1 }))[0];
  if (body.remove === true) {
    if (existing) await ctx.repo.remove('impact_baselines', { eq: { id: existing.id } });
    await audit(ctx, staff, 'impact.baseline_removed', 'impact_baseline', existing ? existing.id : null, { metric: body.metric });
    return { removed: true };
  }
  const errors = {};
  const value = Number(body.value);
  if (!Number.isInteger(value) || value < 0) errors.value = 'Enter a whole number.';
  if (QUALIFIERS.indexOf(body.qualifier) === -1) errors.qualifier = 'Choose exact, about, estimated, or "or more".';
  if (!isValidDate(body.as_of)) errors.as_of = 'Enter the date these totals run through.';
  if (body.period_start && !isValidDate(body.period_start)) errors.period_start = 'Enter a valid start date.';
  if (body.period_start && isValidDate(body.as_of) && body.period_start > body.as_of) errors.period_start = 'The start must be on or before the “through” date.';
  if (Object.keys(errors).length) throw fail(errors);
  const row = {
    metric: body.metric, value: value, qualifier: body.qualifier, as_of: body.as_of, period_start: body.period_start || null,
    notes: cleanMultiline(body.notes) || null, recorded_by: staff.id, recorded_at: ctx.now().toISOString()
  };
  const saved = existing ? await ctx.repo.update('impact_baselines', existing.id, row) : await ctx.repo.insert('impact_baselines', Object.assign({ id: randomUUID() }, row));
  await audit(ctx, staff, 'impact.baseline_set', 'impact_baseline', saved.id, { metric: body.metric, value: value, qualifier: body.qualifier });
  return { baseline: saved };
}

/* ---------- Events & per-event counts ---------- */

export async function listImpactEvents(ctx) {
  const data = await loadAll(ctx);
  return {
    events: data.events.slice().sort(function (a, b) { return a.event_date < b.event_date ? 1 : -1; }).map(function (e) { return eventSummary(e, data); })
  };
}

export async function eventReport(ctx, staff, id) {
  if (!isUuid(id)) throw new HttpError(400, 'Invalid event id.');
  const data = await loadAll(ctx);
  const e = data.eventById.get(id);
  if (!e) throw new HttpError(404, 'Event not found.');
  const cats = await ctx.repo.list('inventory_categories', {});
  const catName = new Map(cats.map(function (c) { return [c.slug, c.name]; }));
  const linked = data.distributions.filter(function (t) { return t.event_id === id; });
  return {
    event: e,
    summary: eventSummary(e, data),
    counts: data.counts.filter(function (c) { return c.event_id === id; }),
    distributions: Object.entries(linked.reduce(function (acc, t) { acc[t.slug] = (acc[t.slug] || 0) - Number(t.quantity); return acc; }, {}))
      .map(function (pair) { return { category: catName.get(pair[0]) || pair[0], quantity: pair[1] }; }),
    count_metrics: EVENT_COUNT_METRICS.map(function (k) { return { key: k, label: METRIC.get(k).label, engagement: !!METRIC.get(k).engagement }; })
  };
}

/** Create an event; warns if another event is already recorded on that date. */
export async function createImpactEvent(ctx, staff, body) {
  const errors = {};
  const name = cleanText(body.name);
  if (!name) errors.name = 'Enter the event name.';
  else if (name.length > 200) errors.name = 'Name is too long.';
  if (!isValidDate(body.event_date)) errors.event_date = 'Enter a valid date.';
  if (PARTICIPATION.indexOf(body.participation) === -1) errors.participation = 'Choose hosted, exhibited, attended, or partnered.';
  if (Object.keys(errors).length) throw fail(errors);

  const sameDay = await ctx.repo.list('program_events', { eq: { event_date: body.event_date } });
  const exact = sameDay.find(function (e) { return e.name.toLowerCase() === name.toLowerCase(); });
  if (exact) return { event: exact, existing: true };
  if (body.public_event_id) {
    const linked = (await ctx.repo.list('program_events', { eq: { public_event_id: cleanText(body.public_event_id) }, limit: 1 }))[0];
    if (linked) return { event: linked, existing: true };
  }
  if (sameDay.length && body.confirm_duplicate !== true) {
    throw new HttpError(409, 'Another event is already recorded on this date: ' + sameDay.map(function (e) { return e.name; }).join(', ') +
      '. If this is a different event, confirm to add it.', { possible_duplicate: sameDay.map(function (e) { return { id: e.id, name: e.name }; }) });
  }
  const nowIso = ctx.now().toISOString();
  const ev = await ctx.repo.insert('program_events', {
    id: randomUUID(), name: name, event_date: body.event_date, participation: body.participation,
    location: cleanText(body.location) || null, public_event_id: cleanText(body.public_event_id) || null,
    notes: cleanMultiline(body.notes) || null, created_by: staff.id, created_at: nowIso, updated_at: nowIso
  });
  await audit(ctx, staff, 'program_event.created', 'program_event', ev.id, { event_date: ev.event_date, participation: ev.participation });
  return { event: ev };
}

export async function updateImpactEvent(ctx, staff, id, body) {
  if (!isUuid(id)) throw new HttpError(400, 'Invalid event id.');
  const e = await ctx.repo.get('program_events', id);
  if (!e) throw new HttpError(404, 'Event not found.');
  const patch = {};
  const errors = {};
  if ('name' in body) { const n = cleanText(body.name); if (!n || n.length > 200) errors.name = 'Enter the event name.'; else patch.name = n; }
  if ('event_date' in body) { if (!isValidDate(body.event_date)) errors.event_date = 'Enter a valid date.'; else patch.event_date = body.event_date; }
  if ('participation' in body) { if (PARTICIPATION.indexOf(body.participation) === -1) errors.participation = 'Choose a role.'; else patch.participation = body.participation; }
  if ('location' in body) patch.location = cleanText(body.location) || null;
  if ('notes' in body) patch.notes = cleanMultiline(body.notes) || null;
  if (Object.keys(errors).length) throw fail(errors);
  if (!Object.keys(patch).length) throw new HttpError(422, 'No changes to save.');
  patch.updated_at = ctx.now().toISOString();
  const updated = await ctx.repo.update('program_events', id, patch);
  await audit(ctx, staff, 'program_event.updated', 'program_event', id, { fields: Object.keys(patch).filter(function (k) { return k !== 'updated_at'; }) });
  return { event: updated };
}

/** Record (or replace, or clear) one count for one event. One value per event and figure. */
export async function setEventCount(ctx, staff, body) {
  if (!isUuid(body.event_id) || !(await ctx.repo.get('program_events', body.event_id))) throw fail({ event_id: 'Choose an event.' });
  if (EVENT_COUNT_METRICS.indexOf(body.metric) === -1) throw fail({ metric: 'Choose a figure.' });
  const existing = (await ctx.repo.list('event_impact_counts', { eq: { event_id: body.event_id, metric: body.metric }, limit: 1 }))[0];
  if (body.remove === true) {
    if (existing) await ctx.repo.remove('event_impact_counts', { eq: { id: existing.id } });
    await audit(ctx, staff, 'impact.count_removed', 'program_event', body.event_id, { metric: body.metric });
    return { removed: true };
  }
  const errors = {};
  const value = Number(body.value);
  if (!Number.isInteger(value) || value < 0 || value > 1000000) errors.value = 'Enter a whole number.';
  const qualifier = body.qualifier || 'exact';
  if (QUALIFIERS.indexOf(qualifier) === -1) errors.qualifier = 'Choose exact, about, estimated, or "or more".';
  const notes = cleanMultiline(body.notes);
  if (notes.length > 1000) errors.notes = 'Notes are too long.';
  if (Object.keys(errors).length) throw fail(errors);
  const nowIso = ctx.now().toISOString();
  const row = { value: value, qualifier: qualifier, notes: notes || null, recorded_by: staff.id, updated_at: nowIso };
  const saved = existing
    ? await ctx.repo.update('event_impact_counts', existing.id, row)
    : await ctx.repo.insert('event_impact_counts', Object.assign({ id: randomUUID(), event_id: body.event_id, metric: body.metric, recorded_at: nowIso }, row));
  await audit(ctx, staff, existing ? 'impact.count_updated' : 'impact.count_recorded', 'program_event', body.event_id, { metric: body.metric, value: value, qualifier: qualifier });
  return { count: saved, replaced: !!existing };
}

/* ---------- Executive summary & export ---------- */

function joinList(parts) {
  if (parts.length <= 1) return parts.join('');
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

function lower(fig) {
  return fig.replace(/^About/, 'about').replace(/^Est\./, 'an estimated');
}

/** Plain-language summary built only from figures that have data. Pure. */
export function executiveSummary(metrics, range) {
  const m = new Map(metrics.map(function (x) { return [x.key, x]; }));
  const has = function (k) { return m.get(k) && m.get(k).has_data && !m.get(k).hidden; };
  const fig = function (k) { const x = m.get(k); return lower(formatFigure(x.value, x.qualifier, x.unit)); };
  const period = range.preset === 'all' ? 'To date' : 'From ' + formatLongDate(range.from) + ' to ' + formatLongDate(range.to);
  const sentences = [];

  const reach = [];
  if (has('children_served')) reach.push(fig('children_served') + ' children');
  if (has('families_served')) reach.push(fig('families_served') + ' families');
  const events = [];
  if (has('events_hosted')) events.push('hosted ' + fig('events_hosted') + ' event' + (m.get('events_hosted').value === 1 ? '' : 's'));
  if (has('events_attended')) events.push('took part in ' + fig('events_attended') + (has('events_hosted') ? ' more' : ' event' + (m.get('events_attended').value === 1 ? '' : 's')));
  if (!events.length && has('events_total')) events.push('held or took part in ' + fig('events_total') + ' events');
  if (events.length || reach.length) {
    sentences.push(period + ', Bottor Learning Foundation ' + (events.length ? joinList(events) : 'reached the community') +
      (reach.length ? ', serving ' + joinList(reach) : '') + '.');
  }
  const given = [];
  if (has('books_distributed')) given.push(fig('books_distributed') + ' books');
  if (has('clothing_distributed')) given.push(fig('clothing_distributed') + ' clothing items');
  if (has('supplies_distributed')) given.push(fig('supplies_distributed') + ' educational supplies');
  if (has('other_items_distributed')) given.push(fig('other_items_distributed') + ' other donated items');
  if (given.length) sentences.push('The foundation distributed ' + joinList(given) + '.');
  const engage = [];
  if (has('game_participants')) engage.push(fig('game_participants') + ' educational game participants');
  if (has('table_interactions')) engage.push(fig('table_interactions') + ' table interactions');
  if (has('activity_plays')) engage.push(fig('activity_plays') + ' tablet activity plays');
  if (engage.length) sentences.push('Engagement at events included ' + joinList(engage) + '. Interactions and plays count engagements, not individual people.');
  if (has('volunteer_hours')) sentences.push('Volunteers contributed ' + fig('volunteer_hours') + ' supervisor-verified hours.');
  const gifts = [];
  if (has('monetary_donations')) gifts.push(m.get('monetary_donations').gift_count + ' monetary gift' + (m.get('monetary_donations').gift_count === 1 ? '' : 's') + ' totaling ' + fig('monetary_donations'));
  if (has('in_kind_donations')) gifts.push(fig('in_kind_donations') + ' in-kind gift' + (m.get('in_kind_donations').value === 1 ? '' : 's') + (m.get('in_kind_donations').items_received ? ' (' + m.get('in_kind_donations').items_received.toLocaleString('en-US') + ' items)' : ''));
  if (gifts.length) sentences.push('The foundation received ' + joinList(gifts) + '.');
  if (!sentences.length) sentences.push('No activity has been recorded for this period yet.');
  return sentences;
}

const QUALIFIER_LABEL = { exact: 'Exact', approximate: 'Approximate', estimated: 'Estimated', minimum: 'Minimum (or more)' };

export async function exportImpactCsv(ctx, staff, query) {
  const report = await impactReport(ctx, staff, query);
  const rows = [['Bottor Learning Foundation — Community Impact Report'], ['Period', report.range.from || 'All time', report.range.to || ''], ['Generated', report.generated_on], [],
    ['Figure', 'Value', 'Count type', 'Includes starting total', 'Source']];
  report.metrics.forEach(function (x) {
    rows.push([x.label, x.hidden ? '(hidden)' : x.value, QUALIFIER_LABEL[x.qualifier], x.baseline ? 'Yes (through ' + x.baseline.as_of + ')' : '', METRIC.get(x.key).source]);
  });
  rows.push([], ['Event', 'Date', 'Our role'].concat(EVENT_COUNT_METRICS.concat(['supplies_distributed']).map(function (k) { return METRIC.get(k).label; })));
  report.events.forEach(function (e) {
    rows.push([e.name, e.event_date, e.participation].concat(EVENT_COUNT_METRICS.concat(['supplies_distributed']).map(function (k) {
      const f = e.figures[k];
      return f ? formatFigure(f.value, f.qualifier, 'count') : '';
    })));
  });
  await audit(ctx, staff, 'impact.exported', 'impact_report', null, { preset: report.range.preset });
  return { csv: toCsv(rows), filename: 'impact-report-' + (report.range.from || 'all-time') + (report.range.to ? '-to-' + report.range.to : '') + '.csv' };
}
