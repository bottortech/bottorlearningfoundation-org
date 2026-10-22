import { randomUUID } from 'node:crypto';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { can } from '../permissions.js';
import { checkThrottle } from '../throttle.js';
import {
  validateApplication, todayInOrgTimeZone, isUuid, isValidDate, cleanText, cleanMultiline,
  containsSsn, summarizeHours
} from '../../../js/volunteer-core.js';
import { AGREEMENT_VERSION } from '../../../js/volunteer-agreement.js';

// Bots fill forms in milliseconds; people take longer than this.
export const MIN_FORM_FILL_MS = 4000;
export const APPLY_LIMIT_PER_HOUR = 5;

export const SCREENING_STATUSES = ['not_started', 'in_progress', 'cleared', 'not_cleared'];
export const BACKGROUND_STATUSES = ['not_required', 'not_started', 'pending', 'cleared', 'not_cleared', 'expired'];
export const COURT_APPROVAL_STATUSES = ['not_recorded', 'pending', 'approved', 'denied'];

export function applicationReference(id) {
  return 'BLF-' + String(id).slice(0, 8).toUpperCase();
}

/* ---------- Public application ---------- */

export async function submitApplication(ctx, body, meta) {
  // Honeypot: real visitors never see or fill the "website" field. Pretend
  // success so bots get no signal, but store nothing.
  if (body.website) {
    return { ok: true, reference: applicationReference(randomUUID()), agreement_version: AGREEMENT_VERSION };
  }

  const startedAt = Number(body.form_started_at);
  const elapsed = ctx.now().getTime() - startedAt;
  if (!Number.isFinite(startedAt) || elapsed < MIN_FORM_FILL_MS) {
    throw new HttpError(422, 'Please take a moment to review your answers, then submit again.');
  }

  await checkThrottle(ctx, 'apply:' + meta.ip, {
    limit: APPLY_LIMIT_PER_HOUR,
    windowMs: 60 * 60 * 1000,
    message: 'We have received several applications from this connection. Please try again in an hour.'
  });

  const today = todayInOrgTimeZone(ctx.now());
  const result = validateApplication(body, { today: today, agreementVersion: AGREEMENT_VERSION });
  if (!result.ok) {
    throw new HttpError(422, 'Please correct the highlighted fields.', { errors: result.errors });
  }
  const v = result.value;

  const existing = await ctx.repo.list('volunteers', { eq: { email: v.email, status: 'pending' }, limit: 1 });
  if (existing.length) {
    throw new HttpError(409, 'We already have a pending application for this email address. Our volunteer team will be in touch soon.');
  }

  const nowIso = ctx.now().toISOString();
  const court = v.track === 'court_ordered';
  const id = randomUUID();

  await ctx.repo.insert('volunteers', {
    id: id,
    track: v.track,
    status: 'pending',
    first_name: v.first_name,
    last_name: v.last_name,
    email: v.email,
    phone: v.phone,
    age_confirmed: true,
    availability_days: v.availability_days,
    availability_notes: v.availability_notes || null,
    interests: v.interests,
    skills: v.skills || null,
    preferred_assignments: v.preferred_assignments || null,
    emergency_name: v.emergency_name,
    emergency_relationship: v.emergency_relationship,
    emergency_phone: v.emergency_phone,
    court_required_hours: court ? v.court_required_hours : null,
    court_deadline: court ? v.court_deadline : null,
    agency_name: court ? v.agency_name : null,
    agency_contact_name: court ? v.agency_contact_name : null,
    agency_contact_email: court ? v.agency_contact_email || null : null,
    agency_contact_phone: court ? v.agency_contact_phone || null : null,
    court_reported_status: court ? v.court_reported_status : null,
    court_approval_status: 'not_recorded',
    target_hours: court ? v.court_required_hours : null,
    screening_status: 'not_started',
    background_check_status: 'not_started',
    supervision_required: true,
    created_at: nowIso,
    updated_at: nowIso
  });

  await ctx.repo.insert('agreement_acknowledgments', {
    volunteer_id: id,
    agreement_version: AGREEMENT_VERSION,
    typed_name: v.typed_name,
    method: 'web_form_checkbox_and_typed_name',
    acknowledged_at: nowIso
  });

  await audit(ctx, null, 'application.submitted', 'volunteer', id, { track: v.track, agreement_version: AGREEMENT_VERSION });

  return { ok: true, reference: applicationReference(id), acknowledged_at: nowIso, agreement_version: AGREEMENT_VERSION };
}

