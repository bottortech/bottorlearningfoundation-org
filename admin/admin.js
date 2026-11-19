/* ============================================
   BOTTOR LEARNING FOUNDATION — Foundation Management Portal
   All data comes from the authenticated /api/admin endpoints;
   this page itself contains no volunteer, donor, or inventory records.
   ============================================ */
import {
  INTEREST_OPTIONS, AVAILABILITY_OPTIONS, COURT_REPORTED_STATUS_OPTIONS,
  calculateNetMinutes, formatHours, todayInOrgTimeZone
} from '/js/volunteer-core.js';
import {
  applyChartWidths, columnChart, formatFigure as chartFigure, goalBars, monthTable, yoyTable
} from '/admin/charts.js';

const state = { staff: null, permissions: new Set() };
const main = document.getElementById('main');

/* ---------- Labels ---------- */

const LABELS = {
  status: { pending: 'Pending review', approved: 'Approved', declined: 'Declined', inactive: 'Inactive', withdrawn: 'Withdrawn' },
  hour: { pending: 'Awaiting verification', approved: 'Verified', rejected: 'Rejected', voided: 'Voided' },
  letter: { draft: 'Draft — not issued', approved: 'Approved', void: 'Void' },
  screening: { not_started: 'Not started', in_progress: 'In progress', cleared: 'Cleared', not_cleared: 'Not cleared' },
  background: { not_required: 'Not required for role', not_started: 'Not started', pending: 'Pending', cleared: 'Cleared', not_cleared: 'Not cleared', expired: 'Expired' },
  court: { not_recorded: 'Not recorded', pending: 'Pending', approved: 'Approved', denied: 'Denied' },
  role: { admin: 'Administrator', coordinator: 'Coordinator', supervisor: 'Supervisor' }
};
const optionLabel = (opts, v) => (opts.find((o) => o.value === v) || {}).label || v;

const TONE = {
  pending: 'warn', approved: 'ok', declined: 'muted', inactive: 'muted', withdrawn: 'muted',
  rejected: 'bad', voided: 'muted', draft: 'warn', void: 'muted', cleared: 'ok', not_cleared: 'bad',
  expired: 'bad', not_started: 'muted', in_progress: 'warn', not_required: 'muted', not_recorded: 'muted', denied: 'bad'
};

/* ---------- Helpers ---------- */

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function badge(group, value) {
  const text = (LABELS[group] && LABELS[group][value]) || value;
  return '<span class="badge badge-' + (TONE[value] || 'muted') + '">' + esc(text) + '</span>';
}

function canDo(permission) {
  return state.permissions.has(permission);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' });
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM');
}

const fullName = (v) => (v.first_name || '') + ' ' + (v.last_name || '');

async function api(path, options) {
  const opts = options || {};
  let res;
  try {
    res = await fetch('/api/' + path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'Could not reach the server. Check your connection and try again.' } };
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !opts.allow401) {
    showLogin('Your session has ended. Please sign in again.');
  }
  return { ok: res.ok, status: res.status, data: data };
}

function toast(message, tone) {
  const region = document.getElementById('toast-region');
  const el = document.createElement('div');
  el.className = 'toast toast-' + (tone || 'ok');
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function loading(label) {
  main.innerHTML = '<div class="state-box" role="status"><span class="spinner" aria-hidden="true"></span> ' + esc(label || 'Loading…') + '</div>';
}

function errorState(message, retry) {
  main.innerHTML = '<div class="state-box state-error" role="alert"><p><strong>Something went wrong.</strong> ' + esc(message) +
    '</p><button type="button" class="btn btn-secondary btn-sm" id="retry-btn">Try again</button></div>';
  document.getElementById('retry-btn').addEventListener('click', retry);
}

function emptyState(message) {
  return '<div class="empty-state"><p>' + esc(message) + '</p></div>';
}

function progressBar(summary) {
  if (!summary || !summary.targetMinutes) {
    return '<span class="muted-text">' + formatHours(summary ? summary.verifiedMinutes : 0) + ' verified hrs</span>';
  }
  return '<div class="progress-wrap"><progress max="' + summary.targetMinutes + '" value="' + summary.verifiedMinutes + '" aria-label="Verified hours progress"></progress>' +
    '<span>' + formatHours(summary.verifiedMinutes) + ' / ' + formatHours(summary.targetMinutes) + ' hrs</span></div>';
}

function selectOptions(map, selected) {
  return Object.entries(map).map(([value, label]) =>
    '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(label) + '</option>').join('');
}

/* ---------- Modal ---------- */

const modal = document.getElementById('modal');
let modalHandler = null;

function openModal(config) {
  document.getElementById('modal-title').textContent = config.title;
  document.getElementById('modal-body').innerHTML = config.body;
  document.getElementById('modal-error').hidden = true;
  const submit = document.getElementById('modal-submit');
  submit.textContent = config.submitLabel || 'Save';
  submit.className = 'btn btn-sm ' + (config.danger ? 'btn-danger' : 'btn-primary');
  submit.hidden = !config.onSubmit;
  modalHandler = config.onSubmit || null;
  modal.showModal();
  if (config.onOpen) config.onOpen(document.getElementById('modal-body'));
  const first = modal.querySelector('.modal-body input, .modal-body select, .modal-body textarea');
  if (first) first.focus();
}

function closeModal() {
  modalHandler = null;
  modal.close();
}

function modalError(message, errors) {
  const box = document.getElementById('modal-error');
  const details = errors ? Object.values(errors) : [];
  box.innerHTML = '<p><strong>' + esc(message) + '</strong></p>' +
    (details.length ? '<ul>' + details.map((d) => '<li>' + esc(d) + '</li>').join('') + '</ul>' : '');
  box.hidden = false;
}

document.getElementById('modal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!modalHandler) return closeModal();
  const submit = document.getElementById('modal-submit');
  submit.disabled = true;
  const original = submit.textContent;
  submit.textContent = 'Saving…';
  try {
    const data = Object.fromEntries(new FormData(e.target));
    e.target.querySelectorAll('input[type="checkbox"]').forEach((cb) => { data[cb.name] = cb.checked; });
    const result = await modalHandler(data);
    if (result && result.ok === false) {
      modalError(result.data.error || 'Could not save.', result.data.errors || (result.data.reasons ? Object.assign({}, result.data.reasons) : null));
    } else {
      closeModal();
    }
  } finally {
    submit.disabled = false;
    submit.textContent = original;
  }
});
modal.addEventListener('close', () => modal.classList.remove('modal-wide'));
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);

/* ---------- Auth ---------- */

function showLogin(message) {
  document.getElementById('boot').hidden = true;
  document.getElementById('app-view').hidden = true;
  document.getElementById('login-view').hidden = false;
  const err = document.getElementById('login-error');
  err.hidden = !message;
  err.textContent = message || '';
  document.getElementById('login-email').focus();
}

function startApp(session) {
  state.staff = session.staff;
  state.permissions = new Set(session.permissions);
  document.getElementById('boot').hidden = true;
  document.getElementById('login-view').hidden = true;
  document.getElementById('app-view').hidden = false;
  document.getElementById('user-name').textContent = session.staff.full_name;
  document.getElementById('user-role').textContent = LABELS.role[session.staff.role] || session.staff.role;
  document.querySelectorAll('.admin-nav a[data-perm]').forEach((a) => { a.hidden = !canDo(a.dataset.perm); });
  route();
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) {
    err.textContent = 'Enter your email and password.';
    err.hidden = false;
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  const res = await api('auth/login', { method: 'POST', body: { email, password }, allow401: true });
  btn.disabled = false;
  btn.textContent = 'Sign In';
  if (res.ok) {
    document.getElementById('login-password').value = '';
    startApp(res.data);
  } else {
    err.textContent = res.data.error || 'Sign-in failed.';
    err.hidden = false;
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('auth/logout', { method: 'POST', body: {} });
  state.staff = null;
  showLogin('You have been signed out.');
});

/* ---------- Router ---------- */

const VIEWS = {
  overview: viewOverview,
  applications: viewApplications,
  volunteers: viewVolunteers,
  volunteer: viewVolunteer,
  assignments: viewAssignments,
  hours: viewHours,
  letters: viewLetters,
  retention: viewRetention,
  audit: viewAudit,
  team: viewTeam,
  donations: viewDonations,
  donation: viewDonation,
  donors: viewDonors,
  inventory: viewInventory,
  acknowledgments: viewAcknowledgments,
  impact: viewImpact,
  'impact-event': viewImpactEvent,
  'public-impact': viewPublicImpact
};

