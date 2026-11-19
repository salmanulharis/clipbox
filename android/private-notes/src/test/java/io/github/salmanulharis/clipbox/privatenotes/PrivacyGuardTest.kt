package io.github.salmanulharis.clipbox.privatenotes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Enforces the privacy boundary: the private-notes module contains no networking code and does
 * not depend on the :network module or an HTTP client.
 */
class PrivacyGuardTest {
    private val moduleDir = File(System.getProperty("user.dir"))

    @Test fun `module does not depend on networking`() {
        val build = File(moduleDir, "build.gradle.kts").readText()
            .lines().filterNot { it.trim().startsWith("//") }.joinToString("\n")
        for (banned in listOf(":network", "okhttp", "retrofit", "ktor", "volley")) {
            assertTrue("build.gradle.kts must not reference $banned", !build.contains(banned, ignoreCase = true))
        }
    }

    @Test fun `sources contain no network APIs`() {
        val sources = File(moduleDir, "src/main").walkTopDown().filter { it.isFile && (it.extension == "kt" || it.extension == "java") }.toList()
        assertTrue("expected sources in ${moduleDir.path}", sources.isNotEmpty())
        val banned = listOf("java.net", "javax.net", "okhttp", "HttpURLConnection", "Socket", "URL(", "android.net")
        val hits = sources.flatMap { f -> banned.filter { f.readText().contains(it) }.map { "${f.name}: $it" } }
        assertEquals(emptyList<String>(), hits)
    }

    @Test fun `manifest requests no permissions`() {
        val manifest = File(moduleDir, "src/main/AndroidManifest.xml").readText()
        assertTrue(!manifest.contains("uses-permission"))
    }
}
