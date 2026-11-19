import { audit } from '../audit.js';
import { todayInOrgTimeZone } from '../../../js/volunteer-core.js';

// Full backup of the portal's records as one JSON file (administrator only).
// Uploaded files (documents, signatures) stay in private storage; their
// details are included. Sign-in credentials are never included.
const TABLES = [
  'volunteers', 'agreement_acknowledgments', 'assignments', 'volunteer_assignments', 'hour_entries',
  'hour_entry_revisions', 'verification_letters', 'staff_users', 'staff_permission_grants', 'donors',
  'donations', 'donation_items', 'donation_documents', 'inventory_categories', 'inventory_transactions',
  'program_events', 'event_impact_counts', 'impact_baselines', 'impact_goals', 'impact_publications',
  'donor_acknowledgments', 'audit_log'
];

export async function exportBackup(ctx, staff) {
  const data = {};
  const counts = {};
  for (const table of TABLES) {
    let rows = await ctx.repo.list(table, {});
    if (table === 'staff_users') rows = rows.map(function (r) { const c = Object.assign({}, r); delete c.auth_user_id; return c; });
    data[table] = rows;
    counts[table] = rows.length;
  }
  const today = todayInOrgTimeZone(ctx.now());
  await audit(ctx, staff, 'records.backup_downloaded', 'backup', null, { tables: TABLES.length, rows: Object.values(counts).reduce(function (a, b) { return a + b; }, 0) });
  return {
    download: {
      filename: 'bottor-portal-backup-' + today + '.json',
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ organization: 'Bottor Learning Foundation', created_at: ctx.now().toISOString(), created_by: staff.full_name, counts: counts, data: data }, null, 2)
    }
  };
}
