# ClipBox for Android

A native Android app (Kotlin + Jetpack Compose) for your ClipBox server: clipboards, shared notes, and **private notes that never leave the phone**.

## Features

- **Connect by QR code.** Scan the code from ClipBox → **Connect** on your computer, or type the address. The app remembers the server, so you only do this once.
- **Stays connected.** Live updates while the app is open. If the server's address changes, the app tries every address it knows (LAN first, then public HTTPS), and it refuses to connect if a *different* ClipBox answers at a saved address.
- **Clipboards.** Tap an item to copy it, paste from your phone's clipboard, add text, and manage clipboards.
- **Images and files.** Attach files with **File**. Image and file items can be opened (tap), shared to other apps, saved anywhere via the system file picker, and images can be copied to the phone's clipboard. Uploads need a connection; up to the server's `MAX_FILE_MB`.
- **Groups.** If the server has more than one group, the group name appears next to the scan button: tap it to switch. Clipboards and shared notes are shown per group, new ones are created in the open group, and the app remembers the last group per server. Scanning a group invitation opens that group.
- **Shared notes.** Create, edit, pin, lock and delete them. If someone else edits the same note at the same time, you choose between *Keep mine*, *Use theirs* or *Copy mine*.
- **Private notes.** Encrypted on the phone and never sent to any server. Includes Trash (30 days) with Undo, plus encrypted backup and restore. Backups (`.cbx`) are interchangeable with the web app.
- **Lock with fingerprint or screen lock** (Settings → Private notes). Private notes then need your fingerprint/face/PIN to open, lock again after 30 seconds in the background, and can't be screenshotted.
- **Save as note.** The note icon on a clipboard item (or *Save as note* in the clipboard menu) saves it as a private or shared note; private is the default.
- **Share to ClipBox.** From any app's share sheet, you choose where the text goes: a clipboard, a new private note, or a new shared note. Shared **images and files** (one or several) are uploaded to the clipboard you pick. Nothing is sent automatically.
- **Offline editing.** Shared notes and clipboard items you add while offline are kept on the phone (encrypted) and sent when you reconnect, marked *waiting to sync* until then. If someone else changed a note meanwhile, your version is saved as a separate "(offline copy)" instead of overwriting theirs; nothing is ever silently dropped. Private notes always work offline.
- **Same design as the web app**, with the same 7 themes.
- **Settings.** Switch between servers, disconnect, and back up private notes.

## Privacy & security

| | How |
|---|---|
| Private notes | Stored in a file encrypted with AES-256-GCM. The key lives in the **Android Keystore** (hardware-backed where available) and never leaves the device. |
| Separation | Private notes live in their own Gradle module (`:private-notes`) with **no network dependency**. A unit test fails the build if networking code or dependencies ever appear there. |
| Server login | A random device token from QR pairing, stored encrypted. Only its hash is kept on the server, and the host can revoke it at any time. |
| Offline cache | Encrypted, and deleted when you disconnect. |
| Backups | `allowBackup=false`, and nothing is copied during device transfer. The Keystore key can't be backed up anyway, so use **Settings → Back up** for a passphrase-encrypted file (PBKDF2-SHA256 + AES-GCM). |
| Network | Plain `http://` is only used for local-network addresses (private IPs, `localhost`, `*.local`). Public addresses must be HTTPS. |
| Self-signed HTTPS | The QR code carries the server certificate's SHA-256 fingerprint; the app trusts exactly that certificate (pinning), and validates every other certificate normally. |
| App lock | Optional fingerprint/face/screen-lock gate for private notes (system BiometricPrompt on Android 11+, screen-lock confirmation on 8–10), with screenshot blocking while they're shown. |
| Offline changes | Queued in an encrypted outbox per server. If you disconnect with unsent changes, they're kept as private notes tagged `unsynced`. |
| Local network (Android 17+) | The app asks for **Local network access**, which it needs to reach a server on your Wi-Fi. Public HTTPS addresses work without it. |

If the device's Keystore key is ever lost (for example after a factory reset), the app can't decrypt the existing private notes. It then keeps the file untouched and read-only instead of overwriting it, so you can still restore from a backup.

## Build

Requirements: Android SDK with platform 37, and JDK 17 or newer (Android Studio's bundled JDK works).

```bash
cd android
./gradlew test               # unit tests (core, private notes, network)
./gradlew :app:assembleDebug # app/build/outputs/apk/debug/app-debug.apk
```

Install on a connected phone with `adb install app/build/outputs/apk/debug/app-debug.apk`.

### Release builds

Release builds are signed when these environment variables are set:

```bash
ANDROID_KEYSTORE_PATH=/path/to/release.jks
ANDROID_KEYSTORE_PASSWORD=…
ANDROID_KEY_ALIAS=…
ANDROID_KEY_PASSWORD=…
./gradlew :app:assembleRelease
```

The release build is shrunk with R8 (about 2.5 MB, against 17 MB for debug) and installs as a separate app from the debug build (`…clipbox` vs `…clipbox.debug`).

## Releases

Pushing a tag like `v1.4.0` runs `.github/workflows/release.yml`. It checks that the tag matches `package.json`, the Android `versionName` and a `CHANGELOG.md` section, runs all tests, builds and verifies the signed APK, and publishes a GitHub Release with the APK, its SHA-256 and that version's changelog.

It needs four repository secrets, set once:

```bash
# from the folder that holds the key and signing.env
base64 -w0 clipbox-release.jks | gh secret set ANDROID_KEYSTORE_BASE64
source signing.env
printf '%s' "$ANDROID_KEYSTORE_PASSWORD" | gh secret set ANDROID_KEYSTORE_PASSWORD
printf '%s' "$ANDROID_KEY_ALIAS"         | gh secret set ANDROID_KEY_ALIAS
printf '%s' "$ANDROID_KEY_PASSWORD"      | gh secret set ANDROID_KEY_PASSWORD
```

> **Back up the signing key.** Android only installs updates signed with the same key. If `clipbox-release.jks` and its password are lost, existing installs can't be updated; users would have to uninstall (losing their private notes unless they made a backup) and install fresh. Keep a copy somewhere safe, such as a password manager plus an offline copy. Never commit it.

## Modules

```
app/            Compose UI, QR scanner (CameraX + ZXing), share sheet, ViewModel
core/           models, JSON, Keystore encryption (SecureBox), atomic encrypted files
private-notes/  private notes repository: no network code (enforced by PrivacyGuardTest)
network/        API client, live updates (SSE + long-poll), QR links, URL policy,
                server profiles with failover, encrypted offline cache
```

## Testing on an emulator

The emulator reaches your computer at `10.0.2.2`. Start ClipBox on the computer, then in the app enter `10.0.2.2:3210` under **Or enter the address**.

Emulator traffic reaches the server from `127.0.0.1`, so the emulator shows up as **Host**. A real phone on your Wi-Fi gets the role it was paired with.
