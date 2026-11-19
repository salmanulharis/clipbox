package io.github.salmanulharis.clipbox.ui

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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.salmanulharis.clipbox.AppViewModel
import io.github.salmanulharis.clipbox.Screen
import io.github.salmanulharis.clipbox.core.model.ClipItem
import io.github.salmanulharis.clipbox.network.Connection
import io.github.salmanulharis.clipbox.ui.theme.LocalPalette
import io.github.salmanulharis.clipbox.ui.theme.MonoStyle

@Composable
fun ClipboardsTab(vm: AppViewModel) {
    val p = LocalPalette.current
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val connection by vm.connection.collectAsStateWithLifecycle()
    val activeId by vm.activeId.collectAsStateWithLifecycle()

    if (activeId == null) {
        ConnectPrompt(vm)
        return
    }
    val clipboards = snapshot?.clipboards.orEmpty()
    val active = clipboards.firstOrNull { it.id == vm.activeClipboardId } ?: clipboards.firstOrNull()
    val online = connection is Connection.Online
    val canWrite = online && vm.role.canWrite

    var dialog by remember { mutableStateOf<String?>(null) } // "new" | "rename" | "clear" | "delete"
    var menu by remember { mutableStateOf(false) }
    var draft by rememberSaveable { mutableStateOf("") }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = ListPadding, verticalArrangement = Arrangement.spacedBy(0.dp)) {
        item { ConnectionBanner(vm, Modifier.padding(bottom = 10.dp)) }
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                LazyRow(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(clipboards, key = { it.id }) { cb ->
                        Chip("${cb.name}${if (cb.items.isNotEmpty()) "  ${cb.items.size}" else ""}", cb.id == active?.id) { vm.activeClipboardId = cb.id }
                    }
                    if (canWrite) item { Chip("+", false) { dialog = "new" } }
                }
                if (active != null) {
                    Box {
                        IconAction(Ic.More, "Clipboard options") { menu = true }
                        DropdownMenu(menu, { menu = false }) {
                            DropdownMenuItem(
                                text = { Text("Copy all") },
                                leadingIcon = { Icon(Ic.Copy, null, Modifier.size(18.dp)) },
                                enabled = active.items.any { it.isText },
                                onClick = {
                                    menu = false
                                    vm.copyText(active.items.filter { it.isText }.joinToString("\n") { it.text.orEmpty() }, "Copied ${active.items.count { it.isText }} items")
                                },
                            )
                            if (canWrite) {
                                DropdownMenuItem(text = { Text("Rename") }, leadingIcon = { Icon(Ic.Edit, null, Modifier.size(18.dp)) }, onClick = { menu = false; dialog = "rename" })
                                DropdownMenuItem(text = { Text("Clear all items") }, leadingIcon = { Icon(Ic.Eraser, null, Modifier.size(18.dp)) }, enabled = active.items.isNotEmpty(), onClick = { menu = false; dialog = "clear" })
                                DropdownMenuItem(text = { Text("Delete clipboard", color = p.danger) }, leadingIcon = { Icon(Ic.Trash, null, Modifier.size(18.dp), tint = p.danger) }, onClick = { menu = false; dialog = "delete" })
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
        }

        if (canWrite && active != null) {
            item {
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).border(1.dp, p.border, RoundedCornerShape(10.dp)).background(p.bgSoft)) {
                    OutlinedTextField(
                        draft, { draft = it },
                        placeholder = { Text("Type or paste text…", style = MonoStyle, color = p.muted) },
                        textStyle = MonoStyle.copy(color = p.text),
                        minLines = 2, maxLines = 8,
                        modifier = Modifier.fillMaxWidth(),
                        colors = OutlinedTextFieldDefaults.colors(
                            unfocusedBorderColor = androidx.compose.ui.graphics.Color.Transparent,
                            focusedBorderColor = androidx.compose.ui.graphics.Color.Transparent,
                        ),
                    )
                    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedButton(onClick = {
                            val clip = vm.readDeviceClipboard()
                            if (clip.isNullOrBlank()) vm.msg("Your phone's clipboard is empty.", error = true)
                            else vm.addText(active.id, clip) { if (it) vm.msg("Pasted from your phone") }
                        }) {
                            Icon(Ic.Paste, null, Modifier.size(16.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("Paste")
                        }
                        Spacer(Modifier.weight(1f))
                        Button(enabled = draft.isNotBlank(), onClick = {
                            val text = draft
                            vm.addText(active.id, text) { ok -> if (ok && draft == text) draft = "" }
                        }) {
                            Icon(Ic.Plus, null, Modifier.size(16.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("Add")
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
            }
        }

        val items = active?.items.orEmpty()
        if (active == null) {
            item { EmptyState(Ic.Clipboard, if (snapshot == null) "Loading…" else "No clipboards", if (snapshot == null) "Connecting to the server." else "Create one with +.") }
        } else if (items.isEmpty()) {
            item { EmptyState(Ic.Clipboard, "This clipboard is empty", if (canWrite) "Type above, or tap Paste to add what's on your phone's clipboard." else "Items added on other devices appear here.") }
        }
        items(items, key = { it.id }) { item ->
            ItemRow(vm, item, canDelete = canWrite) { vm.deleteItem(active!!.id, item) }
            HorizontalDivider(color = p.border)
        }
    }

    when (dialog) {
        "new" -> TextPromptDialog("New clipboard", placeholder = "e.g. Work, Links", confirm = "Create", onDismiss = { dialog = null }) { vm.createClipboard(it) }
        "rename" -> active?.let { TextPromptDialog("Rename clipboard", it.name, confirm = "Rename", onDismiss = { dialog = null }) { n -> vm.renameClipboard(it.id, n) } }
        "clear" -> active?.let { ConfirmDialog("Clear \"${it.name}\"?", "All ${it.items.size} items will be removed on every device.", "Clear", danger = true, onDismiss = { dialog = null }) { vm.clearClipboard(it.id) } }
        "delete" -> active?.let { ConfirmDialog("Delete \"${it.name}\"?", "The clipboard and all its items will be deleted on every device.", "Delete", danger = true, onDismiss = { dialog = null }) { vm.deleteClipboard(it.id) } }
    }
}

@Composable
private fun ItemRow(vm: AppViewModel, item: ClipItem, canDelete: Boolean, onDelete: () -> Unit) {
    val p = LocalPalette.current
    var expanded by remember(item.id) { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().clickable { if (item.isText) vm.copyText(item.text.orEmpty()) }.padding(vertical = 10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Column(Modifier.weight(1f)) {
            when {
                item.isText -> Text(
                    item.text.orEmpty(),
                    style = MonoStyle,
                    color = p.text,
                    maxLines = if (expanded) Int.MAX_VALUE else 8,
                    overflow = TextOverflow.Ellipsis,
                )
                item.isImage -> {
                    val bmp by produceState<ImageBitmap?>(null, item.id) { value = vm.thumbnail(item) }
                    Box(Modifier.clip(RoundedCornerShape(8.dp)).border(1.dp, p.border, RoundedCornerShape(8.dp)).background(p.bgSoft).heightIn(min = 60.dp)) {
                        bmp?.let { Image(it, item.name, Modifier.heightIn(max = 220.dp), contentScale = ContentScale.Fit) }
                            ?: Text("Loading image…", Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall, color = p.muted)
                    }
                }
                else -> Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Ic.File, null, Modifier.size(18.dp), tint = p.muted)
                    Spacer(Modifier.width(8.dp))
                    Text(item.name ?: "File", style = MaterialTheme.typography.bodyLarge, color = p.text)
                }
            }
            Spacer(Modifier.height(4.dp))
            val meta = buildString {
                append(timeAgo(item.createdAt))
                if (item.isText) append(" · ${item.text.orEmpty().length} chars") else append(" · ${bytes(item.size)}")
                if (item.updatedAt != item.createdAt) append(" · edited")
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(meta, style = MaterialTheme.typography.bodySmall, color = p.muted)
                if (item.isText && (item.text?.lines()?.size ?: 0) > 8) {
                    Text(
                        if (expanded) "  Show less" else "  Show more",
                        style = MaterialTheme.typography.bodySmall,
                        color = p.accent,
                        modifier = Modifier.clickable { expanded = !expanded },
                    )
                }
            }
        }
        if (item.isText) IconAction(Ic.Copy, "Copy", tint = p.accent) { vm.copyText(item.text.orEmpty()) }
        if (canDelete) IconAction(Ic.Trash, "Delete") { onDelete() }
    }
}

@Composable
private fun ConnectPrompt(vm: AppViewModel) {
    val p = LocalPalette.current
    Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Box(Modifier.size(64.dp).clip(RoundedCornerShape(16.dp)).background(p.accentSoft), contentAlignment = Alignment.Center) {
            Icon(Ic.Scan, null, Modifier.size(32.dp), tint = p.accent)
        }
        Spacer(Modifier.height(16.dp))
        Text("Connect to your ClipBox", style = MaterialTheme.typography.titleLarge, color = p.text)
        Spacer(Modifier.height(8.dp))
        Text(
            "On your computer, open ClipBox and click Connect, then scan the QR code. ClipBox remembers the server, so you only do this once.",
            style = MaterialTheme.typography.bodyMedium, color = p.muted, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        Spacer(Modifier.height(20.dp))
        Button(onClick = { vm.screen = Screen.Scanner }) {
            Icon(Ic.Scan, null, Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Scan QR code")
        }
        Spacer(Modifier.height(24.dp))
        Text("Private notes work without a server — see the Notes tab.", style = MaterialTheme.typography.bodySmall, color = p.muted)
    }
}
