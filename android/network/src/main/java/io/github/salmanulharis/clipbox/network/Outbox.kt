package io.github.salmanulharis.clipbox.network

import io.github.salmanulharis.clipbox.core.storage.EncryptedFileStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** One change made while offline, waiting to be sent to the server. */
data class OutboxOp(
    val opId: String,
    val kind: Kind,
    /** Server note id (updates/deletes) or the temporary local id of a note created offline. */
    val noteId: String? = null,
    /** Version the edit was based on, for conflict detection when it is finally sent. */
    val baseVersion: Int? = null,
    val title: String? = null,
    val body: String? = null,
    val tags: List<String>? = null,
    val clipboardId: String? = null,
    val text: String? = null,
    /** Group a note created offline belongs to (null: the server's default group). */
    val groupId: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
) {
    enum class Kind { NOTE_CREATE, NOTE_UPDATE, NOTE_DELETE, CLIP_ADD }
}

/**
 * Offline changes for one server, stored encrypted and sent in order on reconnect.
 * Edits are coalesced: several edits to one note become one update, edits to a note
 * created offline are folded into its creation, and deleting such a note cancels it.
 */
class Outbox(private val store: EncryptedFileStore) {
    private val _ops = MutableStateFlow<List<OutboxOp>>(emptyList())
    val ops: StateFlow<List<OutboxOp>> = _ops.asStateFlow()

    val isEmpty: Boolean get() = _ops.value.isEmpty()

    @Synchronized
    fun load() {
        val arr = store.read()?.let { runCatching { JSONObject(it).optJSONArray("ops") }.getOrNull() } ?: JSONArray()
        _ops.value = List(arr.length()) { fromJson(arr.getJSONObject(it)) }
    }

    /** New note created offline; returns its temporary local id. */
    @Synchronized
    fun createNote(title: String, body: String, tags: List<String>, groupId: String? = null): String {
        val localId = LOCAL_PREFIX + UUID.randomUUID().toString().replace("-", "").take(16)
        commit(_ops.value + OutboxOp(newOpId(), OutboxOp.Kind.NOTE_CREATE, noteId = localId, title = title, body = body, tags = tags, groupId = groupId))
        return localId
    }

    @Synchronized
    fun updateNote(noteId: String, baseVersion: Int?, title: String, body: String, tags: List<String>) {
        val list = _ops.value
        val create = list.firstOrNull { it.kind == OutboxOp.Kind.NOTE_CREATE && it.noteId == noteId }
        val update = list.firstOrNull { it.kind == OutboxOp.Kind.NOTE_UPDATE && it.noteId == noteId }
        commit(
            when {
                create != null -> list.map { if (it === create) it.copy(title = title, body = body, tags = tags) else it }
                // keep the original baseVersion: that's what the offline edits were based on
                update != null -> list.map { if (it === update) it.copy(title = title, body = body, tags = tags, createdAt = System.currentTimeMillis()) else it }
                else -> list + OutboxOp(newOpId(), OutboxOp.Kind.NOTE_UPDATE, noteId = noteId, baseVersion = baseVersion, title = title, body = body, tags = tags)
            },
        )
    }

    @Synchronized
    fun deleteNote(noteId: String) {
        val list = _ops.value.filterNot { it.noteId == noteId && it.kind == OutboxOp.Kind.NOTE_UPDATE }
        commit(
            if (list.any { it.kind == OutboxOp.Kind.NOTE_CREATE && it.noteId == noteId }) list.filterNot { it.noteId == noteId }
            else list + OutboxOp(newOpId(), OutboxOp.Kind.NOTE_DELETE, noteId = noteId),
        )
    }

    @Synchronized
    fun addClipText(clipboardId: String, text: String) {
        commit(_ops.value + OutboxOp(newOpId(), OutboxOp.Kind.CLIP_ADD, clipboardId = clipboardId, text = text))
    }

    @Synchronized
    fun remove(opId: String) = commit(_ops.value.filterNot { it.opId == opId })

    /** After a note created offline reaches the server, point later ops at its real id. */
    @Synchronized
    fun replaceNoteId(localId: String, realId: String) =
        commit(_ops.value.map { if (it.noteId == localId) it.copy(noteId = realId) else it })

    @Synchronized
    fun clear() {
        _ops.value = emptyList()
        store.delete()
    }

    private fun commit(next: List<OutboxOp>) {
        require(next.size <= MAX_OPS) { "Too many offline changes. Reconnect to sync them first." }
        if (next.isEmpty()) store.delete()
        else store.write(JSONObject().put("ops", JSONArray(next.map(::toJson))).toString())
        _ops.value = next
    }

    private fun toJson(o: OutboxOp) = JSONObject()
        .put("opId", o.opId).put("kind", o.kind.name).put("noteId", o.noteId ?: JSONObject.NULL)
        .put("baseVersion", o.baseVersion ?: JSONObject.NULL).put("title", o.title ?: JSONObject.NULL)
        .put("body", o.body ?: JSONObject.NULL).put("tags", o.tags?.let { JSONArray(it) } ?: JSONObject.NULL)
        .put("clipboardId", o.clipboardId ?: JSONObject.NULL).put("text", o.text ?: JSONObject.NULL)
        .put("groupId", o.groupId ?: JSONObject.NULL).put("createdAt", o.createdAt)

    private fun fromJson(o: JSONObject): OutboxOp {
        fun str(k: String) = if (o.has(k) && !o.isNull(k)) o.getString(k) else null
        val tags = o.optJSONArray("tags")
        return OutboxOp(
            opId = o.getString("opId"),
            kind = OutboxOp.Kind.valueOf(o.getString("kind")),
            noteId = str("noteId"),
            baseVersion = if (o.has("baseVersion") && !o.isNull("baseVersion")) o.getInt("baseVersion") else null,
            title = str("title"),
            body = str("body"),
            tags = tags?.let { a -> List(a.length()) { a.getString(it) } },
            clipboardId = str("clipboardId"),
            text = str("text"),
            groupId = str("groupId"),
            createdAt = o.optLong("createdAt"),
        )
    }

    companion object {
        const val LOCAL_PREFIX = "local_"
        const val MAX_OPS = 500
        fun isLocalId(id: String?) = id?.startsWith(LOCAL_PREFIX) == true
        private fun newOpId() = UUID.randomUUID().toString()
    }
}
