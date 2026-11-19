'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const config = require('./config');
const { Store, ValidationError, newId } = require('./store');
const { Auth, PAIR_TTL_MS } = require('./auth');
const { localUrls } = require('./network');
const { Tunnel } = require('./tunnel');

const PUBLIC_DIR = path.join(config.root, 'public');
const VENDOR = { '/vendor/jsQR.js': require.resolve('jsqr/dist/jsQR.js') };
const SAFE_INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

const store = new Store(config.dataDir, { maxTextBytes: config.maxTextBytes });
store.load();
const tunnel = new Tunnel(config);
const auth = new Auth(config, () => tunnel.url);

// ── helpers ───────────────────────────────────────────────────
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const CSP =
  "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; " +
  "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new ValidationError('Request is too large.', 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ValidationError('Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeFilename(name) {
  // eslint-disable-next-line no-control-regex
  const v = String(name || '').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').trim().slice(0, 200);
  return v || 'file';
}

function serverInfo(req) {
  return {
    publicRequest: auth.isPublic(req),
    authMode: config.authMode,
    passwordSet: auth.passwordSet,
    maxTextBytes: config.maxTextBytes,
    maxFileBytes: config.maxFileBytes,
    tunnel: tunnel.info(),
  };
}

// ── live sync (Server-Sent Events + long-poll fallback) ─────
const sseClients = new Set();
const waiters = new Set();

store.on('change', (event) => {
  const payload = `id: ${event.rev}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(payload);
  for (const w of waiters) w();
});

tunnel.on('update', (info) => {
  const payload = `event: tunnel\ndata: ${JSON.stringify(info)}\n\n`;
  for (const res of sseClients) res.write(payload);
  if (info.url && info.status === 'ready') printPublic(info.url);
  else if (info.error) console.log(`[tunnel] ${info.error}`);
});

setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 20000).unref();

function handleEvents(req, res) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Padding helps proxies that buffer small responses flush immediately.
  res.write(`:${' '.repeat(2048)}\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ rev: store.rev, boot: store.boot })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

function handleSync(req, res, url) {
  const since = Number(url.searchParams.get('rev'));
  const reply = () => json(res, 200, store.snapshot());
  if (since !== store.rev || url.searchParams.get('boot') !== store.boot) return reply();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    waiters.delete(finish);
    clearTimeout(timer);
    reply();
  };
  const timer = setTimeout(finish, 25000);
  waiters.add(finish);
  req.on('close', () => {
    done = true;
    waiters.delete(finish);
    clearTimeout(timer);
  });
}

// ── file uploads ─────────────────────────────────────────────
function handleUpload(req, res, clipboardId) {
  store.get(clipboardId); // throws 404 early
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > config.maxFileBytes) {
    throw new ValidationError(`File is too large (max ${Math.round(config.maxFileBytes / 1048576)} MB).`, 413);
  }
  const id = newId();
  const dest = store.filePath(id);
  const tmp = `${dest}.part`;
  let name = 'file';
  try { name = sanitizeFilename(decodeURIComponent(req.headers['x-filename'] || 'file')); } catch { /* keep default */ }
  let mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) mime = 'application/octet-stream';

  let size = 0;
  let failed = false;
  const out = fs.createWriteStream(tmp);
  const fail = (err) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(tmp, { force: true }, () => {});
    if (!res.headersSent) {
      json(res, err.status || 500, { error: err.status ? err.message : 'Upload failed.' }, { Connection: 'close' });
    }
  };
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > config.maxFileBytes) {
      fail(new ValidationError(`File is too large (max ${Math.round(config.maxFileBytes / 1048576)} MB).`, 413));
      req.unpipe(out);
      req.resume();
    }
  });
  req.on('aborted', () => fail(new Error('aborted')));
  out.on('error', fail);
  out.on('finish', () => {
    if (failed) return;
    if (size === 0) return fail(new ValidationError('File is empty.'));
    fs.rename(tmp, dest, (err) => {
      if (err) return fail(err);
      try {
        const item = store.addFile(clipboardId, { id, name, mime, size });
        json(res, 201, item);
      } catch (e) {
        fs.rm(dest, { force: true }, () => {});
        fail(e);
      }
    });
  });
  req.pipe(out);
}

