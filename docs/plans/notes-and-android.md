# Plan: Private & Shared Notes + Android App

Status: **Approved (recommended options).** Phase 1 shipped in v1.1.0, Phase 2 in v1.2.0, Phase 3 (Android MVP) in v1.3.0, Phase 4 in v1.4.0 (except multiple groups, see §11).

---

## 0. Where we start from (current architecture)

| Area | Today | Gap for this feature |
|---|---|---|
| Server | Plain Node `http`. Routes are declared in `server/index.js` and use 2 dependencies. | Fine to extend. |
| Storage | One in-memory DB flushed atomically to `data/db.json` (+ `.bak`), with files in `data/files/`. No schema version is enforced (`version: 1` is written but not checked). | Needs a versioned migration. |
| Sync | One global `rev` counter. SSE `/api/events` sends `change` events (`clipboard` / `remove`), with long-poll `/api/sync` as fallback. Clients reload on a `boot` change or a rev gap. | Reusable as-is for notes. |
| Auth | **One shared password.** Sessions are stateless HMAC cookies. LAN requests are open in `AUTH_MODE=public`. QR join tokens last 10 minutes, can be reused within that window, and **only exist when a password is set**. | **No users, devices, groups or roles exist.** Nothing can say "who" made a change, and no session can be revoked except by changing the password. |
| QR flow | The QR encodes a plain URL, or `URL/join?t=<token>`, which sets a cookie and redirects. | Fine for browsers. A native app needs a token, not a cookie. |
| Web client | Vanilla JS. `localStorage` is used only for the active clipboard and the theme. Strict CSP (`connect-src 'self'`). | No local data store yet. |

**Two important consequences:**

1. **"Group / team / host / member" doesn't exist yet.** Today everyone who can reach the server is equally trusted. Section 3 proposes the smallest model that meets the requirements without rebuilding auth.
2. **Device identity is needed** for note ownership, Android login, disconnect and revocation. This is the main new server concept.

---

## 1. Key decisions (approved)

| # | Decision | Recommendation | Alternative |
|---|---|---|---|
| D1 | **Group model** | **One group per server** (the server *is* the group), plus per-device roles. It keeps the current mental model and stays backward compatible. | Multiple groups per server, each with its own invite QR and membership. That's roughly 2× the server work, and could come later as Phase 4. |
| D2 | **Android technology** | **Native Kotlin + Jetpack Compose**. It gives real secure storage (Keystore), a reliable camera/QR, and private notes that are physically unreachable by server-supplied code. | Capacitor wrapper around the web UI. It reuses JS, but needs CORS and bearer auth in the web client, and weakens the privacy story (see §5.2). |
| D3 | **Private notes in the browser** | **IndexedDB, unencrypted by default**, with optional passphrase lock (WebCrypto). | Always encrypted. Stronger at rest, but a forgotten passphrase means permanent data loss. |
| D4 | **Offline edits to shared notes (Android)** | **v1: read-only offline cache**; edits need a connection. | Offline outbox with conflict resolution. More complex, so this would be Phase 3. |
| D5 | **Who can change a shared note** | Everyone in the group, **unless the author locks it** ("Only I can edit"). The host can always manage. | Strict owner-only editing. |

The rest of this plan assumes the recommended options.

---

## 2. Data model

### 2.1 Server: `db.json` v2 (shared data only)

```jsonc
{
  "version": 2,
  "serverId": "srv_8f3k…",          // stable ID, used by Android to recognise the same server on LAN vs tunnel URLs
  "serverName": "Office PC",       // shown on connect screens (defaults to hostname)
  "clipboards": [ /* unchanged */ ],
  "notes": [
    {
      "id": "n_…",
      "title": "Wi-Fi details",
      "body": "…",                    // plain text, max NOTE_MAX_KB
      "tags": ["home"],
      "pinned": false,
      "locked": false,               // true → only author/host may edit/delete
      "authorId": "dev_…",           // device that created it
      "authorName": "Pixel 8",       // denormalised for display
      "version": 7,                  // optimistic concurrency
      "createdAt": 0, "updatedAt": 0, "updatedBy": "dev_…"
    }
  ],
  "devices": [
    {
      "id": "dev_…",
      "name": "Pixel 8",
      "platform": "android" | "web",
      "role": "member" | "viewer",
      "tokenHash": "sha256…",        // only for Android/bearer devices; raw token never stored
      "createdAt": 0, "lastSeenAt": 0, "revoked": false
    }
  ]
}
```

