package io.github.salmanulharis.clipbox.privatenotes

import io.github.salmanulharis.clipbox.core.security.SecureBox
import io.github.salmanulharis.clipbox.core.security.StaticKeySource
import io.github.salmanulharis.clipbox.core.storage.EncryptedFileStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files

class PrivateNotesRepositoryTest {
    private val dir: File = Files.createTempDirectory("clipbox-private").toFile()
    private var now = 1_000_000L
    private fun repo(key: Byte = 1) =
        PrivateNotesRepository(EncryptedFileStore(dir, "private-notes", SecureBox(StaticKeySource(ByteArray(32) { key }))), { now })

    @Test fun `notes persist encrypted and survive a restart`() {
        val r = repo().apply { load() }
        val n = r.create("Wi-Fi", "pass: hunter2", listOf("home"))
        assertTrue(n.id.startsWith("p_"))
        val raw = File(dir, "private-notes.enc").readBytes().toString(Charsets.ISO_8859_1)
        assertFalse("must be encrypted at rest", raw.contains("hunter2"))
        val again = repo().apply { load() }
        assertEquals("pass: hunter2", again.get(n.id)?.body)
    }

    @Test fun `trash, restore and 30-day purge`() {
        val r = repo().apply { load() }
        val n = r.create("Old", "x")
        r.trash(n.id)
        assertEquals(1, r.trash.size)
        r.restore(n.id)
        assertEquals(0, r.trash.size)
        r.trash(n.id)
        now += PrivateNotesRepository.TRASH_MS + 1
        val later = repo().apply { load() }
        assertNull("purged after 30 days", later.get(n.id))
    }

    @Test fun `a lost device key makes storage read-only instead of wiping it`() {
        repo(1).apply { load(); create("Keep me", "important") }
        val other = repo(2).apply { load() }
        assertNotNull(other.loadError)
        try {
            other.create("x", "y")
            fail("writes must be refused")
        } catch (_: IllegalStateException) { }
        assertEquals("Keep me", repo(1).apply { load() }.active.single().title)
    }

    @Test fun `encrypted backups round-trip and merge by newest`() {
        val r = repo().apply { load() }
        val a = r.create("A", "one")
        val backup = r.exportBackup("pass phrase".toCharArray())
        now += 1000
        r.update(a.id, body = "changed later")
        val b = r.create("B", "two")

        val fresh = PrivateNotesRepository(
            EncryptedFileStore(Files.createTempDirectory("clipbox-other").toFile(), "p", SecureBox(StaticKeySource(ByteArray(32) { 7 }))),
            { now },
        ).apply { load() }
        try {
            fresh.importBackup(backup, null)
            fail("passphrase required")
        } catch (_: PrivateNotesRepository.PassphraseRequired) { }
        assertEquals(PrivateNotesRepository.ImportResult(1, 0, 0), fresh.importBackup(backup, "pass phrase".toCharArray()))

        val newer = r.exportBackup("pp".toCharArray())
        val res = fresh.importBackup(newer, "pp".toCharArray())
        assertEquals(1, res.added) // B
        assertEquals(1, res.updated) // A changed later
        assertEquals("changed later", fresh.get(a.id)?.body)
        assertNotNull(fresh.get(b.id))
    }

    @Test fun `imports plain JSON exported by the web app`() {
        val r = repo().apply { load() }
        val web = """{"app":"clipbox","kind":"private-notes","format":1,"notes":[
            {"id":"p_abc123","title":"From web","body":"hi","tags":["#x"],"pinned":false,"createdAt":5,"updatedAt":6,"deletedAt":null},
            {"id":"bad id!","title":"","body":"   ","tags":[],"pinned":false,"createdAt":5,"updatedAt":6,"deletedAt":null}]}"""
        val res = r.importBackup(web.toByteArray(), null)
        assertEquals(1, res.added)
        assertEquals(1, res.skipped)
        assertEquals(listOf("x"), r.get("p_abc123")?.tags)
    }

    @Test fun `random files are rejected`() {
        val r = repo().apply { load() }
        try {
            r.importBackup("""{"hello":1}""".toByteArray(), null)
            fail("not a backup")
        } catch (_: IllegalArgumentException) { }
    }
}
