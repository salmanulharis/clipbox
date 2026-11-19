// Shared helpers: start a throwaway ClipBox server and make API calls.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REMOTE = { 'X-Forwarded-For': '203.0.113.7' };

export const tempDir = () => mkdtempSync(join(tmpdir(), 'clipbox-test-'));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

/**
 * Start a server. Resolves with { base, dataDir, proc, stop() } once healthy,
 * or with { exitCode, output } if the process exits during startup.
 */
export async function startServer({ dataDir = tempDir(), env = {}, keepData = false } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir,
      AUTH_PASSWORD: 'test-password', AUTH_MODE: 'public', TUNNEL: 'none', PUBLIC_URL: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => proc.once('exit', resolve));

  const stop = async () => {
    if (proc.exitCode === null) {
      proc.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    if (!keepData) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) return { exitCode: proc.exitCode, output, stop };
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, dataDir, proc, stop, output: () => output };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  await stop();
  throw new Error(`server did not start:\n${output}`);
}

/** JSON API call. Adds the CSRF header unless a bearer token is used. */
export async function call(base, method, path, body, headers = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (!h.Authorization) h['X-ClipBox'] = '1';
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data, headers: res.headers };
}

/** Extract "name=value" pairs from all Set-Cookie headers into a Cookie header value. */
export function cookieHeader(headers) {
  return headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });
