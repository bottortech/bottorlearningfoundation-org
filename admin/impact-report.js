/* Printable community impact report (period or single event). All figures
   come from /api/admin/impact-*; estimates keep their labels in print. */
import { applyChartWidths, columnChart, formatFigure, goalBars, yoyTable, QUALIFIER_LABEL } from '/admin/charts.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const PARTICIPATION = { hosted: 'Hosted', exhibited: 'Exhibited', attended: 'Attended', partnered: 'Partnered' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CHART_METRICS = ['children_served', 'books_distributed', 'volunteer_hours'];
let money = [];

function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function longDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return MONTHS[m - 1] + ' ' + d + ', ' + y;
}

async function get(path) {
  try {
    const res = await fetch('/api/admin/' + path, { credentials: 'same-origin' });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'Could not reach the server.' } };
  }
}

function fail(res) {
  const box = $('report-state');
  box.className = 'state-box state-error';
  box.textContent = res.status === 401 ? 'Please sign in to the portal first, then reopen this report.' : (res.data.error || 'Could not build this report.');
}

function tile(label, value, qualifier, unit, meta, isMoney) {
  return '<div class="report-tile' + (isMoney ? ' money-figure' : '') + '"><span class="report-tile-value">' + esc(formatFigure(value, qualifier, unit)) + '</span>' +
    '<span class="report-tile-label">' + esc(label) + '</span>' +
    (qualifier !== 'exact' ? '<span class="report-tile-q">' + esc(QUALIFIER_LABEL[qualifier]) + '</span>' : '') +
    (meta ? '<span class="report-tile-meta">' + esc(meta) + '</span>' : '') + '</div>';
}

function notes(extra) {
  $('notes').innerHTML = [
    'Figures come from Bottor Learning Foundation’s records: inventory distributions, supervisor-approved volunteer hours, donation records, and counts recorded at each event.',
    'Count types: exact counts are shown as plain numbers; “About” marks approximate totals, “Est.” marks estimates, and “+” marks minimums (for example, 200+). A total that includes any estimate is labeled as estimated.',
    'Table interactions and tablet activity plays count engagements, not individual people or children served.',
    'Books, clothing, and supplies distributed are counted from inventory when items were linked to an event; a recorded event count is used only where no inventory was linked, so nothing is counted twice.'
  ].concat(extra || []).map((n) => '<li>' + esc(n) + '</li>').join('');
}

async function periodReport() {
  const q = new URLSearchParams();
  ['preset', 'year', 'from', 'to'].forEach((k) => { if (params.get(k)) q.set(k, params.get(k)); });
  const rep = await get('impact-report?' + q);
  if (!rep.ok) return fail(rep);
  const r = rep.data;
  const range = r.range;

  $('title').textContent = range.preset === 'year' ? range.year + ' Community Impact Report' : 'Community Impact Report';
  $('period').textContent = (range.from ? longDate(range.from) + ' – ' + longDate(range.to) : 'All recorded activity through ' + longDate(r.generated_on)) +
    ' · Prepared ' + longDate(r.generated_on);
  $('summary').innerHTML = r.summary.map((s) => '<p>' + esc(s) + '</p>').join('');

  const shown = r.metrics.filter((m) => m.has_data && !m.hidden);
  $('tiles').innerHTML = shown.map((m) => tile(m.label, m.value, m.qualifier, m.unit,
    m.key === 'monetary_donations' ? m.gift_count + ' gift' + (m.gift_count === 1 ? '' : 's') :
      m.key === 'in_kind_donations' ? (m.items_received || 0) + ' items received' : m.engagement ? 'Engagements, not people' : '',
    m.key === 'monetary_donations')).join('') || '<p>No figures recorded for this period.</p>';
  money = shown.filter((m) => m.key === 'monetary_donations');

  if (r.goals.length) { $('goals').innerHTML = goalBars(r.goals); $('goals-section').hidden = false; }

  // Monthly charts for a year or custom range (dated records only).
  if (range.from) {
    const charts = await Promise.all(CHART_METRICS.map((k) => get('impact-trend?metric=' + k + '&from=' + range.from + '&to=' + (range.to < r.generated_on ? range.to : r.generated_on))));
    const html = charts.filter((c) => c.ok && c.data.months.some((m) => m.has_data)).map((c) =>
      '<div class="report-chart"><h3>' + esc(c.data.metric.label) + '</h3>' + columnChart(c.data.months, { unit: c.data.metric.unit, label: c.data.metric.label + ' by month' }) + '</div>').join('');
    if (html) { $('charts').innerHTML = html; $('charts-section').hidden = false; }
  }

  if (range.preset === 'year') {
    const yoy = await get('impact-yoy?year=' + range.year);
    if (yoy.ok && yoy.data.rows.some((x) => x.previous.has_data || x.current.has_data)) { $('yoy').innerHTML = yoyTable(yoy.data); $('yoy-section').hidden = false; }
  }

  if (r.events.length) {
    const f = (e, k) => e.figures[k] ? formatFigure(e.figures[k].value, e.figures[k].qualifier, 'count') : '—';
    $('events').innerHTML = '<table class="letter-summary report-table"><thead><tr><th>Date</th><th>Event</th><th>Role</th><th>Children</th><th>Families</th><th>Books</th><th>Clothing</th></tr></thead><tbody>' +
      r.events.map((e) => '<tr><td>' + esc(longDate(e.event_date)) + '</td><td>' + esc(e.name) + '</td><td>' + esc(PARTICIPATION[e.participation]) + '</td><td>' + esc(f(e, 'children_served')) +
        '</td><td>' + esc(f(e, 'families_served')) + '</td><td>' + esc(f(e, 'books_distributed')) + '</td><td>' + esc(f(e, 'clothing_distributed')) + '</td></tr>').join('') + '</tbody></table>';
    $('events-section').hidden = false;
  }

  const extra = [];
  const base = r.metrics.filter((m) => m.baseline);
  if (base.length) extra.push('Includes starting totals recorded before the portal for: ' + base.map((m) => m.label.toLowerCase() + ' (through ' + longDate(m.baseline.as_of) + ')').join('; ') + '. Entries dated inside those spans are not added again.');
  const skipped = r.metrics.filter((m) => m.baseline_skipped);
  if (skipped.length) extra.push('Starting totals for ' + skipped.map((m) => m.label.toLowerCase()).join(', ') + ' are not included because this period covers only part of the span they record and they cannot be split by date.');
  extra.push('Monthly charts show dated records only; starting totals are not split by month.');
  notes(extra);
  $('foot').textContent = 'Bottor Learning Foundation is a 501(c)(3) nonprofit organization · EIN 41-3321544';
  done(($('title').textContent));
}

