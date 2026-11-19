// Database schema migration (v1 → v2) and forward-compatibility guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, call, tempDir } from './helpers.mjs';

const V1 = {
  version: 1,
  clipboards: [{
    id: 'oldClip0001', name: 'Legacy', createdAt: 1, updatedAt: 1,
    items: [{ id: 'oldItem0001', type: 'text', text: 'kept across upgrade', createdAt: 1, updatedAt: 1 }],
  }],
};

test('v1 databases are upgraded in place with a one-time backup', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'db.json'), JSON.stringify(V1));
  const srv = await startServer({ dataDir: dir, keepData: true });
  try {
    const { data } = await call(srv.base, 'GET', '/api/state');
    assert.equal(data.clipboards[0].items[0].text, 'kept across upgrade');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'db.v1-backup.json'), 'utf8')), V1);
    const db = JSON.parse(readFileSync(join(dir, 'db.json'), 'utf8'));
    assert.equal(db.version, 3);
    assert.equal(db.clipboards[0].groupId, 'grp_everyone');
    assert.match(db.serverId, /^srv_/);
    assert.deepEqual(db.notes, []);
    assert.ok(Array.isArray(db.devices));
  } finally {
    await srv.stop();
  }

  // serverId is stable across restarts
  const firstId = JSON.parse(readFileSync(join(dir, 'db.json'), 'utf8')).serverId;
  const again = await startServer({ dataDir: dir, keepData: true });
  try {
    const { data } = await call(again.base, 'GET', '/api/info');
    assert.equal(data.serverId, firstId);
  } finally {
    await again.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('fresh installs start at the current schema without backups', async () => {
  const srv = await startServer({ keepData: true });
  try {
    const db = JSON.parse(readFileSync(join(srv.dataDir, 'db.json'), 'utf8'));
    assert.equal(db.version, 3);
    assert.equal(existsSync(join(srv.dataDir, 'db.v1-backup.json')), false);
  } finally {
    await srv.stop();
    rmSync(srv.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a database from a newer ClipBox is refused, not overwritten', async () => {
  const dir = tempDir();
  const future = JSON.stringify({ version: 99, clipboards: [] });
  writeFileSync(join(dir, 'db.json'), future);
  const r = await startServer({ dataDir: dir, keepData: true });
  try {
    assert.notEqual(r.exitCode, 0);
    assert.match(r.output, /schema v99/);
    assert.equal(readFileSync(join(dir, 'db.json'), 'utf8'), future);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
