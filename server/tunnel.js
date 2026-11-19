'use strict';
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * Discovers (and optionally launches) the public tunnel URL.
 *  - PUBLIC_URL:   fixed URL, always used when set.
 *  - ngrok:        URL read from ngrok's local API (works whether we launched it or not).
 *  - cloudflare:   quick tunnel URL parsed from cloudflared's output, or PUBLIC_URL for named tunnels.
 */
class Tunnel extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.url = config.publicUrl || null;
    this.status = config.publicUrl ? 'ready' : config.tunnel === 'none' ? 'off' : 'starting';
    this.error = null;
    this.child = null;
    this._timer = null;
    this._stopped = false;
  }

  get target() {
    const proto = this.config.https ? 'https' : 'http';
    return `${proto}://localhost:${this.config.port}`;
  }

  start() {
    const { tunnel, tunnelAutostart } = this.config;
    if (tunnel === 'ngrok') {
      if (tunnelAutostart) this._launchNgrok();
      this._pollNgrok(1500);
    } else if (tunnel === 'cloudflare') {
      if (tunnelAutostart) this._launchCloudflared();
      else if (!this.config.publicUrl) {
        this._set(null, 'error', 'Cloudflare tunnel URL unknown: set TUNNEL_AUTOSTART=true or PUBLIC_URL.');
      }
    }
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    if (this.child && !this.child.killed) this.child.kill();
  }

  _set(url, status, error = null) {
    if (this.config.publicUrl) url = this.config.publicUrl; // explicit URL always wins
    const changed = url !== this.url || status !== this.status || error !== this.error;
    this.url = url;
    this.status = status;
    this.error = error;
    if (changed) this.emit('update', this.info());
  }

  info() {
    return { provider: this.config.tunnel, url: this.url, status: this.status, error: this.error };
  }

  _spawn(bin, args, onOutput) {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      this._set(null, 'error', `Could not start ${bin}: ${err.message}`);
      return null;
    }
    this.child = child;
    const handle = (buf) => onOutput(buf.toString());
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (err) => {
      const msg = err.code === 'ENOENT' ? `"${bin}" was not found. Install it or set its path in .env.` : err.message;
      this._set(null, 'error', msg);
    });
    child.on('exit', (code) => {
      if (this._stopped) return;
      this._set(null, 'error', `${bin} exited (code ${code}).`);
    });
    return child;
  }

  // ── ngrok ────────────────────────────────────────────────────
  _launchNgrok() {
    const args = ['http', this.target, '--log', 'stdout', '--log-format', 'logfmt'];
    if (this.config.ngrokDomain) args.push('--domain', this.config.ngrokDomain);
    let lastErr = '';
    this._spawn(this.config.ngrokBin, args, (text) => {
      const m = text.match(/lvl=(?:eror|crit)[^\n]*?err="?([^"\n]+)/);
      if (m) {
        lastErr = m[1];
        this._set(null, 'error', `ngrok: ${lastErr}`);
      }
    });
  }

  async _pollNgrok(delay) {
    clearTimeout(this._timer);
    this._timer = setTimeout(async () => {
      if (this._stopped) return;
      let next = 3000;
      try {
        const res = await fetch(`${this.config.ngrokApi}/api/tunnels`, { signal: AbortSignal.timeout(3000) });
        const data = await res.json();
        const port = String(this.config.port);
        const match = (data.tunnels || []).filter((t) => {
          const addr = String(t.config?.addr || '');
          return addr.endsWith(`:${port}`) || addr === port;
        });
        const t = match.find((x) => x.public_url?.startsWith('https')) || match[0];
        if (t) {
          this._set(t.public_url.replace(/\/+$/, ''), 'ready');
          next = 15000;
        } else if (this.status !== 'error') {
          this._set(null, 'starting', `ngrok is running but has no tunnel to port ${port}.`);
        }
      } catch {
        if (this.status === 'ready' || !this.config.tunnelAutostart) {
          this._set(null, this.config.tunnelAutostart ? 'error' : 'starting',
            this.config.tunnelAutostart ? 'Lost connection to ngrok.' : `Waiting for ngrok (run: ngrok http ${this.config.port}).`);
        }
      }
      this._pollNgrok(next);
    }, delay);
  }

  // ── cloudflared ──────────────────────────────────────────────
  _launchCloudflared() {
    const named = Boolean(this.config.cloudflareToken);
    const args = named
      ? ['tunnel', '--no-autoupdate', 'run', '--token', this.config.cloudflareToken]
      : ['tunnel', '--no-autoupdate', '--url', this.target];
    if (this.config.https && !named) args.push('--no-tls-verify');
    if (named && !this.config.publicUrl) {
      this._set(null, 'error', 'Named Cloudflare tunnel: set PUBLIC_URL to its hostname.');
    }
    this._spawn(this.config.cloudflaredBin, args, (text) => {
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !named) this._set(m[0], 'ready');
      if (named && /Registered tunnel connection/i.test(text) && this.config.publicUrl) this._set(this.config.publicUrl, 'ready');
    });
  }
}

module.exports = { Tunnel };
