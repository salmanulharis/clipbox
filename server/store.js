'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MAX_CLIPBOARDS = 200;
const MAX_ITEMS = 1000;
const MAX_NAME = 60;
const MAX_DEVICE_NAME = 40;
const MAX_DEVICES = 500;
const SCHEMA_VERSION = 2;
const WEB_DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ROLES = ['host', 'member', 'viewer'];

const newId = () => crypto.randomBytes(9).toString('base64url');
const now = () => Date.now();

class SchemaError extends Error {}

class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Remove control characters and collapse whitespace in names. */
function cleanName(name) {
  if (typeof name !== 'string') throw new ValidationError('Name must be text.');
  // eslint-disable-next-line no-control-regex
  const v = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!v) throw new ValidationError('Name cannot be empty.');
  if (v.length > MAX_NAME) throw new ValidationError(`Name is too long (max ${MAX_NAME} characters).`);
  return v;
}

function cleanDeviceName(name) {
  // eslint-disable-next-line no-control-regex
  const v = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!v) throw new ValidationError('Device name cannot be empty.');
  return v.slice(0, MAX_DEVICE_NAME);
}

/**
 * JSON-file store. All data lives in memory and is flushed to disk with an
 * atomic write (temp file + rename) shortly after every change.
 */
class Store extends EventEmitter {
  constructor(dataDir, { maxTextBytes }) {
    super();
    this.dir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.backup = path.join(dataDir, 'db.json.bak');
    this.filesDir = path.join(dataDir, 'files');
    this.maxTextBytes = maxTextBytes;
    this.db = null;
    this.rev = 0;
    this.boot = newId(); // changes on every server start
    this._saveTimer = null;
    this._saving = null;
    this._dirty = false;
  }

