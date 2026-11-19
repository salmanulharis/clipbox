package io.github.salmanulharis.clipbox.network

import io.github.salmanulharis.clipbox.core.model.ClipItem
import io.github.salmanulharis.clipbox.core.model.Clipboard
import io.github.salmanulharis.clipbox.core.model.Json
import io.github.salmanulharis.clipbox.core.model.Role
import io.github.salmanulharis.clipbox.core.model.SharedNote
import io.github.salmanulharis.clipbox.core.model.Snapshot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Error from the server (status > 0) or the network (status == 0). */
class ApiException(val status: Int, message: String, val reason: String? = null, val body: JSONObject? = null) : Exception(message) {
    val isOffline: Boolean get() = status == 0
    val isRevoked: Boolean get() = status == 401 && reason == "device_revoked"
    val isConflict: Boolean get() = status == 409 && reason == "conflict"
}

data class ServerInfo(
    val serverId: String,
    val serverName: String,
    val version: String,
    val authRequired: Boolean,
    val passwordSet: Boolean,
)

data class PairResult(
    val deviceId: String,
    val deviceToken: String,
    val role: Role,
    val serverId: String,
    val serverName: String,
    val urls: List<String>,
)

/**
 * Thin client for the ClipBox HTTP API. Every call takes the base URL and the device token.
 *
 * [certSha256] pins a self-signed HTTPS certificate (from the server's QR code): a server
 * presenting exactly that certificate is trusted; any other certificate must pass normal
 * system validation, so public tunnel URLs keep working.
 */
class ClipBoxApi(private val baseClient: OkHttpClient = OkHttpClient(), val certSha256: String? = null) {
    private val http = baseClient.newBuilder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .apply { certSha256?.let { Pinning.apply(this, it) } }
        .build()

    /** The same client, trusting [pin] in addition to the system's certificate authorities. */
    fun pinned(pin: String?): ClipBoxApi = if (pin == certSha256) this else ClipBoxApi(baseClient, pin)
    private val probe = http.newBuilder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(3, TimeUnit.SECONDS)
        .build()
    /** For live updates: the server pings every 20 s, so silence beyond 70 s means a dead connection. */
    val streaming: OkHttpClient = http.newBuilder().readTimeout(70, TimeUnit.SECONDS).build()

    private val jsonType = "application/json; charset=utf-8".toMediaType()

    // ── discovery & pairing ──────────────────────────────────────
    suspend fun info(base: String, quick: Boolean = false): ServerInfo {
        val o = call(if (quick) probe else http, request(base, "/api/info", null))
        if (o.optString("app") != "clipbox") throw ApiException(-1, "That address isn't a ClipBox server.")
        return ServerInfo(
            serverId = o.getString("serverId"),
            serverName = o.optString("serverName", "ClipBox"),
            version = o.optString("version"),
            authRequired = o.optBoolean("authRequired"),
            passwordSet = o.optBoolean("passwordSet"),
        )
    }

    suspend fun pair(base: String, pairToken: String?, password: String?, deviceName: String): PairResult {
        val body = JSONObject().put("name", deviceName).put("platform", "android")
        if (pairToken != null) body.put("pairToken", pairToken)
        if (password != null) body.put("password", password)
        val o = call(http, request(base, "/api/devices/pair", null, "POST", body))
        val urls = o.optJSONArray("urls") ?: JSONArray()
        return PairResult(
            deviceId = o.getString("deviceId"),
            deviceToken = o.getString("deviceToken"),
            role = Role.parse(o.optString("role")),
            serverId = o.getString("serverId"),
            serverName = o.optString("serverName", "ClipBox"),
            urls = List(urls.length()) { urls.getJSONObject(it).optString("url") }.filter { it.isNotBlank() },
        )
    }

    suspend fun disconnect(base: String, token: String) {
        call(http, request(base, "/api/devices/me", token, "DELETE"))
    }

    // ── state ────────────────────────────────────────────────────
    suspend fun stateJson(base: String, token: String): JSONObject = call(http, request(base, "/api/state", token))

    suspend fun state(base: String, token: String): Snapshot = Json.snapshot(stateJson(base, token))

    /** Long-poll fallback: returns when the server's revision differs from [rev] (or after ~25 s). */
    suspend fun sync(base: String, token: String, rev: Int, boot: String): JSONObject =
        call(streaming, request(base, "/api/sync?rev=$rev&boot=$boot", token))

    // ── shared notes ─────────────────────────────────────────────
    suspend fun createNote(base: String, token: String, title: String, body: String, tags: List<String>): SharedNote =
        Json.sharedNote(
            call(http, request(base, "/api/notes", token, "POST", JSONObject().put("title", title).put("body", body).put("tags", JSONArray(tags)))),
        )

