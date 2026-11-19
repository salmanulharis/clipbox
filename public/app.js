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
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  devices: '<rect x="2" y="4" width="14" height="10" rx="1.5"/><path d="M5 18h8"/><rect x="17" y="8" width="5" height="12" rx="1"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  note: '<path d="M15 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M15 3v5h5M8 13h8M8 17h5"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.9-1"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  pin: '<path d="M12 17v5M9 10.8V4h6v6.8l3 3.2v2H6v-2z"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
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
  notes: [],
  view: 'clipboards',
  groups: [],
  groupId: store.get('clipbox.group'),
};
/** Group named by a group invitation (/join redirects to /?group=…). */
const invitedGroup = new URLSearchParams(location.search).get('group');
if (invitedGroup) state.groupId = invitedGroup;
/** Clipboards of the group currently shown. */
const groupClipboards = () => state.clipboards.filter((c) => c.groupId === state.groupId);
const currentGroup = () => state.groups.find((g) => g.id === state.groupId) || null;
const active = () => {
  const list = groupClipboards();
  return list.find((c) => c.id === state.activeId) || list[0] || null;
};

// ── toasts ───────────────────────────────────────────────────
function toast(message, kind = 'ok', ms = 2200, action = null) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'error' ? 'x' : 'check')}<span></span>`;
  el.querySelector('span').textContent = message;
  const hide = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  };
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => { hide(); action.run(); });
    el.append(b);
    el.classList.add('has-action');
  }
  $('#toasts').append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(hide, action ? Math.max(ms, 5000) : ms);
}

// ── API ──────────────────────────────────────────────────────
class ApiError extends Error {
  constructor(message, status, reason, data) { super(message); this.status = status; this.reason = reason; this.data = data; }
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
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status}).`, res.status, data?.reason, data);
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
  renderGroupSwitcher();
  renderBoards();
  renderMain(cb);
}