function route() {
  if (!state.staff) return;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const name = VIEWS[parts[0]] ? parts[0] : 'overview';
  document.querySelectorAll('.admin-nav a').forEach((a) => {
    const active = a.dataset.view === name || (name === 'volunteer' && a.dataset.view === 'volunteers') ||
      ((name === 'donation' || name === 'donors') && a.dataset.view === 'donations') ||
      ((name === 'impact-event' || name === 'public-impact') && a.dataset.view === 'impact');
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  VIEWS[name](parts[1]);
  main.focus({ preventScroll: true });
}
window.addEventListener('hashchange', route);

/* ---------- Overview ---------- */

function foundationOverview(f) {
  const impactBlock = f.impact ? '<h2 class="overview-subhead">Community impact, ' + esc(f.impact_year) + '</h2><div class="stat-grid">' +
    f.impact.map((m) => '<a class="stat-card stat-blue" href="#/impact"><span class="stat-value">' + (m.has_data ? esc(chartFigure(m.value, m.qualifier, m.unit)) : '—') +
      '</span><span class="stat-label">' + esc(m.label) + '</span></a>').join('') + '</div>' : '';
  if (f.donations_this_year === undefined && f.inventory_on_hand === undefined && !f.acknowledgments) return impactBlock;
  const card = (label, value, href, tone) => value === undefined ? '' :
    '<a class="stat-card stat-' + tone + '" href="' + href + '"><span class="stat-value">' + esc(value) + '</span><span class="stat-label">' + esc(label) + '</span></a>';
  return impactBlock + '<h2 class="overview-subhead">Donations &amp; inventory</h2><div class="stat-grid">' +
    card('Donations this year', f.donations_this_year, '#/donations', 'green') +
    card('Money received this year', f.monetary_this_year === undefined ? undefined : fmtMoney(f.monetary_this_year), '#/donations', 'green') +
    card('Items donated this year', f.in_kind_items_this_year, '#/donations', 'orange') +
    card('Items on hand', f.inventory_on_hand, '#/inventory', 'blue') +
    card('Items distributed (all time)', f.items_distributed, '#/inventory', 'gray') +
    (f.acknowledgments ? card('Donations needing a thank-you', f.acknowledgments.not_started, '#/acknowledgments', 'orange') +
      card('Thank-you letters ready to send', f.acknowledgments.ready_to_send, '#/acknowledgments', 'blue') : '') +
    '</div>' + (f.acknowledgments && f.acknowledgments.recent_pending.length ? '<section class="panel"><h2>Pending thank-you letters</h2><ul class="attention-list">' +
      f.acknowledgments.recent_pending.map((p) => '<li><a href="#/donation/' + esc(p.donation_id) + '">' + fmtDate(p.received_on) + '</a><span>' +
        esc(p.donor_name || 'No donor record') + ' · ' + (p.donation_type === 'monetary' ? 'money' : 'items') + '</span></li>').join('') +
      '</ul>' + (f.acknowledgments.drafts ? '<p class="field-hint">' + f.acknowledgments.drafts + ' draft letter' + (f.acknowledgments.drafts === 1 ? '' : 's') + ' waiting to be finalized.</p>' : '') + '</section>' : '') + (f.recent_donations ? '<section class="panel"><h2>Recent donations</h2>' + (f.recent_donations.length
      ? '<ul class="attention-list recent-list">' + f.recent_donations.map((d) => '<li><a href="#/donation/' + esc(d.id) + '">' + fmtDate(d.received_on) + '</a><span>' +
        esc(d.donor_name || 'Anonymous') + (d.is_anonymous && d.donor_name ? ' (anonymous)' : '') + ' · ' +
        (d.donation_type === 'monetary' ? (d.amount !== undefined ? fmtMoney(d.amount) : 'Money') : esc(d.item_summary)) + '</span></li>').join('') + '</ul>'
      : emptyState('No donations recorded yet.')) + '</section>' : '');
}

async function viewOverview() {
  loading('Loading overview…');
  const res = await api('admin/dashboard');
  if (!res.ok) return errorState(res.data.error, viewOverview);
  const c = res.data.counts;
  const card = (label, value, href, tone) => value === null ? '' :
    '<a class="stat-card stat-' + tone + '" href="' + href + '"><span class="stat-value">' + esc(value) + '</span><span class="stat-label">' + esc(label) + '</span></a>';
  const attention = res.data.attention;
  main.innerHTML =
    '<h1>Welcome, ' + esc(state.staff.full_name.split(' ')[0]) + '</h1>' +
    '<div class="stat-grid">' +
      card('Applications to review', c.pending_applications, '#/applications', 'orange') +
      card('Active volunteers', c.active_volunteers, '#/volunteers', 'blue') +
      card('Hours awaiting verification', c.pending_hours, '#/hours', 'green') +
      card('Draft letters', c.draft_letters, '#/letters', 'gray') +
    '</div>' + foundationOverview(res.data.foundation || {}) +
    (canDo('volunteers.manage')
      ? '<section class="panel"><h2>Needs attention</h2>' + (attention.length
        ? '<ul class="attention-list">' + attention.map((a) =>
          '<li class="attention-' + esc(a.kind) + '"><a href="#/volunteer/' + esc(a.volunteer_id) + '">' + esc(a.name) + '</a><span>' + esc(a.detail) + '</span></li>').join('') + '</ul>'
        : emptyState('Nothing needs attention right now.')) + '</section>'
      : '');
}

/* ---------- Applications ---------- */

async function viewApplications() {
  const status = sessionStorage.getItem('apps.status') || 'pending';
  main.innerHTML = '<div class="view-header"><h1>Applications</h1>' +
    '<div class="segmented" role="group" aria-label="Filter applications">' +
    ['pending', 'declined', 'withdrawn'].map((s) => '<button type="button" data-status="' + s + '" aria-pressed="' + (s === status) + '">' + esc(LABELS.status[s]) + '</button>').join('') +
    '</div></div><div id="apps-list"></div>';
  main.querySelectorAll('.segmented button').forEach((b) => b.addEventListener('click', () => {
    sessionStorage.setItem('apps.status', b.dataset.status);
    viewApplications();
  }));

  const list = document.getElementById('apps-list');
  list.innerHTML = '<div class="state-box" role="status"><span class="spinner" aria-hidden="true"></span> Loading applications…</div>';
  const res = await api('admin/applications?status=' + encodeURIComponent(status));
  if (!res.ok) return errorState(res.data.error, viewApplications);
  const rows = res.data.volunteers;
  if (!rows.length) {
    list.innerHTML = emptyState(status === 'pending' ? 'No applications are waiting for review. New applications from the volunteer page will appear here.' : 'No ' + LABELS.status[status].toLowerCase() + ' applications.');
    return;
  }
  list.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Path</th><th>Submitted</th><th>Interests</th><th></th></tr></thead><tbody>' +
    rows.map((v) => '<tr><td><a href="#/volunteer/' + esc(v.id) + '">' + esc(fullName(v)) + '</a></td>' +
      '<td>' + (v.track === 'court_ordered' ? '<span class="badge badge-blue">Court-ordered</span>' : '<span class="badge badge-muted">General</span>') + '</td>' +
      '<td>' + fmtDate(v.created_at) + '</td>' +
      '<td class="wrap">' + esc((v.interests || []).map((i) => optionLabel(INTEREST_OPTIONS, i)).join(', ')) + '</td>' +
      '<td><a class="btn btn-secondary btn-sm" href="#/volunteer/' + esc(v.id) + '">Review</a></td></tr>').join('') +
    '</tbody></table></div>';
}

/* ---------- Volunteers ---------- */

async function viewVolunteers() {
  const status = sessionStorage.getItem('vols.status') || 'approved';
  const q = sessionStorage.getItem('vols.q') || '';
  main.innerHTML = '<div class="view-header"><h1>Volunteers</h1>' +
    '<form class="filter-bar" id="vol-filter" role="search">' +
    '<label class="sr-only" for="vol-status">Status</label><select id="vol-status">' +
    selectOptions({ approved: 'Approved (active)', inactive: 'Inactive', '': 'All statuses' }, status) + '</select>' +
    '<label class="sr-only" for="vol-q">Search</label><input type="search" id="vol-q" placeholder="Search name or email" value="' + esc(q) + '">' +
    '<button class="btn btn-secondary btn-sm" type="submit">Search</button></form></div><div id="vol-list"></div>';
  document.getElementById('vol-filter').addEventListener('submit', (e) => {
    e.preventDefault();
    sessionStorage.setItem('vols.status', document.getElementById('vol-status').value);
    sessionStorage.setItem('vols.q', document.getElementById('vol-q').value);
    viewVolunteers();
  });

  const list = document.getElementById('vol-list');
  list.innerHTML = '<div class="state-box" role="status"><span class="spinner" aria-hidden="true"></span> Loading volunteers…</div>';
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (q) params.set('q', q);
  const res = await api('admin/volunteers?' + params);
  if (!res.ok) return errorState(res.data.error, viewVolunteers);
  const rows = res.data.volunteers;
  if (!rows.length) {
    list.innerHTML = emptyState(q ? 'No volunteers match your search.' : 'No volunteers here yet. Approved applicants will appear in this list.');
    return;
  }
  list.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Path</th><th>Status</th><th>Verified progress</th><th>Youth clearance</th></tr></thead><tbody>' +
    rows.map((v) => '<tr><td><a href="#/volunteer/' + esc(v.id) + '">' + esc(fullName(v)) + '</a>' +
      (v.supervision_required ? ' <span class="badge badge-warn" title="Supervision required">Supervised</span>' : '') + '</td>' +
      '<td>' + esc(v.track === 'court_ordered' ? 'Court-ordered' : 'General') + '</td>' +
      '<td>' + badge('status', v.status) + '</td>' +
      '<td>' + progressBar(v.hours) + '</td>' +
      '<td>' + (v.youth_cleared ? '<span class="badge badge-ok">Cleared</span>' : '<span class="badge badge-muted">Not cleared</span>') + '</td></tr>').join('') +
    '</tbody></table></div>';
}

/* ---------- Volunteer detail ---------- */

async function viewVolunteer(id) {
  loading('Loading volunteer…');
  const res = await api('admin/volunteers?id=' + encodeURIComponent(id || ''));
  if (!res.ok) return errorState(res.data.error, () => viewVolunteer(id));
  const d = res.data;
  const v = d.volunteer;
  const court = v.track === 'court_ordered';
  const s = d.summary;

  const actions = [];
  if (v.status === 'pending' && canDo('applications.review')) {
    actions.push('<button type="button" class="btn btn-donate btn-sm" data-act="approve">Approve</button>');
    actions.push('<button type="button" class="btn btn-secondary btn-sm" data-act="decline">Decline</button>');
  }
  if ((v.status === 'approved' || v.status === 'inactive') && canDo('letters.draft')) {
    actions.push('<button type="button" class="btn btn-primary btn-sm" data-act="draft-letter"' + (s.approvedCount ? '' : ' disabled title="No verified hours yet"') + '>Draft verification letter</button>');
  }
  if (v.status === 'approved' && canDo('volunteers.manage')) {
    actions.push('<button type="button" class="btn btn-secondary btn-sm" data-act="end-service">End service</button>');
  }

  const kv = (pairs) => '<dl class="kv">' + pairs.filter(Boolean).map(([k, val]) => '<dt>' + esc(k) + '</dt><dd>' + val + '</dd>').join('') + '</dl>';

  const contactCard = '<section class="panel"><h2>Contact</h2>' + kv([
    ['Email', '<a href="mailto:' + esc(v.email) + '">' + esc(v.email) + '</a>'],
    ['Phone', esc(v.phone)],
    ['Emergency contact', esc(v.emergency_name) + ' (' + esc(v.emergency_relationship) + ')<br>' + esc(v.emergency_phone)],
    ['Age', '18+ confirmed by applicant']
  ]) + '</section>';

  const appCard = '<section class="panel"><h2>Application</h2>' + kv([
    ['Submitted', fmtDateTime(v.created_at)],
    ['Availability', esc((v.availability_days || []).map((a) => optionLabel(AVAILABILITY_OPTIONS, a)).join(', ')) + (v.availability_notes ? '<br><span class="muted-text">' + esc(v.availability_notes) + '</span>' : '')],
    ['Interests', esc((v.interests || []).map((i) => optionLabel(INTEREST_OPTIONS, i)).join(', '))],
    'skills' in v ? ['Skills', esc(v.skills || '—')] : null,
    'preferred_assignments' in v ? ['Preferences', esc(v.preferred_assignments || '—')] : null,
    v.decision_reason ? ['Decision note', esc(v.decision_reason)] : null,
    v.ended_reason ? ['Ended', fmtDate(v.ended_at) + ' — ' + esc(v.ended_reason)] : null
  ]) + '</section>';

  const ack = d.acknowledgments[0];
  const ackCard = '<section class="panel"><h2>Volunteer Agreement</h2>' + (ack ? kv([
    ['Version', esc(ack.agreement_version)],
    ['Acknowledged', fmtDateTime(ack.acknowledged_at)],
    ['Typed name', esc(ack.typed_name)],
    ['Method', 'Checkbox + typed name (acknowledgment, not a certified signature)']
  ]) + '<p><a href="/volunteer-agreement.html" target="_blank" rel="noopener">Print agreement for a paper signature</a></p>' : emptyState('No acknowledgment on file.')) + '</section>';

  let courtCard = '';
  if (court) {
    courtCard = '<section class="panel"><h2>Court-ordered service</h2>' + kv([
      ['Required hours', esc(v.court_required_hours)],
      ['Deadline', fmtDate(v.court_deadline)],
      ['Agency', esc(v.agency_name)],
      'agency_contact_name' in v ? ['Agency contact', esc(v.agency_contact_name) + '<br>' + esc(v.agency_contact_email || '') + ' ' + esc(v.agency_contact_phone || '')] : null,
      ['Applicant reported', esc(optionLabel(COURT_REPORTED_STATUS_OPTIONS, v.court_reported_status))],
      ['Court/agency approval', badge('court', v.court_approval_status) + (v.court_approval_recorded_at ? ' <span class="muted-text">recorded ' + fmtDateTime(v.court_approval_recorded_at) + '</span>' : '')],
      v.court_approval_notes ? ['Approval notes', esc(v.court_approval_notes)] : null
    ]) + (canDo('court.record') ? '<button type="button" class="btn btn-secondary btn-sm" data-act="court">Record court approval</button>' : '') + '</section>';
  }

  const clearance = d.youth_clearance;
  const manage = canDo('volunteers.manage');
  const screeningCard = '<section class="panel"><h2>Screening &amp; youth safety</h2>' +
    '<p>' + (clearance.cleared ? '<span class="badge badge-ok">Cleared for youth-facing assignments</span>'
      : '<span class="badge badge-warn">Not cleared for youth-facing assignments</span><ul class="reason-list">' + clearance.reasons.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul>') + '</p>' +
    kv([
      ['Screening', badge('screening', v.screening_status)],
      ['Background check', badge('background', v.background_check_status) +
        (v.background_check_expires_on ? ' <span class="muted-text">expires ' + fmtDate(v.background_check_expires_on) + '</span>' : '')],
      'background_check_reference' in v ? ['Vendor reference', esc(v.background_check_reference || '—')] : null,
      ['Supervision', v.supervision_required ? 'Required' : 'Not required'],
      ['Target hours', esc(v.target_hours || v.court_required_hours || '—')],
      'admin_notes' in v ? ['Admin notes', esc(v.admin_notes || '—')] : null
    ]) +
    '<p class="field-hint">Background-check reports are never stored here — record only status, dates, and the vendor reference number.</p>' +
    (manage ? '<button type="button" class="btn btn-secondary btn-sm" data-act="screening">Update screening</button>' : '') + '</section>';

  const placementsCard = '<section class="panel panel-wide"><div class="panel-head"><h2>Assignments</h2>' +
    (canDo('assignments.manage') && v.status === 'approved' ? '<button type="button" class="btn btn-secondary btn-sm" data-act="assign">Assign activity</button>' : '') + '</div>' +
    (d.placements.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Activity</th><th>Supervisor</th><th>Status</th><th>Assigned</th><th></th></tr></thead><tbody>' +
      d.placements.map((p) => '<tr><td>' + esc(p.assignment_name) + (p.youth_facing ? ' <span class="badge badge-blue">Youth-facing</span>' : '') + '</td>' +
        '<td>' + esc(p.supervisor_name) + '</td><td>' + (p.status === 'active' ? '<span class="badge badge-ok">Active</span>' : '<span class="badge badge-muted">Ended</span>') + '</td>' +
        '<td>' + fmtDate(p.assigned_at) + '</td><td>' + (p.status === 'active' && canDo('assignments.manage') ? '<button type="button" class="btn-link" data-act="end-placement" data-id="' + esc(p.id) + '">End</button>' : '') + '</td></tr>').join('') +
      '</tbody></table></div>' : emptyState('No assignments yet.')) + '</section>';

  const hoursCard = '<section class="panel panel-wide"><div class="panel-head"><h2>Service hours</h2>' +
    (canDo('hours.record') && (v.status === 'approved' || v.status === 'inactive') && d.placements.length ? '<button type="button" class="btn btn-secondary btn-sm" data-act="log-hours">Log hours</button>' : '') + '</div>' +
    '<div class="hours-summary"><div>' + progressBar(s) + '</div><div><strong>' + formatHours(s.verifiedMinutes) + '</strong> verified hrs' +
    (s.targetMinutes ? ' · <strong>' + formatHours(s.remainingMinutes) + '</strong> remaining' : '') +
    ' · <strong>' + formatHours(s.pendingMinutes) + '</strong> awaiting verification</div>' +
    (s.firstServiceDate ? '<div class="muted-text">Verified service: ' + fmtDate(s.firstServiceDate) + ' – ' + fmtDate(s.lastServiceDate) + '</div>' : '') + '</div>' +
    (d.hours.length ? hoursTable(d.hours, false) : emptyState('No hours logged yet.')) + '</section>';

  const lettersCard = canDo('letters.view') ? '<section class="panel panel-wide"><h2>Verification letters</h2>' +
    (d.letters.length ? '<ul class="letter-list">' + d.letters.map((l) => '<li><a href="/admin/letter.html?id=' + esc(l.id) + '" target="_blank" rel="noopener">' + esc(l.letter_number) + '</a> ' + badge('letter', l.status) + ' <span class="muted-text">' + formatHours(l.total_minutes) + ' hrs · drafted ' + fmtDate(l.drafted_at) + '</span></li>').join('') + '</ul>'
      : emptyState('No letters yet.')) + '</section>' : '';

  main.innerHTML = '<p class="breadcrumb"><a href="#/' + (v.status === 'pending' || v.status === 'declined' ? 'applications' : 'volunteers') + '">← Back</a></p>' +
    '<div class="view-header"><div><h1>' + esc(fullName(v)) + '</h1><p class="header-badges">' + badge('status', v.status) + ' ' +
    (court ? '<span class="badge badge-blue">Court-ordered</span>' : '<span class="badge badge-muted">General volunteer</span>') +
    (v.supervision_required ? ' <span class="badge badge-warn">Supervision required</span>' : '') + '</p></div>' +
    '<div class="action-row">' + actions.join('') + '</div></div>' +
    '<div class="detail-grid">' + contactCard + appCard + screeningCard + (courtCard || '') + ackCard + placementsCard + hoursCard + lettersCard + '</div>';

  hourIndex = new Map(d.hours.map((e) => [e.id, e]));
  bindHourActions(() => viewVolunteer(id));
  main.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => volunteerAction(btn.dataset.act, d, btn.dataset.id)));
}

function volunteerAction(act, d, extraId) {
  const v = d.volunteer;
  const reload = () => viewVolunteer(v.id);
  const done = (msg) => (res) => { if (res.ok) { toast(msg); reload(); } return res; };

  if (act === 'approve') {
    openModal({
      title: 'Approve ' + fullName(v) + '?',
      body: '<p>Approving lets you assign activities and log hours. It does not clear them for youth-facing work — screening is tracked separately.</p>' +
        '<p class="field-hint">No email is sent automatically. Contact the volunteer directly to share next steps.</p>',
      submitLabel: 'Approve volunteer',
      onSubmit: () => api('admin/decision', { method: 'POST', body: { volunteer_id: v.id, decision: 'approve' } }).then(done('Volunteer approved.'))
    });
  } else if (act === 'decline') {
    openModal({
      title: 'Decline application',
      body: '<label for="m-reason">Reason (internal only) *</label><textarea id="m-reason" name="reason" rows="3" maxlength="1000" required></textarea>' +
        '<p class="field-hint">No email is sent automatically. Declined applications are deleted after 12 months.</p>',
      submitLabel: 'Decline', danger: true,
      onSubmit: (f) => api('admin/decision', { method: 'POST', body: { volunteer_id: v.id, decision: 'decline', reason: f.reason } }).then(done('Application declined.'))
    });
  } else if (act === 'court') {
    openModal({
      title: 'Record court / agency approval',
      body: '<label for="m-court">Approval status</label><select id="m-court" name="status">' + selectOptions(LABELS.court, v.court_approval_status) + '</select>' +
        '<label for="m-notes">Notes</label><textarea id="m-notes" name="notes" rows="3" maxlength="1000" placeholder="e.g. Confirmed by phone with agency contact on Oct 21">' + esc(v.court_approval_notes || '') + '</textarea>' +
        '<p class="field-hint">Record how approval was confirmed. Do not record offense details.</p>',
      onSubmit: (f) => api('admin/court-approval', { method: 'POST', body: { volunteer_id: v.id, status: f.status, notes: f.notes } }).then(done('Court approval recorded.'))
    });
  } else if (act === 'screening') {
    openModal({
      title: 'Update screening & management',
      body: '<div class="m-grid"><div><label for="m-scr">Screening</label><select id="m-scr" name="screening_status">' + selectOptions(LABELS.screening, v.screening_status) + '</select></div>' +
        '<div><label for="m-bg">Background check</label><select id="m-bg" name="background_check_status">' + selectOptions(LABELS.background, v.background_check_status) + '</select></div>' +
        '<div><label for="m-bgc">Completed on</label><input type="date" id="m-bgc" name="background_check_completed_on" value="' + esc(v.background_check_completed_on || '') + '"></div>' +
        '<div><label for="m-bge">Expires on</label><input type="date" id="m-bge" name="background_check_expires_on" value="' + esc(v.background_check_expires_on || '') + '"></div></div>' +
        '<label for="m-ref">Vendor reference number</label><input type="text" id="m-ref" name="background_check_reference" maxlength="120" value="' + esc(v.background_check_reference || '') + '">' +
        '<p class="field-hint">Reference ID only. Never upload or paste report contents or SSNs.</p>' +
        '<label for="m-target">Target hours</label><input type="number" id="m-target" name="target_hours" min="1" max="1000" step="0.25" value="' + esc(v.target_hours || '') + '">' +
        '<label class="check-label"><input type="checkbox" name="supervision_required"' + (v.supervision_required ? ' checked' : '') + '> <span>Supervision required</span></label>' +
        '<label for="m-anotes">Admin notes</label><textarea id="m-anotes" name="admin_notes" rows="3" maxlength="2000">' + esc(v.admin_notes || '') + '</textarea>' +
        '<p class="field-hint">If this change means the volunteer is no longer cleared, their youth-facing assignments end automatically.</p>',
      onSubmit: (f) => api('admin/volunteers?id=' + encodeURIComponent(v.id), { method: 'PATCH', body: f }).then((res) => {
        if (res.ok) {
          toast(res.data.ended_youth_placements ? 'Saved. ' + res.data.ended_youth_placements + ' youth-facing assignment(s) ended.' : 'Screening updated.', res.data.ended_youth_placements ? 'warn' : 'ok');
          reload();
        }
        return res;
      })
    });
  } else if (act === 'assign') {
    api('admin/assignments').then((res) => {
      if (!res.ok) return toast(res.data.error, 'bad');
      const active = res.data.assignments.filter((a) => a.active);
      if (!active.length) return toast('Create an assignment first (Assignments tab).', 'warn');
      openModal({
        title: 'Assign activity',
        body: '<label for="m-as">Activity</label><select id="m-as" name="assignment_id">' +
          active.map((a) => '<option value="' + esc(a.id) + '" data-youth="' + (a.youth_facing ? '1' : '') + '">' + esc(a.name) + (a.youth_facing ? ' (youth-facing)' : '') + '</option>').join('') + '</select>' +
          '<div id="m-youth-warn" class="notice-box" hidden>This is a youth-facing assignment. ' +
          (d.youth_clearance.cleared ? 'This volunteer is cleared.' : '<strong>This volunteer is not cleared yet:</strong> ' + esc(d.youth_clearance.reasons.join(' '))) + '</div>' +
          '<label for="m-sup">Supervisor *</label><input type="text" id="m-sup" name="supervisor_name" maxlength="120" required>',
        submitLabel: 'Assign',
        onOpen: (body) => {
          const sel = body.querySelector('#m-as');
          const sync = () => { body.querySelector('#m-youth-warn').hidden = !sel.selectedOptions[0].dataset.youth; };
          sel.addEventListener('change', sync);
          sync();
        },
        onSubmit: (f) => api('admin/placements', { method: 'POST', body: { volunteer_id: v.id, assignment_id: f.assignment_id, supervisor_name: f.supervisor_name } }).then(done('Assignment added.'))
      });
    });
  } else if (act === 'end-placement') {
    openModal({
      title: 'End this assignment?',
      body: '<p>The volunteer will no longer be scheduled for this activity. Logged hours are kept.</p>',
      submitLabel: 'End assignment', danger: true,
      onSubmit: () => api('admin/end-placement', { method: 'POST', body: { placement_id: extraId } }).then(done('Assignment ended.'))
    });
  } else if (act === 'end-service') {
    openModal({
      title: 'End volunteer service',
      body: '<label for="m-es">New status</label><select id="m-es" name="status">' + selectOptions({ inactive: 'Inactive (placement ended)', withdrawn: 'Withdrawn (volunteer chose to leave)' }, 'inactive') + '</select>' +
        '<label for="m-er">Reason (internal only) *</label><textarea id="m-er" name="reason" rows="3" maxlength="1000" required></textarea>' +
        '<p class="field-hint">All active assignments end. Verified hours stay on record for letters.</p>',
      submitLabel: 'End service', danger: true,
      onSubmit: (f) => api('admin/end-service', { method: 'POST', body: { volunteer_id: v.id, status: f.status, reason: f.reason } }).then(done('Service ended.'))
    });
  } else if (act === 'draft-letter') {
    openModal({
      title: 'Draft verification letter',
      body: '<p>The draft will include <strong>' + formatHours(d.summary.verifiedMinutes) + ' verified hours</strong> (' + d.summary.approvedCount + ' supervisor-approved entries). Pending and rejected hours are excluded.</p>' +
        '<p>An authorized administrator must review and approve the draft before it can be issued.</p>',
      submitLabel: 'Create draft',
      onSubmit: () => api('admin/letters', { method: 'POST', body: { volunteer_id: v.id } }).then((res) => {
        if (res.ok) {
          toast('Draft letter created.');
          window.open('/admin/letter.html?id=' + encodeURIComponent(res.data.letter.id), '_blank', 'noopener');
          reload();
        }
        return res;
      })
    });
  } else if (act === 'log-hours') {
    openHourForm({ volunteer: v, placements: d.placements.filter((p) => p.status === 'active') }, reload);
  }
}

/* ---------- Hours ---------- */

function hoursTable(entries, showVolunteer) {
  return '<div class="table-wrap"><table class="data-table"><thead><tr><th>Date &amp; time</th>' + (showVolunteer ? '<th>Volunteer</th>' : '') +
    '<th>Assignment</th><th>Net hrs</th><th>Supervisor</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
    entries.map((e) => {
      const acts = [];
      if (e.status === 'pending' && canDo('hours.verify') && !e.is_own_entry) {
        acts.push('<button type="button" class="btn btn-donate btn-xs" data-hour="approve" data-id="' + esc(e.id) + '">Approve</button>');
        acts.push('<button type="button" class="btn btn-secondary btn-xs" data-hour="reject" data-id="' + esc(e.id) + '">Reject</button>');
      }
      if (e.status === 'pending' && e.is_own_entry) acts.push('<span class="muted-text">Your own hours</span>');
      if (e.status !== 'voided' && canDo('hours.correct')) {
        acts.push('<button type="button" class="btn-link" data-hour="edit" data-id="' + esc(e.id) + '">Correct</button>');
        acts.push('<button type="button" class="btn-link" data-hour="void" data-id="' + esc(e.id) + '">Void</button>');
      }
      acts.push('<button type="button" class="btn-link" data-hour="history" data-id="' + esc(e.id) + '">History</button>');
      return '<tr' + (e.status === 'voided' ? ' class="row-muted"' : '') + '><td class="nowrap">' + fmtDate(e.service_date) + '<div class="muted-text small">' + fmtTime(e.start_time) + '–' + fmtTime(e.end_time) + '</div></td>' +
        (showVolunteer ? '<td><a href="#/volunteer/' + esc(e.volunteer_id) + '">' + esc(e.volunteer_name) + '</a></td>' : '') +
        '<td>' + esc(e.assignment_name) + '</td>' +
        '<td class="nowrap"><strong>' + formatHours(e.net_minutes) + '</strong><div class="muted-text small">' + esc(e.break_minutes) + ' min break</div></td>' +
        '<td>' + esc(e.supervisor_name) + '</td><td>' + badge('hour', e.status) +
        (e.verification_note ? '<div class="muted-text small">' + esc(e.verification_note) + '</div>' : '') + '</td>' +
        '<td class="actions-cell">' + acts.join(' ') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

let hourIndex = new Map();

function bindHourActions(reload) {
  main.querySelectorAll('[data-hour]').forEach((btn) => btn.addEventListener('click', () => hourAction(btn.dataset.hour, btn.dataset.id, reload)));
}

async function hourAction(act, id, reload) {
  const done = (msg) => (res) => { if (res.ok) { toast(msg); reload(); } return res; };
  if (act === 'approve') {
    openModal({
      title: 'Verify these hours?',
      body: '<p>Approve only hours you or the named supervisor directly observed. Verified hours count toward the volunteer\'s total and can appear on verification letters.</p>' +
        '<label for="m-vn">Note (optional)</label><textarea id="m-vn" name="note" rows="2" maxlength="1000"></textarea>',
      submitLabel: 'Approve hours',
      onSubmit: (f) => api('admin/verify-hours', { method: 'POST', body: { id, decision: 'approve', note: f.note } }).then(done('Hours verified.'))
    });
  } else if (act === 'reject') {
    openModal({
      title: 'Reject these hours',
      body: '<label for="m-rn">Reason *</label><textarea id="m-rn" name="note" rows="3" maxlength="1000" required></textarea>',
      submitLabel: 'Reject hours', danger: true,
      onSubmit: (f) => api('admin/verify-hours', { method: 'POST', body: { id, decision: 'reject', note: f.note } }).then(done('Hours rejected.'))
    });
  } else if (act === 'void') {
    openModal({
      title: 'Void this entry',
      body: '<p>Voided entries never count toward totals. The original values are kept in the correction history.</p>' +
        '<label for="m-vr">Reason *</label><textarea id="m-vr" name="reason" rows="3" maxlength="1000" required></textarea>',
      submitLabel: 'Void entry', danger: true,
      onSubmit: (f) => api('admin/void-hours', { method: 'POST', body: { id, reason: f.reason } }).then(done('Entry voided.'))
    });
  } else if (act === 'history') {
    const res = await api('admin/hour-history?id=' + encodeURIComponent(id));
    if (!res.ok) return toast(res.data.error, 'bad');
    const revs = res.data.revisions;
    openModal({
      title: 'Correction history',
      body: revs.length ? '<ol class="history-list">' + revs.map((r) => {
        const p = r.previous;
        return '<li><strong>' + fmtDateTime(r.changed_at) + '</strong> by ' + esc(r.changed_by_name || 'staff') + '<br>' +
          '<span class="muted-text">Reason: ' + esc(r.reason) + '</span><br>Previously: ' + fmtDate(p.service_date) + ', ' + fmtTime(p.start_time) + '–' + fmtTime(p.end_time) +
          ', break ' + esc(p.break_minutes) + ' min, ' + formatHours(p.net_minutes) + ' hrs, ' + esc(LABELS.hour[p.status] || p.status) + '</li>';
      }).join('') + '</ol>' : emptyState('This entry has not been corrected.'),
      submitLabel: 'Close'
    });
  } else if (act === 'edit') {
    const entry = hourIndex.get(id);
    const res = await api('admin/volunteers?id=' + encodeURIComponent(entry.volunteer_id));
    if (!res.ok) return toast(res.data.error, 'bad');
    openHourForm({ volunteer: res.data.volunteer, placements: res.data.placements, entry: entry }, reload);
  }
}

function openHourForm(ctx, reload) {
  const e = ctx.entry;
  const placements = ctx.placements;
  const today = todayInOrgTimeZone();
  openModal({
    title: (e ? 'Correct hours — ' : 'Log hours — ') + fullName(ctx.volunteer),
    body: '<label for="h-as">Assignment *</label><select id="h-as" name="assignment_id">' +
      placements.map((p) => '<option value="' + esc(p.assignment_id) + '" data-sup="' + esc(p.supervisor_name) + '"' + (e && e.assignment_id === p.assignment_id ? ' selected' : '') + '>' + esc(p.assignment_name) + '</option>').join('') + '</select>' +
      '<div class="m-grid"><div><label for="h-date">Service date *</label><input type="date" id="h-date" name="service_date" max="' + today + '" value="' + esc(e ? e.service_date : today) + '" required></div>' +
      '<div><label for="h-break">Break (minutes)</label><input type="number" id="h-break" name="break_minutes" min="0" max="600" step="1" value="' + esc(e ? e.break_minutes : 0) + '"></div>' +
      '<div><label for="h-start">Start time *</label><input type="time" id="h-start" name="start_time" value="' + esc(e ? e.start_time : '') + '" required></div>' +
      '<div><label for="h-end">End time *</label><input type="time" id="h-end" name="end_time" value="' + esc(e ? e.end_time : '') + '" required></div></div>' +
      '<p class="net-preview" id="h-net" aria-live="polite"></p>' +
      '<label for="h-sup">Supervisor *</label><input type="text" id="h-sup" name="supervisor_name" maxlength="120" value="' + esc(e ? e.supervisor_name : '') + '" required>' +
      '<label for="h-notes">Notes</label><textarea id="h-notes" name="notes" rows="2" maxlength="1000">' + esc(e ? e.notes || '' : '') + '</textarea>' +
      (e ? '<label for="h-reason">Reason for correction *</label><textarea id="h-reason" name="reason" rows="2" maxlength="1000" required></textarea>' +
        '<p class="field-hint">' + (e.status === 'approved' ? 'This entry is verified. Correcting it sends it back for re-verification.' : 'The original values are saved to the correction history.') + '</p>'
        : '<p class="field-hint">New entries start as "awaiting verification" and only count once a supervisor approves them.</p>'),
    submitLabel: e ? 'Save correction' : 'Log hours',
    onOpen: (body) => {
      const net = body.querySelector('#h-net');
      const sel = body.querySelector('#h-as');
      const sup = body.querySelector('#h-sup');
      const update = () => {
        const r = calculateNetMinutes(body.querySelector('#h-start').value, body.querySelector('#h-end').value, body.querySelector('#h-break').value);
        net.textContent = r.ok ? 'Net hours: ' + formatHours(r.minutes) : (body.querySelector('#h-start').value && body.querySelector('#h-end').value ? r.error : '');
        net.classList.toggle('net-error', !r.ok);
      };
      ['#h-start', '#h-end', '#h-break'].forEach((s) => body.querySelector(s).addEventListener('input', update));
      if (!e) {
        const syncSup = () => { if (sel.selectedOptions[0]) sup.value = sel.selectedOptions[0].dataset.sup; };
        sel.addEventListener('change', syncSup);
        syncSup();
      }
      update();
    },
    onSubmit: (f) => {
      const body = {
        assignment_id: f.assignment_id, service_date: f.service_date, start_time: f.start_time, end_time: f.end_time,
        break_minutes: f.break_minutes === '' ? 0 : Number(f.break_minutes), supervisor_name: f.supervisor_name, notes: f.notes
      };
      const req = e
        ? api('admin/hours?id=' + encodeURIComponent(e.id), { method: 'PATCH', body: Object.assign(body, { reason: f.reason }) })
        : api('admin/hours', { method: 'POST', body: Object.assign(body, { volunteer_id: ctx.volunteer.id }) });
      return req.then((res) => { if (res.ok) { toast(e ? 'Correction saved.' : 'Hours logged.'); reload(); } return res; });
    }
  });
}

async function viewHours() {
  const status = sessionStorage.getItem('hours.status') ?? 'pending';
  main.innerHTML = '<div class="view-header"><h1>Hours</h1><div class="action-row">' +
    '<label class="sr-only" for="h-filter">Status</label><select id="h-filter">' +
    selectOptions({ pending: 'Awaiting verification', approved: 'Verified', rejected: 'Rejected', voided: 'Voided', '': 'All entries' }, status) + '</select>' +
    (canDo('hours.export') ? '<a class="btn btn-secondary btn-sm" id="export-btn" href="/api/admin/hours-export' + (status ? '?status=' + status : '') + '" download>Export CSV</a>' : '') +
    '</div></div><p class="field-hint">To log new hours, open the volunteer\'s page. Only supervisor-approved hours count toward totals and letters.</p><div id="hours-list"></div>';
  document.getElementById('h-filter').addEventListener('change', (e) => {
    sessionStorage.setItem('hours.status', e.target.value);
    viewHours();
  });
  const list = document.getElementById('hours-list');
  list.innerHTML = '<div class="state-box" role="status"><span class="spinner" aria-hidden="true"></span> Loading hours…</div>';
  const res = await api('admin/hours' + (status ? '?status=' + status : ''));
  if (!res.ok) return errorState(res.data.error, viewHours);
  hourIndex = new Map(res.data.entries.map((e) => [e.id, e]));
  list.innerHTML = res.data.entries.length ? hoursTable(res.data.entries, true)
    : emptyState(status === 'pending' ? 'No hours are waiting for verification.' : 'No entries match this filter.');
  bindHourActions(viewHours);
}

/* ---------- Assignments ---------- */

async function viewAssignments() {
  loading('Loading assignments…');
  const res = await api('admin/assignments');
  if (!res.ok) return errorState(res.data.error, viewAssignments);
  const rows = res.data.assignments;
  const manage = canDo('assignments.manage');
  main.innerHTML = '<div class="view-header"><h1>Assignments</h1>' +
    (manage ? '<button type="button" class="btn btn-primary btn-sm" id="new-assignment">New assignment</button>' : '') + '</div>' +
    '<p class="field-hint">Youth-facing assignments are always supervised and only accept volunteers whose screening is complete.</p>' +
    (rows.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Activity</th><th>Location</th><th>Safety</th><th>Active volunteers</th><th>Status</th><th></th></tr></thead><tbody>' +
      rows.map((a) => '<tr' + (a.active ? '' : ' class="row-muted"') + '><td><strong>' + esc(a.name) + '</strong>' + (a.description ? '<div class="muted-text small">' + esc(a.description) + '</div>' : '') + '</td>' +
        '<td>' + esc(a.location || '—') + '</td><td>' + (a.youth_facing ? '<span class="badge badge-blue">Youth-facing</span> ' : '') + (a.requires_supervision ? '<span class="badge badge-warn">Supervised</span>' : '') + '</td>' +
        '<td>' + esc(a.active_volunteers) + '</td><td>' + (a.active ? '<span class="badge badge-ok">Active</span>' : '<span class="badge badge-muted">Archived</span>') + '</td>' +
        '<td>' + (manage ? '<button type="button" class="btn-link" data-edit="' + esc(a.id) + '">Edit</button>' : '') + '</td></tr>').join('') +
      '</tbody></table></div>' : emptyState('No assignments yet. Create activities like "Inventor Workshop classroom support" or "Book drive sorting".'));

  const form = (a) => '<label for="a-name">Name *</label><input type="text" id="a-name" name="name" maxlength="120" required value="' + esc(a ? a.name : '') + '">' +
    '<label for="a-desc">Description</label><textarea id="a-desc" name="description" rows="2" maxlength="1000">' + esc(a ? a.description || '' : '') + '</textarea>' +
    '<label for="a-loc">Location</label><input type="text" id="a-loc" name="location" maxlength="200" value="' + esc(a ? a.location || '' : '') + '">' +
    '<label class="check-label"><input type="checkbox" name="youth_facing"' + (a && a.youth_facing ? ' checked' : '') + '> <span>Youth-facing (volunteers work with students) — requires screening</span></label>' +
    '<label class="check-label"><input type="checkbox" name="requires_supervision"' + (!a || a.requires_supervision ? ' checked' : '') + '> <span>Requires on-site supervision</span></label>' +
    (a ? '<label class="check-label"><input type="checkbox" name="active"' + (a.active ? ' checked' : '') + '> <span>Active (uncheck to archive)</span></label>' : '');

  if (manage) {
    document.getElementById('new-assignment').addEventListener('click', () => openModal({
      title: 'New assignment', body: form(null), submitLabel: 'Create',
      onSubmit: (f) => api('admin/assignments', { method: 'POST', body: f }).then((r) => { if (r.ok) { toast('Assignment created.'); viewAssignments(); } return r; })
    }));
    main.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => {
      const a = rows.find((x) => x.id === btn.dataset.edit);
      openModal({
        title: 'Edit assignment', body: form(a),
        onSubmit: (f) => api('admin/assignments?id=' + encodeURIComponent(a.id), { method: 'PATCH', body: f }).then((r) => { if (r.ok) { toast('Assignment saved.'); viewAssignments(); } return r; })
      });
    }));
  }
}

/* ---------- Letters ---------- */

async function viewLetters() {
  loading('Loading letters…');
  const res = await api('admin/letters');
  if (!res.ok) return errorState(res.data.error, viewLetters);
  const rows = res.data.letters;
  main.innerHTML = '<div class="view-header"><h1>Verification Letters</h1></div>' +
    '<p class="field-hint">Draft a letter from a volunteer\'s page. Drafts are not valid until an authorized administrator reviews and approves them.' +
    (canDo('letters.approve') ? ' Open a draft to review and approve it.' : '') + '</p>' +
    (rows.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Letter</th><th>Volunteer</th><th>Verified hrs</th><th>Service period</th><th>Status</th><th></th></tr></thead><tbody>' +
      rows.map((l) => '<tr' + (l.status === 'void' ? ' class="row-muted"' : '') + '><td><a href="/admin/letter.html?id=' + esc(l.id) + '" target="_blank" rel="noopener">' + esc(l.letter_number) + '</a></td>' +
        '<td><a href="#/volunteer/' + esc(l.volunteer_id) + '">' + esc(l.volunteer_name) + '</a></td><td>' + formatHours(l.total_minutes) + '</td>' +
        '<td class="nowrap">' + fmtDate(l.first_service_date) + ' – ' + fmtDate(l.last_service_date) + '</td>' +
        '<td>' + badge('letter', l.status) + (l.status === 'approved' ? '<div class="muted-text small">' + esc(l.signer_name) + ', ' + fmtDate(l.issue_date) + '</div>' : '') + '</td>' +
        '<td class="actions-cell"><a class="btn-link" href="/admin/letter.html?id=' + esc(l.id) + '" target="_blank" rel="noopener">Open</a>' +
        (l.status === 'draft' || (l.status === 'approved' && canDo('letters.approve')) ? ' <button type="button" class="btn-link" data-void="' + esc(l.id) + '">Void</button>' : '') + '</td></tr>').join('') +
      '</tbody></table></div>' : emptyState('No letters yet.'));
  main.querySelectorAll('[data-void]').forEach((btn) => btn.addEventListener('click', () => openModal({
    title: 'Void letter',
    body: '<p>A void letter can no longer be printed as valid. This cannot be undone.</p><label for="l-vr">Reason *</label><textarea id="l-vr" name="reason" rows="3" required></textarea>',
    submitLabel: 'Void letter', danger: true,
    onSubmit: (f) => api('admin/void-letter', { method: 'POST', body: { id: btn.dataset.void, reason: f.reason } }).then((r) => { if (r.ok) { toast('Letter voided.'); viewLetters(); } return r; })
  })));
}

/* ---------- Retention ---------- */

async function viewRetention() {
  loading('Checking retention…');
  const res = await api('admin/retention');
  if (!res.ok) return errorState(res.data.error, viewRetention);
  const rows = res.data.eligible;
  main.innerHTML = '<div class="view-header"><h1>Data Retention</h1></div>' +
    '<section class="panel"><h2>Policy</h2><ul class="policy-list">' +
    '<li>Declined or withdrawn applications: deleted after <strong>12 months</strong>.</li>' +
    '<li>Former volunteers: deleted <strong>3 years</strong> after service ends (kept so hours can be re-verified).</li>' +
    '<li>Spam-protection hashes: deleted after <strong>7 days</strong>.</li>' +
    '<li>Purging is permanent and removes the record, agreement acknowledgment, assignments, hours, and letters. The audit log keeps only record IDs.</li></ul></section>' +
    (rows.length ? '<form id="purge-form"><div class="table-wrap"><table class="data-table"><thead><tr><th><span class="sr-only">Select</span></th><th>Name</th><th>Status</th><th>Since</th><th>Rule</th></tr></thead><tbody>' +
      rows.map((r) => '<tr><td><input type="checkbox" name="ids" value="' + esc(r.id) + '" aria-label="Select ' + esc(r.name) + '"></td><td>' + esc(r.name) + '</td><td>' + badge('status', r.status) + '</td><td>' + fmtDate(r.since) + '</td><td>' + esc(r.rule) + '</td></tr>').join('') +
      '</tbody></table></div><button type="submit" class="btn btn-danger btn-sm">Purge selected</button></form>'
      : emptyState('No records are past their retention period.'));
  const form = document.getElementById('purge-form');
  if (form) form.addEventListener('submit', (e) => {
    e.preventDefault();
    const ids = Array.from(form.querySelectorAll('input[name="ids"]:checked')).map((c) => c.value);
    if (!ids.length) return toast('Select at least one record.', 'warn');
    openModal({
      title: 'Permanently delete ' + ids.length + ' record(s)?',
      body: '<p>This cannot be undone.</p><label for="p-confirm">Type <strong>PURGE</strong> to confirm</label><input type="text" id="p-confirm" name="confirm" autocomplete="off" required>',
      submitLabel: 'Delete permanently', danger: true,
      onSubmit: (f) => api('admin/retention', { method: 'POST', body: { volunteer_ids: ids, confirm: f.confirm } }).then((r) => { if (r.ok) { toast(r.data.purged + ' record(s) purged.'); viewRetention(); } return r; })
    });
  });
}

/* ---------- Audit ---------- */

async function viewAudit() {
  loading('Loading audit log…');
  const res = await api('admin/audit?limit=300');
  if (!res.ok) return errorState(res.data.error, viewAudit);
  const rows = res.data.events;
  main.innerHTML = '<div class="view-header"><h1>Audit Log</h1>' + (canDo('records.backup') ? '<a class="btn btn-secondary btn-sm" download href="/api/admin/backup">Download full backup</a>' : '') + '</div><p class="field-hint">The most recent 300 events. Entries cannot be edited or deleted from the dashboard.</p>' +
    (rows.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th></tr></thead><tbody>' +
      rows.map((r) => '<tr><td class="nowrap">' + fmtDateTime(r.created_at) + '</td><td>' + esc(r.actor_email || 'Public / system') + '</td><td><code>' + esc(r.action) + '</code></td>' +
        '<td>' + esc(r.entity_type) + (r.entity_id ? ' <span class="muted-text small">' + esc(String(r.entity_id).slice(0, 8)) + '</span>' : '') + '</td>' +
        '<td class="wrap small">' + esc(Object.keys(r.details || {}).length ? JSON.stringify(r.details) : '') + '</td></tr>').join('') +
      '</tbody></table></div>' : emptyState('No events yet.'));
}

/* ---------- Donations ---------- */

const PAYMENT_LABELS = { cash: 'Cash', check: 'Check', card: 'Card', givebutter: 'Givebutter', bank_transfer: 'Bank transfer', other: 'Other' };
const TXN_LABELS = { opening_balance: 'Opening balance', received: 'Received', distributed: 'Distributed', adjustment: 'Correction' };
const PARTICIPATION_LABELS = { exhibited: 'Exhibited', hosted: 'Hosted', attended: 'Attended', partnered: 'Partnered' };

function fmtMoney(n) {
  return n == null ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function today() {
  return todayInOrgTimeZone();
}

function newRequestId() {
  return crypto.randomUUID();
}

let inventoryCategories = [];

async function loadCategories() {
  if (inventoryCategories.length) return inventoryCategories;
  const res = await api('admin/inventory');
  if (res.ok) inventoryCategories = res.data.categories;
  return inventoryCategories;
}

function giftCell(d) {
  if (d.donation_type === 'monetary') return 'amount' in d ? fmtMoney(d.amount) : '<span class="muted-text">Money (amount hidden)</span>';
  return esc(d.item_summary || '—');
}

async function viewDonations() {
  const year = sessionStorage.getItem('don.year') || String(new Date().getFullYear());
  const type = sessionStorage.getItem('don.type') || '';
  const years = { '': 'All years' };
  for (let y = new Date().getFullYear(); y >= 2024; y--) years[String(y)] = String(y);
  main.innerHTML = '<div class="view-header"><h1>Donations</h1><div class="action-row">' +
    '<a class="btn btn-secondary btn-sm" href="#/donors">Donors</a>' +
    (canDo('records.export') ? '<a class="btn btn-secondary btn-sm" download href="/api/admin/donations-export' + (year ? '?from=' + year + '-01-01&to=' + year + '-12-31' : '') + '">Export CSV</a>' : '') +
    (canDo('donations.manage') ? '<button type="button" class="btn btn-primary btn-sm" id="new-donation">Record donation</button>' : '') +
    '</div></div>' +
    '<div class="filter-bar"><label class="sr-only" for="don-year">Year</label><select id="don-year">' + selectOptions(years, year) + '</select>' +
    '<label class="sr-only" for="don-type">Type</label><select id="don-type">' + selectOptions({ '': 'Money and items', monetary: 'Money', in_kind: 'Items (in-kind)' }, type) + '</select></div>' +
    '<div id="don-list"><div class="state-box" role="status"><span class="spinner" aria-hidden="true"></span> Loading donations…</div></div>';
  document.getElementById('don-year').addEventListener('change', (e) => { sessionStorage.setItem('don.year', e.target.value); viewDonations(); });
  document.getElementById('don-type').addEventListener('change', (e) => { sessionStorage.setItem('don.type', e.target.value); viewDonations(); });
  const btn = document.getElementById('new-donation');
  if (btn) btn.addEventListener('click', () => openDonationForm(null, viewDonations));

  const params = new URLSearchParams();
  if (year) { params.set('from', year + '-01-01'); params.set('to', year + '-12-31'); }
  if (type) params.set('donation_type', type);
  const res = await api('admin/donations?' + params);
  if (!res.ok) return errorState(res.data.error, viewDonations);
  const rows = res.data.donations;
  document.getElementById('don-list').innerHTML = rows.length
    ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Received</th><th>Donor</th><th>Gift</th><th>Restriction</th><th>Status</th><th>Thank-you</th></tr></thead><tbody>' +
      rows.map((d) => '<tr' + (d.status === 'void' ? ' class="row-muted"' : '') + '><td class="nowrap"><a href="#/donation/' + esc(d.id) + '">' + fmtDate(d.received_on) + '</a>' +
        (d.is_historical ? '<div class="muted-text small">Historical entry</div>' : '') + '</td>' +
        '<td>' + (d.donor_name ? esc(d.donor_name) : '<span class="muted-text">No donor record</span>') + (d.is_anonymous ? ' <span class="badge badge-muted">Anonymous</span>' : '') + '</td>' +
        '<td>' + giftCell(d) + '</td>' +
        '<td>' + (d.restriction === 'restricted' ? '<span class="badge badge-warn" title="' + esc(d.restriction_purpose) + '">Restricted</span>' : '<span class="muted-text">Unrestricted</span>') + '</td>' +
        '<td>' + (d.status === 'void' ? '<span class="badge badge-muted">Void</span>' : '<span class="badge badge-ok">Recorded</span>') + '</td>' +
        '<td>' + (d.acknowledgment_status ? esc(d.acknowledgment_status) : '<span class="muted-text">Not started</span>') + '</td></tr>').join('') +
      '</tbody></table></div>'
    : emptyState(year ? 'No donations recorded for ' + year + ' yet.' : 'No donations recorded yet. Use “Record donation” to add one, including past gifts.');
}

async function openDonationForm(existing, reload) {
  const [cats, donorsRes] = await Promise.all([loadCategories(), api('admin/donors')]);
  if (!donorsRes.ok) return toast(donorsRes.data.error, 'bad');
  const donors = donorsRes.data.donors;
  const d = existing || {};
  const editing = !!existing;
  const requestId = newRequestId();
  const catOptions = cats.map((c) => '<option value="' + esc(c.category_id) + '">' + esc(c.name) + '</option>').join('');
  const itemRow = () => '<div class="item-row"><select name="item_category" aria-label="Category">' + catOptions + '</select>' +
    '<input type="text" name="item_description" placeholder="Description (e.g. picture books)" maxlength="300" aria-label="Item description">' +
    '<input type="number" name="item_quantity" min="1" step="1" placeholder="Qty" aria-label="Quantity">' +
    '<input type="number" name="item_value" min="0" step="0.01" placeholder="Est. value $" aria-label="Estimated value (optional)">' +
    '<button type="button" class="btn-link" data-remove-item aria-label="Remove item">×</button></div>';
  const showAmounts = canDo('donors.view_contact');

  openModal({
    title: editing ? 'Edit donation' : 'Record donation',
    submitLabel: editing ? 'Save changes' : 'Save donation',
    body:
      '<label for="dn-donor">Donor</label><select id="dn-donor" name="donor_id"><option value="">— No donor record —</option>' +
      donors.map((x) => '<option value="' + esc(x.id) + '"' + (x.id === d.donor_id ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select>' +
      '<p class="field-hint">Not listed? Add them first under <a href="#/donors">Donors</a>. Anonymous gifts don’t need a donor record.</p>' +
      '<label class="check-label"><input type="checkbox" name="is_anonymous"' + (d.is_anonymous ? ' checked' : '') + '> <span>Anonymous: never credit this donor publicly</span></label>' +
      '<div class="m-grid"><div><label for="dn-date">Date received *</label><input type="date" id="dn-date" name="received_on" max="' + today() + '" value="' + esc(d.received_on || today()) + '" required></div>' +
      '<div><label for="dn-type">Type *</label><select id="dn-type" name="donation_type"' + (editing ? ' disabled' : '') + '>' +
      selectOptions({ in_kind: 'Items (in-kind)', monetary: 'Money' }, d.donation_type || 'in_kind') + '</select></div></div>' +
      '<label class="check-label"><input type="checkbox" name="is_historical"' + (d.is_historical ? ' checked' : '') + '> <span>Historical entry (recorded after the fact)</span></label>' +
      '<div id="dn-money"><div class="m-grid"><div><label for="dn-amount">Amount *</label><input type="number" id="dn-amount" name="amount" min="0.01" step="0.01" value="' + esc(d.amount == null ? '' : d.amount) + '"></div>' +
      '<div><label for="dn-method">Received by *</label><select id="dn-method" name="payment_method"><option value="">Choose…</option>' + selectOptions(PAYMENT_LABELS, d.payment_method) + '</select></div></div></div>' +
      '<div id="dn-items">' + (editing ? '<p class="field-hint">Items can’t be changed after saving. To fix them, void this donation and re-enter it, or record an inventory correction.</p>'
        : '<label>Items *</label><div id="item-rows">' + itemRow() + '</div><button type="button" class="btn-link" id="add-item">+ Add another item</button>' +
        (showAmounts ? '<label for="dn-ev">Estimated total value (internal only)</label><input type="number" id="dn-ev" name="estimated_value" min="0" step="0.01">' +
          '<p class="field-hint">Estimates are for your records. They’re never printed on thank-you letters.</p>' : '')) + '</div>' +
      '<label for="dn-restr">Restriction</label><select id="dn-restr" name="restriction">' + selectOptions({ unrestricted: 'Unrestricted', restricted: 'Restricted by the donor' }, d.restriction || 'unrestricted') + '</select>' +
      '<div id="dn-purpose"><label for="dn-purp">How the gift is restricted *</label><input type="text" id="dn-purp" name="restriction_purpose" maxlength="500" value="' + esc(d.restriction_purpose || '') + '"></div>' +
      '<label for="dn-desc">Description</label><input type="text" id="dn-desc" name="description" maxlength="1000" value="' + esc(d.description || '') + '">' +
      '<label for="dn-notes">Notes (internal)</label><textarea id="dn-notes" name="notes" rows="2" maxlength="2000">' + esc(d.notes || '') + '</textarea>' +
      '<div id="dn-dup" hidden><label class="check-label"><input type="checkbox" name="confirm_duplicate"> <span>This is a separate gift, not a duplicate</span></label></div>',
    onOpen: (body) => {
      const type = body.querySelector('#dn-type');
      const sync = () => {
        const money = type.value === 'monetary';
        body.querySelector('#dn-money').hidden = !money || (editing && !showAmounts);
        body.querySelector('#dn-items').hidden = money;
        body.querySelector('#dn-purpose').hidden = body.querySelector('#dn-restr').value !== 'restricted';
      };
      type.addEventListener('change', sync);
      body.querySelector('#dn-restr').addEventListener('change', sync);
      const add = body.querySelector('#add-item');
      if (add) add.addEventListener('click', () => body.querySelector('#item-rows').insertAdjacentHTML('beforeend', itemRow()));
      body.addEventListener('click', (e) => {
        if (e.target.matches('[data-remove-item]') && body.querySelectorAll('.item-row').length > 1) e.target.closest('.item-row').remove();
      });
      sync();
    },
    onSubmit: async (f) => {
      const body = document.getElementById('modal-body');
      const payload = {
        donor_id: f.donor_id || null, is_anonymous: f.is_anonymous, received_on: f.received_on, is_historical: f.is_historical,
        restriction: f.restriction, restriction_purpose: f.restriction_purpose, description: f.description, notes: f.notes
      };
      if (!editing) {
        payload.donation_type = f.donation_type;
        payload.request_id = requestId;
        payload.confirm_duplicate = f.confirm_duplicate === true;
      }
      const type = editing ? d.donation_type : f.donation_type;
      if (type === 'monetary' && (!editing || showAmounts)) { payload.amount = f.amount; payload.payment_method = f.payment_method; }
      if (type === 'in_kind' && !editing) {
        payload.items = Array.from(body.querySelectorAll('.item-row')).map((row) => ({
          category_id: row.querySelector('[name=item_category]').value,
          description: row.querySelector('[name=item_description]').value,
          quantity: Number(row.querySelector('[name=item_quantity]').value),
          estimated_value: row.querySelector('[name=item_value]').value
        }));
        if (showAmounts) payload.estimated_value = f.estimated_value;
      }
      const res = editing
        ? await api('admin/donations?id=' + encodeURIComponent(d.id), { method: 'PATCH', body: payload })
        : await api('admin/donations', { method: 'POST', body: payload });
      if (res.status === 409 && res.data.possible_duplicate) body.querySelector('#dn-dup').hidden = false;
      if (res.ok) {
        inventoryCategories = [];
        toast(editing ? 'Donation updated.' : res.data.repeated ? 'Already saved.' : 'Donation recorded.');
        reload();
      }
      return res;
    }
  });
}

async function viewDonation(id) {
  loading('Loading donation…');
  const res = await api('admin/donations?id=' + encodeURIComponent(id || ''));
  if (!res.ok) return errorState(res.data.error, () => viewDonation(id));
  const { donation: d, donor, items, documents, acknowledgments } = res.data;
  const manage = canDo('donations.manage') && d.status !== 'void';
  const kv = (pairs) => '<dl class="kv">' + pairs.filter(Boolean).map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>').join('') + '</dl>';

  main.innerHTML = '<p class="breadcrumb"><a href="#/donations">← Donations</a></p>' +
    '<div class="view-header"><div><h1>' + (d.donation_type === 'monetary' ? 'Monetary gift' : 'In-kind gift') + ' · ' + fmtDate(d.received_on) + '</h1>' +
    '<p class="header-badges">' + (d.status === 'void' ? '<span class="badge badge-muted">Void</span>' : '<span class="badge badge-ok">Recorded</span>') +
    (d.is_anonymous ? ' <span class="badge badge-muted">Anonymous</span>' : '') + (d.is_historical ? ' <span class="badge badge-blue">Historical entry</span>' : '') +
    (d.restriction === 'restricted' ? ' <span class="badge badge-warn">Restricted</span>' : '') + '</p></div>' +
    '<div class="action-row">' + (manage ? '<button type="button" class="btn btn-secondary btn-sm" id="edit-don">Edit</button><button type="button" class="btn btn-secondary btn-sm" id="void-don">Void</button>' : '') + '</div></div>' +
    '<div class="detail-grid">' +
    '<section class="panel"><h2>Gift</h2>' + kv([
      ['Received', fmtDate(d.received_on)],
      d.donation_type === 'monetary' ? ['Amount', 'amount' in d ? fmtMoney(d.amount) + (d.payment_method ? ' · ' + esc(PAYMENT_LABELS[d.payment_method]) : '') : '<span class="muted-text">Hidden</span>'] : null,
      d.donation_type === 'in_kind' && 'estimated_value' in d ? ['Estimated value', fmtMoney(d.estimated_value) + ' <span class="muted-text small">(internal only)</span>'] : null,
      ['Restriction', d.restriction === 'restricted' ? 'Restricted: ' + esc(d.restriction_purpose) : 'Unrestricted'],
      d.description ? ['Description', esc(d.description)] : null,
      d.notes ? ['Notes', esc(d.notes)] : null,
      d.status === 'void' ? ['Void reason', esc(d.void_reason)] : null,
      ['Recorded', fmtDateTime(d.created_at)]
    ]) + '</section>' +
    '<section class="panel"><h2>Donor</h2>' + (donor ? kv([
      ['Name', esc(donor.name) + ' <span class="muted-text small">(' + (donor.donor_type === 'organization' ? 'organization' : 'individual') + ')</span>'],
      'email' in donor ? ['Email', esc(donor.email || '—')] : null,
      'phone' in donor ? ['Phone', esc(donor.phone || '—')] : null,
      'address_line1' in donor ? ['Address', esc([donor.address_line1, donor.address_line2, [donor.city, donor.state, donor.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '—')] : null
    ]) : emptyState('No donor record (anonymous gift).')) + '</section>' +
    (items.length ? '<section class="panel panel-wide"><h2>Items</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>Category</th><th>Description</th><th>Quantity</th>' +
      (items.some((i) => 'estimated_value' in i) ? '<th>Est. value</th>' : '') + '</tr></thead><tbody>' +
      items.map((i) => '<tr><td>' + esc(i.category_name) + '</td><td>' + esc(i.description) + '</td><td>' + esc(i.quantity) + '</td>' +
        ('estimated_value' in i ? '<td>' + fmtMoney(i.estimated_value) + '</td>' : '') + '</tr>').join('') + '</tbody></table></div>' +
      '<p class="field-hint">These items were added to inventory when the donation was recorded.</p></section>' : '') +
    '<section class="panel panel-wide"><div class="panel-head"><h2>Supporting documents</h2>' +
    (manage ? '<label class="btn btn-secondary btn-sm file-btn">Upload file<input type="file" id="doc-file" accept="application/pdf,image/jpeg,image/png,image/webp" hidden></label>' : '') + '</div>' +
    (documents.length ? '<ul class="letter-list">' + documents.map((doc) => '<li><button type="button" class="btn-link" data-doc="' + esc(doc.id) + '">' + esc(doc.file_name) + '</button> <span class="muted-text small">' +
      Math.ceil(doc.size_bytes / 1024) + ' KB · ' + fmtDateTime(doc.uploaded_at) + '</span></li>').join('') + '</ul>' : emptyState('No documents yet. PDF, JPG, PNG, or WebP, up to 3 MB.')) + '</section>' +
    '<section class="panel panel-wide"><div class="panel-head"><h2>Thank-you letters</h2>' +
    (d.status !== 'void' && canDo('acknowledgments.manage') && !acknowledgments.some((a) => a.status !== 'void')
      ? (donor ? '<button type="button" class="btn btn-secondary btn-sm" id="new-letter">Create thank-you letter</button>' : '<span class="muted-text small">Add a donor record to send a letter</span>') : '') + '</div>' +
    (acknowledgments.length
      ? '<ul class="letter-list">' + acknowledgments.map((a) => '<li>' + (canDo('acknowledgments.view') ? '<a href="/admin/acknowledgment.html?id=' + esc(a.id) + '" target="_blank" rel="noopener">' + esc(a.letter_number) + '</a>' : esc(a.letter_number)) +
        ' ' + ackBadge(a.status) + (a.sent_on ? ' <span class="muted-text small">sent ' + fmtDate(a.sent_on) + '</span>' : '') + '</li>').join('') + '</ul>'
      : emptyState('No thank-you letter yet.')) + '</section>' +
    '</div>';

  const reload = () => viewDonation(id);
  const newLetter = document.getElementById('new-letter');
  if (newLetter) newLetter.addEventListener('click', () => openLetterForm(d.id, reload));
  const edit = document.getElementById('edit-don');
  if (edit) edit.addEventListener('click', () => openDonationForm(d, reload));
  const voidBtn = document.getElementById('void-don');
  if (voidBtn) voidBtn.addEventListener('click', () => openModal({
    title: 'Void this donation?',
    body: '<p>The record is kept but marked void. Any items it added to inventory are removed with a correction entry, so the history stays complete.</p>' +
      '<label for="vd-r">Reason *</label><textarea id="vd-r" name="reason" rows="3" required></textarea>',
    submitLabel: 'Void donation', danger: true,
    onSubmit: (f) => api('admin/void-donation', { method: 'POST', body: { id: d.id, reason: f.reason } }).then((r) => { if (r.ok) { inventoryCategories = []; toast('Donation voided.'); reload(); } return r; })
  }));
  main.querySelectorAll('[data-doc]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('admin/donation-document-link?id=' + encodeURIComponent(b.dataset.doc));
    if (r.ok) window.open(r.data.url, '_blank', 'noopener'); else toast(r.data.error, 'bad');
  }));
  const file = document.getElementById('doc-file');
  if (file) file.addEventListener('change', () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 3 * 1024 * 1024) return toast('Files must be 3 MB or smaller.', 'bad');
    const reader = new FileReader();
    reader.onload = async () => {
      toast('Uploading…', 'warn');
      const data = String(reader.result).split(',')[1];
      const r = await api('admin/donation-document', { method: 'POST', body: { donation_id: d.id, file_name: f.name, content_type: f.type, data: data } });
      if (r.ok) { toast('Document uploaded.'); reload(); } else toast(r.data.error + (r.data.errors ? ' ' + Object.values(r.data.errors).join(' ') : ''), 'bad');
    };
    reader.readAsDataURL(f);
  });
}

async function viewDonors() {
  loading('Loading donors…');
  const res = await api('admin/donors');
  if (!res.ok) return errorState(res.data.error, viewDonors);
  const rows = res.data.donors;
  const contact = canDo('donors.view_contact');
  main.innerHTML = '<p class="breadcrumb"><a href="#/donations">← Donations</a></p><div class="view-header"><h1>Donors</h1>' +
    (canDo('donations.manage') ? '<button type="button" class="btn btn-primary btn-sm" id="new-donor">Add donor</button>' : '') + '</div>' +
    (rows.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Type</th>' + (contact ? '<th>Email</th><th>Phone</th>' : '') +
      '<th>Gifts</th><th>Last gift</th><th></th></tr></thead><tbody>' +
      rows.map((x) => '<tr><td><a href="#/donations" data-donor-filter="' + esc(x.id) + '">' + esc(x.name) + '</a></td><td>' + (x.donor_type === 'organization' ? 'Organization' : 'Individual') + '</td>' +
        (contact ? '<td>' + esc(x.email || '—') + '</td><td>' + esc(x.phone || '—') + '</td>' : '') +
        '<td>' + esc(x.donation_count) + '</td><td>' + fmtDate(x.last_donation_on) + '</td>' +
        '<td>' + (contact && canDo('donations.manage') ? '<button type="button" class="btn-link" data-edit-donor="' + esc(x.id) + '">Edit</button>' : '') + '</td></tr>').join('') +
      '</tbody></table></div>' : emptyState('No donors yet. Add a donor before recording their gift.'));

  const form = (x) => '<label for="dr-type">Type</label><select id="dr-type" name="donor_type">' + selectOptions({ individual: 'Individual', organization: 'Organization or business' }, x.donor_type || 'individual') + '</select>' +
    '<label for="dr-name">Name *</label><input type="text" id="dr-name" name="name" maxlength="160" required value="' + esc(x.name || '') + '">' +
    '<label for="dr-cn">Contact person (organizations)</label><input type="text" id="dr-cn" name="contact_name" maxlength="120" value="' + esc(x.contact_name || '') + '">' +
    '<div class="m-grid"><div><label for="dr-email">Email</label><input type="email" id="dr-email" name="email" value="' + esc(x.email || '') + '"></div>' +
    '<div><label for="dr-phone">Phone</label><input type="tel" id="dr-phone" name="phone" value="' + esc(x.phone || '') + '"></div></div>' +
    '<label for="dr-a1">Mailing address</label><input type="text" id="dr-a1" name="address_line1" maxlength="160" placeholder="Street" value="' + esc(x.address_line1 || '') + '">' +
    '<input type="text" name="address_line2" maxlength="160" placeholder="Apt, suite (optional)" aria-label="Address line 2" value="' + esc(x.address_line2 || '') + '">' +
    '<div class="m-grid"><div><input type="text" name="city" maxlength="80" placeholder="City" aria-label="City" value="' + esc(x.city || '') + '"></div>' +
    '<div class="m-grid"><input type="text" name="state" maxlength="40" placeholder="State" aria-label="State" value="' + esc(x.state || '') + '"><input type="text" name="postal_code" maxlength="20" placeholder="ZIP" aria-label="ZIP code" value="' + esc(x.postal_code || '') + '"></div></div>' +
    '<label for="dr-notes">Notes (internal)</label><textarea id="dr-notes" name="notes" rows="2" maxlength="2000">' + esc(x.notes || '') + '</textarea>';

  const add = document.getElementById('new-donor');
  if (add) add.addEventListener('click', () => openModal({
    title: 'Add donor', body: form({}), submitLabel: 'Add donor',
    onSubmit: (f) => api('admin/donors', { method: 'POST', body: f }).then((r) => { if (r.ok) { toast('Donor added.'); viewDonors(); } return r; })
  }));
  main.querySelectorAll('[data-edit-donor]').forEach((b) => b.addEventListener('click', () => {
    const x = rows.find((r) => r.id === b.dataset.editDonor);
    openModal({
      title: 'Edit donor', body: form(x),
      onSubmit: (f) => api('admin/donors?id=' + encodeURIComponent(x.id), { method: 'PATCH', body: f }).then((r) => { if (r.ok) { toast('Donor updated.'); viewDonors(); } return r; })
    });
  }));
}

/* ---------- Donor thank-you letters ---------- */

const ACK_STATUS = { draft: ['Draft', 'badge-warn'], ready: ['Ready to send', 'badge-blue'], sent: ['Sent', 'badge-ok'], void: ['Void', 'badge-muted'] };

function ackBadge(status) {
  const s = ACK_STATUS[status] || [status, 'badge-muted'];
  return '<span class="badge ' + s[1] + '">' + esc(s[0]) + '</span>';
}

function openLetterForm(donationId, reload) {
  openModal({
    title: 'Create thank-you letter',
    submitLabel: 'Create draft',
    body: '<p>The draft is filled in from the donation and donor records. You can review and edit the wording before finalizing. Nothing is sent.</p>' +
      '<label for="ak-src">How was the gift made?</label><select id="ak-src" name="special_source">' + selectOptions({
        none: 'Standard gift', daf: 'Donor-advised fund grant', ira: 'IRA / retirement account distribution', services: 'Donated services',
        vehicle: 'Vehicle', securities: 'Stock, securities, or cryptocurrency', real_property: 'Real estate or other property needing appraisal'
      }, 'none') + '</select>' +
      '<p class="field-hint" id="ak-hint" hidden>Gifts like this get a thank-you without tax wording. Check with your accountant about what this donor needs.</p>' +
      '<fieldset class="perm-group" id="ak-gs"><legend>Did the donor receive anything in return?</legend>' +
      '<label class="check-label"><input type="radio" name="goods_services" value="none" checked> <span>No, nothing was provided</span></label>' +
      '<label class="check-label"><input type="radio" name="goods_services" value="provided"> <span>Yes, goods or services were provided</span></label>' +
      '<div id="ak-gs-detail" hidden><label for="ak-gsd">What did they receive?</label><input type="text" id="ak-gsd" name="goods_services_description" maxlength="300" placeholder="e.g. two event dinner tickets">' +
      '<label for="ak-gsv">Its fair market value ($)</label><input type="number" id="ak-gsv" name="goods_services_value" min="0" step="0.01">' +
      '<p class="field-hint">You can add the value later, but the letter can’t be finalized without it.</p></div></fieldset>',
    onOpen: (body) => {
      const sync = () => {
        const standard = body.querySelector('#ak-src').value === 'none';
        body.querySelector('#ak-gs').hidden = !standard;
        body.querySelector('#ak-hint').hidden = standard;
        body.querySelector('#ak-gs-detail').hidden = (body.querySelector('input[name=goods_services]:checked') || {}).value !== 'provided';
      };
      body.addEventListener('change', sync);
      sync();
    },
    onSubmit: (f) => api('admin/acknowledgments', { method: 'POST', body: {
      donation_id: donationId, special_source: f.special_source, goods_services: f.goods_services,
      goods_services_description: f.goods_services_description, goods_services_value: f.goods_services_value
    } }).then((r) => {
      if (r.ok) {
        toast('Draft letter created.');
        window.open('/admin/acknowledgment.html?id=' + encodeURIComponent(r.data.acknowledgment.id), '_blank', 'noopener');
        reload();
      } else if (r.status === 409 && r.data.acknowledgment_id) {
        window.open('/admin/acknowledgment.html?id=' + encodeURIComponent(r.data.acknowledgment_id), '_blank', 'noopener');
      }
      return r;
    })
  });
}

async function viewAcknowledgments() {
  loading('Loading thank-you letters…');
  const tab = sessionStorage.getItem('ack.tab') || 'pending';
  const res = await api('admin/acknowledgments');
  if (!res.ok) return errorState(res.data.error, viewAcknowledgments);
  const { pending, letters } = res.data;
  const counts = {
    pending: pending.length,
    draft: letters.filter((l) => l.status === 'draft').length,
    ready: letters.filter((l) => l.status === 'ready').length,
    sent: letters.filter((l) => l.status === 'sent').length,
    void: letters.filter((l) => l.status === 'void').length
  };
  const TABS = { pending: 'Needs a letter', draft: 'Drafts', ready: 'Ready to send', sent: 'Sent', void: 'Void' };
  const manage = canDo('acknowledgments.manage');

  let list;
  if (tab === 'pending') {
    list = pending.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Received</th><th>Donor</th><th>Type</th><th></th></tr></thead><tbody>' +
      pending.map((p) => '<tr><td class="nowrap"><a href="#/donation/' + esc(p.donation_id) + '">' + fmtDate(p.received_on) + '</a>' + (p.is_historical ? '<div class="muted-text small">Historical</div>' : '') + '</td>' +
        '<td>' + (p.donor_name ? esc(p.donor_name) : '<span class="muted-text">No donor record</span>') + '</td>' +
        '<td>' + (p.donation_type === 'monetary' ? 'Money' : 'Items') + '</td>' +
        '<td class="actions-cell">' + (manage && p.can_generate ? '<button type="button" class="btn btn-secondary btn-xs" data-new-letter="' + esc(p.donation_id) + '">Create letter</button>'
          : (!p.can_generate ? '<span class="muted-text small">Anonymous with no donor record: no one to address</span>' : '')) + '</td></tr>').join('') +
      '</tbody></table></div>' : emptyState('Every recorded donation has a thank-you letter.');
  } else {
    const rows = letters.filter((l) => l.status === tab);
    list = rows.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Letter</th><th>Donor</th><th>Gift received</th><th>Status</th><th>Dates</th></tr></thead><tbody>' +
      rows.map((l) => '<tr><td><a href="/admin/acknowledgment.html?id=' + esc(l.id) + '" target="_blank" rel="noopener">' + esc(l.letter_number) + '</a></td>' +
        '<td>' + esc(l.donor_name) + '</td><td>' + fmtDate(l.received_on) + '</td><td>' + ackBadge(l.status) + '</td>' +
        '<td class="small">Created ' + fmtDate(l.generated_at) + (l.issue_date ? '<br>Dated ' + fmtDate(l.issue_date) : '') +
        (l.sent_on ? '<br>Sent ' + fmtDate(l.sent_on) + ' · ' + esc({ mail: 'mail', email: 'email', in_person: 'in person', other: 'other' }[l.sent_method] || '') : '') + '</td></tr>').join('') +
      '</tbody></table></div>' : emptyState('No letters here.');
  }

  main.innerHTML = '<div class="view-header"><h1>Thank-you Letters</h1></div>' +
    '<p class="field-hint">Letters are never sent automatically. Create a draft, review and edit it, finalize and sign it, print or save it as a PDF and send it yourself, then record it as sent.</p>' +
    '<div class="segmented" role="group" aria-label="Filter letters">' + Object.keys(TABS).map((k) =>
      '<button type="button" data-tab="' + k + '" aria-pressed="' + (k === tab) + '">' + esc(TABS[k]) + ' (' + counts[k] + ')</button>').join('') + '</div>' +
    '<div class="ack-list">' + list + '</div>' +
    (canDo('acknowledgments.sign') ? '<section class="panel" id="sig-panel"><h2>Your digital signature</h2><div id="sig-body"><span class="spinner" aria-hidden="true"></span></div></section>' : '');

  main.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { sessionStorage.setItem('ack.tab', b.dataset.tab); viewAcknowledgments(); }));
  main.querySelectorAll('[data-new-letter]').forEach((b) => b.addEventListener('click', () => openLetterForm(b.dataset.newLetter, viewAcknowledgments)));
  if (canDo('acknowledgments.sign')) renderSignaturePanel();
}

async function renderSignaturePanel() {
  const box = document.getElementById('sig-body');
  const res = await api('admin/signature');
  if (!res.ok) { box.textContent = res.data.error || 'Could not load your signature.'; return; }
  box.innerHTML = '<p class="field-hint">Optional. When you finalize a letter, you choose each time whether to use this image or leave space to sign by hand. Replacing it never changes letters already finalized.</p>' +
    (res.data.has_signature ? '<img class="sig-preview" alt="Your saved signature" src="' + res.data.data_url + '">' : emptyState('No signature uploaded. Letters will leave space for a handwritten signature.')) +
    '<div class="action-row"><label class="btn btn-secondary btn-sm file-btn">' + (res.data.has_signature ? 'Replace signature' : 'Upload signature') +
    '<input type="file" id="sig-file" accept="image/png,image/jpeg" hidden></label>' +
    (res.data.has_signature ? '<button type="button" class="btn-link" id="sig-remove">Remove</button>' : '') + '</div>' +
    '<p class="field-hint">PNG or JPG, 500 KB or smaller. A signature on white or transparent paper works best.</p>';
  document.getElementById('sig-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 500 * 1024) return toast('Signature images must be 500 KB or smaller.', 'bad');
    const reader = new FileReader();
    reader.onload = async () => {
      const r = await api('admin/signature', { method: 'POST', body: { content_type: f.type, data: String(reader.result).split(',')[1] } });
      if (r.ok) { toast('Signature saved.'); renderSignaturePanel(); } else toast(r.data.error + (r.data.errors ? ' ' + Object.values(r.data.errors).join(' ') : ''), 'bad');
    };
    reader.readAsDataURL(f);
  });
  const rm = document.getElementById('sig-remove');
  if (rm) rm.addEventListener('click', () => openModal({
    title: 'Remove your signature?', body: '<p>Letters already finalized keep their signature. New letters will leave space to sign by hand.</p>',
    submitLabel: 'Remove', danger: true,
    onSubmit: () => api('admin/signature', { method: 'POST', body: { remove: true } }).then((r) => { if (r.ok) { toast('Signature removed.'); renderSignaturePanel(); } return r; })
  }));
}