    suspend fun updateNote(
        base: String, token: String, id: String,
        title: String? = null, body: String? = null, tags: List<String>? = null, baseVersion: Int? = null,
        pinned: Boolean? = null, locked: Boolean? = null,
    ): SharedNote {
        val o = JSONObject()
        title?.let { o.put("title", it) }
        body?.let { o.put("body", it) }
        tags?.let { o.put("tags", JSONArray(it)) }
        baseVersion?.let { o.put("baseVersion", it) }
        pinned?.let { o.put("pinned", it) }
        locked?.let { o.put("locked", it) }
        return Json.sharedNote(call(http, request(base, "/api/notes/$id", token, "PATCH", o)))
    }

    suspend fun deleteNote(base: String, token: String, id: String) {
        call(http, request(base, "/api/notes/$id", token, "DELETE"))
    }

    // ── clipboards ───────────────────────────────────────────────
    suspend fun addText(base: String, token: String, clipboardId: String, text: String): ClipItem =
        Json.clipItem(call(http, request(base, "/api/clipboards/$clipboardId/items", token, "POST", JSONObject().put("text", text))))

    suspend fun deleteItem(base: String, token: String, clipboardId: String, itemId: String) {
        call(http, request(base, "/api/clipboards/$clipboardId/items/$itemId", token, "DELETE"))
    }

    suspend fun createClipboard(base: String, token: String, name: String): Clipboard =
        Json.clipboard(call(http, request(base, "/api/clipboards", token, "POST", JSONObject().put("name", name))))

    suspend fun renameClipboard(base: String, token: String, id: String, name: String): Clipboard =
        Json.clipboard(call(http, request(base, "/api/clipboards/$id", token, "PATCH", JSONObject().put("name", name))))

    suspend fun clearClipboard(base: String, token: String, id: String): Clipboard =
        Json.clipboard(call(http, request(base, "/api/clipboards/$id/clear", token, "POST")))

    suspend fun deleteClipboard(base: String, token: String, id: String) {
        call(http, request(base, "/api/clipboards/$id", token, "DELETE"))
    }

    suspend fun fileBytes(base: String, token: String, itemId: String): ByteArray = withContext(Dispatchers.IO) {
        execute(http, request(base, "/files/$itemId", token)).use { res ->
            if (!res.isSuccessful) throw ApiException(res.code, "Could not download the file.")
            res.body!!.bytes()
        }
    }

    // ── plumbing ─────────────────────────────────────────────────
    fun request(base: String, path: String, token: String?, method: String = "GET", body: JSONObject? = null): Request =
        Request.Builder()
            .url(base.trimEnd('/') + path)
            .header("X-ClipBox", "1")
            .header("Accept", "application/json")
            .apply { if (token != null) header("Authorization", "Bearer $token") }
            .method(method, if (body != null) body.toString().toRequestBody(jsonType) else if (method == "GET" || method == "DELETE") null else "{}".toRequestBody(jsonType))
            .build()

    private suspend fun call(client: OkHttpClient, req: Request): JSONObject = withContext(Dispatchers.IO) {
        execute(client, req).use { res ->
            ensureActive()
            val text = res.body?.string().orEmpty()
            val json = try {
                if (text.isBlank()) JSONObject() else JSONObject(text)
            } catch (_: Exception) {
                null
            }
            if (!res.isSuccessful || json == null) {
                throw ApiException(
                    res.code.takeIf { !res.isSuccessful } ?: -1,
                    json?.optString("error")?.takeIf { it.isNotBlank() } ?: "Unexpected response from the server (${res.code}).",
                    json?.optString("reason")?.takeIf { it.isNotBlank() },
                    json,
                )
            }
            json
        }
    }

    /** Cancellable OkHttp call. Network failures become ApiException(status = 0). */
    suspend fun execute(client: OkHttpClient, req: Request): Response = suspendCancellableCoroutine { cont ->
        val call = client.newCall(req)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onResponse(call: Call, response: Response) = cont.resume(response) { _, _, _ -> response.close() }
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isCancelled) return
                runCatching { android.util.Log.w("ClipBoxApi", "${req.method} ${req.url.encodedPath} failed: $e") }
                val error = if (e is javax.net.ssl.SSLException) {
                    // TLS problems are not "offline": the server answered but isn't trusted.
                    ApiException(-2, "This server's HTTPS certificate isn't trusted. Scan its QR code from ClipBox → Connect to trust it.", "tls")
                } else {
                    ApiException(0, "Can't reach the server.", "offline")
                }
                cont.resumeWithException(error.apply { initCause(e) })
            }
        })
    }
}
