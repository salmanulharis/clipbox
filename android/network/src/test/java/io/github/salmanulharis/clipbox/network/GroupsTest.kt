package io.github.salmanulharis.clipbox.network

import io.github.salmanulharis.clipbox.core.model.Group
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
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger

/** Groups (API v3): parsing, offline creates in a group, and filtered live events. */
class GroupsTest {
    private val box = SecureBox(StaticKeySource(ByteArray(32) { 7 }))
    private val dir: File = Files.createTempDirectory("clipbox-groups").toFile()
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

    private val everyone = """{"id":"grp_everyone","name":"Everyone","access":"all","isDefault":true}"""
    private val family = """{"id":"grp_fam","name":"Family","access":"members","memberCount":2}"""
    private fun state(rev: Int, groups: String, clipboards: String, notes: String = "") =
        """{"rev":$rev,"boot":"b","groups":[$groups],"clipboards":[$clipboards],"notes":[$notes],
           "me":{"deviceId":"dev_1","role":"member"},"server":{"serverId":"srv_1","serverName":"PC"}}"""

    @Test fun `groups and group ids are parsed and survive the offline cache`() {
        val s = Json.snapshot(
            JSONObject(
                state(
                    4, "$everyone,$family",
                    """{"id":"c1","name":"General","groupId":"grp_everyone","items":[]},{"id":"c2","name":"Home","groupId":"grp_fam","items":[]}""",
                    """{"id":"n_1","title":"Wi-Fi","body":"pw","groupId":"grp_fam","version":1}""",
                ),
            ),
        )
        assertEquals(listOf("grp_everyone", "grp_fam"), s.groups.map { it.id })
        assertTrue(s.groups[0].isDefault)
        assertTrue(s.groups[1].membersOnly)
        assertEquals(2, s.groups[1].memberCount)
        assertEquals("grp_fam", s.clipboards[1].groupId)
        assertEquals("grp_fam", s.notes[0].groupId)
        // The offline cache stores the same shape.
        val again = Json.snapshot(Json.toJson(s))
        assertEquals(s.groups, again.groups)
        assertEquals(s.clipboards.map { it.groupId }, again.clipboards.map { it.groupId })
        assertEquals("grp_fam", again.notes[0].groupId)
    }

    @Test fun `servers without groups put everything in the default group`() {
        val s = Json.snapshot(
            JSONObject(
                """{"rev":1,"boot":"b","clipboards":[{"id":"c1","name":"General","items":[]}],
                   "notes":[{"id":"n_1","title":"T","version":1}],"server":{"serverId":"srv_1"}}""",
            ),
        )
        assertEquals(listOf(Group.DEFAULT), s.groups)
        assertEquals(Group.DEFAULT_ID, s.clipboards[0].groupId)
        assertEquals(Group.DEFAULT_ID, s.notes[0].groupId)
    }

    @Test fun `the outbox keeps the group of notes created offline`() {
        val ob = Outbox(EncryptedFileStore(dir, "outbox-groups", box)).apply { load() }
        ob.createNote("Shopping", "milk", emptyList(), "grp_fam")
        ob.updateNote(ob.ops.value[0].noteId!!, null, "Shopping", "milk, eggs", emptyList())
        val reloaded = Outbox(EncryptedFileStore(dir, "outbox-groups", box)).apply { load() }
        assertEquals("grp_fam", reloaded.ops.value.single().groupId)
        assertEquals("milk, eggs", reloaded.ops.value.single().body)
    }

    private fun engine(): Pair<SyncEngine, ServerProfile> {
        val profiles = ProfileStore(EncryptedFileStore(dir, "profiles", box))
        val p = ServerProfile("srv_1", "PC", listOf("http://127.0.0.1:${server.port}"), null, "dev_1", "cbd_t", Role.MEMBER, 0)
        profiles.upsert(p)
        return SyncEngine(ClipBoxApi(), profiles, SharedCache(dir, box), scope) { EncryptedFileStore(dir, it, box) } to p
    }

