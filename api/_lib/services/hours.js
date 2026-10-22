import { randomUUID } from 'node:crypto';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import {
  validateHourEntry, findOverlap, todayInOrgTimeZone, isUuid, isValidDate, cleanMultiline,
  formatHours, ACTIVE_HOUR_STATUSES
} from '../../../js/volunteer-core.js';

export const HOUR_STATUSES = ['pending', 'approved', 'rejected', 'voided'];
const EDITABLE_FIELDS = ['assignment_id', 'service_date', 'start_time', 'end_time', 'break_minutes', 'supervisor_name', 'notes'];

function snapshot(entry) {
  const out = {};
  EDITABLE_FIELDS.concat(['net_minutes', 'status', 'verified_by', 'verified_at', 'verification_note']).forEach(function (k) {
    out[k] = entry[k] === undefined ? null : entry[k];
  });
  return out;
}

function validationError(errors) {
  return new HttpError(422, 'Please correct the highlighted fields.', { errors: errors });
}

async function assertNoOverlap(ctx, entry) {
  const sameDay = await ctx.repo.list('hour_entries', {
    eq: { volunteer_id: entry.volunteer_id, service_date: entry.service_date },
    in: { status: ACTIVE_HOUR_STATUSES }
  });
  const clash = findOverlap(entry, sameDay);
  if (clash) {
    throw new HttpError(409, 'This overlaps an existing entry on ' + clash.service_date + ' from ' + clash.start_time + ' to ' + clash.end_time + '.');
  }
}

async function assertPlacement(ctx, volunteerId, assignmentId) {
  const placements = await ctx.repo.list('volunteer_assignments', { eq: { volunteer_id: volunteerId, assignment_id: assignmentId }, limit: 1 });
  if (!placements.length) throw validationError({ assignment_id: 'This volunteer has not been assigned to that activity.' });
}

async function loadEntry(ctx, id) {
  if (!isUuid(id)) throw new HttpError(400, 'Invalid hour entry id.');
  const entry = await ctx.repo.get('hour_entries', id);
  if (!entry) throw new HttpError(404, 'Hour entry not found.');
  return entry;
}

export async function listHours(ctx, staff, query) {
  const filter = { eq: {}, in: {}, gte: {}, lte: {}, order: ['service_date', 'desc'] };
  if (query.volunteer_id) {
    if (!isUuid(query.volunteer_id)) throw new HttpError(400, 'Invalid volunteer id.');
    filter.eq.volunteer_id = query.volunteer_id;
  }
  if (query.status) {
    if (HOUR_STATUSES.indexOf(query.status) === -1) throw new HttpError(400, 'Invalid status.');
    filter.eq.status = query.status;
  }
  if (query.from) {
    if (!isValidDate(query.from)) throw new HttpError(400, 'Invalid start date.');
    filter.gte.service_date = query.from;
  }
  if (query.to) {
    if (!isValidDate(query.to)) throw new HttpError(400, 'Invalid end date.');
    filter.lte.service_date = query.to;
  }

  const entries = await ctx.repo.list('hour_entries', filter);
  const volunteerIds = Array.from(new Set(entries.map(function (e) { return e.volunteer_id; })));
  const [volunteers, assignments, staffRows] = await Promise.all([
    volunteerIds.length ? ctx.repo.list('volunteers', { in: { id: volunteerIds } }) : [],
    ctx.repo.list('assignments', {}),
    ctx.repo.list('staff_users', {})
  ]);
  const vMap = new Map(volunteers.map(function (v) { return [v.id, v]; }));
  const aMap = new Map(assignments.map(function (a) { return [a.id, a]; }));
  const sMap = new Map(staffRows.map(function (s) { return [s.id, s]; }));

  return {
    entries: entries.map(function (e) {
      const v = vMap.get(e.volunteer_id) || {};
      return Object.assign({}, e, {
        volunteer_name: [v.first_name, v.last_name].filter(Boolean).join(' '),
        assignment_name: (aMap.get(e.assignment_id) || {}).name || '',
        verified_by_name: e.verified_by ? (sMap.get(e.verified_by) || {}).full_name || '' : '',
        // Lets the UI hide the approve button instead of showing a guaranteed error.
        is_own_entry: !!staff.volunteer_id && staff.volunteer_id === e.volunteer_id
      });
    })
  };
}