/* ---------- Inventory ---------- */

async function viewInventory() {
  loading('Loading inventory…');
  const cat = sessionStorage.getItem('inv.cat') || '';
  const [sumRes, histRes] = await Promise.all([
    api('admin/inventory'),
    api('admin/inventory-history' + (cat ? '?category_id=' + encodeURIComponent(cat) : ''))
  ]);
  if (!sumRes.ok) return errorState(sumRes.data.error, viewInventory);
  if (!histRes.ok) return errorState(histRes.data.error, viewInventory);
  const cats = sumRes.data.categories;
  inventoryCategories = cats;
  const txns = histRes.data.transactions;

  main.innerHTML = '<div class="view-header"><h1>Inventory</h1><div class="action-row">' +
    (canDo('records.export') ? '<a class="btn btn-secondary btn-sm" download href="/api/admin/inventory-export' + (cat ? '?category_id=' + encodeURIComponent(cat) : '') + '">Export CSV</a>' : '') +
    (canDo('inventory.adjust') ? '<button type="button" class="btn btn-secondary btn-sm" id="inv-open">Opening balance</button><button type="button" class="btn btn-secondary btn-sm" id="inv-adj">Correct a count</button>' : '') +
    (canDo('inventory.record') ? '<button type="button" class="btn btn-primary btn-sm" id="inv-dist">Record distribution</button>' : '') +
    '</div></div>' +
    '<p class="field-hint">Donated items are added automatically when you record a donation. Stock can never go below zero.</p>' +
    '<div class="stat-grid inv-grid">' + cats.map((c) => '<div class="stat-card stat-blue inv-card"><span class="stat-value">' + esc(c.on_hand) + '</span>' +
      '<span class="stat-label">' + esc(c.name) + ' on hand</span><span class="inv-breakdown">' +
      (c.has_opening_balance ? c.opening_balance + ' opening · ' : '') + c.received + ' received · ' + c.distributed + ' distributed' +
      (c.adjustments ? ' · ' + (c.adjustments > 0 ? '+' : '') + c.adjustments + ' corrected' : '') + '</span></div>').join('') + '</div>' +
    '<section class="panel"><div class="panel-head"><h2>History</h2><label class="sr-only" for="inv-cat">Category</label><select id="inv-cat">' +
    '<option value="">All categories</option>' + cats.map((c) => '<option value="' + esc(c.category_id) + '"' + (c.category_id === cat ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</select></div>' +
    (txns.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Category</th><th>Type</th><th>Qty</th><th>Details</th><th>Recorded by</th></tr></thead><tbody>' +
      txns.map((t) => '<tr><td class="nowrap">' + fmtDate(t.occurred_on) + (t.is_historical ? '<div class="muted-text small">Historical</div>' : '') + '</td>' +
        '<td>' + esc(t.category_name) + '</td><td>' + esc(TXN_LABELS[t.txn_type] || t.txn_type) + '</td>' +
        '<td class="nowrap"><strong class="' + (t.quantity < 0 ? 'qty-out' : 'qty-in') + '">' + (t.quantity > 0 ? '+' : '') + esc(t.quantity) + '</strong></td>' +
        '<td class="wrap">' + [t.item_description ? (t.donation_id ? '<a href="#/donation/' + esc(t.donation_id) + '">' + esc(t.item_description) + '</a>' : esc(t.item_description)) : '',
          t.event_name ? 'Event: ' + esc(t.event_name) : '', t.reason ? 'Reason: ' + esc(t.reason) : '', t.notes ? esc(t.notes) : ''].filter(Boolean).join('<br>') + '</td>' +
        '<td class="small">' + esc(t.recorded_by_name) + '</td></tr>').join('') + '</tbody></table></div>'
      : emptyState('No inventory activity yet. Set opening balances for items you already have, or record a donation.')) + '</section>';

  document.getElementById('inv-cat').addEventListener('change', (e) => { sessionStorage.setItem('inv.cat', e.target.value); viewInventory(); });
  const catSelect = (name) => '<select id="iv-cat" name="' + name + '">' + cats.map((c) => '<option value="' + esc(c.category_id) + '">' + esc(c.name) + ' (' + c.on_hand + ' on hand)</option>').join('') + '</select>';
  const done = (msg) => (r) => { if (r.ok) { toast(msg); viewInventory(); } return r; };

  const dist = document.getElementById('inv-dist');
  if (dist) dist.addEventListener('click', async () => {
    const evRes = await api('admin/program-events');
    const events = evRes.ok ? evRes.data.events : [];
    const requestId = newRequestId();
    openModal({
      title: 'Record distribution', submitLabel: 'Record distribution',
      body: '<label for="iv-cat">Category *</label>' + catSelect('category_id') +
        '<div class="m-grid"><div><label for="iv-q">Quantity given out *</label><input type="number" id="iv-q" name="quantity" min="1" step="1" required></div>' +
        '<div><label for="iv-d">Date *</label><input type="date" id="iv-d" name="occurred_on" max="' + today() + '" value="' + today() + '" required></div></div>' +
        '<label for="iv-ev">Event</label><select id="iv-ev" name="event_id"><option value="">— Not at an event —</option>' +
        events.map((e) => '<option value="' + esc(e.id) + '">' + esc(e.name) + ' · ' + fmtDate(e.event_date) + '</option>').join('') + '<option value="__new">+ Add a new event…</option></select>' +
        '<div id="iv-new" hidden class="m-grid"><div><label for="iv-en">Event name *</label><input type="text" id="iv-en" name="event_name" maxlength="200"></div>' +
        '<div><label for="iv-ed">Event date *</label><input type="date" id="iv-ed" name="event_date"></div>' +
        '<div><label for="iv-ep">Our role</label><select id="iv-ep" name="participation">' + selectOptions(PARTICIPATION_LABELS, 'exhibited') + '</select></div>' +
        '<div><label for="iv-el">Location</label><input type="text" id="iv-el" name="event_location" maxlength="300"></div></div>' +
        '<label class="check-label"><input type="checkbox" name="is_historical"> <span>Historical entry (recorded after the fact)</span></label>' +
        '<label for="iv-n">Notes</label><textarea id="iv-n" name="notes" rows="2" maxlength="1000"></textarea>',
      onOpen: (body) => {
        const sel = body.querySelector('#iv-ev');
        sel.addEventListener('change', () => { body.querySelector('#iv-new').hidden = sel.value !== '__new'; });
      },
      onSubmit: async (f) => {
        let eventId = f.event_id || null;
        if (eventId === '__new') {
          const ev = await api('admin/program-events', { method: 'POST', body: { name: f.event_name, event_date: f.event_date, participation: f.participation, location: f.event_location } });
          if (!ev.ok) return ev;
          eventId = ev.data.event.id;
        }
        return api('admin/inventory-distribute', { method: 'POST', body: {
          category_id: f.category_id, quantity: Number(f.quantity), occurred_on: f.occurred_on, event_id: eventId,
          notes: f.notes, is_historical: f.is_historical, request_id: requestId
        } }).then(done('Distribution recorded.'));
      }
    });
  });

  const opening = document.getElementById('inv-open');
  if (opening) opening.addEventListener('click', () => {
    const open = cats.filter((c) => !c.has_opening_balance);
    if (!open.length) return toast('Every category already has an opening balance. Use “Correct a count” instead.', 'warn');
    openModal({
      title: 'Set opening balance', submitLabel: 'Save opening balance',
      body: '<p>Use this once per category for items you already had before this system, so stock starts at the right number.</p>' +
        '<label for="iv-cat">Category *</label><select id="iv-cat" name="category_id">' + open.map((c) => '<option value="' + esc(c.category_id) + '">' + esc(c.name) + '</option>').join('') + '</select>' +
        '<div class="m-grid"><div><label for="iv-q">Quantity on hand *</label><input type="number" id="iv-q" name="quantity" min="1" step="1" required></div>' +
        '<div><label for="iv-d">As of *</label><input type="date" id="iv-d" name="occurred_on" max="' + today() + '" value="' + today() + '" required></div></div>' +
        '<label for="iv-n">Notes</label><textarea id="iv-n" name="notes" rows="2" maxlength="1000" placeholder="e.g. Counted at the office"></textarea>',
      onSubmit: (f) => api('admin/inventory-opening', { method: 'POST', body: { category_id: f.category_id, quantity: Number(f.quantity), occurred_on: f.occurred_on, notes: f.notes } }).then(done('Opening balance saved.'))
    });
  });

  const adj = document.getElementById('inv-adj');
  if (adj) adj.addEventListener('click', () => {
    const requestId = newRequestId();
    openModal({
      title: 'Correct a count', submitLabel: 'Save correction',
      body: '<p>Use this when a physical count doesn’t match. Enter a positive number to add items or a negative number to remove them.</p>' +
        '<label for="iv-cat">Category *</label>' + catSelect('category_id') +
        '<div class="m-grid"><div><label for="iv-q">Change (+ or −) *</label><input type="number" id="iv-q" name="quantity" step="1" required></div>' +
        '<div><label for="iv-d">Date *</label><input type="date" id="iv-d" name="occurred_on" max="' + today() + '" value="' + today() + '" required></div></div>' +
        '<label for="iv-r">Reason *</label><textarea id="iv-r" name="reason" rows="2" maxlength="1000" required placeholder="e.g. Recount found 3 damaged books"></textarea>',
      onSubmit: (f) => api('admin/inventory-adjust', { method: 'POST', body: { category_id: f.category_id, quantity: Number(f.quantity), occurred_on: f.occurred_on, reason: f.reason, request_id: requestId } }).then(done('Correction saved.'))
    });
  });
}

/* ---------- Community impact ---------- */

const QUAL_OPTIONS = { exact: 'Exact', approximate: 'About (approximate)', estimated: 'Estimated', minimum: 'Or more (e.g. 200+)' };
const QUAL_SHORT = { exact: 'Exact', approximate: 'About', estimated: 'Est.', minimum: 'Or more' };
const SUMMARY_METRICS = ['children_served', 'families_served', 'books_distributed', 'clothing_distributed', 'supplies_distributed',
  'game_participants', 'events_hosted', 'events_attended', 'volunteer_hours', 'monetary_donations', 'in_kind_donations'];

function impactParams() {
  const preset = sessionStorage.getItem('imp.preset') || 'year';
  const p = new URLSearchParams({ preset });
  if (preset === 'year') p.set('year', sessionStorage.getItem('imp.year') || String(new Date().getFullYear()));
  if (preset === 'custom') { p.set('from', sessionStorage.getItem('imp.from') || ''); p.set('to', sessionStorage.getItem('imp.to') || ''); }
  return p;
}

function qBadge(q) {
  return '<span class="q-badge q-' + esc(q) + '">' + esc(QUAL_SHORT[q] || q) + '</span>';
}

function impactTile(m) {
  if (m.hidden) return '<div class="impact-tile tile-empty"><span class="impact-tile-value">Hidden</span><span class="impact-tile-label">' + esc(m.label) + '</span><span class="impact-tile-meta">Needs access to donation amounts</span></div>';
  return '<div class="impact-tile' + (m.has_data ? '' : ' tile-empty') + '"><span class="impact-tile-value">' + (m.has_data ? esc(chartFigure(m.value, m.qualifier, m.unit)) : '—') + '</span>' +
    '<span class="impact-tile-label">' + esc(m.label) + (m.has_data ? qBadge(m.qualifier) : '') + '</span>' +
    '<span class="impact-tile-meta">' + (m.has_data
      ? (m.key === 'monetary_donations' ? m.gift_count + ' gift' + (m.gift_count === 1 ? '' : 's') : m.key === 'in_kind_donations' ? (m.items_received || 0) + ' items received' : '') +
        (m.baseline ? ' Includes starting total through ' + fmtDate(m.baseline.as_of) + '.' : '') + (m.engagement ? ' Engagements, not unique people.' : '')
      : 'No records yet') + '</span></div>';
}

async function loadWebsiteEvents() {
  const read = () => { try { return BLF_EVENTS; } catch (e) { return null; } }; // eslint-disable-line no-undef
  if (read()) return read();
  await new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = '/events-data.js';
    s.onload = resolve;
    s.onerror = resolve;
    document.head.appendChild(s);
  });
  return read() || [];
}

