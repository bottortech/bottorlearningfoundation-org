// Append-only audit trail. Keep `details` free of personal information —
// record ids, statuses, and field names, not names or contact details.
export async function audit(ctx, actor, action, entityType, entityId, details) {
  await ctx.repo.insert('audit_log', {
    actor_staff_id: actor ? actor.id : null,
    actor_email: actor ? actor.email : null,
    action: action,
    entity_type: entityType,
    entity_id: entityId || null,
    details: details || {},
    created_at: ctx.now().toISOString()
  });
}
