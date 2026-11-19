import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import {
  ADMIN_ONLY, PERMISSIONS, PERMISSION_INFO, can, permissionSource
} from '../permissions.js';
import { loadPermissionOverrides } from '../session.js';
import { isUuid } from '../../../js/volunteer-core.js';

function catalog() {
  return Object.keys(PERMISSIONS).map(function (key) {
    const info = PERMISSION_INFO[key] || ['Other', key];
    return { key: key, group: info[0], label: info[1], admin_only: ADMIN_ONLY.indexOf(key) !== -1, role_defaults: PERMISSIONS[key] };
  });
}

function describe(member) {
  const perms = {};
  Object.keys(PERMISSIONS).forEach(function (key) {
    perms[key] = { allowed: can(member, key), source: permissionSource(member, key) };
  });
  return {
    id: member.id,
    full_name: member.full_name,
    email: member.email,
    role: member.role,
    title: member.title || null,
    active: member.active,
    permissions: perms
  };
}

export async function listTeam(ctx) {
  const members = await ctx.repo.list('staff_users', { order: ['full_name', 'asc'] });
  for (const m of members) m.permission_overrides = await loadPermissionOverrides(ctx, m.id);
  return { catalog: catalog(), members: members.map(describe) };
}

/**
 * Set one permission for one person: 'grant', 'revoke', or 'default'
 * (remove the override so the role default applies).
 */
export async function setPermission(ctx, staff, body) {
  if (!isUuid(body.staff_id)) throw new HttpError(400, 'Choose a team member.');
  if (!PERMISSIONS[body.permission]) throw new HttpError(422, 'Unknown permission.');
  if (['grant', 'revoke', 'default'].indexOf(body.effect) === -1) throw new HttpError(422, 'Choose grant, revoke, or default.');
  if (ADMIN_ONLY.indexOf(body.permission) !== -1) {
    throw new HttpError(422, 'This permission is limited to administrators and can’t be changed per person.');
  }

  const member = await ctx.repo.get('staff_users', body.staff_id);
  if (!member) throw new HttpError(404, 'Team member not found.');

  const existing = await ctx.repo.list('staff_permission_grants', {
    eq: { staff_id: member.id, permission: body.permission }, limit: 1
  });
  const nowIso = ctx.now().toISOString();

  if (body.effect === 'default') {
    if (existing.length) await ctx.repo.remove('staff_permission_grants', { eq: { id: existing[0].id } });
  } else if (existing.length) {
    await ctx.repo.update('staff_permission_grants', existing[0].id, { effect: body.effect, granted_by: staff.id, granted_at: nowIso });
  } else {
    await ctx.repo.insert('staff_permission_grants', {
      staff_id: member.id, permission: body.permission, effect: body.effect, granted_by: staff.id, granted_at: nowIso
    });
  }

  await audit(ctx, staff, 'permission.' + body.effect, 'staff_user', member.id, { permission: body.permission });
  member.permission_overrides = await loadPermissionOverrides(ctx, member.id);
  return { member: describe(member) };
}