/* ---------- Youth safety ---------- */

/**
 * Whether a volunteer may be placed in a youth-facing assignment.
 * Requires completed screening AND a cleared (or documented not-required),
 * unexpired background check.
 */
export function youthClearance(volunteer, today) {
  const reasons = [];
  if (volunteer.status !== 'approved') reasons.push('Volunteer is not approved.');
  if (volunteer.screening_status !== 'cleared') reasons.push('Screening is not marked cleared.');
  const bg = volunteer.background_check_status;
  if (bg !== 'cleared' && bg !== 'not_required') reasons.push('Background check is not cleared.');
  if (bg === 'cleared' && volunteer.background_check_expires_on && volunteer.background_check_expires_on < today) {
    reasons.push('Background check expired on ' + volunteer.background_check_expires_on + '.');
  }
  return { cleared: reasons.length === 0, reasons: reasons };
}

/* ---------- Staff views ---------- */

const SUPERVISOR_HIDDEN_FIELDS = [
  'court_approval_notes', 'agency_contact_email', 'agency_contact_phone', 'agency_contact_name',
  'background_check_reference', 'background_check_completed_on', 'admin_notes', 'decision_reason',
  'skills', 'availability_notes', 'preferred_assignments'
];

// Supervisors see what they need to run a shift safely, not the full file.
export function redactVolunteer(volunteer, staff) {
  if (!volunteer) return volunteer;
  if (can(staff, 'volunteers.manage')) return volunteer;
  const copy = Object.assign({}, volunteer);
  SUPERVISOR_HIDDEN_FIELDS.forEach(function (f) { delete copy[f]; });
  return copy;
}

function targetHoursFor(volunteer) {
  return volunteer.target_hours || volunteer.court_required_hours || null;
}

export async function listVolunteers(ctx, staff, query) {
  const filter = { eq: {}, order: ['created_at', 'desc'] };
  const status = query.status;
  if (status) filter.eq.status = status;
  if (query.track) filter.eq.track = query.track;

  let rows = await ctx.repo.list('volunteers', filter);
  // Supervisors never see pending or declined applications.
  if (!can(staff, 'applications.review')) {
    rows = rows.filter(function (v) { return v.status === 'approved' || v.status === 'inactive'; });
  }
  const search = cleanText(query.q).toLowerCase();
  if (search) {
    rows = rows.filter(function (v) {
      return (v.first_name + ' ' + v.last_name + ' ' + v.email).toLowerCase().indexOf(search) !== -1;
    });
  }

  const ids = rows.map(function (v) { return v.id; });
  const entries = ids.length ? await ctx.repo.list('hour_entries', { in: { volunteer_id: ids, status: ['approved', 'pending'] } }) : [];
  const today = todayInOrgTimeZone(ctx.now());

  return {
    volunteers: rows.map(function (v) {
      const summary = summarizeHours(entries.filter(function (e) { return e.volunteer_id === v.id; }), targetHoursFor(v));
      return Object.assign(redactVolunteer(v, staff), {
        hours: summary,
        youth_cleared: youthClearance(v, today).cleared
      });
    })
  };
}

