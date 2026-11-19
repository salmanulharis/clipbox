package io.github.salmanulharis.clipbox.network

import io.github.salmanulharis.clipbox.core.model.ClipItem
import io.github.salmanulharis.clipbox.core.model.Clipboard
import io.github.salmanulharis.clipbox.core.model.Json
import io.github.salmanulharis.clipbox.core.model.SharedNote
import io.github.salmanulharis.clipbox.core.model.Snapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
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

/**
 * Keeps one server's shared data in sync while the app is in the foreground:
 * finds a working address (verifying the server id), loads the state, then follows live updates
 * over Server-Sent Events, falling back to long-polling if a proxy buffers the stream.
 * The last snapshot is cached (encrypted) for read-only use while offline.
 */
class SyncEngine(
    private val api: ClipBoxApi,
    private val profiles: ProfileStore,
    private val cache: SharedCache,
    private val scope: CoroutineScope,
) {
    private val _connection = MutableStateFlow<Connection>(Connection.Idle)
    private val _snapshot = MutableStateFlow<Snapshot?>(null)
    val connection: StateFlow<Connection> = _connection.asStateFlow()
    val snapshot: StateFlow<Snapshot?> = _snapshot.asStateFlow()

    private var job: Job? = null
    private var profile: ServerProfile? = null

    val token: String? get() = profile?.deviceToken

    /** Current base URL, or throws an offline ApiException. */
    fun base(): String = (connection.value as? Connection.Online)?.base
        ?: throw ApiException(0, "You're offline. Changes can't be saved right now.", "offline")

    fun start(p: ServerProfile) {
        stop()
        profile = p
        if (_snapshot.value?.serverId != p.serverId) _snapshot.value = cache.read(p.serverId)
        job = scope.launch(Dispatchers.IO) { loop(p) }
    }

    fun stop() {
        job?.cancel()
        job = null
        if (_connection.value !is Connection.Revoked) _connection.value = Connection.Idle
    }

    fun clear() {
        stop()
        profile = null
        _snapshot.value = null
        _connection.value = Connection.Idle
    }

    /** Reload everything now (e.g. pull-to-refresh). */
    fun refresh() {
        profile?.let(::start)
    }

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
                loadState(base)
                profiles.update(p.serverId) { it.copy(lastGoodUrl = base, role = _snapshot.value?.me?.role ?: it.role) }
                failures = 0
                _connection.value = Connection.Online(base, live = true)
                if (!stream(base, p.deviceToken)) {
                    _connection.value = Connection.Online(base, live = false)
                    poll(base, p.deviceToken)
                }
            } catch (e: ApiException) {
                if (e.status == 401 || e.status == 403 && e.reason == "no_password") {
                    _connection.value = Connection.Revoked
                    return
                }
                _connection.value = Connection.Offline(if (e.isOffline) "Connection lost. Reconnecting…" else e.message ?: "Error")
                delay(backoff(++failures))
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
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
            } catch (_: ApiException) {
                // unreachable; try the next address
            }
        }
        if (mismatch != null) throw ApiException(-1, mismatch, "wrong_server")
        return null
    }

    private suspend fun loadState(base: String) {
        val p = profile ?: return
        val s = api.state(base, p.deviceToken)
        set(s)
    }

    private fun set(s: Snapshot) {
        _snapshot.value = s
        val id = profile?.serverId ?: return
        scope.launch(Dispatchers.IO) { runCatching { cache.write(id, s) } }
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
                            handle(event, data.toString(), base, token)
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
            val s = _snapshot.value
            val o = api.sync(base, token, s?.rev ?: 0, s?.boot ?: "")
            val fresh = Json.snapshot(o)
            if (fresh.rev != s?.rev || fresh.boot != s.boot) loadState(base) // full state includes `me`
        }
    }

    private suspend fun handle(event: String, data: String, base: String, token: String) {
        val o = try {
            JSONObject(data)
        } catch (_: Exception) {
            return
        }
        val s = _snapshot.value
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
    fun applyNote(n: SharedNote) = _snapshot.value?.let { set(withNote(it, n)) }
    fun removeNote(id: String) = _snapshot.value?.let { set(it.copy(notes = it.notes.filterNot { n -> n.id == id })) }
    fun applyClipboard(cb: Clipboard) = _snapshot.value?.let { set(withClipboard(it, cb, null)) }
    fun removeClipboard(id: String) = _snapshot.value?.let { set(it.copy(clipboards = it.clipboards.filterNot { c -> c.id == id })) }
    fun applyItem(clipboardId: String, item: ClipItem) = _snapshot.value?.let { s ->
        set(s.copy(clipboards = s.clipboards.map { c -> if (c.id == clipboardId && c.items.none { it.id == item.id }) c.copy(items = listOf(item) + c.items) else c }))
    }
    fun removeItem(clipboardId: String, itemId: String) = _snapshot.value?.let { s ->
        set(s.copy(clipboards = s.clipboards.map { c -> if (c.id == clipboardId) c.copy(items = c.items.filterNot { it.id == itemId }) else c }))
    }
}
