import { createHash } from 'node:crypto';
import { HttpError } from './http.js';

// Rate limiting backed by the database, so it works across serverless
// instances. Only salted hashes are stored — never raw IP addresses.
export async function checkThrottle(ctx, key, options) {
  const hash = createHash('sha256').update(ctx.config.throttleSalt + ':' + key).digest('hex');
  const since = new Date(ctx.now().getTime() - options.windowMs).toISOString();
  const recent = await ctx.repo.count('submission_throttle', { eq: { key_hash: hash }, gte: { created_at: since } });
  if (recent >= options.limit) {
    throw new HttpError(429, options.message || 'Too many attempts. Please wait a while and try again.');
  }
  await ctx.repo.insert('submission_throttle', { key_hash: hash, created_at: ctx.now().toISOString() });
}
