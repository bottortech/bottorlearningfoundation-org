import { setContext } from '../api/_lib/context.js';
import { createMemoryContext, addStaff } from '../dev/memory-context.js';
import { AGREEMENT_VERSION } from '../js/volunteer-agreement.js';
import applyHandler from '../api/apply.js';
import authHandler from '../api/auth/[action].js';
import adminHandler from '../api/admin/[resource].js';

export const NOW = '2026-10-21T15:00:00.000Z'; // 10:00 AM in Milwaukee
export const TODAY = '2026-10-21';

export function makeReq(opts) {
  const o = opts || {};
  const headers = Object.assign({ host: 'localhost' }, o.headers || {});
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.cookie) headers.cookie = o.cookie;
  return { method: o.method || 'GET', url: o.url || '/', headers: headers, body: o.body, socket: { remoteAddress: o.ip || '10.0.0.1' } };
}

export function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(data) { this.body = data || ''; this.finished = true; },
    json() { return JSON.parse(this.body); }
  };
  return res;
}

export async function call(handler, opts) {
  const req = makeReq(opts);
  const res = makeRes();
  await handler(req, res);
  return res;
}

export async function setup() {
  const ctx = createMemoryContext({ now: NOW });
  setContext(ctx);
  const admin = await addStaff(ctx, { email: 'admin@test.org', password: 'admin-pass', full_name: 'Alex Admin', title: 'President', role: 'admin', can_sign_letters: true });
  const coordinator = await addStaff(ctx, { email: 'coord@test.org', password: 'coord-pass', full_name: 'Casey Coordinator', title: 'Volunteer Coordinator', role: 'coordinator' });
  const supervisor = await addStaff(ctx, { email: 'super@test.org', password: 'super-pass', full_name: 'Sam Supervisor', role: 'supervisor' });
  return { ctx, admin, coordinator, supervisor };
}

/** Sign in through the real auth handler and return a Cookie header value. */
export async function login(email, password) {
  const res = await call(authHandler, { method: 'POST', url: '/api/auth/login', body: { email, password } });
  if (res.statusCode !== 200) throw new Error('login failed: ' + res.statusCode + ' ' + res.body);
  return res.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
}

export function admin(cookie, method, resource, opts) {
  const o = opts || {};
  return call(adminHandler, { method, url: '/api/admin/' + resource + (o.query ? '?' + new URLSearchParams(o.query) : ''), body: o.body, cookie });
}

export function validApplication(overrides) {
  return Object.assign({
    track: 'general',
    first_name: 'Jordan',
    last_name: 'Rivera',
    email: 'Jordan.Rivera@example.com',
    phone: '(414) 555-0142',
    age_confirmed: true,
    availability_days: ['saturday', 'weekday_evening'],
    availability_notes: 'Most Saturdays',
    interests: ['inventor_workshop', 'literacy_events'],
    skills: 'Former teacher',
    preferred_assignments: 'Classroom support',
    emergency_name: 'Pat Rivera',
    emergency_relationship: 'Sibling',
    emergency_phone: '414-555-0199',
    privacy_ack: true,
    agreement_ack: true,
    agreement_version: AGREEMENT_VERSION,
    typed_name: 'Jordan Rivera',
    form_started_at: Date.parse(NOW) - 60000
  }, overrides || {});
}

export function courtApplication(overrides) {
  return validApplication(Object.assign({
    track: 'court_ordered',
    email: 'casey.court@example.com',
    first_name: 'Casey',
    last_name: 'Morgan',
    typed_name: 'Casey Morgan',
    court_required_hours: 40,
    court_deadline: '2027-01-31',
    agency_name: 'Milwaukee County Community Service Program',
    agency_contact_name: 'Officer Lee',
    agency_contact_email: 'lee@agency.example.gov',
    agency_contact_phone: '',
    court_reported_status: 'pending',
    court_terms_ack: true
  }, overrides || {}));
}

export { applyHandler, authHandler, adminHandler };

/** Submit + approve a volunteer and place them in an assignment. */
export async function approvedVolunteer(env, cookie, overrides, assignmentFields) {
  const app = await call(applyHandler, { method: 'POST', url: '/api/apply', body: validApplication(overrides) });
  if (app.statusCode !== 201) throw new Error('apply failed ' + app.body);
  const [v] = await env.ctx.repo.list('volunteers', { order: ['created_at', 'desc'], eq: { email: (overrides && overrides.email || 'jordan.rivera@example.com').toLowerCase() } });
  await admin(cookie, 'POST', 'decision', { body: { volunteer_id: v.id, decision: 'approve' } });
  const a = await admin(cookie, 'POST', 'assignments', { body: Object.assign({ name: 'Event Setup', youth_facing: false }, assignmentFields || {}) });
  const assignment = a.json().assignment;
  const p = await admin(cookie, 'POST', 'placements', { body: { volunteer_id: v.id, assignment_id: assignment.id, supervisor_name: 'Sam Supervisor' } });
  if (p.statusCode !== 200) throw new Error('placement failed ' + p.body);
  return { volunteer: v, assignment };
}
