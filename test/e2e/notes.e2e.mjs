// Browser end-to-end tests for notes (real Chromium via Playwright).
// Run with: npm run test:e2e   (first time: npx playwright install chromium)
// Set SCREENSHOTS=<dir> to also save screenshots for visual review.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../helpers.mjs';

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

test('export downloads a JSON backup of private notes', async () => {
  const { context, page } = await openApp();
  const title = `Backup-${Date.now()}`;
  await gotoNotes(page, 'private');
  await newNote(page, title, 'backed up');
  await back(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="export"]')]);
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
