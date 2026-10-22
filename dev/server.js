// LOCAL PREVIEW SERVER — `npm run dev`
// Serves the static site and the real API handlers against an IN-MEMORY
// demo database (data disappears when the server stops). Never deployed.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setContext } from '../api/_lib/context.js';
import { createMemoryContext } from './memory-context.js';
import { seedDemoData, DEMO_ACCOUNTS } from './seed.js';
import applyHandler from '../api/apply.js';
import authHandler from '../api/auth/[action].js';
import adminHandler from '../api/admin/[resource].js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.json': 'application/json'
};
// Mirror the admin headers from vercel.json so CSP problems show up locally.
const ADMIN_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const ctx = createMemoryContext();
setContext(ctx);
await seedDemoData(ctx);

async function serveStatic(req, res, pathname) {
  const candidates = pathname.endsWith('/')
    ? [pathname + 'index.html']
    : [pathname, pathname + '.html', pathname + '/index.html'];
  for (const candidate of candidates) {
    const file = path.join(ROOT, path.normalize(candidate));
    if (!file.startsWith(ROOT) || /[\\/](dev|tests|supabase|node_modules|\.git)[\\/]/.test(file.slice(ROOT.length))) break;
    try {
      if (!(await stat(file)).isFile()) continue;
      res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
      if (pathname.startsWith('/admin')) {
        res.setHeader('Content-Security-Policy', ADMIN_CSP);
        res.setHeader('Cache-Control', 'no-store');
      }
      res.end(await readFile(file));
      return;
    } catch (e) { /* try next */ }
  }
  res.statusCode = 404;
  res.end('Not found');
}

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/apply') return await applyHandler(req, res);
    if (pathname.startsWith('/api/auth/')) return await authHandler(req, res);
    if (pathname.startsWith('/api/admin/')) return await adminHandler(req, res);
    if (pathname === '/_vercel/insights/script.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(''); }
    await serveStatic(req, res, pathname === '/' ? '/index.html' : decodeURIComponent(pathname));
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.end('Server error');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log('\nBottor Learning Foundation — local preview (in-memory demo data)');
  console.log('  Site:       http://localhost:' + PORT + '/volunteer');
  console.log('  Dashboard:  http://localhost:' + PORT + '/admin');
  DEMO_ACCOUNTS.forEach((a) => console.log('  ' + a.role.padEnd(12) + a.email + ' / ' + a.password));
  console.log('');
});