  load() {
    fs.mkdirSync(this.filesDir, { recursive: true });
    for (const f of [this.file, this.backup]) {
      try {
        const db = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!db || !Array.isArray(db.clipboards)) throw new Error('invalid structure');
        this.db = db;
        if (f === this.backup) console.warn('[store] main database unreadable — restored from backup.');
        break;
      } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`[store] could not read ${path.basename(f)}: ${err.message}`);
      }
    }
    if (!this.db) {
      this.db = { version: SCHEMA_VERSION, clipboards: [] };
      this._create('General');
    }
    this._migrate();
    this.pruneDevices();
    this.saveSync();
    this.rev = 1;
    this._cleanupOrphanFiles();
  }

  /**
   * Upgrade older databases in place. A one-time copy of the original v1 file
   * is kept as db.v1-backup.json. Databases from a newer ClipBox are refused
   * rather than risk silently dropping data.
   */
  _migrate() {
    const v = Number(this.db.version) || 1;
    if (v > SCHEMA_VERSION) {
      throw new SchemaError(
        `data/db.json uses schema v${v}, but this ClipBox only understands up to v${SCHEMA_VERSION}. ` +
        'Update ClipBox, or restore an older backup.',
      );
    }
    if (v < 2) {
      const backup = path.join(this.dir, 'db.v1-backup.json');
      if (!fs.existsSync(backup) && fs.existsSync(this.file)) fs.copyFileSync(this.file, backup);
      console.log('[store] upgraded database to schema v2 (backup: db.v1-backup.json)');
    }
    this.db.version = SCHEMA_VERSION;
    if (!this.db.serverId) this.db.serverId = `srv_${newId()}`;
    if (!this.db.serverName) this.db.serverName = os.hostname();
    if (!Array.isArray(this.db.notes)) this.db.notes = [];
    if (!Array.isArray(this.db.devices)) this.db.devices = [];
  }

  // ── persistence ──────────────────────────────────────────────
  _changed(event) {
    this.rev += 1;
    this._dirty = true;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 150);
    this.emit('change', { ...event, rev: this.rev, boot: this.boot, order: this.db.clipboards.map((c) => c.id) });
  }

  async _save() {
    if (this._saving) {
      await this._saving;
      if (!this._dirty) return;
    }
    this._dirty = false;
    const data = JSON.stringify(this.db);
    const tmp = `${this.file}.tmp`;
    this._saving = (async () => {
      try {
        const fh = await fsp.open(tmp, 'w');
        try {
          await fh.writeFile(data, 'utf8');
          await fh.sync();
        } finally {
          await fh.close();
        }
        await fsp.copyFile(this.file, this.backup).catch(() => {});
        await renameWithRetry(tmp, this.file);
      } catch (err) {
        this._dirty = true;
        console.error('[store] save failed:', err.message);
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._save(), 2000);
      }
    })();
    await this._saving;
    this._saving = null;
  }

  /** Synchronous flush, used at startup and on shutdown. */
  saveSync() {
    clearTimeout(this._saveTimer);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db), 'utf8');
    try { fs.copyFileSync(this.file, this.backup); } catch { /* first run */ }
    fs.renameSync(tmp, this.file);
    this._dirty = false;
  }

  /** Persist without broadcasting a sync event (device bookkeeping). */
  _persist() {
    this._dirty = true;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 500);
  }

  flush() {
    if (this._dirty) this.saveSync();
  }

  _cleanupOrphanFiles() {
    const used = new Set();
    for (const c of this.db.clipboards) for (const i of c.items) if (i.type === 'file') used.add(i.id);
    for (const f of fs.readdirSync(this.filesDir)) {
      if (!used.has(f)) fs.rm(path.join(this.filesDir, f), { force: true }, () => {});
    }
  }

  _removeFiles(items) {
    for (const i of items) {
      if (i.type === 'file') fs.rm(this.filePath(i.id), { force: true }, () => {});
    }
  }

  filePath(itemId) {
    return path.join(this.filesDir, itemId.replace(/[^A-Za-z0-9_-]/g, ''));
  }

  // ── server identity ──────────────────────────────────────────
  get serverId() {
    return this.db.serverId;
  }

  get serverName() {
    return this.db.serverName;
  }

  // ── devices ──────────────────────────────────────────────────
  getDevice(id) {
    return (id && this.db.devices.find((d) => d.id === id)) || null;
  }

  findDeviceByTokenHash(hash) {
    return this.db.devices.find((d) => d.tokenHash && d.tokenHash === hash) || null;
  }

  listDevices() {
    return this.db.devices;
  }

  createDevice({ name, platform = 'web', role = 'member', tokenHash = null }) {
    if (this.db.devices.length >= MAX_DEVICES) {
      this.pruneDevices(0);
      if (this.db.devices.length >= MAX_DEVICES) throw new ValidationError('Too many devices. Remove some in Devices.', 409);
    }
    const t = now();
    const device = {
      id: `dev_${newId()}`,
      name: cleanDeviceName(name),
      platform: ['web', 'android', 'ios', 'cli', 'other'].includes(platform) ? platform : 'other',
      role: ROLES.includes(role) ? role : 'member',
      tokenHash,
      createdAt: t,
      lastSeenAt: t,
      revoked: false,
    };
    this.db.devices.push(device);
    this._persist();
    return device;
  }

  updateDevice(id, { name, role, revoked }) {
    const d = this.getDevice(id);
    if (!d) throw new ValidationError('Device not found.', 404);
    if (name !== undefined) d.name = cleanDeviceName(name);
    if (role !== undefined) {
      if (!ROLES.includes(role)) throw new ValidationError('Invalid role.');
      d.role = role;
    }
    if (revoked !== undefined) d.revoked = Boolean(revoked);
    this._persist();
    return d;
  }

  deleteDevice(id) {
    const before = this.db.devices.length;
    this.db.devices = this.db.devices.filter((d) => d.id !== id);
    if (this.db.devices.length === before) throw new ValidationError('Device not found.', 404);
    this._persist();
  }

  /** Update last-seen at most once a minute to avoid needless writes. */
  touchDevice(device) {
    const t = now();
    if (t - device.lastSeenAt > 60000) {
      device.lastSeenAt = t;
      this._persist();
    }
  }

  /** Forget browser devices not seen for 90 days (app devices are kept until removed). */
  pruneDevices(ttl = WEB_DEVICE_TTL_MS) {
    const cutoff = now() - ttl;
    const before = this.db.devices.length;
    this.db.devices = this.db.devices.filter((d) => d.tokenHash || d.role === 'host' || d.lastSeenAt >= cutoff);
    if (this.db.devices.length !== before) this._persist();
  }

  // ── queries ──────────────────────────────────────────────────
  snapshot() {
    return { rev: this.rev, boot: this.boot, clipboards: this.db.clipboards };
  }

  get(id) {
    const c = this.db.clipboards.find((x) => x.id === id);
    if (!c) throw new ValidationError('Clipboard not found.', 404);
    return c;
  }

  findItem(itemId) {
    for (const c of this.db.clipboards) {
      const item = c.items.find((i) => i.id === itemId);
      if (item) return { clipboard: c, item };
    }
    return null;
  }

  // ── clipboard operations ─────────────────────────────────────
  _create(name) {
    const t = now();
    const c = { id: newId(), name: cleanName(name), createdAt: t, updatedAt: t, items: [] };
    this.db.clipboards.push(c);
    return c;
  }

  createClipboard(name) {
    if (this.db.clipboards.length >= MAX_CLIPBOARDS) throw new ValidationError('Too many clipboards.');
    const c = this._create(name);
    this._changed({ type: 'clipboard', clipboard: c });
    return c;
  }

  renameClipboard(id, name) {
    const c = this.get(id);
    c.name = cleanName(name);
    c.updatedAt = now();
    this._changed({ type: 'clipboard', clipboard: c });
    return c;
  }

  clearClipboard(id) {
    const c = this.get(id);
    this._removeFiles(c.items);
    c.items = [];
    c.updatedAt = now();
    this._changed({ type: 'clipboard', clipboard: c });
    return c;
  }

  deleteClipboard(id) {
    const c = this.get(id);
    this._removeFiles(c.items);
    this.db.clipboards = this.db.clipboards.filter((x) => x.id !== id);
    if (this.db.clipboards.length === 0) {
      const fresh = this._create('General');
      this._changed({ type: 'clipboard', clipboard: fresh });
    }
    this._changed({ type: 'remove', id });
  }

  // ── item operations ──────────────────────────────────────────
  _checkText(text) {
    if (typeof text !== 'string') throw new ValidationError('Text is required.');
    if (!text.trim()) throw new ValidationError('Text cannot be empty.');
    if (Buffer.byteLength(text, 'utf8') > this.maxTextBytes) {
      throw new ValidationError(`Text is too large (max ${Math.round(this.maxTextBytes / 1024)} KB).`, 413);
    }
    return text;
  }

  _pushItem(c, item) {
    if (c.items.length >= MAX_ITEMS) {
      const dropped = c.items.splice(MAX_ITEMS - 1);
      this._removeFiles(dropped);
    }
    c.items.unshift(item);
    c.updatedAt = item.createdAt;
    this._changed({ type: 'clipboard', clipboard: c });
    return item;
  }

  addText(clipboardId, text) {
    const c = this.get(clipboardId);
    const t = now();
    return this._pushItem(c, { id: newId(), type: 'text', text: this._checkText(text), createdAt: t, updatedAt: t });
  }

  /** Register a file that has already been written to filePath(id). */
  addFile(clipboardId, { id, name, mime, size }) {
    const c = this.get(clipboardId);
    const t = now();
    return this._pushItem(c, { id, type: 'file', name, mime, size, createdAt: t, updatedAt: t });
  }

  updateItem(clipboardId, itemId, text) {
    const c = this.get(clipboardId);
    const item = c.items.find((i) => i.id === itemId);
    if (!item) throw new ValidationError('Item not found.', 404);
    if (item.type !== 'text') throw new ValidationError('Only text items can be edited.');
    item.text = this._checkText(text);
    item.updatedAt = now();
    c.updatedAt = item.updatedAt;
    this._changed({ type: 'clipboard', clipboard: c });
    return item;
  }

  deleteItem(clipboardId, itemId) {
    const c = this.get(clipboardId);
    const item = c.items.find((i) => i.id === itemId);
    if (!item) throw new ValidationError('Item not found.', 404);
    c.items = c.items.filter((i) => i.id !== itemId);
    this._removeFiles([item]);
    c.updatedAt = now();
    this._changed({ type: 'clipboard', clipboard: c });
  }
}

async function renameWithRetry(from, to, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      // Windows can briefly lock files (antivirus, indexer).
      if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

module.exports = { Store, ValidationError, SchemaError, newId, SCHEMA_VERSION };
