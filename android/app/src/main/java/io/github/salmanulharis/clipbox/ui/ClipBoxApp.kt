package io.github.salmanulharis.clipbox.ui

import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.salmanulharis.clipbox.AppViewModel
import io.github.salmanulharis.clipbox.Scope
import io.github.salmanulharis.clipbox.Screen
import io.github.salmanulharis.clipbox.Tab
import io.github.salmanulharis.clipbox.network.Connection
import io.github.salmanulharis.clipbox.ui.theme.LocalPalette
import io.github.salmanulharis.clipbox.ui.theme.Palette
import androidx.compose.ui.graphics.Color

@Composable
fun ClipBoxApp(vm: AppViewModel) {
    val p = LocalPalette.current
    val context = LocalContext.current
    LaunchedEffect(p.dark, p.bg) {
        val transparent = android.graphics.Color.TRANSPARENT
        (context as? ComponentActivity)?.enableEdgeToEdge(
            statusBarStyle = if (p.dark) SystemBarStyle.dark(transparent) else SystemBarStyle.light(transparent, transparent),
            navigationBarStyle = if (p.dark) SystemBarStyle.dark(p.bg.toArgb()) else SystemBarStyle.light(p.bg.toArgb(), p.bg.toArgb()),
        )
    }

    val localNet = rememberLocalNetworkAccess()
    val activeIdForPermission by vm.activeId.collectAsStateWithLifecycle()
    LaunchedEffect(activeIdForPermission, vm.ready) {
        val p = vm.activeProfile ?: return@LaunchedEffect
        if (!localNet.granted && p.urls.any(LocalNetwork::isLocal)) localNet.request { ok -> if (ok) vm.refresh() }
    }

    LifecycleStartEffect(Unit) {
        vm.onForeground()
        onStopOrDispose { vm.onBackground() }
    }

    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(Unit) {
        vm.messages.collect { m ->
            val r = snackbar.showSnackbar(m.text, m.actionLabel, duration = if (m.action != null) SnackbarDuration.Long else SnackbarDuration.Short)
            if (r == SnackbarResult.ActionPerformed) m.action?.invoke()
        }
    }

    BackHandler(enabled = vm.screen != Screen.Home) {
        if (vm.screen == Screen.Editor) vm.closeEditor() else vm.screen = Screen.Home
    }

    Box(Modifier.fillMaxSize().background(p.bg)) {
        if (!vm.ready) return@Box
        when (vm.screen) {
            Screen.Home -> HomeScreen(vm)
            Screen.Editor -> vm.editor?.let { NoteEditorScreen(vm, it) }
            Screen.Scanner -> ScannerScreen(vm)
            Screen.Trash -> TrashScreen(vm)
            Screen.Groups -> GroupsScreen(vm)
        }
        SnackbarHost(
            snackbar,
            Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = if (vm.screen == Screen.Home) 80.dp else 8.dp),
        ) { data ->
            Snackbar(data, containerColor = p.text, contentColor = p.bg, actionColor = p.accentSoft, shape = RoundedCornerShape(10.dp))
        }
    }

    vm.pendingShare?.let { text -> ShareTargetDialog(vm, text) }
    if (vm.pendingShareFiles.isNotEmpty()) ShareFilesDialog(vm, vm.pendingShareFiles)
}

