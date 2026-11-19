'use strict';
/* ClipBox client — vanilla JS, no build step. */

// ── tiny helpers ─────────────────────────────────────────────
const $ = (sel, el = document) => el.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const ICONS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  eraser: '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L12 21"/><path d="M22 21H7M5 11l9 9"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  paste: '<path d="M9 4h6v3H9z"/><path d="M15 5h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h3M9 13h6M9 17h4"/>',
  attach: '<path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8L13.2 3.2a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6L15 6.6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 0 0 0 20c.9 0 1.6-.7 1.6-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.7 1.7-1.7h2c3 0 5.5-2.5 5.5-5.5C22 6 17.5 2 12 2z"/>',
};
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const hydrateIcons = (root = document) => root.querySelectorAll('i[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 604800) return `${Math.round(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}
const isUrl = (s) => /^https?:\/\/\S+$/i.test(s.trim());
const isImage = (item) => item.type === 'file' && /^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(item.mime);

// ── state ────────────────────────────────────────────────────
const state = {
  clipboards: [],
  rev: 0,
  boot: null,
  server: null,
  session: null,
  activeId: store.get('clipbox.active'),
  editing: null,
  loaded: false,
};
const active = () => state.clipboards.find((c) => c.id === state.activeId) || state.clipboards[0] || null;

// ── toasts ───────────────────────────────────────────────────
function toast(message, kind = 'ok', ms = 2200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'error' ? 'x' : 'check')}<span></span>`;
  el.querySelector('span').textContent = message;
  $('#toasts').append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

// ── API ──────────────────────────────────────────────────────
class ApiError extends Error {
  constructor(message, status, reason) { super(message); this.status = status; this.reason = reason; }
}

async function api(method, url, body) {
  const headers = { 'X-ClipBox': '1' };
  let payload;
  if (body instanceof Blob) {
    payload = body;
    headers['Content-Type'] = body.type || 'application/octet-stream';
    headers['X-Filename'] = encodeURIComponent(body.name || 'file');
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection.', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 || (res.status === 403 && data?.reason === 'no_password')) {
    showLogin(data?.reason);
    throw new ApiError(data?.error || 'Login required.', res.status, data?.reason);
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status}).`, res.status);
  return data;
}

/** Run an action, showing an error toast on failure. Returns undefined on error. */
async function attempt(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r ?? true;
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error', 3500);
    return undefined;
  }
}

// ── clipboard helpers (copy / read) ──────────────────────────
async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  }
  // Fallback for plain-http LAN access, where the async Clipboard API is unavailable.
  const host = document.querySelector('dialog[open]') || document.body;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  Object.assign(ta.style, { position: 'fixed', top: '0', left: '0', opacity: '0', pointerEvents: 'none' });
  host.append(ta);
  ta.focus({ preventScroll: true });
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function toPng(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(img.src);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('convert failed'))), 'image/png');
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

