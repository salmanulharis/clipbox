'use strict';
/*
 * Private notes storage — lives ONLY in this browser.
 *
 * PRIVACY RULE: this file must never contain network code (no fetch, XHR,
 * EventSource, WebSocket, beacons or dynamic imports). The test suite fails
 * the build if it does. The only ways a private note can leave the device are
 * explicit user actions in the UI: Copy, Export, or "Share…" (which creates a
 * separate shared note after a confirmation).
 *
 * Storage: IndexedDB (preferred) → localStorage (fallback) → memory (last
 * resort, e.g. some private-browsing modes; data is lost when the tab closes).
 *
 * Optional passphrase lock: note contents (title, body, tags) are encrypted with
 * AES-256-GCM using a key derived from the passphrase (PBKDF2-SHA256). The key
 * only lives in memory while unlocked. Only ids, timestamps and the pinned /
 * trashed flags stay readable, so trash cleanup works while locked.
 *
 * Backups: plain JSON, or encrypted ".cbx" files in the same format as the
 * .cbx format ("CBX1" | uint32 iterations | 16-byte salt | 12-byte IV |
 * AES-GCM ciphertext), so encrypted backups move freely between browsers.
 */
const PrivateStore = (() => {
  const DB_NAME = 'clipbox-private';
  const DB_VERSION = 1;
  const LS_KEY = 'clipbox.private.v1';
  const TRASH_MS = 30 * 24 * 60 * 60 * 1000;
  const MAX_TITLE = 200;
  const MAX_BODY = 1024 * 1024;
  const MAX_TAGS = 20;
  const LOCK_ITERATIONS = 600000;
  const BACKUP_ITERATIONS = 310000; // PBKDF2-SHA256 iterations for new backups
  const MAGIC = [0x43, 0x42, 0x58, 0x31]; // "CBX1"

  let backend = null; // 'idb' | 'local' | 'memory'
  let idb = null;
  let mem = { notes: {}, meta: {} };
  let key = null; // CryptoKey while unlocked
  let lockMeta = null; // { v, salt, iterations, check } when a passphrase is set
  const listeners = new Set();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('clipbox-private') : null;
  if (channel) {
    channel.onmessage = async () => {
      const before = lockMeta?.salt;
      await loadLockMeta();
      if (!lockMeta || lockMeta.salt !== before) key = null; // lock removed or passphrase changed elsewhere
      listeners.forEach((fn) => fn({ external: true }));
    };
  }

  class LockedError extends Error {
    constructor() { super('Private notes are locked.'); this.name = 'LockedError'; }
  }
  class PassphraseRequired extends Error {
    constructor() { super('This backup is encrypted. Enter its passphrase.'); this.name = 'PassphraseRequired'; }
  }

  const now = () => Date.now();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const newId = () => {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return `p_${Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 18)}`;
  };
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const toB64 = (bytes) => {
    const u = new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  // ── backends ────────────────────────────────────────────────
  const reqP = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const txDone = (t) => new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });

  function openIdb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }

  function lsRead() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || { notes: {}, meta: {} }; } catch { return { notes: {}, meta: {} }; }
  }
  function lsWrite(data) {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  }

  /** Raw stored records (possibly encrypted). */
  async function allRecords() {
    if (backend === 'idb') return reqP(idb.transaction('notes').objectStore('notes').getAll());
    const data = backend === 'local' ? lsRead() : mem;
    return Object.values(data.notes);
  }

  async function putRecords(records) {
    if (backend === 'idb') {
      const t = idb.transaction('notes', 'readwrite');
      const s = t.objectStore('notes');
      records.forEach((n) => s.put(n));
      return txDone(t);
    }
    const data = backend === 'local' ? lsRead() : mem;
    records.forEach((n) => { data.notes[n.id] = n; });
    if (backend === 'local') lsWrite(data);
  }

  async function removeRecords(ids) {
    if (backend === 'idb') {
      const t = idb.transaction('notes', 'readwrite');
      const s = t.objectStore('notes');
      ids.forEach((id) => s.delete(id));
      return txDone(t);
    }
    const data = backend === 'local' ? lsRead() : mem;
    ids.forEach((id) => delete data.notes[id]);
    if (backend === 'local') lsWrite(data);
  }

  /** Replace every record and the lock settings in one atomic step (enable/disable/change lock). */
  async function rewriteAll(records, newLockMeta) {
    if (backend === 'idb') {
      const t = idb.transaction(['notes', 'meta'], 'readwrite');
      const notes = t.objectStore('notes');
      notes.clear();
      records.forEach((r) => notes.put(r));
      if (newLockMeta) t.objectStore('meta').put({ key: 'lock', value: newLockMeta });
      else t.objectStore('meta').delete('lock');
      return txDone(t);
    }
    const data = backend === 'local' ? lsRead() : mem;
    data.notes = Object.fromEntries(records.map((r) => [r.id, r]));
    if (newLockMeta) data.meta.lock = newLockMeta; else delete data.meta.lock;
    if (backend === 'local') lsWrite(data);
  }

  async function getMeta(k) {
    if (backend === 'idb') return (await reqP(idb.transaction('meta').objectStore('meta').get(k)))?.value;
    return (backend === 'local' ? lsRead() : mem).meta[k];
  }

  async function setMeta(k, value) {
    if (backend === 'idb') {
      const t = idb.transaction('meta', 'readwrite');
      t.objectStore('meta').put({ key: k, value });
      return txDone(t);
    }
    const data = backend === 'local' ? lsRead() : mem;
    data.meta[k] = value;
    if (backend === 'local') lsWrite(data);
  }

  async function loadLockMeta() {
    lockMeta = (await getMeta('lock')) || null;
  }

  // ── crypto ──────────────────────────────────────────────────
  async function deriveKey(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async function seal(k, obj) {
    const iv = rand(12);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify(obj)));
    return { iv: toB64(iv), data: toB64(data) };
  }

  async function unseal(k, box) {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, k, fromB64(box.data));
    return JSON.parse(dec.decode(plain));
  }

  /** Note → stored record (encrypted contents when a lock is set). */
  async function encode(n, withKey = key, meta = lockMeta) {
    if (!meta) return n;
    if (!withKey) throw new LockedError();
    const { title, body, tags, ...rest } = n;
    return { ...rest, enc: await seal(withKey, { title, body, tags }) };
  }

  /** Stored record → note (requires the key for encrypted records). */
  async function decode(r) {
    if (!r.enc) return r;
    if (!key) throw new LockedError();
    const { enc: box, ...rest } = r;
    return { ...rest, ...(await unseal(key, box)) };
  }

  async function allNotes() {
    const recs = await allRecords();
    return Promise.all(recs.map(decode));
  }

  // ── validation ──────────────────────────────────────────────
  function clean(n) {
    const tags = Array.isArray(n.tags) ? n.tags : [];
    const seen = new Set();
    return {
      id: typeof n.id === 'string' && /^p_[\w-]{4,40}$/.test(n.id) ? n.id : newId(),
      title: String(n.title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE),
      body: String(n.body ?? '').slice(0, MAX_BODY),
      tags: tags
        .map((t) => String(t).replace(/^#+/, '').replace(/\s+/g, '-').trim().slice(0, 30))
        .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
        .slice(0, MAX_TAGS),
      pinned: Boolean(n.pinned),
      createdAt: Number(n.createdAt) || now(),
      updatedAt: Number(n.updatedAt) || now(),
      deletedAt: n.deletedAt ? Number(n.deletedAt) : null,
    };
  }

  function notify() {
    listeners.forEach((fn) => fn({ external: false }));
    if (channel) channel.postMessage('changed');
  }

  // ── public API ──────────────────────────────────────────────
  async function init() {
    try {
      idb = await openIdb();
      backend = 'idb';
    } catch {
      try {
        localStorage.setItem('clipbox.private.probe', '1');
        localStorage.removeItem('clipbox.private.probe');
        backend = 'local';
      } catch {
        backend = 'memory';
      }
    }
    await loadLockMeta();
    await purgeTrash();
    return backend;
  }

  /** 'off' (no passphrase), 'locked', or 'unlocked'. */
  function lockState() {
    if (!lockMeta) return 'off';
    return key ? 'unlocked' : 'locked';
  }

  async function list() {
    if (lockState() === 'locked') {
      const recs = await allRecords();
      return { locked: true, active: [], trash: [], counts: { active: recs.filter((r) => !r.deletedAt).length, trash: recs.filter((r) => r.deletedAt).length } };
    }
    const notes = await allNotes();
    return { locked: false, active: notes.filter((n) => !n.deletedAt), trash: notes.filter((n) => n.deletedAt) };
  }

  async function get(id) {
    const r = (await allRecords()).find((x) => x.id === id);
    return r ? decode(r) : null;
  }

  async function create(fields) {
    const t = now();
    const note = clean({ ...fields, id: newId(), createdAt: t, updatedAt: t, deletedAt: null });
    await putRecords([await encode(note)]);
    notify();
    return note;
  }

  async function update(id, patch) {
    const n = await get(id);
    if (!n) throw new Error('Private note not found.');
    const note = clean({ ...n, ...patch, id, createdAt: n.createdAt, updatedAt: now() });
    await putRecords([await encode(note)]);
    notify();
    return note;
  }

  /** Trash/restore only touch the readable deletedAt flag, so they work while locked too. */
  async function setDeleted(id, at) {
    const r = (await allRecords()).find((x) => x.id === id);
    if (!r) return;
    await putRecords([{ ...r, deletedAt: at }]);
    notify();
  }

  const trash = (id) => setDeleted(id, now());
  const restore = (id) => setDeleted(id, null);

  async function destroy(id) {
    await removeRecords([id]);
    notify();
  }

  async function emptyTrash() {
    const recs = (await allRecords()).filter((r) => r.deletedAt);
    await removeRecords(recs.map((r) => r.id));
    notify();
    return recs.length;
  }

  async function purgeTrash() {
    const cutoff = now() - TRASH_MS;
    const old = (await allRecords()).filter((r) => r.deletedAt && r.deletedAt < cutoff);
    if (old.length) await removeRecords(old.map((r) => r.id));
  }

  // ── passphrase lock ─────────────────────────────────────────
  async function newLock(passphrase) {
    const salt = rand(16);
    const k = await deriveKey(passphrase, salt, LOCK_ITERATIONS);
    const meta = { v: 1, salt: toB64(salt), iterations: LOCK_ITERATIONS, check: await seal(k, { ok: 'clipbox' }) };
    return { k, meta };
  }

  /** Turn on the lock: every note is re-encrypted with a key derived from the passphrase. */
  async function enableLock(passphrase) {
    if (lockMeta) throw new Error('A passphrase is already set.');
    const notes = await allNotes();
    const { k, meta } = await newLock(passphrase);
    const records = await Promise.all(notes.map((n) => encode(n, k, meta)));
    await rewriteAll(records, meta);
    lockMeta = meta;
    key = k;
    notify();
  }

  /** @returns true when the passphrase is correct. */
  async function unlock(passphrase) {
    if (!lockMeta) return true;
    const k = await deriveKey(passphrase, fromB64(lockMeta.salt), lockMeta.iterations);
    try {
      const c = await unseal(k, lockMeta.check);
      if (c.ok !== 'clipbox') return false;
    } catch {
      return false;
    }
    key = k;
    listeners.forEach((fn) => fn({ external: false }));
    return true;
  }

  function lock() {
    if (!lockMeta || !key) return;
    key = null;
    listeners.forEach((fn) => fn({ external: false }));
  }

  async function changePassphrase(passphrase) {
    if (lockState() !== 'unlocked') throw new LockedError();
    const notes = await allNotes();
    const { k, meta } = await newLock(passphrase);
    await rewriteAll(await Promise.all(notes.map((n) => encode(n, k, meta))), meta);
    lockMeta = meta;
    key = k;
    notify();
  }

  async function disableLock() {
    if (lockState() !== 'unlocked') throw new LockedError();
    const notes = await allNotes();
    await rewriteAll(notes, null);
    lockMeta = null;
    key = null;
    notify();
  }

  // ── backups ─────────────────────────────────────────────────
  async function backupObject() {
    if (lockState() === 'locked') throw new LockedError();
    return { app: 'clipbox', kind: 'private-notes', format: 1, exportedAt: new Date().toISOString(), notes: await allNotes() };
  }

  /** Plain JSON backup of every private note (including trash). */
  async function exportData() {
    const data = await backupObject();
    await setMeta('lastExportAt', now());
    return data;
  }

  /** Encrypted .cbx backup. */
  async function exportEncrypted(passphrase, iterations = BACKUP_ITERATIONS) {
    const data = await backupObject();
    const salt = rand(16);
    const iv = rand(12);
    const k = await deriveKey(passphrase, salt, iterations);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify(data))));
    const out = new Uint8Array(4 + 4 + 16 + 12 + ct.length);
    out.set(MAGIC, 0);
    new DataView(out.buffer).setUint32(4, iterations); // big-endian, like Java's ByteBuffer
    out.set(salt, 8);
    out.set(iv, 24);
    out.set(ct, 36);
    await setMeta('lastExportAt', now());
    return { bytes: out, count: data.notes.length };
  }

  const isEncryptedBackup = (bytes) => bytes.length > 36 && MAGIC.every((b, i) => bytes[i] === b);

  async function decryptBackup(bytes, passphrase) {
    const iterations = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4);
    if (iterations < 1000 || iterations > 5000000) throw new Error('This backup file is damaged.');
    const k = await deriveKey(passphrase, bytes.slice(8, 24), iterations);
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(24, 36) }, k, bytes.slice(36));
      return JSON.parse(dec.decode(plain));
    } catch {
      throw new Error('Wrong passphrase, or the file is damaged.');
    }
  }

  /** Merge a backup: unknown ids are added, known ids keep whichever copy is newer. */
  async function importData(data) {
    if (!data || data.app !== 'clipbox' || data.kind !== 'private-notes' || !Array.isArray(data.notes)) {
      throw new Error('This file is not a ClipBox private-notes backup.');
    }
    if (lockState() === 'locked') throw new LockedError();
    const existing = new Map((await allNotes()).map((n) => [n.id, n]));
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const toPut = [];
    for (const raw of data.notes) {
      if (!raw || typeof raw !== 'object') { skipped++; continue; }
      const n = clean(raw);
      if (!n.title && !n.body.trim()) { skipped++; continue; }
      const cur = existing.get(n.id);
      if (!cur) { added++; toPut.push(n); } else if (n.updatedAt > cur.updatedAt) { updated++; toPut.push(n); } else skipped++;
    }
    await putRecords(await Promise.all(toPut.map((n) => encode(n))));
    if (toPut.length) notify();
    return { added, updated, skipped };
  }

  /** Import a backup file (plain JSON or encrypted .cbx). */
  async function importFile(bytes, passphrase) {
    if (isEncryptedBackup(bytes)) {
      if (!passphrase) throw new PassphraseRequired();
      return importData(await decryptBackup(bytes, passphrase));
    }
    let data;
    try {
      data = JSON.parse(dec.decode(bytes));
    } catch {
      throw new Error('This file is not a ClipBox private-notes backup.');
    }
    return importData(data);
  }

  /** Ask the browser not to evict our storage under pressure. */
  async function requestPersist() {
    try {
      if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
      return Boolean(await navigator.storage?.persist?.());
    } catch {
      return false;
    }
  }

  return {
    init,
    get backend() { return backend; },
    lockState,
    enableLock,
    unlock,
    lock,
    changePassphrase,
    disableLock,
    list,
    get,
    create,
    update,
    trash,
    restore,
    destroy,
    emptyTrash,
    exportData,
    exportEncrypted,
    importData,
    importFile,
    isEncryptedBackup,
    getMeta,
    setMeta,
    requestPersist,
    LockedError,
    PassphraseRequired,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
