# ClipBox

[![CI](https://github.com/salmanulharis/clipbox/actions/workflows/ci.yml/badge.svg)](https://github.com/salmanulharis/clipbox/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen)

A lightweight, self-hosted clipboard you can share between your desktop, phone and tablet.
Run it on one computer, open it in any browser on your network (or anywhere through a tunnel), and every device sees the same clipboards in real time.

- **Multiple clipboards.** Create, rename, clear and delete them. Add, edit, copy and delete items.
- **Text, images and files.** Press Ctrl+V anywhere on the page, drag & drop, or use the paste/attach buttons.
- **One-click copy.** Copy a single item, or the whole clipboard with **Copy all**.
- **Live sync.** Changes appear on every connected device almost instantly.
- **QR connect.** Scan a code to open ClipBox on another device. Remote codes also sign the device in.
- **Built-in QR scanner.** Uses the live camera, or a photo when the page isn't on HTTPS.
- **LAN + public access.** Works on your local network and through ngrok or Cloudflare Tunnel, with no code changes.
- **Themes.** System, Light, Dark, Midnight, Forest, Rose and Sand, remembered per device.
- **Notes, private and shared.** Private notes never leave your browser; shared notes sync live to everyone on the server, with conflict protection.
- **Persistent.** Data is stored in a JSON file on the server and survives restarts.
- **Secure by default.** Remote access always requires a password.
- **Android app.** A native app that pairs by QR code, keeps private notes encrypted on the phone, and syncs shared notes and clipboards. See [android/README.md](android/README.md).
- **Tiny.** Plain Node.js with two dependencies (`qrcode`, `jsqr`), no database and no build step.

---

## Android app

The `android/` folder contains a native Android app (Kotlin + Jetpack Compose, Android 8.0+):

1. On your computer, open ClipBox and click **Connect**.
2. In the app, tap **Scan QR code** and scan it. The app pairs itself with a device token and remembers the server.
3. On Android 17+, allow **Local network access** when asked; the app needs it to reach a server on your Wi-Fi.

Private notes in the app are encrypted with a key in the Android Keystore and are never sent to the server. Shared notes and clipboards sync live. Build instructions and the security details are in [android/README.md](android/README.md). Each CI run also uploads a debug APK as a downloadable artifact.

## Requirements

- [Node.js](https://nodejs.org) **18.17 or newer** (20+ recommended)
- Optional: [ngrok](https://ngrok.com/download) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for public access

## Installation

```bash
cd clipbox
npm install
cp .env.example .env      # Windows (cmd): copy .env.example .env
npm start
```

The console prints every address ClipBox is reachable at, plus a QR code for your phone:

```
  ClipBox is running

  This PC: http://localhost:3210
  Network: http://192.168.1.20:3210  (Wi-Fi)
  Auth:    LAN open, password required for remote access

  Scan to open http://192.168.1.20:3210 on your phone:
  ▄▄▄▄▄▄▄ ▄ ▄ ...
```

Open `http://localhost:3210` on this computer.

---

## Configuration (`.env`)

Every setting is optional. Variables already set in the real environment take precedence over `.env`.

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Interface to bind. `0.0.0.0` makes ClipBox reachable from your LAN; `127.0.0.1` restricts it to this machine and tunnels. |
| `PORT` | `3210` | HTTP port. |
| `DATA_DIR` | `./data` | Where clipboards (`db.json`), uploaded files and the session secret live. |
| `AUTH_PASSWORD` | *(empty)* | Password for logging in. **Remote access is refused until this is set.** |
| `AUTH_MODE` | `public` | `public`: LAN devices need no password, remote/tunnel visitors must log in. `all`: every device must log in. |
| `SESSION_DAYS` | `30` | How long a login stays valid. |
| `LOCAL_HOSTNAMES` | *(empty)* | Extra comma-separated host names treated as "local" (e.g. a name set up in your router's DNS). |
| `TUNNEL` | `none` | `none`, `ngrok` or `cloudflare`. |
| `TUNNEL_AUTOSTART` | `false` | `true` makes ClipBox launch the tunnel program itself. |
| `PUBLIC_URL` | *(empty)* | Fixed public URL (named Cloudflare tunnel, reverse proxy, …). Always wins over auto-detection. |
| `NGROK_BIN` | `ngrok` | Path to the ngrok executable. |
| `NGROK_API` | `http://127.0.0.1:4040` | ngrok's local API, used to detect the public URL. |
| `NGROK_DOMAIN` | *(empty)* | Your reserved/static ngrok domain (optional). |
| `CLOUDFLARED_BIN` | `cloudflared` | Path to the cloudflared executable. |
| `CLOUDFLARE_TUNNEL_TOKEN` | *(empty)* | Token of a named tunnel. Without it a free quick tunnel is created. |
| `MAX_TEXT_KB` | `1024` | Maximum size of a text item. |
| `MAX_FILE_MB` | `25` | Maximum size of an uploaded image or file. |
| `HTTPS_CERT` / `HTTPS_KEY` | *(empty)* | Certificate and key paths to serve HTTPS directly on the LAN (see [HTTPS on the LAN](#optional-https-on-the-lan)). |

---

## Local network access

1. Keep `HOST=0.0.0.0` (the default) and start ClipBox.
2. On your phone or tablet, connected to the **same Wi-Fi**, do one of these:
   - scan the QR code printed in the terminal,
   - click **Connect** in the app and scan the code on screen,
   - or type the `Network:` address, e.g. `http://192.168.1.20:3210`.

If another device can't connect:

- **Windows firewall.** Allow Node.js on *Private* networks when Windows asks. If you missed the prompt, run this in an admin PowerShell:
  ```powershell
  New-NetFirewallRule -DisplayName "ClipBox" -Direction Inbound -Protocol TCP -LocalPort 3210 -Action Allow -Profile Private
  ```
  Also make sure your Wi-Fi network profile is set to *Private*.
- **macOS.** Allow incoming connections for `node` under System Settings → Network → Firewall.
- **Linux (ufw).** Run `sudo ufw allow 3210/tcp`.
- **Wrong address.** The Connect dialog lists every network interface. Addresses marked *virtual* (WSL, Hyper-V, Docker) usually can't be reached from other devices.
- **Guest network.** Guest networks and "AP/client isolation" block devices from reaching each other.

---

## Public access

> ⚠️ Set `AUTH_PASSWORD` before going public. Without it, ClipBox refuses every request that arrives through a tunnel.

### ngrok

1. [Install ngrok](https://ngrok.com/download) and add your authtoken once:
   ```bash
   ngrok config add-authtoken <YOUR_TOKEN>
   ```
2. Configure `.env`:
   ```ini
   AUTH_PASSWORD=choose-a-strong-password
   TUNNEL=ngrok
   TUNNEL_AUTOSTART=true
   # NGROK_DOMAIN=your-name.ngrok-free.app   # optional, free static domain
   ```
3. Run `npm start`. ClipBox launches ngrok, reads the public URL from ngrok's API, prints it, and shows it in the **Connect** dialog.

Prefer to run ngrok yourself? Set `TUNNEL_AUTOSTART=false` and run `ngrok http 3210` in another terminal. ClipBox still detects the URL automatically.

*The free ngrok plan shows a one-time "You are about to visit…" warning page. Click **Visit Site** and it won't appear again on that device.*

### Cloudflare Tunnel

**Quick tunnel (free, no account, random `*.trycloudflare.com` URL):**

1. [Install cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. Configure `.env`:
   ```ini
   AUTH_PASSWORD=choose-a-strong-password
   TUNNEL=cloudflare
   TUNNEL_AUTOSTART=true
   ```
3. Run `npm start`. The `trycloudflare.com` URL is detected automatically. It changes every time the tunnel restarts.

**Named tunnel (your own domain, permanent URL):**

1. In the Cloudflare dashboard go to **Zero Trust → Networks → Tunnels → Create tunnel**. Add a *public hostname* (e.g. `clips.example.com`) that points to `http://localhost:3210`, and copy the tunnel token.
2. Configure `.env`:
   ```ini
   AUTH_PASSWORD=choose-a-strong-password
   TUNNEL=cloudflare
   TUNNEL_AUTOSTART=true
   CLOUDFLARE_TUNNEL_TOKEN=eyJh...
   PUBLIC_URL=https://clips.example.com
   ```
   You can also run `cloudflared` as a system service yourself. In that case leave `TUNNEL_AUTOSTART=false` and keep `PUBLIC_URL` set.

### Any other proxy or tunnel

Point it at `http://localhost:3210` and set `PUBLIC_URL` to its address so the Connect dialog can show it.

---

## Usage

| Action | How |
|---|---|
| Add text | Type in the box and press **Add** or **Ctrl/⌘+Enter** |
| Quick paste | Press **Ctrl/⌘+V** anywhere on the page (outside the text box). The content is added immediately. |
| Paste button | Reads your device's clipboard directly. This needs HTTPS; over plain HTTP, long-press the box and choose *Paste*. |
| Add image/file | Paste it, drag & drop it, or use the 📎 button |
| Copy an item | The blue copy icon on each item |
| Copy everything | **Copy all** copies every text item, joined by new lines |
| Edit an item | ✏️ on the item. Ctrl+Enter saves, Esc cancels. |
| New / switch clipboard | The sidebar on desktop, or the chips under the top bar on mobile |
| Rename | Click the clipboard title or the ✏️ next to *Copy all* |
| Clear / Delete clipboard | The eraser and trash icons next to *Copy all* (you'll be asked to confirm) |
| Connect a device | **Connect** shows a QR code for each LAN or public address |
| Scan a QR code | The scan icon in the top bar. You can open the link, add it to the clipboard, or copy it. |
| Change theme | The palette icon in the top bar (each device remembers its own choice) |
| Focus the input | Press `/` |

The dot next to the logo shows the connection state: **green** = live, **amber** = connecting, **red** = offline (it reconnects automatically). When a device comes back from sleep it re-syncs automatically.

### How QR sign-in works

When a password is needed for an address (any public URL, or every URL with `AUTH_MODE=all`), the QR code includes a **sign-in token that is valid for 10 minutes**. Scanning it opens ClipBox already logged in, so you never have to type the password on your phone. After it expires, open **Connect** again to get a fresh code.

QR links also end in `#cb1.<server-id>`. Browsers ignore this; the upcoming ClipBox Android app uses it to recognise the server.

### Notes

Switch between **Clipboards** and **Notes** in the top bar. Notes have two clearly separated sections:

| | 🔒 **Private** | 👥 **Shared** |
|---|---|---|
| Stored | Only in this browser (IndexedDB), for this exact address | On the server (`data/db.json`) |
| Visible to | You, in this browser | Everyone connected to the server |
| Sent over the network | **Never** | Yes, synced live |
| Works for viewers | Yes | Read-only |

- **Write:** click **New private note** or **New shared note**. Notes save automatically as you type. Press **Esc** to go back, or **Ctrl/⌘+S** to save now.
- **Organise:** pin notes to the top, add `#tags` (separated by commas) and filter by tapping a tag, or search titles, text and tags instantly. Press `/` to focus search.
- **Quick actions:** copy, pin, edit and delete from the list.
- **Moving between sections is always explicit.** **Share…** puts a *copy* of a private note in Shared, after you confirm; the private original stays private. **Make private copy** saves a shared note into this browser.
- **Lock (shared notes):** the author can lock a note so only they or the host can edit or delete it.
- **Conflicts:** if someone else saves a shared note while you're editing it, you choose **Keep mine**, **Use theirs** or **Copy mine**; nothing is silently overwritten. If the note is deleted while you edit, you can save your text as a new note.
- **Trash & undo (private):** deleted private notes can be undone straight away, and stay in **Trash** for 30 days.
- **Backups (private):** use the export ⬇ and import ⬆ buttons in the Private banner. Import merges by note, keeping the newer copy. If you have 10+ private notes and no recent export, ClipBox reminds you after 30 days.

> **Where private notes live.** They're stored by your browser *for the exact address you opened*. `http://192.168.1.20:3210`, `http://localhost:3210` and your tunnel URL each have their own separate private notes, and so does every browser and private window. Clearing site data deletes them. Safari on iPhone/iPad may erase site data after about 7 days without a visit, unless ClipBox is added to the Home Screen. **Export a backup** now and then, and use a stable address (a DHCP reservation for the server PC helps).
>
> **Honest limit:** private notes are never sent to the server, and other users can't see them. However, the page's code is served by the host, so a host who *modifies* the ClipBox code could read them. For highly sensitive notes, use the [ClipBox Android app](android/README.md), whose code doesn't come from the server.

### Devices & roles

Every browser or app that opens ClipBox is recorded as a **device**. Each device has one of three roles:

| Role | Who gets it | Can |
|---|---|---|
| **Host** | The server computer itself, and any device that signed in with `AUTH_PASSWORD` | Everything, plus manage devices |
| **Member** | Devices that joined by QR code, and browsers on your LAN | Read and change clipboards |
| **Viewer** | A device the host downgraded | Read and copy only (shows a *View only* badge) |

To manage devices as the host, open **Connect → Manage devices**. From there you can rename a device, change its role, **revoke** it (it's signed out immediately, and its live connection is closed), restore it, or remove it.

> In the default `AUTH_MODE=public`, browsers on your LAN don't need a password, so a revoked LAN browser can simply reload and come back as a new device. Use `AUTH_MODE=all` when you need revocation and viewer roles to be enforced for every device.

Browser devices that haven't been seen for 90 days are forgotten automatically.

---

## Browser notes: HTTP vs HTTPS

Browsers restrict some features to secure (HTTPS or `localhost`) pages:

| Feature | Plain HTTP on the LAN | HTTPS (tunnel or local cert) |
|---|---|---|
| Copy text | ✅ (uses a fallback method) | ✅ |
| Paste with Ctrl+V / long-press | ✅ | ✅ |
| Paste button (read clipboard) | ❌ use Ctrl+V / long-press | ✅ |
| Copy image to clipboard | ❌ downloads instead | ✅ |
| Live camera QR scanner | ❌ use **Scan from photo** | ✅ |

The ngrok and Cloudflare URLs are HTTPS, so every feature works there.

### Optional: HTTPS on the LAN

To get the full feature set on your local network too, create a certificate with [mkcert](https://github.com/FiloSottile/mkcert):

```bash
mkcert -install
mkcert 192.168.1.20 localhost      # use your LAN IP
```

```ini
HTTPS_CERT=./192.168.1.20+1.pem
HTTPS_KEY=./192.168.1.20+1-key.pem
```

Other devices need to trust mkcert's root CA (see the mkcert docs). If they don't, they'll show a certificate warning that you can accept.

---

## Security model

- **LAN vs remote.** A request counts as *local* only when **all** of these are true: it comes straight from a private/loopback IP, it carries no proxy headers (`X-Forwarded-For`, `CF-Connecting-IP`, …), and its `Host` is an IP address, `localhost`, your computer's name, `*.local`, or a name in `LOCAL_HOSTNAMES`. Everything else, including all tunnel traffic, counts as *remote*.
- **Remote requests always need the password.** If `AUTH_PASSWORD` is empty, they are rejected outright.
- **Sessions** are HMAC-signed, `HttpOnly`, `SameSite=Lax` cookies (`Secure` over HTTPS), tied to a device record, so revoking the device ends the session. **Changing `AUTH_PASSWORD` signs out every browser.** The signing secret lives in `DATA_DIR/secret.key`.
- **App devices** authenticate with a random 256-bit bearer token issued once at pairing. Only its SHA-256 hash is stored. Revoking the device invalidates the token instantly. App devices keep working through a tunnel even if `AUTH_PASSWORD` is empty, because pairing itself was the authorisation.
- **QR pairing tokens** expire after 10 minutes. Each one can register only **one** app device; browsers can reuse it within that window.
- **Roles** are enforced on the server for every request: viewers can't write, and only hosts can manage devices.
- **Login and pairing** attempts are rate-limited (10 failures per 5 minutes per client).
- **CSRF and DNS rebinding.** Cookie-authenticated writes require a custom header, and unknown `Host` names are treated as remote, which blocks malicious websites from reaching your LAN instance.
- **Uploaded files.** Only common image types are shown inline. Everything else (including SVG and HTML) is served as a download in a sandbox.
- **Shared LAN.** On a network you share with others (office, dorm), use `AUTH_MODE=all`.
- **Private notes** have no server representation at all: no API route, no database field, no sync event. The browser code that stores them (`public/private-store.js`) contains no network calls, which the test suite enforces, and an end-to-end test checks that a private note's text never appears in any request.
- **Shared notes** are checked on the server: viewers can't write, locked notes accept changes only from their author or a host, and edits carry a `baseVersion` so stale writes get `409 Conflict` instead of overwriting.

## Data & backups

```
data/
├── db.json            # clipboards, devices, server identity (schema v2)
├── db.json.bak        # previous version (used automatically if db.json is damaged)
├── db.v1-backup.json  # one-time copy of your data from before the v2 upgrade
├── files/             # uploaded images and files
└── secret.key         # session/device signing key
```

Writes are atomic (temp file → rename) and flushed on shutdown. To back up, copy the `data/` folder. To reset everything, stop the server and delete it.

**Upgrades.** ClipBox 1.1 upgrades `db.json` from schema v1 to v2 automatically on first start, and keeps the original as `db.v1-backup.json`. If `db.json` was written by a *newer* ClipBox, the server refuses to start instead of risking your data. To roll back to 1.0, stop the server and copy `db.v1-backup.json` over `db.json`; anything created since the upgrade is lost.

## Running in the background

- **pm2 (any OS):** `npm i -g pm2 && pm2 start server/index.js --name clipbox && pm2 save`
- **Linux systemd:** create a service with `WorkingDirectory=/path/to/clipbox` and `ExecStart=/usr/bin/node server/index.js`.
- **Windows:** use pm2, or a Task Scheduler task "At log on" that runs `node server\index.js` in the project folder.

## Project structure

```
server/
  index.js     HTTP server, routing, SSE sync, uploads, QR codes
  store.js     JSON persistence, schema migration, clipboards and devices
  auth.js      local/remote detection, sessions, device tokens, roles
  tunnel.js    ngrok / cloudflared launch and URL discovery
  network.js   LAN address detection
  config.js    .env loading and defaults
public/
  index.html, app.js, style.css   the UI shell, clipboards, devices (vanilla JS, no build)
  notes.js                        Notes view: private + shared notes
  private-store.js                private notes storage (IndexedDB; no network code)
  theme.js                        applies the saved theme before first paint
test/
  api.test.mjs                    clipboards, uploads, auth, SSE
  devices.test.mjs                pairing, roles, revocation
  migration.test.mjs              schema upgrades
  notes.test.mjs                  shared notes API, conflicts, locks, privacy checks
  e2e/notes.e2e.mjs               browser tests (Playwright + Chromium)
  helpers.mjs                     throwaway test server
android/                          native Android app (see android/README.md)
docs/plans/                       design documents for upcoming features
```

## Development

```bash
npm run dev     # restart automatically on server changes
npm run check   # syntax-check all source files
npm test        # start a throwaway server and run the API test suite
npm run test:e2e  # browser tests in headless Chromium
                  # (first time only: npx playwright install chromium)
```

Set `SCREENSHOTS=some/folder` when running `test:e2e` to save screenshots of each step.

CI runs the checks and API tests on Linux and Windows with Node 20, 22 and 24, the browser tests on Linux, and the Android unit tests plus a debug APK build.

### API (for scripting)

Authenticate in one of two ways:
- **Cookie** (browsers and scripts): writes need the header `X-ClipBox: 1`, and remote requests also need the session cookie from `POST /api/login`.
- **Bearer token** (apps): pair once, then send `Authorization: Bearer <deviceToken>` on every request. No `X-ClipBox` header is needed.

```
GET    /api/info                               server id, name, version (no data; no auth)
POST   /api/devices/pair  {pairToken | password, name, platform}
                                               → {deviceId, deviceToken, role, serverId, urls}
GET    /api/devices                            list devices            (host)
PATCH  /api/devices/:id   {name?, role?, revoked?}                     (host)
DELETE /api/devices/:id                        forget a device         (host)
DELETE /api/devices/me                         disconnect this device

GET    /api/state                              all clipboards + {me: {deviceId, role}}
POST   /api/clipboards                {name}   create
PATCH  /api/clipboards/:id            {name}   rename
POST   /api/clipboards/:id/clear               clear
DELETE /api/clipboards/:id                     delete
POST   /api/clipboards/:id/items      {text}   add text
PATCH  /api/clipboards/:id/items/:itemId {text} edit
DELETE /api/clipboards/:id/items/:itemId       delete item
POST   /api/clipboards/:id/files   (raw body, Content-Type, X-Filename)  upload
GET    /files/:itemId[?download]               fetch a file
GET    /api/events                             live updates (Server-Sent Events)

POST   /api/notes   {title, body, tags?, pinned?, locked?}            create a shared note
PATCH  /api/notes/:id {title?, body?, tags?, baseVersion, pinned?, locked?}
                                               edit (409 + current note if baseVersion is stale)
DELETE /api/notes/:id                          delete a shared note
```

Shared notes are included in `GET /api/state` as `notes`, and live events have `type: "note"` or `"note-remove"`. Changing `title`, `body` or `tags` requires `baseVersion`; `pinned` and `locked` don't.

Example: send text from a terminal on your LAN:

```bash
ID=$(curl -s localhost:3210/api/state | node -pe "JSON.parse(require('fs').readFileSync(0)).clipboards[0].id")
curl -s -X POST localhost:3210/api/clipboards/$ID/items -H "X-ClipBox: 1" -H "Content-Type: application/json" -d '{"text":"hello from the terminal"}'
```

## License

MIT