export async function createHourEntry(ctx, staff, body) {
  const today = todayInOrgTimeZone(ctx.now());
  const result = validateHourEntry(body, { today: today });
  if (!result.ok) throw validationError(result.errors);
  const value = result.value;

  const volunteer = await ctx.repo.get('volunteers', value.volunteer_id);
  if (!volunteer) throw new HttpError(404, 'Volunteer not found.');
  if (volunteer.status !== 'approved' && volunteer.status !== 'inactive') {
    throw new HttpError(409, 'Hours can only be logged for approved volunteers.');
  }
  await assertPlacement(ctx, value.volunteer_id, value.assignment_id);
  await assertNoOverlap(ctx, value);

  const nowIso = ctx.now().toISOString();
  const row = await ctx.repo.insert('hour_entries', {
    id: randomUUID(),
    volunteer_id: value.volunteer_id,
    assignment_id: value.assignment_id,
    service_date: value.service_date,
    start_time: value.start_time,
    end_time: value.end_time,
    break_minutes: value.break_minutes,
    net_minutes: value.net_minutes,
    supervisor_name: value.supervisor_name,
    notes: value.notes || null,
    status: 'pending',
    created_by: staff.id,
    created_at: nowIso,
    updated_at: nowIso,
    verified_by: null,
    verified_at: null,
    verification_note: null
  });
  await audit(ctx, staff, 'hours.created', 'hour_entry', row.id, { volunteer_id: row.volunteer_id, net_minutes: row.net_minutes });
  return { entry: row };
}

export async function verifyHourEntry(ctx, staff, body) {
  const entry = await loadEntry(ctx, body.id);
  if (entry.status !== 'pending') throw new HttpError(409, 'Only pending entries can be verified.');
  if (staff.volunteer_id && staff.volunteer_id === entry.volunteer_id) {
    throw new HttpError(403, 'You cannot verify your own volunteer hours. Ask another supervisor.');
  }
  if (body.decision !== 'approve' && body.decision !== 'reject') throw new HttpError(422, 'Choose approve or reject.');
  const note = cleanMultiline(body.note);
  if (body.decision === 'reject' && !note) throw validationError({ note: 'Explain why these hours are being rejected.' });
  if (note.length > 1000) throw validationError({ note: 'Note is too long.' });

  const nowIso = ctx.now().toISOString();
  const row = await ctx.repo.update('hour_entries', entry.id, {
    status: body.decision === 'approve' ? 'approved' : 'rejected',
    verified_by: staff.id,
    verified_at: nowIso,
    verification_note: note || null,
    updated_at: nowIso
  });
  await audit(ctx, staff, 'hours.' + (body.decision === 'approve' ? 'approved' : 'rejected'), 'hour_entry', entry.id, { volunteer_id: entry.volunteer_id });
  return { entry: row };
}

/**
 * Correct an entry. The previous values are saved to the revision history,
 * and a corrected entry always goes back to "pending" for re-verification.
 */
