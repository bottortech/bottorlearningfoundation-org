/* ============================================
   Impact charts — hand-drawn SVG, no libraries (works under the portal's CSP
   and prints cleanly). Colors validated for color-blind separation:
   this year / single series #2B6CB0, last year #DD6B20, goals #38A169.
   Estimated values are hatched AND labeled, so they never rely on color alone.
   ============================================ */

export const COLORS = { primary: '#2B6CB0', previous: '#DD6B20', goal: '#38A169', grid: '#E2E8F0', axis: '#718096', ink: '#2D3748' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let uid = 0;

function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatFigure(value, qualifier, unit) {
  if (value === null || value === undefined) return '—';
  const n = unit === 'usd'
    ? '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : unit === 'usd-short' ? '$' + Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })
    : unit === 'hours' ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })
      : Number(value).toLocaleString('en-US');
  if (qualifier === 'approximate') return 'About ' + n;
  if (qualifier === 'estimated') return 'Est. ' + n;
  if (qualifier === 'minimum') return n + '+';
  return n;
}

export const QUALIFIER_LABEL = { exact: 'Exact count', approximate: 'Approximate', estimated: 'Estimated', minimum: 'Minimum (or more)' };

// Axis scale with at most 5 steps of 1, 2, or 5 × a power of ten, so ticks are
// always whole, readable numbers (never 6.25 books).
function niceScale(v) {
  if (!(v > 0)) return { top: 1, ticks: 1 };
  let pow = Math.pow(10, Math.floor(Math.log10(v / 5)));
  if (pow < 1) pow = 1;
  for (const m of [1, 2, 5, 10, 20, 50]) {
    const step = m * pow;
    const n = Math.ceil(v / step);
    if (n <= 5) return { top: n * step, ticks: Math.max(n, 1) };
  }
  return { top: v, ticks: 1 };
}

// Bar with a 4px rounded top, anchored square to the baseline.
function barPath(x, y, w, h) {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return 'M' + x + ',' + (y + h) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r) +
    'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + h) + 'Z';
}

function hatchDef(id, color) {
  return '<pattern id="' + id + '" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
    '<rect width="6" height="6" fill="' + color + '" fill-opacity="0.35"/><line x1="0" y1="0" x2="0" y2="6" stroke="' + color + '" stroke-width="3"/></pattern>';
}

/**
 * Monthly column chart for ONE metric (single series: no legend; the title names it).
 * months: [{ month: 'YYYY-MM', value, qualifier, has_data }]
 */
export function columnChart(months, opts) {
  const o = opts || {};
  const W = 640, H = 240, padL = 44, padR = 12, padT = 18, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const scale = niceScale(Math.max.apply(null, months.map((m) => m.value || 0)));
  const max = scale.top;
  const slot = plotW / Math.max(months.length, 1);
  const barW = Math.max(4, Math.min(36, slot - 2 * Math.max(2, slot * 0.18)));
  const id = 'hatch' + (++uid);
  const peak = months.reduce((best, m, i) => (m.value > (best.v || 0) ? { i, v: m.value } : best), {});
  const anyEst = months.some((m) => m.qualifier !== 'exact' && m.has_data);
  let svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.label || 'Monthly chart') + '" preserveAspectRatio="xMidYMid meet">' +
    '<defs>' + hatchDef(id, COLORS.primary) + '</defs>';
  for (let i = 0; i <= scale.ticks; i++) {
    const v = max * i / scale.ticks;
    const y = padT + plotH - plotH * i / scale.ticks;
    svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y + '" y2="' + y + '" stroke="' + (i === 0 ? COLORS.axis : COLORS.grid) + '" stroke-width="1"/>' +
      '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" class="chart-tick">' + esc(formatFigure(v, 'exact', o.unit === 'usd' ? 'usd-short' : o.unit)) + '</text>';
  }
  months.forEach((m, i) => {
    const h = plotH * (m.value || 0) / max;
    const x = padL + slot * i + (slot - barW) / 2;
    const y = padT + plotH - h;
    const est = m.has_data && m.qualifier !== 'exact';
    const label = m.month + ': ' + formatFigure(m.value, m.qualifier, o.unit) + (est ? ' (' + QUALIFIER_LABEL[m.qualifier].toLowerCase() + ')' : '');
    const [yy, mm] = m.month.split('-');
    svg += '<g class="chart-bar"><title>' + esc(label) + '</title>' +
      '<rect x="' + (padL + slot * i) + '" y="' + padT + '" width="' + slot + '" height="' + plotH + '" fill="transparent"/>' +
      (h > 0 ? '<path d="' + barPath(x, y, barW, h) + '" fill="' + (est ? 'url(#' + id + ')' : COLORS.primary) + '"' + (est ? ' stroke="' + COLORS.primary + '" stroke-width="1"' : '') + '/>' : '') +
      '<text x="' + (padL + slot * i + slot / 2) + '" y="' + (H - padB + 16) + '" text-anchor="middle" class="chart-tick">' + MONTHS[Number(mm) - 1] +
      (mm === '01' || i === 0 ? '</text><text x="' + (padL + slot * i + slot / 2) + '" y="' + (H - padB + 29) + '" text-anchor="middle" class="chart-tick">' + yy : '') + '</text>' +
      (peak.i === i && m.value > 0 ? '<text x="' + (x + barW / 2) + '" y="' + (y - 5) + '" text-anchor="middle" class="chart-value">' + esc(formatFigure(m.value, m.qualifier, o.unit)) + '</text>' : '') +
      '</g>';
  });
  svg += '</svg>';
  return '<figure class="chart-figure">' + svg +
    (anyEst ? '<figcaption class="chart-note"><span class="hatch-swatch" aria-hidden="true"></span>Hatched months include estimated or approximate counts.</figcaption>' : '') +
    '</figure>';
}

