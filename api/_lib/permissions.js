import { HttpError } from './http.js';

export const ROLES = ['admin', 'coordinator', 'supervisor'];

const ALL = ['admin', 'coordinator', 'supervisor'];
const MANAGERS = ['admin', 'coordinator'];
const ADMINS = ['admin'];

// Every dashboard action maps to exactly one permission.
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
  'audit.view': ADMINS
};

export function can(staff, permission) {
  if (!staff || !staff.active) return false;
  const roles = PERMISSIONS[permission];
  if (!roles || roles.indexOf(staff.role) === -1) return false;
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