async function eventReport(id) {
  const res = await get('impact-events?id=' + encodeURIComponent(id));
  if (!res.ok) return fail(res);
  const { event: e, summary, distributions, count_metrics: metrics } = res.data;
  $('title').textContent = e.name + ' — Event Impact Report';
  $('period').textContent = longDate(e.event_date) + ' · ' + PARTICIPATION[e.participation] + (e.location ? ' · ' + e.location : '');
  const labels = new Map(metrics.map((m) => [m.key, m]));
  labels.set('supplies_distributed', { label: 'Educational supplies distributed' });
  const figs = Object.entries(summary.figures);
  $('summary').innerHTML = '<p>' + esc(figs.length
    ? 'At ' + e.name + ' on ' + longDate(e.event_date) + ', Bottor Learning Foundation ' + ({ hosted: 'hosted the event', exhibited: 'exhibited', attended: 'attended', partnered: 'took part as a partner' })[e.participation] + ' and recorded the figures below.'
    : 'No figures have been recorded for this event yet.') + '</p>';
  $('tiles').innerHTML = figs.map(([k, v]) => tile((labels.get(k) || { label: k }).label, v.value, v.qualifier, 'count', (labels.get(k) || {}).engagement ? 'Engagements, not people' : '')).join('');
  if (distributions.length) {
    $('events-title').textContent = 'Items distributed (from inventory)';
    $('events').innerHTML = '<ul>' + distributions.map((d) => '<li>' + esc(d.quantity) + ' ' + esc(d.category.toLowerCase()) + '</li>').join('') + '</ul>';
    $('events-section').hidden = false;
  }
  notes(e.notes ? ['Event notes: ' + e.notes] : []);
  $('foot').textContent = 'Bottor Learning Foundation is a 501(c)(3) nonprofit organization · EIN 41-3321544';
  done(e.name + ' Impact Report');
}

function done(title) {
  applyChartWidths(document);
  $('report-state').hidden = true;
  $('toolbar').hidden = false;
  $('report').hidden = false;
  document.title = title + ' — Bottor Learning Foundation';
  $('hide-money').parentElement.hidden = !money.length;
}

$('print-btn').addEventListener('click', () => window.print());
$('hide-money').addEventListener('change', (ev) => {
  // For audiences that shouldn't see gift totals (e.g. a public handout):
  // hide the donation-amount tile, its year-over-year row, and summary sentences with dollar figures.
  document.querySelectorAll('.yoy-table tbody tr').forEach((tr) => {
    if (/^Monetary donations/.test(tr.cells[0].textContent)) tr.classList.add('money-figure');
  });
  document.querySelectorAll('#summary p').forEach((p) => { if (/\$\d/.test(p.textContent)) p.classList.add('money-figure'); });
  document.body.classList.toggle('hide-money', ev.target.checked);
});

if (params.get('event')) eventReport(params.get('event')); else periodReport();