async function viewImpact() {
  loading('Loading community impact…');
  const params = impactParams();
  const preset = params.get('preset');
  const year = params.get('year') || String(new Date().getFullYear());
  const metric = sessionStorage.getItem('imp.metric') || 'children_served';
  const trendQ = new URLSearchParams({ metric });
  if (preset === 'year') { trendQ.set('from', year + '-01-01'); trendQ.set('to', year === String(new Date().getFullYear()) ? today() : year + '-12-31'); }
  if (preset === 'custom') { trendQ.set('from', params.get('from')); trendQ.set('to', params.get('to')); }

  const [rep, yoy, trend] = await Promise.all([
    api('admin/impact-report?' + params),
    api('admin/impact-yoy?year=' + encodeURIComponent(preset === 'year' ? year : String(new Date().getFullYear()))),
    api('admin/impact-trend?' + trendQ)
  ]);
  if (!rep.ok) return errorState(rep.data.error, viewImpact);
  const r = rep.data;
  const PRESETS = { month: 'This month', quarter: 'This quarter', year: 'Year', all: 'All time', custom: 'Custom' };
  const years = {};
  for (let y = new Date().getFullYear(); y >= 2024; y--) years[String(y)] = String(y);
  const skipped = r.metrics.filter((m) => m.baseline_skipped);
  const metricOptions = {};
  r.metrics.filter((m) => !m.hidden).forEach((m) => { metricOptions[m.key] = m.label; });

  main.innerHTML = '<div class="view-header"><h1>Community Impact</h1><div class="action-row">' +
    '<a class="btn btn-primary btn-sm" href="/admin/impact-report.html?' + params + '" target="_blank" rel="noopener">Printable report</a>' +
    (canDo('records.export') ? '<a class="btn btn-secondary btn-sm" download href="/api/admin/impact-export?' + params + '">Export CSV</a>' : '') +
    (canDo('impact.record') ? '<button type="button" class="btn btn-secondary btn-sm" id="imp-add-event">Add event</button><button type="button" class="btn btn-secondary btn-sm" id="imp-baselines">Starting totals</button>' : '') +
    (canDo('impact.goals') ? '<button type="button" class="btn btn-secondary btn-sm" id="imp-goals">Goals</button>' : '') +
    '<a class="btn btn-secondary btn-sm" href="#/public-impact">Public website</a>' +
    '</div></div>' +
    '<div class="range-bar"><div class="segmented" role="group" aria-label="Report period">' + Object.keys(PRESETS).map((k) =>
      '<button type="button" data-preset="' + k + '" aria-pressed="' + (k === preset) + '">' + PRESETS[k] + '</button>').join('') + '</div>' +
    (preset === 'year' ? '<label class="sr-only" for="imp-year">Year</label><select id="imp-year">' + selectOptions(years, year) + '</select>' : '') +
    (preset === 'custom' ? '<label class="sr-only" for="imp-from">From</label><input type="date" id="imp-from" value="' + esc(params.get('from')) + '"> to ' +
      '<label class="sr-only" for="imp-to">To</label><input type="date" id="imp-to" value="' + esc(params.get('to')) + '"><button type="button" class="btn btn-secondary btn-sm" id="imp-apply">Apply</button>' : '') +
    '<span class="muted-text small">' + (r.range.from ? fmtDate(r.range.from) + ' – ' + fmtDate(r.range.to) : 'All recorded activity') + '</span></div>' +
    (skipped.length ? '<div class="notice-box">Starting totals recorded before the portal (through ' + fmtDate(skipped[0].baseline_skipped.as_of) +
      ') aren’t included here because this period covers only part of their span and they can’t be split by date. Choose a period that covers the whole span, or All time, to include them.</div>' : '') +
    '<section class="panel"><h2>Summary</h2>' + r.summary.map((s) => '<p>' + esc(s) + '</p>').join('') + '</section>' +
    '<div class="impact-tiles">' + r.metrics.map(impactTile).join('') + '</div>' +
    (r.goals.length ? '<section class="panel"><h2>' + esc(r.range.year) + ' goals</h2>' + goalBars(r.goals) + '</section>' : '') +
    '<section class="panel"><div class="panel-head"><h2>' + esc(trend.ok ? trend.data.metric.label : 'Monthly trend') + ' by month</h2>' +
    '<label class="sr-only" for="imp-metric">Figure</label><select id="imp-metric">' + selectOptions(metricOptions, metric) + '</select></div>' +
    (trend.ok ? columnChart(trend.data.months, { unit: trend.data.metric.unit, label: trend.data.metric.label + ' by month' }) +
      '<details><summary class="small">Show as a table</summary>' + monthTable(trend.data.months, trend.data.metric.unit) + '</details>' +
      '<p class="field-hint">Monthly charts show dated records only. Starting totals aren’t split by month.</p>' : '<p>' + esc(trend.data.error) + '</p>') + '</section>' +
    '<section class="panel"><h2>Year over year</h2>' + (yoy.ok ? yoyTable(yoy.data) : esc(yoy.data.error)) + '</section>' +
    '<section class="panel"><h2>Events</h2>' + (r.events.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Event</th><th>Our role</th><th>Children</th><th>Families</th><th>Books</th><th>Clothing</th><th></th></tr></thead><tbody>' +
      r.events.map((e) => {
        const f = (k) => e.figures[k] ? esc(chartFigure(e.figures[k].value, e.figures[k].qualifier, 'count')) : '<span class="muted-text">—</span>';
        return '<tr><td class="nowrap">' + fmtDate(e.event_date) + '</td><td><a href="#/impact-event/' + esc(e.id) + '">' + esc(e.name) + '</a></td><td>' + esc(PARTICIPATION_LABELS[e.participation] || e.participation) + '</td>' +
          '<td>' + f('children_served') + '</td><td>' + f('families_served') + '</td><td>' + f('books_distributed') + '</td><td>' + f('clothing_distributed') + '</td>' +
          '<td><a class="btn-link" href="#/impact-event/' + esc(e.id) + '">' + (canDo('impact.record') ? 'Record counts' : 'View') + '</a></td></tr>';
      }).join('') + '</tbody></table></div>' : emptyState('No events recorded in this period. Use “Add event” to record one, or import past events from the website calendar.')) + '</section>';
  applyChartWidths(main);

  main.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    sessionStorage.setItem('imp.preset', b.dataset.preset);
    if (b.dataset.preset === 'custom' && !sessionStorage.getItem('imp.from')) { sessionStorage.setItem('imp.from', String(new Date().getFullYear()) + '-01-01'); sessionStorage.setItem('imp.to', today()); }
    viewImpact();
  }));
  const ySel = document.getElementById('imp-year');
  if (ySel) ySel.addEventListener('change', () => { sessionStorage.setItem('imp.year', ySel.value); viewImpact(); });
  const apply = document.getElementById('imp-apply');
  if (apply) apply.addEventListener('click', () => {
    sessionStorage.setItem('imp.from', document.getElementById('imp-from').value);
    sessionStorage.setItem('imp.to', document.getElementById('imp-to').value);
    viewImpact();
  });
  document.getElementById('imp-metric').addEventListener('change', (e) => { sessionStorage.setItem('imp.metric', e.target.value); viewImpact(); });
  const addBtn = document.getElementById('imp-add-event');
  if (addBtn) addBtn.addEventListener('click', openAddEvent);
  const baseBtn = document.getElementById('imp-baselines');
  if (baseBtn) baseBtn.addEventListener('click', openBaselines);
  const goalBtn = document.getElementById('imp-goals');
  if (goalBtn) goalBtn.addEventListener('click', () => openGoals(preset === 'year' ? year : String(new Date().getFullYear()), metricOptions));
}

