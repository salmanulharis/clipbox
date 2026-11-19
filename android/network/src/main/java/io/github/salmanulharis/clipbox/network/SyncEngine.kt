package io.github.salmanulharis.clipbox.network

import io.github.salmanulharis.clipbox.core.model.ClipItem
import io.github.salmanulharis.clipbox.core.model.Clipboard
import io.github.salmanulharis.clipbox.core.model.Json
import io.github.salmanulharis.clipbox.core.model.SharedNote
import io.github.salmanulharis.clipbox.core.model.Snapshot
import io.github.salmanulharis.clipbox.core.storage.EncryptedFileStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.coroutines.coroutineContext

sealed interface Connection {
    data object Idle : Connection
    data object Connecting : Connection
    /** [base] is the address in use; [live] is false when falling back to long-polling. */
    data class Online(val base: String, val live: Boolean) : Connection
    data class Offline(val message: String) : Connection
    /** The host removed this device; it must pair again. */
    data object Revoked : Connection
    /** A different ClipBox answered at every saved address. */
    data class WrongServer(val message: String) : Connection
}

/** Things the UI should know about while syncing. */
sealed interface SyncEvent {
    /** A note created offline reached the server and got its real id. */
    data class NoteSynced(val localId: String?, val note: SharedNote) : SyncEvent
    /** Something worth telling the user (e.g. an offline edit saved as a copy). */
    data class Notice(val message: String) : SyncEvent
}

/**
 * Keeps one server's shared data in sync while the app is in the foreground:
 * finds a working address (verifying the server id), sends offline changes from the outbox,
 * loads the state, then follows live updates over Server-Sent Events, falling back to
 * long-polling if a proxy buffers the stream. The last snapshot is cached (encrypted) for
 * offline use, and pending offline changes are shown on top of it.
 */
