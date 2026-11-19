import { randomUUID } from 'node:crypto';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { formatFigure, impactReport } from './impact.js';
import { cleanText, containsSsn, todayInOrgTimeZone } from '../../../js/volunteer-core.js';

// Public impact statistics. The website reads ONLY the latest published
// snapshot. Values always come from the records (the same all-time
// calculation as the reports, so starting totals are never double counted);
// administrators choose which statistics appear and may edit their wording,
// never their numbers. Donation figures can never be published.

export const PUBLIC_METRICS = {
  children_served: 'stats',
  families_served: 'stats',
  attendance: 'stats',
  game_participants: 'stats',
  books_distributed: 'stats',
  clothing_distributed: 'stats',
  supplies_distributed: 'stats',
  other_items_distributed: 'stats',
  events_total: 'stats',
  events_hosted: 'stats',
  events_attended: 'stats',
  volunteer_hours: 'stats',
  table_interactions: 'engagement',
  activity_plays: 'engagement'
};

const DEFAULT_LABELS = {
  events_total: 'Community events held',
  clothing_distributed: 'Clothing items donated',
  table_interactions: 'Estimated table interactions',
  activity_plays: 'Estimated tablet activity plays'
};
const DEFAULT_ENGAGEMENT_HEADING = 'Candyland & Career Day engagement';
const EMAIL_OR_PHONE = /[^\s@]+@[^\s@]+\.[a-z]{2,}|\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/i;

function fail(message, errors) {
  return new HttpError(422, message, errors ? { errors: errors } : undefined);
}

async function currentPublication(ctx) {
  return (await ctx.repo.list('impact_publications', { eq: { status: 'published' }, limit: 1 }))[0] || null;
}

// All-time figures for publishable metrics, computed from the records.
async function currentFigures(ctx, staff) {
  const report = await impactReport(ctx, staff, { preset: 'all' });
  const out = {};
  report.metrics.forEach(function (m) {
    if (!PUBLIC_METRICS[m.key]) return;
    out[m.key] = {
      key: m.key, label: m.label, value: m.value, qualifier: m.qualifier, unit: m.unit, has_data: m.has_data,
      display: formatFigure(m.value, m.qualifier, m.unit), includes_starting_total: !!m.baseline
    };
  });
  return out;
}

/** Only these fields ever reach the public website. */
export function publicView(publication) {
  if (!publication) return { published: false, items: [] };
  const f = publication.figures || {};
  return {
    published: true,
    as_of: publication.as_of,
    engagement_heading: f.engagement_heading || null,
    items: (f.items || []).map(function (i) {
      return { key: i.key, label: i.label, display: i.display, qualifier: i.qualifier, detail: i.detail || null, section: PUBLIC_METRICS[i.key] || 'stats' };
    })
  };
}

export async function publicationOverview(ctx, staff) {
  const [pub, figures, history, staffRows] = await Promise.all([
    currentPublication(ctx),
    currentFigures(ctx, staff),
    ctx.repo.list('impact_publications', { order: ['approved_at', 'desc'], limit: 50 }),
    ctx.repo.list('staff_users', {})
  ]);
  const names = new Map(staffRows.map(function (s) { return [s.id, s.full_name]; }));
  const published = pub ? (pub.figures.items || []) : [];
  const publishedKeys = new Set(published.map(function (i) { return i.key; }));
  return {
    published: pub ? { id: pub.id, as_of: pub.as_of, approved_at: pub.approved_at, approved_by: names.get(pub.approved_by) || '', engagement_heading: pub.figures.engagement_heading || DEFAULT_ENGAGEMENT_HEADING } : null,
    items: published.map(function (i) {
      const now = figures[i.key];
      return Object.assign({}, i, {
        current_display: now ? now.display : null,
        current_qualifier: now ? now.qualifier : null,
        changed: !!now && (now.value !== i.value || now.qualifier !== i.qualifier)
      });
    }),
    available: Object.values(figures).filter(function (f) { return !publishedKeys.has(f.key); }).map(function (f) {
      return Object.assign({}, f, { suggested_label: DEFAULT_LABELS[f.key] || f.label, section: PUBLIC_METRICS[f.key] });
    }),
    history: history.slice().sort(function (a, b) {
      if (a.approved_at !== b.approved_at) return a.approved_at < b.approved_at ? 1 : -1;
      return (a.status === 'published' ? 0 : 1) - (b.status === 'published' ? 0 : 1);
    }).map(function (h) {
      return {
        id: h.id, status: h.status, as_of: h.as_of, approved_at: h.approved_at, approved_by: names.get(h.approved_by) || '',
        items: (h.figures.items || []).map(function (i) { return { label: i.label, display: i.display }; }), note: h.figures.note || null
      };
    }),
    can_publish: false
  };
}

