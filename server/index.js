'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const config = require('./config');
const { Store, ValidationError, SchemaError, newId, DEFAULT_GROUP } = require('./store');
const { Auth, PAIR_TTL_MS, deviceNameFromUA } = require('./auth');
const { version: VERSION } = require('../package.json');
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

const store = new Store(config.dataDir, { maxTextBytes: config.maxTextBytes, maxNoteBytes: config.maxNoteBytes });
try {
  store.load();
} catch (err) {
  if (err instanceof SchemaError) {
    console.error(`\n  Cannot start: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
const tunnel = new Tunnel(config);
const auth = new Auth(config, store, () => tunnel.url);
const ROLE_RANK = { viewer: 0, member: 1, host: 2 };
const NEED_RANK = { read: 0, write: 1, host: 2 };

/**
 * SHA-256 fingerprint (lowercase hex) of the HTTPS certificate, or null over plain http.
 * Put in QR codes so the Android app can trust a self-signed LAN certificate (pinning on first use).
 */
const CERT_SHA256 = (() => {
  if (!config.https) return null;
  try {
    const pem = fs.readFileSync(path.resolve(config.root, config.httpsCert), 'utf8');
    return new (require('crypto').X509Certificate)(pem).fingerprint256.replace(/:/g, '').toLowerCase();
  } catch {
    return null;
  }
})();

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
    serverId: store.serverId,
    serverName: store.serverName,
    version: VERSION,
    publicRequest: auth.isPublic(req),
    authMode: config.authMode,
    passwordSet: auth.passwordSet,
    maxTextBytes: config.maxTextBytes,
    maxFileBytes: config.maxFileBytes,
    maxNoteBytes: config.maxNoteBytes,
    tunnel: tunnel.info(),
  };
}

function publicDevice(d, ctx) {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    role: d.role,
    revoked: d.revoked,
    app: Boolean(d.tokenHash),
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    current: Boolean(ctx?.device && ctx.device.id === d.id),
  };
}

function me(ctx) {
  return {
    deviceId: ctx.device?.id || null,
    name: ctx.device?.name || null,
    platform: ctx.device?.platform || null,
    role: ctx.role,
  };
}

/** Make sure a browser has a device record + cookie; upgrade legacy sessions. Returns Set-Cookie values. */
/**
 * Real browsers send Fetch Metadata (Sec-Fetch-*) or a Mozilla-style user agent; curl, scripts
 * and health checks don't. Only browsers get a device record, so scripts don't pile up as
 * anonymous "Browser" devices.
 */
const looksLikeBrowser = (req) => Boolean(req.headers['sec-fetch-mode']) || /^Mozilla\//.test(req.headers['user-agent'] || '');

function ensureWebDevice(req, ctx) {
  const cookies = [];
  if (ctx.via === 'bearer') return cookies;
  if (!ctx.device && !ctx.session && !looksLikeBrowser(req)) return cookies; // a script on the LAN
  if (!ctx.device) {
    ctx.device = store.createDevice({ name: deviceNameFromUA(req.headers['user-agent']), platform: 'web' });
    if (!auth.isHostMachine(req)) ctx.role = ctx.device.role;
    cookies.push(auth.deviceCookie(req, ctx.device.id));
  }
  if (ctx.session && !ctx.session.deviceId) cookies.push(auth.sessionCookie(req, ctx.device.id));
  return cookies;
}

/** Device to reuse when a browser signs in: its existing (non-revoked) device cookie, or a new one. */
function deviceForSignIn(req, role) {
  const existing = auth.cookieDevice(req);
  if (existing) {
    if (role === 'host' && existing.role !== 'host') store.updateDevice(existing.id, { role: 'host' });
    return existing;
  }
  return store.createDevice({ name: deviceNameFromUA(req.headers['user-agent']), platform: 'web', role });
}

// ── groups: who can see what ─────────────────────────────────
/** Hosts see every group; "all" groups are visible to every device; others only to members. */
function canSeeGroup(ctx, g) {
  if (!g) return false;
  if (ctx.role === 'host' || g.access === 'all') return true;
  return Boolean(ctx.device && g.members.includes(ctx.device.id));
}

const groupOf = (id) => store.listGroups().find((g) => g.id === id);

/** Not visible = not found (404), so ids in other groups aren't even confirmed to exist. */
function assertGroup(ctx, groupId) {
  if (!canSeeGroup(ctx, groupOf(groupId))) throw new ValidationError('Not found.', 404);
}

function publicGroup(g, ctx) {
  const out = { id: g.id, name: g.name, access: g.access, createdAt: g.createdAt, isDefault: g.id === DEFAULT_GROUP };
  if (ctx.role === 'host') out.members = g.members;
  else out.memberCount = g.members.length;
  return out;
}

/** Everything this device may see. */
function snapshotFor(ctx) {
  const s = store.snapshot((g) => canSeeGroup(ctx, g));
  return { ...s, groups: s.groups.map((g) => publicGroup(g, ctx)) };
}

/**
 * A live event as one device should receive it: full for groups it can see; for other
 * groups only an empty "skip" (keeps the revision sequence intact, reveals nothing);
 * group changes just tell clients to reload.
 */
function eventFor(ctx, event, groupOfClipboard) {
  let data;
  if (event.type === 'groups') {
    data = { type: 'groups', rev: event.rev, boot: event.boot };
  } else if (event.groupId && !canSeeGroup(ctx, groupOf(event.groupId))) {
    data = { type: 'skip', rev: event.rev, boot: event.boot };
  } else {
    const order = event.order.filter((id) => canSeeGroup(ctx, groupOf(groupOfClipboard.get(id))));
    data = { ...event, order };
  }
  return `id: ${event.rev}\nevent: change\ndata: ${JSON.stringify(data)}\n\n`;
}

function knownUrls() {
  const urls = localUrls(config).filter((u) => !u.virtual).map((u) => ({ kind: 'local', url: u.url }));
  if (tunnel.url) urls.push({ kind: 'public', url: tunnel.url });
  return urls;
}

// ── live sync (Server-Sent Events + long-poll fallback) ─────
const sseClients = new Map(); // res -> request context (device, role)
const waiters = new Set();

store.on('change', (event) => {
  const groupOfClipboard = new Map(store.snapshot().clipboards.map((c) => [c.id, c.groupId]));
  for (const [res, ctx] of sseClients) res.write(eventFor(ctx, event, groupOfClipboard));
  for (const w of waiters) w();
});

tunnel.on('update', (info) => {
  const payload = `event: tunnel\ndata: ${JSON.stringify(info)}\n\n`;
  for (const res of sseClients.keys()) res.write(payload);
  if (info.url && info.status === 'ready') printPublic(info.url);
  else if (info.error) console.log(`[tunnel] ${info.error}`);
});

setInterval(() => {
  for (const res of sseClients.keys()) res.write(': ping\n\n');
}, 20000).unref();

setInterval(() => store.pruneDevices(), 24 * 60 * 60 * 1000).unref();

/** Close live connections of a revoked/removed device so it re-authenticates. */
function kickDevice(deviceId) {
  for (const [res, ctx] of sseClients) {
    if (ctx.device?.id === deviceId) {
      sseClients.delete(res);
      res.end();
    }
  }
}

/** Tell a device its own role/name changed. */
function notifyDevice(deviceId, payload) {
  const msg = `event: me\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [res, ctx] of sseClients) {
    if (ctx.device?.id !== deviceId) continue;
    // Keep the stored role current so live events are filtered correctly.
    if (payload.role && ctx.role !== 'host') ctx.role = payload.role;
    else if (payload.role === 'host') ctx.role = 'host';
    res.write(msg);
  }
}

function handleEvents(req, res, ctx) {
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
  sseClients.set(res, ctx);
  req.on('close', () => sseClients.delete(res));
}

function handleSync(req, res, url, ctx) {
  const since = Number(url.searchParams.get('rev'));
  const reply = () => json(res, 200, snapshotFor(ctx));
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

function serveFile(req, res, itemId, download, ctx) {
  const found = store.findItem(itemId);
  if (!found || found.item.type !== 'file' || !canSeeGroup(ctx, groupOf(found.clipboard.groupId))) {
    return json(res, 404, { error: 'File not found.' });
  }
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
/**
 * QR codes / links for adding a device. With [groupId] (not the default group) the link is an
 * invitation: the device that uses it joins that group. Invites to invite-only groups are host-only.
 */
function connectInfo(req, ctx, groupId) {
  const g = groupId ? groupOf(groupId) : null;
  if (groupId && (!g || !canSeeGroup(ctx, g))) throw new ValidationError('Group not found.', 404);
  if (g && g.access === 'members' && ctx.role !== 'host') throw new ValidationError('Only the host can invite devices to this group.', 403);
  const invite = g && g.id !== DEFAULT_GROUP ? g.id : '';
  const token = auth.createPairToken(invite);
  // The #cb1.<serverId> fragment lets the Android app recognise a ClipBox QR;
  // browsers ignore fragments, so camera-scanned links behave exactly as before.
  // With HTTPS, the certificate fingerprint lets the app pin a self-signed LAN certificate.
  const fragment = `#cb1.${store.serverId}${CERT_SHA256 ? `.sha256-${CERT_SHA256}` : ''}`;
  const withToken = (base) => `${base}/join?t=${encodeURIComponent(token)}${fragment}`;
  const urls = localUrls(config).map((u) => ({
    kind: 'local',
    label: u.virtual ? `${u.label} (virtual)` : u.label,
    url: u.url,
    // Invitations always need the token (it carries the group); otherwise LAN links stay token-free.
    link: config.authMode === 'all' || invite ? withToken(u.url) : `${u.url}/${fragment}`,
  }));
  if (tunnel.url) {
    urls.unshift({
      kind: 'public',
      label: config.tunnel === 'none' ? 'Public URL' : `Public (${config.tunnel})`,
      url: tunnel.url,
      link: withToken(tunnel.url),
      blocked: !auth.passwordSet,
    });
  }
  return {
    urls, token, fragment, tokenMinutes: PAIR_TTL_MS / 60000, tunnel: tunnel.info(),
    group: g ? { id: g.id, name: g.name, access: g.access } : null,
  };
}

// ── router ───────────────────────────────────────────────────
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });

route('GET', /^\/api\/session$/, (req, res) => {
  const a = auth.identify(req);
  json(res, 200, { authenticated: a.ok, required: a.required, reason: a.reason || null, role: a.ok ? a.role : null, ...serverInfo(req) });
}, { open: true });

route('GET', /^\/api\/info$/, (req, res) => {
  json(res, 200, {
    app: 'clipbox',
    apiVersion: 3,
    features: ['groups', 'notes', 'devices'],
    version: VERSION,
    serverId: store.serverId,
    serverName: store.serverName,
    authMode: config.authMode,
    authRequired: auth.requiresAuth(req),
    passwordSet: auth.passwordSet,
    certSha256: CERT_SHA256,
  });
}, { open: true });

route('POST', /^\/api\/login$/, async (req, res) => {
  const body = await readJson(req, 4096);
  const r = auth.login(req, body.password);
  if (!r.ok) return json(res, r.status, { error: r.error });
  // Knowing the host password makes this browser a host device.
  const device = deviceForSignIn(req, 'host');
  json(res, 200, { ok: true }, { 'Set-Cookie': [auth.sessionCookie(req, device.id), auth.deviceCookie(req, device.id)] });
}, { open: true });

route('POST', /^\/api\/logout$/, (req, res) => {
  json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(req) });
}, { open: true });

