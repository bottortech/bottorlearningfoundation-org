import { randomUUID } from 'node:crypto';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { cleanText, cleanMultiline, isUuid, todayInOrgTimeZone } from '../../../js/volunteer-core.js';
import { youthClearance } from './volunteers.js';

function validateAssignment(body, partial) {
  const errors = {};
  const value = {};
  if (!partial || 'name' in body) {
    value.name = cleanText(body.name);
    if (!value.name) errors.name = 'Enter an assignment name.';
    else if (value.name.length > 120) errors.name = 'Name is too long.';
  }
  if (!partial || 'description' in body) {
    value.description = cleanMultiline(body.description) || null;
    if (value.description && value.description.length > 1000) errors.description = 'Description is too long.';
  }
  if (!partial || 'location' in body) {
    value.location = cleanText(body.location) || null;
    if (value.location && value.location.length > 200) errors.location = 'Location is too long.';
  }
  if (!partial || 'youth_facing' in body) value.youth_facing = body.youth_facing === true;
  if (!partial || 'requires_supervision' in body) value.requires_supervision = body.requires_supervision !== false;
  if (partial && 'active' in body) value.active = body.active === true;
  // Youth-facing work is always supervised.
  if (value.youth_facing) value.requires_supervision = true;
  if (Object.keys(errors).length) throw new HttpError(422, 'Please correct the highlighted fields.', { errors: errors });
  return value;
}

export async function listAssignments(ctx) {
  const [assignments, placements] = await Promise.all([
    ctx.repo.list('assignments', { order: ['name', 'asc'] }),
    ctx.repo.list('volunteer_assignments', { eq: { status: 'active' } })
  ]);
  return {
    assignments: assignments.map(function (a) {
      return Object.assign({}, a, {
        active_volunteers: placements.filter(function (p) { return p.assignment_id === a.id; }).length
      });
    })
  };
}

export async function createAssignment(ctx, staff, body) {
  const value = validateAssignment(body, false);
  const nowIso = ctx.now().toISOString();
  const row = await ctx.repo.insert('assignments', Object.assign({ id: randomUUID(), active: true, created_at: nowIso, updated_at: nowIso }, value));
  await audit(ctx, staff, 'assignment.created', 'assignment', row.id, { youth_facing: row.youth_facing });
  return { assignment: row };
}

export async function updateAssignment(ctx, staff, id, body) {
  if (!isUuid(id)) throw new HttpError(400, 'Invalid assignment id.');
  const existing = await ctx.repo.get('assignments', id);
  if (!existing) throw new HttpError(404, 'Assignment not found.');
  const value = validateAssignment(body, true);

  if (value.youth_facing && !existing.youth_facing) {
    const today = todayInOrgTimeZone(ctx.now());
    const placements = await ctx.repo.list('volunteer_assignments', { eq: { assignment_id: id, status: 'active' } });
    for (const p of placements) {
      const v = await ctx.repo.get('volunteers', p.volunteer_id);
      if (!v || !youthClearance(v, today).cleared) {
        throw new HttpError(409, 'Some volunteers in this assignment are not cleared for youth-facing work. End their placements or complete their screening first.');
      }
    }
  }

  value.updated_at = ctx.now().toISOString();
  const row = await ctx.repo.update('assignments', id, value);
  await audit(ctx, staff, 'assignment.updated', 'assignment', id, { fields: Object.keys(value).filter(function (k) { return k !== 'updated_at'; }) });
  return { assignment: row };
}

export async function assignVolunteer(ctx, staff, body) {
  if (!isUuid(body.volunteer_id) || !isUuid(body.assignment_id)) throw new HttpError(400, 'Choose a volunteer and an assignment.');
  const supervisor = cleanText(body.supervisor_name);
  if (!supervisor) throw new HttpError(422, 'Name the supervisor for this placement.', { errors: { supervisor_name: 'A supervisor is required.' } });
  if (supervisor.length > 120) throw new HttpError(422, 'Supervisor name is too long.');

  const [volunteer, assignment] = await Promise.all([
    ctx.repo.get('volunteers', body.volunteer_id),
    ctx.repo.get('assignments', body.assignment_id)
  ]);
  if (!volunteer) throw new HttpError(404, 'Volunteer not found.');
  if (!assignment) throw new HttpError(404, 'Assignment not found.');
  if (volunteer.status !== 'approved') throw new HttpError(409, 'Only approved volunteers can be assigned.');
  if (!assignment.active) throw new HttpError(409, 'This assignment is not active.');

  if (assignment.youth_facing) {
    const clearance = youthClearance(volunteer, todayInOrgTimeZone(ctx.now()));
    if (!clearance.cleared) {
      throw new HttpError(422, 'This is a youth-facing assignment. Screening must be complete before placement.', { reasons: clearance.reasons });
    }
  }

  const existing = await ctx.repo.list('volunteer_assignments', {
    eq: { volunteer_id: volunteer.id, assignment_id: assignment.id, status: 'active' }, limit: 1
  });
  if (existing.length) throw new HttpError(409, 'This volunteer is already assigned to that activity.');

  const row = await ctx.repo.insert('volunteer_assignments', {
    id: randomUUID(),
    volunteer_id: volunteer.id,
    assignment_id: assignment.id,
    supervisor_name: supervisor,
    status: 'active',
    assigned_by: staff.id,
    assigned_at: ctx.now().toISOString(),
    ended_at: null
  });
  await audit(ctx, staff, 'placement.created', 'volunteer_assignment', row.id, {
    volunteer_id: volunteer.id, assignment_id: assignment.id, youth_facing: !!assignment.youth_facing
  });
  return { placement: row };
}

export async function endPlacement(ctx, staff, body) {
  if (!isUuid(body.placement_id)) throw new HttpError(400, 'Invalid placement id.');
  const p = await ctx.repo.get('volunteer_assignments', body.placement_id);
  if (!p) throw new HttpError(404, 'Placement not found.');
  if (p.status !== 'active') throw new HttpError(409, 'This placement has already ended.');
  const row = await ctx.repo.update('volunteer_assignments', p.id, { status: 'ended', ended_at: ctx.now().toISOString() });
  await audit(ctx, staff, 'placement.ended', 'volunteer_assignment', p.id, {});
  return { placement: row };
}
