/* ============================================
   BOTTOR LEARNING FOUNDATION — Public impact figures
   Shows the statistics an administrator PUBLISHED in the Foundation
   Management Portal (GET /api/impact). If the request fails, the last
   successfully loaded figures (kept in this browser) are shown; if there
   are none, the figures written into the page stay as they are.
   Also used by the portal to preview a publication before it goes live.
   ============================================ */

(function () {
  var CACHE_KEY = 'blf.publicImpact.v1';
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function longDate(iso) {
    var p = String(iso || '').slice(0, 10).split('-').map(Number);
    return p.length === 3 && p[1] ? MONTHS[p[1] - 1] + ' ' + p[2] + ', ' + p[0] : '';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function statCard(item, estimateStyle) {
    var card = el('div', 'impact-stat' + (estimateStyle ? ' impact-stat-estimate' : ''));
    card.appendChild(el('span', 'impact-stat-value', item.display));
    card.appendChild(el('span', 'impact-stat-label', item.label));
    if (item.detail) card.appendChild(el('span', 'impact-stat-detail', item.detail));
    return card;
  }

  function footnoteText(items) {
    var q = {};
    items.forEach(function (i) { q[i.qualifier] = true; });
    var parts = ['Figures are recorded by Bottor Learning Foundation after each event.'];
    if (q.approximate) parts.push('Totals marked “about” are approximate.');
    if (q.estimated) parts.push('Totals marked “Est.” are estimates.');
    if (q.minimum) parts.push('A “+” means at least that many.');
    return parts.join(' ');
  }

  /** Render published figures into a Community Impact section. Never uses innerHTML with data. */
  function render(section, data) {
    if (!section || !data || !data.published || !data.items || !data.items.length) return false;
    var stats = data.items.filter(function (i) { return i.section !== 'engagement'; });
    var engagement = data.items.filter(function (i) { return i.section === 'engagement'; });

    var asof = section.querySelector('.impact-asof');
    if (asof && data.as_of) {
      asof.textContent = 'Totals as of ';
      var t = el('time', null, longDate(data.as_of));
      t.setAttribute('datetime', data.as_of);
      asof.appendChild(t);
    }

    var grid = section.querySelector('.impact-stats');
    if (grid) {
      grid.textContent = '';
      stats.forEach(function (i) { grid.appendChild(statCard(i, false)); });
      grid.style.display = stats.length ? '' : 'none';
    }

    var box = section.querySelector('.impact-engagement');
    if (box) {
      box.style.display = engagement.length ? '' : 'none';
      var h = box.querySelector('h3');
      if (h && data.engagement_heading) h.textContent = data.engagement_heading;
      var eg = box.querySelector('.impact-engagement-grid');
      if (eg) {
        eg.textContent = '';
        engagement.forEach(function (i) { eg.appendChild(statCard(i, true)); });
      }
    }

    var foot = section.querySelector('.impact-footnote');
    if (foot) foot.textContent = footnoteText(data.items);
    section.setAttribute('data-impact-source', 'published');
    return true;
  }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; }
  }

  function writeCache(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* storage unavailable: fine */ }
  }

  function load() {
    var section = document.getElementById('community-impact');
    if (!section || !window.fetch) return;
    var cached = readCache();
    if (cached && render(section, cached)) section.setAttribute('data-impact-source', 'cached');

    var controller = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, 6000);
    fetch('/api/impact', { headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        clearTimeout(timer);
        if (data && data.published && data.items && data.items.length) {
          render(section, data);
          writeCache(data);
        }
        // Not published yet, or unavailable: keep what's on the page.
      })
      .catch(function () { clearTimeout(timer); });
  }

  window.BLFPublicImpact = { render: render };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
})();
