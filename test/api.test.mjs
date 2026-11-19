// End-to-end API tests. Starts a real server on a free port with a temporary
// data directory, exercises the HTTP API, then shuts it down.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'test-password';
let server;
let dataDir;
let BASE;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(BASE + path, {
    method,
    redirect: 'manual',
    headers: { 'X-ClipBox': '1', 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data, headers: res.headers };
};

const getWithHost = (path, host) => new Promise((resolve, reject) => {
  const url = new URL(BASE);
  http.get({ host: url.hostname, port: url.port, path, headers: { Host: host } }, (res) => {
    res.resume();
    resolve(res.statusCode);
  }).on('error', reject);
});

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'clipbox-test-'));
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, AUTH_PASSWORD: PASSWORD, AUTH_MODE: 'public', TUNNEL: 'none', PUBLIC_URL: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(async () => {
  // Wait for the server to exit (it flushes data on shutdown) before removing its data dir.
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('local requests need no login and get a default clipboard', async () => {
  const s = await call('GET', '/api/session');
  assert.equal(s.data.authenticated, true);
  assert.equal(s.data.required, false);
  const state = await call('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.ok(state.data.clipboards.length >= 1);
  assert.ok(state.data.boot);
});

test('clipboard lifecycle: create, rename, clear, delete', async () => {
  const created = await call('POST', '/api/clipboards', { name: '  Work   notes ' });
  assert.equal(created.status, 201);
  assert.equal(created.data.name, 'Work notes');
  const id = created.data.id;

  assert.equal((await call('PATCH', `/api/clipboards/${id}`, { name: 'Renamed' })).data.name, 'Renamed');
  await call('POST', `/api/clipboards/${id}/items`, { text: 'one' });
  const cleared = await call('POST', `/api/clipboards/${id}/clear`);
  assert.equal(cleared.data.items.length, 0);
  assert.equal((await call('DELETE', `/api/clipboards/${id}`)).status, 200);
  assert.equal((await call('PATCH', `/api/clipboards/${id}`, { name: 'x' })).status, 404);
});

test('name validation', async () => {
  assert.equal((await call('POST', '/api/clipboards', { name: '' })).status, 400);
  assert.equal((await call('POST', '/api/clipboards', { name: 'x'.repeat(61) })).status, 400);
});

test('text items: add, edit, delete, validation', async () => {
  const { data: [cb] } = { data: (await call('GET', '/api/state')).data.clipboards };
  const added = await call('POST', `/api/clipboards/${cb.id}/items`, { text: 'hello\nworld' });
  assert.equal(added.status, 201);
  assert.equal(added.data.text, 'hello\nworld');
  assert.equal((await call('POST', `/api/clipboards/${cb.id}/items`, { text: '   ' })).status, 400);
  const edited = await call('PATCH', `/api/clipboards/${cb.id}/items/${added.data.id}`, { text: 'edited' });
  assert.equal(edited.data.text, 'edited');
  assert.equal((await call('DELETE', `/api/clipboards/${cb.id}/items/${added.data.id}`)).status, 200);
});

test('file uploads: images inline, other types as attachments', async () => {
  const cb = (await call('GET', '/api/state')).data.clipboards[0];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const upload = (body, type, name) => fetch(`${BASE}/api/clipboards/${cb.id}/files`, {
    method: 'POST', headers: { 'X-ClipBox': '1', 'Content-Type': type, 'X-Filename': encodeURIComponent(name) }, body,
  }).then((r) => r.json());

  const img = await upload(png, 'image/png', 'pixel.png');
  assert.equal(img.size, png.length);
  const imgRes = await fetch(`${BASE}/files/${img.id}`);
  assert.equal(imgRes.headers.get('content-type'), 'image/png');

  const html = await upload('<script>alert(1)</script>', 'text/html', 'evil.html');
  const htmlRes = await fetch(`${BASE}/files/${html.id}`);
  assert.equal(htmlRes.headers.get('content-type'), 'application/octet-stream');
  assert.match(htmlRes.headers.get('content-disposition'), /^attachment/);
});

test('mutations without the X-ClipBox header are rejected (CSRF)', async () => {
  const res = await fetch(`${BASE}/api/clipboards`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"name":"x"}' });
  assert.equal(res.status, 403);
});

test('remote requests require login', async () => {
  const remote = { 'X-Forwarded-For': '203.0.113.7' };
  assert.equal((await call('GET', '/api/state', undefined, remote)).status, 401);
  assert.equal(await getWithHost('/api/state', 'evil.example.com'), 401, 'unknown Host is treated as remote');
  assert.equal(await getWithHost('/api/state', 'localhost'), 200);

  assert.equal((await call('POST', '/api/login', { password: 'nope' }, remote)).status, 401);
  const login = await call('POST', '/api/login', { password: PASSWORD }, remote);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/state', undefined, { ...remote, Cookie: cookie })).status, 200);
  assert.equal((await call('GET', '/api/state', undefined, { ...remote, Cookie: `${cookie.slice(0, -3)}abc` })).status, 401);
});

test('QR join tokens sign devices in', async () => {
  const info = await call('GET', '/api/connect');
  assert.ok(info.data.token);
  const join = await call('GET', `/join?t=${encodeURIComponent(info.data.token)}`, undefined, { 'X-Forwarded-For': '203.0.113.7' });
  assert.equal(join.status, 302);
  assert.match(join.headers.get('set-cookie'), /clipbox_session=/);
  const bad = await call('GET', '/join?t=1.2.3');
  assert.equal(bad.headers.get('location'), '/?join=expired');
});

test('QR code endpoint returns SVG', async () => {
  const res = await fetch(`${BASE}/api/qr?text=${encodeURIComponent('http://example.test')}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^<svg/);
});

test('live updates are pushed over Server-Sent Events', async () => {
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const readUntil = async (pattern) => {
    while (!pattern.test(buf)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
    }
  };
  await readUntil(/event: hello/);
  await call('POST', '/api/clipboards', { name: 'SSE check' });
  await readUntil(/event: change[\s\S]*SSE check/);
  ac.abort();
  assert.match(buf, /SSE check/);
});

test('static assets are served with a CSP and paths cannot escape public/', async () => {
  const index = await fetch(`${BASE}/`);
  assert.equal(index.status, 200);
  assert.ok(index.headers.get('content-security-policy'));
  assert.equal((await fetch(`${BASE}/vendor/jsQR.js`)).status, 200);
  const traversal = await fetch(`${BASE}/%2e%2e/package.json`);
  assert.doesNotMatch(await traversal.text(), /"dependencies"/);
});