@Composable
private fun HomeScreen(vm: AppViewModel) {
    val p = LocalPalette.current
    Scaffold(
        containerColor = p.bg,
        topBar = { TopBar(vm) },
        bottomBar = {
            NavigationBar(containerColor = p.bg, tonalElevation = 0.dp) {
                listOf(
                    Triple(Tab.CLIPBOARDS, "Clipboards", Ic.Clipboard),
                    Triple(Tab.NOTES, "Notes", Ic.Note),
                    Triple(Tab.SETTINGS, "Settings", Ic.Settings),
                ).forEach { (tab, label, icon) ->
                    NavigationBarItem(
                        selected = vm.tab == tab,
                        onClick = { vm.tab = tab },
                        icon = { Icon(icon, null, Modifier.size(22.dp)) },
                        label = { Text(label) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = p.accent,
                            selectedTextColor = p.accent,
                            indicatorColor = p.accentSoft,
                            unselectedIconColor = p.muted,
                            unselectedTextColor = p.muted,
                        ),
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (vm.tab) {
                Tab.CLIPBOARDS -> ClipboardsTab(vm)
                Tab.NOTES -> NotesTab(vm)
                Tab.SETTINGS -> SettingsTab(vm)
            }
        }
    }
}

@Composable
private fun TopBar(vm: AppViewModel) {
    val p = LocalPalette.current
    val connection by vm.connection.collectAsStateWithLifecycle()
    val activeId by vm.activeId.collectAsStateWithLifecycle()
    val profile = vm.activeProfile
    Column(Modifier.background(p.bg).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(28.dp).clip(RoundedCornerShape(8.dp)).background(Color(0xFF4F46E5)), contentAlignment = Alignment.Center) {
                Icon(Ic.Clipboard, null, Modifier.size(17.dp), tint = Color.White)
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f).clickable(enabled = activeId != null) { vm.tab = Tab.SETTINGS }) {
                Text("ClipBox", style = MaterialTheme.typography.titleMedium, color = p.text)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val (color, label) = statusOf(connection, profile?.serverName, p)
                    Dot(color, 7)
                    Spacer(Modifier.width(6.dp))
                    Text(label, style = MaterialTheme.typography.bodySmall, color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (activeId != null) GroupSwitcher(vm)
            IconAction(Ic.Scan, "Scan a QR code to connect", tint = p.text) { vm.screen = Screen.Scanner }
        }
        HorizontalDivider(color = p.border)
    }
}

/**
 * Group picker. Hidden while the server only has its default group (or is too old for groups),
 * so single-group setups look exactly as before.
 */
@Composable
private fun GroupSwitcher(vm: AppViewModel) {
    val p = LocalPalette.current
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val groups = snapshot?.groups.orEmpty()
    if (groups.size < 2) return
    val current = vm.currentGroup(snapshot)
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.clip(RoundedCornerShape(8.dp)).clickable { open = true }.padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(if (current.membersOnly) Ic.Lock else Ic.Users, null, Modifier.size(16.dp), tint = p.accent)
            Spacer(Modifier.width(6.dp))
            Text(current.name, style = MaterialTheme.typography.labelLarge, color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 120.dp))
            Icon(Ic.ChevronDown, "Switch group", Modifier.size(16.dp), tint = p.muted)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            groups.forEach { g ->
                val clips = snapshot?.clipboards.orEmpty().count { it.groupId == g.id }
                val notes = snapshot?.notes.orEmpty().count { it.groupId == g.id }
                val access = if (g.membersOnly) "Invited only" else "Everyone"
                val clipLabel = if (clips == 1) "1 clipboard" else "$clips clipboards"
                val noteLabel = if (notes == 1) "1 note" else "$notes notes"
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(g.name, color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("$access · $clipLabel · $noteLabel", style = MaterialTheme.typography.bodySmall, color = p.muted)
                        }
                    },
                    leadingIcon = { Icon(if (g.membersOnly) Ic.Lock else Ic.Users, null, Modifier.size(18.dp), tint = if (g.id == current.id) p.accent else p.muted) },
                    trailingIcon = if (g.id == current.id) ({ Icon(Ic.Check, null, Modifier.size(18.dp), tint = p.accent) }) else null,
                    onClick = {
                        open = false
                        if (g.id != current.id) {
                            vm.selectGroup(g.id)
                            vm.msg("Switched to ${g.name}")
                        }
                    },
                )
            }
            if (vm.role == io.github.salmanulharis.clipbox.core.model.Role.HOST) {
                HorizontalDivider(color = p.border)
                DropdownMenuItem(
                    text = { Text("Manage groups", color = p.text) },
                    leadingIcon = { Icon(Ic.Settings, null, Modifier.size(18.dp), tint = p.muted) },
                    onClick = { open = false; vm.openGroups() },
                )
            }
        }
    }
}

private fun statusOf(c: Connection, server: String?, p: Palette): Pair<Color, String> = when (c) {
    is Connection.Online -> p.ok to "${server ?: "Connected"}${if (c.live) "" else " · polling"}"
    Connection.Connecting -> p.warn to "Connecting to ${server ?: "server"}…"
    is Connection.Offline -> p.danger to "Offline · ${server ?: ""}"
    Connection.Revoked -> p.danger to "Removed by the host"
    is Connection.WrongServer -> p.danger to "Different server found"
    Connection.Idle -> p.muted to (server ?: "Not connected")
}

/** Shown above server content when not live: offline (read-only cache), revoked, or a different server. */
@Composable
fun ConnectionBanner(vm: AppViewModel, modifier: Modifier = Modifier) {
    val connection by vm.connection.collectAsStateWithLifecycle()
    when (val c = connection) {
        is Connection.Offline -> {
            val pendingCount = vm.pending.collectAsStateWithLifecycle().value.size
            val localNet = rememberLocalNetworkAccess()
            val needsLocal = !localNet.granted && vm.activeProfile?.urls?.any(LocalNetwork::isLocal) == true
            Banner(
                Ic.Server,
                if (needsLocal) "ClipBox needs \"Local network access\" to reach ${vm.activeProfile?.serverName} on your Wi-Fi."
                else "${c.message}" + if (pendingCount > 0) " $pendingCount change${if (pendingCount == 1) "" else "s"} will sync when you're back online." else " New changes are kept on this phone until then.",
                warn = true, modifier = modifier,
            ) {
                if (needsLocal) TextButton(onClick = { localNet.request { if (it) vm.refresh() } }) { Text("Allow") }
                else IconAction(Ic.Refresh, "Retry now") { vm.refresh() }
            }
        }
        Connection.Revoked -> Banner(Ic.X, "The host removed this phone from ${vm.activeProfile?.serverName ?: "the server"}.", warn = true, modifier = modifier) {
            TextButton(onClick = { vm.forgetActive(); vm.screen = Screen.Scanner }) { Text("Reconnect") }
        }
        is Connection.WrongServer -> Banner(Ic.X, c.message, warn = true, modifier = modifier) {
            TextButton(onClick = { vm.screen = Screen.Scanner }) { Text("Scan") }
        }
        else -> Unit
    }
}