- **There is no `privateNotes` field anywhere on the server, by design.** Private data has no server representation, no route and no event type (§6).
- Notes go in the same store and the same atomic write as clipboards. They also share the backup path, the rev counter and the event stream, so we don't build a second system.
- Limits: `NOTE_MAX_KB` (default 256), at most 2,000 shared notes, at most 20 tags of up to 30 characters each.

### 2.2 Browser: private notes (IndexedDB)

Database `clipbox-private` holds the store `notes`:

```js
{ id, title, body, tags: [], pinned, createdAt, updatedAt, deletedAt /* soft delete, 30-day trash */ }
```

There's also a `meta` store with `{ schemaVersion, lastExportAt, lockSalt? }`.

- **Why IndexedDB instead of localStorage:** it's async, holds far more than localStorage's ~5 MB, is transactional (no half-written notes), and is versioned via `onupgradeneeded`.
- On first save we call `navigator.storage.persist()` to ask the browser not to evict the data.
- If IndexedDB is unavailable (some private-browsing modes), we fall back to `localStorage` and show a persistent warning: "Private notes on this browser will be lost when you close it".
- A soft-delete **Trash** (30 days) guards against accidental deletion. Delete also offers an **Undo** toast.

### 2.3 Android

The app keeps two separate databases, with no code shared between them:

| DB | Contents | Protection |
|---|---|---|
| `private.db` (Room + SQLCipher) | Private notes | Encrypted. The DB key is random and wrapped by an **Android Keystore** AES-GCM key (hardware-backed where available). Optional biometric unlock. |
| `shared-cache.db` (Room) | Read-only cache of shared notes and clipboards | App sandbox. Deleted on disconnect. |
| DataStore + Keystore-encrypted blob | Server profiles (§4) and device tokens | Tokens are encrypted with a Keystore key. |

---

## 3. Identity, roles & access control

### 3.1 Roles (single-group model, D1)

| Role | Who | Can |
|---|---|---|
| **Host** | Requests from the server machine itself (loopback, no proxy headers), or any session that logged in with `AUTH_PASSWORD` | Everything, plus manage devices (rename, change role, revoke) and edit/delete any note, including locked ones. |
| **Member** | Paired devices (via QR) and LAN browsers in `AUTH_MODE=public` | View, create and edit shared notes and clipboards. Can't edit others' locked notes. |
| **Viewer** | Device the host has downgraded | Read-only on shared notes and clipboards. |

In `AUTH_MODE=public`, anyone on the LAN is a Member. The docs will say this plainly and recommend `AUTH_MODE=all` for real team use.

### 3.2 Device identity

- **Browsers:** on the first authorised request, the server issues a `clipbox_device` cookie (HMAC-signed device ID) and creates a `web` device record. The existing session cookie remains the *authorisation*; the device cookie is *attribution*. Old cookies keep working.
- **Android:** gets a **bearer device token** (§4.2), sent as `Authorization: Bearer <token>`. The server stores only `sha256(token)`, so revocation is instant.
- Inactive `web` device records (90 days) are pruned automatically.

### 3.3 Auth changes in `server/auth.js`

1. `check(req)` also accepts a valid, non-revoked bearer token, and returns `{ ok, role, deviceId }`.
2. **Pair tokens no longer require a password.** They're signed with the server secret, so LAN-open servers can pair Android devices too. They become **single-use** for device pairing (a used-nonce set kept in memory until expiry) and keep their 10-minute TTL.
3. The CSRF rule (`X-ClipBox` header) stays for cookie auth. Bearer requests are exempt, because they can't be sent cross-site.
4. All role checks happen in one place (`authorize(req, action, note?)`), not scattered through handlers.

---

## 4. QR connection & reconnection

### 4.1 QR payload (backward compatible)

Keep the QR a **normal URL**, so a phone camera still opens the browser, and add an optional fragment:

```
https://abc.ngrok.app/join?t=<pairToken>#cb1.<serverId>
http://192.168.1.20:3210/#cb1.<serverId>            (LAN, no token needed in AUTH_MODE=public)
```

- Browsers ignore the fragment, so the current behaviour is unchanged.
- The Android scanner recognises `#cb1.` and enters the native pairing flow. It also accepts a plain ClipBox URL and checks it via `GET /api/info`.
- The **Connect** dialog gains a line: "Scan with the ClipBox Android app or your camera".

### 4.2 Pairing flow (Android)

```
Scan QR ─▶ GET  {url}/api/info                 → { serverId, serverName, version, authMode, needsPassword }
        ─▶ POST {url}/api/devices/pair          { pairToken?, name: "Pixel 8", platform: "android" }
           ◀─ { deviceId, deviceToken, role, serverId, serverName, urls: [LAN…, public…] }
        ─▶ store profile (Keystore-encrypted token) and open the app
```