async function openAddEvent() {
  const [site, existing] = await Promise.all([loadWebsiteEvents(), api('admin/impact-events')]);
  const linked = new Set((existing.ok ? existing.data.events : []).map((e) => e.public_event_id).filter(Boolean));
  const past = site.filter((e) => e.date <= today() && !linked.has(e.id)).sort((a, b) => (a.date < b.date ? 1 : -1));
  openModal({
    title: 'Add event',
    submitLabel: 'Add event',
    body: (past.length ? '<label for="ev-site">From the website calendar</label><select id="ev-site" name="site"><option value="">— Enter details below —</option>' +
      past.map((e) => '<option value="' + esc(e.id) + '">' + esc(fmtDate(e.date) + ' · ' + e.title) + '</option>').join('') + '</select>' +
      '<p class="field-hint">Picking one fills in the details. Each calendar event can only be added once.</p>' : '') +
      '<label for="ev-name">Event name *</label><input type="text" id="ev-name" name="name" maxlength="200" required>' +
      '<div class="m-grid"><div><label for="ev-date">Date *</label><input type="date" id="ev-date" name="event_date" max="' + today() + '" required></div>' +
      '<div><label for="ev-role">Our role *</label><select id="ev-role" name="participation">' + selectOptions(PARTICIPATION_LABELS, 'exhibited') + '</select></div></div>' +
      '<label for="ev-loc">Location</label><input type="text" id="ev-loc" name="location" maxlength="300">' +
      '<input type="hidden" name="public_event_id" id="ev-pub">' +
      '<div id="ev-dup" hidden><label class="check-label"><input type="checkbox" name="confirm_duplicate"> <span>This is a different event on the same date</span></label></div>',
    onOpen: (body) => {
      const sel = body.querySelector('#ev-site');
      if (sel) sel.addEventListener('change', () => {
        const e = past.find((x) => x.id === sel.value);
        body.querySelector('#ev-pub').value = e ? e.id : '';
        if (!e) return;
        body.querySelector('#ev-name').value = e.title;
        body.querySelector('#ev-date').value = e.date;
        body.querySelector('#ev-loc').value = [e.venue, e.address].filter(Boolean).join(', ');
      });
    },
    onSubmit: (f) => api('admin/impact-events', { method: 'POST', body: f }).then((res) => {
      if (res.status === 409 && res.data.possible_duplicate) document.getElementById('ev-dup').hidden = false;
      if (res.ok) {
        toast(res.data.existing ? 'That event was already recorded. Opening it.' : 'Event added.');
        location.hash = '#/impact-event/' + res.data.event.id;
      }
      return res;
    })
  });
}

