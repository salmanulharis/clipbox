package io.github.salmanulharis.clipbox.ui

import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import io.github.salmanulharis.clipbox.AppViewModel
import io.github.salmanulharis.clipbox.Screen
import io.github.salmanulharis.clipbox.core.model.Group
import io.github.salmanulharis.clipbox.core.model.Role
import io.github.salmanulharis.clipbox.network.Connection
import io.github.salmanulharis.clipbox.network.Invite
import io.github.salmanulharis.clipbox.ui.theme.LocalPalette

/** Host-only: create, rename, open/close, re-member, invite to and delete groups. */
@Composable
fun GroupsScreen(vm: AppViewModel) {
    val p = LocalPalette.current
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val connection by vm.connection.collectAsStateWithLifecycle()
    val online = connection is Connection.Online
    if (vm.role != Role.HOST) {
        vm.screen = Screen.Home
        return
    }
    val groups = snapshot?.groups.orEmpty()
    var newName by rememberSaveable { mutableStateOf("") }
    var renaming by remember { mutableStateOf<Group?>(null) }
    var deleting by remember { mutableStateOf<Group?>(null) }
    var inviting by remember { mutableStateOf<Group?>(null) }
    var expanded by rememberSaveable { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxSize().background(p.bg).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconAction(Ic.Back, "Back", tint = p.text) { vm.screen = Screen.Home }
            Text("Groups", style = MaterialTheme.typography.titleLarge, color = p.text, modifier = Modifier.weight(1f))
            IconAction(Ic.Refresh, "Refresh devices") { vm.loadDevices() }
        }
        LazyColumn(contentPadding = ListPadding, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Text(
                    "Groups keep clipboards and shared notes apart, for example Family and Work. A device only sees the groups it belongs to; Everyone is visible to all devices. Private notes are never part of a group.",
                    style = MaterialTheme.typography.bodySmall, color = p.muted,
                )
            }
            if (!online) item { ConnectionBanner(vm) }
            items(groups, key = { it.id }) { g ->
                GroupCard(
                    vm, g,
                    clipboards = snapshot?.clipboards.orEmpty().count { it.groupId == g.id },
                    notes = snapshot?.notes.orEmpty().count { it.groupId == g.id },
                    enabled = online,
                    expanded = expanded == g.id,
                    onExpand = { expanded = if (expanded == g.id) null else g.id },
                    onRename = { renaming = g },
                    onInvite = { inviting = g },
                    onDelete = { deleting = g },
                )
            }
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        newName, { newName = it.take(60) }, singleLine = true, enabled = online,
                        placeholder = { Text("New group, e.g. Family") }, modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(8.dp))
                    Button(enabled = online && newName.isNotBlank(), onClick = { vm.createGroup(newName); newName = "" }) { Text("Create") }
                }
                Text(
                    "New groups are invite-only and start with a General clipboard.",
                    style = MaterialTheme.typography.bodySmall, color = p.muted, modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }

    renaming?.let { g ->
        TextPromptDialog("Rename group", g.name, "Group name", "Rename", onDismiss = { renaming = null }) { name ->
            renaming = null
            vm.renameGroup(g.id, name)
        }
    }
    deleting?.let { g ->
        val clips = snapshot?.clipboards.orEmpty().count { it.groupId == g.id }
        val notes = snapshot?.notes.orEmpty().count { it.groupId == g.id }
        ConfirmDialog(
            "Delete \"${g.name}\"?",
            "This deletes its $clips clipboard${if (clips == 1) "" else "s"}, including files, and $notes shared note${if (notes == 1) "" else "s"} for every device. It can't be undone.",
            "Delete", danger = true, onDismiss = { deleting = null },
        ) {
            deleting = null
            vm.deleteGroup(g)
        }
    }
    inviting?.let { g -> InviteDialog(vm, g) { inviting = null } }
}

