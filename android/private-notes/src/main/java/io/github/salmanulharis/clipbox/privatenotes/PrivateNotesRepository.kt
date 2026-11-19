package io.github.salmanulharis.clipbox.privatenotes

import io.github.salmanulharis.clipbox.core.model.Json
import io.github.salmanulharis.clipbox.core.model.NoteText
import io.github.salmanulharis.clipbox.core.model.PrivateNote
import io.github.salmanulharis.clipbox.core.security.PassphraseBox
import io.github.salmanulharis.clipbox.core.storage.EncryptedFileStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

/**
 * Private notes, encrypted with a key that never leaves this device's Keystore.
 *
 * There is deliberately no network code here: notes only leave the device through an explicit
 * user action in the UI (copy, encrypted backup, or "Share…" which creates a separate shared note).
 */
class PrivateNotesRepository(
    private val store: EncryptedFileStore,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val _notes = MutableStateFlow<List<PrivateNote>>(emptyList())

    /** All notes, including those in the trash (deletedAt != null). */
    val notes: StateFlow<List<PrivateNote>> = _notes.asStateFlow()

    /**
     * Set when existing data could not be decrypted (e.g. the Keystore key was lost after a device
     * reset). Writes are then refused so the encrypted file is never overwritten with nothing.
     */
    @Volatile var loadError: String? = null
        private set

    @Synchronized
    fun load() {
        val text = store.read()
        if (text == null) {
            loadError = if (store.exists()) "Your private notes could not be decrypted on this device." else null
            _notes.value = emptyList()
            return
        }
        loadError = null
        val arr = JSONObject(text).optJSONArray("notes") ?: JSONArray()
        val cutoff = clock() - TRASH_MS
        val all = List(arr.length()) { Json.privateNote(arr.getJSONObject(it)) }
        val kept = all.filter { (it.deletedAt ?: Long.MAX_VALUE) > cutoff }
        _notes.value = kept
        if (kept.size != all.size) persist(kept)
    }

    val active: List<PrivateNote> get() = _notes.value.filter { it.deletedAt == null }
    val trash: List<PrivateNote> get() = _notes.value.filter { it.deletedAt != null }

    fun get(id: String): PrivateNote? = _notes.value.firstOrNull { it.id == id }

    @Synchronized
    fun create(title: String, body: String, tags: List<String> = emptyList(), pinned: Boolean = false): PrivateNote {
        val t = clock()
        val note = PrivateNote(newId(), NoteText.cleanTitle(title), body.take(MAX_BODY), tags.take(20), pinned, t, t)
        commit(_notes.value + note)
        return note
    }

    @Synchronized
    fun update(id: String, title: String? = null, body: String? = null, tags: List<String>? = null, pinned: Boolean? = null): PrivateNote {
        val cur = get(id) ?: throw NoSuchElementException("Private note not found")
        val next = cur.copy(
            title = title?.let(NoteText::cleanTitle) ?: cur.title,
            body = body?.take(MAX_BODY) ?: cur.body,
            tags = tags?.take(20) ?: cur.tags,
            pinned = pinned ?: cur.pinned,
            updatedAt = clock(),
        )
        commit(_notes.value.map { if (it.id == id) next else it })
        return next
    }

    @Synchronized fun trash(id: String) = setDeleted(id, clock())
    @Synchronized fun restore(id: String) = setDeleted(id, null)

    @Synchronized
    fun destroy(id: String) = commit(_notes.value.filterNot { it.id == id })

    @Synchronized
    fun emptyTrash(): Int {
        val n = trash.size
        commit(_notes.value.filter { it.deletedAt == null })
        return n
    }

    private fun setDeleted(id: String, at: Long?) {
        commit(_notes.value.map { if (it.id == id) it.copy(deletedAt = at) else it })
    }

    // ── backups ──────────────────────────────────────────────────
    /** Passphrase-encrypted backup of every private note (including trash). */
    fun exportBackup(passphrase: CharArray): ByteArray =
        PassphraseBox.seal(exportJson().toString().toByteArray(Charsets.UTF_8), passphrase)

    private fun exportJson(): JSONObject = JSONObject()
        .put("app", "clipbox")
        .put("kind", "private-notes")
        .put("format", 1)
        .put("exportedAt", clock())
        .put("notes", JSONArray(_notes.value.map(Json::toJson)))

    data class ImportResult(val added: Int, val updated: Int, val skipped: Int)

    class PassphraseRequired : Exception("This backup is encrypted. Enter its passphrase.")

    /**
     * Import an encrypted Android backup, or a plain JSON backup exported by the ClipBox web app.
     * Notes are merged by id: unknown ids are added, known ids keep the newer copy.
     */
    @Synchronized
    fun importBackup(bytes: ByteArray, passphrase: CharArray?): ImportResult {
        val json = if (PassphraseBox.isSealed(bytes)) {
            if (passphrase == null) throw PassphraseRequired()
            String(PassphraseBox.open(bytes, passphrase), Charsets.UTF_8)
        } else {
            String(bytes, Charsets.UTF_8)
        }
        val data = try {
            JSONObject(json)
        } catch (e: Exception) {
            throw IllegalArgumentException("This file is not a ClipBox private-notes backup.")
        }
        require(data.optString("app") == "clipbox" && data.optString("kind") == "private-notes") {
            "This file is not a ClipBox private-notes backup."
        }
        val arr = data.optJSONArray("notes") ?: JSONArray()
        val existing = _notes.value.associateBy { it.id }.toMutableMap()
        var added = 0
        var updated = 0
        var skipped = 0
        for (i in 0 until arr.length()) {
            val n = try {
                sanitize(Json.privateNote(arr.getJSONObject(i)))
            } catch (_: Exception) {
                skipped++
                continue
            }
            if (n.title.isBlank() && n.body.isBlank()) { skipped++; continue }
            val cur = existing[n.id]
            when {
                cur == null -> { existing[n.id] = n; added++ }
                n.updatedAt > cur.updatedAt -> { existing[n.id] = n; updated++ }
                else -> skipped++
            }
        }
        if (added + updated > 0) commit(existing.values.toList())
        return ImportResult(added, updated, skipped)
    }

    private fun sanitize(n: PrivateNote) = n.copy(
        id = if (ID_RE.matches(n.id)) n.id else newId(),
        title = NoteText.cleanTitle(n.title),
        body = n.body.take(MAX_BODY),
        tags = NoteText.parseTags(n.tags.joinToString(",")),
    )

    // ── persistence ──────────────────────────────────────────────
    private fun commit(next: List<PrivateNote>) {
        check(loadError == null) { "Private notes are read-only because they could not be decrypted." }
        persist(next)
        _notes.value = next
    }

    private fun persist(list: List<PrivateNote>) {
        store.write(JSONObject().put("format", 1).put("notes", JSONArray(list.map(Json::toJson))).toString())
    }

    companion object {
        const val TRASH_MS = 30L * 24 * 60 * 60 * 1000
        const val MAX_BODY = 1024 * 1024
        private val ID_RE = Regex("^p_[\\w-]{4,40}$")
        private val rnd = SecureRandom()

        fun newId(): String {
            val b = ByteArray(12).also(rnd::nextBytes)
            return "p_" + b.joinToString("") { (it.toInt() and 0xff).toString(36).padStart(2, '0') }.take(18)
        }
    }
}
