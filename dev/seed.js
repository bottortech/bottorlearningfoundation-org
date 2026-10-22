// Fictional demo data for the LOCAL PREVIEW only. All people are made up.
import { randomUUID } from 'node:crypto';
import { addStaff } from './memory-context.js';
import { AGREEMENT_VERSION } from '../js/volunteer-agreement.js';

export const DEMO_ACCOUNTS = [
  { role: 'admin', email: 'admin@demo.local', password: 'demo-admin-pass', full_name: 'Demo Administrator', title: 'President (Demo)', can_sign_letters: true },
  { role: 'coordinator', email: 'coordinator@demo.local', password: 'demo-coord-pass', full_name: 'Demo Coordinator', title: 'Volunteer Coordinator' },
  { role: 'supervisor', email: 'supervisor@demo.local', password: 'demo-super-pass', full_name: 'Demo Supervisor', title: null }
];

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}

export async function seedDemoData(ctx) {
  const staff = {};
  for (const a of DEMO_ACCOUNTS) staff[a.role] = await addStaff(ctx, a);
  const r = ctx.repo;

  const assignment = async (fields) => r.insert('assignments', Object.assign({
    id: randomUUID(), description: null, location: null, youth_facing: false, requires_supervision: true,
    active: true, created_at: daysAgo(60).toISOString(), updated_at: daysAgo(60).toISOString()
  }, fields));
  const workshop = await assignment({ name: 'Inventor Workshop classroom support', youth_facing: true, location: 'Partner school (varies)', description: 'Help students build and test prototypes alongside Bottor staff.' });
  const books = await assignment({ name: 'Book drive sorting & packing', location: 'Foundation office' });
  await assignment({ name: 'Event setup & hospitality', location: 'Varies by event' });

  const base = {
    phone: '(414) 555-0100', age_confirmed: true, availability_days: ['saturday'], availability_notes: null,
    interests: ['book_distribution'], skills: null, preferred_assignments: null,
    emergency_name: 'Demo Contact', emergency_relationship: 'Friend', emergency_phone: '(414) 555-0199',
    court_required_hours: null, court_deadline: null, agency_name: null, agency_contact_name: null,
    agency_contact_email: null, agency_contact_phone: null, court_reported_status: null,
    court_approval_status: 'not_recorded', target_hours: null, screening_status: 'not_started',
    background_check_status: 'not_started', supervision_required: true
  };
  const volunteer = async (fields, createdDaysAgo) => {
    const created = daysAgo(createdDaysAgo).toISOString();
    const v = await r.insert('volunteers', Object.assign({ id: randomUUID() }, base, fields, { created_at: created, updated_at: created }));
    await r.insert('agreement_acknowledgments', {
      volunteer_id: v.id, agreement_version: AGREEMENT_VERSION, typed_name: v.first_name + ' ' + v.last_name,
      method: 'web_form_checkbox_and_typed_name', acknowledged_at: created
    });
    return v;
  };

  await volunteer({ track: 'general', status: 'pending', first_name: 'Avery', last_name: 'Sample', email: 'avery.sample@example.com', interests: ['inventor_workshop', 'literacy_events'], skills: 'Retired 4th-grade teacher', availability_days: ['weekday_daytime', 'school_breaks'] }, 2);
  await volunteer({
    track: 'court_ordered', status: 'pending', first_name: 'Riley', last_name: 'Example', email: 'riley.example@example.com',
    court_required_hours: 25, target_hours: 25, court_deadline: daysAgo(-60).toISOString().slice(0, 10),
    agency_name: 'Demo County Community Service Program', agency_contact_name: 'Demo Case Worker',
    agency_contact_email: 'caseworker@agency.example', court_reported_status: 'pending', interests: ['event_setup', 'book_distribution']
  }, 1);

  const decided = { decided_by: staff.coordinator.id, decided_at: daysAgo(40).toISOString() };
  const cleared = await volunteer(Object.assign({
    track: 'general', status: 'approved', first_name: 'Morgan', last_name: 'Placeholder', email: 'morgan.placeholder@example.com',
    interests: ['inventor_workshop'], screening_status: 'cleared', background_check_status: 'cleared',
    background_check_completed_on: daysAgo(35).toISOString().slice(0, 10), background_check_expires_on: daysAgo(-700).toISOString().slice(0, 10),
    background_check_reference: 'DEMO-REF-1042', target_hours: 20
  }, decided), 45);
  const court = await volunteer(Object.assign({
    track: 'court_ordered', status: 'approved', first_name: 'Taylor', last_name: 'Demo', email: 'taylor.demo@example.com',
    court_required_hours: 30, target_hours: 30, court_deadline: daysAgo(-20).toISOString().slice(0, 10),
    agency_name: 'Demo Diversion Program', agency_contact_name: 'Demo Officer', agency_contact_phone: '(414) 555-0123',
    court_reported_status: 'approved', court_approval_status: 'approved', court_approval_notes: 'Confirmed by phone with agency contact.',
    court_approval_recorded_by: staff.coordinator.id, court_approval_recorded_at: daysAgo(38).toISOString(), interests: ['book_distribution']
  }, decided), 42);

  const place = (v, a) => r.insert('volunteer_assignments', {
    id: randomUUID(), volunteer_id: v.id, assignment_id: a.id, supervisor_name: 'Demo Supervisor',
    status: 'active', assigned_by: staff.coordinator.id, assigned_at: daysAgo(39).toISOString(), ended_at: null
  });
  await place(cleared, workshop);
  await place(court, books);

  const hours = (v, a, d, start, end, brk, status) => {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    return r.insert('hour_entries', {
      id: randomUUID(), volunteer_id: v.id, assignment_id: a.id, service_date: daysAgo(d).toISOString().slice(0, 10),
      start_time: start, end_time: end, break_minutes: brk, net_minutes: (eh * 60 + em) - (sh * 60 + sm) - brk,
      supervisor_name: 'Demo Supervisor', notes: null, status: status, created_by: staff.supervisor.id,
      created_at: daysAgo(d).toISOString(), updated_at: daysAgo(d).toISOString(),
      verified_by: status === 'approved' ? staff.supervisor.id : null,
      verified_at: status === 'approved' ? daysAgo(d - 1).toISOString() : null, verification_note: null
    });
  };
  await hours(court, books, 30, '09:00', '13:00', 30, 'approved');
  await hours(court, books, 23, '09:00', '14:00', 30, 'approved');
  await hours(court, books, 16, '10:00', '15:00', 30, 'approved');
  await hours(court, books, 3, '09:00', '12:00', 0, 'pending');
  await hours(cleared, workshop, 10, '08:30', '12:00', 15, 'approved');
  await hours(cleared, workshop, 2, '08:30', '12:00', 15, 'pending');
}
