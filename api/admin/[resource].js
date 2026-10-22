// /api/admin/<resource> — staff dashboard API.
// Every route is authenticated and mapped to exactly one permission.
import {
  HttpError, assertSameOrigin, getUrl, lastPathSegment, readJson, sendError, sendJson
} from '../_lib/http.js';
import { getContext } from '../_lib/context.js';
import { assertCan } from '../_lib/permissions.js';
import { requireStaff } from '../_lib/session.js';
import {
  decideApplication, endVolunteerService, getVolunteerDetail, listVolunteers, recordCourtApproval, updateVolunteer
} from '../_lib/services/volunteers.js';
import {
  assignVolunteer, createAssignment, endPlacement, listAssignments, updateAssignment
} from '../_lib/services/assignments.js';
import {
  correctHourEntry, createHourEntry, exportHoursCsv, hourHistory, listHours, verifyHourEntry, voidHourEntry
} from '../_lib/services/hours.js';
import {
  approveLetter, draftLetter, getLetterView, listLetters, voidLetter
} from '../_lib/services/letters.js';
import { purgeRecords, retentionOverview } from '../_lib/services/retention.js';
import { dashboardSummary, listAudit } from '../_lib/services/overview.js';

function route(permission, handle) {
  return { permission: permission, handle: handle };
}

export const ROUTES = {
  dashboard: {
    GET: route('dashboard.view', (ctx, staff) => dashboardSummary(ctx, staff))
  },
  applications: {
    GET: route('applications.review', (ctx, staff, r) => listVolunteers(ctx, staff, Object.assign({ status: 'pending' }, r.query)))
  },
  decision: {
    POST: route('applications.review', (ctx, staff, r) => decideApplication(ctx, staff, r.body))
  },
  volunteers: {
    GET: route('volunteers.view', (ctx, staff, r) => r.query.id
      ? getVolunteerDetail(ctx, staff, r.query.id)
      : listVolunteers(ctx, staff, r.query)),
    PATCH: route('volunteers.manage', (ctx, staff, r) => updateVolunteer(ctx, staff, r.query.id, r.body))
  },
  'court-approval': {
    POST: route('court.record', (ctx, staff, r) => recordCourtApproval(ctx, staff, r.body))
  },
  'end-service': {
    POST: route('volunteers.manage', (ctx, staff, r) => endVolunteerService(ctx, staff, r.body))
  },
  assignments: {
    GET: route('assignments.view', (ctx) => listAssignments(ctx)),
    POST: route('assignments.manage', (ctx, staff, r) => createAssignment(ctx, staff, r.body)),
    PATCH: route('assignments.manage', (ctx, staff, r) => updateAssignment(ctx, staff, r.query.id, r.body))
  },
  placements: {
    POST: route('assignments.manage', (ctx, staff, r) => assignVolunteer(ctx, staff, r.body))
  },
  'end-placement': {
    POST: route('assignments.manage', (ctx, staff, r) => endPlacement(ctx, staff, r.body))
  },
  hours: {
    GET: route('hours.view', (ctx, staff, r) => listHours(ctx, staff, r.query)),
    POST: route('hours.record', (ctx, staff, r) => createHourEntry(ctx, staff, r.body)),
    PATCH: route('hours.correct', (ctx, staff, r) => correctHourEntry(ctx, staff, r.query.id, r.body))
  },
  'verify-hours': {
    POST: route('hours.verify', (ctx, staff, r) => verifyHourEntry(ctx, staff, r.body))
  },
  'void-hours': {
    POST: route('hours.correct', (ctx, staff, r) => voidHourEntry(ctx, staff, r.body))
  },
  'hour-history': {
    GET: route('hours.view', (ctx, staff, r) => hourHistory(ctx, staff, r.query.id))
  },
  'hours-export': {
    GET: route('hours.export', (ctx, staff, r) => exportHoursCsv(ctx, staff, r.query))
  },
  letters: {
    GET: route('letters.view', (ctx, staff, r) => r.query.id
      ? getLetterView(ctx, staff, r.query.id)
      : listLetters(ctx, staff, r.query)),
    POST: route('letters.draft', (ctx, staff, r) => draftLetter(ctx, staff, r.body))
  },
  'approve-letter': {
    POST: route('letters.approve', (ctx, staff, r) => approveLetter(ctx, staff, r.body))
  },
  'void-letter': {
    POST: route('letters.draft', (ctx, staff, r) => voidLetter(ctx, staff, r.body))
  },
  retention: {
    GET: route('retention.manage', (ctx) => retentionOverview(ctx)),
    POST: route('retention.manage', (ctx, staff, r) => purgeRecords(ctx, staff, r.body))
  },
  audit: {
    GET: route('audit.view', (ctx, staff, r) => listAudit(ctx, staff, r.query))
  }
};

export default async function handler(req, res) {
  try {
    const methods = ROUTES[lastPathSegment(req)];
    if (!methods) throw new HttpError(404, 'Not found.');
    const entry = methods[req.method];
    if (!entry) throw new HttpError(405, 'Method not allowed.');
    if (req.method !== 'GET') assertSameOrigin(req);

    const ctx = await getContext();
    const staff = await requireStaff(req, res, ctx);
    assertCan(staff, entry.permission);

    const query = Object.fromEntries(getUrl(req).searchParams);
    const body = req.method === 'GET' ? {} : await readJson(req);
    const result = await entry.handle(ctx, staff, { query: query, body: body });

    if (result && typeof result.csv === 'string') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="' + result.filename + '"');
      res.setHeader('Cache-Control', 'no-store');
      res.end(result.csv);
      return;
    }
    sendJson(res, 200, result);
  } catch (err) {
    sendError(res, err);
  }
}