function renderBoards() {
  const list = $('#board-list');
  list.replaceChildren(...groupClipboards().map((c) => {
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
  $('#btn-save-note').disabled = !cb || !cb.items.some((i) => i.type === 'text');
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
    ${item.type === 'text' ? `<button class="icon-btn" data-act="note" data-tip="Save as note" aria-label="Save as note">${icon('note')}</button>` : ''}
    ${item.type === 'text' ? `<button class="icon-btn" data-act="edit" data-tip="Edit" aria-label="Edit">${icon('edit')}</button>` : ''}
    ${item.type === 'file' && copyLabel === 'Copy' ? `<button class="icon-btn" data-act="download" data-tip="Download" aria-label="Download">${icon('download')}</button>` : ''}
    <button class="icon-btn danger" data-act="delete" data-tip="Delete" aria-label="Delete">${icon('trash')}</button>`;

  actions.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const current = findItem(item.id) || item;
    if (btn.dataset.act === 'copy') copyItem(current, btn);
    else if (btn.dataset.act === 'edit') startEdit(current.id);
    else if (btn.dataset.act === 'note') saveAsNote({ title: '', body: current.text });
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
  state.notes = data.notes || [];
  state.groups = data.groups || [];
  ensureGroup();
  state.rev = data.rev;
  state.boot = data.boot;
  render();
  if (typeof Notes !== 'undefined') Notes.onShared(null);
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
  if (ev.type === 'groups') return loadState(); // groups or membership changed: reload what we may see
  if (ev.type === 'clipboard') upsertClipboard(ev.clipboard, ev.order);
  else if (ev.type === 'remove') reorder(ev.order);
  else if (ev.type === 'note') {
    const i = state.notes.findIndex((n) => n.id === ev.note.id);
    if (i >= 0) state.notes[i] = ev.note; else state.notes.push(ev.note);
  } else if (ev.type === 'note-remove') state.notes = state.notes.filter((n) => n.id !== ev.id);
  if (ev.type === 'note' || ev.type === 'note-remove') {
    if (typeof Notes !== 'undefined') Notes.onShared(ev);
    return;
  }
  render();
}

const ROLE_LABEL = { host: 'Host', member: 'Member', viewer: 'Viewer' };
const isViewer = () => state.me?.role === 'viewer';

function applyRole() {
  const role = state.me?.role || 'member';
  document.body.classList.toggle('viewer', role === 'viewer');
  $('#role-badge').hidden = role !== 'viewer';
  $('#btn-devices').hidden = role !== 'host';
  if (role === 'viewer' && state.editing) cancelEdit();
  if (typeof Notes !== 'undefined') Notes.onShared(null);
}

async function loadState() {
  const data = await api('GET', '/api/state');
  state.server = data.server;
  const prevRole = state.me?.role;
  state.me = data.me || null;
  applyRole();
  if (prevRole && state.me && prevRole !== state.me.role) {
    toast(`This device is now ${ROLE_LABEL[state.me.role] === 'Viewer' ? 'view-only' : `a ${ROLE_LABEL[state.me.role]}`}`);
  }
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
  es.addEventListener('me', () => loadState().catch(() => {})); // role/name changed by the host
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
  if (isViewer()) { toast('This device is view-only.', 'error'); return false; }
  const item = await attempt(() => api('POST', `/api/clipboards/${cb.id}/items`, { text }));
  if (item) { upsertItem(cb.id, item); return true; }
  return false;
}

async function uploadFiles(files) {
  const cb = active();
  if (!cb) return;
  if (isViewer()) { toast('This device is view-only.', 'error'); return; }
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
  const cb = await attempt(() => api('POST', '/api/clipboards', { name, groupId: state.groupId }));
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
  const idx = groupClipboards().indexOf(cb);
  const ok = await attempt(() => api('DELETE', `/api/clipboards/${cb.id}`), 'Clipboard deleted');
  if (ok) {
    state.clipboards = state.clipboards.filter((c) => c.id !== cb.id);
    const next = groupClipboards()[Math.max(0, idx - 1)];
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

// ── passphrase dialog ────────────────────────────────────────
/**
 * Ask for a passphrase. confirm=true asks twice (min. 8 characters).
 * Resolves to the passphrase, { secondary: true } if the secondary button was used, or null.
 */
/**
 * Ask for a passphrase/password. [verify] (async, optional) checks it before the dialog closes and
 * returns an error message to show, or nothing when it's accepted.
 */
function passDialog({ title, message, confirm = false, ok = 'OK', secondary = null, noun = 'passphrase', min = 8, verify = null }) {
  const dlg = $('#dlg-pass');
  const p1 = $('#pass-1');
  const p2 = $('#pass-2');
  const err = $('#pass-error');
  $('#pass-title').textContent = title;
  $('#pass-message').textContent = message || '';
  p1.value = '';
  p2.value = '';
  const Noun = noun[0].toUpperCase() + noun.slice(1);
  p1.placeholder = Noun;
  p1.setAttribute('aria-label', Noun);
  p2.placeholder = `Repeat ${noun}`;
  p2.setAttribute('aria-label', `Repeat ${noun}`);
  p2.hidden = !confirm;
  p1.autocomplete = confirm ? 'new-password' : 'current-password';
  err.hidden = true;
  $('#pass-ok').textContent = ok;
  const sec = $('#pass-secondary');
  sec.hidden = !secondary;
  sec.textContent = secondary || '';
  return new Promise((resolve) => {
    const finish = (v) => { cleanup(); if (dlg.open) dlg.close(); resolve(v); };
    const fail = (m) => { err.textContent = m; err.hidden = false; p1.focus(); };
    const onSubmit = async (e) => {
      e.preventDefault();
      if (!p1.value) return fail(`Enter a ${noun}.`);
      if (confirm && p1.value.length < min) return fail(`Use at least ${min} characters.`);
      if (confirm && p1.value !== p2.value) return fail(`The ${noun}s don't match.`);
      if (verify) {
        const okBtn = $('#pass-ok');
        okBtn.disabled = true;
        const problem = await verify(p1.value).finally(() => { okBtn.disabled = false; });
        if (problem) { p1.select(); return fail(problem); }
      }
      finish(p1.value);
    };
    const onCancel = () => finish(null);
    const onSecondary = () => finish({ secondary: true });
    const cleanup = () => {
      $('#pass-form').removeEventListener('submit', onSubmit);
      $('#pass-cancel').removeEventListener('click', onCancel);
      sec.removeEventListener('click', onSecondary);
      dlg.removeEventListener('close', onCancel);
    };
    $('#pass-form').addEventListener('submit', onSubmit);
    $('#pass-cancel').addEventListener('click', onCancel);
    sec.addEventListener('click', onSecondary);
    dlg.addEventListener('close', onCancel);
    openDialog(dlg);
    p1.focus();
  });
}

