import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseRepo } from '../api/_lib/supabase.js';

// A stand-in for the Supabase query builder that, like the real service,
// returns at most 1,000 rows per request.
function fakeClient(total) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: String(i).padStart(5, '0'), n: i }));
  return {
    requests: 0,
    from() {
      const client = this;
      const q = { range: [0, Infinity] };
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        order() { return builder; },
        range(from, to) { q.range = [from, to]; return builder; },
        then(resolve) {
          client.requests++;
          const [from, to] = q.range;
          resolve({ data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null });
        }
      };
      return builder;
    }
  };
}

test('list reads every page beyond Supabase’s 1,000-row cap', async () => {
  const client = fakeClient(2500);
  const rows = await createSupabaseRepo(client).list('hour_entries', {});
  assert.equal(rows.length, 2500);
  assert.equal(client.requests, 3);
});

test('list respects an explicit limit and stops early', async () => {
  const client = fakeClient(2500);
  assert.equal((await createSupabaseRepo(client).list('audit_log', { limit: 300 })).length, 300);
  assert.equal(client.requests, 1);
  const exact = fakeClient(1000);
  assert.equal((await createSupabaseRepo(exact).list('x', {})).length, 1000);
  assert.equal(exact.requests, 2, 'a full page triggers one more (empty) request');
});
