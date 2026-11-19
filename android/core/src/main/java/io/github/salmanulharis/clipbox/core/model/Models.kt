package io.github.salmanulharis.clipbox.core.model

/** A clipboard item from the server: text, or an uploaded file/image. */
data class ClipItem(
    val id: String,
    val type: String,
    val text: String?,
    val name: String?,
    val mime: String?,
    val size: Long,
    val createdAt: Long,
    val updatedAt: Long,
) {
    val isText: Boolean get() = type == "text"
    val isImage: Boolean get() = type == "file" && mime in IMAGE_TYPES

    companion object {
        val IMAGE_TYPES = setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp")
    }
}

data class Clipboard(
    val id: String,
    val name: String,
    val createdAt: Long,
    val updatedAt: Long,
    val items: List<ClipItem>,
)

/** A note stored on the server and visible to everyone connected to it. */
data class SharedNote(
    val id: String,
    val title: String,
    val body: String,
    val tags: List<String>,
    val pinned: Boolean,
    val locked: Boolean,
    val authorId: String?,
    val authorName: String,
    val version: Int,
    val createdAt: Long,
    val updatedAt: Long,
    val updatedBy: String?,
    val updatedByName: String,
)

/** A note stored only on this device, encrypted. Never sent to the server. */
data class PrivateNote(
    val id: String,
    val title: String,
    val body: String,
    val tags: List<String>,
    val pinned: Boolean,
    val createdAt: Long,
    val updatedAt: Long,
    val deletedAt: Long? = null,
)

enum class Role { HOST, MEMBER, VIEWER;
    val canWrite: Boolean get() = this != VIEWER

    companion object {
        fun parse(s: String?): Role = when (s) {
            "host" -> HOST
            "viewer" -> VIEWER
            else -> MEMBER
        }
    }
}

data class Me(val deviceId: String?, val name: String?, val role: Role)

/** Everything the server shares with this device (from GET /api/state or the offline cache). */
data class Snapshot(
    val rev: Int,
    val boot: String,
    val clipboards: List<Clipboard>,
    val notes: List<SharedNote>,
    val me: Me?,
    val serverId: String?,
    val serverName: String?,
    val maxNoteBytes: Int,
    /** Largest file/image the server accepts (MAX_FILE_MB). */
    val maxFileBytes: Long = 25L * 1024 * 1024,
)
