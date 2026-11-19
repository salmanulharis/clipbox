package io.github.salmanulharis.clipbox.ui

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import io.github.salmanulharis.clipbox.network.UrlPolicy
import java.net.URI

/**
 * Android 17+ (API 37) blocks apps from reaching devices on the local network (e.g. a ClipBox
 * server at 192.168.x.x) unless the user grants "Local network access". Public https addresses
 * are unaffected. On older Android versions nothing is needed.
 */
object LocalNetwork {
    const val PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"

    val required: Boolean get() = Build.VERSION.SDK_INT >= 37

    fun granted(context: Context): Boolean =
        !required || ContextCompat.checkSelfPermission(context, PERMISSION) == PackageManager.PERMISSION_GRANTED

    fun isLocal(url: String): Boolean = runCatching { UrlPolicy.isLocalHost(URI(url).host ?: "") }.getOrDefault(false)
}

/** State + launcher for the local-network permission. */
class LocalNetworkAccess(val granted: Boolean, val request: (onResult: (Boolean) -> Unit) -> Unit)

@Composable
fun rememberLocalNetworkAccess(): LocalNetworkAccess {
    val context = LocalContext.current
    var granted by remember { mutableStateOf(LocalNetwork.granted(context)) }
    var pending by remember { mutableStateOf<((Boolean) -> Unit)?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok || LocalNetwork.granted(context)
        pending?.invoke(granted)
        pending = null
    }
    return LocalNetworkAccess(granted) { onResult ->
        if (LocalNetwork.granted(context)) {
            granted = true
            onResult(true)
        } else {
            pending = onResult
            launcher.launch(LocalNetwork.PERMISSION)
        }
    }
}
