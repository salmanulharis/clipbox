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
import io.github.salmanulharis.clipbox.network.ServerProfile
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
    val privateNotes = g.privateNotes.notes

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
            ready = true
            activeProfile?.let(g.sync::start)
            snapshot.collect { onSnapshot() }
        }
    }

    // ── lifecycle ────────────────────────────────────────────────
    fun onForeground() {
        if (ready) activeProfile?.let { if (connection.value is Connection.Idle) g.sync.start(it) }
    }

    fun onBackground() {
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
        val info = try {
            g.api.info(link.baseUrl)
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
            g.api.pair(link.baseUrl, link.pairToken?.takeIf { password == null }, password, deviceName())
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
        )
        withContext(Dispatchers.IO) { g.profiles.upsert(profile) }
        if (old != null) g.scope.launch(Dispatchers.IO) { runCatching { g.api.disconnect(link.baseUrl, old.deviceToken) } }
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
            if (base != null) runCatching { g.api.disconnect(base, p.deviceToken) }
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
        g.sync.clear()
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

    fun addText(clipboardId: String, text: String, onDone: (Boolean) -> Unit = {}) {
        if (text.isBlank()) return
        viewModelScope.launch {
            val item = server { b, t -> g.api.addText(b, t, clipboardId, text) }
            if (item != null) g.sync.applyItem(clipboardId, item)
            onDone(item != null)
        }
    }

    fun deleteItem(clipboardId: String, item: ClipItem) {
        viewModelScope.launch {
            if (server { b, t -> g.api.deleteItem(b, t, clipboardId, item.id) } != null) {
                g.sync.removeItem(clipboardId, item.id)
                if (item.isText && item.text != null) msg("Item deleted", actionLabel = "Undo") { addText(clipboardId, item.text!!) }
                else msg("Item deleted")
            }
        }
    }

    fun createClipboard(name: String) {
        viewModelScope.launch {
            server { b, t -> g.api.createClipboard(b, t, name) }?.let {
                g.sync.applyClipboard(it)
                activeClipboardId = it.id
            }
        }
    }

    fun renameClipboard(id: String, name: String) {
        viewModelScope.launch { server { b, t -> g.api.renameClipboard(b, t, id, name) }?.let(g.sync::applyClipboard) }
    }

    fun clearClipboard(id: String) {
        viewModelScope.launch { server { b, t -> g.api.clearClipboard(b, t, id) }?.let { g.sync.applyClipboard(it); msg("Clipboard cleared") } }
    }

    fun deleteClipboard(id: String) {
        viewModelScope.launch {
            if (server { b, t -> g.api.deleteClipboard(b, t, id) } != null) {
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
            val bytes = g.api.fileBytes(base, token, item.id)
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

    // ── shared notes ─────────────────────────────────────────────
    fun canEdit(n: SharedNote?): Boolean =
        role.canWrite && (n == null || !n.locked || role == Role.HOST || n.authorId == myDeviceId)

    fun canLock(n: SharedNote): Boolean = role.canWrite && (role == Role.HOST || n.authorId == myDeviceId)

    fun togglePinShared(n: SharedNote) {
        viewModelScope.launch { server { b, t -> g.api.updateNote(b, t, n.id, pinned = !n.pinned) }?.let(g.sync::applyNote) }
    }

    fun deleteShared(n: SharedNote, after: () -> Unit = {}) {
        viewModelScope.launch {
            if (server { b, t -> g.api.deleteNote(b, t, n.id) } != null) {
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
        e.saving = true
        e.status = "Saving…"
        try {
            val token = g.sync.token ?: throw ApiException(0, "Not connected")
            val base = g.sync.base()
            val n = if (e.id == null) g.api.createNote(base, token, title, body, tags)
            else g.api.updateNote(base, token, e.id!!, title = title, body = body, tags = tags, baseVersion = e.version)
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
                ex.isOffline -> {
                    e.status = "Offline — will retry"
                    e.saveJob = viewModelScope.launch { delay(3000); save(e) }
                }
                else -> e.status = ex.message ?: "Not saved"
            }
            e.statusError = true
            if (ex.isConflict || ex.status == 404) e.status = "Not saved"
        } finally {
            e.saving = false
            if (e.pending) {
                e.pending = false
                if (e.dirty) save(e)
            }
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
            server { b, t -> g.api.updateNote(b, t, n.id, locked = !n.locked) }?.let {
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
                server { b, t -> g.api.createNote(b, t, title, e.body, tags) }?.let {
                    g.sync.applyNote(it)
                    msg("Shared a copy with everyone")
                }
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
