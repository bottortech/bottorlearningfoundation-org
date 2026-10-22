/* ============================================
   BOTTOR LEARNING FOUNDATION — Volunteer Dashboard
   All data comes from the authenticated /api/admin endpoints;
   this page itself contains no volunteer records.
   ============================================ */
import {
  INTEREST_OPTIONS, AVAILABILITY_OPTIONS, COURT_REPORTED_STATUS_OPTIONS,
  calculateNetMinutes, formatHours, todayInOrgTimeZone
} from '/js/volunteer-core.js';

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
  audit: viewAudit
};

function route() {
  if (!state.staff) return;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const name = VIEWS[parts[0]] ? parts[0] : 'overview';
  document.querySelectorAll('.admin-nav a').forEach((a) => {
    const active = a.dataset.view === name || (name === 'volunteer' && a.dataset.view === 'volunteers');
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  VIEWS[name](parts[1]);
  main.focus({ preventScroll: true });
}
window.addEventListener('hashchange', route);

/* ---------- Overview ---------- */

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
    '</div>' +
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
  main.innerHTML = '<div class="view-header"><h1>Audit Log</h1></div><p class="field-hint">The most recent 300 events. Entries cannot be edited or deleted from the dashboard.</p>' +
    (rows.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th></tr></thead><tbody>' +
      rows.map((r) => '<tr><td class="nowrap">' + fmtDateTime(r.created_at) + '</td><td>' + esc(r.actor_email || 'Public / system') + '</td><td><code>' + esc(r.action) + '</code></td>' +
        '<td>' + esc(r.entity_type) + (r.entity_id ? ' <span class="muted-text small">' + esc(String(r.entity_id).slice(0, 8)) + '</span>' : '') + '</td>' +
        '<td class="wrap small">' + esc(Object.keys(r.details || {}).length ? JSON.stringify(r.details) : '') + '</td></tr>').join('') +
      '</tbody></table></div>' : emptyState('No events yet.'));
}

/* ---------- Boot ---------- */

(async function boot() {
  const res = await api('auth/session', { allow401: true });
  if (res.ok) startApp(res.data);
  else showLogin(res.status === 0 || res.status >= 500 ? (res.data.error || 'The dashboard is unavailable right now.') : null);
})();
