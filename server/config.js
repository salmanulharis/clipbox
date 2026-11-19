'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Minimal .env loader (no dependency). Existing environment variables win. */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2];
      if (quoted[1] === '"') value = value.replace(/\\n/g, '\n');
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

const env = (key, fallback = '') => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v.trim();
};
const bool = (key, fallback) => {
  const v = env(key, '').toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
};
const int = (key, fallback, min, max) => {
  const n = parseInt(env(key, ''), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const stripSlash = (u) => u.replace(/\/+$/, '');

const config = {
  root: ROOT,
  host: env('HOST', '0.0.0.0'),
  port: int('PORT', 3210, 1, 65535),
  dataDir: path.resolve(ROOT, env('DATA_DIR', './data')),

  authPassword: env('AUTH_PASSWORD', ''),
  authMode: env('AUTH_MODE', 'public').toLowerCase() === 'all' ? 'all' : 'public',
  sessionDays: int('SESSION_DAYS', 30, 1, 3650),
  localHostnames: env('LOCAL_HOSTNAMES', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  tunnel: ['ngrok', 'cloudflare'].includes(env('TUNNEL', 'none').toLowerCase())
    ? env('TUNNEL').toLowerCase()
    : 'none',
  tunnelAutostart: bool('TUNNEL_AUTOSTART', false),
  publicUrl: stripSlash(env('PUBLIC_URL', '')),
  ngrokBin: env('NGROK_BIN', 'ngrok'),
  ngrokApi: stripSlash(env('NGROK_API', 'http://127.0.0.1:4040')),
  ngrokDomain: env('NGROK_DOMAIN', '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  cloudflaredBin: env('CLOUDFLARED_BIN', 'cloudflared'),
  cloudflareToken: env('CLOUDFLARE_TUNNEL_TOKEN', ''),

  maxTextBytes: int('MAX_TEXT_KB', 1024, 1, 51200) * 1024,
  maxFileBytes: int('MAX_FILE_MB', 25, 1, 2048) * 1024 * 1024,
  maxNoteBytes: int('NOTE_MAX_KB', 256, 1, 10240) * 1024,

  httpsCert: env('HTTPS_CERT', ''),
  httpsKey: env('HTTPS_KEY', ''),
};

config.https = Boolean(config.httpsCert && config.httpsKey);

if (config.publicUrl && !/^https?:\/\/[^\s/]+/i.test(config.publicUrl)) {
  console.warn(`[config] PUBLIC_URL "${config.publicUrl}" is not a valid http(s) URL — ignored.`);
  config.publicUrl = '';
}

module.exports = config;
