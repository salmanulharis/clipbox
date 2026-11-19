package io.github.salmanulharis.clipbox.core.storage

import io.github.salmanulharis.clipbox.core.security.SecureBox
import java.io.File
import java.io.FileOutputStream

/**
 * One encrypted text document on disk, written atomically:
 * encrypt → write temp file → fsync → keep the previous version as `.bak` → rename into place.
 * Reads fall back to the `.bak` copy if the main file is missing or damaged.
 */
class EncryptedFileStore(dir: File, name: String, private val box: SecureBox) {
    private val main = File(dir, "$name.enc")
    private val backup = File(dir, "$name.enc.bak")
    private val temp = File(dir, "$name.enc.tmp")

    init {
        dir.mkdirs()
    }

    /** Last read failure, for diagnostics (e.g. Keystore key lost after a device reset). */
    @Volatile var lastError: Throwable? = null
        private set

    @Synchronized
    fun read(): String? {
        for (f in listOf(main, backup)) {
            if (!f.exists()) continue
            try {
                return String(box.open(f.readBytes()), Charsets.UTF_8)
            } catch (e: Exception) {
                lastError = e
            }
        }
        return null
    }

    @Synchronized
    fun write(text: String) {
        val data = box.seal(text.toByteArray(Charsets.UTF_8))
        FileOutputStream(temp).use { out ->
            out.write(data)
            out.fd.sync()
        }
        if (main.exists()) main.copyTo(backup, overwrite = true)
        if (!temp.renameTo(main)) {
            // Some filesystems (e.g. Windows in unit tests) won't rename over an existing file.
            main.delete()
            check(temp.renameTo(main)) { "Could not move ${temp.name} into place" }
        }
    }

    @Synchronized
    fun delete() {
        listOf(main, backup, temp).forEach { it.delete() }
    }

    fun exists(): Boolean = main.exists() || backup.exists()
}
