package io.github.salmanulharis.clipbox.network

import io.github.salmanulharis.clipbox.core.model.Json
import io.github.salmanulharis.clipbox.core.model.Role
import io.github.salmanulharis.clipbox.core.security.SecureBox
import io.github.salmanulharis.clipbox.core.security.StaticKeySource
import io.github.salmanulharis.clipbox.core.storage.EncryptedFileStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.nio.file.Files
import java.util.Collections

/** Certificate pinning and the offline outbox. */
class Phase4NetworkTest {
    private val box = SecureBox(StaticKeySource(ByteArray(32) { 5 }))
    private val dir: File = Files.createTempDirectory("clipbox-p4").toFile()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val server = MockWebServer()

    @After fun tearDown() {
        scope.cancel()
        runCatching { server.shutdown() }
    }

    private suspend fun <T> until(timeoutMs: Long = 8_000, get: () -> T?): T = withTimeout(timeoutMs) {
        var v = get()
        while (v == null) {
            delay(20)
            v = get()
        }
        v
    }

    @Test fun `QR links carry the certificate fingerprint`() {
        val pin = "ab".repeat(32)
        val l = QrLink.parse("https://192.168.1.20:3210/#cb1.srv_x9.sha256-$pin")!!
        assertEquals("srv_x9", l.serverId)
        assertEquals(pin, l.certSha256)
        assertNull(QrLink.parse("https://192.168.1.20:3210/#cb1.srv_x9.sha256-short")!!.certSha256)
        assertEquals("srv_x9", QrLink.parse("http://192.168.1.20:3210/#cb1.srv_x9")!!.serverId)
    }

    @Test fun `self-signed HTTPS is trusted only with the matching pin`() = runBlocking {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        server.useHttps(tls.sslSocketFactory(), false)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) =
                MockResponse().setBody("""{"app":"clipbox","serverId":"srv_1","serverName":"PC"}""")
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        val url = "https://127.0.0.1:${server.port}" // cert is for "localhost": hostname wouldn't match either
        val pin = Pinning.sha256(cert.certificate)

