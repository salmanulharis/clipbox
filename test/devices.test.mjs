// Devices, roles, pairing and revocation (Phase 1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, call, cookieHeader, bearer, REMOTE } from './helpers.mjs';

let srv;
let B;
const api = (...args) => call(B, ...args);

const pairWithToken = async (name = 'Test Phone') => {
  const { data } = await api('GET', '/api/connect');
  return api('POST', '/api/devices/pair', { pairToken: data.token, name, platform: 'android' }, REMOTE);
};

before(async () => {
  srv = await startServer();
  B = srv.base;
});
after(() => srv?.stop());

test('/api/info identifies the server without exposing data', async () => {
  const { status, data } = await api('GET', '/api/info', undefined, REMOTE);
  assert.equal(status, 200);
  assert.equal(data.app, 'clipbox');
  assert.equal(data.apiVersion, 2);
  assert.match(data.serverId, /^srv_/);
  assert.ok(data.serverName);
  assert.equal(data.authRequired, true);
  assert.equal(data.clipboards, undefined);
});

test('browsers get a device cookie; the server machine is host; state never includes devices', async () => {
  const r = await api('GET', '/api/state');
  assert.equal(r.status, 200);
  assert.equal(r.data.me.role, 'host');
  assert.match(r.data.me.deviceId, /^dev_/);
  assert.match(cookieHeader(r.headers), /clipbox_device=/);
  assert.equal(r.data.devices, undefined);
  assert.equal(JSON.stringify(r.data).includes('tokenHash'), false);
});

test('QR links carry the server fragment', async () => {
  const { data } = await api('GET', '/api/connect');
  const { data: info } = await api('GET', '/api/info');
  assert.equal(data.fragment, `#cb1.${info.serverId}`);
  for (const u of data.urls) assert.ok(u.link.endsWith(data.fragment), u.link);
});

test('pair tokens register exactly one app device', async () => {
  const { data: c } = await api('GET', '/api/connect');
  const first = await api('POST', '/api/devices/pair', { pairToken: c.token, name: 'Phone A', platform: 'android' }, REMOTE);
  assert.equal(first.status, 201);
  assert.match(first.data.deviceToken, /^cbd_/);
  assert.equal(first.data.role, 'member');
  assert.ok(Array.isArray(first.data.urls));
  const again = await api('POST', '/api/devices/pair', { pairToken: c.token, name: 'Phone B' }, REMOTE);
  assert.equal(again.status, 401);
  assert.equal(again.data.reason, 'pair_expired');
});

test('pairing remotely needs a token or the password', async () => {
  const none = await api('POST', '/api/devices/pair', { name: 'x' }, REMOTE);
  assert.equal(none.status, 401);
  const wrong = await api('POST', '/api/devices/pair', { password: 'nope' }, REMOTE);
  assert.equal(wrong.status, 401);
  const ok = await api('POST', '/api/devices/pair', { password: 'test-password', name: 'Owner phone', platform: 'android' }, REMOTE);
  assert.equal(ok.status, 201);
  assert.equal(ok.data.role, 'host', 'pairing with the password makes a host device');
});

test('bearer devices work remotely, need no CSRF header, and see their identity', async () => {
  const { data: p } = await pairWithToken('Bearer phone');
  const auth = { ...REMOTE, ...bearer(p.deviceToken) };
  const state = await api('GET', '/api/state', undefined, auth);
  assert.equal(state.status, 200);
  assert.equal(state.data.me.deviceId, p.deviceId);
  assert.equal(state.data.me.role, 'member');
  assert.equal(state.headers.getSetCookie().length, 0, 'no cookies for bearer clients');
  const cb = state.data.clipboards[0];
  const add = await api('POST', `/api/clipboards/${cb.id}/items`, { text: 'from bearer' }, auth);
  assert.equal(add.status, 201);
  assert.equal((await api('GET', '/api/state', undefined, { ...REMOTE, ...bearer('cbd_bogus') })).status, 401);
});

