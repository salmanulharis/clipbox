// Groups: visibility on every route, invitations, live-event filtering, management, migration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, call, bearer, REMOTE, tempDir } from './helpers.mjs';

let srv;
let B;
const api = (...args) => call(B, ...args);

/** Pair an app device (optionally via a group invitation) and return its auth headers. */
async function device(name, groupId) {
  const { data: c } = await api('GET', `/api/connect${groupId ? `?group=${groupId}` : ''}`);
  const { data: p } = await api('POST', '/api/devices/pair', { pairToken: c.token, name, platform: 'android' }, REMOTE);
  return { ...REMOTE, ...bearer(p.deviceToken), id: p.deviceId, groupId: p.groupId };
}
const h = ({ id, groupId, ...rest }) => rest;

/** Read SSE events from a stream until `stop` returns true. */
async function readEvents(headers, during, stop) {
  const ac = new AbortController();
  const res = await fetch(`${B}/api/events`, { headers, signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      if (stop(buf)) break;
    }
  })();
  while (!buf.includes('event: hello')) await new Promise((r) => setTimeout(r, 20));
  await during();
  await Promise.race([pump, new Promise((r) => setTimeout(r, 1500))]);
  ac.abort();
  return buf;
}

before(async () => {
  srv = await startServer();
  B = srv.base;
});
after(() => srv?.stop());

test('everything starts in the visible "Everyone" group', async () => {
  const { data } = await api('GET', '/api/state');
  assert.equal(data.groups.length, 1);
  assert.equal(data.groups[0].id, 'grp_everyone');
  assert.equal(data.groups[0].access, 'all');
  assert.ok(data.clipboards.every((c) => c.groupId === 'grp_everyone'));
  assert.equal((await api('DELETE', '/api/groups/grp_everyone')).status, 400, "can't delete Everyone");
  assert.equal((await api('PATCH', '/api/groups/grp_everyone', { access: 'members' })).status, 400);
});

test('only the host manages groups', async () => {
  const m = await device('Member');
  assert.equal((await api('POST', '/api/groups', { name: 'Nope' }, h(m))).status, 403);
  const g = await api('POST', '/api/groups', { name: 'Family' });
  assert.equal(g.status, 201);
  assert.equal(g.data.access, 'members', 'new groups are invite-only by default');
  assert.equal((await api('PATCH', `/api/groups/${g.data.id}`, { name: 'x' }, h(m))).status, 403);
});

test('members-only groups are invisible to non-members on every route', async () => {
  const outsider = await device('Outsider');
  const { data: g } = await api('POST', '/api/groups', { name: 'Secret' });
  const { data: state } = await api('GET', '/api/state');
  const cb = state.clipboards.find((c) => c.groupId === g.id);
  assert.ok(cb, 'a new group comes with a General clipboard');
  const { data: item } = await api('POST', `/api/clipboards/${cb.id}/items`, { text: 'top secret' });
  const { data: note } = await api('POST', '/api/notes', { title: 'Secret plan', groupId: g.id });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const file = await (await fetch(`${B}/api/clipboards/${cb.id}/files`, {
    method: 'POST', headers: { 'X-ClipBox': '1', 'Content-Type': 'image/png', 'X-Filename': 'p.png' }, body: png,
  })).json();

  const { data: os } = await api('GET', '/api/state', undefined, h(outsider));
  const blob = JSON.stringify(os);
  assert.equal(os.groups.some((x) => x.id === g.id), false);
  assert.equal(blob.includes('top secret') || blob.includes('Secret plan') || blob.includes(cb.id), false, 'nothing leaks in state');

  const H = h(outsider);
  assert.equal((await api('POST', `/api/clipboards/${cb.id}/items`, { text: 'x' }, H)).status, 404);
  assert.equal((await api('PATCH', `/api/clipboards/${cb.id}`, { name: 'x' }, H)).status, 404);
  assert.equal((await api('POST', `/api/clipboards/${cb.id}/clear`, undefined, H)).status, 404);
  assert.equal((await api('DELETE', `/api/clipboards/${cb.id}/items/${item.id}`, undefined, H)).status, 404);
  assert.equal((await api('DELETE', `/api/clipboards/${cb.id}`, undefined, H)).status, 404);
  assert.equal((await api('PATCH', `/api/notes/${note.id}`, { body: 'x', baseVersion: 1 }, H)).status, 404);
  assert.equal((await api('DELETE', `/api/notes/${note.id}`, undefined, H)).status, 404);
  assert.equal((await api('POST', '/api/notes', { title: 'x', groupId: g.id }, H)).status, 404);
  assert.equal((await api('POST', '/api/clipboards', { name: 'x', groupId: g.id }, H)).status, 404);
  assert.equal((await fetch(`${B}/files/${file.id}`, { headers: H })).status, 404, 'files too');
  assert.equal((await api('GET', `/api/connect?group=${g.id}`, undefined, H)).status, 404);

  // The host still sees everything.
  assert.equal((await fetch(`${B}/files/${file.id}`)).status, 200);
});