        val untrusted = runCatching { ClipBoxApi().info(url) }.exceptionOrNull() as ApiException
        assertEquals("tls", untrusted.reason)
        assertEquals("srv_1", ClipBoxApi().pinned(pin).info(url).serverId)
        val wrong = runCatching { ClipBoxApi().pinned("00".repeat(32)).info(url) }.exceptionOrNull() as ApiException
        assertEquals("tls", wrong.reason)
    }

    @Test fun `outbox coalesces edits and folds them into offline-created notes`() {
        val ob = Outbox(EncryptedFileStore(dir, "outbox-test", box)).apply { load() }
        val local = ob.createNote("Draft", "v1", emptyList())
        ob.updateNote(local, null, "Draft", "v2", listOf("x"))
        ob.updateNote("n_real", 3, "Real", "a", emptyList())
        ob.updateNote("n_real", 3, "Real", "b", emptyList())
        assertEquals(2, ob.ops.value.size)
        assertEquals("v2", ob.ops.value[0].body)
        assertEquals(3, ob.ops.value[1].baseVersion)
        assertEquals("b", ob.ops.value[1].body)
        ob.deleteNote(local)
        assertEquals(1, ob.ops.value.size) // created then deleted offline: nothing to send
        val raw = File(dir, "outbox-test.enc").readBytes().toString(Charsets.ISO_8859_1)
        assertFalse("outbox is encrypted at rest", raw.contains("Real"))
        assertEquals(1, Outbox(EncryptedFileStore(dir, "outbox-test", box)).apply { load() }.ops.value.size)
    }

    // ── engine + fake server ─────────────────────────────────────
    private val serverNote = """{"id":"n_1","title":"Plan","body":"server","version":2,"authorName":"PC","updatedByName":"PC"}"""

    /** Starts a fake ClipBox with one note at version 2; returns the list of write requests it receives. */
    private fun fakeServer(conflict: Boolean): MutableList<String> {
        val seen = Collections.synchronizedList(mutableListOf<String>())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readUtf8()
                if (request.method != "GET") seen += "${request.method} ${request.path} $body"
                return when {
                    request.path == "/api/info" -> MockResponse().setBody("""{"app":"clipbox","serverId":"srv_1","serverName":"PC"}""")
                    request.path == "/api/state" -> MockResponse().setBody(
                        """{"rev":1,"boot":"b","clipboards":[{"id":"c1","name":"General","items":[]}],"notes":[$serverNote],
                           "me":{"deviceId":"dev_1","role":"member"},"server":{"serverId":"srv_1"}}""",
                    )
                    request.path == "/api/events" -> MockResponse().setHeader("Content-Type", "text/event-stream")
                        .setBody("event: hello\ndata: {\"rev\":1,\"boot\":\"b\"}\n\n")
                    request.method == "PATCH" && conflict -> MockResponse().setResponseCode(409)
                        .setBody("""{"error":"changed","reason":"conflict","note":$serverNote}""")
                    request.method == "PATCH" -> MockResponse().setBody(serverNote.replace("\"server\"", "\"offline edit\"").replace("\"version\":2", "\"version\":3"))
                    request.method == "POST" && request.path == "/api/notes" -> {
                        val o = JSONObject(body)
                        MockResponse().setResponseCode(201).setBody(
                            JSONObject().put("id", "n_new").put("title", o.optString("title")).put("body", o.optString("body"))
                                .put("version", 1).put("authorName", "Phone").put("updatedByName", "Phone").toString(),
                        )
                    }
                    request.method == "POST" -> MockResponse().setResponseCode(201).setBody("""{"id":"i_1","type":"text","text":"clip"}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        return seen
    }

    private fun engine(): Pair<SyncEngine, ServerProfile> {
        val profiles = ProfileStore(EncryptedFileStore(dir, "profiles", box))
        val p = ServerProfile("srv_1", "PC", listOf("http://127.0.0.1:${server.port}"), null, "dev_1", "cbd_t", Role.MEMBER, 0)
        profiles.upsert(p)
        // Offline cache from an earlier session, so the engine has data before reaching the server.
        SharedCache(dir, box).write(
            "srv_1",
            Json.snapshot(JSONObject("""{"rev":1,"boot":"b","clipboards":[{"id":"c1","name":"General","items":[]}],"notes":[$serverNote],"server":{"serverId":"srv_1"}}""")),
        )
        return SyncEngine(ClipBoxApi(), profiles, SharedCache(dir, box), scope) { EncryptedFileStore(dir, it, box) } to p
    }

    @Test fun `offline changes are shown immediately and sent on reconnect`() = runBlocking {
        val seen = fakeServer(conflict = false)
        val (e, p) = engine()
        val events = Collections.synchronizedList(mutableListOf<SyncEvent>())
        scope.launch { e.events.collect { events += it } }

        e.start(p.copy(urls = listOf("http://127.0.0.1:9"))) // unreachable address: offline
        e.stop()
        e.queueNoteUpdate("n_1", 2, "Plan", "offline edit", emptyList())
        val local = e.queueNoteCreate("New", "made offline", emptyList())!!
        e.queueClipText("c1", "clip")
        assertEquals("offline edit", e.snapshot.value!!.notes.first { it.id == "n_1" }.body)
        assertTrue(e.snapshot.value!!.notes.any { it.id == local })
        assertTrue(e.pending.value.contains(local))

        e.start(p) // back online
        until { e.outbox?.ops?.value?.takeIf { it.isEmpty() } }
        assertTrue(seen.toString(), seen.any { it.startsWith("PATCH /api/notes/n_1") && it.contains("\"baseVersion\":2") })
        assertTrue(seen.toString(), seen.any { it.startsWith("POST /api/notes ") && it.contains("made offline") })
        assertTrue(seen.toString(), seen.any { it.startsWith("POST /api/clipboards/c1/items") })
        until { events.filterIsInstance<SyncEvent.NoteSynced>().firstOrNull { it.localId == local } }
        e.clear()
    }

    @Test fun `a conflicting offline edit is kept as a separate copy`() = runBlocking {
        val seen = fakeServer(conflict = true)
        val (e, p) = engine()
        val events = Collections.synchronizedList(mutableListOf<SyncEvent>())
        scope.launch { e.events.collect { events += it } }
        e.start(p.copy(urls = listOf("http://127.0.0.1:9")))
        e.stop()
        e.queueNoteUpdate("n_1", 1, "Plan", "my offline version", emptyList())
        e.start(p)
        until { e.outbox?.ops?.value?.takeIf { it.isEmpty() } }
        assertTrue(seen.toString(), seen.any { it.startsWith("POST /api/notes ") && it.contains("Plan (offline copy)") && it.contains("my offline version") })
        until { events.filterIsInstance<SyncEvent.Notice>().firstOrNull { it.message.contains("offline copy") } }
        e.clear()
    }

    @Test fun `forgetting a server rescues unsent changes`() = runBlocking {
        fakeServer(conflict = false)
        val (e, p) = engine()
        val rescued = mutableListOf<Pair<String, String>>()
        e.onUnsynced = { t, b -> rescued += t to b }
        e.start(p.copy(urls = listOf("http://127.0.0.1:9")))
        e.stop()
        e.queueNoteCreate("Idea", "keep me", emptyList())
        e.queueClipText("c1", "unsent clip")
        e.clear()
        assertEquals(listOf("Unsynced: Idea" to "keep me", "Unsynced clipboard item" to "unsent clip"), rescued)
    }
}
