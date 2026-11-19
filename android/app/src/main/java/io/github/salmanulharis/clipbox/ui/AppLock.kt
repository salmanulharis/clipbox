package io.github.salmanulharis.clipbox.ui

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.view.WindowManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext

/**
 * Unlock for private notes with the phone's own security: fingerprint/face or the screen-lock
 * PIN/pattern/password. Uses the system BiometricPrompt on Android 11+ and the screen-lock
 * confirmation on Android 8–10. Private notes are already encrypted at rest; this gate keeps
 * someone holding your unlocked phone out of them.
 */
object AppLock {
    fun deviceSecure(context: Context): Boolean =
        context.getSystemService(KeyguardManager::class.java)?.isDeviceSecure == true
}

/** Returns a function that asks the user to authenticate, then calls back with the result. */
@Composable
fun rememberAuthenticator(): (title: String, onResult: (Boolean) -> Unit) -> Unit {
    val context = LocalContext.current
    var pending by remember { mutableStateOf<((Boolean) -> Unit)?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        pending?.invoke(r.resultCode == Activity.RESULT_OK)
        pending = null
    }
    return { title, onResult ->
        if (!AppLock.deviceSecure(context)) {
            onResult(true) // nothing to verify against; the setting can't be enabled in this state anyway
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val prompt = BiometricPrompt.Builder(context)
                .setTitle(title)
                .setSubtitle("Private notes")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                .build()
            prompt.authenticate(
                CancellationSignal(),
                context.mainExecutor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onResult(true)
                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = onResult(false)
                },
            )
        } else {
            @Suppress("DEPRECATION")
            val intent = context.getSystemService(KeyguardManager::class.java)?.createConfirmDeviceCredentialIntent(title, "Private notes")
            if (intent == null) onResult(true) else {
                pending = onResult
                launcher.launch(intent)
            }
        }
    }
}

/** While shown, blocks screenshots and hides the screen in the recent-apps switcher. */
@Composable
fun SecureScreen(enabled: Boolean) {
    val activity = LocalContext.current as? Activity ?: return
    DisposableEffect(enabled) {
        if (enabled) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        onDispose { if (enabled) activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }
}
