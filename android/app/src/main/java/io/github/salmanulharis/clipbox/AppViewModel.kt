package io.github.salmanulharis.clipbox

import android.app.Application
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.BitmapFactory
import android.os.Build
import android.provider.Settings
import android.util.LruCache
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.salmanulharis.clipbox.core.model.ClipItem
import io.github.salmanulharis.clipbox.core.model.NoteText
import io.github.salmanulharis.clipbox.core.model.PrivateNote
import io.github.salmanulharis.clipbox.core.model.Role
import io.github.salmanulharis.clipbox.core.model.SharedNote
import io.github.salmanulharis.clipbox.network.ApiException
import io.github.salmanulharis.clipbox.network.Connection
import io.github.salmanulharis.clipbox.network.ServerLink
import io.github.salmanulharis.clipbox.network.Outbox
import io.github.salmanulharis.clipbox.network.ServerProfile
import io.github.salmanulharis.clipbox.network.SyncEngine
import io.github.salmanulharis.clipbox.network.SyncEvent
import io.github.salmanulharis.clipbox.network.UrlPolicy
import io.github.salmanulharis.clipbox.privatenotes.PrivateNotesRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class Tab { CLIPBOARDS, NOTES, SETTINGS }
enum class Scope { PRIVATE, SHARED }

sealed interface Screen {
    data object Home : Screen
    data object Editor : Screen
    data object Scanner : Screen
    data object Trash : Screen
}

data class UiMessage(val text: String, val error: Boolean = false, val actionLabel: String? = null, val action: (() -> Unit)? = null)

sealed interface ConnectOutcome {
    data object Done : ConnectOutcome
    data class NeedsPassword(val serverName: String, val hint: String?) : ConnectOutcome
    data class Failed(val message: String) : ConnectOutcome
}