@Composable
private fun GroupCard(
    vm: AppViewModel, g: Group, clipboards: Int, notes: Int, enabled: Boolean, expanded: Boolean,
    onExpand: () -> Unit, onRename: () -> Unit, onInvite: () -> Unit, onDelete: () -> Unit,
) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, if (g.id == vm.currentGroup().id) p.accent else p.border, shape).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(if (g.membersOnly) Ic.Lock else Ic.Users, null, Modifier.size(20.dp), tint = p.accent)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(g.name, style = MaterialTheme.typography.titleMedium, color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val who = when {
                    g.isDefault -> "Visible to every device"
                    g.membersOnly -> "${g.memberCount} member${if (g.memberCount == 1) "" else "s"} + host"
                    else -> "Visible to every device"
                }
                Text(
                    "$who · $clipboards clipboard${if (clipboards == 1) "" else "s"} · $notes shared note${if (notes == 1) "" else "s"}",
                    style = MaterialTheme.typography.bodySmall, color = p.muted,
                )
            }
            IconAction(Ic.Qr, "Invite a device to ${g.name}", tint = p.accent, enabled = enabled, onClick = onInvite)
            if (!g.isDefault) {
                IconAction(Ic.Edit, "Rename ${g.name}", enabled = enabled, onClick = onRename)
                IconAction(Ic.Trash, "Delete ${g.name}", tint = p.danger, enabled = enabled, onClick = onDelete)
            }
        }
        if (g.isDefault) return@Column
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Invite-only", style = MaterialTheme.typography.bodyLarge, color = p.text)
                Text(
                    if (g.membersOnly) "Only members and the host can see it" else "Every connected device can see it",
                    style = MaterialTheme.typography.bodySmall, color = p.muted,
                )
            }
            Switch(g.membersOnly, { vm.setGroupAccess(g.id, it) }, enabled = enabled)
        }
        if (!g.membersOnly) return@Column
        HorizontalDivider(color = p.border, modifier = Modifier.padding(vertical = 6.dp))
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(onClick = onExpand).padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Members", style = MaterialTheme.typography.labelLarge, color = p.text, modifier = Modifier.weight(1f))
            Text(if (expanded) "Hide" else "Choose", style = MaterialTheme.typography.labelLarge, color = p.accent)
        }
        if (expanded) {
            val members = g.members.orEmpty().toSet()
            // The host sees every group anyway, so hosts and removed devices aren't offered.
            val candidates = vm.devices.filter { !it.revoked && it.role != Role.HOST }
            if (candidates.isEmpty()) {
                Text("No other devices yet. Use the invite button to add one.", style = MaterialTheme.typography.bodySmall, color = p.muted)
            }
            candidates.forEach { d ->
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(enabled = enabled) { vm.setMember(g, d.id, d.id !in members) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(d.id in members, { vm.setMember(g, d.id, it) }, enabled = enabled)
                    Column(Modifier.weight(1f)) {
                        Text(d.name, style = MaterialTheme.typography.bodyMedium, color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            "${if (d.app) "App" else "Browser"} · ${if (d.lastSeenAt > 0) "seen ${timeAgo(d.lastSeenAt)}" else "never seen"}",
                            style = MaterialTheme.typography.bodySmall, color = p.muted,
                        )
                    }
                }
            }
        }
    }
}

/** QR code that signs a new device in and, for groups other than Everyone, adds it to [group]. */
@Composable
private fun InviteDialog(vm: AppViewModel, group: Group, onDismiss: () -> Unit) {
    val p = LocalPalette.current
    val context = LocalContext.current
    var invite by remember { mutableStateOf<Invite?>(null) }
    var failed by remember { mutableStateOf(false) }
    var index by remember { mutableStateOf(0) }
    LaunchedEffect(group.id) {
        val i = vm.invite(group.id)
        if (i == null || i.links.isEmpty()) failed = true
        else {
            // Start with the address this phone itself uses, so the other device is likely to reach it too.
            val base = (vm.connection.value as? Connection.Online)?.base
            // Virtual adapters (Hyper-V, WSL, VPN…) are rarely reachable from another device.
            val real = i.links.filterNot { it.label.endsWith("(virtual)") }
            val shown = if (real.isNotEmpty()) i.copy(links = real) else i
            index = shown.links.indexOfFirst { base != null && it.link.startsWith(base) }.takeIf { it >= 0 }
                ?: shown.links.indexOfFirst { !it.blocked }.coerceAtLeast(0)
            invite = shown
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (group.isDefault) "Connect a device" else "Invite to \"${group.name}\"") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
                val inv = invite
                when {
                    failed -> Text("Couldn't create an invitation. Check the connection and try again.", color = p.muted)
                    inv == null -> Box(Modifier.size(240.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    else -> {
                        val link = inv.links[index.coerceIn(0, inv.links.lastIndex)]
                        val qr = remember(link.link) { qrBitmap(link.link) }
                        Box(Modifier.size(240.dp).clip(RoundedCornerShape(12.dp)).background(Color.White).padding(8.dp)) {
                            Image(qr, "QR code for ${link.label}", Modifier.fillMaxSize(), filterQuality = FilterQuality.None)
                        }
                        if (inv.links.size > 1) {
                            Spacer(Modifier.height(10.dp))
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                items(inv.links.size) { i -> Chip(inv.links[i].label, i == index) { index = i } }
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        Text(
                            link.link.substringBefore("/join").substringBefore("/#"),
                            style = MaterialTheme.typography.bodyMedium, color = p.text,
                        )
                        Spacer(Modifier.height(6.dp))
                        if (link.blocked) {
                            Text("Remote access needs AUTH_PASSWORD on the server.", style = MaterialTheme.typography.bodySmall, color = p.danger)
                        }
                        Text(
                            (if (group.isDefault) "Scan with the ClipBox app or a phone camera." else "Scanning signs the device in and adds it to \"${group.name}\".") +
                                " The code works for ${inv.minutes} minutes and can add one app.",
                            style = MaterialTheme.typography.bodySmall, color = p.muted,
                        )
                        Row {
                            TextButton(onClick = { vm.copyText(link.link, "Link copied") }) { Text("Copy link") }
                            TextButton(onClick = {
                                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link.link)
                                context.startActivity(Intent.createChooser(send, "Share invitation"))
                            }) { Text("Share link") }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
    )
}

/** Black-on-white QR code for [text]; the caller adds the quiet zone padding. */
fun qrBitmap(text: String, size: Int = 640): ImageBitmap {
    val hints = mapOf(EncodeHintType.MARGIN to 0, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M)
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints)
    val px = IntArray(m.width * m.height) { i -> if (m.get(i % m.width, i / m.width)) 0xFF000000.toInt() else 0xFFFFFFFF.toInt() }
    return Bitmap.createBitmap(px, m.width, m.height, Bitmap.Config.ARGB_8888).asImageBitmap()
}
