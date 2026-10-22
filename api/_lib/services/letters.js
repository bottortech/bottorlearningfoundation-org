import { randomBytes, randomUUID } from 'node:crypto';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { can } from '../permissions.js';
import { ORG } from '../org.js';
import { isUuid, cleanMultiline, formatHours, todayInOrgTimeZone } from '../../../js/volunteer-core.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatLongDate(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  return MONTHS[m - 1] + ' ' + d + ', ' + y;
}

function newLetterNumber(now) {
  return 'BLF-VL-' + now.getUTCFullYear() + '-' + randomBytes(3).toString('hex').toUpperCase();
}

// Totals are always recomputed from supervisor-approved entries only.
async function verifiedTotals(ctx, volunteerId) {
  const entries = await ctx.repo.list('hour_entries', { eq: { volunteer_id: volunteerId, status: 'approved' } });
  const ids = entries.map(function (e) { return e.id; }).sort();
  const dates = entries.map(function (e) { return e.service_date; }).sort();
  return {
    entry_ids: ids,
    entry_count: entries.length,
    total_minutes: entries.reduce(function (t, e) { return t + Number(e.net_minutes); }, 0),
    first_service_date: dates[0] || null,
    last_service_date: dates[dates.length - 1] || null
  };
}

async function loadLetter(ctx, id) {
  if (!isUuid(id)) throw new HttpError(400, 'Invalid letter id.');
  const letter = await ctx.repo.get('verification_letters', id);
  if (!letter) throw new HttpError(404, 'Letter not found.');
  return letter;
}

export async function listLetters(ctx, staff, query) {
  const filter = { eq: {}, order: ['drafted_at', 'desc'] };
  if (query.volunteer_id) {
    if (!isUuid(query.volunteer_id)) throw new HttpError(400, 'Invalid volunteer id.');
    filter.eq.volunteer_id = query.volunteer_id;
  }
  if (query.status) filter.eq.status = query.status;
  const letters = await ctx.repo.list('verification_letters', filter);
  const ids = Array.from(new Set(letters.map(function (l) { return l.volunteer_id; })));
  const volunteers = ids.length ? await ctx.repo.list('volunteers', { in: { id: ids } }) : [];
  const vMap = new Map(volunteers.map(function (v) { return [v.id, v]; }));
  return {
    letters: letters.map(function (l) {
      const v = vMap.get(l.volunteer_id) || {};
      return Object.assign({}, l, { volunteer_name: [v.first_name, v.last_name].filter(Boolean).join(' '), track: v.track });
    })
  };
}

export async function draftLetter(ctx, staff, body) {
  if (!isUuid(body.volunteer_id)) throw new HttpError(400, 'Invalid volunteer id.');
  const volunteer = await ctx.repo.get('volunteers', body.volunteer_id);
  if (!volunteer) throw new HttpError(404, 'Volunteer not found.');
  if (volunteer.status !== 'approved' && volunteer.status !== 'inactive') {
    throw new HttpError(409, 'Letters can only be drafted for approved or former volunteers.');
  }
  const totals = await verifiedTotals(ctx, volunteer.id);
  if (!totals.entry_count) {
    throw new HttpError(422, 'This volunteer has no supervisor-approved hours yet. Letters only include verified hours.');
  }

  const now = ctx.now();
  const letter = await ctx.repo.insert('verification_letters', Object.assign({
    id: randomUUID(),
    letter_number: newLetterNumber(now),
    volunteer_id: volunteer.id,
    status: 'draft',
    issue_date: null,
    signer_name: null,
    signer_title: null,
    drafted_by: staff.id,
    drafted_at: now.toISOString(),
    approved_by: null,
    approved_at: null
  }, totals));
  await audit(ctx, staff, 'letter.drafted', 'verification_letter', letter.id, { volunteer_id: volunteer.id, total_minutes: totals.total_minutes });
  return { letter: letter };
}

/**
 * An authorized signer approves a draft. The verified totals are recomputed;
 * if any approved hours changed since the draft, approval is refused so a
 * letter can never certify numbers that differ from the verified record.
 */
export async function approveLetter(ctx, staff, body) {
  if (!can(staff, 'letters.approve')) {
    throw new HttpError(403, 'Only an administrator designated as an authorized signer can approve letters.');
  }
  if (body.confirm_reviewed !== true) {
    throw new HttpError(422, 'Confirm that you have reviewed the verified hour records before approving.');
  }
  const letter = await loadLetter(ctx, body.id);
  if (letter.status !== 'draft') throw new HttpError(409, 'Only draft letters can be approved.');
  if (staff.volunteer_id && staff.volunteer_id === letter.volunteer_id) {
    throw new HttpError(403, 'You cannot approve a verification letter for your own hours.');
  }

  const totals = await verifiedTotals(ctx, letter.volunteer_id);
  const sameEntries = totals.entry_ids.join(',') === (letter.entry_ids || []).slice().sort().join(',');
  if (!sameEntries || totals.total_minutes !== letter.total_minutes) {
    throw new HttpError(409, 'Verified hours have changed since this draft was created. Void this draft and create a new one.');
  }

  const now = ctx.now();
  const updated = await ctx.repo.update('verification_letters', letter.id, {
    status: 'approved',
    issue_date: todayInOrgTimeZone(now),
    signer_name: staff.full_name,
    signer_title: staff.title,
    approved_by: staff.id,
    approved_at: now.toISOString()
  });
  await audit(ctx, staff, 'letter.approved', 'verification_letter', letter.id, { volunteer_id: letter.volunteer_id, total_minutes: letter.total_minutes });
  return { letter: updated };
}

