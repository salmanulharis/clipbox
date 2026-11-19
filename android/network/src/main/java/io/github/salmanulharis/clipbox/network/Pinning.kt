package io.github.salmanulharis.clipbox.network

import okhttp3.OkHttpClient
import okhttp3.internal.tls.OkHostnameVerifier
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Trust-on-first-use pinning for self-signed LAN certificates.
 * The pin (SHA-256 of the leaf certificate, lowercase hex) comes from the server's QR code,
 * which the user scanned from a screen they control. A certificate matching the pin is
 * accepted; everything else goes through normal system validation and hostname checks.
 */
object Pinning {
    fun sha256(cert: X509Certificate): String =
        MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }

    fun apply(builder: OkHttpClient.Builder, pin: String) {
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(null as KeyStore?) }
        val system = tmf.trustManagers.filterIsInstance<X509TrustManager>().first()
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = system.checkClientTrusted(chain, authType)

            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                if (chain.isNotEmpty() && sha256(chain[0]) == pin) return
                try {
                    system.checkServerTrusted(chain, authType)
                } catch (e: CertificateException) {
                    throw CertificateException("Certificate doesn't match the one this phone paired with.", e)
                }
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
        }
        val ctx = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        builder.sslSocketFactory(ctx.socketFactory, trust)
        builder.hostnameVerifier { host, session ->
            val leaf = runCatching { session.peerCertificates.firstOrNull() as? X509Certificate }.getOrNull()
            (leaf != null && sha256(leaf) == pin) || OkHostnameVerifier.verify(host, session)
        }
    }
}