async function copyImage(item) {
  if (!(window.isSecureContext && window.ClipboardItem && navigator.clipboard?.write)) return false;
  try {
    const blob = fetch(`/files/${item.id}`).then((r) => r.blob()).then((b) => (b.type === 'image/png' ? b : toPng(b)));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}

function download(item) {
  const a = document.createElement('a');
  a.href = `/files/${item.id}?download`;
  a.download = item.name;
  document.body.append(a);
  a.click();
  a.remove();
}

function flashButton(btn) {
  if (!btn) return;
  const prev = btn.innerHTML;
  btn.classList.add('done');
  const svg = btn.querySelector('svg');
  if (svg) svg.outerHTML = icon('check');
  setTimeout(() => { btn.innerHTML = prev; btn.classList.remove('done'); }, 1200);
}

async function copyItem(item, btn) {
  if (item.type === 'text') {
    if (await copyText(item.text)) { flashButton(btn); toast('Copied to clipboard'); }
    else toast('Copy failed — select the text and copy manually.', 'error', 3500);
  } else if (isImage(item) && (await copyImage(item))) {
    flashButton(btn);
    toast('Image copied');
  } else {
    download(item);
    toast(isImage(item) ? 'Image copy needs HTTPS — downloading instead' : 'Downloading file');
  }
}

// ── rendering ────────────────────────────────────────────────
const itemEls = new Map(); // id -> { key, el }

function render() {
  const cb = active();
  if (cb && cb.id !== state.activeId) state.activeId = cb.id;
  renderBoards();
  renderMain(cb);
}

function renderBoards() {
  const list = $('#board-list');
  list.replaceChildren(...state.clipboards.map((c) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = `board${c.id === state.activeId ? ' active' : ''}`;
    b.innerHTML = '<span class="board-label"></span><span class="board-count"></span>';
    b.querySelector('.board-label').textContent = c.name;
    b.querySelector('.board-count').textContent = c.items.length || '';
    b.addEventListener('click', () => setActive(c.id));
    if (c.id === state.activeId) b.setAttribute('aria-current', 'true');
    li.append(b);
    return li;
  }));
  const current = list.querySelector('.board.active');
  if (current && window.matchMedia('(max-width: 760px)').matches) current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderMain(cb) {
  $('#board-name').textContent = cb ? cb.name : '';
  const n = cb ? cb.items.length : 0;
  $('#board-count').textContent = `${n} item${n === 1 ? '' : 's'}`;
  document.title = cb ? `${cb.name} · ClipBox` : 'ClipBox';
  $('#btn-copy-all').disabled = !cb || !cb.items.some((i) => i.type === 'text');
  $('#btn-clear').disabled = !n;
  $('#empty').hidden = n > 0;
  renderItems(cb ? cb.items : []);
}

function renderItems(items) {
  const list = $('#items');
  const seen = new Set();
  const els = items.map((item) => {
    seen.add(item.id);
    const existing = itemEls.get(item.id);
    if (existing && (state.editing === item.id || existing.key === item.updatedAt)) return existing.el;
    const el = buildItem(item);
    if (state.loaded && !existing) el.classList.add('fresh');
    itemEls.set(item.id, { key: item.updatedAt, el });
    return el;
  });
  for (const id of [...itemEls.keys()]) if (!seen.has(id)) itemEls.delete(id);
  if (state.editing && !seen.has(state.editing)) {
    state.editing = null;
    toast('The item you were editing was removed on another device.', 'error', 3500);
  }
  // Keyed reconcile: move nodes only when necessary so focus/selection survive.
  let prev = null;
  for (const el of els) {
    const want = prev ? prev.nextSibling : list.firstChild;
    if (want !== el) list.insertBefore(el, want);
    prev = el;
  }
  let extra = prev ? prev.nextSibling : list.firstChild;
  while (extra) { const next = extra.nextSibling; extra.remove(); extra = next; }
  requestAnimationFrame(() => list.querySelectorAll('.item-text:not(.measured)').forEach(measureClamp));
}

function measureClamp(pre) {
  pre.classList.add('measured');
  if (pre.scrollHeight > pre.clientHeight + 4) {
    pre.classList.add('clamped');
    const more = document.createElement('button');
    more.className = 'more';
    more.innerHTML = `<span>Show more</span>${icon('chevron')}`;
    more.addEventListener('click', () => {
      const open = pre.classList.toggle('expanded');
      more.classList.toggle('open', open);
      more.querySelector('span').textContent = open ? 'Show less' : 'Show more';
    });
    pre.after(more);
  }
}

function buildItem(item) {
  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.id = item.id;

  const body = document.createElement('div');
  body.className = 'item-body';
  let meta;
  if (item.type === 'text') {
    const pre = document.createElement('pre');
    pre.className = 'item-text';
    if (isUrl(item.text)) {
      const a = document.createElement('a');
      a.href = item.text.trim();
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = item.text;
      pre.append(a);
    } else pre.textContent = item.text;
    body.append(pre);
    const chars = [...item.text].length;
    meta = `${chars.toLocaleString()} char${chars === 1 ? '' : 's'}`;
  } else if (isImage(item)) {
    const a = document.createElement('a');
    a.href = `/files/${item.id}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'thumb';
    const img = document.createElement('img');
    img.src = `/files/${item.id}`;
    img.alt = item.name;
    img.loading = 'lazy';
    a.append(img);
    body.append(a);
    meta = `${item.name} · ${fmtBytes(item.size)}`;
  } else {
    const f = document.createElement('div');
    f.className = 'file-row';
    f.innerHTML = `${icon('file')}<span class="file-name"></span>`;
    f.querySelector('.file-name').textContent = item.name;
    body.append(f);
    meta = fmtBytes(item.size);
  }

  const foot = document.createElement('div');
  foot.className = 'item-meta';
  foot.innerHTML = `<span class="ago" data-ts="${item.createdAt}">${timeAgo(item.createdAt)}</span><span class="dot">·</span><span class="meta-extra"></span>${item.updatedAt !== item.createdAt ? '<span class="dot">·</span><span>edited</span>' : ''}`;
  foot.querySelector('.meta-extra').textContent = meta;

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  const copyLabel = item.type === 'text' || isImage(item) ? 'Copy' : 'Download';
  actions.innerHTML = `
    <button class="icon-btn copy" data-act="copy" data-tip="${copyLabel}" aria-label="${copyLabel}">${icon(copyLabel === 'Copy' ? 'copy' : 'download')}</button>
    ${item.type === 'text' ? `<button class="icon-btn" data-act="edit" data-tip="Edit" aria-label="Edit">${icon('edit')}</button>` : ''}
    ${item.type === 'file' && copyLabel === 'Copy' ? `<button class="icon-btn" data-act="download" data-tip="Download" aria-label="Download">${icon('download')}</button>` : ''}
    <button class="icon-btn danger" data-act="delete" data-tip="Delete" aria-label="Delete">${icon('trash')}</button>`;

  actions.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const current = findItem(item.id) || item;
    if (btn.dataset.act === 'copy') copyItem(current, btn);
    else if (btn.dataset.act === 'edit') startEdit(current.id);
    else if (btn.dataset.act === 'download') download(current);
    else if (btn.dataset.act === 'delete') deleteItem(current.id);
  });

  li.append(body, actions, foot);
  return li;
}

function findItem(id) {
  for (const c of state.clipboards) {
    const i = c.items.find((x) => x.id === id);
    if (i) return i;
  }
  return null;
}

setInterval(() => document.querySelectorAll('.ago[data-ts]').forEach((el) => { el.textContent = timeAgo(Number(el.dataset.ts)); }), 30000);

// ── editing ──────────────────────────────────────────────────
function startEdit(id) {
  if (state.editing && state.editing !== id) cancelEdit();
  const entry = itemEls.get(id);
  const item = findItem(id);
  if (!entry || !item) return;
  state.editing = id;
  const li = entry.el;
  li.classList.add('editing');
  const form = document.createElement('form');
  form.className = 'edit-form';
  form.innerHTML = `<textarea aria-label="Edit item"></textarea>
    <div class="row"><span class="hint hide-touch">Ctrl+Enter to save · Esc to cancel</span><div class="spacer"></div>
    <button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>`;
  const ta = form.querySelector('textarea');
  ta.value = item.text;
  li.querySelector('.item-body').hidden = true;
  li.querySelector('.item-actions').hidden = true;
  li.prepend(form);
  autosize(ta);
  ta.addEventListener('input', () => autosize(ta));
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  form.querySelector('[data-cancel]').addEventListener('click', cancelEdit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cb = state.clipboards.find((c) => c.items.some((i) => i.id === id));
    if (!cb) return cancelEdit();
    if (!ta.value.trim()) return toast('Text cannot be empty — delete the item instead.', 'error', 3000);
    const saved = await attempt(() => api('PATCH', `/api/clipboards/${cb.id}/items/${id}`, { text: ta.value }), 'Saved');
    if (saved) {
      upsertItem(cb.id, saved);
      cancelEdit();
    }
  });
}

function cancelEdit() {
  const id = state.editing;
  state.editing = null;
  const entry = id && itemEls.get(id);
  if (entry) entry.key = -1; // force rebuild with latest data
  render();
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight + 2, window.innerHeight * 0.6)}px`;
}

// ── state updates ────────────────────────────────────────────
function applySnapshot(data) {
  state.clipboards = data.clipboards;
  state.rev = data.rev;
  state.boot = data.boot;
  render();
}

function upsertClipboard(cb, order) {
  const i = state.clipboards.findIndex((c) => c.id === cb.id);
  if (i >= 0) state.clipboards[i] = cb;
  else state.clipboards.push(cb);
  if (order) reorder(order);
}

function reorder(order) {
  const pos = new Map(order.map((id, i) => [id, i]));
  state.clipboards = state.clipboards.filter((c) => pos.has(c.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
}

function upsertItem(clipboardId, item) {
  const cb = state.clipboards.find((c) => c.id === clipboardId);
  if (!cb) return;
  const i = cb.items.findIndex((x) => x.id === item.id);
  if (i >= 0) cb.items[i] = item;
  else cb.items.unshift(item);
  render();
}

function applyEvent(ev) {
  if (ev.boot !== state.boot || ev.rev > state.rev + 1) return loadState(); // restart or missed events
  if (ev.rev <= state.rev) return; // duplicate
  state.rev = ev.rev;
  if (ev.type === 'clipboard') upsertClipboard(ev.clipboard, ev.order);
  else if (ev.type === 'remove') reorder(ev.order);
  render();
}

async function loadState() {
  const data = await api('GET', '/api/state');
  state.server = data.server;
  applySnapshot(data);
  state.loaded = true;
  return data;
}

function setActive(id) {
  if (state.editing) cancelEdit();
  state.activeId = id;
  store.set('clipbox.active', id);
  render();
}

// ── live sync ────────────────────────────────────────────────
const sync = { es: null, mode: 'sse', retry: 0, helloTimer: null, polling: false };

function setStatus(s) {
  const el = $('#status');
  el.className = `status ${s}`;
  const label = { online: 'Live — changes sync instantly', connecting: 'Connecting…', offline: 'Offline — reconnecting…' }[s];
  el.dataset.tip = label;
  el.setAttribute('aria-label', label);
}

function connectSync() {
  if (sync.mode === 'poll') return startPolling();
  if (sync.es) sync.es.close();
  clearTimeout(sync.helloTimer);
  setStatus('connecting');
  const es = new EventSource('/api/events');
  sync.es = es;
  let hello = false;
  // If the "hello" event never arrives, a proxy is buffering the stream → use long-polling.
  sync.helloTimer = setTimeout(() => {
    if (!hello && es.readyState !== EventSource.CLOSED) {
      es.close();
      sync.mode = 'poll';
      startPolling();
    }
  }, 8000);
  es.addEventListener('hello', (e) => {
    hello = true;
    clearTimeout(sync.helloTimer);
    sync.retry = 0;
    setStatus('online');
    const h = JSON.parse(e.data);
    if (h.rev !== state.rev || h.boot !== state.boot) loadState().catch(() => {});
  });
  es.addEventListener('change', (e) => applyEvent(JSON.parse(e.data)));
  es.addEventListener('tunnel', (e) => { if (state.server) state.server.tunnel = JSON.parse(e.data); });
  es.onerror = async () => {
    setStatus('offline');
    if (es.readyState === EventSource.CLOSED) {
      clearTimeout(sync.helloTimer);
      sync.retry += 1;
      await sleep(Math.min(15000, 1000 * 2 ** Math.min(sync.retry, 4)));
      if (sync.es === es) {
        try { await checkSessionAndMaybeLogin(); } catch { /* still offline */ }
        if (sync.es === es && !$('#app').hidden) connectSync();
      }
    }
  };
}

async function startPolling() {
  if (sync.polling) return;
  sync.polling = true;
  while (sync.mode === 'poll' && !$('#app').hidden) {
    try {
      const res = await fetch(`/api/sync?rev=${state.rev}&boot=${encodeURIComponent(state.boot || '')}`, { cache: 'no-store' });
      if (res.status === 401 || res.status === 403) { showLogin(); break; }
      if (!res.ok) throw new Error();
      const data = await res.json();
      setStatus('online');
      if (data.rev !== state.rev || data.boot !== state.boot) applySnapshot(data);
    } catch {
      setStatus('offline');
      await sleep(3000);
    }
  }
  sync.polling = false;
}

function stopSync() {
  if (sync.es) sync.es.close();
  sync.es = null;
  clearTimeout(sync.helloTimer);
}

// Mobile browsers freeze background tabs; resync when coming back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || $('#app').hidden) return;
  loadState().catch(() => {});
  if (sync.mode === 'sse' && (!sync.es || sync.es.readyState === EventSource.CLOSED)) connectSync();
});
window.addEventListener('online', () => { if (!$('#app').hidden && sync.mode === 'sse') connectSync(); });

// ── actions ──────────────────────────────────────────────────
async function addText(text) {
  const cb = active();
  if (!cb || !text.trim()) return false;
  const item = await attempt(() => api('POST', `/api/clipboards/${cb.id}/items`, { text }));
  if (item) { upsertItem(cb.id, item); return true; }
  return false;
}

async function uploadFiles(files) {
  const cb = active();
  if (!cb) return;
  const max = state.server?.maxFileBytes || Infinity;
  for (let file of files) {
    if (file.size > max) { toast(`"${file.name}" is too large (max ${fmtBytes(max)}).`, 'error', 4000); continue; }
    if (!file.size) continue;
    if (!file.name || file.name === 'image.png') {
      const ext = (file.type.split('/')[1] || 'bin').replace('jpeg', 'jpg');
      file = new File([file], `pasted-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${ext}`, { type: file.type });
    }
    const item = await attempt(() => api('POST', `/api/clipboards/${cb.id}/files`, file));
    if (item) { upsertItem(cb.id, item); toast(`Added ${file.name}`); }
  }
}

async function deleteItem(id) {
  const cb = state.clipboards.find((c) => c.items.some((i) => i.id === id));
  if (!cb) return;
  const ok = await attempt(() => api('DELETE', `/api/clipboards/${cb.id}/items/${id}`), 'Item deleted');
  if (ok) { cb.items = cb.items.filter((i) => i.id !== id); render(); }
}

async function newClipboard() {
  const name = await ask({ title: 'New clipboard', placeholder: 'e.g. Work, Links, Phone', ok: 'Create' });
  if (!name) return;
  const cb = await attempt(() => api('POST', '/api/clipboards', { name }));
  if (cb) {
    upsertClipboard(cb);
    setActive(cb.id);
    $('#input').focus();
  }
}

async function renameClipboard() {
  const cb = active();
  if (!cb) return;
  const name = await ask({ title: 'Rename clipboard', value: cb.name, ok: 'Rename' });
  if (!name || name === cb.name) return;
  const updated = await attempt(() => api('PATCH', `/api/clipboards/${cb.id}`, { name }), 'Renamed');
  if (updated) { upsertClipboard(updated); render(); }
}

async function clearClipboard() {
  const cb = active();
  if (!cb || !cb.items.length) return;
  const yes = await confirmDialog({ title: `Clear "${cb.name}"?`, message: `All ${cb.items.length} items will be removed on every device.`, ok: 'Clear', danger: true });
  if (!yes) return;
  const updated = await attempt(() => api('POST', `/api/clipboards/${cb.id}/clear`), 'Clipboard cleared');
  if (updated) { upsertClipboard(updated); render(); }
}

async function deleteClipboard() {
  const cb = active();
  if (!cb) return;
  const yes = await confirmDialog({ title: `Delete "${cb.name}"?`, message: 'The clipboard and all its items will be permanently deleted on every device.', ok: 'Delete', danger: true });
  if (!yes) return;
  const idx = state.clipboards.indexOf(cb);
  const ok = await attempt(() => api('DELETE', `/api/clipboards/${cb.id}`), 'Clipboard deleted');
  if (ok) {
    state.clipboards = state.clipboards.filter((c) => c.id !== cb.id);
    const next = state.clipboards[Math.max(0, idx - 1)];
    if (next) setActive(next.id); else loadState().catch(() => {});
  }
}

async function copyAll(btn) {
  const cb = active();
  if (!cb) return;
  const texts = cb.items.filter((i) => i.type === 'text').map((i) => i.text);
  if (!texts.length) return toast('Nothing to copy', 'error');
  if (await copyText(texts.join('\n'))) {
    flashButton(btn);
    const skipped = cb.items.length - texts.length;
    toast(`Copied ${texts.length} item${texts.length === 1 ? '' : 's'}${skipped ? ` (${skipped} file${skipped === 1 ? '' : 's'} skipped)` : ''}`);
  } else toast('Copy failed — your browser blocked clipboard access.', 'error', 3500);
}

async function pasteFromClipboard() {
  const input = $('#input');
  if (window.isSecureContext && navigator.clipboard?.read) {
    try {
      const items = await navigator.clipboard.read();
      const files = [];
      let text = '';
      for (const ci of items) {
        const img = ci.types.find((t) => t.startsWith('image/'));
        if (img) {
          const blob = await ci.getType(img);
          files.push(new File([blob], '', { type: img }));
        } else if (ci.types.includes('text/plain')) {
          text += await (await ci.getType('text/plain')).text();
        }
      }
      if (files.length) await uploadFiles(files);
      if (text) { if (await addText(text)) toast('Pasted'); }
      if (!files.length && !text) toast('Your clipboard is empty', 'error');
      return;
    } catch { /* fall through to readText */ }
  }
  if (window.isSecureContext && navigator.clipboard?.readText) {
    try {
      const text = await navigator.clipboard.readText();
      if (text && (await addText(text))) toast('Pasted');
      else if (!text) toast('Your clipboard is empty', 'error');
      return;
    } catch { /* permission denied */ }
  }
  input.focus();
  toast(window.isSecureContext ? 'Clipboard access was blocked — press Ctrl+V (or long-press → Paste) in the box.' : 'Direct clipboard access needs HTTPS — long-press the box and choose Paste, or press Ctrl+V.', 'error', 4500);
}

// ── dialogs ──────────────────────────────────────────────────
function openDialog(dlg) {
  if (!dlg.open) dlg.showModal();
}

function ask({ title, value = '', placeholder = '', ok = 'OK', message = '' }) {
  return promptDialog({ title, value, placeholder, ok, message, input: true });
}
function confirmDialog({ title, message, ok = 'OK', danger = false }) {
  return promptDialog({ title, message, ok, danger, input: false });
}
function promptDialog(opts) {
  const dlg = $('#dlg-prompt');
  const input = $('#prompt-input');
  $('#prompt-title').textContent = opts.title;
  $('#prompt-message').textContent = opts.message || '';
  $('#prompt-message').hidden = !opts.message;
  input.hidden = !opts.input;
  input.value = opts.value || '';
  input.placeholder = opts.placeholder || '';
  const okBtn = $('#prompt-ok');
  okBtn.textContent = opts.ok;
  okBtn.classList.toggle('danger-solid', Boolean(opts.danger));
  return new Promise((resolve) => {
    const finish = (val) => {
      cleanup();
      if (dlg.open) dlg.close();
      resolve(val);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      if (opts.input) {
        const v = input.value.trim();
        if (!v) { input.focus(); return; }
        finish(v);
      } else finish(true);
    };
    const onCancel = () => finish(opts.input ? null : false);
    const onClose = () => finish(opts.input ? null : false);
    const cleanup = () => {
      $('#prompt-form').removeEventListener('submit', onSubmit);
      $('#prompt-cancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('close', onClose);
    };
    $('#prompt-form').addEventListener('submit', onSubmit);
    $('#prompt-cancel').addEventListener('click', onCancel);
    dlg.addEventListener('close', onClose);
    openDialog(dlg);
    if (opts.input) { input.focus(); input.select(); } else okBtn.focus();
  });
}

// Close buttons + backdrop click close any dialog
document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close]');
  if (closer) closer.closest('dialog').close();
  if (e.target instanceof HTMLDialogElement) {
    const r = e.target.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) e.target.close();
  }
});