test('device management is host-only and never returns token hashes', async () => {
  const { data: p } = await pairWithToken('Member phone');
  const member = await api('GET', '/api/devices', undefined, { ...REMOTE, ...bearer(p.deviceToken) });
  assert.equal(member.status, 403);
  const host = await api('GET', '/api/devices');
  assert.equal(host.status, 200);
  const d = host.data.devices.find((x) => x.id === p.deviceId);
  assert.equal(d.name, 'Member phone');
  assert.equal(d.app, true);
  assert.equal(JSON.stringify(host.data).includes('tokenHash'), false);
});

test('viewers are read-only; revoked devices are rejected', async () => {
  const { data: p } = await pairWithToken('Soon viewer');
  const auth = { ...REMOTE, ...bearer(p.deviceToken) };
  const cb = (await api('GET', '/api/state', undefined, auth)).data.clipboards[0];

  assert.equal((await api('PATCH', `/api/devices/${p.deviceId}`, { role: 'viewer' })).status, 200);
  assert.equal((await api('GET', '/api/state', undefined, auth)).status, 200);
  const write = await api('POST', `/api/clipboards/${cb.id}/items`, { text: 'nope' }, auth);
  assert.equal(write.status, 403);
  assert.equal(write.data.reason, 'forbidden');

  assert.equal((await api('PATCH', `/api/devices/${p.deviceId}`, { revoked: true })).status, 200);
  const after = await api('GET', '/api/state', undefined, auth);
  assert.equal(after.status, 401);
  assert.equal(after.data.reason, 'device_revoked');
});

test('revoking a device closes its live connection', async () => {
  const { data: p } = await pairWithToken('Live phone');
  const res = await fetch(`${B}/api/events`, { headers: { ...REMOTE, ...bearer(p.deviceToken) } });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  await reader.read(); // padding + hello
  await api('PATCH', `/api/devices/${p.deviceId}`, { revoked: true });
  let done = false;
  for (let i = 0; i < 5 && !done; i++) ({ done } = await reader.read());
  assert.equal(done, true);
});

test('a device can disconnect itself', async () => {
  const { data: p } = await pairWithToken('Leaving phone');
  const auth = { ...REMOTE, ...bearer(p.deviceToken) };
  assert.equal((await api('DELETE', '/api/devices/me', undefined, auth)).status, 200);
  assert.equal((await api('GET', '/api/state', undefined, auth)).status, 401);
});

test('browser sessions are bound to a device and end when it is revoked', async () => {
  const login = await api('POST', '/api/login', { password: 'test-password' }, REMOTE);
  assert.equal(login.status, 200);
  const cookie = cookieHeader(login.headers);
  assert.match(cookie, /clipbox_session=.*clipbox_device=/);
  const state = await api('GET', '/api/state', undefined, { ...REMOTE, Cookie: cookie });
  assert.equal(state.status, 200);
  assert.equal(state.data.me.role, 'host');
  await api('PATCH', `/api/devices/${state.data.me.deviceId}`, { revoked: true });
  const after = await api('GET', '/api/state', undefined, { ...REMOTE, Cookie: cookie });
  assert.equal(after.status, 401);
  assert.equal(after.data.reason, 'device_revoked');
});

test('QR join in a browser creates a member device', async () => {
  const { data } = await api('GET', '/api/connect');
  const join = await api('GET', `/join?t=${encodeURIComponent(data.token)}`, undefined, REMOTE);
  assert.equal(join.status, 302);
  const cookie = cookieHeader(join.headers);
  const state = await api('GET', '/api/state', undefined, { ...REMOTE, Cookie: cookie });
  assert.equal(state.data.me.role, 'member');
});

test('raw device tokens are never written to disk', async () => {
  const { data: p } = await pairWithToken('Disk check');
  await new Promise((r) => setTimeout(r, 900)); // debounced save
  const db = readFileSync(join(srv.dataDir, 'db.json'), 'utf8');
  assert.equal(db.includes(p.deviceToken), false);
  assert.ok(db.includes(p.deviceId));
});
