// Provides the data store and auth provider to request handlers.
// Production always uses Supabase (configured by server-side env vars).
// Tests and the local dev server inject an in-memory context instead.

let override = null;
let cached = null;

export function setContext(ctx) {
  override = ctx;
}

export async function getContext() {
  if (override) return override;
  if (!cached) {
    const { createSupabaseContext } = await import('./supabase.js');
    cached = createSupabaseContext(process.env);
  }
  return cached;
}
