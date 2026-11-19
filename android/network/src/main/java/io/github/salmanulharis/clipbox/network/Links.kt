package io.github.salmanulharis.clipbox.network

import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI
import java.net.URLDecoder

/** What a ClipBox QR code / link tells us. */
data class ServerLink(
    /** scheme://host[:port], no trailing slash. */
    val baseUrl: String,
    /** One-time pairing token from `/join?t=…`, if present. */
    val pairToken: String?,
    /** Server id from the `#cb1.<serverId>` fragment, if present. */
    val serverId: String?,
    /** SHA-256 of the server's HTTPS certificate (`#cb1.<id>.sha256-<hex>`), for self-signed LAN certificates. */
    val certSha256: String? = null,
)

object QrLink {
    /**
     * Parses the links the ClipBox web app puts in its QR codes, e.g.
     * `http://192.168.1.20:3210/#cb1.srv_x` or `https://abc.ngrok.app/join?t=TOKEN#cb1.srv_x`.
     * Also accepts a bare address such as `192.168.1.20:3210`.
     */
    fun parse(raw: String): ServerLink? {
        var s = raw.trim()
        if (s.isEmpty() || s.length > 2000) return null
        if (!s.contains("://")) s = "http://$s"
        val uri = try {
            URI(s)
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = uri.host ?: return null
        val hostPart = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
        val base = "$scheme://$hostPart" + if (uri.port != -1) ":${uri.port}" else ""
        val token = if (uri.path == "/join") query(uri.rawQuery)["t"]?.takeIf { it.isNotBlank() } else null
        val parts = uri.fragment?.takeIf { it.startsWith("cb1.") }?.removePrefix("cb1.")?.split('.').orEmpty()
        val serverId = parts.firstOrNull()?.takeIf { it.matches(Regex("[\\w-]{3,64}")) }
        val cert = parts.drop(1).firstOrNull { it.startsWith("sha256-") }?.removePrefix("sha256-")?.lowercase()
            ?.takeIf { it.matches(Regex("[0-9a-f]{64}")) }
        return ServerLink(base, token, serverId, cert)
    }

    private fun query(raw: String?): Map<String, String> = raw.orEmpty().split('&').mapNotNull {
        val i = it.indexOf('=')
        if (i <= 0) null else it.substring(0, i) to URLDecoder.decode(it.substring(i + 1), "UTF-8")
    }.toMap()
}

/**
 * Plain `http://` is only allowed for addresses on the local network (private IPs, localhost,
 * `*.local`, the emulator host). Anything reachable from the internet must use HTTPS.
 */
object UrlPolicy {
    fun isEncrypted(url: String): Boolean = url.startsWith("https://", ignoreCase = true)

    /** @return null if allowed, otherwise a user-facing reason. */
    fun check(url: String): String? {
        val uri = try {
            URI(url)
        } catch (_: Exception) {
            return "That isn't a valid address."
        }
        return when (uri.scheme?.lowercase()) {
            "https" -> null
            "http" -> if (isLocalHost(uri.host ?: "")) null else "Public addresses must use HTTPS (for example your ngrok or Cloudflare URL)."
            else -> "Only http and https addresses are supported."
        }
    }

    fun isLocalHost(rawHost: String): Boolean {
        val host = rawHost.lowercase().removePrefix("[").removeSuffix("]")
        if (host == "localhost" || host.endsWith(".local") || host.endsWith(".lan")) return true
        if (Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(host)) {
            val p = host.split('.').map { it.toInt() }
            if (p.any { it > 255 }) return false
            return p[0] == 10 || p[0] == 127 ||
                (p[0] == 172 && p[1] in 16..31) ||
                (p[0] == 192 && p[1] == 168) ||
                (p[0] == 169 && p[1] == 254) ||
                (p[0] == 100 && p[1] in 64..127)
        }
        if (host.contains(':')) {
            return try {
                val a = InetAddress.getByName(host) as? Inet6Address ?: return false
                a.isLoopbackAddress || a.isLinkLocalAddress || a.isSiteLocalAddress || (a.address[0].toInt() and 0xfe) == 0xfc
            } catch (_: Exception) {
                false
            }
        }
        return false
    }
}
