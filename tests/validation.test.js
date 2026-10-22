import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateApplication, validateHourEntry, isValidPhone, todayInOrgTimeZone } from '../js/volunteer-core.js';
import { AGREEMENT_VERSION } from '../js/volunteer-agreement.js';
import { validApplication, courtApplication, TODAY } from './helpers.js';

const opts = { today: TODAY, agreementVersion: AGREEMENT_VERSION };

test('a complete general application is valid and normalized', () => {
  const r = validateApplication(validApplication(), opts);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.email, 'jordan.rivera@example.com');
  assert.deepEqual(r.value.interests, ['inventor_workshop', 'literacy_events']);
});

test('unknown fields are dropped (allow-list)', () => {
  const r = validateApplication(validApplication({ ssn: '123-45-6789', offense: 'x', status: 'approved' }), opts);
  assert.equal(r.ok, true);
  assert.equal('ssn' in r.value, false);
  assert.equal('offense' in r.value, false);
  assert.equal('status' in r.value, false);
});

test('required fields produce field-level errors', () => {
  const r = validateApplication({}, opts);
  assert.equal(r.ok, false);
  for (const f of ['track', 'first_name', 'last_name', 'email', 'phone', 'age_confirmed', 'availability_days',
    'interests', 'emergency_name', 'emergency_relationship', 'emergency_phone', 'privacy_ack', 'agreement_ack', 'typed_name']) {
    assert.ok(r.errors[f], 'expected error for ' + f);
  }
});

test('applicants must confirm they are 18 or older', () => {
  const r = validateApplication(validApplication({ age_confirmed: false }), opts);
  assert.match(r.errors.age_confirmed, /18/);
});

test('rejects bad email and phone formats', () => {
  const r = validateApplication(validApplication({ email: 'not-an-email', phone: '555-1234' }), opts);
  assert.ok(r.errors.email);
  assert.ok(r.errors.phone);
  assert.equal(isValidPhone('+1 (414) 555-0142'), true);
});

test('typed acknowledgment name must match the applicant name', () => {
  const r = validateApplication(validApplication({ typed_name: 'Someone Else' }), opts);
  assert.ok(r.errors.typed_name);
  const ok = validateApplication(validApplication({ typed_name: '  jordan   RIVERA ' }), opts);
  assert.equal(ok.ok, true);
});

test('a stale agreement version is rejected', () => {
  const r = validateApplication(validApplication({ agreement_version: '0.9' }), opts);
  assert.match(r.errors.agreement_ack, /updated/);
});

test('Social Security numbers are refused in free-text fields', () => {
  const r = validateApplication(validApplication({ skills: 'My SSN is 123-45-6789' }), opts);
  assert.match(r.errors.skills, /Social Security/);
});

test('court-ordered applications require service details but no offense details', () => {
  const ok = validateApplication(courtApplication(), opts);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.value.court_required_hours, 40);

  const missing = validateApplication(courtApplication({
    court_required_hours: '', court_deadline: '', agency_name: '', agency_contact_name: '',
    agency_contact_email: '', agency_contact_phone: '', court_reported_status: undefined, court_terms_ack: false
  }), opts);
  for (const f of ['court_required_hours', 'court_deadline', 'agency_name', 'agency_contact_name',
    'agency_contact_email', 'court_reported_status', 'court_terms_ack']) {
    assert.ok(missing.errors[f], 'expected error for ' + f);
  }
});

test('court deadline in the past and invalid hours are rejected', () => {
  const r = validateApplication(courtApplication({ court_deadline: '2026-10-20', court_required_hours: -5 }), opts);
  assert.ok(r.errors.court_deadline);
  assert.ok(r.errors.court_required_hours);
  const frac = validateApplication(courtApplication({ court_required_hours: 10.1 }), opts);
  assert.ok(frac.errors.court_required_hours);
});

test('general applications ignore court fields entirely', () => {
  const r = validateApplication(validApplication({ court_required_hours: 99 }), opts);
  assert.equal(r.ok, true);
  assert.equal('court_required_hours' in r.value, false);
});

test('hour entries: future dates are rejected', () => {
  const base = { volunteer_id: '00000000-0000-4000-8000-000000000001', assignment_id: '00000000-0000-4000-8000-000000000002', start_time: '09:00', end_time: '10:00', supervisor_name: 'Sam' };
  assert.ok(validateHourEntry(Object.assign({ service_date: '2026-10-22' }, base), { today: TODAY }).errors.service_date);
  assert.equal(validateHourEntry(Object.assign({ service_date: '2026-10-21' }, base), { today: TODAY }).ok, true);
  assert.ok(validateHourEntry(Object.assign({}, base, { service_date: '2026-02-30' }), { today: TODAY }).errors.service_date);
});

test('today is computed in Milwaukee time', () => {
  // 03:00 UTC on Oct 22 is still the evening of Oct 21 in Milwaukee.
  assert.equal(todayInOrgTimeZone(new Date('2026-10-22T03:00:00Z')), '2026-10-21');
});
