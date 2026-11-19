package io.github.salmanulharis.clipbox.network

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.net.URLDecoder
import java.nio.file.Files

/** Uploading and downloading clipboard files. */
class FilesTest {
    private val server = MockWebServer()

    @After fun tearDown() = server.shutdown()

    @Test fun `file names are encoded like encodeURIComponent`() {
        assertEquals("photo%20%C3%BC%2B1.png", ClipBoxApi.encodeFilename("photo ü+1.png"))
        assertEquals("a-b_c.d!~*'()", ClipBoxApi.encodeFilename("a-b_c.d!~*'()"))
        assertEquals("photo ü+1.png", URLDecoder.decode(ClipBoxApi.encodeFilename("photo ü+1.png").replace("+", "%2B"), "UTF-8"))
    }

    @Test fun `uploads stream the file with its name and type`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":"i_9","type":"file","name":"pic ü.png","mime":"image/png","size":4}"""))
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        val bytes = byteArrayOf(1, 2, 3, 4)
        val item = ClipBoxApi().uploadFile("http://127.0.0.1:${server.port}", "cbd_t", "c1", "pic ü.png", "image/png", 4) { ByteArrayInputStream(bytes) }
        assertEquals("i_9", item.id)
        assertEquals(true, item.isImage)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/clipboards/c1/files", req.path)
        assertEquals("pic%20%C3%BC.png", req.getHeader("X-Filename"))
        assertEquals("image/png", req.getHeader("Content-Type"))
        assertEquals("Bearer cbd_t", req.getHeader("Authorization"))
        assertArrayEquals(bytes, req.body.readByteArray())
    }

    @Test fun `unknown types are sent as octet-stream`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":"i_1","type":"file","name":"x","mime":"application/octet-stream","size":1}"""))
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        ClipBoxApi().uploadFile("http://127.0.0.1:${server.port}", "t", "c1", "x", "not a mime", -1) { ByteArrayInputStream(byteArrayOf(9)) }
        assertEquals("application/octet-stream", server.takeRequest().getHeader("Content-Type"))
    }

    @Test fun `downloads stream to a file`() = runBlocking {
        val payload = ByteArray(300_000) { (it % 251).toByte() }
        server.enqueue(MockResponse().setBody(Buffer().write(payload)))
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        val target = Files.createTempFile("clipbox", ".bin").toFile()
        ClipBoxApi().downloadTo("http://127.0.0.1:${server.port}", "t", "i_1", target)
        assertArrayEquals(payload, target.readBytes())
        assertEquals("/files/i_1?download", server.takeRequest().path)
    }
}
