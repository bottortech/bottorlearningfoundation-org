/* ============================================
   BOTTOR LEARNING FOUNDATION — Volunteer application page
   ============================================ */
import {
  AVAILABILITY_OPTIONS, INTEREST_OPTIONS, COURT_REPORTED_STATUS_OPTIONS, validateApplication
} from './volunteer-core.js';
import {
  AGREEMENT_VERSION, ACKNOWLEDGMENT_NOTICE, renderAgreement
} from './volunteer-agreement.js';

const form = document.getElementById('volunteer-form');
const summary = document.getElementById('form-error-summary');
const submitBtn = document.getElementById('submit-btn');
const courtSection = document.getElementById('court-section');
const startedAt = Date.now();

function renderOptions(containerId, name, options, type) {
  const container = document.getElementById(containerId);
  options.forEach(function (opt) {
    const label = document.createElement('label');
    label.className = 'check-label';
    const input = document.createElement('input');
    input.type = type;
    input.name = name;
    input.value = opt.value;
    const span = document.createElement('span');
    span.textContent = opt.label;
    label.appendChild(input);
    label.appendChild(span);
    container.appendChild(label);
  });
}

function currentTrack() {
  const checked = form.querySelector('input[name="track"]:checked');
  return checked ? checked.value : null;
}

function updateTrack() {
  const court = currentTrack() === 'court_ordered';
  courtSection.hidden = !court;
  courtSection.querySelectorAll('input').forEach(function (el) { el.disabled = !court; });
  document.getElementById('agreement-step').textContent = court ? '6' : '5';
  document.getElementById('privacy-step').textContent = court ? '7' : '6';
}

function chooseTrack(track) {
  const radio = form.querySelector('input[name="track"][value="' + track + '"]');
  if (radio) {
    radio.checked = true;
    updateTrack();
  }
}

function collect() {
  const data = new FormData(form);
  const bool = function (id) { return document.getElementById(id).checked; };
  return {
    track: currentTrack(),
    first_name: data.get('first_name'),
    last_name: data.get('last_name'),
    email: data.get('email'),
    phone: data.get('phone'),
    age_confirmed: bool('age_confirmed'),
    availability_days: data.getAll('availability_days'),
    availability_notes: data.get('availability_notes'),
    interests: data.getAll('interests'),
    skills: data.get('skills'),
    preferred_assignments: data.get('preferred_assignments'),
    emergency_name: data.get('emergency_name'),
    emergency_relationship: data.get('emergency_relationship'),
    emergency_phone: data.get('emergency_phone'),
    court_required_hours: data.get('court_required_hours'),
    court_deadline: data.get('court_deadline'),
    agency_name: data.get('agency_name'),
    agency_contact_name: data.get('agency_contact_name'),
    agency_contact_email: data.get('agency_contact_email'),
    agency_contact_phone: data.get('agency_contact_phone'),
    court_reported_status: data.get('court_reported_status'),
    court_terms_ack: bool('court_terms_ack'),
    agreement_ack: bool('agreement_ack'),
    agreement_version: AGREEMENT_VERSION,
    typed_name: data.get('typed_name'),
    privacy_ack: bool('privacy_ack'),
    website: data.get('website'),
    form_started_at: startedAt
  };
}

// The element that should receive focus for a given field's error.
function fieldTarget(name) {
  return document.getElementById(name) || form.querySelector('[name="' + name + '"]');
}

function clearErrors() {
  form.querySelectorAll('.field-error').forEach(function (el) { el.textContent = ''; });
  form.querySelectorAll('[aria-invalid]').forEach(function (el) { el.removeAttribute('aria-invalid'); });
  form.querySelectorAll('.has-error').forEach(function (el) { el.classList.remove('has-error'); });
  summary.hidden = true;
  summary.innerHTML = '';
}

function showErrors(errors, message) {
  clearErrors();
  const names = Object.keys(errors || {});
  names.forEach(function (name) {
    const errEl = document.getElementById('err-' + name);
    if (errEl) errEl.textContent = errors[name];
    const target = fieldTarget(name);
    if (target) {
      target.setAttribute('aria-invalid', 'true');
      const wrapper = target.closest('.field, .check-group, .form-section');
      if (wrapper) wrapper.classList.add('has-error');
    }
  });

  const heading = document.createElement('p');
  heading.innerHTML = '<strong></strong>';
  heading.firstChild.textContent = message || ('Please fix ' + names.length + (names.length === 1 ? ' problem' : ' problems') + ' before submitting:');
  summary.appendChild(heading);

  if (names.length) {
    const list = document.createElement('ul');
    names.forEach(function (name) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#' + name;
      a.textContent = errors[name];
      a.addEventListener('click', function (e) {
        e.preventDefault();
        const t = fieldTarget(name);
        if (t) t.focus();
      });
      li.appendChild(a);
      list.appendChild(li);
    });
    summary.appendChild(list);
  }
  summary.hidden = false;
  summary.focus();
}

