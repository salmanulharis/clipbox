'use strict';
/*
 * Notes view.
 *  - Private notes: stored only in this browser via PrivateStore (private-store.js).
 *    Nothing in this file sends a private note anywhere except the explicit,
 *    confirmed "Share…" action, which creates a separate shared note.
 *  - Shared notes: stored on the server (state.notes), synced live via app.js.
 *
 * Uses helpers from app.js: $, api, attempt, toast, icon, ask, confirmDialog,
 * copyText, timeAgo, state, store, isViewer, sleep.
 */
const Notes = (() => {
  const SAVE_DELAY = { private: 400, shared: 800 };
  const SECTIONS = ['private', 'shared', 'trash'];
  const DAY = 24 * 60 * 60 * 1000;
  const el = (id) => document.getElementById(id);

  const N = {
    ready: false,
    initPromise: null,
    visible: false,
    section: SECTIONS.includes(store.get('clipbox.notesSection')) ? store.get('clipbox.notesSection') : 'private',
    query: '',
    tag: null,
    priv: [],
    trash: [],
    infoOpen: false,
    ed: null, // open editor state
  };

  // ── permissions & helpers ───────────────────────────────────
  const me = () => state.me || {};
  const canWriteShared = () => !isViewer();
  const canEditShared = (n) => canWriteShared() && (!n || !n.locked || me().role === 'host' || n.authorId === me().deviceId);
  const canLock = (n) => canWriteShared() && n && (me().role === 'host' || n.authorId === me().deviceId);
  const serverName = () => state.server?.serverName || 'this server';

  const parseTags = (s) => s.split(/[,\n]/).map((t) => t.trim().replace(/^#+/, '')).filter(Boolean);
  const firstLine = (s) => (s || '').split('\n').find((l) => l.trim()) || '';
  const noteTitle = (n) => n.title || firstLine(n.body).slice(0, 120) || 'Untitled';
  const noteText = (n) => (n.title ? `${n.title}\n\n${n.body}` : n.body).trim();
  const sortNotes = (list) => [...list].sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));

  function sectionNotes(section = N.section) {
    if (section === 'private') return N.priv;
    if (section === 'shared') return state.notes || [];
    return N.trash;
  }

  function findNote(scope, id) {
    if (!id) return null;
    return scope === 'shared' ? (state.notes || []).find((n) => n.id === id) || null : N.priv.find((n) => n.id === id) || null;
  }

  function matches(n) {
    if (N.tag && !(n.tags || []).some((t) => t.toLowerCase() === N.tag.toLowerCase())) return false;
    if (!N.query) return true;
    const hay = `${n.title}\n${n.body}\n${(n.tags || []).join(' ')}`.toLowerCase();
    return N.query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  // ── init ────────────────────────────────────────────────────
  async function reloadPrivate() {
    const { active, trash } = await PrivateStore.list();
    N.priv = active;
    N.trash = trash;
  }

  function init() {
    if (N.initPromise) return N.initPromise;
    N.initPromise = (async () => {
      await PrivateStore.init();
      await reloadPrivate();
      PrivateStore.onChange(async ({ external }) => {
        await reloadPrivate();
        if (external) onPrivateExternal();
        render();
      });
      wire();
      N.ready = true;
    })();
    return N.initPromise;
  }

  // ── rendering ───────────────────────────────────────────────
  function render() {
    if (!N.ready) return;
    el('count-private').textContent = N.priv.length || '';
    el('count-shared').textContent = (state.notes || []).length || '';
    el('count-trash').textContent = N.trash.length || '';
    document.querySelectorAll('.section-btn').forEach((b) => {
      const on = b.dataset.section === N.section;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    });
    if (N.ed) updateEditorChrome();
    else renderList();
  }

  function renderBanner() {
    const b = el('section-banner');
    b.className = `section-banner ${N.section}`;
    if (N.section === 'private') {
      b.innerHTML = `${icon('lock')}
        <div class="banner-text"><strong>Private</strong> <span>— only in this browser, at this address</span></div>
        <div class="banner-actions">
          <button class="icon-btn sm" data-act="info" data-tip="How private notes work" aria-label="How private notes work" aria-expanded="${N.infoOpen}">${icon('info')}</button>
          <button class="icon-btn sm" data-act="export" data-tip="Export a backup" aria-label="Export private notes">${icon('download')}</button>
          <button class="icon-btn sm" data-act="import" data-tip="Import a backup" aria-label="Import private notes">${icon('upload')}</button>
        </div>`;
      if (N.infoOpen) {
        const p = document.createElement('p');
        p.className = 'banner-info';
        p.textContent = `Private notes are stored only in this browser for ${location.origin}. They are never sent to the server or to other devices. `
          + 'Opening ClipBox at a different address (for example the tunnel URL), in another browser, or after clearing site data shows a different set, so export a backup now and then. '
          + 'Because this page\'s code comes from the server, someone who modifies the server\'s ClipBox code could read them; for very sensitive notes, use the ClipBox Android app.';
        b.append(p);
      }
      if (PrivateStore.backend === 'memory') {
        const w = document.createElement('p');
        w.className = 'banner-warn';
        w.textContent = 'This browser is blocking storage (private window?). Private notes will be lost when you close this tab.';
        b.append(w);
      }
    } else if (N.section === 'shared') {
      b.innerHTML = `${icon('users')}<div class="banner-text"><strong>Shared</strong> <span>— visible to everyone connected to <span class="srv"></span></span>${isViewer() ? ' <span class="badge">View only</span>' : ''}</div>`;
      b.querySelector('.srv').textContent = serverName();
    } else {
      b.innerHTML = `${icon('trash')}<div class="banner-text"><strong>Trash</strong> <span>— deleted private notes are kept for 30 days</span></div>
        <div class="banner-actions"><button class="btn sm" data-act="empty-trash" ${N.trash.length ? '' : 'disabled'}>Empty trash</button></div>`;
    }
  }

  function renderTags(notes) {
    const box = el('tag-filter');
    const counts = new Map();
    for (const n of notes) for (const t of n.tags || []) counts.set(t.toLowerCase(), { name: t, n: (counts.get(t.toLowerCase())?.n || 0) + 1 });
    const tags = [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 30);
    if (N.tag && !counts.has(N.tag.toLowerCase())) N.tag = null;
    box.hidden = tags.length === 0;
    box.replaceChildren(...tags.map((t) => {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = `tag-chip${N.tag && N.tag.toLowerCase() === t.name.toLowerCase() ? ' active' : ''}`;
      c.textContent = `#${t.name}`;
      c.addEventListener('click', () => { N.tag = c.classList.contains('active') ? null : t.name; renderList(); });
      return c;
    }));
  }

  function renderList() {
    renderBanner();
    checkReminder();
    const newBtn = el('btn-new-note');
    newBtn.hidden = N.section === 'trash' || (N.section === 'shared' && !canWriteShared());
    el('new-note-label').textContent = N.section === 'shared' ? 'New shared note' : 'New private note';
    newBtn.classList.toggle('shared', N.section === 'shared');

    const all = sectionNotes();
    renderTags(all);
    const notes = sortNotes(all.filter(matches));
    el('notes-list').replaceChildren(...notes.map((n) => buildRow(n, N.section)));

    const empty = el('notes-empty');
    empty.hidden = notes.length > 0;
    if (!notes.length) {
      const filtering = N.query || N.tag;
      const [t, sub] = filtering
        ? ['No matching notes', 'Try a different search or tag.']
        : N.section === 'private'
          ? ['No private notes yet', 'They are stored only in this browser and never sent to the server.']
          : N.section === 'shared'
            ? ['No shared notes yet', canWriteShared() ? `Shared notes are visible to everyone connected to ${serverName()}.` : 'Notes shared by the group will appear here.']
            : ['Trash is empty', 'Deleted private notes stay here for 30 days.'];
      el('notes-empty-title').textContent = t;
      el('notes-empty-sub').textContent = sub;
    }
  }

  function buildRow(n, section) {
    const li = document.createElement('li');
    li.className = `note-row ${section}`;
    li.dataset.id = n.id;

    const main = document.createElement('div');
    main.className = 'note-main';
    main.tabIndex = 0;
    main.setAttribute('role', 'button');
    const title = document.createElement('div');
    title.className = 'note-title';
    if (n.pinned && section !== 'trash') title.insertAdjacentHTML('afterbegin', `<span class="pin-mark" aria-label="Pinned">${icon('pin')}</span>`);
    if (n.locked) title.insertAdjacentHTML('beforeend', `<span class="lock-mark" aria-label="Locked">${icon('lock')}</span>`);
    const tt = document.createElement('span');
    tt.textContent = noteTitle(n);
    title.insertBefore(tt, title.querySelector('.lock-mark'));
    const preview = document.createElement('div');
    preview.className = 'note-preview';
    const rest = n.title ? n.body : n.body.split('\n').slice(1).join('\n');
    preview.textContent = rest.trim().slice(0, 280);
    const meta = document.createElement('div');
    meta.className = 'note-meta';
    const bits = [section === 'trash' ? `deleted ${timeAgo(n.deletedAt)}` : timeAgo(n.updatedAt)];
    if (section === 'shared') bits.push(n.updatedByName && n.updatedByName !== n.authorName ? `by ${n.authorName}, edited by ${n.updatedByName}` : `by ${n.authorName}`);
    meta.textContent = bits.join(' · ');
    for (const t of (n.tags || []).slice(0, 6)) {
      const s = document.createElement('span');
      s.className = 'mini-tag';
      s.textContent = `#${t}`;
      meta.append(s);
    }
    main.append(title, ...(preview.textContent ? [preview] : []), meta);

    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const add = (act, ic, tip, cls = '') => {
      actions.insertAdjacentHTML('beforeend', `<button class="icon-btn ${cls}" data-act="${act}" data-tip="${tip}" aria-label="${tip}">${icon(ic)}</button>`);
    };
    if (section === 'trash') {
      add('restore', 'undo', 'Restore');
      add('destroy', 'trash', 'Delete forever', 'danger');
    } else {
      const editable = section === 'private' || canEditShared(n);
      add('copy', 'copy', 'Copy', 'copy');
      if (editable) add('pin', 'pin', n.pinned ? 'Unpin' : 'Pin', n.pinned ? 'on' : '');
      add('open', editable ? 'edit' : 'note', editable ? 'Edit' : 'Open');
      if (editable) add('delete', 'trash', 'Delete', 'danger');
    }

    const open = () => { if (section !== 'trash') openEditor(section, n); };
    main.addEventListener('click', open);
    main.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    actions.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const cur = section === 'trash' ? N.trash.find((x) => x.id === n.id) || n : findNote(section, n.id) || n;
      if (act === 'copy') copyNote(cur, btn);
      else if (act === 'pin') togglePin(section, cur);
      else if (act === 'open') open();
      else if (act === 'delete') deleteNote(section, cur);
      else if (act === 'restore') { await PrivateStore.restore(cur.id); toast('Note restored'); }
      else if (act === 'destroy') {
        const yes = await confirmDialog({ title: 'Delete forever?', message: `"${noteTitle(cur)}" will be permanently deleted from this browser.`, ok: 'Delete', danger: true });
        if (yes) { await PrivateStore.destroy(cur.id); toast('Deleted forever'); }
      }
    });

    li.append(main, actions);
    return li;
  }

  // ── list actions ────────────────────────────────────────────
  async function copyNote(n, btn) {
    if (await copyText(noteText(n))) { if (btn) flashButton(btn); toast('Note copied'); }
    else toast('Copy failed — select the text and copy manually.', 'error', 3500);
  }

  async function togglePin(section, n) {
    if (section === 'private') {
      await PrivateStore.update(n.id, { pinned: !n.pinned });
    } else {
      const updated = await attempt(() => api('PATCH', `/api/notes/${n.id}`, { pinned: !n.pinned }));
      if (updated) upsertShared(updated);
    }
    toast(n.pinned ? 'Unpinned' : 'Pinned');
  }

  async function deleteNote(section, n) {
    if (section === 'private') {
      await PrivateStore.trash(n.id);
      toast('Moved to trash', 'ok', 5000, { label: 'Undo', run: () => PrivateStore.restore(n.id) });
      return true;
    }
    const yes = await confirmDialog({ title: 'Delete for everyone?', message: `"${noteTitle(n)}" will be removed from every device connected to ${serverName()}.`, ok: 'Delete', danger: true });
    if (!yes) return false;
    const ok = await attempt(() => api('DELETE', `/api/notes/${n.id}`), 'Shared note deleted');
    if (ok) { state.notes = state.notes.filter((x) => x.id !== n.id); render(); }
    return Boolean(ok);
  }

  function upsertShared(n) {
    const i = state.notes.findIndex((x) => x.id === n.id);
    if (i >= 0) state.notes[i] = n; else state.notes.push(n);
    render();
  }

  async function setSection(section) {
    if (!SECTIONS.includes(section) || section === N.section) return;
    if (N.ed && !(await closeEditor())) return;
    N.section = section;
    N.tag = null;
    store.set('clipbox.notesSection', section);
    render();
  }

  // ── editor ──────────────────────────────────────────────────
  function openEditor(scope, note) {
    N.ed = {
      scope,
      id: note?.id || null,
      version: note?.version ?? null,
      dirty: false,
      saving: false,
      pending: false,
      seq: 0,
      timer: null,
      alert: null,
    };
    el('editor-title').value = note?.title || '';
    el('editor-tags').value = (note?.tags || []).join(', ');
    el('editor-body').value = note?.body || '';
    hideAlert();
    el('notes-list-view').hidden = true;
    el('note-editor').hidden = false;
    setStatus(note ? '' : 'New note');
    render();
    const readonly = el('editor-body').readOnly;
    if (!readonly) (note ? el('editor-body') : el('editor-title')).focus();
    window.scrollTo({ top: 0 });
  }

  function updateEditorChrome() {
    const ed = N.ed;
    const n = findNote(ed.scope, ed.id);
    const shared = ed.scope === 'shared';
    const badge = el('editor-badge');
    badge.className = `scope-badge ${ed.scope}`;
    badge.innerHTML = shared ? `${icon('users')}<span>Shared with everyone</span>` : `${icon('lock')}<span>Private · this browser only</span>`;

    const readonly = shared && !canEditShared(n || null);
    for (const id of ['editor-title', 'editor-tags', 'editor-body']) el(id).readOnly = readonly;
    const ro = el('editor-readonly');
    ro.hidden = !readonly;
    if (readonly) ro.textContent = isViewer() ? 'View only — the host made this device read-only.' : `Locked by ${n.authorName} — only they or the host can edit it.`;

    const pin = el('editor-pin');
    pin.hidden = readonly;
    pin.classList.toggle('on', Boolean(n?.pinned));
    pin.dataset.tip = n?.pinned ? 'Unpin' : 'Pin';

    const lock = el('editor-lock');
    lock.hidden = !shared || !n || !canLock(n);
    lock.classList.toggle('on', Boolean(n?.locked));
    lock.dataset.tip = n?.locked ? 'Locked — click to let everyone edit' : 'Only I can edit';
    lock.innerHTML = icon(n?.locked ? 'lock' : 'unlock');

    const move = el('editor-move');
    move.hidden = !shared && !canWriteShared();
    move.innerHTML = shared ? `${icon('lock')}<span>Make private copy</span>` : `${icon('share')}<span>Share…</span>`;
    const moveLabel = shared ? 'Save a private copy in this browser' : 'Share a copy with everyone';
    move.setAttribute('aria-label', moveLabel);
    move.dataset.tip = moveLabel;

    el('editor-delete').hidden = readonly;

    const meta = el('editor-meta');
    if (!n) meta.textContent = shared ? `Will be shared with everyone connected to ${serverName()}.` : 'Saved automatically in this browser.';
    else if (shared) meta.textContent = `Created by ${n.authorName} ${timeAgo(n.createdAt)} · last edited by ${n.updatedByName} ${timeAgo(n.updatedAt)}`;
    else meta.textContent = `Created ${new Date(n.createdAt).toLocaleString()} · edited ${timeAgo(n.updatedAt)}`;
  }

  function setStatus(text, error = false) {
    const s = el('editor-status');
    s.textContent = text;
    s.classList.toggle('error', error);
  }

  function readFields() {
    return {
      title: el('editor-title').value.trim(),
      body: el('editor-body').value,
      tags: parseTags(el('editor-tags').value),
    };
  }

  function fillFields(n) {
    const set = (id, v) => {
      const f = el(id);
      if (f.value === v) return;
      const focused = document.activeElement === f;
      const [a, b] = [f.selectionStart, f.selectionEnd];
      f.value = v;
      if (focused) f.setSelectionRange(Math.min(a, v.length), Math.min(b, v.length));
    };
    set('editor-title', n.title || '');
    set('editor-tags', (n.tags || []).join(', '));
    set('editor-body', n.body || '');
  }

  function onEditorInput() {
    const ed = N.ed;
    if (!ed || el('editor-body').readOnly) return;
    ed.dirty = true;
    ed.seq += 1;
    if (!ed.alert) setStatus('Editing…');
    clearTimeout(ed.timer);
    ed.timer = setTimeout(save, SAVE_DELAY[ed.scope]);
  }

  async function save() {
    const ed = N.ed;
    if (!ed || !ed.dirty || ed.alert) return;
    clearTimeout(ed.timer);
    const f = readFields();
    if (!f.title && !f.body.trim()) {
      setStatus(ed.id ? 'Empty notes are not saved' : '');
      return;
    }
    const seq = ed.seq;

    if (ed.scope === 'private') {
      try {
        if (!ed.id) {
          const n = await PrivateStore.create(f);
          ed.id = n.id;
          PrivateStore.requestPersist();
        } else {
          await PrivateStore.update(ed.id, f);
        }
        if (ed.seq === seq) ed.dirty = false;
        if (N.ed === ed) { setStatus('Saved on this device'); updateEditorChrome(); }
      } catch (err) {
        setStatus(`Not saved: ${err.message}`, true);
      }
      return;
    }

    if (ed.saving) { ed.pending = true; return; }
    ed.saving = true;
    setStatus('Saving…');
    try {
      const n = ed.id
        ? await api('PATCH', `/api/notes/${ed.id}`, { ...f, baseVersion: ed.version })
        : await api('POST', '/api/notes', f);
      ed.id = n.id;
      ed.version = n.version;
      upsertShared(n);
      if (ed.seq === seq) ed.dirty = false;
      if (N.ed === ed) setStatus('Saved · shared');
    } catch (err) {
      if (N.ed !== ed) return;
      if (err.status === 409 && err.data?.note) showConflict(err.data.note);
      else if (err.status === 404) showDeleted();
      else if (err.status === 0) {
        setStatus('Offline — will retry', true);
        ed.timer = setTimeout(save, 3000);
      } else setStatus(`Not saved: ${err.message}`, true);
    } finally {
      ed.saving = false;
      if (ed.pending) {
        ed.pending = false;
        if (ed.dirty && N.ed === ed) save();
      }
    }
  }

  // ── conflict / deleted-elsewhere alerts ─────────────────────
  function showAlert(msg, buttons) {
    el('editor-alert-msg').textContent = msg;
    ['alert-primary', 'alert-secondary', 'alert-tertiary'].forEach((id, i) => {
      const b = el(id);
      const spec = buttons[i];
      b.hidden = !spec;
      if (spec) {
        b.textContent = spec.label;
        b.onclick = spec.run;
      }
    });
    el('editor-alert').hidden = false;
  }

  function hideAlert() {
    el('editor-alert').hidden = true;
    if (N.ed) N.ed.alert = null;
  }

  function showConflict(server) {
    const ed = N.ed;
    ed.alert = 'conflict';
    setStatus('Not saved', true);
    showAlert(`This note was changed on ${server.updatedByName} while you were editing.`, [
      { label: 'Keep mine', run: () => { ed.version = server.version; hideAlert(); ed.dirty = true; save(); } },
      { label: 'Use theirs', run: () => { fillFields(server); ed.version = server.version; ed.dirty = false; hideAlert(); setStatus(`Showing ${server.updatedByName}'s version`); } },
      { label: 'Copy mine', run: () => copyNote(readFields()) },
    ]);
  }

  function showDeleted() {
    const ed = N.ed;
    ed.alert = 'deleted';
    setStatus('Not saved', true);
    showAlert('This note was deleted on another device.', [
      { label: 'Save as new note', run: () => { ed.id = null; ed.version = null; hideAlert(); ed.dirty = true; save(); } },
      { label: 'Discard', run: () => { ed.dirty = false; hideAlert(); closeEditor(); } },
      { label: 'Copy text', run: () => copyNote(readFields()) },
    ]);
  }

  /** @returns {Promise<boolean>} true if the editor was closed */
  async function closeEditor() {
    const ed = N.ed;
    if (!ed) return true;
    clearTimeout(ed.timer);
    while (ed.saving) await sleep(40);
    if (ed.dirty && !ed.alert) await save();
    while (ed.saving) await sleep(40);
    if (ed.alert || (ed.dirty && (readFields().title || readFields().body.trim()))) {
      const leave = await confirmDialog({
        title: 'Leave without saving?',
        message: ed.alert ? 'Your latest changes have not been saved yet.' : 'Your latest changes could not be saved (are you offline?).',
        ok: 'Leave',
        danger: true,
      });
      if (!leave) return false;
    }
    N.ed = null;
    el('note-editor').hidden = true;
    el('notes-list-view').hidden = false;
    hideAlert();
    render();
    return true;
  }

  // ── editor actions ──────────────────────────────────────────
  async function ensureSaved() {
    const ed = N.ed;
    if (ed.dirty) await save();
    while (ed.saving) await sleep(40);
    return ed.id;
  }

  async function editorPin() {
    const ed = N.ed;
    if (!(await ensureSaved())) return toast('Write something first.', 'error');
    const n = findNote(ed.scope, ed.id);
    if (n) await togglePin(ed.scope, n);
  }

  async function editorLock() {
    const ed = N.ed;
    const n = findNote('shared', ed.id);
    if (!n) return;
    const updated = await attempt(() => api('PATCH', `/api/notes/${n.id}`, { locked: !n.locked }), n.locked ? 'Unlocked — everyone can edit' : 'Locked — only you and the host can edit');
    if (updated) upsertShared(updated);
  }

  async function editorMove() {
    const ed = N.ed;
    const f = readFields();
    if (!f.title && !f.body.trim()) return toast('Write something first.', 'error');
    if (ed.scope === 'private') {
      const yes = await confirmDialog({
        title: 'Share this note?',
        message: `A copy will be visible to everyone connected to ${serverName()}. Your private note stays private.`,
        ok: 'Share',
      });
      if (!yes) return;
      await ensureSaved();
      const n = await attempt(() => api('POST', '/api/notes', f));
      if (n) {
        upsertShared(n);
        toast('Shared a copy with everyone', 'ok', 5000, { label: 'View', run: () => goTo('shared', n.id) });
      }
    } else {
      const n = await PrivateStore.create(f);
      PrivateStore.requestPersist();
      toast('Saved a private copy in this browser', 'ok', 5000, { label: 'View', run: () => goTo('private', n.id) });
    }
  }

  async function goTo(section, id) {
    if (N.ed && !(await closeEditor())) return;
    if (state.view !== 'notes') setView('notes');
    N.section = section;
    store.set('clipbox.notesSection', section);
    const n = findNote(section, id);
    if (n) openEditor(section, n); else render();
  }

  async function editorDelete() {
    const ed = N.ed;
    if (!ed.id) { ed.dirty = false; await closeEditor(); return; }
    const n = findNote(ed.scope, ed.id);
    if (!n) return;
    clearTimeout(ed.timer);
    if (ed.scope === 'private') {
      ed.dirty = false;
      await PrivateStore.trash(n.id);
      N.ed = null;
      el('note-editor').hidden = true;
      el('notes-list-view').hidden = false;
      render();
      toast('Moved to trash', 'ok', 5000, { label: 'Undo', run: () => PrivateStore.restore(n.id) });
    } else if (await deleteNote('shared', n)) {
      ed.dirty = false;
      N.ed = null;
      el('note-editor').hidden = true;
      el('notes-list-view').hidden = false;
      render();
    }
  }

  // ── external changes ────────────────────────────────────────
  /** Shared notes changed (live event, snapshot or role change). */
  function onShared(ev) {
    if (!N.ready) return;
    const ed = N.ed;
    if (ed && ed.scope === 'shared' && ed.id && !ed.saving && !ed.alert) {
      const n = findNote('shared', ed.id);
      if (!n) {
        if (ed.dirty) showDeleted();
        else {
          toast('This note was deleted on another device.', 'error', 3500);
          N.ed = null;
          el('note-editor').hidden = true;
          el('notes-list-view').hidden = false;
        }
      } else if (n.version > ed.version && !ed.dirty) {
        fillFields(n);
        ed.version = n.version;
        setStatus(`Updated by ${n.updatedByName}`);
      }
    }
    render();
    if (ev && ev.type === 'note' && !N.visible && ev.note.updatedBy !== me().deviceId && ev.note.version === 1 && ev.note.createdAt === ev.note.updatedAt) {
      el('tab-notes').classList.add('dot');
    }
  }

  /** Private notes changed in another tab of this browser. */
  function onPrivateExternal() {
    const ed = N.ed;
    if (!ed || ed.scope !== 'private' || !ed.id || ed.dirty) return;
    const n = findNote('private', ed.id);
    if (!n) {
      toast('This note was deleted in another tab.', 'error', 3500);
      N.ed = null;
      el('note-editor').hidden = true;
      el('notes-list-view').hidden = false;
    } else fillFields(n);
  }

  // ── backup ──────────────────────────────────────────────────
  async function checkReminder() {
    const box = el('backup-reminder');
    if (N.section !== 'private' || N.priv.length < 10) { box.hidden = true; return; }
    const [last, snooze] = await Promise.all([PrivateStore.getMeta('lastExportAt'), PrivateStore.getMeta('reminderSnoozedUntil')]);
    const since = last || Math.min(...N.priv.map((n) => n.createdAt));
    box.hidden = !(Date.now() - since > 30 * DAY && !(snooze > Date.now()));
  }

  async function exportPrivate() {
    const data = await PrivateStore.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `clipbox-private-notes-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`Exported ${data.notes.length} private note${data.notes.length === 1 ? '' : 's'}`);
    checkReminder();
  }

  async function importPrivate(file) {
    try {
      const data = JSON.parse(await file.text());
      const r = await PrivateStore.importData(data);
      toast(`Imported ${r.added} new, ${r.updated} updated${r.skipped ? `, ${r.skipped} unchanged` : ''}`);
    } catch (err) {
      toast(err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message, 'error', 4000);
    }
  }

  // ── wiring ──────────────────────────────────────────────────
  function wire() {
    document.querySelectorAll('.section-btn').forEach((b) => b.addEventListener('click', () => setSection(b.dataset.section)));
    el('notes-search').addEventListener('input', (e) => { N.query = e.target.value.trim(); renderList(); });
    el('btn-new-note').addEventListener('click', () => openEditor(N.section === 'shared' ? 'shared' : 'private', null));

    el('section-banner').addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'info') { N.infoOpen = !N.infoOpen; renderBanner(); }
      else if (act === 'export') exportPrivate();
      else if (act === 'import') el('import-input').click();
      else if (act === 'empty-trash') {
        const yes = await confirmDialog({ title: 'Empty trash?', message: `${N.trash.length} note${N.trash.length === 1 ? '' : 's'} will be permanently deleted from this browser.`, ok: 'Empty trash', danger: true });
        if (yes) toast(`Deleted ${await PrivateStore.emptyTrash()} notes forever`);
      }
    });
    el('import-input').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) importPrivate(f);
    });
    el('reminder-export').addEventListener('click', exportPrivate);
    el('reminder-later').addEventListener('click', async () => {
      await PrivateStore.setMeta('reminderSnoozedUntil', Date.now() + 7 * DAY);
      el('backup-reminder').hidden = true;
    });

    for (const id of ['editor-title', 'editor-tags', 'editor-body']) el(id).addEventListener('input', onEditorInput);
    el('editor-back').addEventListener('click', closeEditor);
    el('editor-copy').addEventListener('click', (e) => copyNote(readFields(), e.currentTarget));
    el('editor-pin').addEventListener('click', editorPin);
    el('editor-lock').addEventListener('click', editorLock);
    el('editor-move').addEventListener('click', editorMove);
    el('editor-delete').addEventListener('click', editorDelete);
    el('note-editor').addEventListener('keydown', (e) => {
      if (document.querySelector('dialog[open]')) return;
      if (e.key === 'Escape') { e.preventDefault(); closeEditor(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    });

    // Save on tab switch / close; warn if a shared edit is still unsaved.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && N.ed?.dirty) save(); });
    window.addEventListener('beforeunload', (e) => {
      if (N.ed?.dirty) {
        save();
        if (N.ed.scope === 'shared') { e.preventDefault(); e.returnValue = ''; }
      }
    });
  }

  return {
    init,
    render,
    onShared,
    show() {
      N.visible = true;
      el('tab-notes').classList.remove('dot');
      render();
    },
    hide() {
      N.visible = false;
      if (N.ed?.dirty) save();
    },
    focusSearch() {
      if (!N.ed) el('notes-search').focus();
    },
  };
})();