class SyncEngine(
    private val baseApi: ClipBoxApi,
    private val profiles: ProfileStore,
    private val cache: SharedCache,
    private val scope: CoroutineScope,
    /** Creates an encrypted store by name (used for each server's outbox). */
    private val storeFor: (String) -> EncryptedFileStore,
) {
    private val _connection = MutableStateFlow<Connection>(Connection.Idle)
    private val _snapshot = MutableStateFlow<Snapshot?>(null)
    private val _pending = MutableStateFlow<Set<String>>(emptySet())
    private val _events = MutableSharedFlow<SyncEvent>(extraBufferCapacity = 32)
    val connection: StateFlow<Connection> = _connection.asStateFlow()
    /** Server data with pending offline changes applied. */
    val snapshot: StateFlow<Snapshot?> = _snapshot.asStateFlow()
    /** Ids of notes / clipboard items that are waiting to sync. */
    val pending: StateFlow<Set<String>> = _pending.asStateFlow()
    val events: SharedFlow<SyncEvent> = _events

    /**
     * Called with content that could not be synced and has nowhere else to go (e.g. the device
     * became view-only, or the server was forgotten). The app saves it as a private note.
     */
    var onUnsynced: ((title: String, body: String) -> Unit)? = null

    /** API client for the active server (pinned to its certificate when it has one). */
    var api: ClipBoxApi = baseApi
        private set
    var outbox: Outbox? = null
        private set

    private var job: Job? = null
    private var profile: ServerProfile? = null
    private var server: Snapshot? = null // last state from the server (or cache), without pending changes
    private val flushLock = Mutex()

    val token: String? get() = profile?.deviceToken
    val isOnline: Boolean get() = connection.value is Connection.Online

    /** Current base URL, or throws an offline ApiException. */
    fun base(): String = (connection.value as? Connection.Online)?.base
        ?: throw ApiException(0, "You're offline. Changes can't be saved right now.", "offline")

    fun start(p: ServerProfile) {
        stop()
        val switching = profile?.serverId != p.serverId
        profile = p
        api = baseApi.pinned(p.certSha256)
        if (switching || outbox == null) {
            outbox = Outbox(storeFor("outbox-" + safe(p.serverId))).also { it.load() }
            server = cache.read(p.serverId)
            publish()
        }
        job = scope.launch(Dispatchers.IO) { loop(p) }
    }

    fun stop() {
        job?.cancel()
        job = null
        if (_connection.value !is Connection.Revoked) _connection.value = Connection.Idle
    }

    /** Forget this server locally. Unsent offline changes are handed to [onUnsynced] first. */
    fun clear() {
        stop()
        outbox?.let { ob ->
            ob.ops.value.forEach(::rescue)
            ob.clear()
        }
        outbox = null
        profile = null
        server = null
        _snapshot.value = null
        _pending.value = emptySet()
        _connection.value = Connection.Idle
    }

    /** Reload everything now (e.g. pull-to-refresh). */
    fun refresh() {
        profile?.let(::start)
    }

    private fun safe(id: String) = id.replace(Regex("[^\\w-]"), "_")

    private suspend fun loop(p: ServerProfile) {
        var failures = 0
        while (coroutineContext.isActive) {
            _connection.value = Connection.Connecting
            val base = try {
                resolveBase(p)
            } catch (e: ApiException) {
                null.also { _connection.value = Connection.WrongServer(e.message ?: "Different server") }
            }
            if (base == null) {
                if (_connection.value !is Connection.WrongServer) {
                    _connection.value = Connection.Offline("Can't reach ${p.serverName}. Showing saved data.")
                }
                delay(backoff(++failures))
                continue
            }
            try {
                flushOutbox(base, p.deviceToken)
                loadState(base)
                profiles.update(p.serverId) { it.copy(lastGoodUrl = base, role = server?.me?.role ?: it.role) }
                failures = 0
                _connection.value = Connection.Online(base, live = true)
                if (!stream(base, p.deviceToken)) {
                    _connection.value = Connection.Online(base, live = false)
                    poll(base, p.deviceToken)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (e.status == 401 || e.status == 403 && e.reason == "no_password") {
                    _connection.value = Connection.Revoked
                    return
                }
                _connection.value = Connection.Offline(if (e.isOffline) "Connection lost. Reconnecting…" else e.message ?: "Error")
                delay(backoff(++failures))
            } catch (e: Exception) {
                _connection.value = Connection.Offline("Unexpected response from the server. Retrying…")
                delay(backoff(++failures))
            }
        }
    }

    private fun backoff(n: Int): Long = minOf(30_000L, 1_000L * (1L shl minOf(n, 5)))

    /** Try saved addresses in order; return the first that is this same server. */
    private suspend fun resolveBase(p: ServerProfile): String? {
        var mismatch: String? = null
        for (url in p.candidates()) {
            try {
                val info = api.info(url, quick = true)
                if (info.serverId == p.serverId) return url
                mismatch = "A different ClipBox (\"${info.serverName}\") is running at $url. Scan the QR code of \"${p.serverName}\" again."
            } catch (e: ApiException) {
                if (e.reason == "tls") mismatch = e.message
            }
        }
        if (mismatch != null) throw ApiException(-1, mismatch, "wrong_server")
        return null
    }

    private suspend fun loadState(base: String) {
        val p = profile ?: return
        set(api.state(base, p.deviceToken))
    }

    private fun set(s: Snapshot) {
        server = s
        publish()
        val id = profile?.serverId ?: return
        scope.launch(Dispatchers.IO) { runCatching { cache.write(id, s) } }
    }

    /** Recompute what the UI sees: server data + pending offline changes. */
    private fun publish() {
        val s = server
        val ops = outbox?.ops?.value.orEmpty()
        _pending.value = ops.mapNotNull { if (it.kind == OutboxOp.Kind.CLIP_ADD) LOCAL_ITEM + it.opId else it.noteId }.toSet()
        _snapshot.value = s?.let { applyPending(it, ops) }
    }

    private fun applyPending(s: Snapshot, ops: List<OutboxOp>): Snapshot {
        var notes = s.notes
        var cbs = s.clipboards
        for (op in ops) {
            when (op.kind) {
                OutboxOp.Kind.NOTE_CREATE -> notes = notes + SharedNote(
                    id = op.noteId!!, title = op.title.orEmpty(), body = op.body.orEmpty(), tags = op.tags.orEmpty(),
                    pinned = false, locked = false, authorId = s.me?.deviceId, authorName = s.me?.name ?: "This phone",
                    version = 0, createdAt = op.createdAt, updatedAt = op.createdAt,
                    updatedBy = s.me?.deviceId, updatedByName = s.me?.name ?: "This phone",
                )
                OutboxOp.Kind.NOTE_UPDATE -> notes = notes.map {
                    if (it.id == op.noteId) it.copy(title = op.title.orEmpty(), body = op.body.orEmpty(), tags = op.tags.orEmpty(), updatedAt = op.createdAt) else it
                }
                OutboxOp.Kind.NOTE_DELETE -> notes = notes.filterNot { it.id == op.noteId }
                OutboxOp.Kind.CLIP_ADD -> cbs = cbs.map { c ->
                    if (c.id != op.clipboardId) c
                    else c.copy(items = listOf(ClipItem(LOCAL_ITEM + op.opId, "text", op.text, null, null, 0, op.createdAt, op.createdAt)) + c.items)
                }
            }
        }
        return s.copy(notes = notes, clipboards = cbs)
    }

    // ── offline changes ──────────────────────────────────────────
    fun queueNoteCreate(title: String, body: String, tags: List<String>): String? =
        outbox?.createNote(title, body, tags).also { publish(); flushSoon() }

    fun queueNoteUpdate(noteId: String, baseVersion: Int?, title: String, body: String, tags: List<String>) {
        outbox?.updateNote(noteId, baseVersion, title, body, tags) ?: return
        publish()
        flushSoon()
    }

    fun queueNoteDelete(noteId: String) {
        outbox?.deleteNote(noteId) ?: return
        publish()
        flushSoon()
    }

    fun queueClipText(clipboardId: String, text: String) {
        outbox?.addClipText(clipboardId, text) ?: return
        publish()
        flushSoon()
    }

    /** If we're online, try sending queued changes now. */
    fun flushSoon() {
        val base = (connection.value as? Connection.Online)?.base ?: return
        val token = token ?: return
        scope.launch(Dispatchers.IO) {
            runCatching { flushOutbox(base, token) }
        }
    }

    /**
     * Send queued changes in order. Stops (keeping the rest) when the network fails.
     * A change the server rejects is never dropped: an edit that conflicts or whose note is
     * gone is saved as a separate shared note, and if even that is impossible the content
     * goes to [onUnsynced].
     */
    private suspend fun flushOutbox(base: String, token: String) = flushLock.withLock {
        val ob = outbox ?: return@withLock
        while (true) {
            val op = ob.ops.value.firstOrNull() ?: break
            try {
                when (op.kind) {
                    OutboxOp.Kind.NOTE_CREATE -> {
                        val n = api.createNote(base, token, op.title.orEmpty(), op.body.orEmpty(), op.tags.orEmpty())
                        ob.replaceNoteId(op.noteId!!, n.id)
                        server = server?.let { s -> s.copy(notes = s.notes.filterNot { it.id == n.id } + n) }
                        _events.tryEmit(SyncEvent.NoteSynced(op.noteId, n))
                    }
                    OutboxOp.Kind.NOTE_UPDATE -> {
                        val n = api.updateNote(base, token, op.noteId!!, title = op.title, body = op.body, tags = op.tags, baseVersion = op.baseVersion)
                        server = server?.let { s -> s.copy(notes = s.notes.map { if (it.id == n.id) n else it }) }
                        _events.tryEmit(SyncEvent.NoteSynced(null, n))
                    }
                    OutboxOp.Kind.NOTE_DELETE -> try {
                        api.deleteNote(base, token, op.noteId!!)
                    } catch (e: ApiException) {
                        if (e.status != 404) throw e // already gone is fine
                    }
                    OutboxOp.Kind.CLIP_ADD -> api.addText(base, token, op.clipboardId!!, op.text.orEmpty())
                }
            } catch (e: ApiException) {
                if (e.isOffline || e.status == 401 || e.reason == "tls") throw e
                recover(op, e, base, token)
            }
            ob.remove(op.opId)
            publish()
        }
    }

    private suspend fun recover(op: OutboxOp, e: ApiException, base: String, token: String) {
        val title = op.title?.ifBlank { null } ?: "Untitled"
        when (op.kind) {
            OutboxOp.Kind.NOTE_UPDATE, OutboxOp.Kind.NOTE_CREATE -> {
                val copyTitle = if (op.kind == OutboxOp.Kind.NOTE_UPDATE) "$title (offline copy)" else title
                try {
                    val n = api.createNote(base, token, copyTitle, op.body.orEmpty(), op.tags.orEmpty())
                    server = server?.let { s -> s.copy(notes = s.notes + n) }
                    _events.tryEmit(SyncEvent.NoteSynced(if (op.kind == OutboxOp.Kind.NOTE_CREATE) op.noteId else null, n))
                    _events.tryEmit(
                        SyncEvent.Notice(
                            if (e.status == 409) "\"$title\" was changed on another device while you were offline. Your version was saved as \"$copyTitle\"."
                            else "\"$title\" couldn't be updated (${e.message}). Your version was saved as \"$copyTitle\".",
                        ),
                    )
                } catch (inner: ApiException) {
                    if (inner.isOffline) throw inner
                    rescue(op)
                    _events.tryEmit(SyncEvent.Notice("\"$title\" couldn't be shared (${inner.message}). It was saved as a private note instead."))
                }
            }
            OutboxOp.Kind.NOTE_DELETE -> _events.tryEmit(SyncEvent.Notice("A note couldn't be deleted: ${e.message}"))
            OutboxOp.Kind.CLIP_ADD -> {
                rescue(op)
                _events.tryEmit(SyncEvent.Notice("A clipboard item couldn't be added (${e.message}). It was saved as a private note."))
            }
        }
    }

    /** Hand unsendable content to the app (saved as a private note). */
    private fun rescue(op: OutboxOp) {
        when (op.kind) {
            OutboxOp.Kind.NOTE_CREATE, OutboxOp.Kind.NOTE_UPDATE ->
                onUnsynced?.invoke("Unsynced: ${op.title?.ifBlank { null } ?: "note"}", op.body.orEmpty())
            OutboxOp.Kind.CLIP_ADD -> onUnsynced?.invoke("Unsynced clipboard item", op.text.orEmpty())
            OutboxOp.Kind.NOTE_DELETE -> Unit
        }
    }

    // ── live updates ─────────────────────────────────────────────
    /**
     * Follows /api/events until it ends. Returns false if the stream never delivered its "hello"
     * (a proxy is buffering it), so the caller should long-poll instead.
     */
    private suspend fun stream(base: String, token: String): Boolean = withContext(Dispatchers.IO) {
        val res = api.execute(api.streaming, api.request(base, "/api/events", token))
        if (res.code == 401 || res.code == 403) {
            val body = runCatching { JSONObject(res.body?.string().orEmpty()) }.getOrNull()
            res.close()
            throw ApiException(res.code, body?.optString("error") ?: "Unauthorized", body?.optString("reason"))
        }
        if (!res.isSuccessful) {
            res.close()
            throw ApiException(res.code, "Live updates unavailable (${res.code}).")
        }
        var gotHello = false
        val watchdog = scope.launch {
            delay(8_000)
            if (!gotHello) res.close()
        }
        coroutineContext.job.invokeOnCompletion { res.close() }
        try {
            val source = res.body!!.source()
            var event = "message"
            val data = StringBuilder()
            while (isActive) {
                val line = source.readUtf8Line() ?: break
                when {
                    line.isEmpty() -> {
                        if (data.isNotEmpty()) {
                            if (event == "hello") gotHello = true
                            handle(event, data.toString(), base)
                        }
                        event = "message"
                        data.setLength(0)
                    }
                    line.startsWith(":") -> Unit // comment / ping
                    line.startsWith("event:") -> event = line.substringAfter(':').trim()
                    line.startsWith("data:") -> {
                        if (data.isNotEmpty()) data.append('\n')
                        data.append(line.substringAfter(':').removePrefix(" "))
                    }
                }
            }
        } catch (e: ApiException) {
            throw e
        } catch (_: Exception) {
            // stream closed; reconnect below
        } finally {
            watchdog.cancel()
            res.close()
        }
        if (!gotHello) return@withContext false
        throw ApiException(0, "Connection lost. Reconnecting…", "offline")
    }

    private suspend fun poll(base: String, token: String) {
        while (coroutineContext.isActive) {
            val s = server
            val o = api.sync(base, token, s?.rev ?: 0, s?.boot ?: "")
            val fresh = Json.snapshot(o)
            if (fresh.rev != s?.rev || fresh.boot != s.boot) loadState(base) // full state includes `me`
        }
    }

    private suspend fun handle(event: String, data: String, base: String) {
        val o = try {
            JSONObject(data)
        } catch (_: Exception) {
            return
        }
        val s = server
        when (event) {
            "hello" -> if (s == null || o.optInt("rev") != s.rev || o.optString("boot") != s.boot) loadState(base)
            "me" -> loadState(base)
            "change" -> {
                if (s == null || o.optString("boot") != s.boot || o.optInt("rev") > s.rev + 1) return loadState(base)
                if (o.optInt("rev") <= s.rev) return
                set(applyChange(s, o))
            }
        }
    }

    // ── state updates (live events and local results share these) ─
    private fun applyChange(s: Snapshot, ev: JSONObject): Snapshot {
        val rev = ev.optInt("rev")
        val order = ev.optJSONArray("order")?.let { a -> List(a.length()) { a.getString(it) } }
        return when (ev.optString("type")) {
            "clipboard" -> withClipboard(s, Json.clipboard(ev.getJSONObject("clipboard")), order).copy(rev = rev)
            "remove" -> withOrder(s, order).copy(rev = rev)
            "note" -> withNote(s, Json.sharedNote(ev.getJSONObject("note"))).copy(rev = rev)
            "note-remove" -> s.copy(rev = rev, notes = s.notes.filterNot { it.id == ev.optString("id") })
            else -> s.copy(rev = rev)
        }
    }

    private fun withClipboard(s: Snapshot, cb: Clipboard, order: List<String>?): Snapshot {
        val list = if (s.clipboards.any { it.id == cb.id }) s.clipboards.map { if (it.id == cb.id) cb else it } else s.clipboards + cb
        return withOrder(s.copy(clipboards = list), order)
    }

    private fun withOrder(s: Snapshot, order: List<String>?): Snapshot {
        if (order == null) return s
        val pos = order.withIndex().associate { it.value to it.index }
        return s.copy(clipboards = s.clipboards.filter { it.id in pos }.sortedBy { pos[it.id] })
    }

    private fun withNote(s: Snapshot, n: SharedNote): Snapshot =
        s.copy(notes = if (s.notes.any { it.id == n.id }) s.notes.map { if (it.id == n.id) n else it } else s.notes + n)

    /** Apply results of this device's own successful requests immediately (the live event follows). */
    fun applyNote(n: SharedNote) = server?.let { set(withNote(it, n)) }
    fun removeNote(id: String) = server?.let { set(it.copy(notes = it.notes.filterNot { n -> n.id == id })) }
    fun applyClipboard(cb: Clipboard) = server?.let { set(withClipboard(it, cb, null)) }
    fun removeClipboard(id: String) = server?.let { set(it.copy(clipboards = it.clipboards.filterNot { c -> c.id == id })) }
    fun applyItem(clipboardId: String, item: ClipItem) = server?.let { s ->
        set(s.copy(clipboards = s.clipboards.map { c -> if (c.id == clipboardId && c.items.none { it.id == item.id }) c.copy(items = listOf(item) + c.items) else c }))
    }
    fun removeItem(clipboardId: String, itemId: String) = server?.let { s ->
        set(s.copy(clipboards = s.clipboards.map { c -> if (c.id == clipboardId) c.copy(items = c.items.filterNot { it.id == itemId }) else c }))
    }

    companion object {
        const val LOCAL_ITEM = "local_item_"
    }
}
