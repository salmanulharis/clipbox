package io.github.salmanulharis.clipbox.network

import io.github.salmanulharis.clipbox.core.model.Role
import io.github.salmanulharis.clipbox.core.security.SecureBox
import io.github.salmanulharis.clipbox.core.security.StaticKeySource
import io.github.salmanulharis.clipbox.core.storage.EncryptedFileStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class LinksTest {
    @Test fun `parses web QR links`() {
        val lan = QrLink.parse("http://192.168.1.20:3210/#cb1.srv_abc123")!!
        assertEquals("http://192.168.1.20:3210", lan.baseUrl)
        assertNull(lan.pairToken)
        assertEquals("srv_abc123", lan.serverId)

        val pub = QrLink.parse("https://abc.ngrok.app/join?t=1795%2E0.nonce.sig#cb1.srv_x9")!!
        assertEquals("https://abc.ngrok.app", pub.baseUrl)
        assertEquals("1795.0.nonce.sig", pub.pairToken)
        assertEquals("srv_x9", pub.serverId)

        assertEquals("http://10.0.2.2:3210", QrLink.parse(" 10.0.2.2:3210 ")!!.baseUrl)
        assertNull(QrLink.parse("ftp://x"))
        assertNull(QrLink.parse("just some text"))?.let { } // tolerated: parsed as host; checked later by /api/info
    }

    @Test fun `plain http is only allowed on the local network`() {
        for (ok in listOf("http://192.168.0.5:3210", "http://10.0.2.2:3210", "http://172.20.1.1", "http://localhost:3210", "http://pc.local:3210", "https://example.com")) {
            assertNull(ok, UrlPolicy.check(ok))
        }
        for (bad in listOf("http://example.com", "http://8.8.8.8:3210", "http://172.32.0.1", "ftp://192.168.0.1")) {
            assertTrue(bad, UrlPolicy.check(bad) != null)
        }
    }
}

class SyncEngineTest {
    private val server = MockWebServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val box = SecureBox(StaticKeySource(ByteArray(32) { 3 }))
    private val dir = Files.createTempDirectory("clipbox-net").toFile()

    @After fun tearDown() {
        scope.cancel()
        server.shutdown()
    }

    private val state = """{"rev":1,"boot":"b","clipboards":[{"id":"c1","name":"General","createdAt":1,"updatedAt":1,"items":[]}],
        "notes":[],"me":{"deviceId":"dev_1","name":"Phone","role":"member"},"server":{"serverId":"srv_1","serverName":"PC"}}"""

    private fun engine(urls: List<String>): Pair<SyncEngine, ServerProfile> {
        val profiles = ProfileStore(EncryptedFileStore(dir, "profiles", box))
        val p = ServerProfile("srv_1", "PC", urls, null, "dev_1", "cbd_token", Role.MEMBER, 0)
        profiles.upsert(p)
        return SyncEngine(ClipBoxApi(), profiles, SharedCache(dir, box), scope) { EncryptedFileStore(dir, it, box) } to p
    }

    private suspend fun <T> until(timeoutMs: Long = 5_000, get: () -> T?): T = withTimeout(timeoutMs) {
        while (true) {
            get()?.let { return@withTimeout it }
            delay(20)
        }
        @Suppress("UNREACHABLE_CODE") error("unreachable")
    }

    @Test fun `fails over to a working address, then applies live events`() = runBlocking {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                assertEquals("Bearer cbd_token", request.getHeader("Authorization").takeIf { request.path != "/api/info" } ?: "Bearer cbd_token")
                return when (request.path) {
                    "/api/info" -> MockResponse().setBody("""{"app":"clipbox","serverId":"srv_1","serverName":"PC"}""")
                    "/api/state" -> MockResponse().setBody(state)
                    "/api/events" -> MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
                        "event: hello\ndata: {\"rev\":1,\"boot\":\"b\"}\n\n" +
                            "event: change\ndata: {\"type\":\"note\",\"rev\":2,\"boot\":\"b\",\"note\":{\"id\":\"n_1\",\"title\":\"Live\",\"body\":\"x\",\"version\":1}}\n\n",
                    )
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        val dead = "http://127.0.0.1:9" // nothing listens on the discard port
        val (e, p) = engine(listOf(dead, "http://127.0.0.1:${server.port}"))
        e.start(p)
        val s = until { e.snapshot.value?.takeIf { it.notes.isNotEmpty() } }
        assertEquals("Live", s.notes.single().title)
        assertEquals(2, s.rev)
        // The cache (written in the background) soon holds the data for offline use.
        val cached = until { SharedCache(dir, box).read("srv_1")?.notes?.singleOrNull() }
        assertEquals("Live", cached.title)
        e.clear()
    }

    @Test fun `refuses a different server at a saved address`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"app":"clipbox","serverId":"srv_OTHER","serverName":"Someone else"}"""))
        server.start()
        val (e, p) = engine(listOf("http://127.0.0.1:${server.port}"))
        e.start(p)
        val c = until { e.connection.value as? Connection.WrongServer }
        assertTrue(c.message.contains("Someone else"))
        assertNull(e.snapshot.value)
        e.clear()
    }

    @Test fun `a revoked device stops syncing`() = runBlocking {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/api/info" -> MockResponse().setBody("""{"app":"clipbox","serverId":"srv_1","serverName":"PC"}""")
                else -> MockResponse().setResponseCode(401).setBody("""{"error":"removed","reason":"device_revoked"}""")
            }
        }
        server.start()
        val (e, p) = engine(listOf("http://127.0.0.1:${server.port}"))
        e.start(p)
        until { e.connection.value as? Connection.Revoked }
        e.clear()
    }

    @Test fun `profiles keep the token encrypted on disk`() {
        val (_, _) = engine(listOf("http://192.168.0.5:3210"))
        val raw = java.io.File(dir, "profiles.enc").readBytes().toString(Charsets.ISO_8859_1)
        assertFalse(raw.contains("cbd_token"))
        val reloaded = ProfileStore(EncryptedFileStore(dir, "profiles", box)).apply { load() }
        assertEquals("cbd_token", reloaded.active?.deviceToken)
    }
}
