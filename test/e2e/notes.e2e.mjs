// Browser end-to-end tests for notes (real Chromium via Playwright).
// Run with: npm run test:e2e   (first time: npx playwright install chromium)
// Set SCREENSHOTS=<dir> to also save screenshots for visual review.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer, ROOT } from '../helpers.mjs';
import { pbkdf2Sync, createDecipheriv } from 'node:crypto';

let srv;
let browser;
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); };

/** Open ClipBox in a fresh browser context (separate storage = separate "device"). */
async function openApp({ viewport = { width: 1200, height: 800 }, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, acceptDownloads: true });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(`${r.method()} ${r.url()}\n${r.postData() || ''}`));
  page.on('pageerror', (e) => { throw e; });
  await page.goto(srv.base);
  await page.locator('#app').waitFor({ state: 'visible' });
  return { context, page, requests };
}

async function gotoNotes(page, section) {
  await page.click('#tab-notes');
  await page.click(`.section-btn[data-section="${section}"]`);
}

async function newNote(page, title, body) {
  await page.click('#btn-new-note');
  await page.fill('#editor-title', title);
  await page.fill('#editor-body', body);
  await page.locator('#editor-status', { hasText: /Saved/ }).waitFor();
}

async function back(page) {
  await page.click('#editor-back');
  await page.locator('#notes-list-view').waitFor({ state: 'visible' });
}

const rowTitles = (page) => page.locator('#notes-list .note-title').allInnerTexts();

const waitForValue = (page, selector, value) =>
  page.waitForFunction(([sel, v]) => document.querySelector(sel)?.value === v, [selector, value], { timeout: 5000 });

before(async () => {
  srv = await startServer();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await srv?.stop();
});

test('private notes stay in the browser: never sent over the network, survive reload', async () => {
  const { context, page, requests } = await openApp();
  const secret = `SECRET-${Date.now()}`;
  await gotoNotes(page, 'private');
  await shot(page, '01-private-empty');
  await newNote(page, `Private ${secret}`, `body ${secret}\nline two`);
  await shot(page, '02-private-editor');
  await back(page);
  assert.ok((await rowTitles(page)).some((t) => t.includes(secret)));
  await page.reload();
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.click('#tab-notes');
  assert.ok((await rowTitles(page)).some((t) => t.includes(secret)), 'still there after reload');
  await shot(page, '03-private-list');
  const leaked = requests.filter((r) => r.includes(secret));
  assert.deepEqual(leaked, [], 'private note text must never appear in any request');
  await context.close();
});

test('private notes are isolated per browser; shared notes sync live', async () => {
  const a = await openApp();
  const b = await openApp();
  const priv = `OnlyA-${Date.now()}`;
  const shared = `Team-${Date.now()}`;

  await gotoNotes(a.page, 'private');
  await newNote(a.page, priv, 'private to A');
  await back(a.page);

  await gotoNotes(b.page, 'private');
  assert.equal((await rowTitles(b.page)).some((t) => t.includes(priv)), false, "B must not see A's private note");

  await b.page.click('.section-btn[data-section="shared"]');
  await a.page.click('.section-btn[data-section="shared"]');
  await newNote(a.page, shared, 'for everyone');
  await back(a.page);
  await b.page.locator('#notes-list .note-title', { hasText: shared }).waitFor({ timeout: 5000 });
  await shot(b.page, '04-shared-list');

  await a.context.close();
  await b.context.close();
});

test('Share… copies a private note to shared after confirmation', async () => {
  const { context, page } = await openApp();
  const title = `ShareMe-${Date.now()}`;
  await gotoNotes(page, 'private');
  await newNote(page, title, 'to be shared');
  await page.click('#editor-move');
  await page.locator('#dlg-prompt[open]').waitFor();
  await shot(page, '05-share-confirm');
  await page.click('#prompt-ok');
  await page.locator('.toast', { hasText: 'Shared a copy' }).waitFor();
  await back(page);
  assert.ok((await rowTitles(page)).some((t) => t.includes(title)), 'private original stays');
  await page.click('.section-btn[data-section="shared"]');
  await page.locator('#notes-list .note-title', { hasText: title }).waitFor();
  await context.close();
});

