// GET /api/impact — the latest PUBLISHED impact statistics for the public
// website. Aggregate figures only; nothing about donors, volunteers, or
// recipients. Cached at the edge; the page also keeps the last good copy.
import { assertMethod, sendError } from './_lib/http.js';
import { getContext } from './_lib/context.js';
import { readPublicImpact } from './_lib/services/publication.js';

export default async function handler(req, res) {
  try {
    assertMethod(req, ['GET']);
    const ctx = await getContext();
    const data = await readPublicImpact(ctx);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Short edge cache; keep serving the last good copy while refreshing or if the database errors.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400, stale-if-error=604800');
    res.end(JSON.stringify(data));
  } catch (err) {
    sendError(res, err);
  }
}
