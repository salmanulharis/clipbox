# Changelog

All notable changes to ClipBox. Versions apply to both the server/web app and the Android app.

## [1.4.0] - 2026-11-19

### Added
- **Save clipboard content as notes** (web and Android): from a single item or a whole clipboard, as a private note (default) or a shared note.
- **Passphrase lock for private notes on the web**: notes are encrypted in the browser (PBKDF2-SHA256 → AES-256-GCM), and lock on reload and after 10 idle minutes.
- **Encrypted `.cbx` backups** in one format for web and Android, so backups move between them. Web exports are encrypted by default.
- **Android: fingerprint / screen-lock gate** for private notes, with relock after 30 s in the background and screenshot blocking.
- **Android: offline editing.** Shared notes and clipboard text added offline sync on reconnect. Conflicting edits are kept as "(offline copy)", and nothing is dropped.
- **Android: certificate pinning** for self-signed HTTPS on the LAN, using a fingerprint carried in the QR code.
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
