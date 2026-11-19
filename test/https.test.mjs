// HTTPS: the certificate fingerprint is published so the Android app can pin a self-signed LAN cert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { ROOT, tempDir } from './helpers.mjs';

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const getJson = (url) => new Promise((resolve, reject) => {
  https.get(url, { rejectUnauthorized: false }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject);
});

test('HTTPS servers publish their certificate fingerprint in /api/info and QR links', { skip: !hasOpenssl && 'openssl not installed' }, async () => {
  const dir = tempDir();
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=clipbox-test', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const expected = new X509Certificate(readFileSync(cert)).fingerprint256.replace(/:/g, '').toLowerCase();

  const port = await freePort();
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: join(dir, 'data'), HTTPS_CERT: cert, HTTPS_KEY: key, TUNNEL: 'none', AUTH_PASSWORD: 'x' },
    stdio: 'ignore',
  });
  const base = `https://127.0.0.1:${port}`;
  try {
    let info;
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await getJson(`${base}/api/info`); } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(info, 'server started');
    assert.equal(info.certSha256, expected);
    const connect = await getJson(`${base}/api/connect`);
    assert.ok(connect.fragment.endsWith(`.sha256-${expected}`), connect.fragment);
    for (const u of connect.urls) assert.ok(u.link.includes(`sha256-${expected}`), u.link);
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('plain http servers publish no fingerprint', async () => {
  const { startServer } = await import('./helpers.mjs');
  const srv = await startServer();
  try {
    const info = await (await fetch(`${srv.base}/api/info`)).json();
    assert.equal(info.certSha256, null);
    const connect = await (await fetch(`${srv.base}/api/connect`)).json();
    assert.doesNotMatch(connect.fragment, /sha256/);
  } finally {
    await srv.stop();
  }
});
