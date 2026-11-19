'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'clipbox_session';
const DEVICE_COOKIE = 'clipbox_device';
const PAIR_TTL_MS = 10 * 60 * 1000;
const DEVICE_COOKIE_DAYS = 5 * 365;
const ROLES = ['host', 'member', 'viewer'];

/** Is the address loopback / private / link-local / CGNAT (Tailscale etc.)? */
function isPrivateAddress(addr) {
  if (!addr) return false;
  let a = addr.toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (net.isIPv4(a)) {
    const [p1, p2] = a.split('.').map(Number);
    return (
      p1 === 10 ||
      p1 === 127 ||
      (p1 === 172 && p2 >= 16 && p2 <= 31) ||
      (p1 === 192 && p2 === 168) ||
      (p1 === 169 && p2 === 254) ||
      (p1 === 100 && p2 >= 64 && p2 <= 127)
    );
  }
  if (net.isIPv6(a)) {
    return a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  }
  return false;
}

function isLoopback(addr) {
  if (!addr) return false;
  const a = addr.toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch { /* ignore malformed cookie */ }
  }
  return out;
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  const h = hostHeader.toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Friendly device name from a User-Agent, e.g. "Chrome on Windows". */
function deviceNameFromUA(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
      : /OPR\//.test(ua) ? 'Opera'
        : /Firefox\//.test(ua) ? 'Firefox'
          : /Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const osName = /Android/.test(ua) ? 'Android'
    : /iPhone/.test(ua) ? 'iPhone'
      : /iPad/.test(ua) ? 'iPad'
        : /Windows/.test(ua) ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
            : /CrOS/.test(ua) ? 'ChromeOS'
              : /Linux/.test(ua) ? 'Linux' : '';
  return osName ? `${browser} on ${osName}` : browser;
}

/**
 * Authentication & authorisation.
 *
 * Identity sources (strongest first):
 *  1. `Authorization: Bearer cbd_…` — paired app/API device (token hash stored in db).
 *  2. Session cookie — signed; new sessions are bound to a device id so revoking
 *     the device signs that browser out. Legacy (pre-device) sessions still work.
 *  3. Device cookie — signed device id used for attribution of LAN-open browsers.
 *
 * Roles: host (server machine itself, or a device the host trusts),
 *        member (default), viewer (read-only).
 */
class Auth {
  constructor(config, store, getPublicUrl) {
    this.config = config;
    this.store = store;
    this.getPublicUrl = getPublicUrl;
    this.secret = this._loadSecret();
    // Session/pair key depends on the password, so changing the password logs everyone out.
    this.key = crypto.createHmac('sha256', this.secret).update(`pw:${config.authPassword}`).digest();
    // Device-cookie key does not, so browsers keep their identity across password changes.
    this.deviceKey = crypto.createHmac('sha256', this.secret).update('device-cookie').digest();
    this.attempts = new Map();
    this.usedPairNonces = new Map();
    const host = os.hostname().toLowerCase();
    this.localNames = new Set(['localhost', host, `${host}.local`, `${host}.lan`, ...config.localHostnames]);
  }

  _loadSecret() {
    const file = path.join(this.config.dataDir, 'secret.key');
    try {
      const s = fs.readFileSync(file);
      if (s.length >= 32) return s;
    } catch { /* create below */ }
    const s = crypto.randomBytes(48);
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }

  get passwordSet() {
    return Boolean(this.config.authPassword);
  }

  /**
   * A request is "public" when it did not come straight from a device on the
   * local network: it arrived through a proxy/tunnel (forwarding headers),
   * from a public IP, or with a Host name we don't recognise as local (this
   * also defeats DNS-rebinding attacks from malicious websites).
   */
  isPublic(req) {
    if (!isPrivateAddress(req.socket.remoteAddress)) return true;
    const h = req.headers;
    if (h['x-forwarded-for'] || h['x-forwarded-host'] || h['x-real-ip'] || h['cf-connecting-ip'] || h['cf-ray'] || h.forwarded) {
      return true;
    }
    const host = hostnameOf(h.host);
    if (!host) return true;
    const pub = this.getPublicUrl();
    if (pub && hostnameOf(new URL(pub).host) === host) return true;
    if (net.isIP(host)) return false;
    if (this.localNames.has(host) || host.endsWith('.local')) return false;
    return true;
  }

