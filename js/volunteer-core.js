/* ============================================
   BOTTOR LEARNING FOUNDATION — Volunteer rules
   Shared by the public volunteer page (browser) and the
   serverless API (Node). The server is always the authority;
   the browser copy only gives faster, friendlier feedback.
   ============================================ */

export const MINIMUM_AGE = 18;
export const ORG_TIME_ZONE = 'America/Chicago';

export const TRACKS = {
  general: 'General Volunteer',
  court_ordered: 'Court-Ordered Community Service'
};

export const AVAILABILITY_OPTIONS = [
  { value: 'weekday_daytime', label: 'Weekday daytime' },
  { value: 'weekday_evening', label: 'Weekday evenings' },
  { value: 'saturday', label: 'Saturdays' },
  { value: 'sunday', label: 'Sundays' },
  { value: 'school_breaks', label: 'Summer & school breaks' }
];

export const INTEREST_OPTIONS = [
  { value: 'inventor_workshop', label: 'Inventor Workshop classroom support' },
  { value: 'literacy_events', label: 'Library & community literacy events' },
  { value: 'book_distribution', label: 'Book distribution & donation drives' },
  { value: 'inventors_expo', label: 'Inventors Expo support' },
  { value: 'event_setup', label: 'Event setup & hospitality' },
  { value: 'media', label: 'Photography, video & social media' },
  { value: 'tech_support', label: 'Tech & AV support' },
  { value: 'admin_support', label: 'Office & administrative support' }
];

export const COURT_REPORTED_STATUS_OPTIONS = [
  { value: 'approved', label: 'My agency has already approved this placement' },
  { value: 'pending', label: 'I have asked and am waiting for an answer' },
  { value: 'not_requested', label: 'I have not asked my agency yet' },
  { value: 'unsure', label: 'I am not sure' }
];

