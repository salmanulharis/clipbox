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
const SCHEMA_VERSION = 3;
/** The group every existing clipboard/note moved into; visible to all devices; can't be deleted. */
const DEFAULT_GROUP = 'grp_everyone';
const MAX_GROUPS = 50;
/**
 * all: every device sees the group directly.
 * password: every device sees it (locked); entering its password joins it.
 * members: hidden from everyone but its members (and the host).
 */
const ACCESS = ['all', 'password', 'members'];
const MIN_GROUP_PASSWORD = 4;
const MAX_GROUP_PASSWORD = 200;

/** scrypt hash of a group password, as "scrypt$salt$hash" (base64url). */
function hashGroupPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_GROUP_PASSWORD || password.length > MAX_GROUP_PASSWORD) {
    throw new ValidationError(`The group password must be ${MIN_GROUP_PASSWORD}–${MAX_GROUP_PASSWORD} characters.`);
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password.normalize('NFC'), salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function checkGroupPassword(stored, password) {
  if (typeof stored !== 'string' || typeof password !== 'string' || password.length > MAX_GROUP_PASSWORD) return false;
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(password.normalize('NFC'), Buffer.from(salt, 'base64url'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
const WEB_DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ROLES = ['host', 'member', 'viewer'];
const MAX_NOTES = 2000;
const MAX_NOTE_TITLE = 200;
const MAX_TAGS = 20;
const MAX_TAG = 30;

const newId = () => crypto.randomBytes(9).toString('base64url');
const now = () => Date.now();

class SchemaError extends Error {}

class ValidationError extends Error {
  constructor(message, status = 400, extra = undefined) {
    super(message);
    this.status = status;
    this.extra = extra; // merged into the JSON error response
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function cleanTitle(title) {
  if (title === undefined || title === null) return '';
  if (typeof title !== 'string') throw new ValidationError('Title must be text.');
  const v = title.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  if (v.length > MAX_NOTE_TITLE) throw new ValidationError(`Title is too long (max ${MAX_NOTE_TITLE} characters).`);
  return v;
}

function cleanTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new ValidationError('Tags must be a list.');
  const out = [];
  const seen = new Set();
  for (const t of tags) {
    if (typeof t !== 'string') throw new ValidationError('Tags must be text.');
    const v = t.replace(CONTROL, '').replace(/^#+/, '').replace(/\s+/g, '-').trim().slice(0, MAX_TAG);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  if (out.length > MAX_TAGS) throw new ValidationError(`Too many tags (max ${MAX_TAGS}).`);
  return out;
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
  constructor(dataDir, { maxTextBytes, maxNoteBytes = 256 * 1024 }) {
    super();
    this.dir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.backup = path.join(dataDir, 'db.json.bak');
    this.filesDir = path.join(dataDir, 'files');
    this.maxTextBytes = maxTextBytes;
    this.maxNoteBytes = maxNoteBytes;
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
      this._create('General', DEFAULT_GROUP);
    }
    this._migrate();
    this.pruneDevices();
    this.saveSync();
    this.rev = 1;
    this._cleanupOrphanFiles();
  }

  /**
   * Upgrade older databases in place, keeping a one-time copy of the original
   * file (db.v1-backup.json / db.v2-backup.json). Databases from a newer
   * ClipBox are refused rather than risk silently dropping data.
   *  v2: server identity, shared notes, devices
   *  v3: groups — everything existing moves into the "Everyone" group
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
    if (v === 2) {
      const backup = path.join(this.dir, 'db.v2-backup.json');
      if (!fs.existsSync(backup) && fs.existsSync(this.file)) fs.copyFileSync(this.file, backup);
      console.log('[store] upgraded database to schema v3: groups (backup: db.v2-backup.json)');
    }
    this.db.version = SCHEMA_VERSION;
    if (!this.db.serverId) this.db.serverId = `srv_${newId()}`;
    if (!this.db.serverName) this.db.serverName = os.hostname();
    if (!Array.isArray(this.db.notes)) this.db.notes = [];
    if (!Array.isArray(this.db.devices)) this.db.devices = [];
    if (!Array.isArray(this.db.groups)) this.db.groups = [];
    if (!this.db.groups.some((g) => g.id === DEFAULT_GROUP)) {
      this.db.groups.unshift({ id: DEFAULT_GROUP, name: 'Everyone', access: 'all', members: [], createdAt: now() });
    }
    const known = new Set(this.db.groups.map((g) => g.id));
    for (const c of this.db.clipboards) if (!known.has(c.groupId)) c.groupId = DEFAULT_GROUP;
    for (const n of this.db.notes) if (!known.has(n.groupId)) n.groupId = DEFAULT_GROUP;
    for (const g of this.db.groups) {
      if (!Array.isArray(g.members)) g.members = [];
      if (!this.db.clipboards.some((c) => c.groupId === g.id)) this._create('General', g.id);
    }
  }

  // ── persistence ──────────────────────────────────────────────
  _changed(event) {
    this.rev += 1;
    this._dirty = true;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 150);
    const groupId = event.groupId ?? event.clipboard?.groupId ?? event.note?.groupId ?? null;
    this.emit('change', { ...event, groupId, rev: this.rev, boot: this.boot, order: this.db.clipboards.map((c) => c.id) });
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
    if (this.db.groups.some((g) => g.members.includes(id))) {
      for (const g of this.db.groups) g.members = g.members.filter((m) => m !== id);
      this._changed({ type: 'groups' });
    } else {
      this._persist();
    }
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
    if (this.db.devices.length !== before) {
      const alive = new Set(this.db.devices.map((d) => d.id));
      for (const g of this.db.groups || []) g.members = g.members.filter((m) => alive.has(m));
      this._persist();
    }
  }

  // ── shared notes ─────────────────────────────────────────────
  getNote(id) {
    const n = this.db.notes.find((x) => x.id === id);
    if (!n) throw new ValidationError('Note not found.', 404);
    return n;
  }

  _checkBody(body) {
    if (body === undefined || body === null) return '';
    if (typeof body !== 'string') throw new ValidationError('Note body must be text.');
    if (Buffer.byteLength(body, 'utf8') > this.maxNoteBytes) {
      throw new ValidationError(`Note is too large (max ${Math.round(this.maxNoteBytes / 1024)} KB).`, 413);
    }
    return body;
  }

  /** @param author {{id, name}|null} */
  createNote(fields, author, groupId = DEFAULT_GROUP) {
    if (this.db.notes.length >= MAX_NOTES) throw new ValidationError(`Too many shared notes (max ${MAX_NOTES}).`, 409);
    this.getGroup(groupId);
    const title = cleanTitle(fields.title);
    const body = this._checkBody(fields.body);
    if (!title && !body.trim()) throw new ValidationError('A note needs a title or some text.');
    const t = now();
    const note = {
      id: `n_${newId()}`,
      title,
      body,
      tags: cleanTags(fields.tags),
      pinned: Boolean(fields.pinned),
      locked: Boolean(fields.locked),
      authorId: author?.id || null,
      authorName: author?.name || 'Unknown device',
      version: 1,
      createdAt: t,
      updatedAt: t,
      updatedBy: author?.id || null,
      updatedByName: author?.name || 'Unknown device',
      groupId,
    };
    this.db.notes.push(note);
    this._changed({ type: 'note', note });
    return note;
  }

  /**
   * Content changes (title/body/tags) require the caller's baseVersion and bump
   * the version; a stale baseVersion is a 409 carrying the current note.
   * pinned/locked are metadata: no version check, no version bump.
   */
  updateNote(id, patch, author) {
    const n = this.getNote(id);
    const content = ['title', 'body', 'tags'].some((k) => patch[k] !== undefined);
    if (content) {
      if (!Number.isInteger(patch.baseVersion)) throw new ValidationError('baseVersion is required when changing a note.');
      if (patch.baseVersion !== n.version) {
        throw new ValidationError(`This note was changed on ${n.updatedByName}.`, 409, { reason: 'conflict', note: n });
      }
    }
    const next = {
      title: patch.title !== undefined ? cleanTitle(patch.title) : n.title,
      body: patch.body !== undefined ? this._checkBody(patch.body) : n.body,
      tags: patch.tags !== undefined ? cleanTags(patch.tags) : n.tags,
    };
    if (content && !next.title && !next.body.trim()) throw new ValidationError('A note needs a title or some text.');
    Object.assign(n, next);
    if (patch.pinned !== undefined) n.pinned = Boolean(patch.pinned);
    if (patch.locked !== undefined) n.locked = Boolean(patch.locked);
    if (content) n.version += 1;
    n.updatedAt = now();
    n.updatedBy = author?.id || null;
    n.updatedByName = author?.name || 'Unknown device';
    this._changed({ type: 'note', note: n });
    return n;
  }

  deleteNote(id) {
    const n = this.getNote(id);
    this.db.notes = this.db.notes.filter((x) => x.id !== id);
    this._changed({ type: 'note-remove', id, groupId: n.groupId });
  }

  // ── groups ───────────────────────────────────────────────────
  get defaultGroupId() {
    return DEFAULT_GROUP;
  }

  listGroups() {
    return this.db.groups;
  }

  getGroup(id) {
    const g = this.db.groups.find((x) => x.id === id);
    if (!g) throw new ValidationError('Group not found.', 404);
    return g;
  }

  createGroup(name, access = 'members', password) {
    if (this.db.groups.length >= MAX_GROUPS) throw new ValidationError(`Too many groups (max ${MAX_GROUPS}).`, 409);
    if (access !== undefined && !ACCESS.includes(access)) throw new ValidationError('Access must be "all", "password" or "members".');
    const g = {
      id: `grp_${newId()}`,
      name: cleanName(name),
      access: access || 'members',
      members: [],
      createdAt: now(),
    };
    if (g.access === 'password') {
      if (!password) throw new ValidationError('Set a password for this group.');
      g.passwordHash = hashGroupPassword(password);
    }
    this.db.groups.push(g);
    this._create('General', g.id);
    this._changed({ type: 'groups' });
    return g;
  }

  /**
   * @param members device ids (replaces the list); unknown ids are ignored
   * @param password new password (password groups); existing members stay members
   */
  updateGroup(id, { name, access, members, password }) {
    const g = this.getGroup(id);
    if (access !== undefined && !ACCESS.includes(access)) throw new ValidationError('Access must be "all", "password" or "members".');
    if (id === DEFAULT_GROUP && access !== undefined && access !== 'all') throw new ValidationError('The Everyone group is always visible to every device.');
    const nextAccess = access ?? g.access;
    if (nextAccess === 'password' && !password && !g.passwordHash) throw new ValidationError('Set a password for this group.');
    if (password && nextAccess !== 'password') throw new ValidationError('Only password groups have a password.');
    // Validate everything before changing anything.
    const hash = password ? hashGroupPassword(password) : null;
    if (name !== undefined) g.name = cleanName(name);
    g.access = nextAccess;
    if (hash) g.passwordHash = hash;
    if (g.access !== 'password') delete g.passwordHash;
    if (members !== undefined) {
      if (!Array.isArray(members)) throw new ValidationError('Members must be a list of device ids.');
      const known = new Set(this.db.devices.map((d) => d.id));
      g.members = [...new Set(members.filter((m) => typeof m === 'string' && known.has(m)))];
    }
    this._changed({ type: 'groups' });
    return g;
  }

  addMember(groupId, deviceId) {
    const g = this.getGroup(groupId);
    if (!g.members.includes(deviceId)) {
      g.members.push(deviceId);
      this._changed({ type: 'groups' });
    }
    return g;
  }

  /** True when [password] is this password group's password. */
  checkGroupPassword(groupId, password) {
    const g = this.getGroup(groupId);
    return g.access === 'password' && checkGroupPassword(g.passwordHash, password);
  }

  removeMember(groupId, deviceId) {
    const g = this.getGroup(groupId);
    if (g.members.includes(deviceId)) {
      g.members = g.members.filter((m) => m !== deviceId);
      this._changed({ type: 'groups' });
    }
    return g;
  }

  /** Deletes the group with all its clipboards (and files) and shared notes. */
  deleteGroup(id) {
    if (id === DEFAULT_GROUP) throw new ValidationError("The Everyone group can't be deleted.");
    this.getGroup(id);
    for (const c of this.db.clipboards.filter((x) => x.groupId === id)) this._removeFiles(c.items);
    this.db.clipboards = this.db.clipboards.filter((x) => x.groupId !== id);
    this.db.notes = this.db.notes.filter((x) => x.groupId !== id);
    this.db.groups = this.db.groups.filter((x) => x.id !== id);
    this._changed({ type: 'groups' });
  }

  // ── queries ──────────────────────────────────────────────────
  /**
   * State for one device: the groups it may list, and the clipboards and notes of the groups it
   * may open (a password group it hasn't joined is listed, but its content isn't included).
   */
  snapshot(canListGroup = () => true, canOpenGroup = canListGroup) {
    const groups = this.db.groups.filter(canListGroup);
    const ids = new Set(this.db.groups.filter(canOpenGroup).map((g) => g.id));
    return {
      rev: this.rev,
      boot: this.boot,
      groups,
      clipboards: this.db.clipboards.filter((c) => ids.has(c.groupId)),
      notes: this.db.notes.filter((n) => ids.has(n.groupId)),
    };
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
  _create(name, groupId) {
    const t = now();
    const c = { id: newId(), name: cleanName(name), groupId, createdAt: t, updatedAt: t, items: [] };
    this.db.clipboards.push(c);
    return c;
  }

  createClipboard(name, groupId = DEFAULT_GROUP) {
    if (this.db.clipboards.length >= MAX_CLIPBOARDS) throw new ValidationError('Too many clipboards.');
    this.getGroup(groupId);
    const c = this._create(name, groupId);
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
    // Every group keeps at least one clipboard.
    if (!this.db.clipboards.some((x) => x.groupId === c.groupId)) {
      const fresh = this._create('General', c.groupId);
      this._changed({ type: 'clipboard', clipboard: fresh });
    }
    this._changed({ type: 'remove', id, groupId: c.groupId });
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

module.exports = { Store, ValidationError, SchemaError, newId, SCHEMA_VERSION, DEFAULT_GROUP };