test('concurrent edits to a shared note show a conflict that can be resolved', async () => {
  const a = await openApp();
  const b = await openApp();
  const title = `Conflict-${Date.now()}`;
  await gotoNotes(a.page, 'shared');
  await newNote(a.page, title, 'v1');
  await back(a.page);

  await gotoNotes(b.page, 'shared');
  await b.page.locator('#notes-list .note-title', { hasText: title }).click();
  await a.page.locator('#notes-list .note-title', { hasText: title }).click();

  // Both editors open on version 1. A types first; while A's save is pending, B saves.
  await b.page.fill('#editor-body', 'edited by B');
  await b.page.locator('#editor-status', { hasText: 'Saved' }).waitFor();
  // A's editor was clean, so it picked up B's version live.
  await waitForValue(a.page, '#editor-body', 'edited by B');

  // Now make A stale: block A's live updates by editing offline from its point of view.
  await a.page.evaluate(() => { window.__es = sync.es; sync.es.close(); });
  await b.page.fill('#editor-body', 'edited by B again');
  await b.page.locator('#editor-status', { hasText: 'Saved' }).waitFor();
  await a.page.fill('#editor-body', 'edited by A');
  await a.page.locator('#editor-alert').waitFor({ state: 'visible' });
  await shot(a.page, '06-conflict');
  await a.page.click('#alert-primary'); // Keep mine
  await a.page.locator('#editor-status', { hasText: 'Saved' }).waitFor();
  await waitForValue(b.page, '#editor-body', 'edited by A');
  await a.context.close();
  await b.context.close();
});

test('deleting a private note can be undone; trash keeps it', async () => {
  const { context, page } = await openApp();
  const title = `Undo-${Date.now()}`;
  await gotoNotes(page, 'private');
  await newNote(page, title, 'delete me');
  await back(page);
  const row = page.locator('.note-row', { hasText: title });
  await row.hover();
  await row.locator('[data-act="delete"]').click();
  await page.locator('.toast .toast-action', { hasText: 'Undo' }).click();
  await page.locator('#notes-list .note-title', { hasText: title }).waitFor();

  await row.hover();
  await row.locator('[data-act="delete"]').click();
  await page.click('.section-btn[data-section="trash"]');
  await page.locator('#notes-list .note-title', { hasText: title }).waitFor();
  await shot(page, '07-trash');
  await context.close();
});

test('a plain JSON backup is still available on request', async () => {
  const { context, page } = await openApp();
  const title = `Backup-${Date.now()}`;
  await gotoNotes(page, 'private');
  await newNote(page, title, 'backed up');
  await back(page);
  await page.click('[data-act="export"]');
  await page.locator('#dlg-pass[open]').waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#pass-secondary')]);
  assert.match(download.suggestedFilename(), /\.json$/);
  const data = JSON.parse(readFileSync(await download.path(), 'utf8'));
  assert.equal(data.kind, 'private-notes');
  assert.ok(data.notes.some((n) => n.title === title));
  await context.close();
});

