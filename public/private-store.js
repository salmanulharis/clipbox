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
 */
const PrivateStore = (() => {
  const DB_NAME = 'clipbox-private';
  const DB_VERSION = 1;
  const LS_KEY = 'clipbox.private.v1';
  const TRASH_MS = 30 * 24 * 60 * 60 * 1000;
  const MAX_TITLE = 200;
  const MAX_BODY = 1024 * 1024;
  const MAX_TAGS = 20;

  let backend = null; // 'idb' | 'local' | 'memory'
  let idb = null;
  let mem = { notes: {}, meta: {} };
  const listeners = new Set();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('clipbox-private') : null;
  if (channel) channel.onmessage = () => listeners.forEach((fn) => fn({ external: true }));

  const now = () => Date.now();
  const newId = () => {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return `p_${Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 18)}`;
  };

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

  async function allNotes() {
    if (backend === 'idb') return reqP(idb.transaction('notes').objectStore('notes').getAll());
    const data = backend === 'local' ? lsRead() : mem;
    return Object.values(data.notes);
  }

  async function putNotes(notes) {
    if (backend === 'idb') {
      const t = idb.transaction('notes', 'readwrite');
      const s = t.objectStore('notes');
      notes.forEach((n) => s.put(n));
      return txDone(t);
    }
    const data = backend === 'local' ? lsRead() : mem;
    notes.forEach((n) => { data.notes[n.id] = n; });
    if (backend === 'local') lsWrite(data);
  }

  async function removeNotes(ids) {
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

  async function getMeta(key) {
    if (backend === 'idb') return (await reqP(idb.transaction('meta').objectStore('meta').get(key)))?.value;
    return (backend === 'local' ? lsRead() : mem).meta[key];
  }

  async function setMeta(key, value) {
    if (backend === 'idb') {
      const t = idb.transaction('meta', 'readwrite');
      t.objectStore('meta').put({ key, value });
      return txDone(t);
    }
    const data = backend === 'local' ? lsRead() : mem;
    data.meta[key] = value;
    if (backend === 'local') lsWrite(data);
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
    await purgeTrash();
    return backend;
  }

  async function list() {
    const notes = await allNotes();
    return { active: notes.filter((n) => !n.deletedAt), trash: notes.filter((n) => n.deletedAt) };
  }

  async function get(id) {
    return (await allNotes()).find((n) => n.id === id) || null;
  }

  async function create(fields) {
    const t = now();
    const note = clean({ ...fields, id: newId(), createdAt: t, updatedAt: t, deletedAt: null });
    await putNotes([note]);
    notify();
    return note;
  }

  async function update(id, patch) {
    const n = await get(id);
    if (!n) throw new Error('Private note not found.');
    const note = clean({ ...n, ...patch, id, createdAt: n.createdAt, updatedAt: now() });
    await putNotes([note]);
    notify();
    return note;
  }

  async function trash(id) {
    const n = await get(id);
    if (!n) return;
    await putNotes([{ ...n, deletedAt: now() }]);
    notify();
  }

  async function restore(id) {
    const n = await get(id);
    if (!n) return;
    await putNotes([{ ...n, deletedAt: null }]);
    notify();
  }

  async function destroy(id) {
    await removeNotes([id]);
    notify();
  }

  async function emptyTrash() {
    const { trash: t } = await list();
    await removeNotes(t.map((n) => n.id));
    notify();
    return t.length;
  }

  async function purgeTrash() {
    const cutoff = now() - TRASH_MS;
    const old = (await allNotes()).filter((n) => n.deletedAt && n.deletedAt < cutoff);
    if (old.length) await removeNotes(old.map((n) => n.id));
  }

  /** Plain JSON backup of every private note (including trash). */
  async function exportData() {
    const notes = await allNotes();
    await setMeta('lastExportAt', now());
    return { app: 'clipbox', kind: 'private-notes', format: 1, exportedAt: new Date().toISOString(), notes };
  }

  /** Merge a backup: unknown ids are added, known ids keep whichever copy is newer. */
  async function importData(data) {
    if (!data || data.app !== 'clipbox' || data.kind !== 'private-notes' || !Array.isArray(data.notes)) {
      throw new Error('This file is not a ClipBox private-notes backup.');
    }
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
    await putNotes(toPut);
    if (toPut.length) notify();
    return { added, updated, skipped };
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
    list,
    get,
    create,
    update,
    trash,
    restore,
    destroy,
    emptyTrash,
    exportData,
    importData,
    getMeta,
    setMeta,
    requestPersist,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