    @Test fun `skip events only move the revision and group changes reload the state`() = runBlocking {
        val stateCalls = AtomicInteger()
        val first = state(1, everyone, """{"id":"c1","name":"General","groupId":"grp_everyone","items":[]}""")
        val later = state(
            3, "$everyone,$family",
            """{"id":"c1","name":"General","groupId":"grp_everyone","items":[]},{"id":"c2","name":"Home","groupId":"grp_fam","items":[]}""",
        )
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/api/info" -> MockResponse().setBody("""{"app":"clipbox","serverId":"srv_1","serverName":"PC"}""")
                "/api/state" -> MockResponse().setBody(if (stateCalls.incrementAndGet() == 1) first else later)
                // A change in a group this device can't see, then this device is added to "Family".
                "/api/events" -> MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
                    "event: hello\ndata: {\"rev\":1,\"boot\":\"b\"}\n\n" +
                        "event: change\ndata: {\"type\":\"skip\",\"rev\":2,\"boot\":\"b\"}\n\n" +
                        "event: change\ndata: {\"type\":\"groups\",\"rev\":3,\"boot\":\"b\"}\n\n",
                )
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        val (e, p) = engine()
        e.start(p)
        // Reconnecting after the stream ends takes ≥2 s, so seeing this sooner proves the "groups" event reloaded.
        val s = until(1_800) { e.snapshot.value?.takeIf { it.groups.size == 2 } }
        assertEquals(3, s.rev)
        assertEquals("grp_fam", s.clipboards.first { it.id == "c2" }.groupId)
        assertEquals("the skip event must not trigger a reload", 2, stateCalls.get())
        e.clear()
    }

    @Test fun `a shared note created offline is sent to its group`() = runBlocking {
        val writes = Collections.synchronizedList(mutableListOf<String>())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readUtf8()
                if (request.method != "GET") writes += "${request.method} ${request.path} $body"
                return when {
                    request.path == "/api/info" -> MockResponse().setBody("""{"app":"clipbox","serverId":"srv_1","serverName":"PC"}""")
                    request.path == "/api/state" -> MockResponse().setBody(state(1, "$everyone,$family", ""))
                    request.path == "/api/events" -> MockResponse().setHeader("Content-Type", "text/event-stream")
                        .setBody("event: hello\ndata: {\"rev\":1,\"boot\":\"b\"}\n\n")
                    request.method == "POST" && request.path == "/api/notes" -> {
                        val o = JSONObject(body)
                        MockResponse().setResponseCode(201).setBody(
                            JSONObject().put("id", "n_new").put("title", o.optString("title")).put("groupId", o.optString("groupId"))
                                .put("version", 1).toString(),
                        )
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        val (e, p) = engine()
        val events = Collections.synchronizedList(mutableListOf<SyncEvent>())
        scope.launch { e.events.collect { events += it } }
        SharedCache(dir, box).write("srv_1", Json.snapshot(JSONObject(state(1, "$everyone,$family", "")))) // seen earlier
        e.start(p.copy(urls = listOf("http://127.0.0.1:9"))) // unreachable: offline
        e.stop()
        val local = e.queueNoteCreate("Shopping", "milk", emptyList(), "grp_fam")!!
        assertEquals("grp_fam", e.snapshot.value!!.notes.first { it.id == local }.groupId)
        e.start(p)
        until { e.outbox?.ops?.value?.takeIf { it.isEmpty() } }
        val post = writes.first { it.startsWith("POST /api/notes ") }
        assertTrue(post, post.contains("\"groupId\":\"grp_fam\""))
        val synced = until { events.filterIsInstance<SyncEvent.NoteSynced>().firstOrNull { it.localId == local } }
        assertEquals("grp_fam", synced.note.groupId)
        assertFalse(e.pending.value.contains(local))
        e.clear()
    }

    @Test fun `host group management calls send the right requests`() = runBlocking {
        val seen = Collections.synchronizedList(mutableListOf<String>())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += "${request.method} ${request.path} ${request.body.readUtf8()}"
                return when {
                    request.path == "/api/devices" -> MockResponse().setBody(
                        """{"devices":[{"id":"dev_a","name":"Pixel","platform":"android","role":"member","revoked":false,"app":true,"lastSeenAt":5,"current":false},
                                       {"id":"dev_b","name":"Chrome","role":"viewer","revoked":true}]}""",
                    )
                    request.path!!.startsWith("/api/connect") -> MockResponse().setBody(
                        """{"urls":[{"kind":"public","label":"Public","url":"https://x.example","link":"https://x.example/join?t=T#cb1.srv_1","blocked":false},
                                    {"kind":"local","label":"Wi-Fi","url":"http://192.168.0.5:3210","link":"http://192.168.0.5:3210/join?t=T#cb1.srv_1"}],
                           "tokenMinutes":10,"group":{"id":"grp_fam","name":"Family","access":"members"}}""",
                    )
                    request.method == "DELETE" -> MockResponse().setBody("""{"ok":true}""")
                    else -> MockResponse().setResponseCode(if (request.method == "POST") 201 else 200).setBody(family.replace("\"memberCount\":2", "\"members\":[\"dev_a\"]"))
                }
            }
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        val api = ClipBoxApi()
        val base = "http://127.0.0.1:${server.port}"

        val devices = api.devices(base, "t")
        assertEquals(listOf("dev_a", "dev_b"), devices.map { it.id })
        assertTrue(devices[0].app)
        assertTrue(devices[1].revoked)
        assertEquals(Role.VIEWER, devices[1].role)

        val created = api.createGroup(base, "t", "Family")
        assertEquals(listOf("dev_a"), created.members)
        assertEquals(1, created.memberCount)
        api.updateGroup(base, "t", "grp_fam", members = listOf("dev_a", "dev_c"))
        api.updateGroup(base, "t", "grp_fam", access = "all")
        api.deleteGroup(base, "t", "grp_fam")
        val invite = api.invite(base, "t", "grp_fam")
        assertEquals(2, invite.links.size)
        assertTrue(invite.links[0].public)
        assertEquals("Family", invite.groupName)
        assertEquals(10, invite.minutes)

        assertTrue(seen.toString(), seen.any { it.startsWith("POST /api/groups ") && it.contains("\"name\":\"Family\"") && it.contains("\"access\":\"members\"") })
        assertTrue(seen.toString(), seen.any { it.startsWith("PATCH /api/groups/grp_fam ") && it.contains("\"members\":[\"dev_a\",\"dev_c\"]") && !it.contains("access") })
        assertTrue(seen.toString(), seen.any { it.startsWith("PATCH /api/groups/grp_fam ") && it.contains("\"access\":\"all\"") && !it.contains("members") })
        assertTrue(seen.toString(), seen.any { it.startsWith("DELETE /api/groups/grp_fam") })
        assertTrue(seen.toString(), seen.any { it.startsWith("GET /api/connect?group=grp_fam") })
    }

    @Test fun `deleting a group locally removes its clipboards and notes`() = runBlocking {
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        val (e, p) = engine()
        SharedCache(dir, box).write(
            "srv_1",
            Json.snapshot(
                JSONObject(
                    state(
                        1, "$everyone,$family",
                        """{"id":"c1","name":"General","groupId":"grp_everyone","items":[]},{"id":"c2","name":"Home","groupId":"grp_fam","items":[]}""",
                        """{"id":"n_1","title":"Shared","groupId":"grp_everyone","version":1},{"id":"n_2","title":"Family","groupId":"grp_fam","version":1}""",
                    ),
                ),
            ),
        )
        e.start(p.copy(urls = listOf("http://127.0.0.1:9")))
        e.stop()
        e.applyGroup(Group("grp_fam", "Family & friends", "all", isDefault = false))
        assertEquals("Family & friends", e.snapshot.value!!.groups.first { it.id == "grp_fam" }.name)
        e.removeGroup("grp_fam")
        val s = e.snapshot.value!!
        assertEquals(listOf("grp_everyone"), s.groups.map { it.id })
        assertEquals(listOf("c1"), s.clipboards.map { it.id })
        assertEquals(listOf("n_1"), s.notes.map { it.id })
        e.clear()
    }
}
