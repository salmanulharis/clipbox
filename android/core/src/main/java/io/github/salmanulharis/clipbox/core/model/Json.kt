package io.github.salmanulharis.clipbox.core.model

import org.json.JSONArray
import org.json.JSONObject

/** JSON mapping shared by the network layer, the offline cache and private-note storage. */
object Json {
    private fun JSONObject.str(key: String): String? = if (has(key) && !isNull(key)) getString(key) else null
    private fun JSONObject.long(key: String): Long = optLong(key, 0L)

    fun tags(arr: JSONArray?): List<String> =
        if (arr == null) emptyList() else List(arr.length()) { arr.optString(it) }.filter { it.isNotBlank() }

    fun clipItem(o: JSONObject) = ClipItem(
        id = o.getString("id"),
        type = o.optString("type", "text"),
        text = o.str("text"),
        name = o.str("name"),
        mime = o.str("mime"),
        size = o.long("size"),
        createdAt = o.long("createdAt"),
        updatedAt = o.long("updatedAt"),
    )

    fun clipboard(o: JSONObject): Clipboard {
        val items = o.optJSONArray("items") ?: JSONArray()
        return Clipboard(
            id = o.getString("id"),
            name = o.optString("name"),
            createdAt = o.long("createdAt"),
            updatedAt = o.long("updatedAt"),
            items = List(items.length()) { clipItem(items.getJSONObject(it)) },
            groupId = o.str("groupId") ?: Group.DEFAULT_ID,
        )
    }

    fun group(o: JSONObject): Group {
        val id = o.getString("id")
        val members = o.optJSONArray("members")?.let { a -> List(a.length()) { a.getString(it) } }
        return Group(
            id = id,
            name = o.optString("name").ifBlank { "Group" },
            access = if (o.optString("access") == "members") "members" else "all",
            isDefault = o.optBoolean("isDefault", id == Group.DEFAULT_ID),
            memberCount = members?.size ?: o.optInt("memberCount", 0),
            members = members,
        )
    }

    /** The groups in a state payload; servers without groups get the implicit default one. */
    fun groups(arr: JSONArray?): List<Group> {
        val list = if (arr == null) emptyList() else List(arr.length()) { group(arr.getJSONObject(it)) }
        return list.ifEmpty { listOf(Group.DEFAULT) }
    }

    fun sharedNote(o: JSONObject) = SharedNote(
        id = o.getString("id"),
        title = o.optString("title"),
        body = o.optString("body"),
        tags = tags(o.optJSONArray("tags")),
        pinned = o.optBoolean("pinned"),
        locked = o.optBoolean("locked"),
        authorId = o.str("authorId"),
        authorName = o.optString("authorName", "Unknown device"),
        version = o.optInt("version", 1),
        createdAt = o.long("createdAt"),
        updatedAt = o.long("updatedAt"),
        updatedBy = o.str("updatedBy"),
        updatedByName = o.optString("updatedByName", o.optString("authorName", "Unknown device")),
        groupId = o.str("groupId") ?: Group.DEFAULT_ID,
    )

    fun me(o: JSONObject?): Me? = o?.let { Me(it.str("deviceId"), it.str("name"), Role.parse(it.str("role"))) }

    fun snapshot(o: JSONObject): Snapshot {
        val cbs = o.optJSONArray("clipboards") ?: JSONArray()
        val notes = o.optJSONArray("notes") ?: JSONArray()
        val server = o.optJSONObject("server")
        return Snapshot(
            rev = o.optInt("rev"),
            boot = o.optString("boot"),
            groups = groups(o.optJSONArray("groups")),
            clipboards = List(cbs.length()) { clipboard(cbs.getJSONObject(it)) },
            notes = List(notes.length()) { sharedNote(notes.getJSONObject(it)) },
            me = me(o.optJSONObject("me")),
            serverId = server?.str("serverId"),
            serverName = server?.str("serverName"),
            maxNoteBytes = server?.optInt("maxNoteBytes", 256 * 1024) ?: 256 * 1024,
            maxFileBytes = server?.optLong("maxFileBytes", 25L * 1024 * 1024) ?: 25L * 1024 * 1024,
        )
    }

    // ── serialisation (offline cache uses the same shape as GET /api/state)
    private fun opt(v: Any?): Any = v ?: JSONObject.NULL

