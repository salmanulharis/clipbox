package io.github.salmanulharis.clipbox.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.salmanulharis.clipbox.AppViewModel
import io.github.salmanulharis.clipbox.BuildConfigInfo
import io.github.salmanulharis.clipbox.Screen
import io.github.salmanulharis.clipbox.network.Connection
import io.github.salmanulharis.clipbox.network.UrlPolicy
import io.github.salmanulharis.clipbox.ui.theme.LocalPalette
import io.github.salmanulharis.clipbox.ui.theme.Palettes
import kotlinx.coroutines.launch
import java.time.LocalDate

@Composable
fun SettingsTab(vm: AppViewModel) {
    val p = LocalPalette.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val profiles by vm.profiles.collectAsStateWithLifecycle()
    val activeId by vm.activeId.collectAsStateWithLifecycle()
    val connection by vm.connection.collectAsStateWithLifecycle()
    val privateAll by vm.privateNotes.collectAsStateWithLifecycle()
    val profile = profiles.firstOrNull { it.serverId == activeId }
    val pending by vm.pending.collectAsStateWithLifecycle()
    val authenticate = rememberAuthenticator()
    /** Run [action] now, or after fingerprint/PIN if private notes are locked. */
    fun unlocked(action: () -> Unit) {
        if (!vm.privateLocked) action()
        else authenticate("Unlock private notes") { ok -> if (ok) { vm.unlockPrivate(); action() } }
    }

    var dialog by remember { mutableStateOf<String?>(null) } // disconnect | export | import-pass
    var exportPass by remember { mutableStateOf<CharArray?>(null) }
    var importBytes by remember { mutableStateOf<ByteArray?>(null) }

    val createDoc = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val pass = exportPass
        exportPass = null
        if (uri != null && pass != null) {
            vm.exportPrivate(pass) { bytes -> context.contentResolver.openOutputStream(uri, "wt")!!.use { it.write(bytes) } }
        }
    }
    val openDoc = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val bytes = try {
                context.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
            } catch (e: Exception) {
                vm.msg("Couldn't read that file.", error = true)
                return@launch
            }
            if (vm.importPrivate(bytes, null)) {
                importBytes = bytes
                dialog = "import-pass"
            }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Section("Server") {
            if (profile == null) {
                Text("Not connected. Private notes still work without a server.", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                Spacer(Modifier.height(8.dp))
                ActionRow(Ic.Scan, "Scan a QR code to connect") { vm.screen = Screen.Scanner }
            } else {
                val base = (connection as? Connection.Online)?.base
                InfoRow("Name", profile.serverName)
                InfoRow(
                    "Status",
                    when (val c = connection) {
                        is Connection.Online -> if (c.live) "Connected · live" else "Connected · polling"
                        Connection.Connecting -> "Connecting…"
                        is Connection.Offline -> "Offline"
                        Connection.Revoked -> "Removed by the host"
                        is Connection.WrongServer -> "Different server at saved address"
                        Connection.Idle -> "Paused"
                    },
                )
                InfoRow("Address", base ?: profile.lastGoodUrl ?: profile.urls.firstOrNull() ?: "—")
                base?.let {
                    InfoRow("Security", if (UrlPolicy.isEncrypted(it)) "Encrypted (HTTPS)" else "Not encrypted (local network only)")
                }
                InfoRow("This phone", "${vm.role.name.lowercase().replaceFirstChar { it.uppercase() }}${if (!vm.role.canWrite) " · view only" else ""}")
                if (profile.certSha256 != null) InfoRow("Certificate", "Pinned from the QR code (self-signed)")
                if (pending.isNotEmpty()) InfoRow("Waiting", "${pending.size} offline change${if (pending.size == 1) "" else "s"} to sync")
                Spacer(Modifier.height(4.dp))
                ActionRow(Ic.Refresh, "Reconnect now") { vm.refresh() }
                ActionRow(Ic.Scan, "Connect another server") { vm.screen = Screen.Scanner }
                ActionRow(Ic.Logout, "Disconnect from ${profile.serverName}", danger = true) { dialog = "disconnect" }
            }
            val others = profiles.filter { it.serverId != activeId }
            if (others.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text("Switch server", style = MaterialTheme.typography.labelLarge, color = p.muted)
                others.forEach { o -> ActionRow(Ic.Server, o.serverName) { vm.switchTo(o.serverId) } }
            }
        }

        Section("Private notes") {
            val secure = AppLock.deviceSecure(context)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Lock with fingerprint or screen lock", style = MaterialTheme.typography.bodyLarge, color = p.text)
                    Text(
                        if (secure || vm.lockEnabled) "Asks before showing private notes, and again after 30 seconds away. Also blocks screenshots of them."
                        else "Set up a screen lock in Android Settings to use this.",
                        style = MaterialTheme.typography.bodySmall, color = p.muted,
                    )
                }
                Spacer(Modifier.width(12.dp))
                Switch(
                    checked = vm.lockEnabled,
                    enabled = secure || vm.lockEnabled,
                    onCheckedChange = { on ->
                        authenticate(if (on) "Turn on the private notes lock" else "Turn off the private notes lock") { ok ->
                            if (ok) vm.changePrivateLock(on)
                        }
                    },
                )
            }
            HorizontalDivider(color = p.border.copy(alpha = 0.5f), modifier = Modifier.padding(vertical = 8.dp))
            Text(
                "${privateAll.count { it.deletedAt == null }} notes, encrypted with a key that never leaves this phone. " +
                    "They aren't included in Android backups — make your own encrypted backup below.",
                style = MaterialTheme.typography.bodyMedium, color = p.muted,
            )
            Spacer(Modifier.height(8.dp))
            ActionRow(Ic.Download, "Back up (encrypted file)") { unlocked { dialog = "export" } }
            ActionRow(Ic.Upload, "Restore from a backup") { unlocked { openDoc.launch(arrayOf("*/*")) } }
            Text(
                "Backups are interchangeable with the ClipBox web app (encrypted .cbx or plain .json).",
                style = MaterialTheme.typography.bodySmall, color = p.muted,
            )
        }

        Section("Appearance") {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Palettes.choices.forEach { (id, name) ->
                    val pal = Palettes.all.firstOrNull { it.id == id }
                    val on = vm.themeId == id
                    Column(
                        Modifier.clip(RoundedCornerShape(10.dp)).clickable { vm.setTheme(id) }
                            .border(1.5.dp, if (on) p.accent else p.border, RoundedCornerShape(10.dp)).padding(10.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Box(
                            Modifier.size(28.dp).clip(CircleShape).border(1.dp, p.border, CircleShape).background(
                                if (pal == null) Brush.linearGradient(listOf(Color.White, Color.White, Color(0xFF111214), Color(0xFF111214)))
                                else Brush.linearGradient(listOf(pal.bg, pal.bg, pal.accent, pal.accent)),
                            ),
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(name, style = MaterialTheme.typography.bodySmall, color = if (on) p.accent else p.text)
                    }
                }
            }
        }

        Section("About") {
            InfoRow("Version", BuildConfigInfo.versionName(context))
            Text(
                "Private notes stay on this phone, encrypted. Shared notes and clipboards live on your ClipBox server. " +
                    "Plain http is only used for addresses on your local network.",
                style = MaterialTheme.typography.bodySmall, color = p.muted,
            )
        }
        Spacer(Modifier.height(40.dp))
    }

    when (dialog) {
        "disconnect" -> profile?.let {
            ConfirmDialog(
                "Disconnect from ${it.serverName}?",
                "This phone is removed from the server and its saved shared data is deleted here. Your private notes stay on this phone.",
                "Disconnect", danger = true, onDismiss = { dialog = null },
            ) { vm.disconnect() }
        }
        "export" -> PassphraseDialog(
            "Back up private notes",
            "The backup file is encrypted with this passphrase. You'll need it to restore.",
            confirmTwice = true, onDismiss = { dialog = null },
        ) { pass ->
            exportPass = pass
            createDoc.launch("clipbox-private-notes-${LocalDate.now()}.cbx")
        }
        "import-pass" -> PassphraseDialog(
            "Encrypted backup",
            "Enter the passphrase used when this backup was made.",
            confirmTwice = false, onDismiss = { dialog = null; importBytes = null },
        ) { pass ->
            val bytes = importBytes ?: return@PassphraseDialog
            scope.launch {
                if (vm.importPrivate(bytes, pass)) dialog = "import-pass" else importBytes = null
            }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    val p = LocalPalette.current
    Column {
        Text(title.uppercase(), style = MaterialTheme.typography.labelLarge, color = p.muted)
        Spacer(Modifier.height(8.dp))
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).border(1.dp, p.border, RoundedCornerShape(12.dp)).padding(14.dp)) { content() }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    val p = LocalPalette.current
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = p.muted, modifier = Modifier.width(96.dp))
        Text(value, style = MaterialTheme.typography.bodyMedium, color = p.text, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun ActionRow(icon: ImageVector, label: String, danger: Boolean = false, onClick: () -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(vertical = 10.dp, horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(18.dp), tint = if (danger) p.danger else p.accent)
        Spacer(Modifier.width(12.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge, color = if (danger) p.danger else p.text)
    }
    HorizontalDivider(color = p.border.copy(alpha = 0.5f))
}