- If the QR had no token and the request isn't local/open, the app asks for the server password once, then pairs.
- `urls` contains every address the server knows (LAN + tunnel), so the app can **fail over** later.

### 4.3 Remembering & reconnecting

Saved profile: `{ serverId, serverName, urls[], lastGoodUrl, deviceId, encryptedToken, role }`. Multiple profiles are supported, but one is active at a time.

On launch or resume:
1. Try `lastGoodUrl` (`/api/health`, 2 s timeout).
2. Then try the other LAN URLs, then the public URL.
3. Check that `/api/info` returns the same `serverId`. **If it doesn't, refuse and warn.** This protects against another server taking over the same IP.
4. If all fail, show the cached shared notes as read-only with an "Offline" banner. Private notes always work.
5. A `401` with a revoked token clears the token and asks the user to re-scan.

### 4.4 Disconnect / switch server

- **Disconnect:** `DELETE /api/devices/me` (best-effort), then wipe the token and the shared cache. **Private notes are kept**; they belong to the device, not the server.
- **Switch:** pick another saved profile, or scan a new QR.

---

## 5. Privacy & security

### 5.1 Hard guarantees (enforced by design + tests)

- The server has **no endpoint, field, event or storage path** for private notes, so there is nothing to misuse.
- Browser private notes live in IndexedDB, and **no code path sends them over the network**. The only way out is the user's own **Copy**, **Export**, or explicit **Share…** (which creates a *new* shared note after a confirmation dialog).
- Android private notes live in a separate Gradle module (`:private-notes`) with **no dependency on the networking module**. The build enforces that sync code can't reach private data.
- Android sets `android:allowBackup="false"` for private data. Keystore keys can't be backed up anyway, so a cloud backup of the encrypted DB would be unreadable and misleading. Users get an explicit encrypted export instead (§7).

### 5.2 An honest limitation: browsers and a malicious host

In the browser, private notes are protected from **other users, other devices and the server's APIs**. However, the page's JavaScript is served by the host. A host who **modifies the ClipBox code** could ship a script that reads that origin's IndexedDB. No web app served by someone else can fully prevent this.

- **Mitigation 1:** the optional passphrase lock (D3) encrypts notes at rest (PBKDF2-SHA256 at 600k iterations, then AES-GCM). It doesn't stop modified code from capturing the passphrase.
- **Mitigation 2:** **use the Android app for sensitive notes.** Its code doesn't come from the server, so the host can't reach the data.
- The UI will state this in one sentence on the Private section's info tooltip.

### 5.3 Other security items

- Note content is always rendered with `textContent` (no HTML), and the existing strict CSP stays.
- Shared note writes check the role and the lock flag server-side. Clients are never trusted.
- Every device is listed in **Settings → Devices** (host only) with last-seen time and revoke.
- **Android cleartext HTTP:** Android blocks `http://` by default. The app allows it **only for private-range IPs, `localhost` and `*.local`**, checked in the app's networking code, with a visible "Not encrypted (local network)" badge. Public URLs must be HTTPS.
- **Self-signed LAN HTTPS (optional, later):** the QR can carry the certificate's SHA-256 fingerprint, and the app pins it (trust-on-first-use).
- Login rate-limiting is extended to `/api/devices/pair`.

---

## 6. API changes

All new routes use the existing router, error format and auth. **Existing routes are unchanged.**

| Method | Route | Role | Notes |
|---|---|---|---|
| GET | `/api/info` | open | `{ serverId, serverName, version, authMode, needsPassword }`. No data. |
| POST | `/api/devices/pair` | open + pair token *or* local-open | Returns the device token once. Single-use token. |
| GET | `/api/devices` | host | List devices. |
| PATCH | `/api/devices/:id` | host | `{ name?, role?, revoked? }` |
| DELETE | `/api/devices/me` | any device | Self-disconnect. |
| GET | `/api/state` | member | **Adds `notes`** and `me: { deviceId, role }`. Old clients ignore the new fields. |
| POST | `/api/notes` | member | `{ title, body, tags?, pinned?, locked? }` |
| PATCH | `/api/notes/:id` | member (lock rules) | Requires `baseVersion`. A mismatch returns **409** with the current note. |
| DELETE | `/api/notes/:id` | member (lock rules) | Deletes the note. |

**Events:** a new `change` type, `note` / `note-remove`, using the same `rev` counter. Old web clients ignore unknown types except for advancing `rev`. I checked `applyEvent`: it updates `rev` and re-renders, so this is safe.