export async function correctHourEntry(ctx, staff, id, body) {
  const entry = await loadEntry(ctx, id);
  if (entry.status === 'voided') throw new HttpError(409, 'Voided entries cannot be edited.');
  const reason = cleanMultiline(body.reason);
  if (!reason) throw validationError({ reason: 'Enter a reason for this correction.' });
  if (reason.length > 1000) throw validationError({ reason: 'Reason is too long.' });

  const merged = Object.assign({}, entry);
  EDITABLE_FIELDS.forEach(function (k) { if (k in body) merged[k] = body[k]; });

  const result = validateHourEntry(merged, { today: todayInOrgTimeZone(ctx.now()), skipVolunteer: true });
  if (!result.ok) throw validationError(result.errors);
  const value = result.value;

  const changed = EDITABLE_FIELDS.filter(function (k) {
    return String(value[k] == null ? '' : value[k]) !== String(entry[k] == null ? '' : entry[k]);
  });
  if (!changed.length) throw new HttpError(422, 'No changes to save.');

  if (value.assignment_id !== entry.assignment_id) await assertPlacement(ctx, entry.volunteer_id, value.assignment_id);
  await assertNoOverlap(ctx, Object.assign({}, value, { id: entry.id, volunteer_id: entry.volunteer_id }));

  const nowIso = ctx.now().toISOString();
  await ctx.repo.insert('hour_entry_revisions', {
    id: randomUUID(),
    hour_entry_id: entry.id,
    changed_by: staff.id,
    changed_at: nowIso,
    reason: reason,
    previous: snapshot(entry)
  });
  const row = await ctx.repo.update('hour_entries', entry.id, {
    assignment_id: value.assignment_id,
    service_date: value.service_date,
    start_time: value.start_time,
    end_time: value.end_time,
    break_minutes: value.break_minutes,
    net_minutes: value.net_minutes,
    supervisor_name: value.supervisor_name,
    notes: value.notes || null,
    status: 'pending',
    verified_by: null,
    verified_at: null,
    verification_note: null,
    updated_at: nowIso
  });
  await audit(ctx, staff, 'hours.corrected', 'hour_entry', entry.id, { fields: changed, previous_status: entry.status });
  return { entry: row };
}

export async function voidHourEntry(ctx, staff, body) {
  const entry = await loadEntry(ctx, body.id);
  if (entry.status === 'voided') throw new HttpError(409, 'This entry is already voided.');
  const reason = cleanMultiline(body.reason);
  if (!reason) throw validationError({ reason: 'Enter a reason for voiding this entry.' });

  const nowIso = ctx.now().toISOString();
  await ctx.repo.insert('hour_entry_revisions', {
    id: randomUUID(), hour_entry_id: entry.id, changed_by: staff.id, changed_at: nowIso,
    reason: 'Voided: ' + reason, previous: snapshot(entry)
  });
  const row = await ctx.repo.update('hour_entries', entry.id, { status: 'voided', updated_at: nowIso });
  await audit(ctx, staff, 'hours.voided', 'hour_entry', entry.id, { previous_status: entry.status });
  return { entry: row };
}

export async function hourHistory(ctx, staff, id) {
  const entry = await loadEntry(ctx, id);
  const [revisions, staffRows] = await Promise.all([
    ctx.repo.list('hour_entry_revisions', { eq: { hour_entry_id: entry.id }, order: ['changed_at', 'desc'] }),
    ctx.repo.list('staff_users', {})
  ]);
  const sMap = new Map(staffRows.map(function (s) { return [s.id, s.full_name]; }));
  return {
    entry: entry,
    revisions: revisions.map(function (r) { return Object.assign({}, r, { changed_by_name: sMap.get(r.changed_by) || '' }); })
  };
}

/* ---------- CSV export ---------- */

// Prevent spreadsheet formula injection (e.g. a note starting with "=").
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows) {
  return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
}

export async function exportHoursCsv(ctx, staff, query) {
  const { entries } = await listHours(ctx, staff, query);
  const header = ['Volunteer', 'Assignment', 'Service Date', 'Start', 'End', 'Break (min)', 'Net Hours', 'Supervisor', 'Status', 'Verified By', 'Verified At', 'Notes'];
  const rows = entries.map(function (e) {
    return [
      e.volunteer_name, e.assignment_name, e.service_date, e.start_time, e.end_time, e.break_minutes,
      formatHours(e.net_minutes), e.supervisor_name, e.status, e.verified_by_name, e.verified_at || '', e.notes || ''
    ];
  });
  await audit(ctx, staff, 'hours.exported', 'hour_entry', null, { rows: rows.length, filters: Object.keys(query).filter(function (k) { return query[k]; }) });
  return { csv: toCsv([header].concat(rows)), filename: 'volunteer-hours-' + todayInOrgTimeZone(ctx.now()) + '.csv' };
}