test('layout works on a phone and in dark mode', async () => {
  const { context, page } = await openApp({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await gotoNotes(page, 'shared');
  await shot(page, '08-mobile-shared-dark');
  await page.click('.section-btn[data-section="private"]');
  await newNote(page, 'Phone note', 'typed on a phone');
  await shot(page, '09-mobile-editor-dark');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'no horizontal scrolling on phones');
  await page.click('#tab-clipboards');
  await shot(page, '10-mobile-clipboards-dark');
  await context.close();
});

// ── Phase 4: save clipboard content as notes, passphrase lock, encrypted backups ──

async function addClipboardText(page, text) {
  await page.click('#tab-clipboards');
  await page.fill('#input', text);
  await page.click('#btn-add');
  await page.locator('.item .item-text', { hasText: text }).first().waitFor();
}

test('a clipboard item can be saved as a private note without contacting the server', async () => {
  const { context, page, requests } = await openApp();
  const text = `clip-to-private-${Date.now()}`;
  await addClipboardText(page, text);
  const before = requests.length;
  const row = page.locator('.item', { hasText: text }).first();
  await row.hover();
  await row.locator('[data-act="note"]').click();
  await page.locator('#dlg-save-note[open]').waitFor();
  assert.equal(await page.isChecked('#dlg-save-note input[value="private"]'), true, 'private is the default');
  await shot(page, '11-save-as-note');
  await page.fill('#save-note-title', 'From clipboard');
  await page.click('#save-note-ok');
  await page.locator('.toast', { hasText: 'Saved as a private note' }).waitFor();
  const after = requests.slice(before);
  assert.deepEqual(after.filter((r) => r.includes('/api/notes')), [], 'saving privately must not call the notes API');
  await page.locator('.toast-action', { hasText: 'View' }).click();
  await waitForValue(page, '#editor-body', text);
  await context.close();
});

test('a whole clipboard can be saved as a shared note', async () => {
  const { context, page } = await openApp();
  const a = `first-${Date.now()}`;
  const b = `second-${Date.now()}`;
  await addClipboardText(page, a);
  await addClipboardText(page, b);
  await page.click('#btn-save-note');
  await page.locator('#dlg-save-note[open]').waitFor();
  await page.check('#dlg-save-note input[value="shared"]');
  await page.click('#save-note-ok');
  await page.locator('.toast', { hasText: 'Saved as a shared note' }).waitFor();
  const state = await (await fetch(`${srv.base}/api/state`)).json();
  const note = state.notes.find((n) => n.body.includes(a) && n.body.includes(b));
  assert.ok(note, 'shared note contains both clipboard items');
  await context.close();
});

test('a passphrase encrypts private notes in the browser and locks them', async () => {
  const { context, page } = await openApp();
  const secret = `locked-secret-${Date.now()}`;
  await gotoNotes(page, 'private');
  await newNote(page, 'Lockable', secret);
  await back(page);

  await page.click('[data-act="set-lock"]');
  await page.fill('#pass-1', 'correct horse battery');
  await page.fill('#pass-2', 'correct horse battery');
  await page.click('#pass-ok');
  await page.locator('.toast', { hasText: 'passphrase-protected' }).waitFor({ timeout: 15000 });

  const raw = await page.evaluate(() => new Promise((resolve, reject) => {
    const r = indexedDB.open('clipbox-private');
    r.onsuccess = () => {
      const q = r.result.transaction('notes').objectStore('notes').getAll();
      q.onsuccess = () => resolve(JSON.stringify(q.result));
      q.onerror = () => reject(q.error);
    };
  }));
  assert.equal(raw.includes(secret), false, 'note text must be encrypted at rest');
  assert.equal(raw.includes('Lockable'), false, 'titles are encrypted too');

  await page.reload();
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.click('#tab-notes');
  await page.locator('#private-locked').waitFor({ state: 'visible' });
  await shot(page, '12-locked');
  assert.equal(await page.locator('#notes-list .note-title').count(), 0);

  await page.fill('#unlock-pass', 'wrong passphrase');
  await page.click('#unlock-btn');
  await page.locator('#unlock-error', { hasText: 'Wrong passphrase' }).waitFor({ timeout: 15000 });
  await page.fill('#unlock-pass', 'correct horse battery');
  await page.click('#unlock-btn');
  await page.locator('#notes-list .note-title', { hasText: 'Lockable' }).waitFor({ timeout: 15000 });
  await context.close();
});

test('encrypted backups use the shared .cbx format (web ↔ Android)', async () => {
  const { context, page } = await openApp();
  await gotoNotes(page, 'private');
  await newNote(page, 'Backup me', 'cbx body');
  await back(page);
  await page.click('[data-act="export"]');
  await page.fill('#pass-1', 'backup passphrase');
  await page.fill('#pass-2', 'backup passphrase');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#pass-ok')]);
  assert.match(download.suggestedFilename(), /\.cbx$/);

  // Decrypt with the reference algorithm (the same one the Android app uses).
  const bytes = readFileSync(await download.path());
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'CBX1');
  const iterations = bytes.readUInt32BE(4);
  const key = pbkdf2Sync('backup passphrase', bytes.subarray(8, 24), iterations, 32, 'sha256');
  const d = createDecipheriv('aes-256-gcm', key, bytes.subarray(24, 36));
  d.setAuthTag(bytes.subarray(bytes.length - 16));
  const data = JSON.parse(Buffer.concat([d.update(bytes.subarray(36, bytes.length - 16)), d.final()]).toString('utf8'));
  assert.equal(data.kind, 'private-notes');
  assert.ok(data.notes.some((n) => n.title === 'Backup me'));
  await context.close();

  // A fresh browser imports the shared fixture (also imported by the Android unit tests).
  const fresh = await openApp();
  await gotoNotes(fresh.page, 'private');
  const [chooser] = await Promise.all([fresh.page.waitForEvent('filechooser'), fresh.page.click('[data-act="import"]')]);
  await chooser.setFiles(join(ROOT, 'test', 'fixtures', 'interop-backup.cbx'));
  await fresh.page.locator('#dlg-pass[open]').waitFor();
  await fresh.page.fill('#pass-1', 'fixture-passphrase');
  await fresh.page.click('#pass-ok');
  await fresh.page.locator('#notes-list .note-title', { hasText: 'Interop note' }).waitFor();
  await fresh.context.close();
});

