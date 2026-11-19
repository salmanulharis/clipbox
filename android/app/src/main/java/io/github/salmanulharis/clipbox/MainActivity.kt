package io.github.salmanulharis.clipbox

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.content.IntentCompat
import io.github.salmanulharis.clipbox.ui.ClipBoxApp
import io.github.salmanulharis.clipbox.ui.theme.ClipBoxTheme

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) handleShare(intent)
        setContent {
            ClipBoxTheme(vm.themeId) { ClipBoxApp(vm) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShare(intent)
    }

    /** "Share to ClipBox" from another app: the user then picks where it goes. */
    private fun handleShare(intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_SEND -> {
                val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() }
                val stream = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                when {
                    // A shared file wins unless it's plain text that also came as text (e.g. a link).
                    stream != null && (text == null || intent.type?.startsWith("text/") != true) -> vm.pendingShareFiles = listOf(stream)
                    text != null -> vm.pendingShare = text.take(1_000_000)
                }
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                    ?.takeIf { it.isNotEmpty() }?.let { vm.pendingShareFiles = it.take(50) }
            }
        }
    }
}
