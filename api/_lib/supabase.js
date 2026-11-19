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
    storage: createSupabaseStorage(admin),
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
    // Supabase returns at most 1,000 rows per request, so read every page;
    // otherwise totals and exports would silently undercount as data grows.
    async list(table, query) {
      const PAGE = 1000;
      const limit = query && query.limit ? query.limit : Infinity;
      const rows = [];
      for (let from = 0; rows.length < limit; from += PAGE) {
        let b = applyQuery(client.from(table).select('*'), query);
        // A stable order is required for paging; 'id' breaks ties.
        if (query && query.order) b = b.order(query.order[0], { ascending: query.order[1] !== 'desc' });
        b = b.order('id', { ascending: true });
        const to = Math.min(from + PAGE, limit) - 1;
        const page = check(await b.range(from, to)) || [];
        rows.push.apply(rows, page);
        if (page.length < to - from + 1) break;
      }
      return rows.map(normalizeRow);
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

// Private file storage for donation documents. The bucket is created on
// first use and is never public; files are opened through short-lived links.
export const DOCUMENT_BUCKET = 'donation-documents';

export function createSupabaseStorage(admin) {
  let ready = false;
  async function ensureBucket() {
    if (ready) return;
    const { data } = await admin.storage.getBucket(DOCUMENT_BUCKET);
    if (!data) {
      const { error } = await admin.storage.createBucket(DOCUMENT_BUCKET, { public: false, fileSizeLimit: 3 * 1024 * 1024 });
      if (error && !/already exists/i.test(error.message)) throw new DbError(error.message, 'STORAGE');
    }
    ready = true;
  }
  return {
    async upload(path, buffer, contentType) {
      await ensureBucket();
      const { error } = await admin.storage.from(DOCUMENT_BUCKET).upload(path, buffer, { contentType: contentType, upsert: false });
      if (error) throw new DbError(error.message, 'STORAGE');
    },
    // Returns a Buffer, or null if the file doesn't exist.
    async download(path) {
      await ensureBucket();
      const { data, error } = await admin.storage.from(DOCUMENT_BUCKET).download(path);
      if (error) {
        if (/not.?found|does not exist|404/i.test(error.message || '') || error.statusCode === '404' || error.status === 404) return null;
        throw new DbError(error.message, 'STORAGE');
      }
      return Buffer.from(await data.arrayBuffer());
    },
    async remove(path) {
      await ensureBucket();
      const { error } = await admin.storage.from(DOCUMENT_BUCKET).remove([path]);
      if (error) throw new DbError(error.message, 'STORAGE');
    },
    async signedUrl(path, seconds) {
      const { data, error } = await admin.storage.from(DOCUMENT_BUCKET).createSignedUrl(path, seconds);
      if (error) throw new DbError(error.message, 'STORAGE');
      return data.signedUrl;
    }
  };
}
