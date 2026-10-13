import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

// A minimal local stand-in for Firebase Hosting that applies the `headers` from firebase.json, because the Hosting
// emulator does not. It exists only so the security headers (CSP above all) can be exercised in a real browser before
// deployment. Development tool: never used in production.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };

export function createStaticHost({ publicDir = 'public', firebaseJson = 'firebase.json' } = {}) {
  const root = resolve(publicDir);
  const rules = JSON.parse(readFileSync(firebaseJson, 'utf8')).hosting.headers ?? [];
  const headers = Object.fromEntries(rules.flatMap((r) => r.headers.map((h) => [h.key, h.value]))); // shortcut: every rule is treated as source "**", which is all firebase.json has
  return createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(root, path));
      if (file !== root && !file.startsWith(root + sep)) throw Object.assign(new Error('outside'), { code: 'ENOENT' });
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', ...headers });
      res.end(body);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      res.writeHead(err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : 400, headers).end('Not found');
    }
  });
}
