package io.github.salmanulharis.clipbox.core

import io.github.salmanulharis.clipbox.core.model.Json
import io.github.salmanulharis.clipbox.core.model.NoteText
import io.github.salmanulharis.clipbox.core.model.Role
import io.github.salmanulharis.clipbox.core.security.PassphraseBox
import io.github.salmanulharis.clipbox.core.security.SecureBox
import io.github.salmanulharis.clipbox.core.security.StaticKeySource
import io.github.salmanulharis.clipbox.core.storage.EncryptedFileStore
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files

class CoreTest {
    private val box = SecureBox(StaticKeySource(ByteArray(32) { it.toByte() }))
    private fun tempDir(): File = Files.createTempDirectory("clipbox-core").toFile()

    @Test fun `secure box round-trips and uses a fresh IV each time`() {
        val plain = "hello private world".toByteArray()
        val a = box.seal(plain)
        val b = box.seal(plain)
        assertFalse(a.contentEquals(b))
        assertArrayEquals(plain, box.open(a))
        assertFalse(String(a).contains("hello"))
    }

    @Test fun `secure box rejects tampered data`() {
        val sealed = box.seal("secret".toByteArray())
        sealed[sealed.size - 1] = (sealed.last() + 1).toByte()
        try {
            box.open(sealed)
            fail("tampering must be detected")
        } catch (_: Exception) { }
    }

    @Test fun `file store writes atomically and falls back to the backup copy`() {
        val dir = tempDir()
        val store = EncryptedFileStore(dir, "notes", box)
        assertNull(store.read())
        store.write("v1")
        store.write("v2")
        assertEquals("v2", store.read())
        // Damage the main file: the previous version is still readable.
        File(dir, "notes.enc").writeBytes(byteArrayOf(9, 9, 9))
        assertEquals("v1", store.read())
        assertFalse(File(dir, "notes.enc").readText(Charsets.ISO_8859_1).contains("v2"))
    }

    @Test fun `passphrase backups need the right passphrase`() {
        val sealed = PassphraseBox.seal("backup".toByteArray(), "correct horse".toCharArray(), iterations = 2_000)
        assertTrue(PassphraseBox.isSealed(sealed))
        assertEquals("backup", String(PassphraseBox.open(sealed, "correct horse".toCharArray())))
        try {
            PassphraseBox.open(sealed, "wrong".toCharArray())
            fail("wrong passphrase must fail")
        } catch (_: Exception) { }
    }

    @Test fun `snapshot JSON from the server is parsed`() {
        val json = JSONObject(
            """{"rev":3,"boot":"b1","clipboards":[{"id":"c1","name":"General","createdAt":1,"updatedAt":2,
               "items":[{"id":"i1","type":"text","text":"hi","createdAt":1,"updatedAt":1},
                        {"id":"i2","type":"file","name":"a.png","mime":"image/png","size":10,"createdAt":1,"updatedAt":1}]}],
               "notes":[{"id":"n_1","title":"T","body":"B","tags":["x"],"pinned":true,"locked":false,"authorId":"dev_1",
                         "authorName":"Phone","version":4,"createdAt":1,"updatedAt":2,"updatedBy":"dev_1","updatedByName":"Phone"}],
               "me":{"deviceId":"dev_1","name":"Phone","role":"viewer"},
               "server":{"serverId":"srv_1","serverName":"PC","maxNoteBytes":1024}}""",
        )
        val s = Json.snapshot(json)
        assertEquals(3, s.rev)
        assertEquals("hi", s.clipboards[0].items[0].text)
        assertTrue(s.clipboards[0].items[1].isImage)
        assertEquals(4, s.notes[0].version)
        assertEquals(listOf("x"), s.notes[0].tags)
        assertEquals(Role.VIEWER, s.me?.role)
        assertEquals("srv_1", s.serverId)
    }

    @Test fun `tags are cleaned like the web app`() {
        assertEquals(listOf("home", "two-words"), NoteText.parseTags("#home, Home, two words,, "))
        assertEquals("Untitled", NoteText.displayTitle("", "  "))
        assertEquals("first", NoteText.displayTitle("", "\nfirst\nsecond"))
        assertTrue(NoteText.matches("wi pass", "Wi-Fi", "the password", emptyList()))
        assertFalse(NoteText.matches("router", "Wi-Fi", "the password", listOf("home")))
    }
}
