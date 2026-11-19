// Shared notes: CRUD, validation, optimistic concurrency, locks, roles, live events.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, call, bearer, REMOTE, ROOT } from './helpers.mjs';

let srv;
let B;
const api = (...args) => call(B, ...args);

/** Pair an app device and return request headers for it. */
async function device(name, role) {
  const { data: c } = await api('GET', '/api/connect');
  const { data: p } = await api('POST', '/api/devices/pair', { pairToken: c.token, name, platform: 'android' }, REMOTE);
  if (role) await api('PATCH', `/api/devices/${p.deviceId}`, { role });
  return { ...REMOTE, ...bearer(p.deviceToken), id: p.deviceId };
}
const headers = ({ id, ...h }) => h;

before(async () => {
  srv = await startServer({ env: { NOTE_MAX_KB: '1' } });
  B = srv.base;
});
after(() => srv?.stop());

test('create, list and delete a shared note', async () => {
  const a = await device('Phone A');
  const created = await api('POST', '/api/notes', { title: '  Wi-Fi\n details ', body: 'pass: hunter2', tags: ['#home', 'Home', 'two words'] }, headers(a));
  assert.equal(created.status, 201);
  const n = created.data;
  assert.match(n.id, /^n_/);
  assert.equal(n.title, 'Wi-Fi details');
  assert.deepEqual(n.tags, ['home', 'two-words'], 'tags are cleaned and de-duplicated');
  assert.equal(n.version, 1);
  assert.equal(n.authorId, a.id);
  assert.equal(n.authorName, 'Phone A');

  const state = await api('GET', '/api/state');
  assert.ok(state.data.notes.some((x) => x.id === n.id));

  assert.equal((await api('DELETE', `/api/notes/${n.id}`, undefined, headers(a))).status, 200);
  assert.equal((await api('DELETE', `/api/notes/${n.id}`, undefined, headers(a))).status, 404);
});

test('validation: empty and oversized notes are rejected', async () => {
  assert.equal((await api('POST', '/api/notes', { title: ' ', body: '  ' })).status, 400);
  assert.equal((await api('POST', '/api/notes', { body: 'x'.repeat(2000) })).status, 413);
  assert.equal((await api('POST', '/api/notes', { title: 'x'.repeat(201) })).status, 400);
  assert.equal((await api('POST', '/api/notes', { title: 'ok', tags: 'nope' })).status, 400);
});

test('edits need baseVersion; stale edits get 409 with the current note', async () => {
  const { data: n } = await api('POST', '/api/notes', { title: 'Draft', body: 'v1' });
  assert.equal((await api('PATCH', `/api/notes/${n.id}`, { body: 'no version' })).status, 400);

  const ok = await api('PATCH', `/api/notes/${n.id}`, { body: 'v2', baseVersion: 1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.version, 2);

  const stale = await api('PATCH', `/api/notes/${n.id}`, { body: 'v2 from elsewhere', baseVersion: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.reason, 'conflict');
  assert.equal(stale.data.note.body, 'v2');
  assert.equal(stale.data.note.version, 2);
});

test('pinning does not bump the version or cause conflicts', async () => {
  const { data: n } = await api('POST', '/api/notes', { title: 'Pin me' });
  const pinned = await api('PATCH', `/api/notes/${n.id}`, { pinned: true });
  assert.equal(pinned.status, 200);
  assert.equal(pinned.data.pinned, true);
  assert.equal(pinned.data.version, 1);
  assert.equal((await api('PATCH', `/api/notes/${n.id}`, { title: 'Pinned', baseVersion: 1 })).status, 200);
});

test('locked notes: only the author or a host can change them', async () => {
  const author = await device('Author');
  const other = await device('Other');
  const { data: n } = await api('POST', '/api/notes', { title: 'Mine', locked: true }, headers(author));
  assert.equal(n.locked, true);

  const blocked = await api('PATCH', `/api/notes/${n.id}`, { body: 'hijack', baseVersion: 1 }, headers(other));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.reason, 'locked');
  assert.equal((await api('DELETE', `/api/notes/${n.id}`, undefined, headers(other))).status, 403);

  assert.equal((await api('PATCH', `/api/notes/${n.id}`, { body: 'by author', baseVersion: 1 }, headers(author))).status, 200);
  assert.equal((await api('PATCH', `/api/notes/${n.id}`, { body: 'by host', baseVersion: 2 })).status, 200, 'server machine is host');

  // only the author/host may unlock; others can't even lock someone else's note
  const { data: open } = await api('POST', '/api/notes', { title: 'Open' }, headers(author));
  assert.equal((await api('PATCH', `/api/notes/${open.id}`, { locked: true }, headers(other))).status, 403);
  assert.equal((await api('PATCH', `/api/notes/${n.id}`, { locked: false }, headers(author))).status, 200);
});

test('viewers can read but not write shared notes', async () => {
  const viewer = await device('Viewer', 'viewer');
  assert.equal((await api('GET', '/api/state', undefined, headers(viewer))).status, 200);
  assert.equal((await api('POST', '/api/notes', { title: 'nope' }, headers(viewer))).status, 403);
});

test('note changes are pushed live', async () => {
  const ac = new AbortController();
  const res = await fetch(`${B}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const until = async (re) => {
    while (!re.test(buf)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
    }
  };
  await until(/event: hello/);
  const { data: n } = await api('POST', '/api/notes', { title: 'Live note' });
  await until(/"type":"note"[\s\S]*Live note/);
  await api('DELETE', `/api/notes/${n.id}`);
  await until(new RegExp(`"type":"note-remove"[^\\n]*"id":"${n.id}"`));
  ac.abort();
});

test('privacy: the server has no concept of private notes', async () => {
  const state = await api('GET', '/api/state');
  assert.deepEqual(Object.keys(state.data).sort(), ['boot', 'clipboards', 'groups', 'me', 'notes', 'rev', 'server']);
  for (const path of ['/api/private', '/api/notes/private', '/api/private-notes']) {
    assert.equal((await api('POST', path, { title: 'x' })).status, 404, path);
  }
  await new Promise((r) => setTimeout(r, 400));
  const db = JSON.parse(readFileSync(join(srv.dataDir, 'db.json'), 'utf8'));
  assert.deepEqual(Object.keys(db).sort(), ['clipboards', 'devices', 'groups', 'notes', 'serverId', 'serverName', 'version']);
});

test('privacy: the browser private-note store contains no network code', () => {
  const src = readFileSync(join(ROOT, 'public', 'private-store.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  for (const banned of ['fetch(', 'XMLHttpRequest', 'EventSource', 'WebSocket', 'sendBeacon', 'api(', 'import(', 'importScripts']) {
    assert.equal(src.includes(banned), false, `private-store.js must not use ${banned}`);
  }
});