async function openBaselines() {
  const res = await api('admin/impact-baselines');
  if (!res.ok) return toast(res.data.error, 'bad');
  const opts = {};
  res.data.metrics.forEach((m) => { opts[m.key] = m.label; });
  openModal({
    title: 'Starting totals',
    submitLabel: 'Save starting total',
    body: '<p>Record totals you kept before the portal, such as the figures already on the website, with the dates they cover. Reports covering that whole span include the starting total and skip any entries dated inside it, so nothing is counted twice.</p>' +
      (res.data.baselines.length ? '<ul class="letter-list">' + res.data.baselines.map((b) => '<li><strong>' + esc(b.label) + ':</strong> ' + esc(chartFigure(b.value, b.qualifier, 'count')) +
        ' <span class="muted-text small">' + (b.period_start ? fmtDate(b.period_start) + ' – ' : 'through ') + fmtDate(b.as_of) + '</span> <button type="button" class="btn-link small" data-rm-base="' + esc(b.metric) + '">Remove</button></li>').join('') + '</ul>' : '') +
      '<label for="bl-m">Figure</label><select id="bl-m" name="metric">' + selectOptions(opts, 'books_distributed') + '</select>' +
      '<div class="m-grid"><div><label for="bl-v">Total *</label><input type="number" id="bl-v" name="value" min="0" step="1" required></div>' +
      '<div><label for="bl-q">Count type *</label><select id="bl-q" name="qualifier">' + selectOptions(QUAL_OPTIONS, 'exact') + '</select></div>' +
      '<div><label for="bl-s">Covers from</label><input type="date" id="bl-s" name="period_start"></div>' +
      '<div><label for="bl-a">Through *</label><input type="date" id="bl-a" name="as_of" value="2026-11-02" required></div></div>' +
      '<p class="field-hint">Without a “covers from” date, the starting total appears only in All-time reports.</p>' +
      '<label for="bl-n">Notes</label><input type="text" id="bl-n" name="notes" maxlength="1000" placeholder="e.g. From the website totals as of Nov 2, 2026">',
    onOpen: (body) => body.querySelectorAll('[data-rm-base]').forEach((b) => b.addEventListener('click', async () => {
      const r = await api('admin/impact-baselines', { method: 'POST', body: { metric: b.dataset.rmBase, remove: true } });
      if (r.ok) { toast('Starting total removed.'); closeModal(); viewImpact(); } else toast(r.data.error, 'bad');
    })),
    onSubmit: (f) => api('admin/impact-baselines', { method: 'POST', body: { metric: f.metric, value: Number(f.value), qualifier: f.qualifier, period_start: f.period_start || null, as_of: f.as_of, notes: f.notes } })
      .then((r) => { if (r.ok) { toast('Starting total saved.'); viewImpact(); } return r; })
  });
}