export async function getVolunteerDetail(ctx, staff, id) {
  if (!isUuid(id)) throw new HttpError(400, 'Invalid volunteer id.');
  const volunteer = await ctx.repo.get('volunteers', id);
  if (!volunteer) throw new HttpError(404, 'Volunteer not found.');
  if (!can(staff, 'applications.review') && volunteer.status !== 'approved' && volunteer.status !== 'inactive') {
    throw new HttpError(404, 'Volunteer not found.');
  }

  const [acks, placements, entries, assignments] = await Promise.all([
    ctx.repo.list('agreement_acknowledgments', { eq: { volunteer_id: id }, order: ['acknowledged_at', 'desc'] }),
    ctx.repo.list('volunteer_assignments', { eq: { volunteer_id: id }, order: ['assigned_at', 'desc'] }),
    ctx.repo.list('hour_entries', { eq: { volunteer_id: id }, order: ['service_date', 'desc'] }),
    ctx.repo.list('assignments', {})
  ]);
  const letters = can(staff, 'letters.view')
    ? await ctx.repo.list('verification_letters', { eq: { volunteer_id: id }, order: ['drafted_at', 'desc'] })
    : [];

  const byId = new Map(assignments.map(function (a) { return [a.id, a]; }));
  const today = todayInOrgTimeZone(ctx.now());

  return {
    volunteer: redactVolunteer(volunteer, staff),
    acknowledgments: acks,
    placements: placements.map(function (p) {
      const a = byId.get(p.assignment_id) || {};
      return Object.assign({}, p, { assignment_name: a.name, youth_facing: !!a.youth_facing, requires_supervision: !!a.requires_supervision });
    }),
    hours: entries.map(function (e) {
      return Object.assign({}, e, {
        assignment_name: (byId.get(e.assignment_id) || {}).name,
        is_own_entry: !!staff.volunteer_id && staff.volunteer_id === e.volunteer_id
      });
    }),
    summary: summarizeHours(entries, targetHoursFor(volunteer)),
    youth_clearance: youthClearance(volunteer, today),
    letters: letters
  };
}

/* ---------- Decisions & updates ---------- */

async function loadVolunteer(ctx, id) {
  if (!isUuid(id)) throw new HttpError(400, 'Invalid volunteer id.');
  const v = await ctx.repo.get('volunteers', id);
  if (!v) throw new HttpError(404, 'Volunteer not found.');
  return v;
}

export async function decideApplication(ctx, staff, body) {
  const v = await loadVolunteer(ctx, body.volunteer_id);
  if (v.status !== 'pending') throw new HttpError(409, 'This application has already been decided.');
  if (body.decision !== 'approve' && body.decision !== 'decline') throw new HttpError(422, 'Choose approve or decline.');
  const reason = cleanMultiline(body.reason);
  if (body.decision === 'decline' && !reason) {
    throw new HttpError(422, 'Enter a reason for declining (kept internal).', { errors: { reason: 'A reason is required.' } });
  }
  if (reason.length > 1000) throw new HttpError(422, 'Reason is too long.');

  const nowIso = ctx.now().toISOString();
  const updated = await ctx.repo.update('volunteers', v.id, {
    status: body.decision === 'approve' ? 'approved' : 'declined',
    decision_reason: reason || null,
    decided_by: staff.id,
    decided_at: nowIso,
    updated_at: nowIso
  });
  await audit(ctx, staff, 'application.' + (body.decision === 'approve' ? 'approved' : 'declined'), 'volunteer', v.id, {});
  return { volunteer: updated };
}

export async function recordCourtApproval(ctx, staff, body) {
  const v = await loadVolunteer(ctx, body.volunteer_id);
  if (v.track !== 'court_ordered') throw new HttpError(422, 'Court approval only applies to court-ordered volunteers.');
  if (COURT_APPROVAL_STATUSES.indexOf(body.status) === -1) throw new HttpError(422, 'Choose a valid court approval status.');
  const notes = cleanMultiline(body.notes);
  if (notes.length > 1000) throw new HttpError(422, 'Notes are too long.');
  if (containsSsn(notes)) throw new HttpError(422, 'Do not record Social Security or case numbers that look like them in notes.');

  const nowIso = ctx.now().toISOString();
  const updated = await ctx.repo.update('volunteers', v.id, {
    court_approval_status: body.status,
    court_approval_notes: notes || null,
    court_approval_recorded_by: staff.id,
    court_approval_recorded_at: nowIso,
    updated_at: nowIso
  });
  await audit(ctx, staff, 'court_approval.recorded', 'volunteer', v.id, { status: body.status });
  return { volunteer: updated };
}

/**
 * Update admin-only screening and management fields.
 * If a change means the volunteer is no longer cleared for youth work,
 * their active youth-facing placements are ended automatically.
 */