// ── connect (QR) dialog ──────────────────────────────────────
const connect = { urls: [], selected: 0 };

async function openConnect() {
  const dlg = $('#dlg-connect');
  openDialog(dlg);
  $('#connect-urls').replaceChildren();
  $('#connect-url').textContent = 'Loading…';
  $('#connect-qr').removeAttribute('src');
  const data = await attempt(() => api('GET', '/api/connect'));
  if (!data) return dlg.close();
  const urls = data.urls;
  const here = location.origin;
  const isLoopback = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  if (!isLoopback && !urls.some((u) => u.url === here)) {
    const needsToken = state.session?.required && data.token;
    urls.push({ kind: 'current', label: 'This address', url: here, link: needsToken ? `${here}/join?t=${encodeURIComponent(data.token)}` : here });
  }
  connect.urls = urls;
  if (!urls.length) {
    $('#connect-url').textContent = 'No network address found.';
    $('#connect-note').textContent = 'Connect this computer to Wi-Fi or Ethernet, or set up a tunnel (see README).';
    return;
  }
  // Prefer the address family the viewer is using: public when remote, LAN otherwise.
  const preferPublic = state.session?.publicRequest;
  let idx = urls.findIndex((u) => (preferPublic ? u.kind === 'public' && !u.blocked : u.kind === 'local' && !/virtual/.test(u.label)));
  if (idx < 0) idx = urls.findIndex((u) => !u.blocked);
  connect.selected = Math.max(0, idx);

  const seg = $('#connect-urls');
  seg.replaceChildren(...urls.map((u, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn';
    b.setAttribute('role', 'tab');
    b.innerHTML = `<span class="seg-kind"></span><span class="seg-label"></span>`;
    b.querySelector('.seg-kind').textContent = u.kind === 'public' ? 'Internet' : u.kind === 'local' ? 'Wi-Fi / LAN' : 'Current';
    b.querySelector('.seg-label').textContent = u.label;
    b.addEventListener('click', () => { connect.selected = i; showConnectUrl(data); });
    return b;
  }));
  showConnectUrl(data);

  const t = data.tunnel;
  const tunnelEl = $('#connect-tunnel');
  tunnelEl.textContent = '';
  if (t.provider !== 'none' && t.status !== 'ready') {
    tunnelEl.textContent = `Tunnel (${t.provider}): ${t.error || 'starting…'}`;
  } else if (t.provider === 'none' && !t.url) {
    tunnelEl.textContent = 'Public access is off. Set TUNNEL=ngrok or cloudflare in .env to reach ClipBox from anywhere.';
  }
}

