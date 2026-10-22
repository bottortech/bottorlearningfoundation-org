import { createClient } from '@supabase/supabase-js';
import { ConfigError, DbError } from './http.js';

const CLIENT_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
};

/**
 * Build the production context from server-side environment variables.
 * The service-role key bypasses Row-Level Security, so it must only ever
 * exist in Vercel environment variables — never in browser code.
 */
export function createSupabaseContext(env) {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'THROTTLE_SALT'].filter(function (k) { return !env[k]; });
  if (missing.length) throw new ConfigError('Missing environment variables: ' + missing.join(', '));

  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, CLIENT_OPTIONS);
  // Sign-in and refresh use a throwaway client so a user session can never
  // replace the service-role credentials on the shared `admin` client.
  const authClient = function () {
    return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY, CLIENT_OPTIONS);
  };

  return {
    repo: createSupabaseRepo(admin),
    auth: createSupabaseAuth(admin, authClient),
    config: { throttleSalt: env.THROTTLE_SALT, secureCookies: true },
    now: function () { return new Date(); }
  };
}

function check(result) {
  if (result.error) throw new DbError(result.error.message, result.error.code);
  return result.data;
}

function applyQuery(builder, query) {
  const q = query || {};
  let b = builder;
  Object.entries(q.eq || {}).forEach(function ([col, val]) { b = val === null ? b.is(col, null) : b.eq(col, val); });
  Object.entries(q.in || {}).forEach(function ([col, vals]) { b = b.in(col, vals); });
  Object.entries(q.gte || {}).forEach(function ([col, val]) { b = b.gte(col, val); });
  Object.entries(q.lte || {}).forEach(function ([col, val]) { b = b.lte(col, val); });
  Object.entries(q.lt || {}).forEach(function ([col, val]) { b = b.lt(col, val); });
  return b;
}

// Postgres `time` comes back as HH:MM:SS; the app works in HH:MM.
function normalizeRow(row) {
  if (row && typeof row.start_time === 'string') row.start_time = row.start_time.slice(0, 5);
  if (row && typeof row.end_time === 'string') row.end_time = row.end_time.slice(0, 5);
  return row;
}

export function createSupabaseRepo(client) {
  return {
    async list(table, query) {
      let b = applyQuery(client.from(table).select('*'), query);
      if (query && query.order) b = b.order(query.order[0], { ascending: query.order[1] !== 'desc' });
      if (query && query.limit) b = b.limit(query.limit);
      return (check(await b) || []).map(normalizeRow);
    },
    async get(table, id) {
      return normalizeRow(check(await client.from(table).select('*').eq('id', id).maybeSingle()));
    },
    async count(table, query) {
      const result = await applyQuery(client.from(table).select('id', { count: 'exact', head: true }), query);
      if (result.error) throw new DbError(result.error.message, result.error.code);
      return result.count || 0;
    },
    async insert(table, row) {
      return normalizeRow(check(await client.from(table).insert(row).select('*').single()));
    },
    async update(table, id, patch) {
      return normalizeRow(check(await client.from(table).update(patch).eq('id', id).select('*').single()));
    },
    async remove(table, query) {
      const filters = ['eq', 'in', 'gte', 'lte', 'lt'].some(function (k) { return query && query[k] && Object.keys(query[k]).length; });
      if (!filters) throw new Error('Refusing to delete without filters');
      check(await applyQuery(client.from(table).delete(), query));
    }
  };
}

export function createSupabaseAuth(admin, authClient) {
  function toSession(data) {
    if (!data || !data.session || !data.user) return null;
    return {
      user: { id: data.user.id, email: data.user.email },
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in
      }
    };
  }

  return {
    async signIn(email, password) {
      const { data, error } = await authClient().auth.signInWithPassword({ email: email, password: password });
      return error ? null : toSession(data);
    },
    async getUser(accessToken) {
      const { data, error } = await admin.auth.getUser(accessToken);
      if (error || !data || !data.user) return null;
      return { id: data.user.id, email: data.user.email };
    },
    async refresh(refreshToken) {
      const { data, error } = await authClient().auth.refreshSession({ refresh_token: refreshToken });
      return error ? null : toSession(data);
    },
    async signOut(accessToken) {
      await admin.auth.admin.signOut(accessToken).catch(function () {});
    }
  };
}
