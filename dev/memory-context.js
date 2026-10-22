// In-memory data store + auth for TESTS and LOCAL PREVIEW ONLY.
// Nothing here is deployed (see .vercelignore); production uses Supabase.
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

function matches(row, query) {
  const q = query || {};
  for (const [col, val] of Object.entries(q.eq || {})) {
    if ((row[col] === undefined ? null : row[col]) !== val) return false;
  }
  for (const [col, vals] of Object.entries(q.in || {})) {
    if (vals.indexOf(row[col]) === -1) return false;
  }
  for (const [col, val] of Object.entries(q.gte || {})) if (!(row[col] >= val)) return false;
  for (const [col, val] of Object.entries(q.lte || {})) if (!(row[col] <= val)) return false;
  for (const [col, val] of Object.entries(q.lt || {})) if (!(row[col] < val)) return false;
  return true;
}

function hasFilters(query) {
  return ['eq', 'in', 'gte', 'lte', 'lt'].some(function (k) { return query && query[k] && Object.keys(query[k]).length; });
}

const clone = (v) => (v == null ? v : structuredClone(v));

export function createMemoryRepo() {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };

  return {
    tables: tables,
    async list(name, query) {
      let rows = table(name).filter((r) => matches(r, query));
      if (query && query.order) {
        const [col, dir] = query.order;
        rows = rows.slice().sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      if (query && query.limit) rows = rows.slice(0, query.limit);
      return rows.map(clone);
    },
    async get(name, id) {
      return clone(table(name).find((r) => r.id === id) || null);
    },
    async count(name, query) {
      return table(name).filter((r) => matches(r, query)).length;
    },
    async insert(name, row) {
      const stored = Object.assign({ id: randomUUID() }, clone(row));
      table(name).push(stored);
      return clone(stored);
    },
    async update(name, id, patch) {
      const row = table(name).find((r) => r.id === id);
      if (!row) throw new Error('Row not found: ' + name + '/' + id);
      Object.assign(row, clone(patch));
      return clone(row);
    },
    async remove(name, query) {
      if (!hasFilters(query)) throw new Error('Refusing to delete without filters');
      tables.set(name, table(name).filter((r) => !matches(r, query)));
    }
  };
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 32);
}

export function createMemoryAuth() {
  const users = new Map();     // email -> { id, email, salt, hash }
  const tokens = new Map();    // access token -> user
  const refresh = new Map();   // refresh token -> user

  function issue(user) {
    const access = randomBytes(24).toString('hex');
    const rt = randomBytes(24).toString('hex');
    tokens.set(access, user);
    refresh.set(rt, user);
    return { user: { id: user.id, email: user.email }, session: { access_token: access, refresh_token: rt, expires_in: 3600 } };
  }

  return {
    addUser(email, password) {
      const salt = randomBytes(16);
      const user = { id: randomUUID(), email: email, salt: salt, hash: hashPassword(password, salt) };
      users.set(email, user);
      return user.id;
    },
    expireAccessTokens() {
      tokens.clear();
    },
    async signIn(email, password) {
      const user = users.get(email);
      if (!user) return null;
      const ok = timingSafeEqual(hashPassword(password, user.salt), user.hash);
      return ok ? issue(user) : null;
    },
    async getUser(token) {
      const user = tokens.get(token);
      return user ? { id: user.id, email: user.email } : null;
    },
    async refresh(token) {
      const user = refresh.get(token);
      if (!user) return null;
      refresh.delete(token);
      return issue(user);
    },
    async signOut(token) {
      tokens.delete(token);
    }
  };
}

export function createMemoryContext(options) {
  const opts = options || {};
  let now = opts.now ? new Date(opts.now) : null;
  return {
    repo: createMemoryRepo(),
    auth: createMemoryAuth(),
    config: { throttleSalt: 'test-salt', secureCookies: false },
    now: () => (now ? new Date(now) : new Date()),
    setNow(value) { now = new Date(value); }
  };
}

/** Create a staff account (auth user + staff_users row). */
export async function addStaff(ctx, fields) {
  const { password, ...profile } = fields;
  const authId = ctx.auth.addUser(profile.email, password || 'password123');
  return ctx.repo.insert('staff_users', Object.assign({
    auth_user_id: authId,
    title: null,
    can_sign_letters: false,
    volunteer_id: null,
    active: true,
    created_at: ctx.now().toISOString()
  }, profile));
}