    fun toJson(i: ClipItem): JSONObject = JSONObject()
        .put("id", i.id).put("type", i.type).put("text", opt(i.text)).put("name", opt(i.name))
        .put("mime", opt(i.mime)).put("size", i.size).put("createdAt", i.createdAt).put("updatedAt", i.updatedAt)

    fun toJson(c: Clipboard): JSONObject = JSONObject()
        .put("id", c.id).put("name", c.name).put("createdAt", c.createdAt).put("updatedAt", c.updatedAt)
        .put("items", JSONArray(c.items.map(::toJson))).put("groupId", c.groupId)

    fun toJson(n: SharedNote): JSONObject = JSONObject()
        .put("id", n.id).put("title", n.title).put("body", n.body).put("tags", JSONArray(n.tags))
        .put("pinned", n.pinned).put("locked", n.locked).put("authorId", opt(n.authorId)).put("authorName", n.authorName)
        .put("version", n.version).put("createdAt", n.createdAt).put("updatedAt", n.updatedAt)
        .put("updatedBy", opt(n.updatedBy)).put("updatedByName", n.updatedByName).put("groupId", n.groupId)

    fun toJson(g: Group): JSONObject = JSONObject()
        .put("id", g.id).put("name", g.name).put("access", g.access).put("isDefault", g.isDefault).put("memberCount", g.memberCount)
        .apply { g.members?.let { put("members", JSONArray(it)) } }

    fun toJson(s: Snapshot): JSONObject = JSONObject()
        .put("rev", s.rev).put("boot", s.boot)
        .put("groups", JSONArray(s.groups.map(::toJson)))
        .put("clipboards", JSONArray(s.clipboards.map(::toJson)))
        .put("notes", JSONArray(s.notes.map(::toJson)))
        .put("me", s.me?.let { JSONObject().put("deviceId", opt(it.deviceId)).put("name", opt(it.name)).put("role", it.role.name.lowercase()) } ?: JSONObject.NULL)
        .put("server", JSONObject().put("serverId", opt(s.serverId)).put("serverName", opt(s.serverName)).put("maxNoteBytes", s.maxNoteBytes).put("maxFileBytes", s.maxFileBytes))

    // ── private notes (same field names as the web app's export, so backups are interchangeable)
    fun privateNote(o: JSONObject) = PrivateNote(
        id = o.getString("id"),
        title = o.optString("title"),
        body = o.optString("body"),
        tags = tags(o.optJSONArray("tags")),
        pinned = o.optBoolean("pinned"),
        createdAt = o.long("createdAt"),
        updatedAt = o.long("updatedAt"),
        deletedAt = if (o.has("deletedAt") && !o.isNull("deletedAt")) o.getLong("deletedAt") else null,
    )

    fun toJson(n: PrivateNote): JSONObject = JSONObject()
        .put("id", n.id)
        .put("title", n.title)
        .put("body", n.body)
        .put("tags", JSONArray(n.tags))
        .put("pinned", n.pinned)
        .put("createdAt", n.createdAt)
        .put("updatedAt", n.updatedAt)
        .put("deletedAt", n.deletedAt ?: JSONObject.NULL)
}

/** Small helpers shared by private and shared notes. */
object NoteText {
    fun parseTags(input: String): List<String> {
        val seen = HashSet<String>()
        return input.split(',', '\n')
            .map { it.trim().trimStart('#').replace(Regex("\\s+"), "-").take(30) }
            .filter { it.isNotEmpty() && seen.add(it.lowercase()) }
            .take(20)
    }

    fun cleanTitle(title: String): String = title.replace(Regex("\\s+"), " ").trim().take(200)

    fun displayTitle(title: String, body: String): String =
        title.ifBlank { body.lineSequence().firstOrNull { it.isNotBlank() }?.trim()?.take(120) ?: "" }.ifBlank { "Untitled" }

    fun preview(title: String, body: String): String {
        val rest = if (title.isNotBlank()) body else body.lineSequence().drop(1).joinToString("\n")
        return rest.trim().take(280)
    }

    fun copyText(title: String, body: String): String = (if (title.isNotBlank()) "$title\n\n$body" else body).trim()

    fun matches(query: String, title: String, body: String, tags: List<String>): Boolean {
        if (query.isBlank()) return true
        val hay = "$title\n$body\n${tags.joinToString(" ")}".lowercase()
        return query.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }.all { hay.contains(it) }
    }
}