// ── save clipboard content as a note ─────────────────────────
function saveAsNote({ title, body }) {
  const dlg = $('#dlg-save-note');
  const firstLine = (body.split(/\r?\n/).find((l) => l.trim()) || '').trim();
  $('#save-note-title').value = (title || (firstLine.length <= 80 ? firstLine : '')).slice(0, 200);
  $('#save-note-preview').textContent = body.length > 2000 ? `${body.slice(0, 2000)}…` : body;
  const canShare = !isViewer() && sync.es?.readyState !== EventSource.CLOSED;
  const sharedOpt = $('#save-shared-opt');
  sharedOpt.classList.toggle('disabled', !canShare);
  sharedOpt.querySelector('input').disabled = !canShare;
  $('#save-shared-hint').textContent = canShare
    ? `Visible to ${groupAudience()}.`
    : isViewer() ? 'This device is view-only.' : 'Not available while offline.';
  const locked = PrivateStore.lockState() === 'locked';
  $('#save-private-hint').textContent = locked
    ? "Only in this browser. You'll be asked for your passphrase."
    : 'Only in this browser. Never sent to the server.';
  dlg.querySelector('input[value="private"]').checked = true; // always default to private
  openDialog(dlg);
  $('#save-note-title').focus();

  const form = $('#save-note-form');
  const onSubmit = async (e) => {
    e.preventDefault();
    const scope = form.querySelector('input[name="save-scope"]:checked').value;
    const fields = { title: $('#save-note-title').value.trim(), body };
    $('#save-note-ok').disabled = true;
    try {
      if (await Notes.createFrom(scope, fields)) { cleanup(); dlg.close(); }
    } finally {
      $('#save-note-ok').disabled = false;
    }
  };
  const onCancel = () => { cleanup(); if (dlg.open) dlg.close(); };
  const cleanup = () => {
    form.removeEventListener('submit', onSubmit);
    $('#save-note-cancel').removeEventListener('click', onCancel);
    dlg.removeEventListener('close', cleanup);
  };
  form.addEventListener('submit', onSubmit);
  $('#save-note-cancel').addEventListener('click', onCancel);
  dlg.addEventListener('close', cleanup);
}

// ── connect (QR) dialog ──────────────────────────────────────
const connect = { urls: [], selected: 0 };

