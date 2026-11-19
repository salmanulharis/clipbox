package io.github.salmanulharis.clipbox.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import io.github.salmanulharis.clipbox.AppViewModel
import io.github.salmanulharis.clipbox.ConnectOutcome
import io.github.salmanulharis.clipbox.Screen
import io.github.salmanulharis.clipbox.network.QrLink
import io.github.salmanulharis.clipbox.network.ServerLink
import io.github.salmanulharis.clipbox.ui.theme.LocalPalette
import kotlinx.coroutines.launch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@Composable
fun ScannerScreen(vm: AppViewModel) {
    val p = LocalPalette.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var hasCamera by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { hasCamera = it }
    LaunchedEffect(Unit) { if (!hasCamera) askCamera.launch(Manifest.permission.CAMERA) }

    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var manual by remember { mutableStateOf("") }
    var passwordFor by remember { mutableStateOf<Pair<ServerLink, ConnectOutcome.NeedsPassword>?>(null) }
    val paused = busy || passwordFor != null

    val localNet = rememberLocalNetworkAccess()

    fun attempt(link: ServerLink, password: String? = null) {
        // Check the live permission (not remembered state), or a grant would re-request forever.
        if (LocalNetwork.isLocal(link.baseUrl) && !LocalNetwork.granted(context)) {
            busy = true
            localNet.request { ok ->
                busy = false
                if (ok) attempt(link, password)
                else error = "ClipBox needs \"Local network access\" to reach a server on your Wi-Fi. Allow it in Android Settings → Apps → ClipBox → Permissions, or scan the public (https) QR code instead."
            }
            return
        }
        busy = true
        error = null
        scope.launch {
            when (val r = vm.connect(link, password)) {
                ConnectOutcome.Done -> Unit
                is ConnectOutcome.NeedsPassword -> passwordFor = link to r
                is ConnectOutcome.Failed -> error = r.message
            }
            busy = false
        }
    }

    fun onText(text: String) {
        if (paused) return
        val link = QrLink.parse(text)
        if (link == null) {
            error = "That isn't a ClipBox link. Scan the QR code from ClipBox → Connect on your computer."
            return
        }
        attempt(link)
    }

    // The camera keeps seeing the same code: don't retry it for a few seconds after an attempt.
    var lastScan by remember { mutableStateOf("" to 0L) }
    fun onScan(text: String) {
        val now = System.currentTimeMillis()
        if (paused || (text == lastScan.first && now - lastScan.second < 4000)) return
        lastScan = text to now
        onText(text)
    }

    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconAction(Ic.Back, "Back", tint = p.text) { vm.screen = Screen.Home }
            Text("Connect to a server", style = MaterialTheme.typography.titleLarge, color = p.text)
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(
                "On your computer, open ClipBox and click Connect. Scan the QR code shown there.",
                style = MaterialTheme.typography.bodyMedium, color = p.muted,
            )
            Box(
                Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(16.dp)).background(Color.Black),
                contentAlignment = Alignment.Center,
            ) {
                if (hasCamera) {
                    QrCamera(enabled = !paused, onCode = ::onScan)
                    Box(Modifier.fillMaxSize(0.62f).border(2.dp, Color.White.copy(alpha = 0.85f), RoundedCornerShape(14.dp)))
                } else {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(24.dp)) {
                        Text("Camera access is needed to scan.", color = Color.White, style = MaterialTheme.typography.bodyMedium)
                        Spacer(Modifier.height(10.dp))
                        OutlinedButton(onClick = { askCamera.launch(Manifest.permission.CAMERA) }) { Text("Allow camera", color = Color.White) }
                    }
                }
                if (busy) {
                    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.55f)), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator(color = Color.White, modifier = Modifier.size(32.dp))
                            Spacer(Modifier.height(10.dp))
                            Text("Connecting…", color = Color.White)
                        }
                    }
                }
            }
            error?.let { Banner(Ic.X, it, warn = true) }
            Text("Or enter the address", style = MaterialTheme.typography.labelLarge, color = p.muted)
            OutlinedTextField(
                manual, { manual = it },
                placeholder = { Text("e.g. 192.168.1.20:3210 or a ClipBox link") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                modifier = Modifier.fillMaxWidth(),
            )
            Button(enabled = manual.isNotBlank() && !paused, onClick = { onText(manual) }, modifier = Modifier.fillMaxWidth()) { Text("Connect") }
        }
    }

    passwordFor?.let { (link, need) ->
        var pw by remember { mutableStateOf("") }
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { passwordFor = null },
            title = { Text("Password for ${need.serverName}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(need.hint ?: "This server needs its password to add a new device. You only enter it once.")
                    OutlinedTextField(
                        pw, { pw = it }, singleLine = true, label = { Text("Server password") },
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                androidx.compose.material3.TextButton(enabled = pw.isNotEmpty(), onClick = {
                    passwordFor = null
                    attempt(link, pw)
                }) { Text("Connect") }
            },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { passwordFor = null }) { Text("Cancel") } },
        )
    }
}

/** Camera preview that decodes QR codes with ZXing; reports each new code once. */
@Composable
private fun QrCamera(enabled: Boolean, onCode: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val active = remember { AtomicBoolean(true) }
    active.set(enabled)
    val currentOnCode = androidx.compose.runtime.rememberUpdatedState(onCode)

    DisposableEffect(Unit) {
        onDispose {
            runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
            executor.shutdown()
        }
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            val view = PreviewView(ctx).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
            val providerFuture = ProcessCameraProvider.getInstance(ctx)
            providerFuture.addListener({
                val provider = providerFuture.get()
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                    .also {
                        it.setAnalyzer(executor, QrAnalyzer({ active.get() }) { text ->
                            if (!active.get()) return@QrAnalyzer
                            ContextCompat.getMainExecutor(ctx).execute { if (active.get()) currentOnCode.value(text) }
                        })
                    }
                runCatching {
                    provider.unbindAll()
                    provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                }
            }, ContextCompat.getMainExecutor(ctx))
            view
        },
    )
}

private class QrAnalyzer(private val isActive: () -> Boolean, private val onResult: (String) -> Unit) : ImageAnalysis.Analyzer {
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true))
    }
    private var lastAt = 0L

    override fun analyze(image: ImageProxy) {
        try {
            val now = System.currentTimeMillis()
            if (!isActive() || now - lastAt < 150) return
            lastAt = now
            val plane = image.planes[0]
            val buffer = plane.buffer
            val data = ByteArray(buffer.remaining()).also(buffer::get)
            val width = minOf(image.width, plane.rowStride)
            val source = PlanarYUVLuminanceSource(data, plane.rowStride, image.height, 0, 0, width, image.height, false)
            val result = reader.decodeWithState(BinaryBitmap(HybridBinarizer(source)))
            onResult(result.text)
        } catch (_: Exception) {
            // no QR code in this frame
        } finally {
            reader.reset()
            image.close()
        }
    }
}