// ── groups ──
test('groups keep clipboards and shared notes apart', async () => {
  const { context, page } = await openApp();
  const family = `Family ${Date.now() % 100000}`;
  // The group switcher is available to the host (this browser runs on the server machine).
  await page.locator('#group-wrap').waitFor({ state: 'visible' });
  await page.click('#btn-group');
  await page.locator('#group-menu .menu-item', { hasText: 'Manage groups' }).click();
  await page.locator('#dlg-groups[open]').waitFor();
  await page.fill('#group-new-name', family);
  await page.click('#group-create button[type="submit"]');
  await page.locator('#group-list .device-name', { hasText: family }).waitFor();
  await shot(page, '13-groups-dialog');
  await page.click('#dlg-groups [data-close]');

  // Switch to the new group: it has its own empty General clipboard.
  await page.click('#btn-group');
  await page.locator('#group-menu .menu-item', { hasText: family }).click();
  await page.locator('#group-name', { hasText: family }).waitFor();
  const inFamily = `family-only-${Date.now()}`;
  await page.fill('#input', inFamily);
  await page.click('#btn-add');
  await page.locator('.item .item-text', { hasText: inFamily }).waitFor();
  await shot(page, '14-group-switcher');

  // A shared note created here belongs to the group.
  await page.click('#tab-notes');
  await page.click('.section-btn[data-section="shared"]');
  await page.locator('#section-banner', { hasText: `members of "${family}"` }).waitFor();
  const noteTitle = `Family note ${Date.now()}`;
  await newNote(page, noteTitle, 'only for the family');
  await back(page);

  // Back in Everyone, neither is shown.
  await page.click('#btn-group');
  await page.locator('#group-menu .menu-item', { hasText: 'Everyone' }).click();
  assert.equal(await page.locator('#notes-list .note-title', { hasText: noteTitle }).count(), 0);
  await page.click('#tab-clipboards');
  assert.equal(await page.locator('.item .item-text', { hasText: inFamily }).count(), 0);

  // The server stored both in the group.
  const state = await (await fetch(`${srv.base}/api/state`)).json();
  const g = state.groups.find((x) => x.name === family);
  assert.equal(state.notes.find((n) => n.title === noteTitle).groupId, g.id);
  assert.ok(state.clipboards.find((c) => c.groupId === g.id).items.some((i) => i.text === inFamily));

  // Inviting to the group: the QR carries a sign-in token even on the LAN.
  await page.click('#btn-connect');
  await page.locator('#dlg-connect[open]').waitFor();
  await page.selectOption('#connect-group', g.id);
  await page.locator('#connect-group-note', { hasText: family }).waitFor();
  await shot(page, '15-group-invite');
  await context.close();
});