export const LIMITS = {
  name: 80,
  email: 254,
  shortText: 120,
  relationship: 60,
  agency: 160,
  notes: 500,
  longText: 1000,
  maxCourtHours: 1000,
  maxBreakMinutes: 600,
  maxShiftMinutes: 16 * 60
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Used to stop people pasting Social Security numbers into free-text fields.
const SSN_RE = /\b\d{3}-?\d{2}-?\d{4}\b/;

/* ---------- Small helpers ---------- */

export function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

// Like cleanText, but keeps line breaks for multi-line answers.
export function cleanMultiline(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function isValidEmail(value) {
  return typeof value === 'string' && value.length <= LIMITS.email && EMAIL_RE.test(value);
}

export function isValidPhone(value) {
  if (typeof value !== 'string') return false;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 && /^[\d\s().+-]+$/.test(value.trim());
}

export function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function containsSsn(value) {
  return typeof value === 'string' && SSN_RE.test(value);
}

// Today's date (YYYY-MM-DD) in Milwaukee, regardless of server time zone.
export function todayInOrgTimeZone(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ORG_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

function pickList(value, options) {
  const allowed = new Set(options.map(function (o) { return o.value; }));
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(function (v) { return allowed.has(v); })));
}

function namesMatch(typed, first, last) {
  const norm = function (s) { return cleanText(s).toLowerCase(); };
  return norm(typed) === norm(first + ' ' + last);
}

/* ---------- Application validation ---------- */

/**
 * Validate a volunteer application.
 * Builds `value` from an allow-list of fields, so anything unexpected is dropped.
 * @returns {{ ok: boolean, errors: Object<string,string>, value: Object }}
 */
export function validateApplication(input, options) {
  const opts = options || {};
  const today = opts.today || todayInOrgTimeZone();
  const agreementVersion = opts.agreementVersion;
  const src = input && typeof input === 'object' ? input : {};
  const errors = {};

  const value = {
    track: src.track,
    first_name: cleanText(src.first_name),
    last_name: cleanText(src.last_name),
    email: cleanText(src.email).toLowerCase(),
    phone: cleanText(src.phone),
    age_confirmed: src.age_confirmed === true,
    availability_days: pickList(src.availability_days, AVAILABILITY_OPTIONS),
    availability_notes: cleanMultiline(src.availability_notes),
    interests: pickList(src.interests, INTEREST_OPTIONS),
    skills: cleanMultiline(src.skills),
    preferred_assignments: cleanMultiline(src.preferred_assignments),
    emergency_name: cleanText(src.emergency_name),
    emergency_relationship: cleanText(src.emergency_relationship),
    emergency_phone: cleanText(src.emergency_phone),
    privacy_ack: src.privacy_ack === true,
    agreement_ack: src.agreement_ack === true,
    agreement_version: cleanText(src.agreement_version),
    typed_name: cleanText(src.typed_name)
  };

  if (!Object.prototype.hasOwnProperty.call(TRACKS, value.track)) {
    errors.track = 'Choose General Volunteer or Court-Ordered Community Service.';
  }

  if (!value.first_name) errors.first_name = 'Enter your first name.';
  else if (value.first_name.length > LIMITS.name) errors.first_name = 'First name is too long.';
  if (!value.last_name) errors.last_name = 'Enter your last name.';
  else if (value.last_name.length > LIMITS.name) errors.last_name = 'Last name is too long.';

  if (!value.email) errors.email = 'Enter your email address.';
  else if (!isValidEmail(value.email)) errors.email = 'Enter a valid email address, like name@example.com.';

  if (!value.phone) errors.phone = 'Enter your phone number.';
  else if (!isValidPhone(value.phone)) errors.phone = 'Enter a valid phone number with area code.';

  if (!value.age_confirmed) {
    errors.age_confirmed = 'Volunteers must be ' + MINIMUM_AGE + ' or older. Please confirm your age.';
  }

  if (value.availability_days.length === 0) errors.availability_days = 'Choose at least one time you are available.';
  if (value.availability_notes.length > LIMITS.notes) errors.availability_notes = 'Please keep availability notes under ' + LIMITS.notes + ' characters.';
  if (value.interests.length === 0) errors.interests = 'Choose at least one area you are interested in.';
  if (value.skills.length > LIMITS.longText) errors.skills = 'Please keep this under ' + LIMITS.longText + ' characters.';
  if (value.preferred_assignments.length > LIMITS.notes) errors.preferred_assignments = 'Please keep this under ' + LIMITS.notes + ' characters.';

  ['availability_notes', 'skills', 'preferred_assignments'].forEach(function (field) {
    if (!errors[field] && containsSsn(value[field])) {
      errors[field] = 'Please remove any Social Security or ID numbers. We never need them.';
    }
  });

  if (!value.emergency_name) errors.emergency_name = 'Enter an emergency contact name.';
  else if (value.emergency_name.length > LIMITS.shortText) errors.emergency_name = 'Name is too long.';
  if (!value.emergency_relationship) errors.emergency_relationship = 'Enter how this person is related to you.';
  else if (value.emergency_relationship.length > LIMITS.relationship) errors.emergency_relationship = 'Please shorten this.';
  if (!value.emergency_phone) errors.emergency_phone = 'Enter an emergency contact phone number.';
  else if (!isValidPhone(value.emergency_phone)) errors.emergency_phone = 'Enter a valid phone number with area code.';

  if (value.track === 'court_ordered') {
    const hours = Number(src.court_required_hours);
    value.court_required_hours = hours;
    value.court_deadline = cleanText(src.court_deadline);
    value.agency_name = cleanText(src.agency_name);
    value.agency_contact_name = cleanText(src.agency_contact_name);
    value.agency_contact_email = cleanText(src.agency_contact_email).toLowerCase();
    value.agency_contact_phone = cleanText(src.agency_contact_phone);
    value.court_reported_status = src.court_reported_status;
    value.court_terms_ack = src.court_terms_ack === true;

    if (src.court_required_hours === '' || src.court_required_hours == null || !Number.isFinite(hours)) {
      errors.court_required_hours = 'Enter the number of service hours you are required to complete.';
    } else if (hours <= 0 || hours > LIMITS.maxCourtHours) {
      errors.court_required_hours = 'Enter a number of hours between 1 and ' + LIMITS.maxCourtHours + '.';
    } else if (Math.round(hours * 4) !== hours * 4) {
      errors.court_required_hours = 'Enter hours in quarter-hour steps (for example 20 or 20.5).';
    }

    if (!value.court_deadline) errors.court_deadline = 'Enter your completion deadline.';
    else if (!isValidDate(value.court_deadline)) errors.court_deadline = 'Enter a valid date.';
    else if (value.court_deadline < today) errors.court_deadline = 'The deadline has already passed. Please contact your agency before applying.';

    if (!value.agency_name) errors.agency_name = 'Enter the supervising agency or court program.';
    else if (value.agency_name.length > LIMITS.agency) errors.agency_name = 'Agency name is too long.';
    if (!value.agency_contact_name) errors.agency_contact_name = 'Enter your agency contact or case worker name.';
    else if (value.agency_contact_name.length > LIMITS.shortText) errors.agency_contact_name = 'Name is too long.';

    if (!value.agency_contact_email && !value.agency_contact_phone) {
      errors.agency_contact_email = 'Enter an email or phone number for your agency contact.';
    }
    if (value.agency_contact_email && !isValidEmail(value.agency_contact_email)) {
      errors.agency_contact_email = 'Enter a valid email address for your agency contact.';
    }
    if (value.agency_contact_phone && !isValidPhone(value.agency_contact_phone)) {
      errors.agency_contact_phone = 'Enter a valid phone number for your agency contact.';
    }

    if (!COURT_REPORTED_STATUS_OPTIONS.some(function (o) { return o.value === value.court_reported_status; })) {
      errors.court_reported_status = 'Tell us whether your agency has approved this placement.';
    }
    if (!value.court_terms_ack) {
      errors.court_terms_ack = 'Please confirm you understand that acceptance and court recognition are subject to approval.';
    }
  }

  if (!value.agreement_ack) errors.agreement_ack = 'Please confirm you have read and agree to the Volunteer Agreement.';
  if (agreementVersion && value.agreement_version !== agreementVersion) {
    errors.agreement_ack = 'The Volunteer Agreement has been updated. Please reload the page and review it again.';
  }
  if (!value.typed_name) errors.typed_name = 'Type your full name to acknowledge the agreement.';
  else if (!errors.first_name && !errors.last_name && !namesMatch(value.typed_name, value.first_name, value.last_name)) {
    errors.typed_name = 'Type your name exactly as entered above (' + value.first_name + ' ' + value.last_name + ').';
  }

  if (!value.privacy_ack) errors.privacy_ack = 'Please confirm you have read the privacy notice.';

  return { ok: Object.keys(errors).length === 0, errors: errors, value: value };
}

/* ---------- Hour calculations ---------- */

export function parseTimeToMinutes(value) {
  if (typeof value !== 'string') return null;
  const match = TIME_RE.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function normalizeTime(value) {
  const minutes = parseTimeToMinutes(value);
  if (minutes === null) return null;
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}

/**
 * Net minutes for a shift: (end - start) - break.
 * @returns {{ ok: true, minutes: number } | { ok: false, error: string, field: string }}
 */
export function calculateNetMinutes(startTime, endTime, breakMinutes) {
  const start = parseTimeToMinutes(startTime);
  const end = parseTimeToMinutes(endTime);
  const brk = breakMinutes === '' || breakMinutes == null ? 0 : Number(breakMinutes);

  if (start === null) return { ok: false, field: 'start_time', error: 'Enter a valid start time.' };
  if (end === null) return { ok: false, field: 'end_time', error: 'Enter a valid end time.' };
  if (end <= start) return { ok: false, field: 'end_time', error: 'End time must be after start time (shifts cannot cross midnight).' };
  if (!Number.isInteger(brk) || brk < 0) return { ok: false, field: 'break_minutes', error: 'Break must be zero or a whole number of minutes.' };
  if (brk > LIMITS.maxBreakMinutes) return { ok: false, field: 'break_minutes', error: 'Break is too long.' };

  const span = end - start;
  if (span > LIMITS.maxShiftMinutes) return { ok: false, field: 'end_time', error: 'A single entry cannot be longer than 16 hours.' };
  const net = span - brk;
  if (net <= 0) return { ok: false, field: 'break_minutes', error: 'Break cannot be as long as or longer than the shift.' };
  return { ok: true, minutes: net };
}

export function formatHours(minutes) {
  return (Math.round((Number(minutes) || 0) / 60 * 100) / 100).toFixed(2);
}

/**
 * Validate a staff-entered hour record.
 * @returns {{ ok: boolean, errors: Object<string,string>, value: Object }}
 */
export function validateHourEntry(input, options) {
  const opts = options || {};
  const today = opts.today || todayInOrgTimeZone();
  const src = input && typeof input === 'object' ? input : {};
  const errors = {};

  const value = {
    volunteer_id: src.volunteer_id,
    assignment_id: src.assignment_id,
    service_date: cleanText(src.service_date),
    start_time: normalizeTime(src.start_time),
    end_time: normalizeTime(src.end_time),
    break_minutes: src.break_minutes === '' || src.break_minutes == null ? 0 : Number(src.break_minutes),
    supervisor_name: cleanText(src.supervisor_name),
    notes: cleanMultiline(src.notes)
  };

  if (!opts.skipVolunteer && !isUuid(value.volunteer_id)) errors.volunteer_id = 'Choose a volunteer.';
  if (!isUuid(value.assignment_id)) errors.assignment_id = 'Choose an assignment.';

  if (!value.service_date) errors.service_date = 'Enter the service date.';
  else if (!isValidDate(value.service_date)) errors.service_date = 'Enter a valid date.';
  else if (value.service_date > today) errors.service_date = 'Hours cannot be logged for a future date.';

  const net = calculateNetMinutes(src.start_time, src.end_time, src.break_minutes);
  if (!net.ok) errors[net.field] = net.error;
  else value.net_minutes = net.minutes;

  if (!value.supervisor_name) errors.supervisor_name = 'Enter the supervisor for this shift.';
  else if (value.supervisor_name.length > LIMITS.shortText) errors.supervisor_name = 'Supervisor name is too long.';
  if (value.notes.length > LIMITS.longText) errors.notes = 'Notes must be under ' + LIMITS.longText + ' characters.';

  return { ok: Object.keys(errors).length === 0, errors: errors, value: value };
}

// Only pending and approved entries block a time slot.
export const ACTIVE_HOUR_STATUSES = ['pending', 'approved'];

/** Returns the first existing entry that overlaps `entry` on the same date, or null. */
export function findOverlap(entry, existingEntries) {
  const start = parseTimeToMinutes(entry.start_time);
  const end = parseTimeToMinutes(entry.end_time);
  return (existingEntries || []).find(function (other) {
    if (other.id && entry.id && other.id === entry.id) return false;
    if (other.volunteer_id !== entry.volunteer_id) return false;
    if (other.service_date !== entry.service_date) return false;
    if (ACTIVE_HOUR_STATUSES.indexOf(other.status) === -1) return false;
    const oStart = parseTimeToMinutes(other.start_time);
    const oEnd = parseTimeToMinutes(other.end_time);
    return start < oEnd && oStart < end;
  }) || null;
}

/**
 * Progress summary. Only supervisor-approved entries count as verified.
 */
export function summarizeHours(entries, targetHours) {
  const list = entries || [];
  const approved = list.filter(function (e) { return e.status === 'approved'; });
  const pending = list.filter(function (e) { return e.status === 'pending'; });
  const sum = function (arr) { return arr.reduce(function (t, e) { return t + Number(e.net_minutes || 0); }, 0); };
  const dates = approved.map(function (e) { return e.service_date; }).sort();
  const verifiedMinutes = sum(approved);
  const targetMinutes = targetHours ? Math.round(Number(targetHours) * 60) : null;

  return {
    verifiedMinutes: verifiedMinutes,
    pendingMinutes: sum(pending),
    approvedCount: approved.length,
    firstServiceDate: dates[0] || null,
    lastServiceDate: dates[dates.length - 1] || null,
    targetMinutes: targetMinutes,
    remainingMinutes: targetMinutes === null ? null : Math.max(0, targetMinutes - verifiedMinutes),
    percent: targetMinutes ? Math.min(100, Math.round(verifiedMinutes / targetMinutes * 100)) : null
  };
}