/** State of the note editor (one open note at a time, private or shared). */
class EditorState(val scope: Scope, id: String?, var version: Int?, title: String, tags: String, body: String) {
    var id by mutableStateOf(id)
    var title by mutableStateOf(title)
    var tags by mutableStateOf(tags)
    var body by mutableStateOf(body)
    var status by mutableStateOf(if (id == null) "New note" else "")
    var statusError by mutableStateOf(false)
    var conflict by mutableStateOf<SharedNote?>(null)
    var deletedRemotely by mutableStateOf(false)
    var leavePrompt by mutableStateOf(false)
    internal var dirty = false
    internal var seq = 0
    internal var saving = false
    internal var pending = false
    internal var saveJob: Job? = null
}

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val g = (app as ClipBoxApplication).graph

    val profiles = g.profiles.profiles
    val activeId = g.profiles.activeId
    val connection = g.sync.connection
    val snapshot = g.sync.snapshot
    /** Ids of shared notes / clipboard items changed offline and waiting to sync. */
    val pending = g.sync.pending
    val privateNotes = g.privateNotes.notes

    // ── private notes lock (fingerprint / screen lock) ───────────
    var lockEnabled by mutableStateOf(g.prefs.getBoolean("lock_private", false)); private set
    var privateUnlocked by mutableStateOf(false); private set
    private var backgroundAt = 0L
    /** True when private notes need fingerprint/PIN before they can be shown. */
    val privateLocked: Boolean get() = lockEnabled && !privateUnlocked

    fun changePrivateLock(on: Boolean) {
        lockEnabled = on
        privateUnlocked = on // the user just authenticated to turn it on
        g.prefs.edit().putBoolean("lock_private", on).apply()
    }

    fun unlockPrivate() {
        privateUnlocked = true
    }

    fun lockPrivate() {
        if (!lockEnabled) return
        if (editor?.scope == Scope.PRIVATE) closeEditor()
        if (screen == Screen.Trash) screen = Screen.Home
        privateUnlocked = false
    }

    var ready by mutableStateOf(false); private set
    var tab by mutableStateOf(Tab.CLIPBOARDS)
    var screen by mutableStateOf<Screen>(Screen.Home)
    var notesScope by mutableStateOf(Scope.PRIVATE)
    var activeClipboardId by mutableStateOf<String?>(null)
    var themeId by mutableStateOf(g.prefs.getString("theme", "system") ?: "system"); private set
    var pendingShare by mutableStateOf<String?>(null)
    var editor by mutableStateOf<EditorState?>(null); private set
    var privateLoadError by mutableStateOf<String?>(null); private set

    private val _messages = MutableSharedFlow<UiMessage>(extraBufferCapacity = 16)
    val messages: SharedFlow<UiMessage> = _messages
    private val thumbs = LruCache<String, ImageBitmap>(40)

    val activeProfile: ServerProfile? get() = g.profiles.active
    val role: Role get() = snapshot.value?.me?.role ?: activeProfile?.role ?: Role.MEMBER
    val myDeviceId: String? get() = snapshot.value?.me?.deviceId ?: activeProfile?.deviceId
    val isOnline: Boolean get() = connection.value is Connection.Online

    init {
        viewModelScope.launch {
            withContext(Dispatchers.IO) {
                runCatching { g.privateNotes.load() }.onFailure { privateLoadError = it.message }
                runCatching { g.profiles.load() }
            }
            privateLoadError = privateLoadError ?: g.privateNotes.loadError
            // Offline changes that can't be delivered anywhere are kept as private notes.
            g.sync.onUnsynced = { title, body ->
                runCatching { g.privateNotes.create(title, body, listOf("unsynced")) }
            }
            ready = true
            withContext(Dispatchers.IO) { runCatching { cleanShareCache() } }
            activeProfile?.let(g.sync::start)
            launch { g.sync.events.collect(::onSyncEvent) }
            snapshot.collect { onSnapshot() }
        }
    }

    private fun onSyncEvent(ev: SyncEvent) {
        when (ev) {
            is SyncEvent.Notice -> msg(ev.message, error = true)
            is SyncEvent.NoteSynced -> editor?.let { e ->
                // A note created offline got its real id; edits made since then follow it.
                if (e.scope == Scope.SHARED && (e.id == ev.localId || e.id == ev.note.id)) {
                    e.id = ev.note.id
                    if (!e.dirty) e.version = ev.note.version
                    else if (ev.localId != null) e.version = ev.note.version
                    e.status = "Synced"
                }
            }
        }
    }

    // ── lifecycle ────────────────────────────────────────────────
    fun onForeground() {
        // Private notes lock again after the app has been in the background for 30 seconds.
        if (lockEnabled && privateUnlocked && backgroundAt > 0 && System.currentTimeMillis() - backgroundAt > 30_000) lockPrivate()
        backgroundAt = 0
        if (ready) activeProfile?.let { if (connection.value is Connection.Idle) g.sync.start(it) }
    }

    fun onBackground() {
        backgroundAt = System.currentTimeMillis()
        editor?.let { e -> if (e.dirty) viewModelScope.launch { save(e) } }
        g.sync.stop()
    }

    fun msg(text: String, error: Boolean = false, actionLabel: String? = null, action: (() -> Unit)? = null) {
        _messages.tryEmit(UiMessage(text, error, actionLabel, action))
    }

    fun setTheme(id: String) {
        themeId = id
        g.prefs.edit().putString("theme", id).apply()
    }

    /** Run a server call; shows errors as messages and returns null on failure. */
    private suspend fun <T> server(block: suspend (base: String, token: String) -> T): T? = try {
        val token = g.sync.token ?: throw ApiException(0, "Not connected to a server.")
        block(g.sync.base(), token)
    } catch (e: CancellationException) {
        throw e
    } catch (e: ApiException) {
        msg(e.message ?: "Something went wrong.", error = true)
        if (e.status == 401) g.sync.refresh()
        null
    } catch (e: Exception) {
        msg(e.message ?: "Something went wrong.", error = true)
        null
    }

    // ── connecting ───────────────────────────────────────────────
    private fun deviceName(): String {
        val ctx = getApplication<Application>()
        val named = runCatching { Settings.Global.getString(ctx.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
        return (named?.takeIf { it.isNotBlank() } ?: "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}").take(40)
    }

    suspend fun connect(link: ServerLink, password: String?): ConnectOutcome {
        UrlPolicy.check(link.baseUrl)?.let { return ConnectOutcome.Failed(it) }
        val known = g.profiles.profiles.value.firstOrNull { it.serverId == link.serverId }
        // Trust the certificate fingerprint from the QR code (self-signed HTTPS on the LAN).
        val pin = link.certSha256 ?: known?.certSha256
        val linkApi = g.api.pinned(pin)
        val info = try {
            linkApi.info(link.baseUrl)
        } catch (e: ApiException) {
            return ConnectOutcome.Failed(
                if (e.isOffline) "Couldn't reach ${link.baseUrl}. Make sure this phone is on the same network, or use the public (https) QR code."
                else e.message ?: "That address isn't a ClipBox server.",
            )
        }
        if (link.serverId != null && link.serverId != info.serverId) {
            return ConnectOutcome.Failed("This QR code belongs to a different ClipBox server than the one answering at ${link.baseUrl}.")
        }
        val pair = try {
            linkApi.pair(link.baseUrl, link.pairToken?.takeIf { password == null }, password, deviceName())
        } catch (e: ApiException) {
            return when {
                e.reason == "pair_expired" -> ConnectOutcome.NeedsPassword(info.serverName, "This QR code has expired or was already used. Show a fresh one, or enter the server password.")
                e.status == 401 && password != null -> ConnectOutcome.NeedsPassword(info.serverName, "Wrong password. Try again.")
                e.status == 401 -> ConnectOutcome.NeedsPassword(info.serverName, null)
                else -> ConnectOutcome.Failed(e.message ?: "Pairing failed.")
            }
        }
        val old = g.profiles.profiles.value.firstOrNull { it.serverId == pair.serverId }
        val profile = ServerProfile(
            serverId = pair.serverId,
            serverName = pair.serverName,
            urls = (listOf(link.baseUrl) + pair.urls).distinct(),
            lastGoodUrl = link.baseUrl,
            deviceId = pair.deviceId,
            deviceToken = pair.deviceToken,
            role = pair.role,
            pairedAt = System.currentTimeMillis(),
            certSha256 = pin,
        )
        withContext(Dispatchers.IO) { g.profiles.upsert(profile) }
        if (old != null) g.scope.launch(Dispatchers.IO) { runCatching { linkApi.disconnect(link.baseUrl, old.deviceToken) } }
        activeClipboardId = null
        g.sync.start(profile)
        screen = Screen.Home
        tab = Tab.CLIPBOARDS
        msg("Connected to ${pair.serverName}")
        return ConnectOutcome.Done
    }

    fun switchTo(serverId: String) {
        if (serverId == activeId.value) return
        viewModelScope.launch {
            withContext(Dispatchers.IO) { g.profiles.setActive(serverId) }
            activeClipboardId = null
            activeProfile?.let(g.sync::start)
        }
    }

    /** Remove this device from the server (best effort) and forget it here. Private notes stay. */
    fun disconnect() {
        val p = activeProfile ?: return
        viewModelScope.launch {
            val base = (connection.value as? Connection.Online)?.base
            if (base != null) runCatching { g.sync.api.disconnect(base, p.deviceToken) }
            forget(p)
            msg("Disconnected from ${p.serverName}. Your private notes stay on this phone.")
        }
    }

    /** Forget a server whose host revoked this device. */
    fun forgetActive() {
        activeProfile?.let { p -> viewModelScope.launch { forget(p) } }
    }

    private suspend fun forget(p: ServerProfile) {
        if (editor?.scope == Scope.SHARED) { editor = null; screen = Screen.Home }
        val unsent = g.sync.outbox?.ops?.value?.count { it.kind != io.github.salmanulharis.clipbox.network.OutboxOp.Kind.NOTE_DELETE } ?: 0
        g.sync.clear() // unsent offline changes are rescued into private notes (onUnsynced)
        if (unsent > 0) msg("$unsent unsynced change${if (unsent == 1) " was" else "s were"} kept as private notes (tag: unsynced).")
        withContext(Dispatchers.IO) {
            g.cache.delete(p.serverId)
            g.profiles.remove(p.serverId)
        }
        activeClipboardId = null
        g.profiles.profiles.value.firstOrNull()?.let { switchTo(it.serverId) }
    }

    fun refresh() = g.sync.refresh()

    // ── clipboards ───────────────────────────────────────────────
    private val clipboardManager get() = getApplication<Application>().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    fun copyText(text: String, what: String = "Copied") {
        clipboardManager.setPrimaryClip(ClipData.newPlainText("ClipBox", text))
        // Android 13+ shows its own confirmation.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) msg(what)
    }

    fun readDeviceClipboard(): String? =
        clipboardManager.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(getApplication())?.toString()

    /** Add text to a clipboard. Offline, it's queued and sent when the phone reconnects. */
    fun addText(clipboardId: String, text: String, onDone: (Boolean) -> Unit = {}) {
        if (text.isBlank()) return
        viewModelScope.launch {
            if (!g.sync.isOnline) {
                val ok = runCatching { withContext(Dispatchers.IO) { g.sync.queueClipText(clipboardId, text) } }
                    .onFailure { msg(it.message ?: "Couldn't save it for later.", error = true) }.isSuccess
                if (ok) msg("Saved on this phone. It will be added when you're back online.")
                onDone(ok)
                return@launch
            }
            try {
                val item = g.sync.api.addText(g.sync.base(), g.sync.token!!, clipboardId, text)
                g.sync.applyItem(clipboardId, item)
                onDone(true)
            } catch (e: ApiException) {
                if (e.isOffline) {
                    withContext(Dispatchers.IO) { g.sync.queueClipText(clipboardId, text) }
                    msg("Connection lost. It will be added when you're back online.")
                    onDone(true)
                } else {
                    msg(e.message ?: "Couldn't add it.", error = true)
                    onDone(false)
                }
            }
        }
    }

    /**
     * "Save as note" for clipboard content. Private notes are stored on this phone only;
     * shared notes go to the server (queued while offline).
     */
    fun saveAsNote(scope: Scope, title: String, body: String) {
        val t = NoteText.cleanTitle(title)
        if (t.isBlank() && body.isBlank()) return
        viewModelScope.launch {
            if (scope == Scope.PRIVATE) {
                val n = local { create(t, body) } ?: return@launch
                msg("Saved as a private note", actionLabel = "Open") { tab = Tab.NOTES; notesScope = Scope.PRIVATE; openEditor(Scope.PRIVATE, n.id) }
                return@launch
            }
            val id = createShared(t, body, emptyList()) ?: return@launch
            msg(if (Outbox.isLocalId(id)) "Saved as a shared note. It will sync when you're back online." else "Saved as a shared note", actionLabel = "Open") {
                tab = Tab.NOTES; notesScope = Scope.SHARED; openEditor(Scope.SHARED, id)
            }
        }
    }

    /** Create a shared note online, or queue it offline. Returns its id (a temporary local id when queued). */
    private suspend fun createShared(title: String, body: String, tags: List<String>): String? {
        if (g.sync.isOnline) {
            try {
                val n = g.sync.api.createNote(g.sync.base(), g.sync.token!!, title, body, tags)
                g.sync.applyNote(n)
                return n.id
            } catch (e: ApiException) {
                if (!e.isOffline) {
                    msg(e.message ?: "Couldn't share the note.", error = true)
                    return null
                }
            }
        }
        return runCatching { withContext(Dispatchers.IO) { g.sync.queueNoteCreate(title, body, tags) } }
            .onFailure { msg(it.message ?: "Couldn't save it for later.", error = true) }.getOrNull()
    }

    fun deleteItem(clipboardId: String, item: ClipItem) {
        viewModelScope.launch {
            if (server { b, t -> g.sync.api.deleteItem(b, t, clipboardId, item.id) } != null) {
                g.sync.removeItem(clipboardId, item.id)
                if (item.isText && item.text != null) msg("Item deleted", actionLabel = "Undo") { addText(clipboardId, item.text!!) }
                else msg("Item deleted")
            }
        }
    }

    fun createClipboard(name: String) {
        viewModelScope.launch {
            server { b, t -> g.sync.api.createClipboard(b, t, name) }?.let {
                g.sync.applyClipboard(it)
                activeClipboardId = it.id
            }
        }
    }

    fun renameClipboard(id: String, name: String) {
        viewModelScope.launch { server { b, t -> g.sync.api.renameClipboard(b, t, id, name) }?.let(g.sync::applyClipboard) }
    }

    fun clearClipboard(id: String) {
        viewModelScope.launch { server { b, t -> g.sync.api.clearClipboard(b, t, id) }?.let { g.sync.applyClipboard(it); msg("Clipboard cleared") } }
    }

    fun deleteClipboard(id: String) {
        viewModelScope.launch {
            if (server { b, t -> g.sync.api.deleteClipboard(b, t, id) } != null) {
                g.sync.removeClipboard(id)
                activeClipboardId = null
                msg("Clipboard deleted")
            }
        }
    }

    suspend fun thumbnail(item: ClipItem): ImageBitmap? {
        thumbs.get(item.id)?.let { return it }
        val token = g.sync.token ?: return null
        val base = (connection.value as? Connection.Online)?.base ?: return null
        return try {
            val bytes = g.sync.api.fileBytes(base, token, item.id)
            withContext(Dispatchers.Default) {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (bounds.outWidth / (sample * 2) >= 720 || bounds.outHeight / (sample * 2) >= 720) sample *= 2
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
            }?.also { thumbs.put(item.id, it) }
        } catch (_: Exception) {
            null
        }
    }

    // ── files & images ───────────────────────────────────────────
    /** Files shared into ClipBox from another app, waiting for the user to pick a clipboard. */
    var pendingShareFiles by mutableStateOf<List<android.net.Uri>>(emptyList())

    private data class LocalFile(val name: String, val mime: String, val size: Long)

    private fun describe(uri: android.net.Uri): LocalFile {
        val cr = getApplication<Application>().contentResolver
        var name: String? = null
        var size = -1L
        cr.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME, android.provider.OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                name = c.getString(0)
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
        val fileName = (name ?: uri.lastPathSegment ?: "file").substringAfterLast('/').ifBlank { "file" }
        val mime = cr.getType(uri)
            ?: android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(fileName.substringAfterLast('.', "").lowercase())
            ?: "application/octet-stream"
        return LocalFile(fileName, mime, size)
    }

    /** Upload picked or shared files to a clipboard (needs a connection: files aren't queued offline). */
    fun uploadUris(clipboardId: String, uris: List<android.net.Uri>) {
        if (uris.isEmpty()) return
        viewModelScope.launch {
            val token = g.sync.token
            val base = (connection.value as? Connection.Online)?.base
            if (token == null || base == null) {
                msg("Files can only be added while you're connected to the server.", error = true)
                return@launch
            }
            val max = snapshot.value?.maxFileBytes ?: (25L * 1024 * 1024)
            val cr = getApplication<Application>().contentResolver
            var added = 0
            var last = ""
            for (uri in uris) {
                val f = withContext(Dispatchers.IO) { runCatching { describe(uri) }.getOrNull() }
                if (f == null) { msg("Couldn't read a shared file.", error = true); continue }
                if (f.size > max) { msg("\"${f.name}\" is too large (max ${max / 1048576} MB).", error = true); continue }
                if (f.size == 0L) continue
                try {
                    val item = g.sync.api.uploadFile(base, token, clipboardId, f.name, f.mime, f.size) {
                        cr.openInputStream(uri) ?: throw java.io.IOException("Can't open ${f.name}")
                    }
                    g.sync.applyItem(clipboardId, item)
                    added++
                    last = f.name
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    msg("\"${f.name}\" wasn't added: ${e.message}", error = true)
                }
            }
            if (added == 1) msg("Added $last") else if (added > 1) msg("Added $added files")
        }
    }

    private val sharedDir get() = java.io.File(getApplication<Application>().cacheDir, "shared").apply { mkdirs() }

    /** Download a clipboard file into the share cache (reused if already there). */
    private suspend fun cachedFile(item: ClipItem): java.io.File? {
        val safe = (item.name ?: "file").replace(Regex("[^\\w.\\- ]"), "_").take(80)
        val f = java.io.File(sharedDir, "${item.id}_$safe")
        if (f.exists() && f.length() == item.size) return f
        return try {
            val token = g.sync.token ?: throw ApiException(0, "Not connected.")
            g.sync.api.downloadTo(g.sync.base(), token, item.id, f)
            f
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            f.delete()
            msg(if (e is ApiException && e.isOffline) "Connect to the server to open files." else "Couldn't download the file.", error = true)
            null
        }
    }

    private fun contentUri(f: java.io.File): android.net.Uri =
        androidx.core.content.FileProvider.getUriForFile(getApplication(), "${getApplication<Application>().packageName}.files", f)

    private fun startChooser(intent: android.content.Intent) {
        try {
            getApplication<Application>().startActivity(
                android.content.Intent.createChooser(intent, null).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: android.content.ActivityNotFoundException) {
            msg("No app on this phone can open this file.", error = true)
        }
    }

    fun openItem(item: ClipItem) {
        viewModelScope.launch {
            val f = cachedFile(item) ?: return@launch
            startChooser(
                android.content.Intent(android.content.Intent.ACTION_VIEW)
                    .setDataAndType(contentUri(f), item.mime ?: "*/*")
                    .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION),
            )
        }
    }

    fun shareItem(item: ClipItem) {
        viewModelScope.launch {
            val f = cachedFile(item) ?: return@launch
            startChooser(
                android.content.Intent(android.content.Intent.ACTION_SEND)
                    .setType(item.mime ?: "application/octet-stream")
                    .putExtra(android.content.Intent.EXTRA_STREAM, contentUri(f))
                    .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION),
            )
        }
    }

    /** Put an image on the phone's clipboard, so it can be pasted into other apps. */
    fun copyImage(item: ClipItem) {
        viewModelScope.launch {
            val f = cachedFile(item) ?: return@launch
            val app = getApplication<Application>()
            clipboardManager.setPrimaryClip(ClipData.newUri(app.contentResolver, item.name ?: "image", contentUri(f)))
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) msg("Image copied")
        }
    }

    /** Save a copy wherever the user chose (system file picker). */
    fun saveItem(item: ClipItem, target: android.net.Uri) {
        viewModelScope.launch {
            val f = cachedFile(item) ?: return@launch
            try {
                withContext(Dispatchers.IO) {
                    getApplication<Application>().contentResolver.openOutputStream(target, "wt")!!.use { out -> f.inputStream().use { it.copyTo(out) } }
                }
                msg("Saved ${item.name ?: "file"}")
            } catch (e: Exception) {
                msg("Couldn't save: ${e.message}", error = true)
            }
        }
    }

    /** Downloaded copies are only for handing to other apps; drop them after a day. */
    private fun cleanShareCache() {
        val cutoff = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
        sharedDir.listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.delete() }
    }

    // ── shared notes ─────────────────────────────────────────────
    fun canEdit(n: SharedNote?): Boolean =
        role.canWrite && (n == null || !n.locked || role == Role.HOST || n.authorId == myDeviceId)

    fun canLock(n: SharedNote): Boolean = role.canWrite && (role == Role.HOST || n.authorId == myDeviceId)

    fun togglePinShared(n: SharedNote) {
        viewModelScope.launch { server { b, t -> g.sync.api.updateNote(b, t, n.id, pinned = !n.pinned) }?.let(g.sync::applyNote) }
    }

    fun deleteShared(n: SharedNote, after: () -> Unit = {}) {
        viewModelScope.launch {
            if (!g.sync.isOnline || Outbox.isLocalId(n.id)) {
                withContext(Dispatchers.IO) { g.sync.queueNoteDelete(n.id) }
                msg(if (Outbox.isLocalId(n.id)) "Note discarded" else "Deleted here. It will be removed for everyone when you're back online.")
                after()
                return@launch
            }
            if (server { b, t -> g.sync.api.deleteNote(b, t, n.id) } != null) {
                g.sync.removeNote(n.id)
                msg("Shared note deleted")
                after()
            }
        }
    }

    // ── private notes (never sent anywhere) ──────────────────────
    private suspend fun <T> local(block: PrivateNotesRepository.() -> T): T? = try {
        withContext(Dispatchers.IO) { g.privateNotes.block() }
    } catch (e: Exception) {
        msg(e.message ?: "Couldn't save the private note.", error = true)
        null
    }

    fun togglePinPrivate(n: PrivateNote) {
        viewModelScope.launch { local { update(n.id, pinned = !n.pinned) } }
    }

    fun trashPrivate(n: PrivateNote) {
        viewModelScope.launch {
            local { trash(n.id) } ?: return@launch
            msg("Moved to trash", actionLabel = "Undo") { viewModelScope.launch { local { restore(n.id) } } }
        }
    }

    fun restorePrivate(n: PrivateNote) {
        viewModelScope.launch { local { restore(n.id) }?.let { msg("Note restored") } }
    }

    fun destroyPrivate(n: PrivateNote) {
        viewModelScope.launch { local { destroy(n.id) } }
    }

    fun emptyTrash() {
        viewModelScope.launch { local { emptyTrash() }?.let { msg("Deleted $it notes forever") } }
    }

    fun exportPrivate(passphrase: CharArray, write: (ByteArray) -> Unit) {
        viewModelScope.launch {
            val bytes = local { exportBackup(passphrase) } ?: return@launch
            try {
                withContext(Dispatchers.IO) { write(bytes) }
                msg("Encrypted backup saved (${active(privateNotes.value).size} notes)")
            } catch (e: Exception) {
                msg("Couldn't save the backup: ${e.message}", error = true)
            }
        }
    }

    /** @return true if a passphrase is needed (and the import didn't run). */
    suspend fun importPrivate(bytes: ByteArray, passphrase: CharArray?): Boolean = try {
        val r = withContext(Dispatchers.IO) { g.privateNotes.importBackup(bytes, passphrase) }
        msg("Imported ${r.added} new, ${r.updated} updated" + if (r.skipped > 0) ", ${r.skipped} unchanged" else "")
        false
    } catch (_: PrivateNotesRepository.PassphraseRequired) {
        true
    } catch (e: javax.crypto.AEADBadTagException) {
        msg("Wrong passphrase, or the file is damaged.", error = true)
        true
    } catch (e: Exception) {
        msg(e.message ?: "Import failed.", error = true)
        false
    }

    // ── editor ───────────────────────────────────────────────────
    fun openEditor(scope: Scope, id: String?, prefillBody: String = "") {
        editor?.let { e -> if (e.dirty) viewModelScope.launch { save(e) } }
        val e = when (scope) {
            Scope.PRIVATE -> g.privateNotes.get(id ?: "")?.let { EditorState(scope, it.id, null, it.title, it.tags.joinToString(", "), it.body) }
            Scope.SHARED -> snapshot.value?.notes?.firstOrNull { it.id == id }?.let { EditorState(scope, it.id, it.version, it.title, it.tags.joinToString(", "), it.body) }
        } ?: EditorState(scope, null, null, "", "", prefillBody)
        editor = e
        screen = Screen.Editor
        if (prefillBody.isNotEmpty()) onEditorChange(e)
    }

    fun editorReadOnly(e: EditorState): Boolean =
        e.scope == Scope.SHARED && !canEdit(snapshot.value?.notes?.firstOrNull { it.id == e.id })

    fun onEditorChange(e: EditorState, title: String = e.title, tags: String = e.tags, body: String = e.body) {
        if (editorReadOnly(e)) return
        e.title = title
        e.tags = tags
        e.body = body
        e.dirty = true
        e.seq++
        if (e.conflict == null && !e.deletedRemotely) {
            e.status = "Editing…"
            e.statusError = false
        }
        e.saveJob?.cancel()
        e.saveJob = viewModelScope.launch {
            delay(if (e.scope == Scope.PRIVATE) 400 else 800)
            save(e)
        }
    }

    fun saveNow() {
        editor?.let { e -> viewModelScope.launch { save(e) } }
    }

    private suspend fun save(e: EditorState) {
        if (!e.dirty || e.conflict != null || e.deletedRemotely) return
        val title = NoteText.cleanTitle(e.title)
        val tags = NoteText.parseTags(e.tags)
        val body = e.body
        if (title.isBlank() && body.isBlank()) {
            e.status = if (e.id != null) "Empty notes aren't saved" else ""
            return
        }
        val seq = e.seq
        if (e.scope == Scope.PRIVATE) {
            val n = local { if (e.id == null) create(title, body, tags) else update(e.id!!, title, body, tags) } ?: run {
                e.status = "Not saved"
                e.statusError = true
                return
            }
            e.id = n.id
            if (e.seq == seq) e.dirty = false
            e.status = "Saved on this phone"
            e.statusError = false
            return
        }
        if (e.saving) {
            e.pending = true
            return
        }
        if (!g.sync.isOnline || Outbox.isLocalId(e.id)) {
            saveOffline(e, title, body, tags, seq)
            return
        }
        e.saving = true
        e.status = "Saving…"
        try {
            val token = g.sync.token ?: throw ApiException(0, "Not connected")
            val base = g.sync.base()
            val n = if (e.id == null) g.sync.api.createNote(base, token, title, body, tags)
            else g.sync.api.updateNote(base, token, e.id!!, title = title, body = body, tags = tags, baseVersion = e.version)
            e.id = n.id
            e.version = n.version
            g.sync.applyNote(n)
            if (e.seq == seq) e.dirty = false
            e.status = "Saved · shared"
            e.statusError = false
        } catch (ex: CancellationException) {
            throw ex
        } catch (ex: ApiException) {
            when {
                ex.isConflict -> ex.body?.optJSONObject("note")?.let { e.conflict = io.github.salmanulharis.clipbox.core.model.Json.sharedNote(it) }
                ex.status == 404 -> e.deletedRemotely = true
                ex.isOffline -> Unit
                else -> e.status = ex.message ?: "Not saved"
            }
            e.statusError = true
            if (ex.isConflict || ex.status == 404) e.status = "Not saved"
            if (ex.isOffline) {
                e.saving = false
                saveOffline(e, title, body, tags, seq)
            }
        } finally {
            e.saving = false
            if (e.pending) {
                e.pending = false
                if (e.dirty) save(e)
            }
        }
    }

    /** Shared note edited while offline: keep it in the encrypted outbox; it syncs on reconnect. */
    private suspend fun saveOffline(e: EditorState, title: String, body: String, tags: List<String>, seq: Int) {
        try {
            val id = e.id
            val newId = withContext(Dispatchers.IO) {
                if (id == null) g.sync.queueNoteCreate(title, body, tags)
                else { g.sync.queueNoteUpdate(id, e.version, title, body, tags); id }
            } ?: throw IllegalStateException("Connect to a server first.")
            e.id = newId
            if (e.seq == seq) e.dirty = false
            e.status = "Saved on this phone · syncs when you're back online"
            e.statusError = false
        } catch (ex: CancellationException) {
            throw ex
        } catch (ex: Exception) {
            e.status = ex.message ?: "Not saved"
            e.statusError = true
        }
    }

    /** Back from the editor: saves first; asks before discarding unsaved changes. */
    fun closeEditor(discard: Boolean = false) {
        val e = editor ?: return
        viewModelScope.launch {
            e.saveJob?.cancel()
            if (!discard) {
                while (e.saving) delay(40)
                if (e.dirty) save(e)
                while (e.saving) delay(40)
                if (e.conflict != null || e.deletedRemotely || (e.dirty && (e.title.isNotBlank() || e.body.isNotBlank()))) {
                    e.leavePrompt = true
                    return@launch
                }
            }
            if (editor === e) {
                editor = null
                screen = Screen.Home
            }
        }
    }

    fun keepMine(e: EditorState) {
        val c = e.conflict ?: return
        e.version = c.version
        e.conflict = null
        e.dirty = true
        viewModelScope.launch { save(e) }
    }

    fun useTheirs(e: EditorState) {
        val c = e.conflict ?: return
        e.title = c.title
        e.tags = c.tags.joinToString(", ")
        e.body = c.body
        e.version = c.version
        e.conflict = null
        e.dirty = false
        e.status = "Showing ${c.updatedByName}'s version"
        e.statusError = false
    }

    fun saveAsNew(e: EditorState) {
        e.id = null
        e.version = null
        e.deletedRemotely = false
        e.dirty = true
        viewModelScope.launch { save(e) }
    }

    fun editorPin(e: EditorState) {
        viewModelScope.launch {
            if (e.dirty) save(e)
            val id = e.id ?: return@launch msg("Write something first.", error = true)
            if (e.scope == Scope.PRIVATE) g.privateNotes.get(id)?.let(::togglePinPrivate)
            else snapshot.value?.notes?.firstOrNull { it.id == id }?.let(::togglePinShared)
        }
    }

    fun editorLock(e: EditorState) {
        val n = snapshot.value?.notes?.firstOrNull { it.id == e.id } ?: return
        viewModelScope.launch {
            server { b, t -> g.sync.api.updateNote(b, t, n.id, locked = !n.locked) }?.let {
                g.sync.applyNote(it)
                msg(if (it.locked) "Locked — only you and the host can edit" else "Unlocked — everyone can edit")
            }
        }
    }

    /** Private → shared copy (after the UI confirmed), or shared → private copy. */
    fun editorCopyTo(e: EditorState) {
        val title = NoteText.cleanTitle(e.title)
        val tags = NoteText.parseTags(e.tags)
        if (title.isBlank() && e.body.isBlank()) return msg("Write something first.", error = true)
        viewModelScope.launch {
            if (e.scope == Scope.PRIVATE) {
                save(e)
                val id = createShared(title, e.body, tags) ?: return@launch
                msg(if (Outbox.isLocalId(id)) "A copy will be shared when you're back online" else "Shared a copy with everyone")
            } else {
                local { create(title, e.body, tags) }?.let { msg("Saved a private copy on this phone") }
            }
        }
    }

    fun editorDelete(e: EditorState) {
        e.saveJob?.cancel()
        val id = e.id
        if (id == null) {
            e.dirty = false
            closeEditor(discard = true)
            return
        }
        if (e.scope == Scope.PRIVATE) {
            g.privateNotes.get(id)?.let(::trashPrivate)
            e.dirty = false
            closeEditor(discard = true)
        } else {
            snapshot.value?.notes?.firstOrNull { it.id == id }?.let { n ->
                deleteShared(n) {
                    e.dirty = false
                    closeEditor(discard = true)
                }
            }
        }
    }

    /** Keep an open shared note in step with changes from other devices. */
    private fun onSnapshot() {
        val e = editor ?: return
        if (e.scope != Scope.SHARED || e.id == null || e.saving || e.conflict != null || e.deletedRemotely) return
        if (Outbox.isLocalId(e.id)) return // created offline; NoteSynced will give it its real id
        val n = snapshot.value?.notes?.firstOrNull { it.id == e.id }
        if (n == null) {
            if (connection.value !is Connection.Online) return
            if (e.dirty) e.deletedRemotely = true
            else {
                msg("This note was deleted on another device.", error = true)
                editor = null
                screen = Screen.Home
            }
        } else if (n.version > (e.version ?: 0) && !e.dirty) {
            e.title = n.title
            e.tags = n.tags.joinToString(", ")
            e.body = n.body
            e.version = n.version
            e.status = "Updated by ${n.updatedByName}"
        }
    }

    companion object {
        fun active(list: List<PrivateNote>) = list.filter { it.deletedAt == null }
    }
}
