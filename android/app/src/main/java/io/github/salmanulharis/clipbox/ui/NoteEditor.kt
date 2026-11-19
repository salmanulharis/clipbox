package io.github.salmanulharis.clipbox.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.foundation.layout.size
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.salmanulharis.clipbox.AppViewModel
import io.github.salmanulharis.clipbox.EditorState
import io.github.salmanulharis.clipbox.Scope
import io.github.salmanulharis.clipbox.core.model.NoteText
import io.github.salmanulharis.clipbox.network.Connection
import io.github.salmanulharis.clipbox.ui.theme.LocalPalette
import io.github.salmanulharis.clipbox.ui.theme.MonoStyle

@Composable
fun NoteEditorScreen(vm: AppViewModel, e: EditorState) {
    val p = LocalPalette.current
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val privateAll by vm.privateNotes.collectAsStateWithLifecycle()
    val connection by vm.connection.collectAsStateWithLifecycle()
    val shared = e.scope == Scope.SHARED
    val sharedNote = if (shared) snapshot?.notes?.firstOrNull { it.id == e.id } else null
    val privateNote = if (!shared) privateAll.firstOrNull { it.id == e.id } else null
    val readOnly = vm.editorReadOnly(e)
    val online = connection is Connection.Online
    val pinned = sharedNote?.pinned ?: privateNote?.pinned ?: false
    var dialog by remember { mutableStateOf<String?>(null) } // "share" | "delete"
    val localOnly = io.github.salmanulharis.clipbox.network.Outbox.isLocalId(e.id)
    SecureScreen(enabled = !shared && vm.lockEnabled)

    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            IconAction(Ic.Back, "Back", tint = p.text) { vm.closeEditor() }
            ScopeBadge(e.scope)
            Spacer(Modifier.weight(1f))
            IconAction(Ic.Copy, "Copy note") { vm.copyText(NoteText.copyText(e.title, e.body), "Note copied") }
            if (!readOnly && (!shared || (online && !localOnly))) IconAction(Ic.Pin, if (pinned) "Unpin" else "Pin", tint = if (pinned) p.accent else p.muted) { vm.editorPin(e) }
            if (shared && sharedNote != null && vm.canLock(sharedNote) && online) {
                IconAction(if (sharedNote.locked) Ic.Lock else Ic.Unlock, if (sharedNote.locked) "Locked — tap to let everyone edit" else "Only I can edit", tint = if (sharedNote.locked) p.accent else p.muted) { vm.editorLock(e) }
            }
            // Less frequent actions live in a menu with text labels, so they're unambiguous.
            Box {
                var menu by remember { mutableStateOf(false) }
                IconAction(Ic.More, "More actions") { menu = true }
                DropdownMenu(menu, { menu = false }) {
                    if (shared) {
                        DropdownMenuItem(
                            text = { Text("Save a private copy") },
                            leadingIcon = { Icon(Ic.Lock, null, Modifier.size(18.dp)) },
                            onClick = { menu = false; vm.editorCopyTo(e) },
                        )
                    } else if (vm.activeProfile != null && vm.role.canWrite) {
                        DropdownMenuItem(
                            text = { Text("Share a copy with everyone…") },
                            leadingIcon = { Icon(Ic.Share, null, Modifier.size(18.dp)) },
                            enabled = online,
                            onClick = { menu = false; dialog = "share" },
                        )
                    }
                    if (!readOnly) {
                        DropdownMenuItem(
                            text = { Text(if (shared) "Delete for everyone" else "Move to trash", color = p.danger) },
                            leadingIcon = { Icon(Ic.Trash, null, Modifier.size(18.dp), tint = p.danger) },
                            onClick = { menu = false; if (shared && e.id != null) dialog = "delete" else vm.editorDelete(e) },
                        )
                    }
                }
            }
        }
        Text(
            e.status,
            style = MaterialTheme.typography.bodySmall,
            color = if (e.statusError) p.danger else p.muted,
            modifier = Modifier.padding(horizontal = 16.dp),
        )

        e.conflict?.let { c ->
            AlertCard("This note was changed on ${c.updatedByName} while you were editing.") {
                Button(onClick = { vm.keepMine(e) }) { Text("Keep mine") }
                OutlinedButton(onClick = { vm.useTheirs(e) }) { Text("Use theirs") }
                OutlinedButton(onClick = { vm.copyText(NoteText.copyText(e.title, e.body), "Your version copied") }) { Text("Copy mine") }
            }
        }
        if (e.deletedRemotely) {
            AlertCard("This note was deleted on another device.") {
                Button(onClick = { vm.saveAsNew(e) }) { Text("Save as new note") }
                OutlinedButton(onClick = { vm.closeEditor(discard = true) }) { Text("Discard") }
            }
        }
        if (readOnly) {
            Text(
                if (!vm.role.canWrite) "View only — the host made this phone read-only."
                else "Locked by ${sharedNote?.authorName} — only they or the host can edit it.",
                style = MaterialTheme.typography.bodySmall, color = p.muted, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            )
        }
        if (shared && !online && !readOnly) {
            Text("Offline — changes are kept on this phone and sync when you reconnect.", style = MaterialTheme.typography.bodySmall, color = p.warn, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        }

        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Field(e.title, { vm.onEditorChange(e, title = it) }, "Title", readOnly, TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = p.text), singleLine = true)
            Field(e.tags, { vm.onEditorChange(e, tags = it) }, "Tags, separated by commas", readOnly, TextStyle(fontSize = 14.sp, color = p.accent), singleLine = true)
            HorizontalDivider(color = p.border)
            Spacer(Modifier.height(8.dp))
            Field(e.body, { vm.onEditorChange(e, body = it) }, "Write something…", readOnly, MonoStyle.copy(color = p.text, fontSize = 15.sp, lineHeight = 23.sp), minHeight = 320)
        }
        HorizontalDivider(color = p.border)
        Text(
            when {
                sharedNote != null -> "Created by ${sharedNote.authorName} ${timeAgo(sharedNote.createdAt)} · last edited by ${sharedNote.updatedByName} ${timeAgo(sharedNote.updatedAt)}"
                privateNote != null -> "Encrypted on this phone · edited ${timeAgo(privateNote.updatedAt)}"
                shared -> "Will be shared with everyone on ${vm.activeProfile?.serverName}."
                else -> "Saved automatically, encrypted on this phone."
            },
            style = MaterialTheme.typography.bodySmall, color = p.muted, modifier = Modifier.padding(16.dp, 8.dp),
        )
    }

    if (e.leavePrompt) {
        ConfirmDialog(
            "Leave without saving?",
            if (e.conflict != null || e.deletedRemotely) "Your latest changes haven't been saved yet." else "Your latest changes couldn't be saved (are you offline?).",
            "Leave", danger = true,
            onDismiss = { e.leavePrompt = false },
        ) { vm.closeEditor(discard = true) }
    }
    when (dialog) {
        "share" -> ConfirmDialog(
            "Share this note?",
            "A copy will be visible to everyone connected to ${vm.activeProfile?.serverName}. Your private note stays private.",
            "Share", onDismiss = { dialog = null },
        ) { vm.editorCopyTo(e) }
        "delete" -> ConfirmDialog(
            "Delete for everyone?",
            "This shared note will be removed from every device connected to ${vm.activeProfile?.serverName}.",
            "Delete", danger = true, onDismiss = { dialog = null },
        ) { vm.editorDelete(e) }
    }
}

@Composable
private fun Field(value: String, onChange: (String) -> Unit, placeholder: String, readOnly: Boolean, style: TextStyle, singleLine: Boolean = false, minHeight: Int = 0) {
    val p = LocalPalette.current
    BasicTextField(
        value, onChange,
        readOnly = readOnly,
        singleLine = singleLine,
        textStyle = style,
        cursorBrush = SolidColor(p.accent),
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).heightIn(min = minHeight.dp),
        decorationBox = { inner ->
            Box {
                if (value.isEmpty()) Text(placeholder, style = style.copy(color = p.muted.copy(alpha = 0.7f)))
                inner()
            }
        },
    )
}

@Composable
private fun AlertCard(message: String, buttons: @Composable () -> Unit) {
    val p = LocalPalette.current
    Column(
        Modifier.padding(horizontal = 16.dp, vertical = 6.dp).fillMaxWidth()
            .clip(RoundedCornerShape(10.dp)).border(1.dp, p.warn, RoundedCornerShape(10.dp)).background(p.bgSoft).padding(12.dp),
    ) {
        Text(message, style = MaterialTheme.typography.bodyMedium, color = p.text)
        Spacer(Modifier.height(8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { buttons() }
    }
}
