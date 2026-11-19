package io.github.salmanulharis.clipbox.core.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.nio.ByteBuffer
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/** Supplies the AES key used to encrypt data at rest. */
fun interface KeySource {
    fun key(): SecretKey
}

/**
 * AES-256 key generated inside the Android Keystore (hardware-backed where the device supports it).
 * The key never leaves the Keystore and is not included in backups, so encrypted files are
 * unreadable anywhere except on this device, by this app.
 */
class AndroidKeystoreKeySource(private val alias: String) : KeySource {
    @Synchronized
    override fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }
}

/** Fixed key, for unit tests on the JVM (no Android Keystore there). */
class StaticKeySource(bytes: ByteArray) : KeySource {
    private val key = SecretKeySpec(bytes.copyOf(), "AES")
    override fun key(): SecretKey = key
}

/** Authenticated encryption (AES-GCM). Format: [version=1][12-byte IV][ciphertext+tag]. */
class SecureBox(private val keys: KeySource) {
    fun seal(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, keys.key()) // the provider picks a fresh random IV
        val iv = cipher.iv
        require(iv.size == IV_BYTES) { "Unexpected IV size ${iv.size}" }
        return byteArrayOf(VERSION) + iv + cipher.doFinal(plain)
    }

    fun open(data: ByteArray): ByteArray {
        require(data.size > 1 + IV_BYTES && data[0] == VERSION) { "Unknown encrypted format" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, keys.key(), GCMParameterSpec(TAG_BITS, data, 1, IV_BYTES))
        return cipher.doFinal(data, 1 + IV_BYTES, data.size - 1 - IV_BYTES)
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val VERSION: Byte = 1
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}

/**
 * Passphrase-based encryption for backups that leave the device (PBKDF2-SHA256 → AES-256-GCM).
 * Format: "CBX1" | iterations (int) | 16-byte salt | 12-byte IV | ciphertext+tag.
 */
object PassphraseBox {
    private val MAGIC = "CBX1".toByteArray()
    const val DEFAULT_ITERATIONS = 310_000

    fun isSealed(data: ByteArray): Boolean = data.size > 36 && data.copyOfRange(0, 4).contentEquals(MAGIC)

    fun seal(plain: ByteArray, passphrase: CharArray, iterations: Int = DEFAULT_ITERATIONS): ByteArray {
        val rnd = SecureRandom()
        val salt = ByteArray(16).also(rnd::nextBytes)
        val iv = ByteArray(12).also(rnd::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, derive(passphrase, salt, iterations), GCMParameterSpec(128, iv))
        val ct = cipher.doFinal(plain)
        return ByteBuffer.allocate(4 + 4 + 16 + 12 + ct.size)
            .put(MAGIC).putInt(iterations).put(salt).put(iv).put(ct).array()
    }

    /** @throws javax.crypto.AEADBadTagException when the passphrase is wrong or the file was altered. */
    fun open(data: ByteArray, passphrase: CharArray): ByteArray {
        require(isSealed(data)) { "Not an encrypted ClipBox backup" }
        val buf = ByteBuffer.wrap(data, 4, data.size - 4)
        val iterations = buf.int
        require(iterations in 1_000..5_000_000) { "Corrupted backup header" }
        val salt = ByteArray(16).also(buf::get)
        val iv = ByteArray(12).also(buf::get)
        val ct = ByteArray(buf.remaining()).also(buf::get)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, derive(passphrase, salt, iterations), GCMParameterSpec(128, iv))
        return cipher.doFinal(ct)
    }

    private fun derive(passphrase: CharArray, salt: ByteArray, iterations: Int): SecretKey {
        val spec = PBEKeySpec(passphrase, salt, iterations, 256)
        try {
            val bytes = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
            return SecretKeySpec(bytes, "AES")
        } finally {
            spec.clearPassword()
        }
    }
}