  requiresAuth(req) {
    return this.config.authMode === 'all' || this.isPublic(req);
  }

  /** The server machine itself (loopback, not via a tunnel). Always host. */
  isHostMachine(req) {
    return isLoopback(req.socket.remoteAddress) && !this.isPublic(req);
  }

  bearerToken(req) {
    const h = req.headers.authorization;
    if (!h || !/^Bearer\s+/i.test(h)) return null;
    return h.replace(/^Bearer\s+/i, '').trim();
  }

  /**
   * Resolve who is making the request and whether they may proceed.
   * @returns {{ok:boolean, required:boolean, reason?:string, role:string, device:object|null,
   *            via:'bearer'|'session'|'open', session:object|null, deviceFromCookie:boolean}}
   */
  identify(req) {
    const required = this.requiresAuth(req);
    const hostMachine = this.isHostMachine(req);

    // 1. Bearer token (paired apps). Valid on LAN and remotely.
    const bearer = this.bearerToken(req);
    if (bearer) {
      const dev = bearer.startsWith('cbd_') ? this.store.findDeviceByTokenHash(sha256(bearer)) : null;
      if (!dev || dev.revoked) return { ok: false, required: true, reason: 'device_revoked', role: 'viewer', device: null, via: 'bearer' };
      return { ok: true, required, role: hostMachine ? 'host' : dev.role, device: dev, via: 'bearer', session: null };
    }

    // 2. Session cookie
    const cookies = parseCookies(req.headers.cookie);
    let session = null;
    const raw = cookies[COOKIE];
    if (raw) {
      const v = this._verify('sd', raw) || this._verify('s', raw);
      if (v) {
        session = { kind: v.kind, deviceId: v.data || null, revoked: false };
        if (session.deviceId) {
          const d = this.store.getDevice(session.deviceId);
          if (!d || d.revoked) session.revoked = true;
        }
      }
    }
    const sessionValid = Boolean(session && !session.revoked);

    if (required && !sessionValid) {
      if (!this.passwordSet && !session) return { ok: false, required, reason: 'no_password', role: 'viewer', device: null, via: 'session' };
      return { ok: false, required, reason: session?.revoked ? 'device_revoked' : 'login', role: 'viewer', device: null, via: 'session' };
    }

    // 3. Device for attribution: session-bound first, then device cookie.
    let device = sessionValid && session.deviceId ? this.store.getDevice(session.deviceId) : null;
    let deviceFromCookie = false;
    if (!device) {
      const id = this._verifyDeviceCookie(cookies[DEVICE_COOKIE]);
      const d = id && this.store.getDevice(id);
      if (d && !d.revoked) { device = d; deviceFromCookie = true; }
    }

    let role = device ? device.role : 'member';
    if (hostMachine) role = 'host';
    return { ok: true, required, role, device, via: sessionValid ? 'session' : 'open', session: sessionValid ? session : null, deviceFromCookie };
  }

  /** Backwards-compatible alias. */
  check(req) {
    return this.identify(req);
  }

  // ── tokens ───────────────────────────────────────────────────
  _sign(kind, ttlMs, data = '') {
    const exp = Date.now() + ttlMs;
    const nonce = crypto.randomBytes(9).toString('base64url');
    const msg = data ? `${kind}.${exp}.${nonce}.${data}` : `${kind}.${exp}.${nonce}`;
    const sig = crypto.createHmac('sha256', this.key).update(msg).digest('base64url');
    return data ? `${exp}.${nonce}.${data}.${sig}` : `${exp}.${nonce}.${sig}`;
  }

  /** @returns {{kind, exp, nonce, data}|null} */
  _verify(kind, token) {
    if (typeof token !== 'string' || token.length > 300) return null;
    const parts = token.split('.');
    if (parts.length !== 3 && parts.length !== 4) return null;
    const [exp, nonce] = parts;
    const data = parts.length === 4 ? parts[2] : '';
    const sig = parts[parts.length - 1];
    if (!exp || !nonce || !sig || Number(exp) < Date.now()) return null;
    const msg = data ? `${kind}.${exp}.${nonce}.${data}` : `${kind}.${exp}.${nonce}`;
    const expected = crypto.createHmac('sha256', this.key).update(msg).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    return { kind, exp: Number(exp), nonce, data };
  }