function setSubmitting(on) {
  submitBtn.disabled = on;
  submitBtn.setAttribute('aria-busy', on ? 'true' : 'false');
  submitBtn.querySelector('.btn-label').textContent = on ? 'Submitting…' : 'Submit Application';
}

function formatTimestamp(iso) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago', dateStyle: 'long', timeStyle: 'short'
  }) + ' (Central)';
}

function showConfirmation(result, payload) {
  const name = (payload.typed_name || '').trim();
  document.getElementById('confirm-reference').textContent = result.reference;
  document.getElementById('confirm-court-note').hidden = payload.track !== 'court_ordered';
  document.getElementById('ack-name').textContent = name;
  document.getElementById('ack-version').textContent = result.agreement_version;
  document.getElementById('ack-time').textContent = result.acknowledged_at ? formatTimestamp(result.acknowledged_at) : '';
  document.getElementById('ack-reference').textContent = result.reference;
  document.getElementById('ack-note').textContent = ACKNOWLEDGMENT_NOTICE;

  // Build the print-only copy: full agreement + acknowledgment record.
  renderAgreement(document.getElementById('print-agreement-text'), 2);
  document.getElementById('print-ack-record').innerHTML = '';
  document.getElementById('print-ack-record').appendChild(document.getElementById('ack-record').cloneNode(true));

  // From here on, any print (button, ⌘P, File → Export as PDF) produces the
  // agreement copy. The class is never toggled around window.print(): Safari
  // prints asynchronously, and changing the layout mid-print yields blank PDFs.
  document.body.classList.add('print-agreement-mode');

  form.hidden = true;
  summary.hidden = true;
  const panel = document.getElementById('volunteer-confirmation');
  panel.hidden = false;
  panel.focus();
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function onSubmit(e) {
  e.preventDefault();
  const payload = collect();
  const check = validateApplication(payload, { agreementVersion: AGREEMENT_VERSION });
  if (!check.ok) {
    showErrors(check.errors);
    return;
  }

  clearErrors();
  setSubmitting(true);
  try {
    const res = await fetch('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(function () { return {}; });
    if (res.ok) {
      showConfirmation(data, payload);
    } else if (res.status === 422 && data.errors) {
      showErrors(data.errors, data.error);
    } else {
      showErrors({}, data.error || 'We could not submit your application. Please try again.');
    }
  } catch (err) {
    showErrors({}, 'We could not reach our server. Check your internet connection and try again. Your answers are still here.');
  } finally {
    setSubmitting(false);
  }
}

function updateNameHint() {
  const first = document.getElementById('first_name').value.trim();
  const last = document.getElementById('last_name').value.trim();
  document.getElementById('hint-typed_name').textContent = (first || last)
    ? 'Type it exactly as entered above: ' + (first + ' ' + last).trim() + '. ' + ACKNOWLEDGMENT_NOTICE
    : ACKNOWLEDGMENT_NOTICE;
}

function init() {
  if (!form) return;
  renderOptions('availability-options', 'availability_days', AVAILABILITY_OPTIONS, 'checkbox');
  renderOptions('interest-options', 'interests', INTEREST_OPTIONS, 'checkbox');
  renderOptions('court-status-options', 'court_reported_status', COURT_REPORTED_STATUS_OPTIONS, 'radio');
  renderAgreement(document.getElementById('agreement-text'), 3);
  updateNameHint();

  form.querySelectorAll('input[name="track"]').forEach(function (r) { r.addEventListener('change', updateTrack); });
  document.querySelectorAll('[data-choose-track]').forEach(function (btn) {
    btn.addEventListener('click', function () { chooseTrack(btn.getAttribute('data-choose-track')); });
  });
  ['first_name', 'last_name'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', updateNameHint);
  });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  document.getElementById('court_deadline').min = today;

  document.getElementById('print-agreement').addEventListener('click', function () { window.print(); });
  form.addEventListener('submit', onSubmit);

  const preset = new URLSearchParams(window.location.search).get('path');
  if (preset === 'court' || preset === 'court_ordered') chooseTrack('court_ordered');
  else if (preset === 'general') chooseTrack('general');
  updateTrack();
}

init();