test('a browser that joins with a group invitation opens that group', async () => {
  const H = { 'X-ClipBox': '1', 'Content-Type': 'application/json' };
  const name = `Invited ${Date.now() % 100000}`;
  const g = await (await fetch(`${srv.base}/api/groups`, { method: 'POST', headers: H, body: JSON.stringify({ name }) })).json();
  const c = await (await fetch(`${srv.base}/api/connect?group=${g.id}`)).json();
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => { throw e; });
  await page.goto(`${srv.base}/join?t=${encodeURIComponent(c.token)}`);
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('#group-name', { hasText: name }).waitFor();
  await page.locator('.toast', { hasText: `You joined "${name}"` }).waitFor();
  assert.equal(new URL(page.url()).search, '', 'the address bar is cleaned up');
  // The choice is remembered: a reload stays in the group.
  await page.reload();
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('#group-name', { hasText: name }).waitFor();
  await context.close();
});

test('password groups: locked in the menu, joined with the password, and left again', async () => {
  const H = { 'X-ClipBox': '1', 'Content-Type': 'application/json' };
  const name = `Locked ${Date.now() % 100000}`;
  const g = await (await fetch(`${srv.base}/api/groups`, { method: 'POST', headers: H, body: JSON.stringify({ name, access: 'password', password: 'garden42' }) })).json();
  const st = await (await fetch(`${srv.base}/api/state`)).json();
  const cb = st.clipboards.find((c) => c.groupId === g.id);
  await fetch(`${srv.base}/api/clipboards/${cb.id}/items`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'behind-the-password' }) });

  // A member (not host) device: a remote browser signed in with a plain QR link.
  const { token } = await (await fetch(`${srv.base}/api/connect`)).json();
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.50' } });
  const page = await context.newPage();
  page.on('pageerror', (e) => { throw e; });
  const requests = [];
  page.on('request', (r) => requests.push(r.postData() || ''));
  await page.goto(`${srv.base}/join?t=${encodeURIComponent(token)}`);
  await page.locator('#app').waitFor({ state: 'visible' });

  await page.click('#btn-group');
  const item = page.locator('#group-menu .menu-item', { hasText: name });
  await item.locator('.menu-hint', { hasText: 'Join' }).waitFor();
  await shot(page, '16-group-locked');
  await item.click();
  await page.locator('#dlg-pass[open]').waitFor();
  await page.fill('#pass-1', 'wrong-one');
  await page.click('#pass-ok');
  await page.locator('#pass-error', { hasText: 'Wrong password' }).waitFor();
  await shot(page, '17-group-join');
  await page.fill('#pass-1', 'garden42');
  await page.click('#pass-ok');
  await page.locator('#group-name', { hasText: name }).waitFor();
  await page.locator('.item .item-text', { hasText: 'behind-the-password' }).waitFor();
  assert.ok(requests.some((b) => b.includes('garden42')), 'the password goes only to the join request');

  // Leave again: back to locked.
  await page.click('#btn-group');
  await page.locator('#group-menu .menu-item', { hasText: `Leave "${name}"` }).click();
  await page.click('#prompt-ok');
  await page.locator('#group-name', { hasText: 'Everyone' }).waitFor();
  await page.click('#btn-group');
  await page.locator('#group-menu .menu-item', { hasText: name }).locator('.menu-hint').waitFor();
  await context.close();
});

test('the host creates a password group from the dialog', async () => {
  const { context, page } = await openApp();
  const name = `PW ${Date.now() % 100000}`;
  await page.click('#btn-group');
  await page.locator('#group-menu .menu-item', { hasText: 'Manage groups' }).click();
  await page.locator('#dlg-groups[open]').waitFor();
  await page.fill('#group-new-name', name);
  await page.selectOption('#group-new-access', 'password');
  await page.fill('#group-new-password', 'river-stone');
  await shot(page, '18-group-create-password');
  await page.click('#group-create button[type="submit"]');
  const row = page.locator('#group-list .group-row', { hasText: name });
  await row.locator('.device-meta', { hasText: 'Password' }).waitFor();
  assert.equal(await row.locator('.role-select').inputValue(), 'password');
  await row.locator('[aria-label="Change password"]').waitFor();
  const groups = (await (await fetch(`${srv.base}/api/groups`)).json()).groups;
  assert.equal(groups.find((x) => x.name === name).access, 'password');
  await context.close();
});
