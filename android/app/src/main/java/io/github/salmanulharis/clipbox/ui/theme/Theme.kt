package io.github.salmanulharis.clipbox.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** The same seven palettes as the web app (public/style.css). */
@Immutable
data class Palette(
    val id: String,
    val name: String,
    val dark: Boolean,
    val bg: Color,
    val bgSoft: Color,
    val bgHover: Color,
    val border: Color,
    val text: Color,
    val muted: Color,
    val accent: Color,
    val accentSoft: Color,
    val accentText: Color,
    val danger: Color,
    val ok: Color,
    val warn: Color,
)

private fun c(hex: Long) = Color(0xFF000000 or hex)

object Palettes {
    val Light = Palette("light", "Light", false, c(0xFFFFFF), c(0xF6F7F9), c(0xF0F1F4), c(0xE4E6EB), c(0x16181D), c(0x6B7180), c(0x4F46E5), c(0xEEF0FF), c(0xFFFFFF), c(0xDC2626), c(0x16A34A), c(0xB45309))
    val Dark = Palette("dark", "Dark", true, c(0x111214), c(0x18191C), c(0x202126), c(0x2A2C32), c(0xE8E9EC), c(0x8D92A0), c(0x818CF8), c(0x23253A), c(0x0D0E1A), c(0xF87171), c(0x4ADE80), c(0xFBBF24))
    val Midnight = Palette("midnight", "Midnight", true, c(0x0B1020), c(0x111832), c(0x19213F), c(0x222C4F), c(0xE6E9F5), c(0x8A93B8), c(0x60A5FA), c(0x172554), c(0x04122B), c(0xF87171), c(0x4ADE80), c(0xFBBF24))
    val Forest = Palette("forest", "Forest", true, c(0x0F1512), c(0x141C18), c(0x1B2620), c(0x26332C), c(0xE3ECE6), c(0x8AA094), c(0x34D399), c(0x123126), c(0x06261B), c(0xF87171), c(0x4ADE80), c(0xFBBF24))
    val Rose = Palette("rose", "Rose", false, c(0xFFFAFB), c(0xFDF2F4), c(0xFBE7EB), c(0xF3D9DF), c(0x2A1A1F), c(0x8A6B74), c(0xE11D48), c(0xFFE4EA), c(0xFFFFFF), c(0xB91C1C), c(0x16A34A), c(0xB45309))
    val Sand = Palette("sand", "Sand", false, c(0xFBF8F1), c(0xF4EFE3), c(0xEDE6D6), c(0xE2D9C5), c(0x2D2A24), c(0x7C7465), c(0xB45309), c(0xFBEDD5), c(0xFFFFFF), c(0xDC2626), c(0x16A34A), c(0xB45309))

    val all = listOf(Light, Dark, Midnight, Forest, Rose, Sand)
    /** "system" + the palettes, for the theme picker. */
    val choices = listOf("system" to "System") + all.map { it.id to it.name }

    fun resolve(id: String, systemDark: Boolean): Palette =
        all.firstOrNull { it.id == id } ?: if (systemDark) Dark else Light
}

val LocalPalette = staticCompositionLocalOf { Palettes.Light }

private val Mono = FontFamily.Monospace

@Composable
fun ClipBoxTheme(themeId: String, content: @Composable () -> Unit) {
    val p = Palettes.resolve(themeId, isSystemInDarkTheme())
    val scheme = if (p.dark) {
        darkColorScheme(
            primary = p.accent, onPrimary = p.accentText, primaryContainer = p.accentSoft, onPrimaryContainer = p.accent,
            secondaryContainer = p.accentSoft, onSecondaryContainer = p.accent,
            background = p.bg, onBackground = p.text, surface = p.bg, onSurface = p.text,
            surfaceVariant = p.bgSoft, onSurfaceVariant = p.muted, surfaceContainer = p.bgSoft,
            surfaceContainerLow = p.bgSoft, surfaceContainerHigh = p.bgHover, surfaceContainerHighest = p.bgHover,
            outline = p.border, outlineVariant = p.border, error = p.danger,
        )
    } else {
        lightColorScheme(
            primary = p.accent, onPrimary = p.accentText, primaryContainer = p.accentSoft, onPrimaryContainer = p.accent,
            secondaryContainer = p.accentSoft, onSecondaryContainer = p.accent,
            background = p.bg, onBackground = p.text, surface = p.bg, onSurface = p.text,
            surfaceVariant = p.bgSoft, onSurfaceVariant = p.muted, surfaceContainer = p.bgSoft,
            surfaceContainerLow = p.bgSoft, surfaceContainerHigh = p.bgHover, surfaceContainerHighest = p.bgHover,
            outline = p.border, outlineVariant = p.border, error = p.danger,
        )
    }
    val type = Typography(
        titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.2).sp),
        titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
        bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 23.sp),
        bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
        labelLarge = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
    )
    CompositionLocalProvider(LocalPalette provides p) {
        MaterialTheme(colorScheme = scheme, typography = type, content = content)
    }
}

/** Monospace style used for clipboard text and note bodies, like the web app. */
val MonoStyle = TextStyle(fontFamily = Mono, fontSize = 14.sp, lineHeight = 21.sp)