function serveFile(req, res, itemId, download) {
  const found = store.findItem(itemId);
  if (!found || found.item.type !== 'file') return json(res, 404, { error: 'File not found.' });
  const { item } = found;
  const file = store.filePath(item.id);
  fs.stat(file, (err, st) => {
    if (err) return json(res, 404, { error: 'File not found.' });
    const inline = !download && SAFE_INLINE.has(item.mime);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': inline ? item.mime : 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ── static files ─────────────────────────────────────────────
function serveStatic(req, res, pathname) {
  let file;
  if (VENDOR[pathname]) file = VENDOR[pathname];
  else {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: 'Not found.' });
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback for unknown non-asset paths
      if (pathname !== '/' && !path.extname(pathname)) return serveStatic(req, res, '/');
      return json(res, 404, { error: 'Not found.' });
    }
    const ext = path.extname(file);
    send(res, 200, data, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      ...(ext === '.html' ? { 'Content-Security-Policy': CSP } : {}),
    });
  });
}

// ── connection info / QR ─────────────────────────────────────
function connectInfo(req) {
  const token = auth.createPairToken();
  const withToken = (base) => `${base}/join?t=${encodeURIComponent(token)}`;
  const urls = localUrls(config).map((u) => ({
    kind: 'local',
    label: u.virtual ? `${u.label} (virtual)` : u.label,
    url: u.url,
    link: config.authMode === 'all' && token ? withToken(u.url) : u.url,
  }));
  if (tunnel.url) {
    urls.unshift({
      kind: 'public',
      label: config.tunnel === 'none' ? 'Public URL' : `Public (${config.tunnel})`,
      url: tunnel.url,
      link: token ? withToken(tunnel.url) : tunnel.url,
      blocked: !token,
    });
  }
  return { urls, token, tokenMinutes: token ? PAIR_TTL_MS / 60000 : 0, tunnel: tunnel.info() };
}

// ── router ───────────────────────────────────────────────────
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });

route('GET', /^\/api\/session$/, (req, res) => {
  const a = auth.check(req);
  json(res, 200, { authenticated: a.ok, required: a.required, reason: a.reason || null, ...serverInfo(req) });
}, { open: true });

route('POST', /^\/api\/login$/, async (req, res) => {
  const body = await readJson(req, 4096);
  const r = auth.login(req, body.password);
  if (!r.ok) return json(res, r.status, { error: r.error });
  json(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(req) });
}, { open: true });

route('POST', /^\/api\/logout$/, (req, res) => {
  json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(req) });
}, { open: true });

route('GET', /^\/join$/, (req, res, m, url) => {
  const token = url.searchParams.get('t');
  if (auth.verifyPairToken(token)) {
    return send(res, 302, '', { Location: '/', 'Set-Cookie': auth.sessionCookie(req), 'Cache-Control': 'no-store' });
  }
  send(res, 302, '', { Location: '/?join=expired', 'Cache-Control': 'no-store' });
}, { open: true });

route('GET', /^\/api\/health$/, (req, res) => json(res, 200, { ok: true }), { open: true });

route('GET', /^\/api\/state$/, (req, res) => json(res, 200, { ...store.snapshot(), server: serverInfo(req) }));
route('GET', /^\/api\/events$/, (req, res) => handleEvents(req, res));
route('GET', /^\/api\/sync$/, (req, res, m, url) => handleSync(req, res, url));
route('GET', /^\/api\/connect$/, (req, res) => json(res, 200, connectInfo(req)));