async function openGoals(year, metricOptions) {
  const res = await api('admin/impact-goals?year=' + encodeURIComponent(year));
  if (!res.ok) return toast(res.data.error, 'bad');
  openModal({
    title: year + ' impact goals',
    submitLabel: 'Save goal',
    body: (res.data.goals.length ? goalBars(res.data.goals) + '<ul class="letter-list">' + res.data.goals.map((g) => '<li>' + esc(g.label) + ': target ' + esc(chartFigure(g.target, 'exact', g.unit)) +
      ' <button type="button" class="btn-link small" data-rm-goal="' + esc(g.metric) + '">Remove</button></li>').join('') + '</ul>' : '<p class="muted-text">No goals set for ' + esc(year) + ' yet.</p>') +
      '<input type="hidden" name="goal_year" value="' + esc(year) + '">' +
      '<label for="gl-m">Figure</label><select id="gl-m" name="metric">' + selectOptions(metricOptions, 'children_served') + '</select>' +
      '<label for="gl-t">Target for ' + esc(year) + ' *</label><input type="number" id="gl-t" name="target" min="1" step="1" required>' +
      '<label for="gl-n">Notes</label><input type="text" id="gl-n" name="notes" maxlength="500">' +
      '<p class="field-hint">Setting a goal for a figure that already has one replaces it.</p>',
    onOpen: (body) => { applyChartWidths(body); body.querySelectorAll('[data-rm-goal]').forEach((b) => b.addEventListener('click', async () => {
      const r = await api('admin/impact-goals', { method: 'POST', body: { goal_year: Number(year), metric: b.dataset.rmGoal, remove: true } });
      if (r.ok) { toast('Goal removed.'); closeModal(); viewImpact(); } else toast(r.data.error, 'bad');
    })); },
    onSubmit: (f) => api('admin/impact-goals', { method: 'POST', body: { goal_year: Number(f.goal_year), metric: f.metric, target: Number(f.target), notes: f.notes } })
      .then((r) => { if (r.ok) { toast('Goal saved.'); viewImpact(); } return r; })
  });
}