function showConnectUrl(data) {
  const u = connect.urls[connect.selected];
  [...$('#connect-urls').children].forEach((b, i) => {
    b.classList.toggle('active', i === connect.selected);
    b.setAttribute('aria-selected', String(i === connect.selected));
  });
  const note = $('#connect-note');
  const qr = $('#connect-qr');
  $('#connect-url').textContent = u.url;
  if (u.blocked) {
    qr.removeAttribute('src');
    qr.hidden = true;
    note.textContent = 'Remote access is disabled because no AUTH_PASSWORD is set on the server. Set one in .env and restart.';
    note.classList.add('warn');
    return;
  }
  note.classList.remove('warn');
  qr.hidden = false;
  qr.src = `/api/qr?text=${encodeURIComponent(u.link)}`;
  const withToken = u.link !== u.url;
  note.textContent = withToken
    ? `Scan with a phone or tablet camera. The code signs the device in automatically and expires in ${data.tokenMinutes} minutes.`
    : u.kind === 'local'
      ? 'Scan with a phone or tablet camera. The device must be on the same network.'
      : 'Scan with a phone or tablet camera.';
}

$('#connect-copy').addEventListener('click', async (e) => {
  const u = connect.urls[connect.selected];
  if (!u) return;
  if (await copyText(u.link)) { flashButton(e.currentTarget); toast(u.link !== u.url ? 'Sign-in link copied (valid for a few minutes)' : 'Link copied'); }
});

