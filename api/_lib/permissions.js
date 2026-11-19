import { HttpError } from './http.js';

export const ROLES = ['admin', 'coordinator', 'supervisor'];

const ALL = ['admin', 'coordinator', 'supervisor'];
const MANAGERS = ['admin', 'coordinator'];
const ADMINS = ['admin'];

// Every portal action maps to exactly one permission. These are the ROLE
// DEFAULTS; an administrator can grant or revoke any permission for one
// person (staff_permission_grants), except the ADMIN_ONLY ones below.
export const PERMISSIONS = {
  'dashboard.view': ALL,
  'applications.review': MANAGERS,
  'volunteers.view': ALL,
  'volunteers.manage': MANAGERS,
  'court.record': MANAGERS,
  'assignments.view': ALL,
  'assignments.manage': MANAGERS,
  'hours.view': ALL,
  'hours.record': ALL,
  'hours.verify': ALL,
  'hours.correct': MANAGERS,
  'hours.export': MANAGERS,
  'letters.view': MANAGERS,
  'letters.draft': MANAGERS,
  'letters.approve': ADMINS,
  'retention.manage': ADMINS,
  'audit.view': ADMINS,
  // Foundation Management Portal (2026-11). New permissions start admin-only;
  // the administrator grants them to individuals.
  'permissions.manage': ADMINS,
  'donations.view': ADMINS,
  'donations.manage': ADMINS,
  'donors.view_contact': ADMINS,
  'inventory.view': ADMINS,
  'inventory.record': ADMINS,
  'inventory.adjust': ADMINS,
  'impact.view': ADMINS,
  'impact.record': ADMINS,
  'impact.goals': ADMINS,
  'impact.publish': ADMINS,
  'acknowledgments.view': ADMINS,
  'acknowledgments.manage': ADMINS,
  'records.export': ADMINS
};

// Never grantable to non-administrators, and never revocable from them.
export const ADMIN_ONLY = ['permissions.manage', 'letters.approve', 'retention.manage', 'impact.publish'];

// Labels and groups for the Team & Permissions screen.
export const PERMISSION_INFO = {
  'dashboard.view': ['Portal', 'Sign in and see the overview'],
  'applications.review': ['Volunteers', 'Review, approve, and decline applications'],
  'volunteers.view': ['Volunteers', 'View volunteer records'],
  'volunteers.manage': ['Volunteers', 'Update screening and end volunteer service'],
  'court.record': ['Volunteers', 'Record court or agency approval'],
  'assignments.view': ['Volunteers', 'View assignments'],
  'assignments.manage': ['Volunteers', 'Create assignments and place volunteers'],
  'hours.view': ['Volunteer hours', 'View service hours'],
  'hours.record': ['Volunteer hours', 'Log service hours'],
  'hours.verify': ['Volunteer hours', 'Approve or reject hours'],
  'hours.correct': ['Volunteer hours', 'Correct or void hour entries'],
  'hours.export': ['Volunteer hours', 'Export hours to CSV'],
  'letters.view': ['Volunteer hours', 'View verification letters'],
  'letters.draft': ['Volunteer hours', 'Draft verification letters'],
  'letters.approve': ['Volunteer hours', 'Approve and sign verification letters'],
  'donations.view': ['Donations', 'View donation records (no donor contact details)'],
  'donations.manage': ['Donations', 'Add, edit, and void donation records'],
  'donors.view_contact': ['Donations', 'See donor contact details and amounts'],
  'inventory.view': ['Inventory', 'View inventory and history'],
  'inventory.record': ['Inventory', 'Record items received and distributed'],
  'inventory.adjust': ['Inventory', 'Set opening balances and correct discrepancies'],
  'impact.view': ['Community impact', 'View impact reports'],
  'impact.record': ['Community impact', 'Record event counts'],
  'impact.goals': ['Community impact', 'Set annual impact goals'],
  'impact.publish': ['Community impact', 'Approve figures for the public website'],
  'acknowledgments.view': ['Donor acknowledgments', 'View acknowledgment letters'],
  'acknowledgments.manage': ['Donor acknowledgments', 'Generate letters and record when sent'],
  'records.export': ['Administration', 'Export and back up records'],
  'retention.manage': ['Administration', 'Purge records past retention'],
  'audit.view': ['Administration', 'View the activity log'],
  'permissions.manage': ['Administration', 'Assign and revoke permissions']
};

function roleAllows(staff, permission) {
  const roles = PERMISSIONS[permission];
  return !!roles && roles.indexOf(staff.role) !== -1;
}

/**
 * Whether a permission comes from the role or a per-person override.
 * `staff.permission_overrides` is { permission: 'grant' | 'revoke' }.
 */
export function permissionSource(staff, permission) {
  const override = (staff.permission_overrides || {})[permission];
  if (ADMIN_ONLY.indexOf(permission) !== -1 || !override) return 'role';
  return override;
}

export function can(staff, permission) {
  if (!staff || !staff.active) return false;
  if (!PERMISSIONS[permission]) return false;
  let allowed = roleAllows(staff, permission);
  const source = permissionSource(staff, permission);
  if (source === 'grant') allowed = true;
  if (source === 'revoke') allowed = false;
  if (!allowed) return false;
  // Approving a letter also requires being a designated, titled signer.
  if (permission === 'letters.approve') return staff.can_sign_letters === true && !!staff.title;
  return true;
}

export function assertCan(staff, permission) {
  if (!can(staff, permission)) {
    throw new HttpError(403, 'Your role does not allow this action.');
  }
}

export function permissionsFor(staff) {
  return Object.keys(PERMISSIONS).filter(function (p) { return can(staff, p); });
}