**Conflicts:** notes are edited for longer than clipboard items, so last-write-wins would silently lose work. With `baseVersion`, a 409 lets the editor show: *"This note was changed on Pixel 8. Keep mine / Use theirs / Copy mine to clipboard."*

---

## 7. Backup, recovery & migration

**Server migration v1 → v2** (in `store.load()`):
1. If `version` is missing or 1, copy `db.json` to `db.v1-backup.json` (once, never overwritten).
2. Add `serverId`, `serverName`, `notes: []` and `devices: []`, then set `version: 2`.
3. Save atomically. A newer `version` than the code understands makes the server **refuse to start** with a clear message, instead of silently dropping data.

**Server backup:** shared notes are inside `db.json`, so the existing `.bak` and "copy `data/`" advice still covers them. Add `npm run backup`, which writes a timestamped zip-free copy of `data/` to `backups/`, and document a restore.

**Web private notes:**
- **Export:** a JSON file, optionally passphrase-encrypted. **Import** merges by `id`, keeping the newer `updatedAt`.
- If there's no export for 30+ days and 10+ notes exist, a gentle "Back up your private notes" reminder appears.
- **Origin pitfall:** browser storage is tied to the exact address. Notes created on `http://192.168.1.20:3210` **won't appear** on the ngrok URL, on `localhost`, or if the PC's IP changes. Mitigations:
  - a clear notice in the Private section ("Saved in this browser, for this address only"),
  - Export/Import,
  - README advice to use a stable address (DHCP reservation or hostname).
- **Safari/iOS** may erase site data after ~7 days without a visit (unless the site is added to the Home Screen). This goes in the docs, plus a suggestion to install it as a PWA or use the Android app.

**Android:**
- Encrypted export/import via the system file picker (Storage Access Framework), protected by a user passphrase.
- Room migrations are versioned and tested.
- Uninstalling the app deletes private notes. A warning is shown before **Disconnect / Reset app data**.

---

## 8. UI / UX

### 8.1 Web

- **Top-level switch** in the header: `Clipboards | Notes`, a two-segment control that remembers the last choice.
- The **Notes view** reuses the same layout: sidebar on desktop, chips on mobile.

```
┌ Notes ──────────────────────────────────────────────────────┐
│ 🔍 Search notes…                                    [+ New]  │
│ ┌──────────────┐                                             │
│ │ 🔒 Private  12│  ← lock icon, neutral/grey tint            │
│ │ 👥 Shared    5│  ← people icon, accent tint                │
│ │ ── Tags ──    │                                             │
│ │ #home  #work  │                                             │
│ └──────────────┘                                             │
│  📌 Wi-Fi details                    2h ago   [⧉] [✎] [🗑]   │
│     SSID: Home-5G  pass: …                                   │
│  Meeting notes                        1d ago   [⧉] [✎] [🗑]   │
└──────────────────────────────────────────────────────────────┘
```

- **Unmistakable separation:**
  - Each section has its own header banner: **"🔒 Private — only on this device"** or **"👥 Shared — visible to everyone on Office PC"**.
  - The editor shows the same badge.
  - Private uses a neutral tint and Shared uses the accent colour.
  - The **New** button creates a note in the section you're viewing, and the button label says so ("New private note").
  - Moving a note between sections is never a drag or a toggle. It's an explicit **Share…** (confirm dialog that shows the destination) or **Make private copy**.
- **Editor:** inline, like clipboard items today. It autosaves locally for private notes. For shared notes it saves when you pause typing for 800 ms, with a "Saving… / Saved / Conflict" indicator.
- **Quick actions:** copy (whole note), edit, pin, delete (with Undo), and `/` to focus search. Search filters title, body and tags client-side, instantly.
- **Organise:** pinned notes first, then by updated time. Tags are free-form chips, and you filter by tapping one.

### 8.2 Android (same design language)

- Material 3 with ClipBox's colour tokens. The same 7 themes, plus "follow system".
- Bottom navigation: **Clipboards · Notes · Settings**. Inside Notes, tabs **Private 🔒 | Shared 👥** use the same banners as the web.
- Quick actions: swipe to delete (with Undo), long-press to copy, and a FAB for a new note in the current tab.
- Android share sheet: "Share to ClipBox" lets you choose a clipboard or a private/shared note explicitly (no default).
- Settings: connected server (name, address in use, role), Switch server, Disconnect, Export/Import private notes, Biometric lock, Theme.

---

## 9. Android app architecture