route('GET', /^\/api\/qr$/, async (req, res, m, url) => {
  const text = url.searchParams.get('text') || '';
  if (!text || text.length > 1500) throw new ValidationError('Invalid QR text.');
  const svg = await QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  send(res, 200, svg, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
});

route('POST', /^\/api\/clipboards$/, async (req, res) => {
  const body = await readJson(req, 4096);
  json(res, 201, store.createClipboard(body.name));
});
route('PATCH', /^\/api\/clipboards\/([\w-]+)$/, async (req, res, m) => {
  const body = await readJson(req, 4096);
  json(res, 200, store.renameClipboard(m[1], body.name));
});
route('DELETE', /^\/api\/clipboards\/([\w-]+)$/, (req, res, m) => {
  store.deleteClipboard(m[1]);
  json(res, 200, { ok: true });
});
route('POST', /^\/api\/clipboards\/([\w-]+)\/clear$/, (req, res, m) => json(res, 200, store.clearClipboard(m[1])));
route('POST', /^\/api\/clipboards\/([\w-]+)\/items$/, async (req, res, m) => {
  const body = await readJson(req, config.maxTextBytes * 2 + 1024);
  json(res, 201, store.addText(m[1], body.text));
});
route('POST', /^\/api\/clipboards\/([\w-]+)\/files$/, (req, res, m) => handleUpload(req, res, m[1]));
route('PATCH', /^\/api\/clipboards\/([\w-]+)\/items\/([\w-]+)$/, async (req, res, m) => {
  const body = await readJson(req, config.maxTextBytes * 2 + 1024);
  json(res, 200, store.updateItem(m[1], m[2], body.text));
});
route('DELETE', /^\/api\/clipboards\/([\w-]+)\/items\/([\w-]+)$/, (req, res, m) => {
  store.deleteItem(m[1], m[2]);
  json(res, 200, { ok: true });
});
route('GET', /^\/files\/([\w-]+)$/, (req, res, m, url) => serveFile(req, res, m[1], url.searchParams.has('download')));

async function handler(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    return json(res, 400, { error: 'Bad request.' });
  }
  const { pathname } = url;
  const r = routes.find((x) => x.method === req.method && x.pattern.test(pathname));

  if (!r) {
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    return json(res, 404, { error: 'Not found.' });
  }

  // CSRF protection: state-changing API calls must carry a custom header,
  // which browsers refuse to send cross-origin without a CORS preflight.
  if (req.method !== 'GET' && req.headers['x-clipbox'] !== '1') {
    return json(res, 403, { error: 'Missing request header.' });
  }

  if (!r.open) {
    const a = auth.check(req);
    if (!a.ok) {
      const msg = a.reason === 'no_password'
        ? 'Remote access is disabled: set AUTH_PASSWORD on the server to enable it.'
        : 'Login required.';
      return json(res, a.reason === 'no_password' ? 403 : 401, { error: msg, reason: a.reason });
    }
  }

  try {
    await r.handler(req, res, pathname.match(r.pattern), url);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    if (err instanceof ValidationError) return json(res, err.status, { error: err.message });
    console.error('[server]', err);
    json(res, 500, { error: 'Internal server error.' });
  }
}

// ── startup ──────────────────────────────────────────────────
function createServer() {
  if (!config.https) return http.createServer(handler);
  try {
    return https.createServer(
      { cert: fs.readFileSync(path.resolve(config.root, config.httpsCert)), key: fs.readFileSync(path.resolve(config.root, config.httpsKey)) },
      handler,
    );
  } catch (err) {
    console.error(`[https] could not load certificate/key: ${err.message}`);
    process.exit(1);
  }
}

async function printQr(url) {
  try {
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  } catch { /* terminal QR is a nicety */ }
}

let lastPrinted = null;
async function printPublic(url) {
  if (url === lastPrinted) return;
  lastPrinted = url;
  console.log(`\n  Public:  ${url}${auth.passwordSet ? '  (password required)' : '  (BLOCKED: set AUTH_PASSWORD to allow remote access)'}`);
  if (auth.passwordSet) console.log('  Tip: open "Connect" in the app for a QR code that logs devices in automatically.\n');
}

const server = createServer();
server.keepAliveTimeout = 65000;
server.requestTimeout = 0; // allow long uploads & SSE
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\nPort ${config.port} is already in use. Set a different PORT in .env.\n`);
  else console.error('[server]', err);
  process.exit(1);
});

server.listen(config.port, config.host, async () => {
  const proto = config.https ? 'https' : 'http';
  const locals = localUrls(config);
  console.log('\n  ClipBox is running\n');
  console.log(`  This PC: ${proto}://localhost:${config.port}`);
  for (const u of locals) console.log(`  Network: ${u.url}  (${u.label}${u.virtual ? ', virtual' : ''})`);
  if (config.host === '127.0.0.1' || config.host === 'localhost') console.log('  (HOST is loopback: other devices on your network cannot connect)');
  console.log(`  Data:    ${config.dataDir}`);
  console.log(`  Auth:    ${config.authMode === 'all' ? 'password required for every device' : 'LAN open, password required for remote access'}${auth.passwordSet ? '' : ' (no AUTH_PASSWORD set)'}`);
  const primary = locals.find((u) => !u.virtual) || locals[0];
  if (primary && config.authMode !== 'all') {
    console.log(`\n  Scan to open ${primary.url} on your phone:`);
    await printQr(primary.url);
  }
  if (config.tunnel !== 'none') console.log(`  Tunnel:  ${config.tunnel}${config.tunnelAutostart ? ' (auto-start)' : ''} — waiting for public URL…`);
  tunnel.start();
  if (tunnel.url) printPublic(tunnel.url);
});

if (config.authMode === 'all' && !auth.passwordSet) {
  console.warn('\n  WARNING: AUTH_MODE=all but AUTH_PASSWORD is empty — nobody will be able to log in.\n');
}

function shutdown() {
  console.log('\n  Saving and shutting down…');
  try { store.flush(); } catch (err) { console.error(err); }
  tunnel.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
