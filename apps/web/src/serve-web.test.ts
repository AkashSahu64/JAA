import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const serverScript = resolve(process.cwd(), 'scripts/serve-web.mjs');
const port = 4_900 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;
let root = '';
let server: ChildProcess;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/`)).ok) return;
    } catch {
      // The child may still be binding its port.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
  }
  throw new Error('Static web server did not become ready');
}

function rawStatus(path: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const request = httpRequest(`${baseUrl}${path}`, response => {
      response.resume();
      response.once('end', () => resolveStatus(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end();
  });
}

describe('production static dashboard server', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'jobagent-web-server-'));
    await writeFile(join(root, 'index.html'), '<html><body>dashboard shell</body></html>');
    await writeFile(join(root, 'client.js'), 'console.log("fixture");');
    await writeFile(join(root, 'secret.txt'), 'must not leak');
    try { await symlink(join(root, 'secret.txt'), join(root, 'linked-secret.txt')); } catch { /* Symlinks may be restricted on Windows. */ }
    server = spawn(process.execPath, [serverScript], { env: { ...process.env, PORT: String(port), WEB_ROOT: root }, stdio: ['ignore', 'ignore', 'pipe'] });
    await waitForServer();
  });

  afterAll(async () => {
    server?.kill('SIGTERM');
    if (server) await new Promise<void>(resolveExit => server.once('exit', () => resolveExit()));
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('serves SPA routes with security headers and correct cache policy', async () => {
    const response = await fetch(`${baseUrl}/applications`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('dashboard shell');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(response.headers.get('content-security-policy')).toContain("base-uri 'none'");
    expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");

    const asset = await fetch(`${baseUrl}/client.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
  });

  it('supports HEAD, rejects unsupported methods, and fails closed on traversal/unknown assets', async () => {
    const head = await fetch(`${baseUrl}/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String((await readFile(join(root, 'index.html'))).byteLength));

    const method = await fetch(`${baseUrl}/`, { method: 'POST' });
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('GET, HEAD');

    expect(await rawStatus('/%2e%2e%2f%2e%2e%2fsecret.txt')).toBe(400);
    const linked = await fetch(`${baseUrl}/linked-secret.txt`);
    expect([400, 404]).toContain(linked.status);
    const missingAsset = await fetch(`${baseUrl}/missing.css`);
    expect(missingAsset.status).toBe(404);
  });
});