  /** QR join/pair token. No longer requires a password (signed with the server secret). */
  createPairToken() {
    return this._sign('p', PAIR_TTL_MS);
  }

  /** Browser join (/join): reusable within its lifetime so one QR can onboard several phones. */
  verifyPairToken(token) {
    return Boolean(this._verify('p', token));
  }

  /** App pairing: each token can register only one device. */
  consumePairToken(token) {
    const v = this._verify('p', token);
    if (!v) return false;
    const now = Date.now();
    for (const [n, exp] of this.usedPairNonces) if (exp < now) this.usedPairNonces.delete(n);
    if (this.usedPairNonces.has(v.nonce)) return false;
    this.usedPairNonces.set(v.nonce, v.exp);
    return true;
  }

  sessionCookie(req, deviceId) {
    const maxAge = this.config.sessionDays * 86400;
    const token = deviceId ? this._sign('sd', maxAge * 1000, deviceId) : this._sign('s', maxAge * 1000);
    return `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`;
  }

  clearCookie(req) {
    return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`;
  }

  deviceCookie(req, deviceId) {
    const sig = crypto.createHmac('sha256', this.deviceKey).update(`d.${deviceId}`).digest('base64url');
    const maxAge = DEVICE_COOKIE_DAYS * 86400;
    return `${DEVICE_COOKIE}=${deviceId}.${sig}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`;
  }

  _verifyDeviceCookie(value) {
    if (typeof value !== 'string' || value.length > 200) return null;
    const i = value.lastIndexOf('.');
    if (i < 1) return null;
    const id = value.slice(0, i);
    const expected = crypto.createHmac('sha256', this.deviceKey).update(`d.${id}`).digest();
    const given = Buffer.from(value.slice(i + 1), 'base64url');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? id : null;
  }

  /** The browser's existing device (from its device cookie), if valid and not revoked. */
  cookieDevice(req) {
    const id = this._verifyDeviceCookie(parseCookies(req.headers.cookie)[DEVICE_COOKIE]);
    const d = id && this.store.getDevice(id);
    return d && !d.revoked ? d : null;
  }

  /** New random bearer token for an app device. Only its hash is stored. */
  newDeviceToken() {
    const token = `cbd_${crypto.randomBytes(32).toString('base64url')}`;
    return { token, hash: sha256(token) };
  }

  // ── rate limiting ────────────────────────────────────────────
  clientIp(req) {
    const h = req.headers;
    return (h['cf-connecting-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
  }

  _bucket(req) {
    const ip = this.clientIp(req);
    const t = Date.now();
    if (this.attempts.size > 1000) {
      for (const [k, v] of this.attempts) if (v.reset < t) this.attempts.delete(k);
    }
    let a = this.attempts.get(ip);
    if (!a || a.reset < t) a = { count: 0, reset: t + 5 * 60 * 1000 };
    return { ip, a };
  }

  rateLimited(req) {
    return this._bucket(req).a.count >= 10;
  }

  recordFailure(req) {
    const { ip, a } = this._bucket(req);
    a.count += 1;
    this.attempts.set(ip, a);
  }

  login(req, password) {
    if (this.rateLimited(req)) return { ok: false, status: 429, error: 'Too many attempts. Try again in a few minutes.' };
    if (!this.passwordSet) return { ok: false, status: 403, error: 'No password is configured on the server.' };
    const given = crypto.createHash('sha256').update(String(password ?? '')).digest();
    const expected = crypto.createHash('sha256').update(this.config.authPassword).digest();
    if (!crypto.timingSafeEqual(given, expected)) {
      this.recordFailure(req);
      return { ok: false, status: 401, error: 'Wrong password.' };
    }
    this.attempts.delete(this.clientIp(req));
    return { ok: true };
  }
}

function isSecure(req) {
  return Boolean(req.socket.encrypted) || String(req.headers['x-forwarded-proto'] || '').startsWith('https');
}

module.exports = { Auth, PAIR_TTL_MS, ROLES, isPrivateAddress, isLoopback, deviceNameFromUA };
