package io.github.salmanulharis.clipbox.network

import io.github.salmanulharis.clipbox.core.model.Json
import io.github.salmanulharis.clipbox.core.model.Role
import io.github.salmanulharis.clipbox.core.model.Snapshot
import io.github.salmanulharis.clipbox.core.security.SecureBox
import io.github.salmanulharis.clipbox.core.storage.EncryptedFileStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** A server this device has paired with. The device token is only ever stored encrypted. */
data class ServerProfile(
    val serverId: String,
    val serverName: String,
    /** Every address the server is known by: LAN first, then public. */
    val urls: List<String>,
    /** The address that worked most recently; tried first. */
    val lastGoodUrl: String?,
    val deviceId: String,
    val deviceToken: String,
    val role: Role,
    val pairedAt: Long,
) {
    /** Addresses to try, in order. Plain-http public addresses are never used. */
    fun candidates(): List<String> = (listOfNotNull(lastGoodUrl) + urls).distinct().filter { UrlPolicy.check(it) == null }
}

/** Saved servers + which one is active, in one Keystore-encrypted file. */
class ProfileStore(private val file: EncryptedFileStore) {
    private val _profiles = MutableStateFlow<List<ServerProfile>>(emptyList())
    private val _activeId = MutableStateFlow<String?>(null)
    val profiles: StateFlow<List<ServerProfile>> = _profiles.asStateFlow()
    val activeId: StateFlow<String?> = _activeId.asStateFlow()

    val active: ServerProfile? get() = _profiles.value.firstOrNull { it.serverId == _activeId.value }

    @Synchronized
    fun load() {
        val o = file.read()?.let(::JSONObject) ?: return
        val arr = o.optJSONArray("profiles") ?: JSONArray()
        _profiles.value = List(arr.length()) { fromJson(arr.getJSONObject(it)) }
        _activeId.value = o.optString("active").takeIf { id -> id.isNotBlank() && _profiles.value.any { it.serverId == id } }
    }

    @Synchronized
    fun upsert(p: ServerProfile, makeActive: Boolean = true) {
        _profiles.value = _profiles.value.filterNot { it.serverId == p.serverId } + p
        if (makeActive) _activeId.value = p.serverId
        save()
    }

    @Synchronized
    fun setActive(serverId: String?) {
        _activeId.value = serverId?.takeIf { id -> _profiles.value.any { it.serverId == id } }
        save()
    }

    @Synchronized
    fun remove(serverId: String) {
        _profiles.value = _profiles.value.filterNot { it.serverId == serverId }
        if (_activeId.value == serverId) _activeId.value = null
        save()
    }

    @Synchronized
    fun update(serverId: String, change: (ServerProfile) -> ServerProfile) {
        val cur = _profiles.value.firstOrNull { it.serverId == serverId } ?: return
        val next = change(cur)
        if (next == cur) return
        _profiles.value = _profiles.value.map { if (it.serverId == serverId) next else it }
        save()
    }

    private fun save() {
        file.write(
            JSONObject()
                .put("active", _activeId.value ?: "")
                .put("profiles", JSONArray(_profiles.value.map(::toJson)))
                .toString(),
        )
    }

    private fun toJson(p: ServerProfile) = JSONObject()
        .put("serverId", p.serverId).put("serverName", p.serverName).put("urls", JSONArray(p.urls))
        .put("lastGoodUrl", p.lastGoodUrl ?: "").put("deviceId", p.deviceId).put("deviceToken", p.deviceToken)
        .put("role", p.role.name.lowercase()).put("pairedAt", p.pairedAt)

    private fun fromJson(o: JSONObject): ServerProfile {
        val urls = o.optJSONArray("urls") ?: JSONArray()
        return ServerProfile(
            serverId = o.getString("serverId"),
            serverName = o.optString("serverName", "ClipBox"),
            urls = List(urls.length()) { urls.getString(it) },
            lastGoodUrl = o.optString("lastGoodUrl").takeIf { it.isNotBlank() },
            deviceId = o.getString("deviceId"),
            deviceToken = o.getString("deviceToken"),
            role = Role.parse(o.optString("role")),
            pairedAt = o.optLong("pairedAt"),
        )
    }
}

/** Last known shared data per server, for read-only use while offline. Encrypted; deleted on disconnect. */
class SharedCache(private val dir: File, private val box: SecureBox) {
    private fun store(serverId: String) = EncryptedFileStore(dir, "cache-" + serverId.replace(Regex("[^\\w-]"), "_"), box)

    fun read(serverId: String): Snapshot? = try {
        store(serverId).read()?.let { Json.snapshot(JSONObject(it)) }
    } catch (_: Exception) {
        null
    }

    fun write(serverId: String, s: Snapshot) = store(serverId).write(Json.toJson(s).toString())

    fun delete(serverId: String) = store(serverId).delete()
}