> **As built in Phase 3 (v1.3.0): changes from the original plan**
>
> - **Private notes storage:** a single AES-256-GCM encrypted file with a Keystore-held key, written atomically with a `.bak` copy, instead of Room + SQLCipher. Same protection at rest, but no annotation processing and no native SQLCipher dependency. A personal notes collection is small enough for one document.
> - **QR decoding:** ZXing (pure Java, works without Google Play Services) instead of ML Kit.
> - **Offline cache and server profiles:** the same encrypted-file mechanism instead of Room/DataStore.
> - **Android 17 local network permission:** discovered during emulator testing. Apps targeting API 37 can't reach private IPs without `ACCESS_LOCAL_NETWORK`, and the connection just times out silently. The app now requests it before connecting to a LAN address, on startup when a saved server is on the LAN, and from the offline banner.
> - **Lost Keystore key:** if private notes can't be decrypted, the repository becomes read-only rather than overwriting the file.
> - **Not in the MVP:** offline editing of shared notes (they're read-only offline, as planned), image copy/share from clipboards, and biometric lock. These are in Phase 4.


```
android/                         (in this repo — one project, one issue tracker)
  app/                           Compose UI, navigation, DI (Hilt)
  core/model/                    shared data classes
  core/network/                  OkHttp + kotlinx.serialization, SSE (okhttp-sse) + long-poll fallback, server profiles
  feature/shared/                clipboards + shared notes (uses core/network, shared-cache.db)
  feature/private-notes/         private notes (Room + SQLCipher, Keystore)  ⟵ NO dependency on core/network
  feature/connect/               CameraX + ML Kit barcode scanning (bundled model, works without Play Services)
```

- **Min SDK 26** (Android 8.0) and target the latest SDK.
- **Sync:** connect SSE while the app is in the foreground and use the existing long-poll fallback. No always-on background service (to save battery). Refresh on resume.
- **Distribution:** signed APK on **GitHub Releases** via CI. Play Store is optional later.
- **CI:** add an `android` job (Gradle build, unit tests, lint, and a dependency rule check that `private-notes` doesn't depend on `network`).

---

## 10. Testing

**Server (extend `test/api.test.mjs`)**
- v1 → v2 migration: data is preserved, a backup is written, and a newer version refuses to start.
- Notes CRUD and validation, `baseVersion` 409, lock rules per role, viewer is read-only.
- Device pairing: single-use token, an expired token is rejected, revoked bearer gets 401, token hash only (raw token not in `db.json`).
- **Privacy:** a static test asserts no route, store field or event type contains "private". Old clients still work with v2 `/api/state`.

**Web (add Playwright as a dev-only dependency)**
- Create private notes, then assert **no network request body contains their text** (all requests intercepted).
- Two browser contexts: A's private notes are invisible to B, while shared notes sync both ways within 1 s.
- Private notes survive a reload. Undo after delete works. Export → clear → Import round-trips.
- Conflict: edit the same shared note in two contexts and check the conflict UI.
- Responsive snapshots at 375 / 768 / 1280 px across all 7 themes.

**Android**
- Unit: crypto wrap/unwrap, Room migrations, URL failover order, serverId mismatch refusal, cleartext policy (public `http://` is rejected).
- Instrumented: pair via QR image fixture, disconnect wipes the token and cache but keeps private notes, process death and restore.
- Manual matrix: LAN HTTP, ngrok, Cloudflare, server IP change, server offline, revoked device.

---

## 11. Phased delivery

| Phase | Scope | Ships |
|---|---|---|
| **1. Foundations** | DB v2 migration, `serverId`, devices, bearer auth, single-use pair tokens, `/api/info`, `/api/devices/*`, host device-management UI | Server + web. No visible note features yet; fully backward compatible. |
| **2. Notes on web** | Shared notes API + events + conflict handling; web Notes view; private notes in IndexedDB; export/import; trash | Usable notes on web. |
| **3. Android MVP** | Connect via QR, profiles & failover, clipboards, shared notes (online + read-only cache), private notes (encrypted), export/import, disconnect | APK on GitHub Releases. |
| **4. Optional** | Passphrase lock (web), biometric lock (Android), offline outbox for shared notes, certificate pinning for LAN HTTPS, multiple groups per server | **v1.4.0:** all except multiple groups, plus "Save as note" from clipboards (web + Android) and encrypted `.cbx` backups shared by web and Android. Multiple groups per server is deferred: it changes the access model for every endpoint and deserves its own design review. |

Each phase is a separate PR with tests and README updates, and can be released on its own.

---

## 12. Out of scope (deliberately)

- User accounts or email-based sign-in. Devices plus one host password are enough for this app's purpose.
- Syncing private notes between a user's own devices. That would require routing them through the server, or end-to-end encryption between devices; it can be revisited later as an E2EE feature.
- Rich text / Markdown rendering. Notes are plain text in v1; Markdown preview could come later.
