import { can } from '../permissions.js';
import { summarizeHours, todayInOrgTimeZone } from '../../../js/volunteer-core.js';
import { youthClearance } from './volunteers.js';
import { inventorySummary } from './inventory.js';
import { listDonations } from './donations.js';
import { pendingAcknowledgmentCount } from './acknowledgments.js';
import { impactReport } from './impact.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function dashboardSummary(ctx, staff) {
  const [volunteers, pendingHours, letters, placements, assignments] = await Promise.all([
    ctx.repo.list('volunteers', { in: { status: ['pending', 'approved'] } }),
    ctx.repo.list('hour_entries', { eq: { status: 'pending' } }),
    can(staff, 'letters.view') ? ctx.repo.list('verification_letters', { eq: { status: 'draft' } }) : [],
    ctx.repo.list('volunteer_assignments', { eq: { status: 'active' } }),
    ctx.repo.list('assignments', {})
  ]);
  const today = todayInOrgTimeZone(ctx.now());
  const soon = new Date(ctx.now().getTime() + 30 * DAY_MS).toISOString().slice(0, 10);
  const approved = volunteers.filter(function (v) { return v.status === 'approved'; });
  const youthIds = new Set(assignments.filter(function (a) { return a.youth_facing; }).map(function (a) { return a.id; }));

  const attention = [];
  if (can(staff, 'volunteers.manage')) {
    const court = approved.filter(function (v) { return v.track === 'court_ordered' && v.court_deadline && v.court_deadline <= soon; });
    const approvedHours = court.length
      ? await ctx.repo.list('hour_entries', { in: { volunteer_id: court.map(function (v) { return v.id; }) }, eq: { status: 'approved' } })
      : [];
    court.forEach(function (v) {
      const s = summarizeHours(approvedHours.filter(function (e) { return e.volunteer_id === v.id; }), v.target_hours || v.court_required_hours);
      if (s.remainingMinutes > 0) {
        attention.push({ kind: 'deadline', volunteer_id: v.id, name: v.first_name + ' ' + v.last_name, detail: 'Court deadline ' + v.court_deadline + ' with ' + (s.remainingMinutes / 60).toFixed(2) + ' verified hours remaining' });
      }
    });
    approved.forEach(function (v) {
      if (v.track === 'court_ordered' && v.court_approval_status !== 'approved') {
        attention.push({ kind: 'court', volunteer_id: v.id, name: v.first_name + ' ' + v.last_name, detail: 'Court/agency approval not yet recorded as approved' });
      }
      const inYouth = placements.some(function (p) { return p.volunteer_id === v.id && youthIds.has(p.assignment_id); });
      if (inYouth && !youthClearance(v, today).cleared) {
        attention.push({ kind: 'youth', volunteer_id: v.id, name: v.first_name + ' ' + v.last_name, detail: 'In a youth-facing assignment without current clearance' });
      }
    });
  }

  return {
    foundation: await foundationSummary(ctx, staff, today),
    counts: {
      pending_applications: can(staff, 'applications.review') ? volunteers.filter(function (v) { return v.status === 'pending'; }).length : null,
      active_volunteers: approved.length,
      pending_hours: pendingHours.filter(function (e) { return !(staff.volunteer_id && e.volunteer_id === staff.volunteer_id); }).length,
      draft_letters: can(staff, 'letters.view') ? letters.length : null
    },
    attention: attention
  };
}

export async function listAudit(ctx, staff, query) {
  const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);
  return { events: await ctx.repo.list('audit_log', { order: ['created_at', 'desc'], limit: limit }) };
}

// Donations and inventory for the overview, limited to what this person may see.
async function foundationSummary(ctx, staff, today) {
  const out = {};
  const yearStart = today.slice(0, 4) + '-01-01';
  if (can(staff, 'donations.view')) {
    const { donations } = await listDonations(ctx, staff, { from: yearStart, status: 'active' });
    out.donations_this_year = donations.length;
    out.in_kind_items_this_year = donations.reduce(function (t, d) { return t + d.item_count; }, 0);
    if (can(staff, 'donors.view_contact')) {
      out.monetary_this_year = donations.reduce(function (t, d) { return t + (d.amount ? Number(d.amount) : 0); }, 0);
    }
    const recent = (await listDonations(ctx, staff, { status: 'active' })).donations.slice(0, 5);
    out.recent_donations = recent.map(function (d) {
      return {
        id: d.id, received_on: d.received_on, donor_name: d.donor_name, is_anonymous: d.is_anonymous,
        donation_type: d.donation_type, item_summary: d.item_summary, amount: d.amount
      };
    });
  }
  if (can(staff, 'acknowledgments.view')) {
    out.acknowledgments = await pendingAcknowledgmentCount(ctx);
  }
  if (can(staff, 'impact.view')) {
    const report = await impactReport(ctx, staff, { preset: 'year' });
    out.impact_year = report.range.year;
    out.impact = report.metrics.filter(function (m) {
      return ['children_served', 'families_served', 'books_distributed', 'events_total'].indexOf(m.key) !== -1;
    }).map(function (m) { return { key: m.key, label: m.label, value: m.value, qualifier: m.qualifier, unit: m.unit, has_data: m.has_data }; });
  }
  if (can(staff, 'inventory.view')) {
    const inv = await inventorySummary(ctx);
    out.inventory_on_hand = inv.totals.on_hand;
    out.items_distributed = inv.totals.distributed;
  }
  return out;
}
