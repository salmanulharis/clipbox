package io.github.salmanulharis.clipbox.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.salmanulharis.clipbox.AppViewModel
import io.github.salmanulharis.clipbox.Scope
import io.github.salmanulharis.clipbox.ui.theme.LocalPalette
import io.github.salmanulharis.clipbox.ui.theme.MonoStyle

/**
 * "Save as note" for clipboard content. Private is the default; Shared must be chosen
 * explicitly and says where it goes.
 */
@Composable
fun SaveAsNoteDialog(vm: AppViewModel, initialTitle: String, body: String, onDismiss: () -> Unit) {
    val p = LocalPalette.current
    val authenticate = rememberAuthenticator()
    var title by remember { mutableStateOf(initialTitle) }
    var scope by remember { mutableStateOf(Scope.PRIVATE) }
    val canShare = vm.activeProfile != null && vm.role.canWrite

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Save as note") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(title, { title = it.take(200) }, singleLine = true, label = { Text("Title") }, modifier = Modifier.fillMaxWidth())
                Text(
                    body, style = MonoStyle.copy(color = p.muted), maxLines = 5, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(p.bgSoft).padding(10.dp),
                )
                ScopeOption(Ic.Lock, "Private note", "Encrypted on this phone. Never sent to the server.", scope == Scope.PRIVATE, true) { scope = Scope.PRIVATE }
                ScopeOption(
                    Ic.Users, "Shared note",
                    when {
                        vm.activeProfile == null -> "Connect to a server to share notes."
                        !vm.role.canWrite -> "This phone is view-only."
                        else -> "Visible to ${vm.audience()}."
                    },
                    scope == Scope.SHARED, canShare, accent = true,
                ) { scope = Scope.SHARED }
            }
        },
        confirmButton = {
            TextButton(enabled = title.isNotBlank() || body.isNotBlank(), onClick = {
                if (scope == Scope.PRIVATE && vm.privateLocked) {
                    authenticate("Unlock private notes") { ok ->
                        if (ok) {
                            vm.unlockPrivate()
                            vm.saveAsNote(scope, title, body)
                            onDismiss()
                        }
                    }
                } else {
                    vm.saveAsNote(scope, title, body)
                    onDismiss()
                }
            }) { Text("Save note") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun ScopeOption(icon: ImageVector, title: String, subtitle: String, selected: Boolean, enabled: Boolean, accent: Boolean = false, onClick: () -> Unit) {
    val p = LocalPalette.current
    val border = when {
        !selected -> p.border
        accent -> p.accent
        else -> p.text
    }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).border(1.dp, border, RoundedCornerShape(10.dp))
            .background(if (selected && accent) p.accentSoft else if (selected) p.bgSoft else p.bg)
            .clickable(enabled = enabled, onClick = onClick).padding(end = 10.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick, enabled = enabled)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, null, Modifier.size(15.dp), tint = if (!enabled) p.muted else if (selected && accent) p.accent else p.text)
                Spacer(Modifier.width(6.dp))
                Text(title, style = MaterialTheme.typography.labelLarge, color = if (!enabled) p.muted else if (selected && accent) p.accent else p.text)
            }
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = p.muted)
        }
    }
}