// ── QR scanner ───────────────────────────────────────────────
const scanner = { stream: null, raf: null, detector: null, busy: false, result: null };
let jsQrPromise = null;
function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsQrPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jsQR.js';
    s.onload = () => resolve(window.jsQR);
    s.onerror = () => { jsQrPromise = null; reject(new Error('Could not load QR decoder')); };
    document.head.append(s);
  });
  return jsQrPromise;
}

async function getDetector() {
  if (scanner.detector !== null) return scanner.detector;
  scanner.detector = false;
  try {
    if ('BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
      scanner.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    }
  } catch { /* unsupported */ }
  return scanner.detector;
}

async function decodeSource(source, w, h) {
  const detector = await getDetector();
  if (detector) {
    try {
      const codes = await detector.detect(source);
      if (codes.length) return codes[0].rawValue;
    } catch { /* fall back to jsQR */ }
  }
  const jsQR = await loadJsQr();
  const canvas = decodeSource.canvas ??= document.createElement('canvas');
  const scale = Math.min(1, 1024 / Math.max(w, h));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return code ? code.data : null;
}

async function openScanner() {
  openDialog($('#dlg-scan'));
  showScanResult(null);
  startCamera();
}

async function startCamera() {
  const msg = $('#scan-msg');
  const view = $('#scan-view');
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    view.hidden = true;
    msg.textContent = 'The live camera needs HTTPS (or localhost). Use "Scan from photo" to take a picture of the QR code instead.';
    return;
  }
  view.hidden = false;
  msg.textContent = 'Starting camera…';
  try {
    scanner.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (err) {
    view.hidden = true;
    msg.textContent = err.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow it in your browser settings, or scan from a photo.'
      : 'No camera available. Use "Scan from photo" instead.';
    return;
  }
  if (!$('#dlg-scan').open) return stopCamera();
  const video = $('#scan-video');
  video.srcObject = scanner.stream;
  await video.play().catch(() => {});
  msg.textContent = 'Point the camera at a QR code.';
  const tick = async () => {
    if (!scanner.stream) return;
    if (!scanner.busy && video.readyState >= 2) {
      scanner.busy = true;
      try {
        const text = await decodeSource(video, video.videoWidth, video.videoHeight);
        if (text && scanner.stream) {
          if (navigator.vibrate) navigator.vibrate(60);
          stopCamera();
          showScanResult(text);
          return;
        }
      } catch { /* keep trying */ }
      scanner.busy = false;
    }
    scanner.raf = setTimeout(tick, 180);
  };
  tick();
}