test('a group invitation QR adds the device to that group', async () => {
  const { data: g } = await api('POST', '/api/groups', { name: 'Work' });
  const invited = await device('Invited phone', g.id);
  assert.equal(invited.groupId, g.id, 'the pair response names the invited group');
  const { data: s } = await api('GET', '/api/state', undefined, h(invited));
  assert.ok(s.groups.some((x) => x.id === g.id));
  assert.equal(s.groups.find((x) => x.id === g.id).members, undefined, 'members list is host-only');
  const { data: groups } = await api('GET', '/api/groups');
  assert.ok(groups.groups.find((x) => x.id === g.id).members.includes(invited.id));
  // Members can work in the group.
  const cb = s.clipboards.find((c) => c.groupId === g.id);
  assert.equal((await api('POST', `/api/clipboards/${cb.id}/items`, { text: 'hello work' }, h(invited))).status, 201);
  // Invite links always carry a token, even on the LAN.
  const { data: c } = await api('GET', `/api/connect?group=${g.id}`);
  assert.equal(c.group.name, 'Work');
  for (const u of c.urls) assert.match(u.link, /\/join\?t=/);
});

test('browser /join with a group invitation adds membership', async () => {
  const { data: g } = await api('POST', '/api/groups', { name: 'Browser group' });
  const { data: c } = await api('GET', `/api/connect?group=${g.id}`);
  const join = await api('GET', `/join?t=${encodeURIComponent(c.token)}`, undefined, REMOTE);
  // Remote join only works with a password; this server has one (test-password).
  assert.equal(join.status, 302);
  const cookie = join.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ');
  const { data: s } = await api('GET', '/api/state', undefined, { ...REMOTE, Cookie: cookie });
  assert.ok(s.groups.some((x) => x.id === g.id));
});

test('live events for other groups arrive as empty "skip" events', async () => {
  const outsider = await device('Listener');
  const { data: g } = await api('POST', '/api/groups', { name: 'Hidden' });
  const { data: state } = await api('GET', '/api/state');
  const cb = state.clipboards.find((c) => c.groupId === g.id);
  const buf = await readEvents(h(outsider), async () => {
    await api('POST', `/api/clipboards/${cb.id}/items`, { text: 'whisper-123' });
    await api('POST', '/api/notes', { title: 'whisper-note', groupId: g.id });
  }, (b) => (b.match(/"type":"skip"/g) || []).length >= 2);
  assert.equal(buf.includes('whisper'), false, 'no content from other groups');
  assert.equal(buf.includes(cb.id), false, 'not even ids');
  assert.ok((buf.match(/"type":"skip"/g) || []).length >= 2);

  // A member of the group gets the real event.
  const member = await device('Member listener', g.id);
  const buf2 = await readEvents(h(member), () => api('POST', `/api/clipboards/${cb.id}/items`, { text: 'visible-456' }), (b) => b.includes('visible-456'));
  assert.ok(buf2.includes('visible-456'));
});

test('opening a group to everyone, removing members and deleting groups', async () => {
  const d = await device('Watcher');
  const { data: g } = await api('POST', '/api/groups', { name: 'Temp' });
  const see = async () => (await api('GET', '/api/state', undefined, h(d))).data.groups.some((x) => x.id === g.id);
  assert.equal(await see(), false);
  await api('PATCH', `/api/groups/${g.id}`, { access: 'all' });
  assert.equal(await see(), true);
  await api('PATCH', `/api/groups/${g.id}`, { access: 'members', members: [d.id] });
  assert.equal(await see(), true);
  await api('PATCH', `/api/groups/${g.id}`, { members: [] });
  assert.equal(await see(), false);

  const { data: state } = await api('GET', '/api/state');
  const cbCount = state.clipboards.filter((c) => c.groupId === g.id).length;
  assert.equal(cbCount, 1);
  assert.equal((await api('DELETE', `/api/groups/${g.id}`)).status, 200);
  const after = (await api('GET', '/api/state')).data;
  assert.equal(after.groups.some((x) => x.id === g.id), false);
  assert.equal(after.clipboards.some((c) => c.groupId === g.id), false, "the group's clipboards are deleted with it");
});

test('removing a device also removes it from its groups', async () => {
  const { data: g } = await api('POST', '/api/groups', { name: 'Leaving' });
  const d = await device('Short-lived', g.id);
  assert.equal((await api('DELETE', '/api/devices/me', undefined, h(d))).status, 200);
  const { data } = await api('GET', '/api/groups');
  assert.equal(data.groups.find((x) => x.id === g.id).members.includes(d.id), false);
});

test('v2 databases are upgraded to groups with a one-time backup', async () => {
  const dir = tempDir();
  const v2 = {
    version: 2, serverId: 'srv_old', serverName: 'Old', devices: [],
    clipboards: [{ id: 'cb_old', name: 'Old', createdAt: 1, updatedAt: 1, items: [] }],
    notes: [{ id: 'n_old', title: 'Old note', body: '', tags: [], version: 1, createdAt: 1, updatedAt: 1 }],
  };
  writeFileSync(join(dir, 'db.json'), JSON.stringify(v2));
  const s2 = await startServer({ dataDir: dir, keepData: true });
  try {
    const db = JSON.parse(readFileSync(join(dir, 'db.json'), 'utf8'));
    assert.equal(db.version, 3);
    assert.equal(db.groups[0].id, 'grp_everyone');
    assert.equal(db.clipboards[0].groupId, 'grp_everyone');
    assert.equal(db.notes[0].groupId, 'grp_everyone');
    assert.ok(existsSync(join(dir, 'db.v2-backup.json')));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'db.v2-backup.json'), 'utf8')), v2);
  } finally {
    await s2.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
