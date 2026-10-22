// POST /api/apply — public volunteer application (no login).
import { assertMethod, assertSameOrigin, clientIp, readJson, sendError, sendJson } from './_lib/http.js';
import { getContext } from './_lib/context.js';
import { submitApplication } from './_lib/services/volunteers.js';

export default async function handler(req, res) {
  try {
    assertMethod(req, ['POST']);
    assertSameOrigin(req);
    const body = await readJson(req);
    const ctx = await getContext();
    const result = await submitApplication(ctx, body, { ip: clientIp(req) });
    sendJson(res, 201, result);
  } catch (err) {
    sendError(res, err);
  }
}