/** "Share to ClipBox": choose a clipboard, a new private note, or a new shared note. Never automatic. */
@Composable
private fun ShareTargetDialog(vm: AppViewModel, text: String) {
    val p = LocalPalette.current
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val connection by vm.connection.collectAsStateWithLifecycle()
    // Offline is fine: shared notes and clipboard items are queued and sent on reconnect.
    val canShare = vm.activeProfile != null && vm.role.canWrite
    val authenticate = rememberAuthenticator()
    val done = { vm.pendingShare = null }
    AlertDialog(
        onDismissRequest = done,
        title = { Text("Save to ClipBox") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(text.take(200), style = MaterialTheme.typography.bodySmall, color = p.muted, maxLines = 3, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(12.dp))
                ShareOption(Ic.Lock, "New private note", "Only on this phone") {
                    val open = { done(); vm.tab = Tab.NOTES; vm.notesScope = Scope.PRIVATE; vm.openEditor(Scope.PRIVATE, null, text) }
                    if (vm.privateLocked) authenticate("Unlock private notes") { ok -> if (ok) { vm.unlockPrivate(); open() } } else open()
                }
                if (canShare) {
                    ShareOption(Ic.Users, "New shared note", "Visible to ${vm.audience()}") {
                        done(); vm.tab = Tab.NOTES; vm.notesScope = Scope.SHARED; vm.openEditor(Scope.SHARED, null, text)
                    }
                    snapshot?.clipboards?.forEach { cb ->
                        ShareOption(Ic.Clipboard, cb.name, clipboardPlace(vm, cb.groupId)) {
                            done(); vm.addText(cb.id, text) { ok -> if (ok) vm.msg("Added to ${cb.name}") }
                        }
                    }
                } else if (vm.activeProfile != null) {
                    Text("This phone is view-only on ${vm.activeProfile?.serverName}.", style = MaterialTheme.typography.bodySmall, color = p.muted, modifier = Modifier.padding(top = 8.dp))
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = done) { Text("Cancel") } },
    )
}

/** Files/images shared into ClipBox: choose which clipboard they're uploaded to. */
@Composable
private fun ShareFilesDialog(vm: AppViewModel, files: List<android.net.Uri>) {
    val p = LocalPalette.current
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val connection by vm.connection.collectAsStateWithLifecycle()
    val online = connection is Connection.Online
    val done = { vm.pendingShareFiles = emptyList() }
    AlertDialog(
        onDismissRequest = done,
        title = { Text(if (files.size == 1) "Add file to ClipBox" else "Add ${files.size} files to ClipBox") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                when {
                    vm.activeProfile == null -> Text("Connect to a ClipBox server first.", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                    !vm.role.canWrite -> Text("This phone is view-only on ${vm.activeProfile?.serverName}.", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                    !online -> Text("Files can only be added while you're connected to ${vm.activeProfile?.serverName}.", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                    else -> snapshot?.clipboards?.forEach { cb ->
                        ShareOption(Ic.Clipboard, cb.name, clipboardPlace(vm, cb.groupId)) {
                            val list = files
                            done()
                            vm.tab = Tab.CLIPBOARDS
                            vm.selectGroup(cb.groupId)
                            vm.activeClipboardId = cb.id
                            vm.uploadUris(cb.id, list)
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = done) { Text("Cancel") } },
    )
}

/** "Clipboard on PC", or "Family · PC" when the server has several groups. */
private fun clipboardPlace(vm: AppViewModel, groupId: String): String {
    val server = vm.activeProfile?.serverName
    val groups = vm.snapshot.value?.groups.orEmpty()
    return if (groups.size < 2) "Clipboard on $server" else "${vm.groupById(groupId).name} · $server"
}

@Composable
private fun ShareOption(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, subtitle: String, onClick: () -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(vertical = 10.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(20.dp), tint = p.accent)
        Spacer(Modifier.width(12.dp))
        Column {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = p.text)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = p.muted)
        }
    }
}
