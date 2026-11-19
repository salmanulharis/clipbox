# Changelog

All notable changes to ClipBox. Since 1.5.0 ClipBox is web only; versions 1.3.0–1.4.0 also included an Android app.

## [1.5.0] - 2026-11-19

### Added
- **Groups**: separate clipboards and shared notes on one server (for example *Family* and *Work*).
  - The default **Everyone** group holds all existing data and is visible to every device.
  - Three kinds of group: **Open** (every device sees it directly), **Password** (listed with a lock; entering the optional group password once joins it) and **Invited only** (hidden from non-members). The host can switch kinds, change passwords, pick members in any kind, rename, or delete a group with its content.
  - Members can leave password and invite-only groups.
  - **Group invitation QR codes** sign a device in and add it to the group in one step.
  - Enforced on the server for every route, file and live event. Devices outside a group get `404`s and empty `skip` events, so nothing leaks, not even ids.
  - Web: group switcher, **Manage groups** dialog, and an invite selector under **Connect**.
  - A browser that joins with a group invitation opens that group.
- Group passwords are scrypt-hashed, never sent back, and wrong attempts share the login rate limit.
- `GET /api/info` reports `apiVersion: 3` and `features: ["groups", "notes", "devices"]`.

### Changed
- Database schema v3. The first start backs up the v2 database to `data/db.v2-backup.json`.

### Removed
- **The Android app.** ClipBox is web only now: open it in the phone's browser (QR connect works the same). The `android/` project, its CI job and the APK release are gone; releases publish the source with the changelog. Existing app pairings keep working until they're removed under *Manage devices*.

### Fixed
- Scripts and health checks (e.g. `curl …/api/state`) no longer create an anonymous "Browser" device on every call; only real browsers are recorded as devices.
- Group menu items now show their icons (lock, key, people) and line up; opening the group or theme menu closes the other.

## [1.4.0] - 2026-11-19

### Added
- **Save clipboard content as notes** (web and Android): from a single item or a whole clipboard, as a private note (default) or a shared note.
- **Passphrase lock for private notes on the web**: notes are encrypted in the browser (PBKDF2-SHA256 → AES-256-GCM), and lock on reload and after 10 idle minutes.
- **Encrypted `.cbx` backups** in one format for web and Android, so backups move between them. Web exports are encrypted by default.
- **Android: fingerprint / screen-lock gate** for private notes, with relock after 30 s in the background and screenshot blocking.
- **Android: offline editing.** Shared notes and clipboard text added offline sync on reconnect. Conflicting edits are kept as "(offline copy)", and nothing is dropped.
- **Android: certificate pinning** for self-signed HTTPS on the LAN, using a fingerprint carried in the QR code.
- **Android: images and files.**
  - share images/files (one or many) into ClipBox from any app
  - attach files from the composer
  - open, share, save and copy image items
- **Windows:** `npm run autostart:install` starts ClipBox hidden at login and restarts it if it exits.

### Fixed
- Dialog footers wrap instead of pushing buttons out of view on narrow screens.

## [1.3.0] - 2026-11-19

### Added
- **ClipBox for Android** (Kotlin + Compose):
  - QR pairing and server profiles with failover
  - live sync of clipboards and shared notes
  - private notes encrypted with an Android Keystore key, kept in a separate module with no network access
  - encrypted backups
  - Share to ClipBox
  - the same 7 themes as the web app
- **Android 17 local network permission** handling.

## [1.2.0] - 2026-11-19

### Added
- **Notes view** with clearly separated **Private** (this browser only) and **Shared** (everyone on the server) sections.
- **Shared notes:** optimistic concurrency (409 conflicts with *Keep mine / Use theirs*), locking, and live sync.
- **Private notes in IndexedDB:** trash with undo, export/import, and a backup reminder.
- **Playwright browser tests**, including a check that private notes never appear in network traffic.

## [1.1.0] - 2026-11-19

### Added
- **Devices and roles** (host, member, viewer), sessions bound to a device, and revocation.
- **App pairing:** single-use QR tokens and bearer device tokens.
- **Database schema v2** with automatic, backed-up migration.

## [1.0.0] - 2026-11-19

### Added
- **Multi-device clipboards:** text, images and files.
- **Live sync** over Server-Sent Events.
- **QR connect.**
- **LAN and public access** via ngrok or Cloudflare Tunnel, with password protection for remote access.
- **Themes.**
