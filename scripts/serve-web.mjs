import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve(process.env.WEB_ROOT ?? 'apps/web/dist');
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer between 1 and 65535');
const realRootPromise = realpath(root);

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.gif', 'image/gif'], ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'], ['.jpg', 'image/jpeg'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.png', 'image/png'], ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'], ['.webp', 'image/webp'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
]);

function safePath(rawUrl) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(rawUrl ?? '/', 'http://localhost').pathname); }
  catch { return null; }
  const candidate = resolve(root, `.${pathname}`);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

async function safeRealPath(candidate) {
  const [realRoot, resolved] = await Promise.all([realRootPromise, realpath(candidate)]);
  return resolved === realRoot || resolved.startsWith(`${realRoot}${sep}`) ? resolved : null;
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end();
    return;
  }
  const requested = safePath(request.url);
  if (!requested) { response.writeHead(400); response.end(); return; }
  let file = requested;
  try {
    file = await safeRealPath(file);
    if (!file) { response.writeHead(400); response.end(); return; }
    const details = await stat(file);
    if (!details.isFile()) file = resolve(root, 'index.html');
  } catch {
    // Client-side routes without an extension resolve to the SPA shell.
    if (extname(file)) { response.writeHead(404); response.end(); return; }
    file = resolve(root, 'index.html');
  }
  try {
    file = await safeRealPath(file);
    if (!file) { response.writeHead(400); response.end(); return; }
    const details = await stat(file);
    const extension = extname(file).toLowerCase();
    const headers = {
      'content-type': contentTypes.get(extension) ?? 'application/octet-stream',
      'content-length': String(details.size),
      'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'cross-origin-opener-policy': 'same-origin',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'content-security-policy': "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https:; frame-ancestors 'none'",
    };
    response.writeHead(200, headers);
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(500);
    response.end();
  }
});

server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'web.server_started', port })));