route('GET', /^\/join$/, (req, res, m, url) => {
  const token = url.searchParams.get('t');
  const invite = auth.verifyPairToken(token);
  if (invite) {
    const device = deviceForSignIn(req, 'member');
    const invitedTo = invite.groupId && groupOf(invite.groupId) ? invite.groupId : null;
    if (invitedTo) store.addMember(invitedTo, device.id);
    return send(res, 302, '', {
      // Open the group this invitation was for.
      Location: invitedTo ? `/?group=${encodeURIComponent(invitedTo)}` : '/',
      'Set-Cookie': [auth.sessionCookie(req, device.id), auth.deviceCookie(req, device.id)],
      'Cache-Control': 'no-store',
    });
  }
  send(res, 302, '', { Location: '/?join=expired', 'Cache-Control': 'no-store' });
}, { open: true });

route('GET', /^\/api\/health$/, (req, res) => json(res, 200, { ok: true }), { open: true });

route('GET', /^\/api\/state$/, (req, res, m, url, ctx) => {
  const cookies = ensureWebDevice(req, ctx);
  json(res, 200, { ...snapshotFor(ctx), server: serverInfo(req), me: me(ctx) }, cookies.length ? { 'Set-Cookie': cookies } : {});
});
route('GET', /^\/api\/events$/, (req, res, m, url, ctx) => handleEvents(req, res, ctx));
route('GET', /^\/api\/sync$/, (req, res, m, url, ctx) => handleSync(req, res, url, ctx));
route('GET', /^\/api\/connect$/, (req, res, m, url, ctx) => json(res, 200, connectInfo(req, ctx, url.searchParams.get('group'))));

