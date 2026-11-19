package io.github.salmanulharis.clipbox.ui

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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.salmanulharis.clipbox.AppViewModel
import io.github.salmanulharis.clipbox.Scope
import io.github.salmanulharis.clipbox.Screen
import io.github.salmanulharis.clipbox.core.model.NoteText
import io.github.salmanulharis.clipbox.network.Connection
import io.github.salmanulharis.clipbox.ui.theme.LocalPalette

/** A row in either list; [shared]-only fields are null for private notes. */
private data class NoteItem(
    val id: String,
    val title: String,
    val body: String,
    val tags: List<String>,
    val pinned: Boolean,
    val updatedAt: Long,
    val locked: Boolean = false,
    val by: String? = null,
    val editable: Boolean = true,
    val pending: Boolean = false,
)

@Composable
fun NotesTab(vm: AppViewModel) {
    val p = LocalPalette.current
    val privateAll by vm.privateNotes.collectAsStateWithLifecycle()
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val connection by vm.connection.collectAsStateWithLifecycle()
    val activeId by vm.activeId.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }
    var tag by rememberSaveable { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf<String?>(null) }
    val pending by vm.pending.collectAsStateWithLifecycle()
    val authenticate = rememberAuthenticator()

    val scope = vm.notesScope
    val privateHidden = scope == Scope.PRIVATE && vm.privateLocked
    // Block screenshots / recent-apps preview while protected private notes are visible.
    SecureScreen(enabled = scope == Scope.PRIVATE && vm.lockEnabled)
    val online = connection is Connection.Online
    val privateActive = privateAll.filter { it.deletedAt == null }
    val trashCount = privateAll.size - privateActive.size
    val rows: List<NoteItem> = when (scope) {
        Scope.PRIVATE -> privateActive.map { NoteItem(it.id, it.title, it.body, it.tags, it.pinned, it.updatedAt) }
        Scope.SHARED -> snapshot?.notes.orEmpty().map {
            NoteItem(it.id, it.title, it.body, it.tags, it.pinned, it.updatedAt, it.locked,
                if (it.updatedByName != it.authorName) "by ${it.authorName}, edited by ${it.updatedByName}" else "by ${it.authorName}",
                vm.canEdit(it), it.id in pending)
        }
    }
    val allTags = rows.flatMap { it.tags }.groupingBy { it.lowercase() }.eachCount().entries.sortedByDescending { it.value }.map { it.key }.take(30)
    if (tag != null && tag !in allTags) tag = null
    val visible = rows
        .filter { r -> tag == null || r.tags.any { it.equals(tag, ignoreCase = true) } }
        .filter { NoteText.matches(query, it.title, it.body, it.tags) }
        .sortedWith(compareByDescending<NoteItem> { it.pinned }.thenByDescending { it.updatedAt })
    // Shared notes can be written offline too: they're queued and synced on reconnect.
    val canCreate = scope == Scope.PRIVATE && vm.privateLoadError == null && !privateHidden ||
        scope == Scope.SHARED && activeId != null && vm.role.canWrite

    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = ListPadding) {
            item {
                Segmented(
                    listOf("Private" to Ic.Lock, "Shared" to Ic.Users),
                    if (scope == Scope.PRIVATE) 0 else 1,
                    { vm.notesScope = if (it == 0) Scope.PRIVATE else Scope.SHARED; tag = null },
                    Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                if (scope == Scope.PRIVATE) {
                    Banner(Ic.Lock, "Private — encrypted on this phone only. Never sent to the server.") {
                        if (!privateHidden && trashCount > 0) TextButton(onClick = { vm.screen = Screen.Trash }) { Text("Trash $trashCount") }
                        if (vm.lockEnabled && !privateHidden) IconAction(Ic.Lock, "Lock now", tint = p.accent) { vm.lockPrivate() }
                    }
                    if (privateHidden) {
                        Column(Modifier.fillMaxWidth().padding(vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(Ic.Lock, null, Modifier.size(36.dp), tint = p.muted)
                            Spacer(Modifier.height(10.dp))
                            Text("Private notes are locked", style = MaterialTheme.typography.titleMedium, color = p.text)
                            Spacer(Modifier.height(4.dp))
                            Text("Use your fingerprint, face or screen lock to open them.", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                            Spacer(Modifier.height(16.dp))
                            Button(onClick = { authenticate("Unlock private notes") { ok -> if (ok) vm.unlockPrivate() } }) {
                                Icon(Ic.Unlock, null, Modifier.size(18.dp))
                                Spacer(Modifier.width(8.dp))
                                Text("Unlock")
                            }
                        }
                    }
                    vm.privateLoadError?.let {
                        Spacer(Modifier.height(8.dp))
                        Banner(Ic.X, "$it Your notes are kept untouched (read-only). Restore from a backup in Settings.", warn = true)
                    }
                } else if (activeId == null) {
                    Banner(Ic.Users, "Shared notes live on a ClipBox server. Connect to one to see them.", accent = true) {
                        TextButton(onClick = { vm.screen = Screen.Scanner }) { Text("Connect") }
                    }
                } else {
                    Banner(Ic.Users, "Shared — visible to everyone connected to ${vm.activeProfile?.serverName}" + if (!vm.role.canWrite) " (view only)" else "", accent = true)
                    Spacer(Modifier.height(8.dp))
                    ConnectionBanner(vm)
                }
                Spacer(Modifier.height(10.dp))
                if (!privateHidden) OutlinedTextField(
                    query, { query = it },
                    placeholder = { Text("Search notes…") },
                    leadingIcon = { Icon(Ic.Search, null, Modifier.size(18.dp)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (allTags.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        items(allTags) { t -> Chip("#$t", tag == t) { tag = if (tag == t) null else t } }
                    }
                }
                Spacer(Modifier.height(6.dp))
            }

            if (visible.isEmpty() && !privateHidden && !(scope == Scope.SHARED && activeId == null)) {
                item {
                    val (t, s) = when {
                        query.isNotBlank() || tag != null -> "No matching notes" to "Try a different search or tag."
                        scope == Scope.PRIVATE -> "No private notes yet" to "They're encrypted on this phone and never leave it unless you share or back them up."
                        else -> "No shared notes yet" to "Shared notes are visible to everyone on ${vm.activeProfile?.serverName}."
                    }
                    EmptyState(Ic.Note, t, s)
                }
            }

            items(if (privateHidden) emptyList() else visible, key = { it.id }) { r ->
                NoteRow(
                    r,
                    onOpen = { vm.openEditor(scope, r.id) },
                    onCopy = { vm.copyText(NoteText.copyText(r.title, r.body), "Note copied") },
                    onPin = if (r.editable && !r.pending && (scope == Scope.PRIVATE || online)) ({
                        if (scope == Scope.PRIVATE) privateAll.firstOrNull { it.id == r.id }?.let(vm::togglePinPrivate)
                        else snapshot?.notes?.firstOrNull { it.id == r.id }?.let(vm::togglePinShared)
                    }) else null,
                    onDelete = if (r.editable) ({
                        if (scope == Scope.PRIVATE) privateAll.firstOrNull { it.id == r.id }?.let(vm::trashPrivate)
                        else confirmDelete = r.id
                    }) else null,
                )
                HorizontalDivider(color = p.border)
            }
        }

        if (canCreate) {
            ExtendedFloatingActionButton(
                onClick = { vm.openEditor(scope, null) },
                icon = { Icon(Ic.Plus, null, Modifier.size(18.dp)) },
                text = { Text(if (scope == Scope.PRIVATE) "New private note" else "New shared note") },
                containerColor = if (scope == Scope.PRIVATE) p.text else p.accent,
                contentColor = if (scope == Scope.PRIVATE) p.bg else p.accentText,
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
            )
        }
    }

    confirmDelete?.let { id ->
        val n = snapshot?.notes?.firstOrNull { it.id == id }
        if (n != null) {
            ConfirmDialog(
                "Delete for everyone?",
                "\"${NoteText.displayTitle(n.title, n.body)}\" will be removed from every device connected to ${vm.activeProfile?.serverName}.",
                "Delete", danger = true, onDismiss = { confirmDelete = null },
            ) { vm.deleteShared(n) }
        } else confirmDelete = null
    }
}

@Composable
private fun NoteRow(r: NoteItem, onOpen: () -> Unit, onCopy: () -> Unit, onPin: (() -> Unit)?, onDelete: (() -> Unit)?) {
    val p = LocalPalette.current
    Row(Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(vertical = 10.dp), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (r.pinned) {
                    Icon(Ic.Pin, "Pinned", Modifier.size(14.dp), tint = p.accent)
                    Spacer(Modifier.width(4.dp))
                }
                Text(NoteText.displayTitle(r.title, r.body), style = MaterialTheme.typography.titleMedium, color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (r.locked) {
                    Spacer(Modifier.width(4.dp))
                    Icon(Ic.Lock, "Locked", Modifier.size(13.dp), tint = p.muted)
                }
            }
            val preview = NoteText.preview(r.title, r.body)
            if (preview.isNotEmpty()) Text(preview, style = MaterialTheme.typography.bodyMedium, color = p.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(2.dp))
            Text(
                listOfNotNull(timeAgo(r.updatedAt), r.by, if (r.pending) "waiting to sync" else null).joinToString(" · ") + r.tags.take(5).joinToString("") { "  #$it" },
                style = MaterialTheme.typography.bodySmall, color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        IconAction(Ic.Copy, "Copy", tint = p.accent, onClick = onCopy)
        if (onPin != null) IconAction(Ic.Pin, if (r.pinned) "Unpin" else "Pin", tint = if (r.pinned) p.accent else p.muted, onClick = onPin)
        if (onDelete != null) IconAction(Ic.Trash, "Delete", onClick = onDelete)
    }
}

@Composable
fun TrashScreen(vm: AppViewModel) {
    val p = LocalPalette.current
    val all by vm.privateNotes.collectAsStateWithLifecycle()
    val trash = all.filter { it.deletedAt != null }.sortedByDescending { it.deletedAt }
    SecureScreen(enabled = vm.lockEnabled)
    if (vm.privateLocked) {
        vm.screen = Screen.Home
        return
    }
    var confirmEmpty by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconAction(Ic.Back, "Back", tint = p.text) { vm.screen = Screen.Home }
            Text("Trash", style = MaterialTheme.typography.titleLarge, color = p.text, modifier = Modifier.weight(1f))
            TextButton(enabled = trash.isNotEmpty(), onClick = { confirmEmpty = true }) { Text("Empty trash", color = if (trash.isEmpty()) p.muted else p.danger) }
        }
        Text("Deleted private notes are kept on this phone for 30 days.", style = MaterialTheme.typography.bodySmall, color = p.muted, modifier = Modifier.padding(horizontal = 16.dp))
        LazyColumn(contentPadding = ListPadding) {
            if (trash.isEmpty()) item { EmptyState(Ic.Trash, "Trash is empty", "Deleted private notes appear here.") }
            items(trash, key = { it.id }) { n ->
                Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(NoteText.displayTitle(n.title, n.body), style = MaterialTheme.typography.titleMedium, color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("deleted ${timeAgo(n.deletedAt ?: 0)}", style = MaterialTheme.typography.bodySmall, color = p.muted)
                    }
                    IconAction(Ic.Undo, "Restore", tint = p.accent) { vm.restorePrivate(n) }
                    IconAction(Ic.Trash, "Delete forever", tint = p.danger) { vm.destroyPrivate(n) }
                }
                HorizontalDivider(color = p.border)
            }
        }
    }
    if (confirmEmpty) {
        ConfirmDialog("Empty trash?", "${trash.size} notes will be permanently deleted from this phone.", "Empty trash", danger = true, onDismiss = { confirmEmpty = false }) { vm.emptyTrash() }
    }
}
