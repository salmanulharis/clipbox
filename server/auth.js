'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'clipbox_session';
const PAIR_TTL_MS = 10 * 60 * 1000;

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

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  const h = hostHeader.toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

class Auth {
  constructor(config, getPublicUrl) {
    this.config = config;
    this.getPublicUrl = getPublicUrl;
    this.secret = this._loadSecret();
    // Key depends on the password, so changing the password logs everyone out.
    this.key = crypto.createHmac('sha256', this.secret).update(`pw:${config.authPassword}`).digest();
    this.attempts = new Map();
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

  /** @returns {{ok: true} | {ok: false, reason: 'login' | 'no_password'}} */
  check(req) {
    if (!this.requiresAuth(req)) return { ok: true, required: false };
    if (!this.passwordSet) return { ok: false, required: true, reason: 'no_password' };
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token && this._verify('s', token)) return { ok: true, required: true };
    return { ok: false, required: true, reason: 'login' };
  }

  // ── tokens ───────────────────────────────────────────────────
  _sign(kind, ttlMs) {
    const exp = Date.now() + ttlMs;
    const nonce = crypto.randomBytes(9).toString('base64url');
    const sig = crypto.createHmac('sha256', this.key).update(`${kind}.${exp}.${nonce}`).digest('base64url');
    return `${exp}.${nonce}.${sig}`;
  }

  _verify(kind, token) {
    if (typeof token !== 'string' || token.length > 200) return false;
    const [exp, nonce, sig] = token.split('.');
    if (!exp || !nonce || !sig || Number(exp) < Date.now()) return false;
    const expected = crypto.createHmac('sha256', this.key).update(`${kind}.${exp}.${nonce}`).digest();
    const given = Buffer.from(sig, 'base64url');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  createPairToken() {
    return this.passwordSet ? this._sign('p', PAIR_TTL_MS) : null;
  }

  verifyPairToken(token) {
    return this.passwordSet && this._verify('p', token);
  }

  sessionCookie(req) {
    const maxAge = this.config.sessionDays * 86400;
    const token = this._sign('s', maxAge * 1000);
    return `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`;
  }

  clearCookie(req) {
    return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`;
  }

  // ── password login with simple rate limiting ─────────────────
  clientIp(req) {
    const h = req.headers;
    return (h['cf-connecting-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
  }

  login(req, password) {
    const ip = this.clientIp(req);
    const t = Date.now();
    if (this.attempts.size > 1000) {
      for (const [k, v] of this.attempts) if (v.reset < t) this.attempts.delete(k);
    }
    let a = this.attempts.get(ip);
    if (!a || a.reset < t) a = { count: 0, reset: t + 5 * 60 * 1000 };
    if (a.count >= 10) return { ok: false, status: 429, error: 'Too many attempts. Try again in a few minutes.' };
    if (!this.passwordSet) return { ok: false, status: 403, error: 'No password is configured on the server.' };

    const given = crypto.createHash('sha256').update(String(password ?? '')).digest();
    const expected = crypto.createHash('sha256').update(this.config.authPassword).digest();
    if (!crypto.timingSafeEqual(given, expected)) {
      a.count += 1;
      this.attempts.set(ip, a);
      return { ok: false, status: 401, error: 'Wrong password.' };
    }
    this.attempts.delete(ip);
    return { ok: true };
  }
}

function isSecure(req) {
  return Boolean(req.socket.encrypted) || String(req.headers['x-forwarded-proto'] || '').startsWith('https');
}

module.exports = { Auth, PAIR_TTL_MS, isPrivateAddress };
