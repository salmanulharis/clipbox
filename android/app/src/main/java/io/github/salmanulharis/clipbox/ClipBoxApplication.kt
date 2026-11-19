package io.github.salmanulharis.clipbox

import android.app.Application
import android.content.Context
import io.github.salmanulharis.clipbox.core.security.AndroidKeystoreKeySource
import io.github.salmanulharis.clipbox.core.security.SecureBox
import io.github.salmanulharis.clipbox.core.storage.EncryptedFileStore
import io.github.salmanulharis.clipbox.network.ClipBoxApi
import io.github.salmanulharis.clipbox.network.ProfileStore
import io.github.salmanulharis.clipbox.network.SharedCache
import io.github.salmanulharis.clipbox.network.SyncEngine
import io.github.salmanulharis.clipbox.privatenotes.PrivateNotesRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.io.File

class ClipBoxApplication : Application() {
    val graph: AppGraph by lazy { AppGraph(this) }
}

/** App-wide singletons. All data at rest is encrypted with one Android Keystore key. */
class AppGraph(context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val box = SecureBox(AndroidKeystoreKeySource("clipbox.data.v1"))
    // noBackupFilesDir: never part of any backup, in addition to allowBackup=false.
    private val dir = File(context.noBackupFilesDir, "secure")

    val privateNotes = PrivateNotesRepository(EncryptedFileStore(dir, "private-notes", box))
    val profiles = ProfileStore(EncryptedFileStore(dir, "profiles", box))
    val cache = SharedCache(File(dir, "cache"), box)
    val api = ClipBoxApi()
    val sync = SyncEngine(api, profiles, cache, scope) { name -> EncryptedFileStore(dir, name, box) }
    val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)
}
