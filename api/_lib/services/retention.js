import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { isUuid } from '../../../js/volunteer-core.js';

// ✅ RETENTION POLICY — keep in sync with the privacy notice on volunteer.html.
export const RETENTION = {
  declinedOrWithdrawnDays: 365,      // declined / withdrawn applications
  inactiveVolunteerDays: 3 * 365,    // former volunteers, counted from when service ended
  throttleDays: 7                    // spam-protection hashes
};

const DAY_MS = 24 * 60 * 60 * 1000;

function cutoff(ctx, days) {
  return new Date(ctx.now().getTime() - days * DAY_MS).toISOString();
}

/** Volunteer records past their retention period. Purging is always a manual, admin-confirmed step. */
export async function findEligibleForPurge(ctx) {
  const shortCutoff = cutoff(ctx, RETENTION.declinedOrWithdrawnDays);
  const longCutoff = cutoff(ctx, RETENTION.inactiveVolunteerDays);
  const rows = await ctx.repo.list('volunteers', { in: { status: ['declined', 'withdrawn', 'inactive'] } });

  return rows.map(function (v) {
    const since = v.status === 'declined' ? (v.decided_at || v.updated_at) : (v.ended_at || v.updated_at);
    const limit = v.status === 'inactive' ? longCutoff : shortCutoff;
    return { v: v, since: since, eligible: since && since < limit };
  }).filter(function (x) { return x.eligible; }).map(function (x) {
    return {
      id: x.v.id,
      name: x.v.first_name + ' ' + x.v.last_name,
      status: x.v.status,
      track: x.v.track,
      since: x.since,
      rule: x.v.status === 'inactive' ? 'Former volunteer, 3+ years since service ended' : 'Declined/withdrawn, 12+ months'
    };
  });
}

export async function retentionOverview(ctx) {
  return { policy: RETENTION, eligible: await findEligibleForPurge(ctx) };
}

export async function purgeRecords(ctx, staff, body) {
  if (body.confirm !== 'PURGE') throw new HttpError(422, 'Type PURGE to confirm permanent deletion.');
  const requested = Array.isArray(body.volunteer_ids) ? body.volunteer_ids.filter(isUuid) : [];
  if (!requested.length) throw new HttpError(422, 'Choose at least one record to purge.');

  // Re-check eligibility on the server; never trust the client's list.
  const eligible = new Set((await findEligibleForPurge(ctx)).map(function (r) { return r.id; }));
  const ids = requested.filter(function (id) { return eligible.has(id); });
  if (ids.length !== requested.length) throw new HttpError(409, 'Some selected records are no longer eligible for purge. Refresh and try again.');

  const entries = await ctx.repo.list('hour_entries', { in: { volunteer_id: ids } });
  const entryIds = entries.map(function (e) { return e.id; });
  if (entryIds.length) await ctx.repo.remove('hour_entry_revisions', { in: { hour_entry_id: entryIds } });
  await ctx.repo.remove('hour_entries', { in: { volunteer_id: ids } });
  await ctx.repo.remove('verification_letters', { in: { volunteer_id: ids } });
  await ctx.repo.remove('volunteer_assignments', { in: { volunteer_id: ids } });
  await ctx.repo.remove('agreement_acknowledgments', { in: { volunteer_id: ids } });
  await ctx.repo.remove('volunteers', { in: { id: ids } });
  await ctx.repo.remove('submission_throttle', { lt: { created_at: cutoff(ctx, RETENTION.throttleDays) } });

  await audit(ctx, staff, 'retention.purged', 'volunteer', null, { count: ids.length, volunteer_ids: ids });
  return { purged: ids.length };
}