function stopCamera() {
  clearTimeout(scanner.raf);
  scanner.busy = false;
  if (scanner.stream) scanner.stream.getTracks().forEach((t) => t.stop());
  scanner.stream = null;
  const video = $('#scan-video');
  if (video) video.srcObject = null;
}

function showScanResult(text) {
  scanner.result = text;
  $('#scan-result').hidden = !text;
  $('#scan-again').hidden = !text;
  if (!text) return;
  $('#scan-view').hidden = true;
  $('#scan-msg').textContent = isUrl(text) ? 'QR code found — open the link to connect.' : 'QR code found.';
  $('#scan-text').textContent = text;
  $('#scan-open').hidden = !isUrl(text);
}

$('#scan-photo').addEventListener('click', () => $('#scan-file').click());
$('#scan-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  stopCamera();
  $('#scan-msg').textContent = 'Reading photo…';
  try {
    const bmp = await createImageBitmap(file);
    const text = await decodeSource(bmp, bmp.width, bmp.height);
    if (text) showScanResult(text);
    else $('#scan-msg').textContent = 'No QR code found in that photo. Try again closer and in focus.';
  } catch {
    $('#scan-msg').textContent = 'Could not read that image.';
  }
});
$('#scan-again').addEventListener('click', () => { showScanResult(null); startCamera(); });
$('#scan-open').addEventListener('click', () => {
  const t = scanner.result?.trim();
  if (t && isUrl(t)) location.href = t;
});
$('#scan-add').addEventListener('click', async () => {
  if (scanner.result && (await addText(scanner.result))) { toast('Added to clipboard'); $('#dlg-scan').close(); }
});
$('#scan-copy').addEventListener('click', async (e) => {
  if (scanner.result && (await copyText(scanner.result))) { flashButton(e.currentTarget); toast('Copied'); }
});
$('#dlg-scan').addEventListener('close', stopCamera);