/**
 * Build (and, unless preview, publish) a new snapshot.
 * items: [{ key, label, detail, refresh }] in display order. refresh=true takes
 * the current value from the records; otherwise the previously published value
 * is kept, so updating one statistic never silently changes the others.
 */
export async function publishImpact(ctx, staff, body) {
  const requested = Array.isArray(body.items) ? body.items : [];
  if (!requested.length) throw fail('Choose at least one statistic to show on the website.');
  if (requested.length > 16) throw fail('That’s too many statistics for the website section.');
  const pub = await currentPublication(ctx);
  const prior = new Map(((pub && pub.figures.items) || []).map(function (i) { return [i.key, i]; }));
  const figures = await currentFigures(ctx, staff);
  const seen = new Set();
  const errors = {};

  const items = requested.map(function (r, idx) {
    if (!PUBLIC_METRICS[r.key]) { errors['items.' + idx] = 'That statistic can’t be shown publicly.'; return null; }
    if (seen.has(r.key)) { errors['items.' + idx] = 'Each statistic can appear only once.'; return null; }
    seen.add(r.key);
    const label = cleanText(r.label);
    const detail = cleanText(r.detail);
    if (!label || label.length > 80) errors['items.' + idx] = 'Give “' + r.key + '” a label of up to 80 characters.';
    else if (detail.length > 200) errors['items.' + idx] = 'Keep each description under 200 characters.';
    else if (EMAIL_OR_PHONE.test(label + ' ' + detail) || containsSsn(label + ' ' + detail)) {
      errors['items.' + idx] = 'Public text can’t include email addresses, phone numbers, or ID numbers.';
    }
    const source = r.refresh === true || !prior.has(r.key) ? figures[r.key] : prior.get(r.key);
    if (!source || (source === figures[r.key] && !source.has_data)) {
      errors['items.' + idx] = 'There are no records yet for “' + label + '”.';
      return null;
    }
    return {
      key: r.key, label: label, detail: detail || null, value: source.value, qualifier: source.qualifier, unit: source.unit,
      display: source.display, refreshed_at: source === figures[r.key] ? todayInOrgTimeZone(ctx.now()) : source.refreshed_at || pub.as_of
    };
  });
  if (Object.keys(errors).length) throw fail('Please correct the highlighted statistics.', errors);

  const heading = cleanText(body.engagement_heading) || (pub && pub.figures.engagement_heading) || DEFAULT_ENGAGEMENT_HEADING;
  if (heading.length > 80) throw fail('Keep the engagement heading under 80 characters.');
  const snapshot = { items: items, engagement_heading: heading, note: cleanText(body.note).slice(0, 300) || null, computed_at: ctx.now().toISOString() };
  const asOf = todayInOrgTimeZone(ctx.now());
  const preview = { as_of: asOf, figures: snapshot };
  if (body.preview === true) return { preview: publicView(preview) };

  if (body.confirm !== true) throw fail('Confirm that you have reviewed the preview before publishing.');
  if (pub) await ctx.repo.update('impact_publications', pub.id, { status: 'superseded' });
  let row;
  try {
    row = await ctx.repo.insert('impact_publications', {
      id: randomUUID(), figures: snapshot, as_of: asOf, status: 'published', approved_by: staff.id, approved_at: ctx.now().toISOString()
    });
  } catch (err) {
    if (pub) await ctx.repo.update('impact_publications', pub.id, { status: 'published' }).catch(function () {});
    throw err;
  }
  await audit(ctx, staff, 'impact.published', 'impact_publication', row.id, {
    statistics: items.map(function (i) { return i.key; }), refreshed: requested.filter(function (r) { return r.refresh === true; }).map(function (r) { return r.key; })
  });
  return { published: publicView(row) };
}

/** Public, unauthenticated read of the latest published snapshot. */
export async function readPublicImpact(ctx) {
  return publicView(await currentPublication(ctx));
}