export async function updateVolunteer(ctx, staff, id, body) {
  const v = await loadVolunteer(ctx, id);
  const patch = {};
  const errors = {};

  if ('screening_status' in body) {
    if (SCREENING_STATUSES.indexOf(body.screening_status) === -1) errors.screening_status = 'Invalid screening status.';
    else patch.screening_status = body.screening_status;
  }
  if ('background_check_status' in body) {
    if (BACKGROUND_STATUSES.indexOf(body.background_check_status) === -1) errors.background_check_status = 'Invalid background check status.';
    else patch.background_check_status = body.background_check_status;
  }
  ['background_check_completed_on', 'background_check_expires_on'].forEach(function (field) {
    if (!(field in body)) return;
    if (!body[field]) patch[field] = null;
    else if (!isValidDate(body[field])) errors[field] = 'Enter a valid date.';
    else patch[field] = body[field];
  });
  if ('background_check_reference' in body) {
    const ref = cleanText(body.background_check_reference);
    if (ref.length > 120) errors.background_check_reference = 'Reference is too long.';
    else if (containsSsn(ref)) errors.background_check_reference = 'Enter the vendor reference number only — never an SSN.';
    else patch.background_check_reference = ref || null;
  }
  if ('supervision_required' in body) patch.supervision_required = body.supervision_required === true;
  if ('target_hours' in body) {
    if (body.target_hours === '' || body.target_hours === null) patch.target_hours = null;
    else {
      const t = Number(body.target_hours);
      if (!Number.isFinite(t) || t <= 0 || t > 1000) errors.target_hours = 'Enter a target between 1 and 1000 hours.';
      else patch.target_hours = t;
    }
  }
  if ('admin_notes' in body) {
    const notes = cleanMultiline(body.admin_notes);
    if (notes.length > 2000) errors.admin_notes = 'Notes are too long.';
    else if (containsSsn(notes)) errors.admin_notes = 'Remove anything that looks like an SSN.';
    else patch.admin_notes = notes || null;
  }

  if (Object.keys(errors).length) throw new HttpError(422, 'Please correct the highlighted fields.', { errors: errors });
  if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to update.');

  patch.updated_at = ctx.now().toISOString();
  const updated = await ctx.repo.update('volunteers', v.id, patch);

  let endedPlacements = 0;
  const today = todayInOrgTimeZone(ctx.now());
  if (!youthClearance(updated, today).cleared) {
    endedPlacements = await endYouthPlacements(ctx, staff, updated.id, 'Youth clearance no longer met');
  }

  await audit(ctx, staff, 'volunteer.updated', 'volunteer', v.id, { fields: Object.keys(patch).filter(function (k) { return k !== 'updated_at'; }), ended_youth_placements: endedPlacements });
  return { volunteer: updated, ended_youth_placements: endedPlacements };
}

async function endYouthPlacements(ctx, staff, volunteerId, reason) {
  const placements = await ctx.repo.list('volunteer_assignments', { eq: { volunteer_id: volunteerId, status: 'active' } });
  let ended = 0;
  for (const p of placements) {
    const assignment = await ctx.repo.get('assignments', p.assignment_id);
    if (assignment && assignment.youth_facing) {
      await ctx.repo.update('volunteer_assignments', p.id, { status: 'ended', ended_at: ctx.now().toISOString() });
      await audit(ctx, staff, 'placement.ended', 'volunteer_assignment', p.id, { reason: reason });
      ended++;
    }
  }
  return ended;
}

export async function endVolunteerService(ctx, staff, body) {
  const v = await loadVolunteer(ctx, body.volunteer_id);
  if (v.status !== 'approved') throw new HttpError(409, 'Only approved volunteers can be ended.');
  const newStatus = body.status === 'withdrawn' ? 'withdrawn' : 'inactive';
  const reason = cleanMultiline(body.reason);
  if (!reason) throw new HttpError(422, 'Enter a reason (kept internal).', { errors: { reason: 'A reason is required.' } });

  const nowIso = ctx.now().toISOString();
  const placements = await ctx.repo.list('volunteer_assignments', { eq: { volunteer_id: v.id, status: 'active' } });
  for (const p of placements) {
    await ctx.repo.update('volunteer_assignments', p.id, { status: 'ended', ended_at: nowIso });
  }
  const updated = await ctx.repo.update('volunteers', v.id, {
    status: newStatus, ended_reason: reason, ended_at: nowIso, updated_at: nowIso
  });
  await audit(ctx, staff, 'volunteer.ended', 'volunteer', v.id, { status: newStatus, placements_ended: placements.length });
  return { volunteer: updated };
}
