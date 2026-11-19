package io.github.salmanulharis.clipbox.ui

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import io.github.salmanulharis.clipbox.Scope
import io.github.salmanulharis.clipbox.ui.theme.LocalPalette

fun timeAgo(ts: Long): String {
    val diff = System.currentTimeMillis() - ts
    return when {
        diff < 60_000 -> "just now"
        diff < 3_600_000 -> "${diff / 60_000}m ago"
        diff < 86_400_000 -> "${diff / 3_600_000}h ago"
        diff < 7 * 86_400_000L -> "${diff / 86_400_000}d ago"
        else -> DateUtils.getRelativeTimeSpanString(ts).toString()
    }
}

fun bytes(n: Long): String = when {
    n < 1024 -> "$n B"
    n < 1024 * 1024 -> "%.1f KB".format(n / 1024.0)
    else -> "%.1f MB".format(n / 1048576.0)
}

@Composable
fun IconAction(icon: ImageVector, label: String, tint: Color = MaterialTheme.colorScheme.onSurfaceVariant, enabled: Boolean = true, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled) {
        Icon(icon, contentDescription = label, tint = if (enabled) tint else tint.copy(alpha = 0.4f), modifier = Modifier.size(20.dp))
    }
}

@Composable
fun Dot(color: Color, size: Int = 8) {
    Spacer(Modifier.size(size.dp).clip(CircleShape).background(color))
}

/** Pill showing whether you're writing in Private or Shared. Used on lists and in the editor. */
@Composable
fun ScopeBadge(scope: Scope, modifier: Modifier = Modifier) {
    val p = LocalPalette.current
    val shared = scope == Scope.SHARED
    Row(
        modifier
            .clip(RoundedCornerShape(50))
            .background(if (shared) p.accentSoft else p.bgHover)
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(if (shared) Ic.Users else Ic.Lock, null, Modifier.size(14.dp), tint = if (shared) p.accent else p.text)
        Spacer(Modifier.width(6.dp))
        Text(
            if (shared) "Shared with everyone" else "Private · this phone only",
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.SemiBold,
            color = if (shared) p.accent else p.text,
        )
    }
}

/** Bordered note shown at the top of a section (Private / Shared / offline …). */
@Composable
fun Banner(
    icon: ImageVector,
    text: String,
    accent: Boolean = false,
    warn: Boolean = false,
    modifier: Modifier = Modifier,
    actions: @Composable () -> Unit = {},
) {
    val p = LocalPalette.current
    val border = when {
        warn -> p.warn
        accent -> p.accent.copy(alpha = 0.3f)
        else -> p.border
    }
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(if (accent) p.accentSoft else p.bgSoft)
            .border(1.dp, border, RoundedCornerShape(10.dp))
            .padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(18.dp), tint = if (accent) p.accent else if (warn) p.warn else p.muted)
        Spacer(Modifier.width(10.dp))
        Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = p.text)
        actions()
    }
}

@Composable
fun Chip(label: String, selected: Boolean, modifier: Modifier = Modifier, leading: ImageVector? = null, onClick: () -> Unit) {
    val p = LocalPalette.current
    Row(
        modifier
            .clip(RoundedCornerShape(50))
            .border(1.dp, if (selected) p.accent else p.border, RoundedCornerShape(50))
            .background(if (selected) p.accentSoft else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) {
            Icon(leading, null, Modifier.size(15.dp), tint = if (selected) p.accent else p.muted)
            Spacer(Modifier.width(6.dp))
        }
        Text(label, style = MaterialTheme.typography.labelLarge, color = if (selected) p.accent else p.text, maxLines = 1)
    }
}

/** Two-way switch styled like the web app's Clipboards | Notes control. */
@Composable
fun Segmented(options: List<Pair<String, ImageVector>>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val p = LocalPalette.current
    Row(
        modifier.clip(RoundedCornerShape(10.dp)).background(p.bgHover).padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        options.forEachIndexed { i, (label, icon) ->
            val on = i == selected
            Row(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (on) p.bg else Color.Transparent)
                    .clickable { onSelect(i) }
                    .padding(vertical = 8.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(icon, null, Modifier.size(16.dp), tint = if (on) p.text else p.muted)
                Spacer(Modifier.width(6.dp))
                Text(label, style = MaterialTheme.typography.labelLarge, color = if (on) p.text else p.muted)
            }
        }
    }
}

@Composable
fun EmptyState(icon: ImageVector, title: String, subtitle: String, modifier: Modifier = Modifier) {
    val p = LocalPalette.current
    Column(modifier.fillMaxWidth().padding(vertical = 48.dp, horizontal = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(icon, null, Modifier.size(36.dp), tint = p.muted.copy(alpha = 0.7f))
        Spacer(Modifier.height(10.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, color = p.text)
        Spacer(Modifier.height(4.dp))
        Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = p.muted, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}

@Composable
fun ConfirmDialog(title: String, text: String, confirm: String, danger: Boolean = false, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = {
            TextButton(onClick = { onDismiss(); onConfirm() }) {
                Text(confirm, color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
fun TextPromptDialog(title: String, initial: String = "", placeholder: String = "", confirm: String = "OK", onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var value by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(value, { value = it.take(60) }, singleLine = true, placeholder = { Text(placeholder) }, modifier = Modifier.fillMaxWidth())
        },
        confirmButton = {
            TextButton(enabled = value.isNotBlank(), onClick = { onDismiss(); onConfirm(value.trim()) }) { Text(confirm) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Passphrase entry; [confirmTwice] for creating a backup. */
@Composable
fun PassphraseDialog(title: String, text: String, confirmTwice: Boolean, onDismiss: () -> Unit, onConfirm: (CharArray) -> Unit) {
    var a by remember { mutableStateOf("") }
    var b by remember { mutableStateOf("") }
    val tooShort = confirmTwice && a.length < 8
    val mismatch = confirmTwice && b.isNotEmpty() && a != b
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(text, style = MaterialTheme.typography.bodyMedium)
                OutlinedTextField(
                    a, { a = it }, singleLine = true, label = { Text("Passphrase") },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    supportingText = { if (confirmTwice) Text("At least 8 characters. It can't be recovered if you forget it.") },
                    modifier = Modifier.fillMaxWidth(),
                )
                if (confirmTwice) {
                    OutlinedTextField(
                        b, { b = it }, singleLine = true, label = { Text("Repeat passphrase") }, isError = mismatch,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = a.isNotEmpty() && !tooShort && (!confirmTwice || a == b),
                onClick = { onDismiss(); onConfirm(a.toCharArray()) },
            ) { Text("OK") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

val ListPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 96.dp)