// ── login ────────────────────────────────────────────────────
function showLogin(reason) {
  stopSync();
  $('#app').hidden = true;
  $('#login').hidden = false;
  const msg = $('#login-msg');
  const fields = $('#login-fields');
  if (reason === 'no_password') {
    fields.hidden = true;
    msg.textContent = 'Remote access is disabled on this server. Set AUTH_PASSWORD in the server\'s .env file and restart it, or connect from the same network.';
    return;
  }
  fields.hidden = false;
  const expired = new URLSearchParams(location.search).get('join') === 'expired';
  msg.textContent = expired ? 'That QR code has expired. Scan a fresh one, or enter the password.' : 'Enter the password to continue.';
  setTimeout(() => $('#login-password').focus(), 50);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ClipBox': '1' },
      body: JSON.stringify({ password: $('#login-password').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Login failed.');
    $('#login-password').value = '';
    await start();
  } catch (ex) {
    err.textContent = ex.message === 'Failed to fetch' ? 'Cannot reach the server.' : ex.message;
    err.hidden = false;
  }
});

async function logout() {
  await fetch('/api/logout', { method: 'POST', headers: { 'X-ClipBox': '1' } }).catch(() => {});
  location.reload();
}

async function checkSessionAndMaybeLogin() {
  const res = await fetch('/api/session', { cache: 'no-store' });
  const s = await res.json();
  state.session = s;
  if (!s.authenticated) { showLogin(s.reason); return false; }
  return true;
}