route('GET', /^\/api\/qr$/, async (req, res, m, url) => {
  const text = url.searchParams.get('text') || '';
  if (!text || text.length > 1500) throw new ValidationError('Invalid QR text.');
  const svg = await QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  send(res, 200, svg, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
});

// ── devices ──────────────────────────────────────────────────
route('POST', /^\/api\/devices\/pair$/, async (req, res) => {
  const body = await readJson(req, 4096);
  if (auth.rateLimited(req)) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
  let role;
  let invite = null;
  if (body.pairToken) {
    invite = auth.consumePairToken(String(body.pairToken));
    if (!invite) {
      auth.recordFailure(req);
      return json(res, 401, { error: 'This QR code has expired or was already used. Show a new one.', reason: 'pair_expired' });
    }
    role = 'member';
  } else if (body.password !== undefined) {
    const r = auth.login(req, body.password);
    if (!r.ok) return json(res, r.status, { error: r.error, reason: 'login' });
    role = 'host';
  } else {
    const ctx = auth.identify(req);
    if (!ctx.ok || ctx.via === 'bearer') {
      return json(res, 401, { error: 'Scan a fresh QR code or enter the server password.', reason: ctx.reason === 'no_password' ? 'no_password' : 'login' });
    }
    role = ctx.role;
  }
  const { token, hash } = auth.newDeviceToken();
  const platform = ['android', 'ios', 'cli', 'other'].includes(body.platform) ? body.platform : 'other';
  const device = store.createDevice({ name: body.name || (platform === 'android' ? 'Android device' : 'Device'), platform, role, tokenHash: hash });
  const invitedTo = invite?.groupId && groupOf(invite.groupId) ? invite.groupId : null;
  if (invitedTo) store.addMember(invitedTo, device.id);
  json(res, 201, {
    deviceId: device.id,
    groupId: invitedTo, // the group this invitation was for, so the app can open it
    deviceToken: token,
    role: device.role,
    serverId: store.serverId,
    serverName: store.serverName,
    version: VERSION,
    urls: knownUrls(),
  });
}, { open: true });

route('GET', /^\/api\/devices$/, (req, res, m, url, ctx) => {
  json(res, 200, { devices: store.listDevices().map((d) => publicDevice(d, ctx)) });
}, { need: 'host' });

route('DELETE', /^\/api\/devices\/me$/, (req, res, m, url, ctx) => {
  if (!ctx.device) throw new ValidationError('This client has no device record.');
  const id = ctx.device.id;
  store.deleteDevice(id);
  kickDevice(id);
  json(res, 200, { ok: true }, ctx.via === 'bearer' ? {} : { 'Set-Cookie': auth.clearCookie(req) });
}, { need: 'read' });

route('PATCH', /^\/api\/devices\/([\w-]+)$/, async (req, res, m, url, ctx) => {
  const body = await readJson(req, 4096);
  const prevRole = store.getDevice(m[1])?.role;
  const d = store.updateDevice(m[1], { name: body.name, role: body.role, revoked: body.revoked });
  if (d.revoked) kickDevice(d.id);
  else if (d.role !== prevRole || body.name !== undefined) notifyDevice(d.id, { role: d.role, name: d.name });
  json(res, 200, publicDevice(d, ctx));
}, { need: 'host' });

route('DELETE', /^\/api\/devices\/([\w-]+)$/, (req, res, m) => {
  store.deleteDevice(m[1]);
  kickDevice(m[1]);
  json(res, 200, { ok: true });
}, { need: 'host' });

// ── shared notes ─────────────────────────────────────────────
// Private notes never touch the server: there is deliberately no route,
// field or event for them. These routes only handle *shared* notes.
const author = (ctx) => (ctx.device ? { id: ctx.device.id, name: ctx.device.name } : null);

/** Locked notes can only be changed by their author or a host. */
function assertCanModify(note, ctx) {
  if (note.locked && ctx.role !== 'host' && note.authorId !== ctx.device?.id) {
    throw new ValidationError(`Only ${note.authorName} or the host can change this locked note.`, 403, { reason: 'locked' });
  }
}

route('POST', /^\/api\/notes$/, async (req, res, m, url, ctx) => {
  const body = await readJson(req, config.maxNoteBytes * 2 + 8192);
  const groupId = typeof body.groupId === 'string' ? body.groupId : DEFAULT_GROUP;
  assertGroup(ctx, groupId);
  json(res, 201, store.createNote(body, author(ctx), groupId));
});

route('PATCH', /^\/api\/notes\/([\w-]+)$/, async (req, res, m, url, ctx) => {
  const body = await readJson(req, config.maxNoteBytes * 2 + 8192);
  const note = store.getNote(m[1]);
  assertGroup(ctx, note.groupId);
  assertCanModify(note, ctx);
  if (body.locked !== undefined && Boolean(body.locked) !== note.locked && ctx.role !== 'host' && note.authorId !== ctx.device?.id) {
    throw new ValidationError('Only the author or the host can lock or unlock a note.', 403, { reason: 'locked' });
  }
  json(res, 200, store.updateNote(m[1], body, author(ctx)));
});

route('DELETE', /^\/api\/notes\/([\w-]+)$/, (req, res, m, url, ctx) => {
  const note = store.getNote(m[1]);
  assertGroup(ctx, note.groupId);
  assertCanModify(note, ctx);
  store.deleteNote(m[1]);
  json(res, 200, { ok: true });
});

// ── groups ───────────────────────────────────────────────────
route('GET', /^\/api\/groups$/, (req, res, m, url, ctx) => {
  json(res, 200, { groups: store.listGroups().filter((g) => canSeeGroup(ctx, g)).map((g) => publicGroup(g, ctx)) });
});
route('POST', /^\/api\/groups$/, async (req, res, m, url, ctx) => {
  const body = await readJson(req, 4096);
  json(res, 201, publicGroup(store.createGroup(body.name, body.access), ctx));
}, { need: 'host' });
route('PATCH', /^\/api\/groups\/([\w-]+)$/, async (req, res, m, url, ctx) => {
  const body = await readJson(req, 64 * 1024);
  json(res, 200, publicGroup(store.updateGroup(m[1], { name: body.name, access: body.access, members: body.members }), ctx));
}, { need: 'host' });
route('DELETE', /^\/api\/groups\/([\w-]+)$/, (req, res, m) => {
  store.deleteGroup(m[1]);
  json(res, 200, { ok: true });
}, { need: 'host' });

// ── clipboards (every route checks the clipboard's group) ───
const visibleClipboard = (ctx, id) => {
  const c = store.get(id);
  assertGroup(ctx, c.groupId);
  return c;
};
route('POST', /^\/api\/clipboards$/, async (req, res, m, url, ctx) => {
  const body = await readJson(req, 4096);
  const groupId = typeof body.groupId === 'string' ? body.groupId : DEFAULT_GROUP;
  assertGroup(ctx, groupId);
  json(res, 201, store.createClipboard(body.name, groupId));
});
route('PATCH', /^\/api\/clipboards\/([\w-]+)$/, async (req, res, m, url, ctx) => {
  const body = await readJson(req, 4096);
  visibleClipboard(ctx, m[1]);
  json(res, 200, store.renameClipboard(m[1], body.name));
});
route('DELETE', /^\/api\/clipboards\/([\w-]+)$/, (req, res, m, url, ctx) => {
  visibleClipboard(ctx, m[1]);
  store.deleteClipboard(m[1]);
  json(res, 200, { ok: true });
});
route('POST', /^\/api\/clipboards\/([\w-]+)\/clear$/, (req, res, m, url, ctx) => {
  visibleClipboard(ctx, m[1]);
  json(res, 200, store.clearClipboard(m[1]));
});
route('POST', /^\/api\/clipboards\/([\w-]+)\/items$/, async (req, res, m, url, ctx) => {
  const body = await readJson(req, config.maxTextBytes * 2 + 1024);
  visibleClipboard(ctx, m[1]);
  json(res, 201, store.addText(m[1], body.text));
});
route('POST', /^\/api\/clipboards\/([\w-]+)\/files$/, (req, res, m, url, ctx) => {
  visibleClipboard(ctx, m[1]);
  handleUpload(req, res, m[1]);
});
route('PATCH', /^\/api\/clipboards\/([\w-]+)\/items\/([\w-]+)$/, async (req, res, m, url, ctx) => {
  const body = await readJson(req, config.maxTextBytes * 2 + 1024);
  visibleClipboard(ctx, m[1]);
  json(res, 200, store.updateItem(m[1], m[2], body.text));
});
route('DELETE', /^\/api\/clipboards\/([\w-]+)\/items\/([\w-]+)$/, (req, res, m, url, ctx) => {
  visibleClipboard(ctx, m[1]);
  store.deleteItem(m[1], m[2]);
  json(res, 200, { ok: true });
});
route('GET', /^\/files\/([\w-]+)$/, (req, res, m, url, ctx) => serveFile(req, res, m[1], url.searchParams.has('download'), ctx));

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
  // Bearer-token clients are exempt: browsers can't attach that header cross-site either.
  if (req.method !== 'GET' && req.headers['x-clipbox'] !== '1' && !auth.bearerToken(req)) {
    return json(res, 403, { error: 'Missing request header.' });
  }

  let ctx = null;
  if (!r.open) {
    ctx = auth.identify(req);
    if (!ctx.ok) {
      const msg = ctx.reason === 'no_password'
        ? 'Remote access is disabled: set AUTH_PASSWORD on the server to enable it.'
        : ctx.reason === 'device_revoked'
          ? 'This device was removed by the host. Scan a new QR code or sign in again.'
          : 'Login required.';
      return json(res, ctx.reason === 'no_password' ? 403 : 401, { error: msg, reason: ctx.reason });
    }
    const need = r.need || (req.method === 'GET' ? 'read' : 'write');
    if (ROLE_RANK[ctx.role] < NEED_RANK[need]) {
      return json(res, 403, {
        error: need === 'host' ? 'Only the host can do this.' : 'This device is view-only.',
        reason: 'forbidden',
      });
    }
    if (ctx.device) store.touchDevice(ctx.device);
  }

  try {
    await r.handler(req, res, pathname.match(r.pattern), url, ctx);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    if (err instanceof ValidationError) return json(res, err.status, { error: err.message, ...(err.extra || {}) });
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
  if (!process.stdout.isTTY) return; // e.g. running in the background with output in a log file
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
  console.log(`\n  ClipBox ${VERSION} is running — "${store.serverName}"\n`);
  console.log(`  This PC: ${proto}://localhost:${config.port}`);
  for (const u of locals) console.log(`  Network: ${u.url}  (${u.label}${u.virtual ? ', virtual' : ''})`);
  if (config.host === '127.0.0.1' || config.host === 'localhost') console.log('  (HOST is loopback: other devices on your network cannot connect)');
  console.log(`  Data:    ${config.dataDir}`);
  console.log(`  Auth:    ${config.authMode === 'all' ? 'password required for every device' : 'LAN open, password required for remote access'}${auth.passwordSet ? '' : ' (no AUTH_PASSWORD set)'}`);
  const primary = locals.find((u) => !u.virtual) || locals[0];
  if (primary && config.authMode !== 'all' && process.stdout.isTTY) {
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