/** Data table for a monthly series (the accessible view of the chart). */
export function monthTable(months, unit) {
  return '<table class="data-table chart-table"><thead><tr><th>Month</th><th>Value</th></tr></thead><tbody>' +
    months.map((m) => '<tr><td>' + esc(m.month) + '</td><td>' + esc(formatFigure(m.value, m.qualifier, unit)) + '</td></tr>').join('') + '</tbody></table>';
}

/**
 * Year-over-year table: each metric has its own scale (different units never
 * share an axis), with a mini paired bar, both values, and the change.
 */
export function yoyTable(yoy) {
  const rows = yoy.rows.filter((r) => !r.hidden && (r.previous.has_data || r.current.has_data));
  if (!rows.length) return '<p class="muted-text">No figures recorded for ' + (yoy.year - 1) + ' or ' + yoy.year + ' yet.</p>';
  const id = 'yoy' + (++uid);
  const bar = (v, max, which, est) => '<span class="yoy-bar yoy-' + which + (est ? ' yoy-est' : '') + '" data-w="' + (max && v ? Math.max(2, v / max * 100) : 0) + '"></span>';
  return '<div class="yoy-legend"><span><span class="yoy-key yoy-previous"></span>' + (yoy.year - 1) + '</span>' +
    '<span><span class="yoy-key yoy-current"></span>' + yoy.year + '</span>' +
    '<span><span class="hatch-swatch" aria-hidden="true"></span>Hatched = includes estimates</span></div>' +
    '<table class="data-table yoy-table" id="' + id + '"><thead><tr><th>Figure</th><th>' + (yoy.year - 1) + '</th><th>' + yoy.year + '</th><th>Change</th><th class="yoy-bars-head"><span class="sr-only">Comparison</span></th></tr></thead><tbody>' +
    rows.map((r) => {
      const max = Math.max(r.previous.value || 0, r.current.value || 0);
      const change = r.change_pct === null ? '—' : (r.change_pct > 0 ? '+' : '') + r.change_pct + '%';
      return '<tr><td>' + esc(r.label) + '</td>' +
        '<td class="nowrap">' + (r.previous.has_data ? esc(formatFigure(r.previous.value, r.previous.qualifier, r.unit)) : '—') + '</td>' +
        '<td class="nowrap"><strong>' + (r.current.has_data ? esc(formatFigure(r.current.value, r.current.qualifier, r.unit)) : '—') + '</strong></td>' +
        '<td class="nowrap">' + esc(change) + '</td>' +
        '<td class="yoy-bars">' + bar(r.previous.value || 0, max, 'previous', r.previous.has_data && r.previous.qualifier !== 'exact') +
        bar(r.current.value || 0, max, 'current', r.current.has_data && r.current.qualifier !== 'exact') + '</td></tr>';
    }).join('') + '</tbody></table>';
}

export function goalBars(goals) {
  if (!goals.length) return '';
  return '<ul class="goal-list">' + goals.map((g) => '<li><div class="goal-head"><span>' + esc(g.label) + '</span><span class="goal-fig">' +
    (g.hidden ? 'Hidden' : esc(formatFigure(g.value, g.qualifier, g.unit)) + ' of ' + esc(formatFigure(g.target, 'exact', g.unit)) + ' · ' + g.percent + '%') + '</span></div>' +
    (g.hidden ? '' : '<div class="goal-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + g.percent + '" aria-label="' + esc(g.label) + '"><span class="goal-fill' +
      (g.qualifier !== 'exact' ? ' goal-est' : '') + '" data-w="' + g.percent + '"></span></div>') + '</li>').join('') + '</ul>';
}

/**
 * Apply bar widths after the HTML is in the page. The portal's security policy
 * blocks inline style attributes, but setting styles from script is allowed.
 */
export function applyChartWidths(root) {
  (root || document).querySelectorAll('[data-w]').forEach(function (el) {
    el.style.width = Math.max(0, Math.min(100, Number(el.dataset.w) || 0)) + '%';
  });
}