async function viewImpactEvent(id) {
  loading('Loading event…');
  const res = await api('admin/impact-events?id=' + encodeURIComponent(id || ''));
  if (!res.ok) return errorState(res.data.error, () => viewImpactEvent(id));
  const { event: e, counts, distributions, count_metrics: metrics } = res.data;
  const byMetric = new Map(counts.map((c) => [c.metric, c]));
  const record = canDo('impact.record');
  const invLinked = new Set(distributions.map((d) => d.category.toLowerCase()));
  const fromInventory = { books_distributed: 'books', clothing_distributed: 'clothing' };

  main.innerHTML = '<p class="breadcrumb"><a href="#/impact">← Community Impact</a></p>' +
    '<div class="view-header"><div><h1>' + esc(e.name) + '</h1><p class="header-badges"><span class="badge badge-blue">' + esc(PARTICIPATION_LABELS[e.participation] || e.participation) + '</span> ' +
    '<span class="muted-text">' + fmtDate(e.event_date) + (e.location ? ' · ' + esc(e.location) : '') + '</span></p></div>' +
    '<div class="action-row"><a class="btn btn-primary btn-sm" href="/admin/impact-report.html?event=' + esc(e.id) + '" target="_blank" rel="noopener">Printable event report</a></div></div>' +
    '<section class="panel"><h2>Counts</h2><p class="field-hint">Record what you tracked at this event. Mark each figure exact, approximate, estimated, or “or more”. ' +
    'Interactions and plays count engagements, not individual people.</p><div class="count-grid">' +
    metrics.map((m) => {
      const c = byMetric.get(m.key) || {};
      const inv = fromInventory[m.key] && invLinked.has(fromInventory[m.key]);
      return '<form class="count-row" data-metric="' + esc(m.key) + '"><span class="count-label"><strong>' + esc(m.label) + '</strong>' +
        (m.engagement ? '<br><span class="muted-text small">Engagements, not people</span>' : '') +
        (inv ? '<br><span class="muted-text small">Counted from inventory for this event</span>' : '') + '</span>' +
        '<input type="number" name="value" min="0" step="1" aria-label="' + esc(m.label) + '" value="' + esc(c.value == null ? '' : c.value) + '"' + (record ? '' : ' disabled') + '>' +
        '<select name="qualifier" aria-label="Count type"' + (record ? '' : ' disabled') + '>' + selectOptions(QUAL_OPTIONS, c.qualifier || 'exact') + '</select>' +
        '<input type="text" name="notes" maxlength="1000" placeholder="Notes" aria-label="Notes" value="' + esc(c.notes || '') + '"' + (record ? '' : ' disabled') + '>' +
        (record ? '<span class="action-row"><button type="submit" class="btn btn-secondary btn-xs">Save</button>' + (c.id ? '<button type="button" class="btn-link small" data-clear>Clear</button>' : '') + '</span>' : '<span></span>') +
        '</form>';
    }).join('') + '</div></section>' +
    '<section class="panel"><h2>Items distributed (from inventory)</h2>' + (distributions.length
      ? '<ul class="letter-list">' + distributions.map((d) => '<li>' + esc(d.quantity) + ' ' + esc(d.category.toLowerCase()) + '</li>').join('') + '</ul><p class="field-hint">When items are linked to this event in Inventory, those numbers are used and a typed count for the same category is ignored, so nothing is counted twice.</p>'
      : emptyState('No inventory distributions are linked to this event. Link them when you record a distribution, or type a count above.')) + '</section>';

  main.querySelectorAll('.count-row').forEach((row) => {
    row.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (row.value.value === '') return toast('Enter a number, or use Clear.', 'warn');
      const r = await api('admin/impact-count', { method: 'POST', body: { event_id: e.id, metric: row.dataset.metric, value: Number(row.value.value), qualifier: row.qualifier.value, notes: row.notes.value } });
      if (r.ok) { toast(r.data.replaced ? 'Count updated.' : 'Count saved.'); viewImpactEvent(id); } else toast(r.data.error + (r.data.errors ? ' ' + Object.values(r.data.errors).join(' ') : ''), 'bad');
    });
    const clear = row.querySelector('[data-clear]');
    if (clear) clear.addEventListener('click', async () => {
      const r = await api('admin/impact-count', { method: 'POST', body: { event_id: e.id, metric: row.dataset.metric, remove: true } });
      if (r.ok) { toast('Count cleared.'); viewImpactEvent(id); } else toast(r.data.error, 'bad');
    });
  });
}

/* ---------- Public website statistics ---------- */

let publicDraft = null; // local, unpublished edits: [{ key, label, detail, refresh }]

function previewMarkup() {
  return '<section class="community-impact public-preview" aria-label="Preview of the website section"><div class="container">' +
    '<div class="section-header"><h2>Community Impact</h2><p class="impact-asof"></p></div>' +
    '<div class="impact-stats"></div>' +
    '<div class="impact-engagement"><h3></h3><div class="impact-engagement-grid"></div>' +
    '<p class="impact-note">These are estimated engagements, not a count of individual people or children served. The same visitor may have stopped by or played more than once.</p></div>' +
    '<p class="impact-footnote"></p></div></section>';
}

async function ensurePublicRenderer() {
  if (window.BLFPublicImpact) return;
  await new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = '/js/public-impact.js';
    s.onload = resolve;
    s.onerror = resolve;
    document.head.appendChild(s);
  });
}

async function viewPublicImpact() {
  loading('Loading public website statistics…');
  const res = await api('admin/public-impact');
  if (!res.ok) return errorState(res.data.error, viewPublicImpact);
  const d = res.data;
  const admin = canDo('impact.publish');
  if (!publicDraft) publicDraft = d.items.map((i) => ({ key: i.key, label: i.label, detail: i.detail || '', refresh: false }));
  const publishedByKey = new Map(d.items.map((i) => [i.key, i]));
  const availableByKey = new Map(d.available.map((a) => [a.key, a]));
  const draftKeys = new Set(publicDraft.map((x) => x.key));
  const dirty = JSON.stringify(publicDraft) !== JSON.stringify(d.items.map((i) => ({ key: i.key, label: i.label, detail: i.detail || '', refresh: false })));

  const rowFor = (x, idx) => {
    const pub = publishedByKey.get(x.key);
    const cur = pub ? pub.current_display : (availableByKey.get(x.key) || {}).display;
    const status = !pub ? '<span class="badge badge-warn">New, not published</span>'
      : x.refresh ? '<span class="badge badge-warn">Will update to ' + esc(cur) + '</span>'
        : pub.changed ? '<span class="badge badge-blue">Records now show ' + esc(cur) + '</span>' : '<span class="badge badge-ok">Up to date</span>';
    return '<tr data-key="' + esc(x.key) + '"><td>' + (admin ? '<input type="text" class="pub-input" data-field="label" maxlength="80" aria-label="Label" value="' + esc(x.label) + '">' +
      '<input type="text" class="pub-input small" data-field="detail" maxlength="200" placeholder="Optional short description" aria-label="Description" value="' + esc(x.detail) + '">' : '<strong>' + esc(x.label) + '</strong><br><span class="muted-text small">' + esc(x.detail) + '</span>') + '</td>' +
      '<td class="nowrap"><strong>' + esc(pub && !x.refresh ? pub.display : cur) + '</strong></td><td>' + status + '</td>' +
      (admin ? '<td class="actions-cell">' + (pub && pub.changed && !x.refresh ? '<button type="button" class="btn btn-secondary btn-xs" data-act="refresh">Use new number</button> ' : '') +
        (idx > 0 ? '<button type="button" class="btn-link" data-act="up" aria-label="Move up">↑</button>' : '') +
        (idx < publicDraft.length - 1 ? '<button type="button" class="btn-link" data-act="down" aria-label="Move down">↓</button>' : '') +
        ' <button type="button" class="btn-link" data-act="remove">' + (pub ? 'Unpublish' : 'Remove') + '</button></td>' : '') + '</tr>';
  };

  main.innerHTML = '<p class="breadcrumb"><a href="#/impact">← Community Impact</a></p><div class="view-header"><h1>Public Website Statistics</h1>' +
    (admin ? '<div class="action-row"><button type="button" class="btn btn-secondary btn-sm" id="pub-discard"' + (dirty ? '' : ' disabled') + '>Discard changes</button>' +
      '<button type="button" class="btn btn-primary btn-sm" id="pub-review"' + (dirty ? '' : ' disabled') + '>Preview &amp; publish</button></div>' : '') + '</div>' +
    '<p class="field-hint">These are the figures shown in the Community Impact section of your home page. Numbers come from your records (all-time, with starting totals counted once). ' +
    'You choose which ones appear and how they’re worded, but you can’t type a number. Donation amounts and anything about individual donors, volunteers, or recipients can never be published.</p>' +
    '<div class="notice-box">' + (d.published ? 'Live on the website since ' + fmtDateTime(d.published.approved_at) + (d.published.approved_by ? ' (approved by ' + esc(d.published.approved_by) + ')' : '') + '. The website shows “Totals as of ' + fmtDate(d.published.as_of) + '”.'
      : 'Nothing has been published yet, so the website still shows the figures written into the page. Your first publication replaces them.') + '</div>' +
    (dirty ? '<div class="form-alert unpublished-alert" role="status"><strong>You have unpublished changes.</strong> Preview and publish them, or discard them.</div>' : '') +
    '<section class="panel"><h2>On the website' + (dirty ? ' (after your changes)' : '') + '</h2>' + (publicDraft.length
      ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Statistic as shown</th><th>Number</th><th>Status</th>' + (admin ? '<th><span class="sr-only">Actions</span></th>' : '') + '</tr></thead><tbody>' +
        publicDraft.map(rowFor).join('') + '</tbody></table></div>' : emptyState('No statistics selected.')) +
    (admin ? '<label for="pub-heading" class="field-hint">Heading above interaction and play figures</label><input type="text" id="pub-heading" class="pub-input" maxlength="80" value="' + esc(sessionStorage.getItem('pub.heading') || (d.published ? d.published.engagement_heading : 'Candyland & Career Day engagement')) + '">' : '') + '</section>' +
    '<section class="panel"><h2>Available to add</h2>' + (d.available.filter((a) => !draftKeys.has(a.key)).length
      ? '<ul class="letter-list">' + d.available.filter((a) => !draftKeys.has(a.key)).map((a) => '<li><strong>' + esc(a.suggested_label) + '</strong> <span class="muted-text">' +
        (a.has_data ? esc(a.display) + (a.includes_starting_total ? ' · includes starting total' : '') : 'no records yet') + '</span> ' +
        (admin && a.has_data ? '<button type="button" class="btn-link small" data-add="' + esc(a.key) + '">Add to website</button>' : '') + '</li>').join('') + '</ul>'
      : emptyState('Every publishable statistic is selected.')) + '</section>' +
    '<section class="panel"><h2>History</h2>' + (d.history.length
      ? '<ul class="letter-list">' + d.history.map((h) => '<li><strong>' + fmtDateTime(h.approved_at) + '</strong> ' + (h.status === 'published' ? '<span class="badge badge-ok">Live</span>' : '<span class="badge badge-muted">Replaced</span>') +
        ' <span class="muted-text small">' + esc(h.approved_by) + '</span><br><span class="small">' + h.items.map((i) => esc(i.label) + ': ' + esc(i.display)).join(' · ') + '</span></li>').join('') + '</ul>'
      : emptyState('Nothing has been published yet.')) + '</section>';

  if (!admin) return;
  const rerender = () => viewPublicImpact();
  main.querySelectorAll('tr[data-key]').forEach((tr) => {
    const item = publicDraft.find((x) => x.key === tr.dataset.key);
    tr.querySelectorAll('.pub-input').forEach((input) => input.addEventListener('change', () => { item[input.dataset.field] = input.value; rerender(); }));
    tr.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const i = publicDraft.indexOf(item);
      if (b.dataset.act === 'refresh') item.refresh = true;
      if (b.dataset.act === 'remove') publicDraft.splice(i, 1);
      if (b.dataset.act === 'up' && i > 0) publicDraft.splice(i - 1, 0, publicDraft.splice(i, 1)[0]);
      if (b.dataset.act === 'down') publicDraft.splice(i + 1, 0, publicDraft.splice(i, 1)[0]);
      rerender();
    }));
  });
  main.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    const a = availableByKey.get(b.dataset.add);
    publicDraft.push({ key: a.key, label: a.suggested_label, detail: '', refresh: true });
    rerender();
  }));
  const heading = document.getElementById('pub-heading');
  heading.addEventListener('change', () => { sessionStorage.setItem('pub.heading', heading.value); });
  const discard = document.getElementById('pub-discard');
  discard.addEventListener('click', () => { publicDraft = null; sessionStorage.removeItem('pub.heading'); rerender(); });
  document.getElementById('pub-review').addEventListener('click', () => reviewPublication(heading.value));
}

async function reviewPublication(heading) {
  await ensurePublicRenderer();
  const body = { items: publicDraft, engagement_heading: heading };
  const pre = await api('admin/public-impact', { method: 'POST', body: Object.assign({ preview: true }, body) });
  if (!pre.ok) return toast(pre.data.error + (pre.data.errors ? ' ' + Object.values(pre.data.errors).join(' ') : ''), 'bad');
  openModal({
    title: 'Preview: Community Impact on your home page',
    submitLabel: 'Publish to website',
    body: '<p class="field-hint">This is exactly how the section will look. Nothing changes on the website until you publish.</p>' +
      '<div class="preview-frame" id="pub-preview">' + previewMarkup() + '</div>' +
      '<label class="check-label"><input type="checkbox" name="confirm"> <span>I’ve reviewed these figures and approve them for the public website.</span></label>',
    onOpen: (b) => {
      modal.classList.add('modal-wide');
      window.BLFPublicImpact.render(b.querySelector('.public-preview'), pre.data.preview);
    },
    onSubmit: (f) => api('admin/public-impact', { method: 'POST', body: Object.assign({ confirm: f.confirm === true }, body) }).then((r) => {
      if (r.ok) { publicDraft = null; sessionStorage.removeItem('pub.heading'); toast('Published. The website updates within a few minutes.'); viewPublicImpact(); }
      return r;
    })
  });
}

/* ---------- Team & Permissions ---------- */

const openTeamMembers = new Set();

async function viewTeam() {
  loading('Loading team…');
  const res = await api('admin/team');
  if (!res.ok) return errorState(res.data.error, viewTeam);
  const catalog = res.data.catalog;
  const members = res.data.members;
  const groups = [];
  catalog.forEach((p) => { if (groups.indexOf(p.group) === -1) groups.push(p.group); });

  const sourceText = (perm) => perm.source === 'grant' ? 'Granted individually'
    : perm.source === 'revoke' ? 'Revoked individually' : 'From role';

  const overrideCount = (m) => Object.values(m.permissions).filter((p) => p.source !== 'role').length;
  const memberCard = (m) => '<details class="panel team-member" data-member="' + esc(m.id) + '"' + (openTeamMembers.has(m.id) ? ' open' : '') + '>' +
    '<summary class="panel-head"><div><h2>' + esc(m.full_name) + '</h2><p class="muted-text small">' + esc(m.email) +
    (m.title ? ' · ' + esc(m.title) : '') + '</p></div><div>' +
    (overrideCount(m) ? '<span class="badge badge-blue">' + overrideCount(m) + ' individual change' + (overrideCount(m) === 1 ? '' : 's') + '</span> ' : '') +
    '<span class="role-badge">' + esc(LABELS.role[m.role] || m.role) + '</span>' +
    (m.active ? '' : ' <span class="badge badge-muted">Inactive</span>') + '</div></summary>' +
    (m.id === state.staff.id ? '<p class="field-hint">This is you. Administrator-only permissions can’t be changed.</p>' : '') +
    groups.map((g) => '<fieldset class="perm-group"><legend>' + esc(g) + '</legend>' +
      catalog.filter((p) => p.group === g).map((p) => {
        const perm = m.permissions[p.key];
        return '<div class="perm-row">' +
          '<label class="check-label"><input type="checkbox" data-perm-key="' + esc(p.key) + '"' + (perm.allowed ? ' checked' : '') +
          (p.admin_only ? ' disabled' : '') + '> <span>' + esc(p.label) + '</span></label>' +
          '<span class="perm-source perm-source-' + esc(perm.source) + '">' + (p.admin_only ? 'Administrators only' : sourceText(perm)) + '</span>' +
          (perm.source !== 'role' && !p.admin_only ? ' <button type="button" class="btn-link small" data-reset-key="' + esc(p.key) + '">Use role default</button>' : '') +
          '</div>';
      }).join('') + '</fieldset>').join('') + '</details>';

  main.innerHTML = '<div class="view-header"><h1>Team &amp; Permissions</h1></div>' +
    '<p class="field-hint">Select a person to see and change their access. Each person starts with their role’s default access. Check or uncheck a box to grant or revoke that one permission for that person. Only administrators can change permissions, and changes take effect on the person’s next action. Every change is recorded in the activity log.</p>' +
    (members.length ? members.map(memberCard).join('') : emptyState('No team members yet.'));

  async function change(memberId, key, effect, control) {
    if (control) control.disabled = true;
    const r = await api('admin/team-permission', { method: 'POST', body: { staff_id: memberId, permission: key, effect: effect } });
    if (!r.ok) {
      toast(r.data.error || 'Could not change that permission.', 'bad');
      if (control) { control.checked = !control.checked; control.disabled = false; }
      return;
    }
    toast('Permission updated for ' + r.data.member.full_name + '.');
    viewTeam();
  }

  main.querySelectorAll('.team-member').forEach((card) => {
    const memberId = card.dataset.member;
    card.addEventListener('toggle', () => { if (card.open) openTeamMembers.add(memberId); else openTeamMembers.delete(memberId); });
    card.querySelectorAll('input[data-perm-key]').forEach((box) => {
      box.addEventListener('change', () => change(memberId, box.dataset.permKey, box.checked ? 'grant' : 'revoke', box));
    });
    card.querySelectorAll('[data-reset-key]').forEach((btn) => {
      btn.addEventListener('click', () => change(memberId, btn.dataset.resetKey, 'default', null));
    });
  });
}

/* ---------- Boot ---------- */

(async function boot() {
  const res = await api('auth/session', { allow401: true });
  if (res.ok) startApp(res.data);
  else showLogin(res.status === 0 || res.status >= 500 ? (res.data.error || 'The portal is unavailable right now.') : null);
})();