// ── themes ───────────────────────────────────────────────────
const THEMES = [
  { id: 'system', name: 'System', swatch: 'linear-gradient(135deg, #ffffff 50%, #111214 50%)' },
  { id: 'light', name: 'Light', bg: '#ffffff', accent: '#4f46e5' },
  { id: 'dark', name: 'Dark', bg: '#111214', accent: '#818cf8' },
  { id: 'midnight', name: 'Midnight', bg: '#0b1020', accent: '#60a5fa' },
  { id: 'forest', name: 'Forest', bg: '#0f1512', accent: '#34d399' },
  { id: 'rose', name: 'Rose', bg: '#fffafb', accent: '#e11d48' },
  { id: 'sand', name: 'Sand', bg: '#fbf8f1', accent: '#b45309' },
];

function syncThemeColor() {
  $('#meta-theme')?.setAttribute('content', getComputedStyle(document.body).backgroundColor);
}

function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) ? id : 'system';
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  store.set('clipbox.theme', theme);
  syncThemeColor();
  document.querySelectorAll('.menu-item[data-theme-id]').forEach((b) => {
    const on = b.dataset.themeId === theme;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

function setupThemeMenu() {
  const btn = $('#btn-theme');
  const menu = $('#theme-menu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  menu.replaceChildren(...THEMES.map((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.dataset.themeId = t.id;
    b.setAttribute('role', 'menuitemradio');
    b.innerHTML = `<span class="swatch"></span><span class="menu-label"></span>${icon('check')}`;
    b.querySelector('.swatch').style.background = t.swatch || `linear-gradient(135deg, ${t.bg} 50%, ${t.accent} 50%)`;
    b.querySelector('.menu-label').textContent = t.name;
    b.addEventListener('click', () => { applyTheme(t.id); close(); btn.focus(); });
    return b;
  }));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) (menu.querySelector('.active') || menu.firstChild).focus();
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...menu.children];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); } });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor);
  applyTheme(store.get('clipbox.theme') || 'system');
}

// ── wiring ───────────────────────────────────────────────────
function wire() {
  hydrateIcons();
  setupThemeMenu();
  const input = $('#input');

  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim()) { input.focus(); return; }
    $('#btn-add').disabled = true;
    if (await addText(text)) {
      input.value = '';
      autosize(input);
      toast('Added');
    }
    $('#btn-add').disabled = false;
    if (!matchMedia('(pointer: coarse)').matches) input.focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  input.addEventListener('input', () => autosize(input));

  $('#btn-paste').addEventListener('click', pasteFromClipboard);
  $('#btn-attach').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => { uploadFiles([...e.target.files]); e.target.value = ''; });
  $('#btn-new').addEventListener('click', newClipboard);
  $('#btn-new-chip').addEventListener('click', newClipboard);
  $('#btn-rename').addEventListener('click', renameClipboard);
  $('#board-name').addEventListener('click', renameClipboard);
  $('#btn-clear').addEventListener('click', clearClipboard);
  $('#btn-delete').addEventListener('click', deleteClipboard);
  $('#btn-copy-all').addEventListener('click', (e) => copyAll(e.currentTarget));
  $('#btn-connect').addEventListener('click', openConnect);
  $('#btn-scan').addEventListener('click', openScanner);
  $('#btn-logout').addEventListener('click', logout);

  // Paste anywhere: files are uploaded; text outside an input is added instantly.
  document.addEventListener('paste', (e) => {
    if ($('#app').hidden || document.querySelector('dialog[open]')) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...dt.files];
    const target = e.target;
    const inField = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || target.isContentEditable;
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
      return;
    }
    if (!inField) {
      const text = dt.getData('text/plain');
      if (text) {
        e.preventDefault();
        addText(text).then((ok) => ok && toast('Added from paste'));
      }
    }
  });

  // Drag & drop
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e) && !$('#app').hidden) { dragDepth++; $('#drop').hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop').hidden = true;
    if (!$('#app').hidden) uploadFiles([...e.dataTransfer.files]);
  });

  // Keyboard: "/" focuses the composer
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      input.focus();
    }
  });
}

async function start() {
  try {
    if (!(await checkSessionAndMaybeLogin())) return;
    await loadState();
  } catch (err) {
    if (err.status === 401 || err.status === 403) return; // login screen already shown
    $('#login').hidden = false;
    $('#login-fields').hidden = true;
    $('#login-msg').textContent = 'Cannot reach the ClipBox server. Retrying…';
    setTimeout(start, 3000);
    return;
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#btn-logout').hidden = !state.session.required;
  if (location.search) history.replaceState(null, '', '/');
  connectSync();
}

wire();
start();