async function openConnect(groupId = state.groupId) {
  const dlg = $('#dlg-connect');
  openDialog(dlg);
  $('#connect-urls').replaceChildren();
  $('#connect-url').textContent = 'Loading…';
  $('#connect-qr').removeAttribute('src');
  // Invitations: hosts can invite to any group, others only to groups open to everyone.
  const invitable = state.groups.filter((g) => state.me?.role === 'host' || g.access === 'all');
  if (!invitable.some((g) => g.id === groupId)) groupId = invitable[0]?.id;
  const sel = $('#connect-group');
  $('#connect-group-row').hidden = invitable.length < 2;
  sel.replaceChildren(...invitable.map((g) => {
    const o = document.createElement('option');
    o.value = g.id;
    o.textContent = g.access === 'all' ? `${g.name} (everyone)` : g.name;
    o.selected = g.id === groupId;
    return o;
  }));
  sel.onchange = () => openConnect(sel.value);
  const data = await attempt(() => api('GET', `/api/connect${groupId ? `?group=${encodeURIComponent(groupId)}` : ''}`));
  if (!data) return dlg.close();
  const invite = data.group && !data.group.isDefault && data.group.id !== 'grp_everyone';
  $('#connect-group-note').textContent = invite ? `Scanning this code also adds the device to the "${data.group.name}" group.` : '';
  const urls = data.urls;
  const here = location.origin;
  const isLoopback = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  if (!isLoopback && !urls.some((u) => u.url === here)) {
    const needsToken = (state.session?.required || invite) && data.token;
    const frag = data.fragment || '';
    urls.push({ kind: 'current', label: 'This address', url: here, link: needsToken ? `${here}/join?t=${encodeURIComponent(data.token)}${frag}` : `${here}/${frag}` });
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
  const meEl = $('#connect-me');
  meEl.textContent = state.me?.name ? `This device: ${state.me.name} · ${ROLE_LABEL[state.me.role] || ''}` : '';

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

// ── devices (host only) ──────────────────────────────────────
const PLATFORM_LABEL = { web: 'Browser', android: 'Android app', ios: 'iOS app', cli: 'API client', other: 'App' };

async function openDevices() {
  openDialog($('#dlg-devices'));
  await refreshDevices();
}

async function refreshDevices() {
  const data = await attempt(() => api('GET', '/api/devices'));
  if (!data) return;
  const devices = data.devices.sort((a, b) => (b.current - a.current) || (a.revoked - b.revoked) || (b.lastSeenAt - a.lastSeenAt));
  $('#device-list').replaceChildren(...devices.map(buildDeviceRow));
  const note = $('#devices-note');
  note.hidden = state.server?.authMode !== 'public';
  note.textContent = 'AUTH_MODE is "public": browsers on your network can reconnect without a password even after being revoked. Use AUTH_MODE=all to control every device.';
}

function buildDeviceRow(d) {
  const li = document.createElement('li');
  li.className = `device-row${d.revoked ? ' revoked' : ''}`;
  li.innerHTML = `${icon(d.platform === 'web' ? 'monitor' : 'phone')}
    <div class="device-main"><button class="device-name" type="button"></button><div class="device-meta"></div></div>
    <select class="role-select" aria-label="Role">
      <option value="host">Host</option><option value="member">Member</option><option value="viewer">Viewer</option>
    </select>
    <div class="row-actions"></div>`;
  const nameBtn = li.querySelector('.device-name');
  nameBtn.textContent = d.name;
  nameBtn.title = 'Rename';
  const meta = li.querySelector('.device-meta');
  const parts = [PLATFORM_LABEL[d.platform] || 'Device', d.revoked ? 'revoked' : `seen ${timeAgo(d.lastSeenAt)}`];
  meta.textContent = parts.join(' · ');
  if (d.current) meta.insertAdjacentHTML('afterbegin', '<span class="you">This device</span> · ');

  const select = li.querySelector('.role-select');
  select.value = d.role;
  select.disabled = d.revoked;

  const actions = li.querySelector('.row-actions');
  const btn = (name, tip, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `icon-btn sm ${cls}`;
    b.dataset.tip = tip;
    b.setAttribute('aria-label', tip);
    b.innerHTML = icon(name);
    actions.append(b);
    return b;
  };

  const patch = async (body, okMsg) => {
    const r = await attempt(() => api('PATCH', `/api/devices/${d.id}`, body), okMsg);
    await refreshDevices();
    if (r && d.current) loadState().catch(() => {});
    return r;
  };

  nameBtn.addEventListener('click', async () => {
    const name = await ask({ title: 'Rename device', value: d.name, ok: 'Rename' });
    if (name && name !== d.name) patch({ name }, 'Renamed');
  });
  select.addEventListener('change', async () => {
    const role = select.value;
    if (d.current && role !== 'host') {
      const yes = await confirmDialog({ title: 'Change your own role?', message: 'This device will lose access to device management (unless it is the server machine itself).', ok: 'Change' });
      if (!yes) { select.value = d.role; return; }
    }
    patch({ role }, `${d.name} is now ${ROLE_LABEL[role]}`);
  });

  if (d.revoked) {
    btn('undo', 'Restore').addEventListener('click', () => patch({ revoked: false }, 'Device restored'));
    btn('trash', 'Remove', 'danger').addEventListener('click', async () => {
      const yes = await confirmDialog({ title: `Remove "${d.name}"?`, message: 'It disappears from this list. To use ClipBox again it must reconnect.', ok: 'Remove', danger: true });
      if (yes && (await attempt(() => api('DELETE', `/api/devices/${d.id}`), 'Device removed'))) refreshDevices();
    });
  } else {
    btn('ban', 'Revoke access', 'danger').addEventListener('click', async () => {
      const yes = await confirmDialog({
        title: `Revoke "${d.name}"?`,
        message: d.current ? 'This signs out the device you are using right now.' : 'It is signed out immediately and must scan a new QR code or sign in to return.',
        ok: 'Revoke',
        danger: true,
      });
      if (yes) patch({ revoked: true }, 'Access revoked');
    });
  }
  return li;
}

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
  msg.textContent = reason === 'device_revoked'
    ? 'This device was removed by the host. Scan a new QR code or enter the password.'
    : expired ? 'That QR code has expired. Scan a fresh one, or enter the password.' : 'Enter the password to continue.';
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
    closeGroupMenu(); // only one menu open at a time
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

// ── groups ───────────────────────────────────────────────────
/** Who sees shared things in the current group, in words. */
function groupAudience() {
  const g = currentGroup();
  const srv = state.server?.serverName || 'this server';
  if (!g || g.isDefault) return `everyone connected to ${srv}`;
  return g.access === 'all' ? `everyone in "${g.name}"` : `members of "${g.name}"`;
}

function ensureGroup() {
  if (!state.groups.some((g) => g.id === state.groupId && !g.locked)) {
    state.groupId = (state.groups.find((g) => g.isDefault) || state.groups[0])?.id || null;
  }
}

const ACCESS_LABEL = { all: 'Open to every device', password: 'Password', members: 'Invited only' };
const groupIcon = (g) => (g.access === 'all' ? 'users' : g.access === 'password' ? 'key' : 'lock');

/** Join a password group: ask for its password (checked by the server), then open it. */
async function joinGroup(g) {
  const pw = await passDialog({
    title: `Join "${g.name}"`,
    message: 'Enter the group password. You only need it once on this device.',
    noun: 'password',
    ok: 'Join',
    verify: async (password) => {
      try {
        await api('POST', `/api/groups/${g.id}/join`, { password });
        return null;
      } catch (err) {
        return err.reason === 'group_password' ? 'Wrong password. Try again.' : err.message;
      }
    },
  });
  if (!pw) return;
  await loadState();
  setGroup(g.id, `You joined "${g.name}"`);
}

async function leaveGroup(g) {
  const yes = await confirmDialog({
    title: `Leave "${g.name}"?`,
    message: g.access === 'password'
      ? "Its clipboards and shared notes disappear from this device. You can join again with the group password."
      : "Its clipboards and shared notes disappear from this device. You'll need a new invitation to come back.",
    ok: 'Leave group',
    danger: true,
  });
  if (!yes || !(await attempt(() => api('POST', `/api/groups/${g.id}/leave`), `You left "${g.name}"`))) return;
  await loadState();
}

function setGroup(id, message) {
  const target = state.groups.find((g) => g.id === id);
  if (target?.locked) return joinGroup(target);
  if (id === state.groupId) return;
  if (state.editing) cancelEdit();
  state.groupId = id;
  store.set('clipbox.group', id);
  render();
  if (typeof Notes !== 'undefined') Notes.onShared(null);
  toast(message || `Switched to ${currentGroup()?.name || 'group'}`);
}

function closeGroupMenu() {
  $('#group-menu').hidden = true;
  $('#btn-group').setAttribute('aria-expanded', 'false');
}

function renderGroupSwitcher() {
  const host = state.me?.role === 'host';
  $('#group-wrap').hidden = !(state.groups.length > 1 || host);
  $('#group-name').textContent = currentGroup()?.name || 'Everyone';
  const items = state.groups.map((g) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `menu-item${g.id === state.groupId ? ' active' : ''}`;
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(g.id === state.groupId));
    b.innerHTML = `${icon(g.locked ? 'lock' : groupIcon(g))}<span class="menu-label"></span>${g.locked ? '<span class="menu-hint">Join</span>' : icon('check')}`;
    b.querySelector('.menu-label').textContent = g.name;
    b.title = g.locked ? 'Password protected: enter the password to join' : ACCESS_LABEL[g.access] || '';
    b.addEventListener('click', () => { closeGroupMenu(); setGroup(g.id); });
    return b;
  });
  const cur = currentGroup();
  if (cur && !host && !cur.isDefault && cur.access !== 'all') {
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    const l = document.createElement('button');
    l.type = 'button';
    l.className = 'menu-item';
    l.innerHTML = `${icon('logout')}<span class="menu-label"></span>`;
    l.querySelector('.menu-label').textContent = `Leave "${cur.name}"`;
    l.addEventListener('click', () => { closeGroupMenu(); leaveGroup(cur); });
    items.push(sep, l);
  }
  if (host) {
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    const m = document.createElement('button');
    m.type = 'button';
    m.className = 'menu-item';
    m.innerHTML = `${icon('settings')}<span class="menu-label">Manage groups…</span>`;
    m.addEventListener('click', () => { closeGroupMenu(); openGroups(); });
    items.push(sep, m);
  }
  $('#group-menu').replaceChildren(...items);
}