export async function voidLetter(ctx, staff, body) {
  const letter = await loadLetter(ctx, body.id);
  if (letter.status === 'void') throw new HttpError(409, 'This letter is already void.');
  // Only signers may void an issued letter; coordinators may discard drafts.
  if (letter.status === 'approved' && !can(staff, 'letters.approve')) {
    throw new HttpError(403, 'Only an authorized signer can void an approved letter.');
  }
  const reason = cleanMultiline(body.reason);
  if (!reason) throw new HttpError(422, 'Enter a reason for voiding this letter.', { errors: { reason: 'A reason is required.' } });

  const updated = await ctx.repo.update('verification_letters', letter.id, {
    status: 'void', voided_by: staff.id, voided_at: ctx.now().toISOString(), void_reason: reason
  });
  await audit(ctx, staff, 'letter.voided', 'verification_letter', letter.id, { previous_status: letter.status });
  return { letter: updated };
}

/**
 * Build the printable letter content. Pure function — no I/O.
 * A signature is NEVER generated: approved letters show the signer's typed
 * name and title beneath a blank line for a handwritten signature.
 */
export function buildLetterDocument(letter, volunteer, org) {
  const o = org || ORG;
  const name = volunteer.first_name + ' ' + volunteer.last_name;
  const hours = formatHours(letter.total_minutes);
  const court = volunteer.track === 'court_ordered';
  const serviceKind = court ? 'community service' : 'volunteer service';
  const range = letter.first_service_date === letter.last_service_date
    ? 'on ' + formatLongDate(letter.first_service_date)
    : 'between ' + formatLongDate(letter.first_service_date) + ' and ' + formatLongDate(letter.last_service_date);
  const approved = letter.status === 'approved';

  const paragraphs = [
    'This letter verifies that ' + name + ' completed ' + hours + ' hours of ' + serviceKind +
      ' with ' + o.name + ' ' + range + '.',
    'These hours were recorded by ' + o.name + ' staff, and each entry was individually reviewed and approved ' +
      'by a supervising staff member. Only supervisor-approved hours are included in this total. Hours that ' +
      'were pending, rejected, or voided at the time this letter was approved are not included.'
  ];
  if (court) {
    paragraphs.push(
      'This letter reports verified service hours only. Whether these hours satisfy a court or agency ' +
      'requirement is determined by the court or supervising agency' +
      (volunteer.agency_name ? ' (' + volunteer.agency_name + ')' : '') + '.'
    );
  }
  paragraphs.push(
    'To confirm the authenticity of this letter, please contact ' + o.name + ' at ' + o.email +
      ' and reference letter number ' + letter.letter_number + '.'
  );

  return {
    status: letter.status,
    isDraft: letter.status === 'draft',
    isVoid: letter.status === 'void',
    org: o,
    letterNumber: letter.letter_number,
    issueDate: approved ? formatLongDate(letter.issue_date) : null,
    salutation: 'To Whom It May Concern:',
    subject: 'Verification of ' + (court ? 'Community Service' : 'Volunteer Service') + ' Hours — ' + name,
    paragraphs: paragraphs,
    summary: [
      ['Volunteer', name],
      ['Verified total', hours + ' hours'],
      ['Service period', formatLongDate(letter.first_service_date) + ' – ' + formatLongDate(letter.last_service_date)],
      ['Approved entries', String(letter.entry_count)],
      ['Letter number', letter.letter_number]
    ],
    closing: 'Sincerely,',
    signer: approved ? { name: letter.signer_name, title: letter.signer_title } : null
  };
}

export async function getLetterView(ctx, staff, id) {
  const letter = await loadLetter(ctx, id);
  const volunteer = await ctx.repo.get('volunteers', letter.volunteer_id);
  if (!volunteer) throw new HttpError(404, 'Volunteer not found.');
  await audit(ctx, staff, 'letter.viewed', 'verification_letter', letter.id, { status: letter.status });
  return {
    letter: letter,
    document: buildLetterDocument(letter, volunteer, ORG),
    can_approve: can(staff, 'letters.approve') && letter.status === 'draft' &&
      !(staff.volunteer_id && staff.volunteer_id === letter.volunteer_id)
  };
}