async function openGroups() {
  openDialog($('#dlg-groups'));
  await renderGroups();
}

async function renderGroups() {
  const devs = await attempt(() => api('GET', '/api/devices'));
  if (!devs) return;
  const devices = devs.devices.filter((d) => !d.revoked);
  $('#group-list').replaceChildren(...state.groups.map((g) => buildGroupRow(g, devices)));
}

async function patchGroup(g, body, okMsg) {
  const r = await attempt(() => api('PATCH', `/api/groups/${g.id}`, body), okMsg);
  if (r) {
    await loadState();
    await renderGroups();
  }
}

function buildGroupRow(g, devices) {
  const li = document.createElement('li');
  li.className = 'group-row';
  li.innerHTML = `<div class="group-head">${icon(groupIcon(g))}
      <div class="group-main"><button type="button" class="device-name"></button><div class="device-meta"></div></div>
      <select class="role-select" aria-label="Who can see this group">
        <option value="all">Open</option><option value="password">Password</option><option value="members">Invited only</option>
      </select>
      <div class="row-actions"></div></div>`;
  const name = li.querySelector('.device-name');
  name.textContent = g.name;
  name.title = 'Rename';
  name.addEventListener('click', async () => {
    const n = await ask({ title: 'Rename group', value: g.name, ok: 'Rename' });
    if (n && n !== g.name) patchGroup(g, { name: n }, 'Group renamed');
  });
  const clips = state.clipboards.filter((c) => c.groupId === g.id).length;
  const notes = (state.notes || []).filter((n) => n.groupId === g.id).length;
  const m = (g.members || []).length;
  const who = g.access === 'all' ? 'Visible to every device'
    : g.access === 'password' ? `Password · ${m} member${m === 1 ? '' : 's'} + host`
      : `${m} member${m === 1 ? '' : 's'} + host`;
  li.querySelector('.device-meta').textContent =
    `${who} · ${clips} clipboard${clips === 1 ? '' : 's'} · ${notes} shared note${notes === 1 ? '' : 's'}`;

  const sel = li.querySelector('.role-select');
  sel.value = g.access;
  sel.disabled = g.isDefault;
  sel.title = g.isDefault ? 'Everyone is always visible to every device'
    : 'Open: every device sees it. Password: every device sees it locked and joins with the password. Invited only: hidden from non-members.';
  sel.addEventListener('change', async () => {
    const access = sel.value;
    const body = { access };
    if (access === 'password') {
      const pw = await askGroupPassword(g.name);
      if (!pw) { sel.value = g.access; return; }
      body.password = pw;
    }
    const msg = { all: 'Now open to every device', password: 'Now password protected', members: 'Now invite-only' }[access];
    patchGroup(g, body, msg);
  });

  const actions = li.querySelector('.row-actions');
  const btn = (ic, tip, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `icon-btn sm ${cls}`;
    b.dataset.tip = tip;
    b.setAttribute('aria-label', tip);
    b.innerHTML = icon(ic);
    b.addEventListener('click', fn);
    actions.append(b);
  };
  btn('qr', 'Invite a device (QR code)', '', () => { $('#dlg-groups').close(); openConnect(g.id); });
  if (g.access === 'password') {
    btn('key', 'Change password', '', async () => {
      const pw = await askGroupPassword(g.name, true);
      if (pw) patchGroup(g, { password: pw }, 'Password changed. Existing members stay in the group.');
    });
  }
  if (!g.isDefault) {
    btn('trash', 'Delete group', 'danger', async () => {
      const yes = await confirmDialog({
        title: `Delete "${g.name}"?`,
        message: `Its ${clips} clipboard${clips === 1 ? '' : 's'} and ${notes} shared note${notes === 1 ? '' : 's'} are deleted for everyone. Private notes are not affected.`,
        ok: 'Delete group',
        danger: true,
      });
      if (yes && (await attempt(() => api('DELETE', `/api/groups/${g.id}`), 'Group deleted'))) {
        await loadState();
        await renderGroups();
      }
    });
  }

  if (g.access !== 'all') {
    const box = document.createElement('div');
    box.className = 'member-list';
    const others = devices.filter((d) => d.role !== 'host' || (g.members || []).includes(d.id));
    if (!others.length) box.innerHTML = '<p class="muted small">No other devices yet. Use the QR button to invite one.</p>';
    for (const d of others) {
      const label = document.createElement('label');
      label.className = 'member';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = (g.members || []).includes(d.id);
      cb.addEventListener('change', () => {
        const next = new Set(g.members || []);
        if (cb.checked) next.add(d.id); else next.delete(d.id);
        patchGroup(g, { members: [...next] }, cb.checked ? `${d.name} added` : `${d.name} removed`);
      });
      const span = document.createElement('span');
      span.textContent = `${d.name}${d.current ? ' (this device)' : ''}`;
      label.append(cb, span);
      box.append(label);
    }
    li.append(box);
  }
  return li;
}

/** New password for a group (entered twice). */
function askGroupPassword(name, change = false) {
  return passDialog({
    title: change ? `New password for "${name}"` : `Password for "${name}"`,
    message: change
      ? 'Devices that already joined stay in the group; new devices need the new password. Remove members below if needed.'
      : 'Every device sees this group with a lock and can join by entering this password once.',
    confirm: true, noun: 'password', min: 4, ok: change ? 'Change password' : 'Set password',
  });
}

// ── views ────────────────────────────────────────────────────
function setView(view) {
  state.view = view === 'notes' ? 'notes' : 'clipboards';
  store.set('clipbox.view', state.view);
  $('#view-clipboards').hidden = state.view !== 'clipboards';
  $('#view-notes').hidden = state.view !== 'notes';
  document.querySelectorAll('.vs-btn').forEach((b) => {
    const on = b.dataset.view === state.view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  if (state.view === 'notes') Notes.show();
  else Notes.hide();
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
  $('#btn-save-note').addEventListener('click', () => {
    const cb = active();
    const texts = cb ? cb.items.filter((i) => i.type === 'text').map((i) => i.text) : [];
    if (!texts.length) return toast('This clipboard has no text to save', 'error');
    saveAsNote({ title: cb.name, body: texts.join('\n\n') });
  });
  $('#btn-connect').addEventListener('click', openConnect);
  $('#btn-scan').addEventListener('click', openScanner);
  $('#btn-devices').addEventListener('click', openDevices);
  $('#btn-group').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#theme-menu').hidden = true; // only one menu open at a time
    $('#btn-theme').setAttribute('aria-expanded', 'false');
    const menu = $('#group-menu');
    menu.hidden = !menu.hidden;
    $('#btn-group').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!$('#group-menu').hidden && !$('#group-menu').contains(e.target)) closeGroupMenu();
  });
  $('#group-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#group-new-name').value.trim();
    if (!name) return $('#group-new-name').focus();
    const access = $('#group-new-access').value;
    const password = $('#group-new-password').value;
    if (access === 'password' && password.length < 4) {
      toast('Use a group password of at least 4 characters.', 'error');
      return $('#group-new-password').focus();
    }
    const body = { name, access, ...(access === 'password' ? { password } : {}) };
    const g = await attempt(() => api('POST', '/api/groups', body), `Group "${name}" created`);
    if (g) {
      $('#group-new-name').value = '';
      $('#group-new-password').value = '';
      await loadState();
      await renderGroups();
    }
  });
  $('#group-new-access').addEventListener('change', () => {
    const pw = $('#group-new-access').value === 'password';
    $('#group-new-password').hidden = !pw;
    if (pw) $('#group-new-password').focus();
  });
  $('#btn-logout').addEventListener('click', logout);

  // Paste anywhere: files are uploaded; text outside an input is added instantly.
  document.addEventListener('paste', (e) => {
    if ($('#app').hidden || state.view !== 'clipboards' || document.querySelector('dialog[open]')) return;
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
  window.addEventListener('dragenter', (e) => { if (hasFiles(e) && !$('#app').hidden && state.view === 'clipboards') { dragDepth++; $('#drop').hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop').hidden = true;
    if (!$('#app').hidden && state.view === 'clipboards') uploadFiles([...e.dataTransfer.files]);
  });

  // Keyboard: "/" focuses the composer
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      if (state.view === 'notes') Notes.focusSearch();
      else input.focus();
    }
  });

  // Clipboards | Notes switch
  document.querySelectorAll('.vs-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
}

async function start() {
  await Notes.init();
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
  if (invitedGroup && currentGroup()?.id === invitedGroup) {
    store.set('clipbox.group', invitedGroup);
    toast(`You joined "${currentGroup().name}"`);
  }
  if (location.search) history.replaceState(null, '', '/');
  connectSync();
  setView(store.get('clipbox.view') || 'clipboards');
}

// Deferred scripts all run before DOMContentLoaded, so notes.js is loaded by then.
document.addEventListener('DOMContentLoaded', () => {
  wire();
  start();
});
